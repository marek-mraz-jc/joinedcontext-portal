//! OData 4.0 over the Portal's own lists (T-6632, pilot on one list): the project's Endpoints as
//! the entity set `Endpoints`, read with `$filter`, `$select`, `$orderby`, `$top`, `$skip` and
//! `$count`, so an OData client (Excel, Power BI, Microsoft.OData.Client) reads what the
//! Endpoints page lists.
//!
//! The URL is parsed by the default broker's `odata-url` crate against the CSDL model below
//! (`odata-csdl`), the same library Antares serves its OData surface with: a name the model does
//! not hold is refused by the parser, so only the allow-listed properties of `PROPERTIES` reach
//! a predicate. The rows are the store's manifests, served by `odata-table` (T-6663), the one
//! query engine of the default broker's OData sets: its `MemoryTable` evaluates `$filter`,
//! `$orderby` and the page, and the caller's read checks are its `Scope`, applied before any
//! option, so an Endpoint the caller may not read is never filtered, counted or paged (API/13
//! section 2). A write goes through odata-table's `write` too, whose batch the REST proposal and
//! delete doors apply, so it is still a Change waiting for approval.

use std::sync::{Arc, LazyLock};

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
use odata_table::{
    Applying, Batch, Change, Fetching, MemoryTable, Operation, Plan, Rule, Scope, Table,
    TableError, TableInfo,
};
use odata_url::{
    EdmModel, Expr, Format, Literal, Method, ODataUri, QueryOptions, Segment, UrlErrorKind,
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
static MODEL: LazyLock<Arc<Model>> = LazyLock::new(|| {
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
    Arc::new(Model {
        version: CsdlVersion::V4_0,
        references: vec![Reference {
            uri: "https://oasis-tcs.github.io/odata-vocabularies/vocabularies/Org.OData.Capabilities.V1.xml".into(),
            includes: vec![Include {
                namespace: "Org.OData.Capabilities.V1".into(),
                alias: Some("Capabilities".into()),
            }],
        }],
        schemas: vec![schema],
    })
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

/// A row's kind, the `kind` property.
const OWN: &str = "own";
const SHARED: &str = "shared";
const GONE: &str = "gone";

fn text(t: Option<&jc_core::Text>) -> Value {
    t.map_or(Value::Null, |t| {
        Value::String(t.resolve(&[], "en").to_owned())
    })
}

fn spec_str(env: &ResourceEnvelope, key: &str) -> Value {
    env.spec
        .get(key)
        .and_then(Value::as_str)
        .map_or(Value::Null, |s| Value::String(s.to_owned()))
}

fn opt(value: Option<&str>) -> Value {
    value.map_or(Value::Null, |s| Value::String(s.to_owned()))
}

/// One row as the entity set holds it: every property of [`PROPERTIES`], `null` where unset.
fn row_of(values: [Value; PROPERTIES.len()]) -> Value {
    Value::Object(
        PROPERTIES
            .iter()
            .zip(values)
            .map(|((name, _, _), value)| ((*name).to_owned(), value))
            .collect(),
    )
}

/// An Endpoint row: `source` the project publishing it, `kind` own or shared, `reference`
/// this project's reference to it, `calls` its calls in the last 7 days where counted.
fn endpoint_row(
    env: &ResourceEnvelope,
    source: &str,
    kind: &'static str,
    reference: Option<&str>,
    calls: Option<u64>,
) -> Value {
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
        .and_then(|status| serde_json::to_value(status.phase).ok())
        .and_then(|phase| phase.as_str().map(str::to_owned));
    row_of([
        Value::String(id),
        Value::String(name),
        text(env.metadata.title.as_ref()),
        text(env.metadata.description.as_ref()),
        crate::permissions::spec_space(&env.spec).map_or(Value::Null, Value::String),
        spec_str(env, "slug"),
        spec_str(env, "audience"),
        // Every Endpoint serves MCP unless it says `mcp: false` (EP-24).
        Value::Bool(env.spec.get("mcp").and_then(Value::as_bool) != Some(false)),
        Value::String(source.to_owned()),
        Value::String(kind.to_owned()),
        opt(reference),
        opt(phase.as_deref()),
        opt(representations.as_deref()),
        calls.map_or(Value::Null, |n| json!(n)),
    ])
}

/// A reference of this project whose Endpoint no longer shows (EP-15): a row still, because a
/// grant nobody lists is a grant nobody can remove (T-0706).
fn gone_row(reference: &ResourceEnvelope) -> Value {
    let name = reference.metadata.name.clone();
    row_of([
        Value::String(format!("reference:{name}")),
        Value::String(name.clone()),
        opt(reference.spec.get("alias").and_then(Value::as_str)),
        Value::Null,
        Value::Null,
        spec_str(reference, "endpointSlug"),
        Value::Null,
        Value::Bool(false),
        Value::Null,
        Value::String(GONE.to_owned()),
        Value::String(name),
        Value::Null,
        Value::Null,
        Value::Null,
    ])
}

/// The text at `name` of `row`.
fn field<'r>(row: &'r Value, name: &str) -> Option<&'r str> {
    row.get(name).and_then(Value::as_str)
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

/// The refusal of a query or write odata-table did not answer.
fn refusal_of(e: TableError) -> Refusal {
    match e {
        TableError::NotImplemented(what) => not_implemented(&what),
        TableError::UnknownProperty(path) => bad(format!(
            "an Endpoint has no property {path}: it has {}",
            PROPERTIES.map(|(n, _, _)| n).join(", ")
        )),
        TableError::BadRequest(why) => bad(why),
        TableError::Forbidden(why) => Refusal(StatusCode::FORBIDDEN, "Forbidden", why),
        TableError::Conflict(why) => Refusal(StatusCode::CONFLICT, "Conflict", why),
        TableError::Source(why) => {
            tracing::error!(error = %why, "the OData Endpoints rows did not answer");
            Refusal(
                StatusCode::INTERNAL_SERVER_ERROR,
                "InternalServerError",
                "the Endpoints rows did not answer; try again".into(),
            )
        }
    }
}

/// The EDM type of property `name`.
fn edm_type(name: &str) -> Option<&'static str> {
    PROPERTIES
        .iter()
        .find(|(n, _, _)| *n == name)
        .map(|(_, ty, _)| *ty)
}

/// The type a `$filter` part has before any row is read: a property's EDM type (a string for
/// `tolower`/`toupper` of one), a literal's or a parameter alias's own; `None` when unknown.
fn static_type(e: &Expr, aliases: &[(String, Literal)]) -> Option<&'static str> {
    let of_literal = |l: &Literal| match l {
        Literal::Bool(_) => Some("Edm.Boolean"),
        Literal::Int(_) => Some("Edm.Int64"),
        Literal::String(_) => Some("Edm.String"),
        _ => None,
    };
    match e {
        Expr::Member(path) => match (&path.variable, path.path.as_slice()) {
            (None, [name]) => edm_type(name),
            _ => None,
        },
        Expr::Call(Method::ToLower | Method::ToUpper, _) => Some("Edm.String"),
        Expr::Literal(l) => of_literal(l),
        Expr::Alias(name) => aliases
            .iter()
            .find(|(n, _)| n == name)
            .and_then(|(_, l)| of_literal(l)),
        _ => None,
    }
}

/// Refuses a `$filter` that compares values of two types, applies a text function to a
/// non-text or is not true or false for a row (`$filter=title`), with a 400 that says so: the
/// types are known from the model, so this reads no row. The rows are matched by odata-table.
fn typed(e: &Expr, aliases: &[(String, Literal)]) -> Result<(), Refusal> {
    let same = |a: &Expr, b: &Expr| match (static_type(a, aliases), static_type(b, aliases)) {
        (Some(x), Some(y)) if x != y => Err(bad(format!(
            "$filter compares {} with {}",
            words(x),
            words(y)
        ))),
        _ => Ok(()),
    };
    match e {
        Expr::And(a, b) | Expr::Or(a, b) => typed(a, aliases).and(typed(b, aliases)),
        Expr::Not(a) => typed(a, aliases),
        Expr::Compare(a, _, b) => same(a, b),
        Expr::In(a, list) => list
            .iter()
            .try_for_each(|l| same(a, &Expr::Literal(l.clone()))),
        Expr::Call(Method::Contains | Method::StartsWith | Method::EndsWith, args) => args
            .iter()
            .try_for_each(|arg| match static_type(arg, aliases) {
                Some("Edm.String") | None => Ok(()),
                Some(other) => Err(bad(format!(
                    "a text method reads two texts, not {}",
                    words(other)
                ))),
            }),
        Expr::Member(_) => match static_type(e, aliases) {
            Some("Edm.Boolean") | None => Ok(()),
            Some(other) => Err(bad(format!(
                "$filter must be true or false for a row, and this part is {}",
                words(other)
            ))),
        },
        _ => Ok(()),
    }
}

fn words(edm: &str) -> &'static str {
    match edm {
        "Edm.Boolean" => "a true/false value",
        "Edm.Int64" => "a number",
        _ => "a text",
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

/// The answer to `Endpoints?{query}` over `table` within `scope`; `root` is the service root
/// URL, ending in `/`. odata-table plans and runs the query (T-6663): the scope first, then
/// `$filter`, `$orderby` with `id` breaking ties, the page and the count.
async fn answer(
    table: &Endpoints<'_>,
    scope: &Scope,
    query: &str,
    root: &str,
) -> Result<Value, Refusal> {
    let options = parse_query(query)?;
    if let Some(filter) = &options.filter {
        typed(filter, &options.aliases)?;
    }
    let page = odata_table::query(table, &options, scope, MAX_TOP)
        .await
        .map_err(refusal_of)?;
    let mut body = Map::new();
    let context = match &page.select {
        Some(names) => {
            let names: Vec<&str> = PROPERTIES
                .iter()
                .map(|(n, _, _)| *n)
                .filter(|n| names.iter().any(|s| s == n))
                .collect();
            format!("{root}$metadata#{ENTITY_SET}({})", names.join(","))
        }
        None => format!("{root}$metadata#{ENTITY_SET}"),
    };
    body.insert("@odata.context".into(), Value::String(context));
    if let Some(count) = page.count {
        body.insert("@odata.count".into(), json!(count));
    }
    body.insert("value".into(), Value::Array(page.rows));
    // Server-driven paging only when the client set no $top: the next page is the same query
    // with $skip moved on by one page.
    if page.next.is_some() {
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

/// The manifests of `kind` in `project`, each with whether the caller may read it: the kind
/// check first (no manifest at all without it), then each manifest's own, which a grant bound to
/// one context space passes for that space's Endpoints alone.
fn listed(
    state: &AppState,
    effective: &crate::permissions::Effective,
    project: &str,
    kind: &str,
) -> Vec<(ResourceEnvelope, bool)> {
    if !effective.may_read_some(kind) {
        return Vec::new();
    }
    state
        .mirror
        .list(project, kind, &ListOptions::default())
        .items
        .into_iter()
        .map(|env| {
            let readable = effective.may_read_envelope(kind, &env);
            (env, readable)
        })
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

/// The rows of one request (T-6663): each row of the project's set and the keys of those the
/// caller may read, which [`Rows::scope`] hands odata-table as the [`Scope`] it applies before
/// any OData option, so a row the caller may not read is never filtered, counted or paged.
#[derive(Default)]
struct Rows {
    all: Vec<Value>,
    readable: Vec<Value>,
}

impl Rows {
    fn push(&mut self, row: Value, readable: bool) {
        if readable {
            self.readable
                .push(row.get("id").cloned().unwrap_or(Value::Null));
        }
        self.all.push(row);
    }

    /// The rows the caller reads: each passed the read check of the project it lives in.
    fn scope(&self) -> Scope {
        Scope::all().and(&["id"], self.readable.clone())
    }
}

/// The rows of `project`, in the page's order: own Endpoints, then those other projects share
/// with it, then references whose Endpoint went away (T-6169), each marked with the read check of
/// the project it lives in.
async fn rows(state: &AppState, user: &CurrentUser, project: &str) -> Result<Rows, ApiError> {
    let effective = gate(state, user, project)?;
    let identity = &user.0.identity;
    let calls = calls_7d(state, project).await;
    let references = listed(state, &effective, project, "SharedSpaceReference");
    // A reference the caller may not read names no row, so its name never shows.
    let read_references: Vec<ResourceEnvelope> = references
        .iter()
        .filter(|(_, readable)| *readable)
        .map(|(env, _)| env.clone())
        .collect();
    let mut rows = Rows::default();
    for (env, readable) in listed(state, &effective, project, KIND) {
        let counted = calls
            .as_ref()
            .map(|calls| calls.get(&env.metadata.name).copied().unwrap_or(0));
        rows.push(endpoint_row(&env, project, OWN, None, counted), readable);
    }
    let mut used = std::collections::HashSet::new();
    for source in state.mirror.namespaces() {
        if source == project || !crate::api::projects::readable(state, identity, &source) {
            continue;
        }
        let theirs = crate::permissions::for_request(state, identity, &source);
        for (env, readable) in listed(state, &theirs, &source, KIND) {
            if !admits(&env, &source, project) {
                continue;
            }
            let reference = readable
                .then(|| reference_to(&read_references, &env, &source))
                .flatten();
            if let Some(reference) = reference {
                used.insert(reference.metadata.name.clone());
            }
            let name = reference.map(|r| r.metadata.name.as_str());
            rows.push(endpoint_row(&env, &source, SHARED, name, None), readable);
        }
    }
    for (reference, readable) in &references {
        if !used.contains(&reference.metadata.name) {
            rows.push(gone_row(reference), *readable);
        }
    }
    Ok(rows)
}

/// The set's [`TableInfo`]: the model's set, read, update and delete offered; who may change
/// a row is the request's [`Scope`] (`changes`, from the proposal and delete checks).
static INFO: LazyLock<Option<TableInfo>> = LazyLock::new(|| {
    let mut info = TableInfo::new(MODEL.clone(), ENTITY_SET)?;
    info.rules = [Operation::Read, Operation::Update, Operation::Delete]
        .into_iter()
        .map(|operation| Rule {
            operation,
            permission: None,
        })
        .collect();
    Some(info)
});

/// The entity set Endpoints of one request (T-6663): the rows in odata-table's
/// [`MemoryTable`], the reference evaluator every OData read runs through, and for a write the
/// [`Door`] that turns odata-table's [`Batch`] into the REST proposal or delete, so every write
/// is still a Change waiting for approval.
struct Endpoints<'r> {
    rows: MemoryTable,
    door: Option<Door<'r>>,
}

impl<'r> Endpoints<'r> {
    fn new(rows: Vec<Value>, door: Option<Door<'r>>) -> Result<Self, ApiError> {
        let info = INFO
            .clone()
            .ok_or_else(|| ApiError::Internal("the OData model holds no Endpoints set".into()))?;
        let rows = MemoryTable::new(info, rows)
            .map_err(|e| ApiError::Internal(format!("the OData Endpoints rows: {e}")))?;
        Ok(Endpoints { rows, door })
    }

    /// The row keyed `key` within `scope`; `None` when there is none the scope reads.
    async fn find(&self, scope: &Scope, key: &str) -> Result<Option<Value>, Refusal> {
        let options = odata_table::key_options(self.info(), &Value::String(key.to_owned()), None)
            .map_err(refusal_of)?;
        let found = odata_table::query(self, &options, scope, 1)
            .await
            .map_err(refusal_of)?;
        Ok(found.rows.into_iter().next())
    }
}

impl Table for Endpoints<'_> {
    fn info(&self) -> &TableInfo {
        self.rows.info()
    }

    fn fetch<'a>(&'a self, plan: &'a Plan, scope: &'a Scope) -> Fetching<'a> {
        self.rows.fetch(plan, scope)
    }

    fn writable(&self) -> bool {
        self.door.is_some()
    }

    fn apply<'a>(&'a self, batch: &'a Batch) -> Applying<'a> {
        Box::pin(async move {
            let Some(door) = &self.door else {
                return Err(TableError::Forbidden(format!(
                    "{ENTITY_SET} is only read here"
                )));
            };
            let [Value::String(name)] = batch.keys.as_slice() else {
                return Err(TableError::BadRequest(format!(
                    "one Endpoint at a time: name it by its key, e.g. {ENTITY_SET}('air-counters')"
                )));
            };
            let answer = match &batch.change {
                Change::Update(patch) => door.propose(name, patch).await,
                Change::Delete => door.remove(name).await,
            };
            let done = matches!(&answer, Ok(response) if response.status().is_success());
            *door
                .answer
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(answer);
            if done {
                Ok(())
            } else {
                Err(TableError::Conflict(format!(
                    "the Endpoint '{name}' was not changed"
                )))
            }
        })
    }
}

/// The REST doors a write of one row goes through: the checked proposal (`PATCH`) and the
/// delete, as the Endpoints page calls them. `answer` keeps the door's own answer (the Change,
/// or its refusal) for the OData call to return.
struct Door<'r> {
    user: &'r CurrentUser,
    front: Front,
    state: &'r AppState,
    project: &'r str,
    headers: &'r HeaderMap,
    answer: std::sync::Mutex<Option<Result<Response, ApiError>>>,
}

impl Door<'_> {
    /// Proposes `patch` (OData properties of [`EDITABLE`]) on Endpoint `name`: the check first,
    /// as the page's form runs it, so it records the verdict the proposal needs (PF-57) and a red
    /// one is answered with its findings and proposes nothing.
    async fn propose(&self, name: &str, patch: &Map<String, Value>) -> Result<Response, ApiError> {
        let mut forwarded = HeaderMap::new();
        forwarded.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/merge-patch+json"),
        );
        if let Some(tag) = self.headers.get(header::IF_MATCH) {
            forwarded.insert(header::IF_MATCH, tag.clone());
        }
        let bytes = Bytes::from(spec_of(patch).to_string());
        let door = |dry_run: Option<String>| {
            crate::api::mutate::patch(
                self.user.clone(),
                self.front,
                State(self.state.clone()),
                Path((
                    self.project.to_owned(),
                    "endpoints".to_owned(),
                    name.to_owned(),
                )),
                Query(DryRunQuery {
                    dry_run,
                    ..DryRunQuery::default()
                }),
                forwarded.clone(),
                bytes.clone(),
            )
        };
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
                detail: format!("the change of Endpoint '{name}' is refused by its check"),
                errors,
            });
        }
        door(None).await
    }

    /// Proposes removing Endpoint `name` through `DELETE /projects/{project}/endpoints/{name}`.
    async fn remove(&self, name: &str) -> Result<Response, ApiError> {
        crate::api::delete::delete_resource(
            self.user.clone(),
            self.front,
            State(self.state.clone()),
            Path((
                self.project.to_owned(),
                "endpoints".to_owned(),
                name.to_owned(),
            )),
            Query(DryRunQuery::default()),
            self.headers.clone(),
        )
        .await
    }
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
    let scope = rows.scope();
    let table = Endpoints::new(rows.all, None)?;
    let root = service_root(&state, &project);
    Ok(
        match answer(&table, &scope, query.as_deref().unwrap_or(""), &root).await {
            Ok(body) => (
                odata_headers("application/json;odata.metadata=minimal"),
                body.to_string(),
            )
                .into_response(),
            Err(refusal) => refusal.into_response(),
        },
    )
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
    /// A refused write: 403 as the problem every write door answers (its CSRF guard too, PF-50),
    /// the reason in its detail; a row the caller cannot read stays the OData 404.
    fn write_refusal(&self) -> Result<Response, ApiError> {
        if self.not_found {
            return Ok(self.refusal().into_response());
        }
        Err(ApiError::Denied(self.reason.clone().unwrap_or_default()))
    }

    fn refusal(&self) -> Refusal {
        let reason = self.reason.clone().unwrap_or_default();
        if self.not_found {
            Refusal(StatusCode::NOT_FOUND, "NotFound", reason)
        } else {
            Refusal(StatusCode::FORBIDDEN, "Forbidden", reason)
        }
    }
}

/// Whether the caller may `op` the row keyed `key` (or the set, without a key); `row` is the
/// row of that key the caller reads, `None` when it reads none.
fn decide(
    state: &AppState,
    user: &CurrentUser,
    project: &str,
    row: Option<&Value>,
    op: &str,
    key: Option<&str>,
) -> Decision {
    let row = match key {
        None => None,
        Some(key) => match row {
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
            match (field(row, "kind"), field(row, "source")) {
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
            let name = field(row, "name").unwrap_or_default();
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
    let scope = rows.scope();
    let table = Endpoints::new(rows.all, None)?;
    let row = match &query.key {
        Some(key) => match table.find(&scope, key).await {
            Ok(row) => row,
            Err(refusal) => return Ok(refusal.into_response()),
        },
        None => None,
    };
    let decision = decide(
        &state,
        &user,
        &project,
        row.as_ref(),
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
) -> Result<(Rows, String), Box<Response>> {
    let rows = rows(state, user, project)
        .await
        .map_err(|refused| Box::new(refused.into_response()))?;
    let key = key_of(segment).ok_or_else(|| {
        Box::new(
            bad(format!(
                "{segment} is no entity of this service: write {ENTITY_SET}('<key>')"
            ))
            .into_response(),
        )
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
        Err(answer) => return *answer,
    };
    let scope = rows.scope();
    let found = match Endpoints::new(rows.all, None) {
        Ok(table) => table.find(&scope, &key).await,
        Err(failed) => return failed.into_response(),
    };
    let mut body = match found {
        Ok(Some(Value::Object(row))) => row,
        Ok(_) => {
            return Refusal(
                StatusCode::NOT_FOUND,
                "NotFound",
                format!("no Endpoint '{key}' in project {project}"),
            )
            .into_response()
        }
        Err(refusal) => return refusal.into_response(),
    };
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

/// The properties an OData `PATCH` body changes: only [`EDITABLE`] ones, each of its type.
fn patch_of(body: &[u8]) -> Result<Map<String, Value>, Refusal> {
    let Ok(Value::Object(fields)) = serde_json::from_slice::<Value>(body) else {
        return Err(bad("the body is a JSON object of the properties to change, e.g. {\"audience\": \"public\"}"));
    };
    let mut patch = Map::new();
    for (name, value) in fields {
        if name.starts_with('@') {
            continue;
        }
        if !EDITABLE.iter().any(|(n, _)| *n == name) {
            return Err(bad(format!(
                "{name} is not changed here: the row changes {}; edit the rest in the Endpoint's form",
                EDITABLE.map(|(n, _)| n).join(", ")
            )));
        }
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
        patch.insert(name, value);
    }
    if patch.is_empty() {
        return Err(bad(
            "the body changes nothing: name at least one property, e.g. {\"mcp\": false}",
        ));
    }
    Ok(patch)
}

/// The manifest merge patch of `patch`: each property under the manifest field it writes.
fn spec_of(patch: &Map<String, Value>) -> Value {
    let spec: Map<String, Value> = patch
        .iter()
        .filter_map(|(name, value)| {
            let (_, field) = EDITABLE.iter().find(|(n, _)| n == name)?;
            Some(((*field).to_owned(), value.clone()))
        })
        .collect();
    json!({ "spec": spec })
}

/// A write of the row `entity` names, through odata-table (T-6663): the row read within the
/// caller's scope (404 when it reads none), the decision `$allowed` answers (a refusal says
/// why), then [`odata_table::write`] with the scope's `changes` holding the row that decision
/// admitted, which hands its [`Batch`] to the [`Door`]; the answer is the door's own.
async fn write_one(
    door: Door<'_>,
    entity: &str,
    op: &str,
    change: impl FnOnce() -> Result<Change, Refusal>,
) -> Result<Response, ApiError> {
    let (state, user, project) = (door.state, door.user, door.project);
    let (rows, key) = match keyed(state, user, project, entity).await {
        Ok(found) => found,
        Err(answer) => return Ok(*answer),
    };
    let scope = rows.scope();
    let table = Endpoints::new(rows.all, Some(door))?;
    let row = match table.find(&scope, &key).await {
        Ok(row) => row,
        Err(refusal) => return Ok(refusal.into_response()),
    };
    let decision = decide(state, user, project, row.as_ref(), op, Some(&key));
    if !decision.allowed {
        return decision.write_refusal();
    }
    let change = match change() {
        Ok(change) => change,
        Err(refusal) => return Ok(refusal.into_response()),
    };
    let key = Value::String(key);
    let scope = scope.changing(&["id"], vec![key.clone()]);
    let only = QueryOptions {
        filter: odata_table::key_options(table.info(), &key, None)
            .map_err(|e| ApiError::Internal(e.to_string()))?
            .filter,
        ..QueryOptions::default()
    };
    let written = odata_table::write(&table, &only, &scope, change, false, 1).await;
    let answered = table.door.as_ref().and_then(|door| {
        door.answer
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
    });
    match (answered, written) {
        (Some(answer), _) => answer,
        (None, Err(refused)) => Ok(refusal_of(refused).into_response()),
        (None, Ok(_)) => Err(ApiError::Internal(format!(
            "the write of Endpoint {key} reached no door"
        ))),
    }
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
    request_body(content = Object, content_type = "application/json", description = "The properties to change, e.g. {\"audience\": \"public\", \"mcp\": false}", example = json!({ "audience": "public", "mcp": false })),
    responses(
        (status = 202, description = "The Change that proposes it", body = Object),
        (status = 400, description = "A property the row does not change or a value of the wrong type, as an OData error"),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "The caller may not propose it, or the row is not this project's: the reason in the problem's detail", body = ProblemDetails),
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
    let door = Door {
        user: &user,
        front,
        state: &state,
        project: &project,
        headers: &headers,
        answer: std::sync::Mutex::new(None),
    };
    write_one(door, &entity, "update", || {
        patch_of(&body).map(Change::Update)
    })
    .await
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
        (status = 403, description = "The caller may not delete it, or the row is not this project's: the reason in the problem's detail", body = ProblemDetails),
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
    let door = Door {
        user: &user,
        front,
        state: &state,
        project: &project,
        headers: &headers,
        answer: std::sync::Mutex::new(None),
    };
    write_one(door, &entity, "delete", || Ok(Change::Delete)).await
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

    fn row(id: &str, title: Option<&str>, space: &str, mcp: bool) -> Value {
        row_of([
            json!(id),
            json!(id),
            json!(title),
            Value::Null,
            json!(space),
            json!(format!("slug{id}")),
            json!("public"),
            json!(mcp),
            json!("p"),
            json!(OWN),
            Value::Null,
            json!("Ready"),
            Value::Null,
            json!(id.len()),
        ])
    }

    /// The answer to `query` over `rows`, every one readable, as the route runs it.
    fn answer_of(rows: Vec<Value>, query: &str, root: &str) -> Result<Value, Refusal> {
        let table = Endpoints::new(rows, None).expect("rows");
        tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("runtime")
            .block_on(answer(&table, &Scope::all(), query, root))
    }

    /// The manifest merge patch of an OData `PATCH` body.
    fn spec_patch(body: &[u8]) -> Result<Value, Refusal> {
        patch_of(body).map(|patch| spec_of(&patch))
    }

    fn rows() -> Vec<Value> {
        vec![
            row("bikes", Some("Bike counters"), "air", true),
            row("trams", Some("Tram stops"), "water", false),
            row("air-quality", None, "air", true),
        ]
    }

    fn ids(query: &str) -> Vec<String> {
        let body = answer_of(rows(), query, ROOT).unwrap_or_else(|r| panic!("{query}: {r:?}"));
        body["value"]
            .as_array()
            .unwrap_or(&vec![])
            .iter()
            .map(|v| v["id"].as_str().unwrap_or_default().to_owned())
            .collect()
    }

    fn refused(query: &str) -> Refusal {
        match answer_of(rows(), query, ROOT) {
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
        let body =
            answer_of(rows(), "$select=title,id&$filter=id eq 'bikes'", ROOT).expect("answer");
        assert_eq!(
            body["value"],
            json!([{ "id": "bikes", "title": "Bike counters" }])
        );
        assert_eq!(
            body["@odata.context"],
            json!(format!("{ROOT}$metadata#Endpoints(id,title)"))
        );
        let all = answer_of(rows(), "$select=*&$top=1", ROOT).expect("answer");
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
        let body =
            answer_of(rows(), "$count=true&$top=1&$skip=1&$orderby=id", ROOT).expect("answer");
        assert_eq!(body["@odata.count"], json!(3));
        assert_eq!(body["value"], json!([rows_json("bikes")]));
        assert!(body.get("@odata.nextLink").is_none(), "{body}");
        let counted =
            answer_of(rows(), "$count=true&$filter=mcp eq true&$top=0", ROOT).expect("answer");
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
        let many: Vec<Value> = (0..1001)
            .map(|i| row(&format!("e{i:04}"), None, "air", true))
            .collect();
        let body = answer_of(many.clone(), "$filter=contextSpace eq 'air'", ROOT).expect("answer");
        assert_eq!(body["value"].as_array().map(Vec::len), Some(1000));
        let next = body["@odata.nextLink"].as_str().expect("a next link");
        let query = next
            .strip_prefix(&format!("{ROOT}Endpoints?"))
            .expect("same entity set");
        assert!(query.contains("$skip=1000"), "{next}");
        let second = answer_of(many, query, ROOT).expect("the next page");
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
        let shared = endpoint_row(
            &manifest("air", json!({ "slug": "s1" })),
            "espoo",
            SHARED,
            Some("r1"),
            None,
        );
        assert_eq!(field(&shared, "id"), Some("espoo/air"));
        assert_eq!(field(&shared, "reference"), Some("r1"));
        assert_eq!(shared.get("calls7d"), Some(&Value::Null));
        let gone = gone_row(&manifest(
            "r9",
            json!({ "alias": "Old air", "endpointSlug": "s9" }),
        ));
        assert_eq!(field(&gone, "id"), Some("reference:r9"));
        assert_eq!(field(&gone, "title"), Some("Old air"));
        assert_eq!(field(&gone, "kind"), Some(GONE));
    }
}
