//! OData 4.0 over the Portal's own lists (T-6632, pilot on one list): the project's Endpoints as
//! the entity set `Endpoints`, read with `$filter`, `$select`, `$orderby`, `$top`, `$skip` and
//! `$count`, so an OData client (Excel, Power BI, Microsoft.OData.Client) reads what the
//! Endpoints page lists.
//!
//! The URL is parsed by the default broker's `odata-url` crate against the CSDL model below
//! (`odata-csdl`), the same library Antares serves its OData surface with: a name the model does
//! not hold is refused by the parser, so only the allow-listed properties of `PROPERTIES` reach
//! a predicate. The rows are the store's manifests, not a SQL table, so the query runs over them
//! in memory, after the read check: an Endpoint the caller may not read is never filtered,
//! counted or paged (API/13 section 2).

use std::cmp::Ordering;
use std::sync::LazyLock;

use axum::body::Bytes;
use axum::extract::{Path, Query, RawQuery, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use odata_csdl::{
    Annotation, CsdlVersion, EntityContainer, EntitySet, EntityType, Expr as CsdlExpr, Include,
    Model, Property, Reference, Schema, TypeRef,
};
use odata_url::{
    CompareOp, EdmModel, Expr, Format, Literal, Method, ODataUri, OrderBy, QueryOptions, Segment,
    SelectItem, UrlErrorKind,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use utoipa::IntoParams;

use crate::api::dry_run::DryRunQuery;
use crate::auth::session::Front;
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
///
/// A row is one of three (T-6645, the rows of the Endpoints page, T-6169): `own`, an Endpoint of
/// this project, keyed by its name; `shared`, an Endpoint another project shares with this one
/// (EP-14), keyed `{source}/{name}`; `gone`, this project's SharedSpaceReference whose Endpoint no
/// longer shows (EP-15), keyed `reference:{name}`. A manifest name holds neither `/` nor `:`, so
/// the three key spaces never meet.
const PROPERTIES: [(&str, &str, bool); 14] = [
    ("id", "Edm.String", false),
    ("name", "Edm.String", false),
    ("title", "Edm.String", true),
    ("description", "Edm.String", true),
    ("contextSpace", "Edm.String", true),
    ("slug", "Edm.String", true),
    ("audience", "Edm.String", true),
    ("mcp", "Edm.Boolean", false),
    ("source", "Edm.String", true),
    ("kind", "Edm.String", false),
    ("reference", "Edm.String", true),
    ("phase", "Edm.String", true),
    ("representations", "Edm.String", true),
    ("calls7d", "Edm.Int64", true),
];

/// The properties a `PATCH` may change, each with the manifest field it writes: what the
/// Endpoints grid edits in place, as its ManifestGrid did (T-6169). The rest is the form's.
const EDITABLE: [(&str, &str); 3] = [
    ("contextSpace", "contextSpaceRef"),
    ("audience", "audience"),
    ("mcp", "mcp"),
];

/// The functions `$filter` serves, as `Capabilities.FilterFunctions` names them.
const FILTER_FUNCTIONS: [&str; 5] = ["contains", "startswith", "endswith", "tolower", "toupper"];

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
    let mut set = EntitySet::new(ENTITY_SET, format!("{NAMESPACE}.{KIND}"));
    // The functions `$filter` serves, so a client knows a case-blind search can ask tolower
    // (the SDK grid's search box, T-6645).
    set.annotations = vec![Annotation::new(
        "Capabilities.FilterFunctions",
        CsdlExpr::Collection(
            FILTER_FUNCTIONS
                .iter()
                .map(|f| CsdlExpr::String((*f).to_owned()))
                .collect(),
        ),
    )];
    container.entity_sets = vec![set];
    let mut schema = Schema::new(NAMESPACE);
    schema.entity_types = vec![endpoint];
    schema.entity_container = Some(container);
    Model {
        version: CsdlVersion::V4_0,
        references: vec![Reference {
            uri: "https://oasis-tcs.github.io/odata-vocabularies/vocabularies/Org.OData.Capabilities.V1.xml".into(),
            includes: vec![Include {
                namespace: "Org.OData.Capabilities.V1".into(),
                alias: Some("Capabilities".into()),
            }],
        }],
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

/// A row's kind, the `kind` property.
const OWN: &str = "own";
const SHARED: &str = "shared";
const GONE: &str = "gone";

fn text(t: Option<&jc_core::Text>) -> Val {
    t.map_or(Val::Null, |t| Val::Str(t.resolve(&[], "en").to_owned()))
}

fn spec_str(env: &ResourceEnvelope, key: &str) -> Val {
    env.spec
        .get(key)
        .and_then(Value::as_str)
        .map_or(Val::Null, |s| Val::Str(s.to_owned()))
}

fn opt(value: Option<&str>) -> Val {
    value.map_or(Val::Null, |s| Val::Str(s.to_owned()))
}

impl Row {
    /// An Endpoint row: `source` the project publishing it, `kind` own or shared, `reference`
    /// this project's reference to it, `calls` its calls in the last 7 days where counted.
    fn endpoint(
        env: &ResourceEnvelope,
        source: &str,
        kind: &'static str,
        reference: Option<&str>,
        calls: Option<u64>,
    ) -> Self {
        let name = env.metadata.name.clone();
        let id = if kind == OWN {
            name.clone()
        } else {
            format!("{source}/{name}")
        };
        let representations = env
            .spec
            .get("enabledRepresentations")
            .and_then(Value::as_array)
            .map(|reps| {
                reps.iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(",")
            });
        let phase = env
            .status
            .as_ref()
            .and_then(|status| serde_json::to_value(&status.phase).ok())
            .and_then(|phase| phase.as_str().map(str::to_owned));
        Row([
            Val::Str(id),
            Val::Str(name),
            text(env.metadata.title.as_ref()),
            text(env.metadata.description.as_ref()),
            crate::permissions::spec_space(&env.spec).map_or(Val::Null, Val::Str),
            spec_str(env, "slug"),
            spec_str(env, "audience"),
            // Every Endpoint serves MCP unless it says `mcp: false` (EP-24).
            Val::Bool(env.spec.get("mcp").and_then(Value::as_bool) != Some(false)),
            Val::Str(source.to_owned()),
            Val::Str(kind.to_owned()),
            opt(reference),
            opt(phase.as_deref()),
            opt(representations.as_deref()),
            calls.map_or(Val::Null, |n| {
                Val::Int(i64::try_from(n).unwrap_or(i64::MAX))
            }),
        ])
    }

    /// A reference of this project whose Endpoint no longer shows (EP-15): a row still, because
    /// a grant nobody lists is a grant nobody can remove (T-0706).
    fn gone(reference: &ResourceEnvelope) -> Self {
        let name = reference.metadata.name.clone();
        Row([
            Val::Str(format!("reference:{name}")),
            Val::Str(name.clone()),
            opt(reference.spec.get("alias").and_then(Value::as_str)),
            Val::Null,
            Val::Null,
            spec_str(reference, "endpointSlug"),
            Val::Null,
            Val::Bool(false),
            Val::Null,
            Val::Str(GONE.to_owned()),
            Val::Str(name),
            Val::Null,
            Val::Null,
            Val::Null,
        ])
    }

    fn get(&self, name: &str) -> Option<&Val> {
        let at = PROPERTIES.iter().position(|(n, _, _)| *n == name)?;
        self.0.get(at)
    }

    fn str(&self, name: &str) -> Option<&str> {
        match self.get(name) {
            Some(Val::Str(s)) => Some(s),
            _ => None,
        }
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
            "the literal {l} fits no property of an Endpoint: they are texts, whole numbers and true/false values"
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
        Expr::Call(method, args) => call(*method, args, row, aliases),
        Expr::Arith(..) | Expr::Neg(_) => Err(not_implemented("arithmetic")),
        Expr::Any { .. } | Expr::All { .. } => Err(not_implemented("any and all")),
        logical => logic(logical, row, aliases).map(Val::Bool),
    }
}

/// The comparison and boolean operators.
fn logic(e: &Expr, row: &Row, aliases: &Aliases) -> Result<bool, Refusal> {
    let holds = |x: &Expr| truth(&eval(x, row, aliases)?);
    match e {
        Expr::Compare(a, op, b) => compare(&eval(a, row, aliases)?, *op, &eval(b, row, aliases)?),
        Expr::In(a, list) => {
            let a = eval(a, row, aliases)?;
            for l in list {
                if compare(&a, CompareOp::Eq, &literal(l)?)? {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        Expr::And(a, b) => Ok(holds(a)? && holds(b)?),
        Expr::Or(a, b) => Ok(holds(a)? || holds(b)?),
        Expr::Not(a) => Ok(!holds(a)?),
        other => Err(not_implemented(&format!("the expression {other}"))),
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

/// `Endpoints?{query}` parsed against the model, every option outside the pilot and a `$top`
/// over [`MAX_TOP`] refused.
fn parse_query(query: &str) -> Result<QueryOptions, Refusal> {
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
    match options.top {
        Some(top) if top > MAX_TOP => Err(bad(format!(
            "$top is at most {MAX_TOP}, and this asks {top}"
        ))),
        _ => Ok(options),
    }
}

/// The rows `$filter` keeps, in `$orderby` order.
fn kept(rows: Vec<Row>, options: &QueryOptions) -> Result<Vec<Row>, Refusal> {
    let aliases = options.aliases.as_slice();
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
    sort(kept, options.orderby.as_deref().unwrap_or(&[]), aliases)
}

/// The answer to `Endpoints?{query}` over `rows`, the rows the caller may read; `root` is the
/// service root URL, ending in `/`.
fn answer(rows: Vec<Row>, query: &str, root: &str) -> Result<Value, Refusal> {
    let options = parse_query(query)?;
    let kept = kept(rows, &options)?;
    let top = options.top;
    let total = kept.len();
    let skip = usize::try_from(options.skip.unwrap_or(0)).unwrap_or(usize::MAX);
    let page = usize::try_from(top.unwrap_or(MAX_TOP)).unwrap_or(usize::MAX);
    let names = selected(options.select.as_deref())?;
    let value: Vec<Value> = kept
        .iter()
        .skip(skip)
        .take(page)
        .map(|row| Value::Object(row_json(row, &names)))
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
            path: vec![Segment::EntitySet(ENTITY_SET.into())],
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

/// The read check of `project`'s service: the kind check, before any OData option. A project
/// where the caller reads no Endpoint has no service.
fn gate(
    state: &AppState,
    user: &CurrentUser,
    project: &str,
) -> Result<crate::permissions::Effective, ApiError> {
    let effective = crate::permissions::for_request(state, &user.0.identity, project);
    if !effective.may_read_some(KIND) {
        return Err(ApiError::NotFound(format!(
            "no OData service in project '{project}': you read no Endpoint there"
        )));
    }
    Ok(effective)
}

/// The manifests of `kind` in `project` the caller may read: the kind check, then each manifest's
/// own (a grant bound to one context space reads that space's Endpoints alone).
fn readable_of(
    state: &AppState,
    effective: &crate::permissions::Effective,
    project: &str,
    kind: &str,
) -> Vec<ResourceEnvelope> {
    if !effective.may_read_some(kind) {
        return Vec::new();
    }
    state
        .mirror
        .list(project, kind, &ListOptions::default())
        .items
        .into_iter()
        .filter(|env| effective.may_read_envelope(kind, env))
        .collect()
}

/// Whether `project` may call an Endpoint `owner` publishes: the gateway's own rule (EP-14), as
/// the Endpoints page reads it (ui sharing.tsx `admits`).
fn admits(env: &ResourceEnvelope, owner: &str, project: &str) -> bool {
    if owner == project {
        return true;
    }
    match env.spec.get("audience").and_then(Value::as_str) {
        Some("organization" | "public") => true,
        None | Some("project-list") => env
            .spec
            .get("allowedProjects")
            .and_then(Value::as_array)
            .is_some_and(|list| list.iter().any(|p| p.as_str() == Some(project))),
        Some(_) => false,
    }
}

/// The reference of `references` to `source`'s Endpoint `env`: by `endpointRef` where it names
/// one, else by slug (ui sharing.tsx `referenceTo`).
fn reference_to<'a>(
    references: &'a [ResourceEnvelope],
    env: &ResourceEnvelope,
    source: &str,
) -> Option<&'a ResourceEnvelope> {
    let slug = env.spec.get("slug").and_then(Value::as_str).unwrap_or("");
    references
        .iter()
        .find(|reference| match reference.spec.get("endpointRef") {
            Some(target) => {
                target.get("project").and_then(Value::as_str) == Some(source)
                    && target.get("name").and_then(Value::as_str)
                        == Some(env.metadata.name.as_str())
            }
            None => {
                !slug.is_empty()
                    && reference.spec.get("endpointSlug").and_then(Value::as_str) == Some(slug)
            }
        })
}

/// Calls per own Endpoint in the last 7 days, as the gateways count them (T-5118); `None` when
/// the usage database does not answer, so the rows still show and the count reads as unknown.
async fn calls_7d(
    state: &AppState,
    project: &str,
) -> Option<std::collections::HashMap<String, u64>> {
    let (from, to) = crate::endpoint_usage::window(chrono::Utc::now().date_naive(), 7);
    match state.endpoint_usage.read(project, from, to).await {
        Ok(rows) => Some(
            rows.iter()
                .fold(std::collections::HashMap::new(), |mut totals, row| {
                    *totals.entry(row.name.clone()).or_insert(0) += row.calls;
                    totals
                }),
        ),
        Err(e) => {
            tracing::warn!(error = %e, project, "the OData Endpoints rows carry no calls: the usage rows were not read");
            None
        }
    }
}

/// The rows of `project` the caller may read, in the page's order: own Endpoints, then those
/// other projects share with it, then references whose Endpoint went away (T-6169). Every row
/// passes the read check of the project it lives in before any OData option sees it.
async fn rows(state: &AppState, user: &CurrentUser, project: &str) -> Result<Vec<Row>, ApiError> {
    let effective = gate(state, user, project)?;
    let identity = &user.0.identity;
    let calls = calls_7d(state, project).await;
    let references = readable_of(state, &effective, project, "SharedSpaceReference");
    let mut rows: Vec<Row> = readable_of(state, &effective, project, KIND)
        .iter()
        .map(|env| {
            let counted = calls
                .as_ref()
                .map(|calls| calls.get(&env.metadata.name).copied().unwrap_or(0));
            Row::endpoint(env, project, OWN, None, counted)
        })
        .collect();
    let mut used = std::collections::HashSet::new();
    for source in state.mirror.namespaces() {
        if source == project || !crate::api::projects::readable(state, identity, &source) {
            continue;
        }
        let theirs = crate::permissions::for_request(state, identity, &source);
        for env in readable_of(state, &theirs, &source, KIND) {
            if !admits(&env, &source, project) {
                continue;
            }
            let reference = reference_to(&references, &env, &source);
            if let Some(reference) = reference {
                used.insert(reference.metadata.name.clone());
            }
            let name = reference.map(|r| r.metadata.name.as_str());
            rows.push(Row::endpoint(&env, &source, SHARED, name, None));
        }
    }
    rows.extend(
        references
            .iter()
            .filter(|reference| !used.contains(&reference.metadata.name))
            .map(Row::gone),
    );
    Ok(rows)
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
    description = "The project's Endpoints the caller may read, as the OData 4.0 entity set Endpoints: $filter (eq, ne, gt, ge, lt, le, in, and, or, not, contains, startswith, endswith, tolower, toupper), $select, $orderby, $top (at most 1000), $skip and $count over id, name, title, description, contextSpace, slug, audience, mcp, source, kind (own, shared or gone), reference, phase, representations and calls7d: the project's own Endpoints, those other projects share with it and its references whose Endpoint went away, each after the read check of the project it lives in (T-6632, T-6645).",
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
    let rows = rows(&state, &user, &project).await?;
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

/// The key of `Endpoints('<key>')`, the quote doubling undone; `None` for any other segment.
fn key_of(segment: &str) -> Option<String> {
    let inner = segment
        .strip_prefix(ENTITY_SET)?
        .strip_prefix("('")?
        .strip_suffix("')")?;
    // A lone quote inside the literal ends it: `'a'b'` is no key.
    if inner.replace("''", "").contains('\'') {
        return None;
    }
    Some(inner.replace("''", "'"))
}

/// One row as JSON, with the selected properties.
fn row_json(row: &Row, names: &[&str]) -> Map<String, Value> {
    names
        .iter()
        .map(|name| {
            (
                (*name).to_owned(),
                row.get(name).map_or(Value::Null, Val::json),
            )
        })
        .collect()
}

/// What `$allowed` and the write doors decide about one call (T-6645), from the decision the
/// proposal path runs, so the answer never drifts from the call: `not_found` for a key the caller
/// does not read, which reads like a missing one.
#[derive(Debug, PartialEq)]
struct Decision {
    allowed: bool,
    reason: Option<String>,
    not_found: bool,
}

impl Decision {
    fn yes() -> Self {
        Decision {
            allowed: true,
            reason: None,
            not_found: false,
        }
    }

    fn no(reason: impl Into<String>) -> Self {
        Decision {
            allowed: false,
            reason: Some(reason.into()),
            not_found: false,
        }
    }

    fn of(check: Result<(), ApiError>) -> Self {
        match check {
            Ok(()) => Decision::yes(),
            Err(ApiError::Denied(m) | ApiError::NotFound(m) | ApiError::BadRequest(m)) => {
                Decision::no(m)
            }
            Err(other) => Decision::no(other.to_string()),
        }
    }

    /// The refusal a write door answers when the decision is no.
    fn refusal(&self) -> Refusal {
        let reason = self.reason.clone().unwrap_or_default();
        if self.not_found {
            Refusal(StatusCode::NOT_FOUND, "NotFound", reason)
        } else {
            Refusal(StatusCode::FORBIDDEN, "Forbidden", reason)
        }
    }
}

/// Whether the caller may `op` the row keyed `key` of `rows` (or the set, without a key).
fn decide(
    state: &AppState,
    user: &CurrentUser,
    project: &str,
    rows: &[Row],
    op: &str,
    key: Option<&str>,
) -> Decision {
    let row = match key {
        None => None,
        Some(key) => match rows.iter().find(|row| row.str("id") == Some(key)) {
            Some(row) => Some(row),
            None => {
                return Decision {
                    allowed: false,
                    reason: Some(format!("no Endpoint '{key}' in project {project}")),
                    not_found: true,
                }
            }
        },
    };
    match op {
        "read" => Decision::yes(),
        "export" => Decision::no(
            "Endpoints serves no $export; read the rows with $top and $skip, or use Export on the Endpoints page",
        ),
        "create" => Decision::no(
            "an Endpoint is created with New endpoint on the Endpoints page, which checks the whole manifest",
        ),
        "update" | "delete" => {
            let Some(row) = row else {
                return Decision::no(format!("name the row: {op} takes a key"));
            };
            match (row.str("kind"), row.str("source")) {
                (Some(OWN), _) => {}
                (Some(SHARED), Some(source)) => {
                    return Decision::no(format!(
                        "project {source} publishes this Endpoint: it is changed there; Stop using in the row menu removes this project's reference"
                    ))
                }
                _ => {
                    return Decision::no(
                        "its Endpoint is gone and only this project's reference is left: Stop using in the row menu removes it",
                    )
                }
            }
            let name = row.str("name").unwrap_or_default();
            let Some(manifest) = state
                .mirror
                .get(project, KIND, name)
                .and_then(|env| serde_json::to_value(env).ok())
            else {
                return Decision::no(format!("Endpoint '{name}' is no longer in project {project}; reload the list"));
            };
            let identity = &user.0.identity;
            Decision::of(if op == "update" {
                crate::groups::for_proposal(state, identity, project, KIND, true, &manifest).check(
                    KIND,
                    jc_core::kinds::Verb::Propose,
                    Some(&manifest),
                )
            } else {
                crate::permissions::for_request(state, identity, project).check(
                    KIND,
                    jc_core::kinds::Verb::Delete,
                    Some(&manifest),
                )
            })
        }
        other => Decision::no(format!(
            "op is one of read, export, create, update and delete, not '{other}'"
        )),
    }
}

/// The query of `$allowed`.
#[derive(Debug, Deserialize, IntoParams)]
#[serde(deny_unknown_fields)]
pub struct AllowedQuery {
    /// read, export, create, update or delete, e.g. update
    pub op: String,
    /// The row's key, e.g. air-counters, or helsinki/bikes for a shared row
    pub key: Option<String>,
}

/// `GET /api/v1/projects/{project}/odata/Endpoints/$allowed` (T-6645).
#[utoipa::path(
    get,
    path = "/api/v1/projects/{project}/odata/Endpoints/$allowed",
    summary = "Ask Whether an Endpoints Call Is Allowed",
    description = "Whether the caller may read, export, create, update or delete the set or one row, and why not, from the same decision the call runs: update is the propose check of the Endpoint, delete its delete check; a shared or gone row is changed elsewhere and says where (T-6645).",
    tag = "resources",
    params(("project" = String, Path, description = "Project name, e.g. helsinki"), AllowedQuery),
    responses(
        (status = 200, description = "{allowed, reason, notFound}: notFound for a key the caller does not read", body = Object),
        (status = 400, description = "op missing or an unknown query parameter", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 404, description = "A project where the caller reads no Endpoint", body = ProblemDetails),
    )
)]
pub async fn allowed(
    user: CurrentUser,
    State(state): State<AppState>,
    Path(project): Path<String>,
    Query(query): Query<AllowedQuery>,
) -> Result<Response, ApiError> {
    let rows = rows(&state, &user, &project).await?;
    let decision = decide(
        &state,
        &user,
        &project,
        &rows,
        &query.op,
        query.key.as_deref(),
    );
    let body = json!({
        "allowed": decision.allowed,
        "reason": decision.reason,
        "notFound": decision.not_found,
    });
    Ok((odata_headers("application/json"), body.to_string()).into_response())
}

/// The row `segment` (`Endpoints('<key>')`) names among the caller's rows.
async fn keyed(
    state: &AppState,
    user: &CurrentUser,
    project: &str,
    segment: &str,
) -> Result<(Vec<Row>, String), Response> {
    let rows = rows(state, user, project)
        .await
        .map_err(IntoResponse::into_response)?;
    let key = key_of(segment).ok_or_else(|| {
        bad(format!(
            "{segment} is no entity of this service: write {ENTITY_SET}('<key>')"
        ))
        .into_response()
    })?;
    Ok((rows, key))
}

/// `GET /api/v1/projects/{project}/odata/{entity}` (T-6645).
#[utoipa::path(
    get,
    path = "/api/v1/projects/{project}/odata/{entity}",
    summary = "Read One Endpoint with OData",
    description = "One row of the entity set Endpoints by its key, the row the caller may read or 404 (T-6645).",
    tag = "resources",
    params(
        ("project" = String, Path, description = "Project name, e.g. helsinki"),
        ("entity" = String, Path, description = "Endpoints('<key>'), e.g. Endpoints('air-counters')"),
    ),
    responses(
        (status = 200, description = "The row with @odata.context", body = Object),
        (status = 400, description = "Not an Endpoints('<key>') segment, as an OData error"),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 404, description = "No such row the caller may read, as an OData error"),
    )
)]
pub async fn read_endpoint(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((project, entity)): Path<(String, String)>,
) -> Response {
    let (rows, key) = match keyed(&state, &user, &project, &entity).await {
        Ok(found) => found,
        Err(answer) => return answer,
    };
    let Some(row) = rows.iter().find(|row| row.str("id") == Some(key.as_str())) else {
        return Refusal(
            StatusCode::NOT_FOUND,
            "NotFound",
            format!("no Endpoint '{key}' in project {project}"),
        )
        .into_response();
    };
    let mut body = row_json(row, &PROPERTIES.map(|(n, _, _)| n));
    body.insert(
        "@odata.context".into(),
        Value::String(format!(
            "{}$metadata#{ENTITY_SET}/$entity",
            service_root(&state, &project)
        )),
    );
    (
        odata_headers("application/json;odata.metadata=minimal"),
        Value::Object(body).to_string(),
    )
        .into_response()
}

/// The merge patch of an OData `PATCH` body: only [`EDITABLE`] properties, each of its type.
fn spec_patch(body: &[u8]) -> Result<Value, Refusal> {
    let Ok(Value::Object(fields)) = serde_json::from_slice::<Value>(body) else {
        return Err(bad("the body is a JSON object of the properties to change, e.g. {\"audience\": \"public\"}"));
    };
    let mut spec = Map::new();
    for (name, value) in fields {
        if name.starts_with('@') {
            continue;
        }
        let Some((_, field)) = EDITABLE.iter().find(|(n, _)| *n == name) else {
            return Err(bad(format!(
                "{name} is not changed here: the row changes {}; edit the rest in the Endpoint's form",
                EDITABLE.map(|(n, _)| n).join(", ")
            )));
        };
        let fits = if name == "mcp" {
            value.is_boolean()
        } else {
            value.as_str().is_some_and(|s| !s.is_empty())
        };
        if !fits {
            let wanted = if name == "mcp" {
                "true or false"
            } else {
                "a non-empty text"
            };
            return Err(bad(format!("{name} takes {wanted}")));
        }
        spec.insert((*field).to_owned(), value);
    }
    if spec.is_empty() {
        return Err(bad(
            "the body changes nothing: name at least one property, e.g. {\"mcp\": false}",
        ));
    }
    Ok(json!({ "spec": spec }))
}

/// `PATCH /api/v1/projects/{project}/odata/{entity}` (T-6645).
#[utoipa::path(
    patch,
    path = "/api/v1/projects/{project}/odata/{entity}",
    summary = "Change One Endpoint with OData",
    description = "Proposes a change of contextSpace, audience or mcp of one of the project's own Endpoints: the same checked proposal the Endpoints page sends (a dry run that records the verdict, then the proposal), so the change waits for approval like any other. A shared or gone row is refused 403 with where it is changed (T-6645).",
    tag = "resources",
    params(
        ("project" = String, Path, description = "Project name, e.g. helsinki"),
        ("entity" = String, Path, description = "Endpoints('<key>'), e.g. Endpoints('air-counters')"),
        ("If-Match" = Option<String>, Header, description = "The ETag of the manifest as read; a stale one is 412"),
    ),
    request_body(content = Object, description = "The properties to change, e.g. {\"audience\": \"public\", \"mcp\": false}"),
    responses(
        (status = 202, description = "The Change that proposes it", body = Object),
        (status = 400, description = "A property the row does not change or a value of the wrong type, as an OData error"),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "The caller may not propose it, or the row is not this project's, as an OData error with the reason"),
        (status = 404, description = "No such row the caller may read, as an OData error"),
        (status = 422, description = "The checked manifest is refused: each finding named", body = ProblemDetails),
    )
)]
pub async fn change_endpoint(
    user: CurrentUser,
    front: Front,
    State(state): State<AppState>,
    Path((project, entity)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let (rows, key) = match keyed(&state, &user, &project, &entity).await {
        Ok(found) => found,
        Err(answer) => return Ok(answer),
    };
    let decision = decide(&state, &user, &project, &rows, "update", Some(&key));
    if !decision.allowed {
        return Ok(decision.refusal().into_response());
    }
    let patch = match spec_patch(&body) {
        Ok(patch) => patch,
        Err(refusal) => return Ok(refusal.into_response()),
    };
    let mut forwarded = HeaderMap::new();
    forwarded.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/merge-patch+json"),
    );
    if let Some(tag) = headers.get(header::IF_MATCH) {
        forwarded.insert(header::IF_MATCH, tag.clone());
    }
    let bytes = Bytes::from(patch.to_string());
    let door = |dry_run: Option<String>| {
        crate::api::mutate::patch(
            user.clone(),
            front,
            State(state.clone()),
            Path((project.clone(), "endpoints".to_owned(), key.clone())),
            Query(DryRunQuery {
                dry_run,
                ..DryRunQuery::default()
            }),
            forwarded.clone(),
            bytes.clone(),
        )
    };
    // The check first, as the page's form runs it: it records the verdict the proposal needs
    // (PF-57), and a red one is answered with its findings and proposes nothing.
    let checked = door(Some("All".to_owned())).await?;
    let verdict: Value = serde_json::from_slice(
        &axum::body::to_bytes(checked.into_body(), 1 << 20)
            .await
            .map_err(|e| ApiError::Internal(format!("the check's answer was not read: {e}")))?,
    )
    .map_err(|e| ApiError::Internal(format!("the check's answer is not JSON: {e}")))?;
    if verdict.get("valid") != Some(&Value::Bool(true)) {
        let errors: Vec<String> = verdict
            .pointer("/verdict/findings")
            .and_then(Value::as_array)
            .map(|findings| {
                findings
                    .iter()
                    .filter_map(|f| {
                        Some(format!(
                            "{}: {}",
                            f.get("path")?.as_str()?,
                            f.get("message")?.as_str()?
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default();
        return Err(ApiError::Unprocessable {
            detail: format!("the change of Endpoint '{key}' is refused by its check"),
            errors,
        });
    }
    door(None).await
}

/// `DELETE /api/v1/projects/{project}/odata/{entity}` (T-6645).
#[utoipa::path(
    delete,
    path = "/api/v1/projects/{project}/odata/{entity}",
    summary = "Remove One Endpoint with OData",
    description = "Proposes removing one of the project's own Endpoints through the same door as DELETE /projects/{project}/endpoints/{name}: refused 409 while other resources reference it; a shared or gone row is refused 403 with where it is removed (T-6645).",
    tag = "resources",
    params(
        ("project" = String, Path, description = "Project name, e.g. helsinki"),
        ("entity" = String, Path, description = "Endpoints('<key>'), e.g. Endpoints('air-counters')"),
        ("If-Match" = Option<String>, Header, description = "The ETag of the manifest as read; a stale one is 412"),
    ),
    responses(
        (status = 202, description = "The Change that proposes it", body = Object),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "The caller may not delete it, or the row is not this project's, as an OData error with the reason"),
        (status = 404, description = "No such row the caller may read, as an OData error"),
        (status = 409, description = "Other resources reference it", body = ProblemDetails),
    )
)]
pub async fn remove_endpoint(
    user: CurrentUser,
    front: Front,
    State(state): State<AppState>,
    Path((project, entity)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let (rows, key) = match keyed(&state, &user, &project, &entity).await {
        Ok(found) => found,
        Err(answer) => return Ok(answer),
    };
    let decision = decide(&state, &user, &project, &rows, "delete", Some(&key));
    if !decision.allowed {
        return Ok(decision.refusal().into_response());
    }
    crate::api::delete::delete_resource(
        user,
        front,
        State(state),
        Path((project, "endpoints".to_owned(), key)),
        Query(DryRunQuery::default()),
        headers,
    )
    .await
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
    gate(&state, &user, &project)?;
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
    gate(&state, &user, &project)?;
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
        .route("/projects/{project}/odata/Endpoints/$allowed", get(allowed))
        .route(
            "/projects/{project}/odata/{entity}",
            get(read_endpoint)
                .patch(change_endpoint)
                .delete(remove_endpoint),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT: &str = "https://portal.example.org/api/v1/projects/p/odata/";

    fn row(id: &str, title: Option<&str>, space: &str, mcp: bool) -> Row {
        Row([
            Val::Str(id.into()),
            Val::Str(id.into()),
            title.map_or(Val::Null, |t| Val::Str(t.into())),
            Val::Null,
            Val::Str(space.into()),
            Val::Str(format!("slug{id}")),
            Val::Str("public".into()),
            Val::Bool(mcp),
            Val::Str("p".into()),
            Val::Str(OWN.into()),
            Val::Null,
            Val::Str("Ready".into()),
            Val::Null,
            Val::Int(i64::try_from(id.len()).unwrap_or(0)),
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
            assert!(
                r.2.contains("an Endpoint has id, name, title"),
                "{query}: {r:?}"
            );
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
        json!({ "id": id, "name": id, "title": "Bike counters", "description": null,
                "contextSpace": "air", "slug": format!("slug{id}"), "audience": "public",
                "mcp": true, "source": "p", "kind": "own", "reference": null, "phase": "Ready",
                "representations": null, "calls7d": id.len() })
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
            json!([{ "id": "e1000", "name": "e1000", "title": null, "description": null,
            "contextSpace": "air", "slug": "sluge1000", "audience": "public", "mcp": true,
            "source": "p", "kind": "own", "reference": null, "phase": "Ready",
            "representations": null, "calls7d": 5 }])
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
        // The SDK grid reads this to search case-blind (T-6645).
        assert!(
            xml.contains(r#"Term="Capabilities.FilterFunctions""#),
            "{xml}"
        );
        assert!(xml.contains("<String>tolower</String>"), "{xml}");
        assert!(
            xml.contains(r#"Namespace="Org.OData.Capabilities.V1""#),
            "{xml}"
        );
        for (name, _, _) in PROPERTIES {
            assert!(
                xml.contains(&format!(r#"Name="{name}""#)),
                "{name} missing: {xml}"
            );
        }
    }

    #[test]
    fn a_key_segment_reads_its_literal_and_refuses_anything_else() {
        assert_eq!(key_of("Endpoints('air')").as_deref(), Some("air"));
        assert_eq!(
            key_of("Endpoints('espoo/air')").as_deref(),
            Some("espoo/air")
        );
        assert_eq!(key_of("Endpoints('o''brien')").as_deref(), Some("o'brien"));
        for refused in [
            "Endpoints",
            "Endpoints(air)",
            "Things('a')",
            "Endpoints('a'b')",
            "Endpoints('a')/x",
        ] {
            assert_eq!(key_of(refused), None, "{refused}");
        }
    }

    #[test]
    fn a_patch_changes_only_the_editable_properties_each_of_its_type() {
        assert_eq!(
            spec_patch(br#"{"audience":"public","mcp":false,"@odata.etag":"x"}"#),
            Ok(json!({ "spec": { "audience": "public", "mcp": false } }))
        );
        assert_eq!(
            spec_patch(br#"{"contextSpace":"air"}"#),
            Ok(json!({ "spec": { "contextSpaceRef": "air" } }))
        );
        for (body, says) in [
            (&br#"{"title":"x"}"#[..], "title is not changed here"),
            (br#"{"mcp":"no"}"#, "mcp takes true or false"),
            (br#"{"audience":""}"#, "audience takes a non-empty text"),
            (br#"{}"#, "changes nothing"),
            (br#"[1]"#, "a JSON object"),
        ] {
            let Err(Refusal(status, _, message)) = spec_patch(body) else {
                panic!("{body:?} was taken");
            };
            assert_eq!(status, StatusCode::BAD_REQUEST);
            assert!(message.contains(says), "{message}");
        }
    }

    fn manifest(name: &str, spec: Value) -> ResourceEnvelope {
        serde_json::from_value(json!({
            "apiVersion": "joinedcontext.com/v1alpha1",
            "kind": "Endpoint",
            "metadata": { "name": name, "namespace": "espoo" },
            "spec": spec,
        }))
        .unwrap_or_else(|e| panic!("{e}"))
    }

    #[test]
    fn a_project_reads_what_another_shares_with_it_by_the_gateways_rule() {
        let open = manifest("open", json!({ "audience": "public" }));
        let org = manifest("org", json!({ "audience": "organization" }));
        let listed = manifest(
            "listed",
            json!({ "audience": "project-list", "allowedProjects": ["p"] }),
        );
        let unlisted = manifest("unlisted", json!({ "allowedProjects": ["q"] }));
        let own = manifest("own", json!({ "audience": "project" }));
        assert!(admits(&open, "espoo", "p"));
        assert!(admits(&org, "espoo", "p"));
        assert!(admits(&listed, "espoo", "p"));
        assert!(!admits(&unlisted, "espoo", "p"));
        assert!(!admits(&own, "espoo", "p"));
        assert!(admits(&own, "p", "p"));
    }

    #[test]
    fn a_reference_finds_its_endpoint_by_ref_or_else_by_slug() {
        let endpoint = manifest("air", json!({ "slug": "s1" }));
        let by_ref = manifest(
            "r1",
            json!({ "endpointRef": { "project": "espoo", "name": "air" } }),
        );
        let other_project = manifest(
            "r2",
            json!({ "endpointRef": { "project": "vantaa", "name": "air" } }),
        );
        let by_slug = manifest("r3", json!({ "endpointSlug": "s1" }));
        let refs = [other_project.clone(), by_ref];
        assert_eq!(
            reference_to(&refs, &endpoint, "espoo").map(|r| r.metadata.name.as_str()),
            Some("r1")
        );
        assert_eq!(
            reference_to(&[other_project, by_slug], &endpoint, "espoo")
                .map(|r| r.metadata.name.as_str()),
            Some("r3")
        );
        let unslugged = manifest("air", json!({}));
        assert!(reference_to(
            &[manifest("r4", json!({ "endpointSlug": "" }))],
            &unslugged,
            "espoo"
        )
        .is_none());
    }

    #[test]
    fn a_shared_and_a_gone_row_say_where_they_are_changed() {
        let shared = Row::endpoint(
            &manifest("air", json!({ "slug": "s1" })),
            "espoo",
            SHARED,
            Some("r1"),
            None,
        );
        assert_eq!(shared.str("id"), Some("espoo/air"));
        assert_eq!(shared.str("reference"), Some("r1"));
        assert_eq!(shared.get("calls7d"), Some(&Val::Null));
        let gone = Row::gone(&manifest(
            "r9",
            json!({ "alias": "Old air", "endpointSlug": "s9" }),
        ));
        assert_eq!(gone.str("id"), Some("reference:r9"));
        assert_eq!(gone.str("title"), Some("Old air"));
        assert_eq!(gone.str("kind"), Some(GONE));
    }
}
