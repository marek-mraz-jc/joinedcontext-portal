//! One operation registry behind the UI, the API, the assistant, and MCP (AG-59, ADR-N-021).
//!
//! Every action the Portal offers is an operation: a name, input/output schemas,
//! behaviour annotations, required roles/verbs, and an interaction lane (CC-70).
//! REST and MCP surfaces act as thin adapters over these same functions (CC-48).
//!
//! Note on drafts (AG-61), verdict gating (AG-62) and elicitation (AG-63): these are
//! later increments (T-0638/T-0639). Proposal operations currently return the planned Change
//! envelope directly since human review on the merge request serves as the gate.

use std::future::Future;
use std::pin::Pin;
use std::sync::OnceLock;

pub mod admin;
pub mod changes;
pub mod compute;
pub mod drafts;
pub mod feed_shape;
pub mod people;
pub mod pipeline_steps;
pub mod previews;
pub mod proposals;
pub mod resources;
pub mod runs;
pub mod space_complete;
pub mod sync_sources;
pub mod verdict;
pub mod views;
pub mod workspaces;

pub(crate) use changes::change_schema;
pub use drafts::*;
pub(crate) use proposals::datasource_verdict;
pub(crate) use proposals::dry_run_output_schema;
pub(crate) use proposals::manifest_input_schema;
pub(crate) use proposals::propose_with_optional_draft;
pub(crate) use proposals::ManifestInput;
pub use proposals::{
    forget_check, forget_import_check, record_check, record_import_check, record_refused_check,
    verdict_for_import, verdict_for_manifest, verdict_refusal,
};
pub use verdict::*;

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use jc_core::kinds::Verb;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use utoipa::ToSchema;

use crate::auth::session::Identity;
use crate::change::Lane;
use crate::error::ApiError;
use crate::state::AppState;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Via {
    Session,
    Bearer,
    Mcp,
    /// An assistant or application run acting for the person who started it (AG-70).
    Agent,
}

impl Via {
    /// Who last touched a draft, as the draft records it (AG-61).
    pub fn touched_kind(self) -> &'static str {
        match self {
            Via::Session => "person",
            Via::Bearer => "api-key",
            Via::Mcp => "mcp",
            Via::Agent => "run",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Caller {
    pub identity: Identity,
    pub via: Via,
    /// What the run's `AgentProfile` grants, when this call belongs to an agent run (AG-70). The
    /// identity is always the person who started the run: an agent has no ambient access (AG-03).
    ///
    /// `None` is a person at a keyboard or a program with their own token: their bindings alone
    /// decide. A profile is the second half and only ever narrows — an operation the person may
    /// not run stays refused whether the profile names it or not.
    pub access: Option<crate::agents::access::Access>,
}

impl Caller {
    pub fn new(identity: Identity, via: Via) -> Self {
        Self {
            identity,
            via,
            access: None,
        }
    }

    /// A call made inside an agent run: the person who started it, narrowed by its profile.
    pub fn for_run(identity: Identity, access: crate::agents::access::Access) -> Self {
        Self {
            identity,
            via: Via::Agent,
            access: Some(access),
        }
    }

    /// The profile's half of a call, where a caller has one (AG-70).
    pub fn grants(&self, op: &Operation) -> Result<(), OpError> {
        match &self.access {
            Some(access) if !access.names(op) => Err(OpError::Api(ApiError::Denied(
                crate::agents::access::refusal(op.name),
            ))),
            _ => Ok(()),
        }
    }

    /// Whether this caller may run the operation at all — asked before anything is asked of a
    /// person (AG-63).
    ///
    /// A refusal that arrives after the confirmation has the person answer a question whose
    /// answer changes nothing, and it teaches an agent that approving is something it does and
    /// then fails at. The profile's half (AG-70) and the refusal no profile can lift (AG-11,
    /// AG-82) are both knowable from the caller and the operation alone, so they are decided
    /// here — and because [`listing`] filters on this function, an operation refused here is one
    /// `GET …/ops` and `tools/list` do not offer either.
    pub fn may_run(&self, op: &Operation) -> Result<(), OpError> {
        // AG-11 before AG-70: a profile that names an approval is an author's mistake, and being
        // told the profile does not grant what it plainly lists explains nothing. The true reason
        // is that no profile can grant it.
        if op.kind == "Change" && op.verb.is_some() {
            resources::refuse_agent_decision(self)?;
        }
        if op.name == "jc_workspace_propose" {
            workspaces::refuse_agent_bring_back(self)?;
        }
        if op.name == "jc_workspace_discard" {
            workspaces::refuse_agent_discard(self)?;
        }
        // The rest of what no profile can grant: another run, the answer to a run's question, and
        // a service account's keys (AG-11). Their refusal used to live in the body alone, which
        // left `listing` — and so `GET …/ops` and `tools/list` — offering a run an operation it
        // would always be denied.
        runs::refuse_agent(self, op.name)?;
        self.grants(op)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct OperationAnnotations {
    pub read_only_hint: bool,
    pub destructive_hint: bool,
    pub idempotent_hint: bool,
}

pub type Annotations = OperationAnnotations;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct OperationSummary {
    pub name: String,
    pub title: String,
    pub description: String,
    #[schema(value_type = Object)]
    pub input_schema: Value,
    #[schema(value_type = Object)]
    pub output_schema: Value,
    pub annotations: OperationAnnotations,
    pub lane: Lane,
}

#[derive(Debug, thiserror::Error)]
pub enum OpError {
    #[error("forbidden: missing role {0}")]
    Forbidden(String),
    #[error("invalid input at {path}: {message}")]
    InvalidInput { path: String, message: String },
    #[error("conflict: {0}")]
    Conflict(Value),
    #[error(transparent)]
    Api(#[from] ApiError),
}

impl From<serde_json::Error> for OpError {
    fn from(err: serde_json::Error) -> Self {
        OpError::Api(ApiError::Internal(err.to_string()))
    }
}

impl IntoResponse for OpError {
    fn into_response(self) -> Response {
        match self {
            OpError::Forbidden(role) => (
                StatusCode::FORBIDDEN,
                [(axum::http::header::CONTENT_TYPE, "application/json")],
                Json(json!({
                    "error": "forbidden",
                    "role": role,
                })),
            )
                .into_response(),
            OpError::InvalidInput { path, message } => (
                StatusCode::UNPROCESSABLE_ENTITY,
                [(axum::http::header::CONTENT_TYPE, "application/json")],
                Json(json!({
                    "error": "invalid_input",
                    "path": path,
                    "message": message,
                })),
            )
                .into_response(),
            OpError::Conflict(val) => (
                StatusCode::CONFLICT,
                [(axum::http::header::CONTENT_TYPE, "application/json")],
                Json(val),
            )
                .into_response(),
            OpError::Api(err) => err.into_response(),
        }
    }
}

impl From<OpError> for ApiError {
    fn from(err: OpError) -> Self {
        match err {
            OpError::Forbidden(msg) => ApiError::Denied(msg),
            OpError::InvalidInput { path, message } => {
                ApiError::BadRequest(format!("{path}: {message}"))
            }
            // The verdict gate's document travels whole, so a REST door answers what the
            // operation answers (T-0956).
            OpError::Conflict(val) if val.get("error") == Some(&json!("verdict_required")) => {
                ApiError::VerdictRequired(val)
            }
            OpError::Conflict(val) => ApiError::Conflict(
                val.get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("conflict")
                    .to_owned(),
            ),
            OpError::Api(api) => api,
        }
    }
}

pub struct Operation {
    pub name: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    pub input: fn() -> Value,
    pub output: fn() -> Value,
    pub annotations: OperationAnnotations,
    pub kind: &'static str,
    pub verb: Option<Verb>,
    pub lane: Lane,
    pub validate: fn(&Value) -> Result<(), OpError>,
    pub run: RunFn,
}

/// One operation's body: the caller, the state, the project and the validated input.
pub type RunFn =
    for<'a> fn(&'a Caller, &'a AppState, &'a str, Value) -> BoxFuture<'a, Result<Value, OpError>>;

pub(crate) fn serde_error_path_and_message(err: &serde_json::Error) -> (String, String) {
    let msg = err.to_string();
    if let Some(rest) = msg.strip_prefix("unknown field `") {
        if let Some((field, _)) = rest.split_once('`') {
            return (format!("/{field}"), msg);
        }
    }
    if let Some(rest) = msg.strip_prefix("missing field `") {
        if let Some((field, _)) = rest.split_once('`') {
            return (format!("/{field}"), msg);
        }
    }
    ("/".to_string(), msg)
}

static REGISTRY: OnceLock<Vec<Operation>> = OnceLock::new();

pub fn registry() -> &'static [Operation] {
    REGISTRY.get_or_init(init_registry)
}

pub fn find(name: &str) -> Option<&'static Operation> {
    registry().iter().find(|op| op.name == name)
}

pub async fn call(
    op: &Operation,
    caller: &Caller,
    state: &AppState,
    project: &str,
    input: Value,
) -> Result<Value, OpError> {
    caller.may_run(op)?;
    permitted(op, &caller.identity, state, project)?;
    within_schema(op, &input)?;
    (op.validate)(&input)?;
    (op.run)(caller, state, project, input).await
}

/// The input against the schema the operation publishes (T-1659): what `tools/list` promises an
/// MCP client is what the door enforces, so an unbounded string or a member nobody named is
/// refused here, with the path of the first thing wrong, before the operation parses anything.
fn within_schema(op: &Operation, input: &Value) -> Result<(), OpError> {
    // ponytail: compiled per call; the schemas are a few dozen lines. Cache per operation when
    // a profile shows this on the hot path.
    let validator = jsonschema::validator_for(&(op.input)()).map_err(|e| {
        OpError::Api(ApiError::Internal(format!(
            "the input schema of {} does not compile: {e}",
            op.name
        )))
    })?;
    let first = validator
        .iter_errors(input)
        .next()
        .map(|error| (error.instance_path().to_string(), error.to_string()));
    match first {
        None => Ok(()),
        Some((path, message)) => Err(OpError::InvalidInput {
            path: if path.is_empty() {
                "/".to_owned()
            } else {
                path
            },
            message,
        }),
    }
}

/// The person's half of a call (PF-50), as the REST route of the same action decides it: the
/// operation's verb on its kind; for a decision on a change, the verb on any kind, the change's own
/// kind being checked when the change is read; for a resource operation, the check its route
/// function makes (AG-77); for any other verbless operation, a grant in the project.
pub fn permitted(
    op: &Operation,
    identity: &crate::auth::session::Identity,
    state: &AppState,
    project: &str,
) -> Result<(), OpError> {
    let effective = crate::permissions::for_request(state, identity, project);
    match (op.kind, op.verb) {
        ("Change", Some(_)) => crate::api::changes::may_approve_anything(state, identity, project)?,
        (kind, Some(verb)) => effective.check(kind, verb, None)?,
        (_, None) if resources::CHECKED_BY_THE_ROUTE.contains(&op.name) => {}
        // A read of a project the caller may not read is the answer of a project that is not
        // there (PF-59, R20); a write keeps its 403, which names what is missing (PF-50).
        (_, None) if !effective.may_read_project() && op.annotations.read_only_hint => {
            return Err(OpError::Api(ApiError::NotFound(format!(
                "project '{project}' not found"
            ))));
        }
        (_, None) if !effective.may_read_project() => {
            return Err(OpError::Api(ApiError::Denied(format!(
                "no role grants access in project {project} (PF-50)"
            ))));
        }
        (_, None) => {}
    }
    Ok(())
}

/// The operations this caller may run in the project: the ones [`permitted`] lets through.
pub fn listing(caller: &Caller, state: &AppState, project: &str) -> Vec<OperationSummary> {
    registry()
        .iter()
        .filter(|op| caller.may_run(op).is_ok())
        .filter(|op| permitted(op, &caller.identity, state, project).is_ok())
        .map(|op| OperationSummary {
            name: op.name.to_string(),
            title: op.title.to_string(),
            description: op.description.to_string(),
            input_schema: (op.input)(),
            output_schema: (op.output)(),
            annotations: op.annotations,
            lane: op.lane,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Input structures with serde(deny_unknown_fields)
// ---------------------------------------------------------------------------

fn parse_input<T: serde::de::DeserializeOwned>(val: Value) -> Result<T, OpError> {
    serde_json::from_value(val).map_err(|e| {
        let (path, message) = serde_error_path_and_message(&e);
        OpError::InvalidInput { path, message }
    })
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EmptyInput {}

/// The bounds every input schema draws from (T-1659, AG-64, MF-40). The input schema is what an
/// MCP client reads in `tools/list`, what the assistant is prompted with, and what [`call`]
/// checks an input against before the operation's own parse: a property says what it is, a
/// string says how long it may be, and an object either names its properties or says how many
/// it may carry.
pub(crate) mod bounds {
    use serde_json::{json, Value};

    /// A Kubernetes object name (DNS-1123 subdomain).
    pub const NAME: u64 = 253;
    /// A kind, a type, an attribute, a unit or a format name.
    pub const TERM: u64 = 128;
    /// An id: a URN, a change id, a key id.
    pub const ID: u64 = 512;
    /// A title or a short label a person reads.
    pub const TITLE: u64 = 256;
    /// A query expression.
    pub const QUERY: u64 = 2048;
    /// A URL.
    pub const URL: u64 = 2048;
    /// A message, a prompt, an answer: what a person or a model writes.
    pub const TEXT: u64 = 20_000;
    /// The top-level members of a manifest: apiVersion, kind, metadata, spec, status.
    pub const MANIFEST_MEMBERS: u64 = 5;
    /// The members of one free-form record: an entity, a sample row, a parameter map.
    pub const RECORD_MEMBERS: u64 = 512;

    /// A string property with its description and its length bound.
    pub fn text(description: &str, max: u64) -> Value {
        json!({ "type": "string", "description": description, "maxLength": max })
    }

    /// A list of bounded strings.
    pub fn texts(description: &str, max: u64) -> Value {
        json!({
            "type": "array",
            "description": description,
            "items": { "type": "string", "maxLength": max }
        })
    }

    /// A whole manifest as an object; the kind's own parse checks everything inside it (MF-37).
    pub fn manifest(description: &str) -> Value {
        json!({
            "type": "object",
            "description": description,
            "maxProperties": MANIFEST_MEMBERS
        })
    }

    /// The saved draft to act on instead of an inline manifest.
    pub fn draft_ref() -> Value {
        json!({
            "type": "object",
            "description": "A saved draft to use instead of an inline manifest",
            "properties": {
                "kind": text("The draft's kind, e.g. Endpoint", TERM),
                "name": text("The draft's metadata.name", NAME)
            },
            "required": ["kind", "name"],
            "additionalProperties": false
        })
    }

    /// The workspace a draft belongs to; absent is the project's own (CC-76, T-2267).
    pub fn workspace() -> Value {
        text(
            "The workspace (copy) the draft belongs to; leave out for the project's own drafts",
            NAME,
        )
    }
}

/// The verdict a check leaves on a draft, written out for the clients that read it (AG-62).
fn verdict_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "ok": { "type": "boolean" },
            "findings": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "level": { "type": "string", "enum": ["error", "warning", "info"] },
                        "path": { "type": "string" },
                        "message": { "type": "string" }
                    }
                }
            },
            "trace": { "type": "object" },
            "checkedAt": { "type": "string", "format": "date-time" },
            "inputDigest": { "type": "string", "description": "`sha256:` and the digest of the manifest checked" }
        },
        "required": ["ok", "findings", "checkedAt", "inputDigest"]
    })
}

pub(super) fn empty_input_schema() -> Value {
    json!({
        "type": "object",
        "properties": {},
        "additionalProperties": false
    })
}

fn init_registry() -> Vec<Operation> {
    let mut operations = compute::operations();
    operations.extend(proposals::operations());
    operations.extend(changes::operations());
    operations.extend(drafts::operations());
    operations.extend(space_complete::operations());
    operations.extend(resources::operations());
    operations.extend(runs::operations());
    operations.extend(views::operations());
    operations.extend(pipeline_steps::operations());
    operations.extend(admin::operations());
    operations.extend(sync_sources::operations());
    operations.extend(workspaces::operations());
    operations.extend(people::operations());
    operations
}

#[cfg(test)]
mod tests {
    use super::*;

    /// T-1659, AG-64: the door enforces the schema it publishes. A bounded string past its
    /// bound and a member the schema does not name are refused with the path to them, before
    /// the operation's own parse; an input inside the schema goes through.
    #[test]
    fn an_input_outside_the_published_schema_is_refused_at_the_door() {
        let op = find("jc_catalog_search").expect("the operation is registered");
        assert!(within_schema(op, &json!({ "q": "air quality" })).is_ok());

        let long = "x".repeat(bounds::QUERY as usize + 1);
        match within_schema(op, &json!({ "q": long })) {
            Err(OpError::InvalidInput { path, .. }) => assert_eq!(path, "/q"),
            other => panic!("an over-long query went through: {other:?}"),
        }
        match within_schema(op, &json!({ "q": "a", "sql": "drop table" })) {
            Err(OpError::InvalidInput { path, message }) => {
                assert_eq!(path, "/");
                assert!(message.contains("sql"), "{message}");
            }
            other => panic!("an unnamed member went through: {other:?}"),
        }
    }

    /// Every published input schema compiles, or every call of that operation would fail.
    #[test]
    fn every_input_schema_compiles() {
        for op in registry() {
            assert!(
                jsonschema::validator_for(&(op.input)()).is_ok(),
                "{} publishes a schema that does not compile",
                op.name
            );
        }
    }

    #[test]
    fn registry_lists_all_operations() {
        // No count: a number every new operation edits tests nothing (T-1499). What must hold is
        // that a name means one operation, and that these are still there.
        let mut names: Vec<&str> = registry().iter().map(|op| op.name).collect();
        let total = names.len();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), total, "two operations share a name");
        for name in [
            "jc_catalog_search",
            "jc_endpoint_propose",
            "jc_kpi_compute",
            "jc_manifest_dry_run",
            "jc_pipeline_test",
            "jc_change_list",
            "jc_change_approve",
            "jc_datasource_check",
            "jc_datasource_propose",
            "jc_pipeline_propose",
            "jc_space_propose",
            "jc_model_propose",
            "jc_model_infer",
            "jc_space_complete",
            "jc_draft_put",
            "jc_draft_get",
            "jc_draft_list",
            "jc_draft_drop",
            "jc_resource_list",
            "jc_resource_get",
            "jc_resource_propose",
            "jc_resource_delete",
            "jc_change_reject",
            "jc_pipeline_metrics",
            "jc_activity_list",
            "jc_federation_graph",
            "jc_model_source_get",
            "jc_run_create",
            "jc_run_cancel",
            "jc_run_publish",
            "jc_project_create",
            "jc_project_delete",
            "jc_project_export",
            "jc_project_import",
            "jc_model_source_put",
            "jc_service_account_key_mint",
            "jc_service_account_key_rotate",
            "jc_service_account_key_revoke",
            "jc_change_get",
            "jc_run_list",
            "jc_run_get",
            "jc_service_account_key_list",
            "jc_ckan_status",
            "jc_endpoint_list_all",
            "jc_project_get",
            "jc_project_revisions",
            "jc_run_answer",
            "jc_run_message",
            "jc_flow_start",
            "jc_syncsource_status",
            "jc_syncsource_sync",
            "jc_syncsource_pause",
            "jc_syncsource_detach",
        ] {
            assert!(find(name).is_some(), "missing operation {name}");
        }
    }

    #[test]
    fn validate_detects_unknown_fields_and_reports_path() {
        let op = find("jc_catalog_search").expect("jc_catalog_search");
        let valid = json!({ "q": "traffic" });
        assert!((op.validate)(&valid).is_ok());

        let invalid = json!({ "q": "traffic", "extraField": 123 });
        let err = (op.validate)(&invalid).expect_err("should reject unknown field");
        match err {
            OpError::InvalidInput { path, message } => {
                assert_eq!(path, "/extraField");
                assert!(message.contains("unknown field `extraField`"));
            }
            other => panic!("expected InvalidInput, got {other:?}"),
        }
    }

    #[test]
    fn listing_filters_by_permission() {
        use crate::config::Config;
        use crate::permissions::ORG_NAMESPACE;
        use crate::resource::ResourceEnvelope;

        let config = Config::for_tests();
        let state = AppState::new(config, None);

        // Principal without bindings
        let viewer_id = Identity {
            subject: "f:1:viewer".into(),
            username: "viewer".into(),
            email: Some("viewer@example.sk".into()),
            name: None,
            roles: vec!["portal-viewer".into()],
            groups: vec![],
        };
        let viewer_caller = Caller::new(viewer_id, Via::Session);

        // Without a binding: the resource operations, which check the caller as their routes do.
        let list = listing(&viewer_caller, &state, "ovzdusie");
        let names: Vec<_> = list.iter().map(|o| o.name.as_str()).collect();
        assert_eq!(names, resources::CHECKED_BY_THE_ROUTE);

        // Add role & binding for pipeline-developer
        let role = ResourceEnvelope {
            api_version: crate::resource::API_VERSION.into(),
            kind: "Role".into(),
            metadata: crate::resource::ObjectMeta::new("developer", ORG_NAMESPACE),
            spec: json!({
                "rules": [
                    { "kinds": ["Pipeline", "DataSource"], "verbs": ["propose"] }
                ]
            }),
            status: None,
        };
        let binding = ResourceEnvelope {
            api_version: crate::resource::API_VERSION.into(),
            kind: "RoleBinding".into(),
            metadata: crate::resource::ObjectMeta::new("dev-binding", ORG_NAMESPACE),
            spec: json!({
                "role": "developer",
                "subjects": [{ "group": "devs" }],
                "scope": { "project": "ovzdusie" }
            }),
            status: None,
        };
        state.mirror.upsert(role);
        state.mirror.upsert(binding);

        let dev_id = Identity {
            subject: "f:1:dev".into(),
            username: "dev".into(),
            email: Some("dev@example.sk".into()),
            name: None,
            roles: vec![],
            groups: vec!["devs".into()],
        };
        let dev_caller = Caller::new(dev_id, Via::Session);

        let dev_list = listing(&dev_caller, &state, "ovzdusie");
        let names: Vec<_> = dev_list.iter().map(|o| o.name.as_str()).collect();

        // Should include read-only ops and propose ops for Pipeline/DataSource
        assert!(names.contains(&"jc_catalog_search"));
        assert!(names.contains(&"jc_datasource_propose"));
        assert!(names.contains(&"jc_pipeline_propose"));
        // Should NOT include propose ops for kinds not granted
        assert!(!names.contains(&"jc_space_propose"));
        assert!(!names.contains(&"jc_change_approve"));
    }

    // ---------------------------------------------------------------------------------------------
    // `serde_error_path_and_message` (T-2116; PF-51, AG-59)
    //
    // The pair a caller reads in a 422: `path` points at the field that is wrong and `message` is
    // serde's own sentence. Its contract is narrow and worth pinning, because it is the one place
    // where text a caller chose (a field name they invented) is put into an answer: the path must
    // stay one field reference, and the pair must stay something a JSON body can carry. Neither
    // half is ever logged — `parse_input` (line 387) is the only builder of `InvalidInput`, and no
    // call site logs it — so an input echoed back reaches nobody but the caller who sent it.
    // ---------------------------------------------------------------------------------------------

    /// Deserialise into a struct with `deny_unknown_fields`, the way every operation's input is.
    fn input_error(input: Value) -> serde_json::Error {
        #[derive(Debug, serde::Deserialize)]
        #[serde(deny_unknown_fields, rename_all = "camelCase")]
        #[allow(dead_code)]
        struct Wanted {
            project: String,
            limit: u32,
        }
        serde_json::from_value::<Wanted>(input).expect_err("the input is not valid")
    }

    #[test]
    fn a_field_the_schema_does_not_have_is_pointed_at_by_name() {
        for (input, path) in [
            (
                json!({ "project": "ovzdusie", "limit": 1, "extra": 1 }),
                "/extra",
            ),
            (
                json!({ "project": "ovzdusie", "limit": 1, "Limit": 1 }),
                "/Limit",
            ),
            (
                json!({ "project": "ovzdusie", "limit": 1, "l\u{00ed}mit": 1 }),
                "/l\u{ed}mit",
            ),
        ] {
            let (found, message) = serde_error_path_and_message(&input_error(input));
            assert_eq!(found, path);
            assert!(
                message.starts_with("unknown field"),
                "the message stopped saying what was wrong: {message}",
            );
        }
    }

    #[test]
    fn a_field_the_input_left_out_is_pointed_at_by_name() {
        let (path, message) = serde_error_path_and_message(&input_error(json!({ "limit": 1 })));
        assert_eq!(path, "/project");
        assert!(message.starts_with("missing field"), "{message}");
    }

    #[test]
    fn anything_else_points_at_the_whole_input() {
        for input in [
            json!({ "project": 7, "limit": 1 }),           // the wrong type
            json!({ "project": "ovzdusie", "limit": -1 }), // out of range
            json!({ "project": "ovzdusie", "limit": 4_294_967_296_i64 }), // the bound plus one
            json!([]),                                     // not an object at all
            Value::Null,
            json!("ovzdusie"),
        ] {
            let (path, message) = serde_error_path_and_message(&input_error(input.clone()));
            assert_eq!(path, "/", "{input}");
            assert!(!message.is_empty(), "{input} produced no message");
        }
    }

    #[test]
    fn a_field_name_the_caller_invented_cannot_break_out_of_the_answer() {
        for forged in [
            "a\nb",
            "a\r\nSet-Cookie: x=y",
            "a\"b",
            "a`b",
            "a/b",
            "a~b",
            "../../etc/passwd",
            "\u{0}",
            "\u{202e}drowssap",
        ] {
            let mut input = json!({ "project": "ovzdusie", "limit": 1 });
            input[forged] = json!(1);
            let (path, message) = serde_error_path_and_message(&input_error(input));
            assert!(path.starts_with('/'), "{forged:?} produced path {path:?}");
            // The pair travels as two JSON strings, so whatever the name was it is escaped on the
            // way out and no answer can grow a header or a second field of its own.
            let body = serde_json::to_string(&json!({ "path": path, "message": message }))
                .expect("a body");
            assert!(
                !body.contains('\n') && !body.contains('\r') && !body.contains('\0'),
                "{forged:?} reached the body raw: {body}",
            );
            assert!(
                serde_json::from_str::<Value>(&body).is_ok(),
                "{forged:?} produced a body that is not JSON: {body}",
            );
            // The path is a field reference for a person to read, not an escaped JSON Pointer: a
            // name holding `/` or `~` is passed through as written. Nothing resolves it, so this is
            // the shape the UI is told to expect — see /workspace/chyby.md.
            if forged == "a/b" {
                assert_eq!(path, "/a/b");
            }
        }
    }

    #[test]
    fn the_message_carries_the_callers_own_input_and_nothing_of_the_installation() {
        // A value typed into a field of the wrong type is quoted back by serde. It is the caller's
        // own text, it reaches nobody else (no call site logs `InvalidInput`), and nothing of the
        // state — no path, no token, no project the caller cannot see — is added to it.
        let (path, message) =
            serde_error_path_and_message(&input_error(json!({ "project": "ovzdusie",
                                                              "limit": "hunter2" })));
        assert_eq!(path, "/");
        assert!(message.contains("hunter2"), "{message}");
        for never in ["ovzdusie", "/workspace", "Bearer", "postgres", "keycloak"] {
            assert!(
                !message.contains(never),
                "the message carried {never:?}: {message}",
            );
        }
    }
}
