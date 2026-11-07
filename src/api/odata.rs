//! OData 4.0 over the Portal's own lists (T-6632, pilot on one list): the project's Endpoints as
//! the entity set `Endpoints`, read with `$filter`, `$select`, `$orderby`, `$top`, `$skip` and
//! `$count`, so an OData client (Excel, Power BI, Microsoft.OData.Client) reads what the
//! Endpoints page lists.
//!
//! The URL is parsed by the default broker's `odata-url` crate against the CSDL model below
//! (`odata-csdl`), the same library Antares serves its OData surface with: a name the model does
//! not hold is refused by the parser, so only the allow-listed properties of [`PROPERTIES`] reach
//! a predicate. The rows are the store's manifests, not a SQL table, so the query runs over them
//! in memory, after the read check: an Endpoint the caller may not read is never filtered,
//! counted or paged (API/13 section 2).

use std::cmp::Ordering;
use std::sync::LazyLock;

use axum::extract::{Path, RawQuery, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use odata_csdl::{
    CsdlVersion, EntityContainer, EntitySet, EntityType, Model, Property, Schema, TypeRef,
};
use odata_url::{
    CompareOp, EdmModel, Expr, Format, Literal, Method, ODataUri, OrderBy, QueryOptions, Segment,
    SelectItem, UrlErrorKind,
};
use serde_json::{json, Map, Value};

use crate::auth::CurrentUser;
use crate::error::{ApiError, ProblemDetails};
use crate::resource::ResourceEnvelope;
use crate::state::AppState;
use crate::store::ListOptions;

const NAMESPACE: &str = "JoinedContext.Portal";
const ENTITY_SET: &str = "Endpoints";
const KIND: &str = "Endpoint";

/// The most rows one answer carries: a `$top` above it is refused, and a read without `$top`
/// pages on with `@odata.nextLink`.
pub const MAX_TOP: u64 = 1000;

/// The properties of an Endpoint row, in order: name, EDM type, nullable. The allow-list: the
/// parser refuses any other name in `$filter`, `$select` and `$orderby`.
const PROPERTIES: [(&str, &str, bool); 7] = [
    ("id", "Edm.String", false),
    ("title", "Edm.String", true),
    ("description", "Edm.String", true),
    ("contextSpace", "Edm.String", true),
    ("slug", "Edm.String", true),
    ("audience", "Edm.String", true),
    ("mcp", "Edm.Boolean", false),
];

/// The service's CSDL model: one entity type, one entity set.
static MODEL: LazyLock<Model> = LazyLock::new(|| {
    let mut endpoint = EntityType::new(KIND);
    endpoint.key = vec!["id".into()];
    endpoint.properties = PROPERTIES
        .iter()
        .map(|(name, ty, nullable)| {
            let property = Property::new(*name, TypeRef::single(*ty));
            if *nullable {
                property
            } else {
                property.required()
            }
        })
        .collect();
    let mut container = EntityContainer::new("Container");
    container.entity_sets = vec![EntitySet::new(ENTITY_SET, format!("{NAMESPACE}.{KIND}"))];
    let mut schema = Schema::new(NAMESPACE);
    schema.entity_types = vec![endpoint];
    schema.entity_container = Some(container);
    Model {
        version: CsdlVersion::V4_0,
        references: vec![],
        schemas: vec![schema],
    }
});

/// The parser's bounds: a request longer, deeper or wider than these is refused before it runs.
fn limits() -> odata_url::Limits {
    odata_url::Limits {
        max_query_len: 4096,
        max_expr_depth: 16,
        max_expr_nodes: 128,
        max_select_items: PROPERTIES.len(),
        max_orderby_items: 4,
        max_in_list_len: 100,
        max_literal_len: 256,
        ..odata_url::Limits::strict()
    }
}

/// One value of a row or of an expression.
#[derive(Debug, Clone, PartialEq)]
enum Val {
    Null,
    Bool(bool),
    Int(i64),
    Str(String),
}

impl Val {
    fn json(&self) -> Value {
        match self {
            Val::Null => Value::Null,
            Val::Bool(b) => Value::Bool(*b),
            Val::Int(i) => json!(i),
            Val::Str(s) => Value::String(s.clone()),
        }
    }

    fn type_name(&self) -> &'static str {
        match self {
            Val::Null => "null",
            Val::Bool(_) => "a true/false value",
            Val::Int(_) => "a number",
            Val::Str(_) => "a text",
        }
    }

    /// The order `$orderby` sorts by: null first, then by value.
    fn order(&self, other: &Val) -> Ordering {
        fn rank(v: &Val) -> u8 {
            match v {
                Val::Null => 0,
                Val::Bool(_) => 1,
                Val::Int(_) => 2,
                Val::Str(_) => 3,
            }
        }
        match (self, other) {
            (Val::Bool(a), Val::Bool(b)) => a.cmp(b),
            (Val::Int(a), Val::Int(b)) => a.cmp(b),
            (Val::Str(a), Val::Str(b)) => a.cmp(b),
            _ => rank(self).cmp(&rank(other)),
        }
    }
}

/// One Endpoint as the entity set holds it, in [`PROPERTIES`] order.
#[derive(Debug, Clone)]
struct Row([Val; PROPERTIES.len()]);

impl Row {
    fn of(env: &ResourceEnvelope) -> Self {
        let text = |t: &Option<jc_core::Text>| {
            t.as_ref()
                .map_or(Val::Null, |t| Val::Str(t.resolve(&[], "en").to_owned()))
        };
        let spec_str = |key: &str| {
            env.spec
                .get(key)
                .and_then(Value::as_str)
                .map_or(Val::Null, |s| Val::Str(s.to_owned()))
        };
        Row([
            Val::Str(env.metadata.name.clone()),
            text(&env.metadata.title),
            text(&env.metadata.description),
            crate::permissions::spec_space(&env.spec).map_or(Val::Null, Val::Str),
            spec_str("slug"),
            spec_str("audience"),
            // Every Endpoint serves MCP unless it says `mcp: false` (EP-24).
            Val::Bool(env.spec.get("mcp").and_then(Value::as_bool) != Some(false)),
        ])
    }

    fn get(&self, name: &str) -> Option<&Val> {
        let at = PROPERTIES.iter().position(|(n, _, _)| *n == name)?;
        self.0.get(at)
    }
}

/// Why a query is not answered: the status, the OData error code and a sentence for a person.
#[derive(Debug, PartialEq)]
struct Refusal(StatusCode, &'static str, String);

fn bad(message: impl Into<String>) -> Refusal {
    Refusal(StatusCode::BAD_REQUEST, "BadRequest", message.into())
}

fn not_implemented(what: &str) -> Refusal {
    Refusal(
        StatusCode::NOT_IMPLEMENTED,
        "NotImplemented",
        format!(
            "{what} is not served on {ENTITY_SET}; it answers $filter, $select, $orderby, $top, \
             $skip and $count"
        ),
    )
}

impl IntoResponse for Refusal {
    fn into_response(self) -> Response {
        let body = json!({ "error": { "code": self.1, "message": self.2 } });
        (self.0, odata_headers("application/json"), body.to_string()).into_response()
    }
}

fn literal(l: &Literal) -> Result<Val, Refusal> {
    match l {
        Literal::Null => Ok(Val::Null),
        Literal::Bool(b) => Ok(Val::Bool(*b)),
        Literal::Int(i) => Ok(Val::Int(*i)),
        Literal::String(s) => Ok(Val::Str(s.clone())),
        _ => Err(bad(format!(
            "the literal {l} fits no property of an Endpoint: they are texts and true/false values"
        ))),
    }
}

/// Whether `a op b` holds. Null equals only null and orders against nothing (URL 5.1.1.1).
fn compare(a: &Val, op: CompareOp, b: &Val) -> Result<bool, Refusal> {
    let ordering = match (a, b) {
        (Val::Null, Val::Null) => Some(Ordering::Equal),
        (Val::Null, _) | (_, Val::Null) => None,
        (Val::Bool(x), Val::Bool(y)) => Some(x.cmp(y)),
        (Val::Int(x), Val::Int(y)) => Some(x.cmp(y)),
        (Val::Str(x), Val::Str(y)) => Some(x.cmp(y)),
        _ => {
            return Err(bad(format!(
                "$filter compares {} with {}",
                a.type_name(),
                b.type_name()
            )))
        }
    };
    Ok(match (op, ordering) {
        (CompareOp::Eq, o) => o == Some(Ordering::Equal),
        (CompareOp::Ne, o) => o != Some(Ordering::Equal),
        (_, None) => false,
        (CompareOp::Gt, Some(o)) => o == Ordering::Greater,
        (CompareOp::Ge, Some(o)) => o != Ordering::Less,
        (CompareOp::Lt, Some(o)) => o == Ordering::Less,
        (CompareOp::Le, Some(o)) => o != Ordering::Greater,
    })
}

/// `true` only for a true value: null and false both drop a row.
fn truth(v: &Val) -> Result<bool, Refusal> {
    match v {
        Val::Bool(b) => Ok(*b),
        Val::Null => Ok(false),
        other => Err(bad(format!(
            "$filter must be true or false for a row, and this part is {}",
            other.type_name()
        ))),
    }
}

/// A text method's arguments, both texts; `None` when either is null.
fn texts(row: &Row, args: &[Expr], aliases: &Aliases) -> Result<Option<(String, String)>, Refusal> {
    let [a, b] = args else {
        return Err(bad("a text method takes two arguments"));
    };
    match (eval(a, row, aliases)?, eval(b, row, aliases)?) {
        (Val::Str(x), Val::Str(y)) => Ok(Some((x, y))),
        (Val::Null, _) | (_, Val::Null) => Ok(None),
        (x, y) => Err(bad(format!(
            "a text method reads two texts, not {} and {}",
            x.type_name(),
            y.type_name()
        ))),
    }
}

type Aliases = [(String, Literal)];

fn call(method: Method, args: &[Expr], row: &Row, aliases: &Aliases) -> Result<Val, Refusal> {
    let test: fn(&str, &str) -> bool = match method {
        Method::Contains => |a, b| a.contains(b),
        Method::StartsWith => |a, b| a.starts_with(b),
        Method::EndsWith => |a, b| a.ends_with(b),
        Method::ToLower | Method::ToUpper => {
            let [arg] = args else {
                return Err(bad("tolower and toupper take one argument"));
            };
            return Ok(match eval(arg, row, aliases)? {
                Val::Str(s) if method == Method::ToLower => Val::Str(s.to_lowercase()),
                Val::Str(s) => Val::Str(s.to_uppercase()),
                Val::Null => Val::Null,
                other => {
                    return Err(bad(format!(
                        "tolower and toupper read a text, not {}",
                        other.type_name()
                    )))
                }
            });
        }
        other => return Err(not_implemented(&format!("the method {other:?}"))),
    };
    Ok(texts(row, args, aliases)?.map_or(Val::Null, |(a, b)| Val::Bool(test(&a, &b))))
}

fn eval(e: &Expr, row: &Row, aliases: &Aliases) -> Result<Val, Refusal> {
    match e {
        Expr::Literal(l) => literal(l),
        Expr::Alias(name) => aliases
            .iter()
            .find(|(n, _)| n == name)
            .ok_or_else(|| bad(format!("the parameter alias @{name} has no value")))
            .and_then(|(_, l)| literal(l)),
        Expr::Member(path) => match (&path.variable, path.path.as_slice()) {
            (None, [name]) => row
                .get(name)
                .cloned()
                .ok_or_else(|| bad(format!("an Endpoint has no property {name}"))),
            _ => Err(not_implemented(&format!("the path {path}"))),
        },
        Expr::Compare(a, op, b) => Ok(Val::Bool(compare(
            &eval(a, row, aliases)?,
            *op,
            &eval(b, row, aliases)?,
        )?)),
        Expr::In(a, list) => {
            let a = eval(a, row, aliases)?;
            for l in list {
                if compare(&a, CompareOp::Eq, &literal(l)?)? {
                    return Ok(Val::Bool(true));
                }
            }
            Ok(Val::Bool(false))
        }
        Expr::And(a, b) => Ok(Val::Bool(
            truth(&eval(a, row, aliases)?)? && truth(&eval(b, row, aliases)?)?,
        )),
        Expr::Or(a, b) => Ok(Val::Bool(
            truth(&eval(a, row, aliases)?)? || truth(&eval(b, row, aliases)?)?,
        )),
        Expr::Not(a) => Ok(Val::Bool(!truth(&eval(a, row, aliases)?)?)),
        Expr::Call(method, args) => call(*method, args, row, aliases),
        Expr::Arith(..) | Expr::Neg(_) => Err(not_implemented("arithmetic")),
        Expr::Any { .. } | Expr::All { .. } => Err(not_implemented("any and all")),
    }
}

/// The options this entity set does not serve, refused by name rather than ignored.
fn refuse_unserved(o: &QueryOptions) -> Result<(), Refusal> {
    let unserved = [
        ("$search", o.search.is_some()),
        ("$compute", o.compute.is_some()),
        ("$apply", o.apply.is_some()),
        ("$expand", o.expand.is_some()),
        ("$skiptoken", o.skiptoken.is_some()),
        ("$schemaversion", o.schemaversion.is_some()),
        ("$id", o.id.is_some()),
    ];
    if let Some((name, _)) = unserved.iter().find(|(_, set)| *set) {
        return Err(not_implemented(name));
    }
    match &o.format {
        None | Some(Format::Json) => Ok(()),
        Some(Format::MediaType(m)) if m.starts_with("application/json") => Ok(()),
        Some(other) => Err(Refusal(
            StatusCode::NOT_ACCEPTABLE,
            "NotAcceptable",
            format!("$format={other} is not served; {ENTITY_SET} answers JSON"),
        )),
    }
}

/// The selected property names, in [`PROPERTIES`] order; every one without `$select` or with `*`.
fn selected(select: Option<&[SelectItem]>) -> Result<Vec<&'static str>, Refusal> {
    let all = || PROPERTIES.iter().map(|(n, _, _)| *n).collect();
    let Some(items) = select else {
        return Ok(all());
    };
    let mut names = Vec::new();
    for item in items {
        match item {
            SelectItem::Star => return Ok(all()),
            SelectItem::Path(path) => match path.as_slice() {
                [name] => names.push(name.as_str()),
                _ => return Err(not_implemented(&format!("$select={}", path.join("/")))),
            },
            SelectItem::Annotation(a) => return Err(not_implemented(&format!("$select={a}"))),
        }
    }
    Ok(PROPERTIES
        .iter()
        .map(|(n, _, _)| *n)
        .filter(|n| names.contains(n))
        .collect())
}

/// Sorts `rows` by `$orderby`, then by `id`, so every page of one query reads the same order.
fn sort(rows: Vec<Row>, orderby: &[OrderBy], aliases: &Aliases) -> Result<Vec<Row>, Refusal> {
    let mut keyed = rows
        .into_iter()
        .map(|row| {
            let keys = orderby
                .iter()
                .map(|o| eval(&o.expr, &row, aliases))
                .collect::<Result<Vec<_>, _>>()?;
            Ok((keys, row))
        })
        .collect::<Result<Vec<_>, Refusal>>()?;
    keyed.sort_by(|(ka, ra), (kb, rb)| {
        ka.iter()
            .zip(kb)
            .zip(orderby)
            .map(|((a, b), o)| {
                let ord = a.order(b);
                if o.descending {
                    ord.reverse()
                } else {
                    ord
                }
            })
            .find(|o| o.is_ne())
            .unwrap_or_else(|| {
                ra.0.first()
                    .zip(rb.0.first())
                    .map_or(Ordering::Equal, |(a, b)| a.order(b))
            })
    });
    Ok(keyed.into_iter().map(|(_, row)| row).collect())
}

/// The answer to `Endpoints?{query}` over `rows`, the rows the caller may read; `root` is the
/// service root URL, ending in `/`.
fn answer(rows: Vec<Row>, query: &str, root: &str) -> Result<Value, Refusal> {
    let uri = if query.is_empty() {
        ENTITY_SET.to_owned()
    } else {
        format!("{ENTITY_SET}?{query}")
    };
    let parsed =
        odata_url::parse(&uri, &EdmModel(&MODEL), &limits()).map_err(|e| match e.kind {
            UrlErrorKind::NotImplemented(_) => not_implemented(&e.to_string()),
            UrlErrorKind::Unresolved => bad(format!(
                "{e} of `{uri}`: an Endpoint has {}",
                PROPERTIES.map(|(n, _, _)| n).join(", ")
            )),
            _ => bad(format!("{e} of `{uri}`")),
        })?;
    let ODataUri::Resource { path, options } = parsed else {
        return Err(bad(format!(
            "only the entity set {ENTITY_SET} is served here"
        )));
    };
    if path != [Segment::EntitySet(ENTITY_SET.into())] {
        return Err(not_implemented("a path below the entity set"));
    }
    refuse_unserved(&options)?;
    let aliases = options.aliases.as_slice();
    let top = match options.top {
        Some(top) if top > MAX_TOP => {
            return Err(bad(format!(
                "$top is at most {MAX_TOP}, and this asks {top}"
            )))
        }
        top => top,
    };
    let mut kept = Vec::new();
    for row in rows {
        let keep = match &options.filter {
            Some(filter) => truth(&eval(filter, &row, aliases)?)?,
            None => true,
        };
        if keep {
            kept.push(row);
        }
    }
    let kept = sort(kept, options.orderby.as_deref().unwrap_or(&[]), aliases)?;
    let total = kept.len();
    let skip = usize::try_from(options.skip.unwrap_or(0)).unwrap_or(usize::MAX);
    let page = usize::try_from(top.unwrap_or(MAX_TOP)).unwrap_or(usize::MAX);
    let names = selected(options.select.as_deref())?;
    let value: Vec<Value> = kept
        .iter()
        .skip(skip)
        .take(page)
        .map(|row| {
            let mut item = Map::new();
            for name in &names {
                item.insert(
                    (*name).to_owned(),
                    row.get(name).map_or(Value::Null, Val::json),
                );
            }
            Value::Object(item)
        })
        .collect();
    let mut body = Map::new();
    let context = match options.select {
        Some(_) => format!("{root}$metadata#{ENTITY_SET}({})", names.join(",")),
        None => format!("{root}$metadata#{ENTITY_SET}"),
    };
    body.insert("@odata.context".into(), Value::String(context));
    if options.count == Some(true) {
        body.insert("@odata.count".into(), json!(total));
    }
    body.insert("value".into(), Value::Array(value));
    // Server-driven paging only when the client set no $top: the next page is the same query
    // with $skip moved on by one page.
    if top.is_none() && total > skip.saturating_add(page) {
        let mut next = options.clone();
        next.skip = Some(options.skip.unwrap_or(0).saturating_add(MAX_TOP));
        let next = ODataUri::Resource {
            path,
            options: next,
        };
        body.insert(
            "@odata.nextLink".into(),
            Value::String(format!("{root}{next}")),
        );
    }
    Ok(Value::Object(body))
}

fn odata_headers(content_type: &'static str) -> [(header::HeaderName, HeaderValue); 2] {
    [
        (header::CONTENT_TYPE, HeaderValue::from_static(content_type)),
        (
            header::HeaderName::from_static("odata-version"),
            HeaderValue::from_static("4.0"),
        ),
    ]
}

/// The rows of `project` the caller may read: the kind check, then each manifest's own (a grant
/// bound to one context space reads that space's Endpoints alone), both before any OData option.
fn readable(state: &AppState, user: &CurrentUser, project: &str) -> Result<Vec<Row>, ApiError> {
    let effective = crate::permissions::for_request(state, &user.0.identity, project);
    if !effective.may_read_some(KIND) {
        return Err(ApiError::NotFound(format!(
            "no OData service in project '{project}': you read no Endpoint there"
        )));
    }
    Ok(state
        .mirror
        .list(project, KIND, &ListOptions::default())
        .items
        .iter()
        .filter(|env| effective.may_read_envelope(KIND, env))
        .map(Row::of)
        .collect())
}

fn service_root(state: &AppState, project: &str) -> String {
    format!(
        "{}/api/v1/projects/{project}/odata/",
        state.config.public_base_url.as_str().trim_end_matches('/')
    )
}

/// `GET /api/v1/projects/{project}/odata/Endpoints` (T-6632).
#[utoipa::path(
    get,
    path = "/api/v1/projects/{project}/odata/Endpoints",
    summary = "Query Endpoints with OData",
    description = "The project's Endpoints the caller may read, as the OData 4.0 entity set Endpoints: $filter (eq, ne, gt, ge, lt, le, in, and, or, not, contains, startswith, endswith, tolower, toupper), $select, $orderby, $top (at most 1000), $skip and $count over id, title, description, contextSpace, slug, audience and mcp (T-6632).",
    tag = "resources",
    params(
        ("project" = String, Path, description = "Project name, e.g. helsinki"),
        ("$filter" = Option<String>, Query, description = "A predicate over the properties, e.g. contextSpace eq 'air' and startswith(id,'bikes')"),
        ("$select" = Option<String>, Query, description = "Properties to return, comma-separated, e.g. id,title"),
        ("$orderby" = Option<String>, Query, description = "Properties to sort by, each with asc or desc, e.g. title desc"),
        ("$top" = Option<u64>, Query, description = "Rows to return, 0 to 1000, e.g. 50"),
        ("$skip" = Option<u64>, Query, description = "Rows to skip first, e.g. 50"),
        ("$count" = Option<bool>, Query, description = "true adds @odata.count, the rows the filter keeps"),
    ),
    responses(
        (status = 200, description = "The OData collection: @odata.context, @odata.count when asked, value and @odata.nextLink when more rows follow", body = Object),
        (status = 400, description = "A name an Endpoint does not have, a bad expression, a $top above 1000 or a query over its bounds, as an OData error"),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 404, description = "A project where the caller reads no Endpoint", body = ProblemDetails),
        (status = 501, description = "An OData option or function this entity set does not serve, as an OData error"),
    )
)]
pub async fn query_endpoints(
    user: CurrentUser,
    State(state): State<AppState>,
    Path(project): Path<String>,
    RawQuery(query): RawQuery,
) -> Result<Response, ApiError> {
    let rows = readable(&state, &user, &project)?;
    let root = service_root(&state, &project);
    Ok(match answer(rows, query.as_deref().unwrap_or(""), &root) {
        Ok(body) => (
            odata_headers("application/json;odata.metadata=minimal"),
            body.to_string(),
        )
            .into_response(),
        Err(refusal) => refusal.into_response(),
    })
}

/// `GET /api/v1/projects/{project}/odata/$metadata` (T-6632).
#[utoipa::path(
    get,
    path = "/api/v1/projects/{project}/odata/$metadata",
    summary = "Read the OData Metadata",
    description = "The CSDL XML document of the project's OData service: the entity type Endpoint and the entity set Endpoints (T-6632).",
    tag = "resources",
    params(("project" = String, Path, description = "Project name, e.g. helsinki")),
    responses(
        (status = 200, description = "CSDL XML, OData 4.0", content_type = "application/xml", body = String),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 404, description = "A project where the caller reads no Endpoint", body = ProblemDetails),
    )
)]
pub async fn metadata(
    user: CurrentUser,
    State(state): State<AppState>,
    Path(project): Path<String>,
) -> Result<Response, ApiError> {
    readable(&state, &user, &project)?;
    let mut xml = Vec::new();
    odata_csdl::write_xml(&MODEL, &odata_csdl::Limits::strict(), &mut xml)
        .map_err(|e| ApiError::Internal(format!("the OData metadata did not write: {e}")))?;
    Ok((odata_headers("application/xml"), xml).into_response())
}

/// `GET /api/v1/projects/{project}/odata/` (T-6632).
#[utoipa::path(
    get,
    path = "/api/v1/projects/{project}/odata/",
    summary = "Read the OData Service Document",
    description = "The service document of the project's OData service: the entity sets it serves, Endpoints today (T-6632).",
    tag = "resources",
    params(("project" = String, Path, description = "Project name, e.g. helsinki")),
    responses(
        (status = 200, description = "The OData service document", body = Object),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 404, description = "A project where the caller reads no Endpoint", body = ProblemDetails),
    )
)]
pub async fn service_document(
    user: CurrentUser,
    State(state): State<AppState>,
    Path(project): Path<String>,
) -> Result<Response, ApiError> {
    readable(&state, &user, &project)?;
    let body = json!({
        "@odata.context": format!("{}$metadata", service_root(&state, &project)),
        "value": [{ "name": ENTITY_SET, "kind": "EntitySet", "url": ENTITY_SET }],
    });
    Ok((
        odata_headers("application/json;odata.metadata=minimal"),
        body.to_string(),
    )
        .into_response())
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/projects/{project}/odata/", get(service_document))
        .route("/projects/{project}/odata/$metadata", get(metadata))
        .route("/projects/{project}/odata/Endpoints", get(query_endpoints))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT: &str = "https://portal.example.org/api/v1/projects/p/odata/";

    fn row(id: &str, title: Option<&str>, space: &str, mcp: bool) -> Row {
        Row([
            Val::Str(id.into()),
            title.map_or(Val::Null, |t| Val::Str(t.into())),
            Val::Null,
            Val::Str(space.into()),
            Val::Str(format!("slug{id}")),
            Val::Str("public".into()),
            Val::Bool(mcp),
        ])
    }

    fn rows() -> Vec<Row> {
        vec![
            row("bikes", Some("Bike counters"), "air", true),
            row("trams", Some("Tram stops"), "water", false),
            row("air-quality", None, "air", true),
        ]
    }

    fn ids(query: &str) -> Vec<String> {
        let body = answer(rows(), query, ROOT).unwrap_or_else(|r| panic!("{query}: {r:?}"));
        body["value"]
            .as_array()
            .unwrap_or(&vec![])
            .iter()
            .map(|v| v["id"].as_str().unwrap_or_default().to_owned())
            .collect()
    }

    fn refused(query: &str) -> Refusal {
        match answer(rows(), query, ROOT) {
            Err(r) => r,
            Ok(body) => panic!("{query} answered {body}"),
        }
    }

    #[test]
    fn every_comparison_operator_keeps_the_rows_it_names() {
        assert_eq!(
            ids("$filter=contextSpace eq 'air'"),
            ["air-quality", "bikes"]
        );
        assert_eq!(ids("$filter=contextSpace ne 'air'"), ["trams"]);
        assert_eq!(ids("$filter=id gt 'bikes'"), ["trams"]);
        assert_eq!(ids("$filter=id lt 'bikes'"), ["air-quality"]);
        assert_eq!(ids("$filter=id ge 'bikes'"), ["bikes", "trams"]);
        assert_eq!(ids("$filter=id le 'bikes'"), ["air-quality", "bikes"]);
        assert_eq!(ids("$filter=mcp eq false"), ["trams"]);
        assert_eq!(ids("$filter=id in ('trams','bikes')"), ["bikes", "trams"]);
    }

    #[test]
    fn null_equals_only_null_and_orders_against_nothing() {
        assert_eq!(ids("$filter=title eq null"), ["air-quality"]);
        assert_eq!(ids("$filter=title ne null"), ["bikes", "trams"]);
        assert_eq!(ids("$filter=title gt 'A'"), ["bikes", "trams"]);
    }

    #[test]
    fn and_or_and_not_combine_predicates() {
        assert_eq!(
            ids("$filter=contextSpace eq 'air' and mcp eq true"),
            ["air-quality", "bikes"]
        );
        assert_eq!(
            ids("$filter=id eq 'trams' or id eq 'bikes'"),
            ["bikes", "trams"]
        );
        assert_eq!(ids("$filter=not (contextSpace eq 'air')"), ["trams"]);
    }

    #[test]
    fn the_text_methods_match_inside_at_the_start_and_at_the_end() {
        assert_eq!(ids("$filter=contains(title,'counter')"), ["bikes"]);
        assert_eq!(ids("$filter=startswith(id,'air')"), ["air-quality"]);
        assert_eq!(ids("$filter=endswith(id,'ms')"), ["trams"]);
        assert_eq!(ids("$filter=contains(tolower(title),'tram')"), ["trams"]);
        assert_eq!(ids("$filter=startswith(toupper(id),'BI')"), ["bikes"]);
    }

    #[test]
    fn a_parameter_alias_is_read_as_its_literal() {
        assert_eq!(ids("$filter=id eq @which&@which='trams'"), ["trams"]);
    }

    #[test]
    fn a_name_an_endpoint_does_not_have_is_refused_400() {
        for query in ["$filter=owner eq 'x'", "$select=owner", "$orderby=owner"] {
            let r = refused(query);
            assert_eq!(r.0, StatusCode::BAD_REQUEST, "{query}: {r:?}");
            assert!(r.2.contains("an Endpoint has id, title"), "{query}: {r:?}");
        }
    }

    #[test]
    fn a_type_mismatch_and_a_non_boolean_filter_are_refused_400() {
        assert_eq!(refused("$filter=id eq 3").0, StatusCode::BAD_REQUEST);
        assert_eq!(refused("$filter=title").0, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn select_returns_only_the_named_properties_and_says_so_in_the_context() {
        let body = answer(rows(), "$select=title,id&$filter=id eq 'bikes'", ROOT).expect("answer");
        assert_eq!(
            body["value"],
            json!([{ "id": "bikes", "title": "Bike counters" }])
        );
        assert_eq!(
            body["@odata.context"],
            json!(format!("{ROOT}$metadata#Endpoints(id,title)"))
        );
        let all = answer(rows(), "$select=*&$top=1", ROOT).expect("answer");
        assert_eq!(
            all["value"][0].as_object().map(Map::len),
            Some(PROPERTIES.len())
        );
    }

    #[test]
    fn orderby_sorts_ascending_descending_and_nulls_first() {
        assert_eq!(ids("$orderby=title"), ["air-quality", "bikes", "trams"]);
        assert_eq!(
            ids("$orderby=title desc"),
            ["trams", "bikes", "air-quality"]
        );
        assert_eq!(
            ids("$orderby=contextSpace desc,id desc"),
            ["trams", "bikes", "air-quality"]
        );
    }

    #[test]
    fn top_skip_and_count_page_the_filtered_rows() {
        let body = answer(rows(), "$count=true&$top=1&$skip=1&$orderby=id", ROOT).expect("answer");
        assert_eq!(body["@odata.count"], json!(3));
        assert_eq!(body["value"], json!([rows_json("bikes")]));
        assert!(body.get("@odata.nextLink").is_none(), "{body}");
        let counted =
            answer(rows(), "$count=true&$filter=mcp eq true&$top=0", ROOT).expect("answer");
        assert_eq!(counted["@odata.count"], json!(2));
        assert_eq!(counted["value"], json!([]));
    }

    fn rows_json(id: &str) -> Value {
        json!({ "id": id, "title": "Bike counters", "description": null, "contextSpace": "air",
                "slug": format!("slug{id}"), "audience": "public", "mcp": true })
    }

    #[test]
    fn top_is_capped_and_a_read_without_top_pages_on_with_a_next_link() {
        let r = refused("$top=1001");
        assert_eq!(r.0, StatusCode::BAD_REQUEST);
        assert!(r.2.contains("1000"), "{r:?}");
        let many: Vec<Row> = (0..1001)
            .map(|i| row(&format!("e{i:04}"), None, "air", true))
            .collect();
        let body = answer(many.clone(), "$filter=contextSpace eq 'air'", ROOT).expect("answer");
        assert_eq!(body["value"].as_array().map(Vec::len), Some(1000));
        let next = body["@odata.nextLink"].as_str().expect("a next link");
        let query = next
            .strip_prefix(&format!("{ROOT}Endpoints?"))
            .expect("same entity set");
        assert!(query.contains("$skip=1000"), "{next}");
        let second = answer(many, query, ROOT).expect("the next page");
        assert_eq!(
            second["value"],
            json!([{ "id": "e1000", "title": null, "description": null,
            "contextSpace": "air", "slug": "sluge1000", "audience": "public", "mcp": true }])
        );
        assert!(second.get("@odata.nextLink").is_none());
    }

    #[test]
    fn an_expression_over_its_depth_or_length_is_refused() {
        let deep = format!("$filter={}id eq 'x'{}", "(".repeat(40), ")".repeat(40));
        assert_eq!(refused(&deep).0, StatusCode::BAD_REQUEST);
        let long = format!("$filter=id eq '{}'", "x".repeat(5000));
        assert_eq!(refused(&long).0, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn an_option_or_function_outside_the_pilot_is_refused_501_by_name() {
        for (query, named) in [
            ("$expand=x", "$expand"),
            ("$search=bikes", "$search"),
            ("$filter=length(id) gt 3", ""),
        ] {
            let r = refused(query);
            assert!(
                matches!(r.0, StatusCode::NOT_IMPLEMENTED | StatusCode::BAD_REQUEST),
                "{query}: {r:?}"
            );
            assert!(r.2.contains(named), "{query}: {r:?}");
        }
        assert_eq!(refused("$search=bikes").0, StatusCode::NOT_IMPLEMENTED);
        assert_eq!(
            refused("$filter=length(id) gt 3").0,
            StatusCode::NOT_IMPLEMENTED
        );
        assert_eq!(refused("$format=xml").0, StatusCode::NOT_ACCEPTABLE);
    }

    #[test]
    fn the_metadata_document_names_the_entity_set_and_every_property() {
        let mut xml = Vec::new();
        odata_csdl::write_xml(&MODEL, &odata_csdl::Limits::strict(), &mut xml).expect("xml");
        let xml = String::from_utf8(xml).expect("utf-8");
        assert!(xml.contains(r#"<EntitySet Name="Endpoints""#), "{xml}");
        for (name, _, _) in PROPERTIES {
            assert!(
                xml.contains(&format!(r#"Name="{name}""#)),
                "{name} missing: {xml}"
            );
        }
    }
}
