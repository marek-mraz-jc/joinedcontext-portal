//! A person's connectors (AG-142..AG-147, ADR-N-064, API/14): a grant one person gives one AI
//! client over part of the platform, served as an MCP server at `/c/{id}` (`crate::mcp::connector`).
//!
//! The record names segments (presets of tools and kinds) and a scope (projects, and inside one
//! the spaces, Endpoints or pipelines it reaches). Nothing here is a right of its own: every call
//! is the owner's, narrowed by the record, and the owner's live bindings decide again at each call
//! (`ops::permitted`), so a role the owner lost drops from every connector at its next call.
//!
//! Two storage arms like every store here: `Postgres` over migration `0051_connectors.sql`, and
//! `Memory` when the Portal runs without a database.

use std::sync::Mutex;

use argon2::password_hash::rand_core::{OsRng, RngCore};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use utoipa::ToSchema;

use crate::activity::{chrono_to_odt, odt_to_chrono};
use crate::error::ApiError;
use crate::ops::Operation;
use crate::resource::is_dns1123;

/// Live connectors one person may hold (T-5950).
pub const MAX_PER_PERSON: usize = 20;
/// Scope items and allowed clients one connector may name.
const MAX_SCOPE: usize = 50;
const MAX_CLIENTS: usize = 10;
/// Audit rows one activity page carries, and how long a row is kept.
pub const CALLS_PAGE: i64 = 200;
const CALLS_KEPT_DAYS: i64 = 30;
/// Connectors the organization overview lists, live ones first (T-5975).
const OVERVIEW_PAGE: i64 = 500;
/// Refused calls in a day that flag a connector on the overview: a client probing past its scope.
pub const DENIALS_FLAG: i64 = 10;

/// A segment (API/14 §1, Architecture/07 §11): the read tools it lists and the kinds those tools
/// may name. A segment that proposes lists `jc_change_plan` (a dry run, nothing saved); the one
/// write, `jc_change_apply`, comes with the connector's `writes` switch alone (AG-149, T-5956).
/// Cross-project tools (people, projects, every Endpoint) are in none.
pub const SEGMENTS: &[(&str, &[&str], &[&str])] = &[
    (
        "data-read",
        &[
            "jc_schema_get",
            "jc_resource_list",
            "jc_resource_get",
            "jc_kpi_compute",
            "jc_data_query",
        ],
        &["Endpoint", "ContextSpace", "DataModel"],
    ),
    (
        "context",
        &[
            "jc_change_plan",
            "jc_schema_get",
            "jc_resource_list",
            "jc_resource_get",
            "jc_model_source_get",
        ],
        &["ContextSpace", "DataModel", "Endpoint", "Policy"],
    ),
    (
        "pipeline",
        &[
            "jc_change_plan",
            "jc_schema_get",
            "jc_resource_list",
            "jc_resource_get",
            "jc_pipeline_metrics",
            "jc_syncsource_status",
        ],
        &[
            "Pipeline",
            "DataSource",
            "SyncSource",
            "ContextSpace",
            "DataModel",
            "Endpoint",
        ],
    ),
    (
        "access",
        &[
            "jc_change_plan",
            "jc_schema_get",
            "jc_resource_list",
            "jc_resource_get",
        ],
        &["Role", "RoleBinding", "ServiceAccount", "Policy", "Group"],
    ),
    (
        "publish",
        &[
            "jc_change_plan",
            "jc_schema_get",
            "jc_resource_list",
            "jc_resource_get",
            "jc_ckan_status",
        ],
        &["Endpoint", "CkanInstance"],
    ),
    (
        "apps",
        &[
            "jc_change_plan",
            "jc_schema_get",
            "jc_resource_list",
            "jc_resource_get",
            "jc_run_list",
            "jc_run_get",
        ],
        &["App"],
    ),
    (
        "operate",
        &[
            "jc_change_plan",
            "jc_activity_list",
            "jc_pipeline_metrics",
            "jc_syncsource_status",
            "jc_change_list",
            "jc_change_get",
        ],
        &["Pipeline", "SyncSource"],
    ),
];

/// The plan and apply tools (API/14 §4.3).
pub const PLAN: &str = "jc_change_plan";
pub const APPLY: &str = "jc_change_apply";

/// `admin` is every segment above.
pub const ADMIN: &str = "admin";

/// What a person no DelegationPolicy names may put in a connector (ADR-N-064 §3.5, AG-150):
/// `data-read`, reads only, 30 days, any client.
// ponytail: the organization default for everyone; T-5953 reads the DelegationPolicy ceiling.
pub struct Ceiling {
    pub segments: &'static [&'static str],
    pub writes: bool,
    pub max_days: i64,
    /// Whether a scope item may tick `personalData` (AG-158).
    pub personal_data: bool,
}

pub const DEFAULT_CEILING: Ceiling = Ceiling {
    segments: &["data-read"],
    writes: false,
    max_days: 30,
    personal_data: false,
};

/// What one connector may spend (T-5968): its own calls a minute, calls at once and answer size.
/// The person's own budget (`PERSON_LIMITS`) holds across all their connectors and `/api/v1/mcp`
/// together, so a second connector adds no calls. Counted on the verified token's subject and the
/// connector id from the path, never on a header.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(as = ConnectorLimits)]
pub struct Limits {
    /// Tool calls a minute; the call past it answers 429 with `Retry-After`.
    pub calls_per_minute: u32,
    /// Calls answered at once; the next answers 429 until one ends.
    pub parallel_calls: u32,
    /// The largest tool answer in bytes; a larger one is refused as a 413 tool error naming
    /// what to narrow.
    pub result_bytes: usize,
}

/// Every connector's limits (T-5968). Decided (worker-t5968, owner may override): constants in
/// code until a DelegationPolicy lowers them (T-5953); a person's 120 calls a minute (AG-60)
/// split so one runaway connector leaves the person half for the others; 4 at once covers a
/// model's parallel tool calls (Claude and ChatGPT issue 2-4 per turn); 1 MiB is ~250k tokens,
/// past any model context a tool answer should fill, under the route's 4 MiB.
pub const DEFAULT_LIMITS: Limits = Limits {
    calls_per_minute: 60,
    parallel_calls: 4,
    result_bytes: 1024 * 1024,
};

/// One person's budget over all their connectors and `/api/v1/mcp` (AG-60, T-5968).
pub const PERSON_LIMITS: Limits = Limits {
    calls_per_minute: 120,
    parallel_calls: 8,
    result_bytes: 4 * 1024 * 1024,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
#[schema(as = ConnectorAccess)]
pub enum ItemAccess {
    Read,
    Write,
}

/// One item of a connector's scope: a project, and at most one of a space, an Endpoint or a
/// pipeline in it (`*` for every one the owner reaches). Without one it is the whole project.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schema(as = ConnectorScopeItem)]
pub struct ScopeItem {
    /// A project slug, e.g. `doprava`.
    pub project: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub space: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pipeline: Option<String>,
    pub access: ItemAccess,
    /// Whether answers through this item keep the attributes the model marks `personalData`
    /// (DM-122): off by default, and only where the organization's ceiling allows it (AG-158).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub personal_data: bool,
}

impl ScopeItem {
    fn narrowing(&self) -> Option<(&'static str, &str)> {
        [
            ("ContextSpace", &self.space),
            ("Endpoint", &self.endpoint),
            ("Pipeline", &self.pipeline),
        ]
        .into_iter()
        .find_map(|(kind, name)| name.as_deref().map(|name| (kind, name)))
    }

    /// Whether this item reaches the object `kind`/`name` of its project.
    fn names(&self, kind: &str, name: &str) -> bool {
        match self.narrowing() {
            None => true,
            Some((narrowed, item)) => narrowed == kind && (item == "*" || item == name),
        }
    }
}

/// What a person asks for when creating a connector (API/14 §1).
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewConnector {
    /// A DNS-1123 label unique among the person's connectors, e.g. `doprava-in-claude`.
    pub name: String,
    /// Presets, e.g. `["data-read"]`.
    pub segments: Vec<String>,
    pub scope: Vec<ScopeItem>,
    #[serde(default)]
    pub writes: bool,
    /// RFC 3339, e.g. `2026-11-27T00:00:00Z`.
    #[schema(value_type = String, format = DateTime)]
    pub expires_at: DateTime<Utc>,
    /// OAuth client ids the connector answers, e.g. a CIMD URL `https://claude.ai/oauth/mcp-client-metadata`.
    #[serde(default)]
    pub allowed_clients: Vec<String>,
}

/// What the Portal keeps of a connector, besides its id, owner and times.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GrantDoc {
    segments: Vec<String>,
    scope: Vec<ScopeItem>,
    writes: bool,
    expires_at: DateTime<Utc>,
    allowed_clients: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Record {
    id: String,
    owner: String,
    name: String,
    grant: GrantDoc,
    created_at: DateTime<Utc>,
    last_used_at: Option<DateTime<Utc>>,
    revoked_at: Option<DateTime<Utc>>,
}

/// A connector as its owner reads it (API/14 §1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(as = ConnectorGrant)]
pub struct Connector {
    pub id: String,
    pub name: String,
    pub owner: String,
    pub segments: Vec<String>,
    pub scope: Vec<ScopeItem>,
    pub writes: bool,
    #[schema(value_type = String, format = DateTime)]
    pub expires_at: DateTime<Utc>,
    pub allowed_clients: Vec<String>,
    /// Whether the allowed clients bind the connector (claude.ai, ChatGPT) or only say whom it
    /// is meant for (Claude Code, `mcp-local`): AG-153.
    pub client_is_boundary: bool,
    /// `active`, `expired` or `revoked`.
    pub state: String,
    #[schema(value_type = String, format = DateTime)]
    pub created_at: DateTime<Utc>,
    #[schema(value_type = Option<String>, format = DateTime)]
    pub last_used_at: Option<DateTime<Utc>>,
    /// The MCP address a client adds: `https://portal.{domain}/c/{id}`.
    pub url: String,
    /// What the connector may spend; shown on My connectors.
    pub limits: Limits,
}

impl Connector {
    pub fn is_active(&self) -> bool {
        self.state == "active"
    }

    /// The tools and kinds the segments reach.
    fn reach(&self) -> (Vec<&'static str>, Vec<&'static str>) {
        let mut tools = Vec::new();
        let mut kinds = Vec::new();
        for (segment, seg_tools, seg_kinds) in SEGMENTS {
            if self.segments.iter().any(|s| s == segment || s == ADMIN) {
                tools.extend_from_slice(seg_tools);
                kinds.extend_from_slice(seg_kinds);
            }
        }
        if self.writes {
            tools.push(APPLY);
        }
        tools.sort_unstable();
        tools.dedup();
        kinds.sort_unstable();
        kinds.dedup();
        (tools, kinds)
    }

    /// The narrowing a call through this connector carries, as an agent profile's access block
    /// (AG-70): only the segments' tools, `read` on their kinds, every Endpoint the scope names.
    pub fn access(&self) -> crate::agents::access::Access {
        let (tools, kinds) = self.reach();
        crate::agents::access::Access::from_spec(&json!({
            "access": {
                "operations": tools,
                "kinds": kinds.iter().map(|k| json!({ "kind": k, "verbs": ["read"] })).collect::<Vec<_>>(),
            }
        }))
        .through(self.clone())
    }

    /// Whether a plan (or, with `write`, an apply) may name `kind`/`name` of `project`: a kind of
    /// the segments, a scope item that reaches the object, and for a write the `writes` switch and
    /// `write` on that item (AG-144, AG-149). `Err` says which, naming the target.
    pub fn may_change(
        &self,
        project: &str,
        kind: &str,
        name: &str,
        write: bool,
    ) -> Result<(), String> {
        let (_, kinds) = self.reach();
        if !kinds.contains(&kind) {
            return Err(format!(
                "this connector's segments ({}) change only {}, not {kind}",
                self.segments.join(", "),
                kinds.join(", ")
            ));
        }
        let mut items = self
            .scope
            .iter()
            .filter(|i| i.project == project && i.names(kind, name))
            .peekable();
        if items.peek().is_none() {
            return Err(format!(
                "this connector does not reach {kind} {name} of project {project}"
            ));
        }
        if !write {
            return Ok(());
        }
        if !self.writes {
            return Err(format!(
                "this connector has writes off: apply the plan in the Portal, or turn writes on \
                 for connector {} on the My connectors page",
                self.name
            ));
        }
        if items.any(|i| i.access == ItemAccess::Write) {
            return Ok(());
        }
        Err(format!(
            "this connector only reads {kind} {name} of project {project}: its scope gives no \
             write there"
        ))
    }

    /// The projects the scope names, in order, once each.
    pub fn projects(&self) -> Vec<&str> {
        let mut projects: Vec<&str> = Vec::new();
        for item in &self.scope {
            if !projects.contains(&item.project.as_str()) {
                projects.push(&item.project);
            }
        }
        projects
    }

    fn whole(&self, project: &str) -> bool {
        self.scope
            .iter()
            .any(|i| i.project == project && i.narrowing().is_none())
    }

    /// Whether `tools/list` offers `op` in `project`: in a project the scope narrows to named
    /// items, only a tool that names its object can be held to them.
    pub fn lists(&self, op: &Operation, project: &str) -> bool {
        self.scope.iter().any(|i| i.project == project)
            && (self.whole(project) || names_its_object(op))
    }

    /// The scope's half of one call (AG-144): the project, the kind and the object the call
    /// names. `Err` is the reason the refusal carries, naming the target.
    pub fn admits(&self, op: &Operation, project: &str, args: &Value) -> Result<(), String> {
        if !self.scope.iter().any(|i| i.project == project) {
            return Err(format!(
                "this connector does not reach project {project}; its scope names {}",
                self.projects().join(", ")
            ));
        }
        let text = |key: &str| args.get(key).and_then(Value::as_str);
        let kind = if op.kind == "*" {
            text("kind")
        } else {
            Some(op.kind)
        };
        if matches!(op.name, "jc_resource_list" | "jc_resource_get") {
            let (_, kinds) = self.reach();
            match kind {
                Some(kind) if kinds.contains(&kind) => {}
                _ => {
                    return Err(format!(
                        "this connector's segments ({}) read only {}",
                        self.segments.join(", "),
                        kinds.join(", ")
                    ))
                }
            }
        }
        // A plan or an apply names its objects per change; the operation holds each one to
        // the scope with `may_change` (T-5956).
        if self.whole(project) || matches!(op.name, "jc_schema_get" | PLAN | APPLY) {
            return Ok(());
        }
        let name = names_its_object(op)
            .then(|| text("name").or_else(|| text("endpoint")))
            .flatten();
        match (kind, name) {
            (Some(kind), Some(name))
                if self
                    .scope
                    .iter()
                    .any(|i| i.project == project && i.names(kind, name)) =>
            {
                Ok(())
            }
            (Some(kind), Some(name)) => Err(format!(
                "this connector does not reach {kind} {name} of project {project}; it names {}",
                self.named(project)
            )),
            _ => Err(format!(
                "this connector reaches only {} of project {project}: name one",
                self.named(project)
            )),
        }
    }

    /// Whether a call in `project` with `args` may answer the attributes the model marks
    /// personal (AG-158): a ticked item of the project that reaches the call's Endpoint, named
    /// by `endpoint` or `name`. A ticked space or pipeline item does not reach one.
    pub fn shows_personal(&self, project: &str, args: &Value) -> bool {
        let endpoint = ["endpoint", "name"]
            .iter()
            .find_map(|key| args.get(*key).and_then(Value::as_str));
        self.scope.iter().any(|i| {
            i.project == project
                && i.personal_data
                && match i.narrowing() {
                    None => true,
                    Some(("Endpoint", name)) => name == "*" || Some(name) == endpoint,
                    Some(_) => false,
                }
        })
    }

    fn named(&self, project: &str) -> String {
        self.scope
            .iter()
            .filter(|i| i.project == project)
            .filter_map(ScopeItem::narrowing)
            .map(|(kind, name)| format!("{kind} {name}"))
            .collect::<Vec<_>>()
            .join(", ")
    }
}

/// A tool whose call names one object by `name`: what a narrowed scope can hold it to.
fn names_its_object(op: &Operation) -> bool {
    let input = (op.input)();
    matches!(op.name, "jc_resource_get" | PLAN | APPLY)
        || (matches!(op.kind, "Endpoint" | "ContextSpace" | "Pipeline")
            && input.pointer("/properties/name").is_some())
        || (op.kind == "Endpoint" && input.pointer("/properties/endpoint").is_some())
        || op.name == "jc_schema_get"
}

/// Whether a client id binds: a published client whose redirect URIs no local program can use
/// (AG-153). Claude Code's own document and realm clients are loopback, so "intended for" only.
// ponytail: the hosts of today's two vendors; T-5954 records the exact CIMD ids.
pub fn binds(client: &str) -> bool {
    let Ok(url) = url::Url::parse(client) else {
        return false;
    };
    url.scheme() == "https"
        && matches!(url.host_str(), Some("claude.ai" | "chatgpt.com"))
        && !url.path().contains("claude-code")
}

impl Record {
    fn view(&self, base: &str, now: DateTime<Utc>) -> Connector {
        let state = if self.revoked_at.is_some() {
            "revoked"
        } else if self.grant.expires_at <= now {
            "expired"
        } else {
            "active"
        };
        Connector {
            id: self.id.clone(),
            name: self.name.clone(),
            owner: self.owner.clone(),
            segments: self.grant.segments.clone(),
            scope: self.grant.scope.clone(),
            writes: self.grant.writes,
            expires_at: self.grant.expires_at,
            client_is_boundary: !self.grant.allowed_clients.is_empty()
                && self.grant.allowed_clients.iter().all(|c| binds(c)),
            allowed_clients: self.grant.allowed_clients.clone(),
            state: state.to_owned(),
            created_at: self.created_at,
            last_used_at: self.last_used_at,
            url: address(base, &self.id),
            limits: DEFAULT_LIMITS,
        }
    }
}

/// The connector's MCP address, which is also the audience its tokens carry (AG-143).
pub fn address(base: &str, id: &str) -> String {
    format!("{}/c/{id}", base.trim_end_matches('/'))
}

/// 26 random base32 characters (`a-z`, `2-7`): 130 bits, not guessable, not a secret either.
fn new_id() -> String {
    const ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
    let mut bytes = [0u8; 26];
    OsRng.fill_bytes(&mut bytes);
    bytes
        .iter()
        .map(|b| char::from(ALPHABET[usize::from(b & 31)]))
        .collect()
}

/// Whether `id` could be a connector id at all, so a probe never reaches the store.
pub fn is_id(id: &str) -> bool {
    id.len() == 26 && id.bytes().all(|b| matches!(b, b'a'..=b'z' | b'2'..=b'7'))
}

fn invalid(field: &str, detail: String) -> ApiError {
    ApiError::Invalid {
        detail,
        errors: vec![field.to_owned()],
    }
}

fn above_ceiling(field: &str, detail: String) -> ApiError {
    ApiError::Denied(format!("{field}: {detail} (AG-150)"))
}

/// Checks a request against its shape and the ceiling; the owner's rights over each scope item
/// are the caller's half (`api::connectors`), since they need the Portal's state.
pub fn validate(new: &NewConnector, ceiling: &Ceiling, now: DateTime<Utc>) -> Result<(), ApiError> {
    if !is_dns1123(&new.name) || new.name.len() > 63 {
        return Err(invalid(
            "name",
            format!("name '{}' must be a DNS-1123 label of at most 63 characters, e.g. doprava-in-claude", new.name),
        ));
    }
    validate_segments(&new.segments, ceiling)?;
    validate_scope(new)?;
    validate_personal(&new.scope, ceiling)?;
    if new.writes && !ceiling.writes {
        return Err(above_ceiling(
            "writes",
            "your organization lets a connector read only; writes arrive with plan_change (T-5956)"
                .into(),
        ));
    }
    if new.expires_at <= now {
        return Err(invalid(
            "expiresAt",
            "expiresAt must lie in the future".into(),
        ));
    }
    if new.expires_at > now + Duration::days(ceiling.max_days) {
        return Err(above_ceiling(
            "expiresAt",
            format!("a connector lives at most {} days", ceiling.max_days),
        ));
    }
    validate_clients(&new.allowed_clients)
}

fn validate_segments(segments: &[String], ceiling: &Ceiling) -> Result<(), ApiError> {
    if segments.is_empty() {
        return Err(invalid(
            "segments",
            "segments names at least one preset, e.g. data-read".into(),
        ));
    }
    for (i, segment) in segments.iter().enumerate() {
        let known = segment == ADMIN || SEGMENTS.iter().any(|(s, _, _)| s == segment);
        if !known {
            return Err(invalid(
                &format!("segments[{i}]"),
                format!("'{segment}' is no segment; one of data-read, context, pipeline, access, publish, apps, operate, admin"),
            ));
        }
        if !ceiling.segments.contains(&segment.as_str()) {
            return Err(above_ceiling(
                &format!("segments[{i}]"),
                format!(
                    "your organization lets a connector carry only {}",
                    ceiling.segments.join(", ")
                ),
            ));
        }
    }
    Ok(())
}

fn validate_scope(new: &NewConnector) -> Result<(), ApiError> {
    if new.scope.is_empty() || new.scope.len() > MAX_SCOPE {
        return Err(invalid("scope", format!("scope names 1 to {MAX_SCOPE} items, e.g. {{\"project\": \"doprava\", \"access\": \"read\"}}")));
    }
    for (i, item) in new.scope.iter().enumerate() {
        if !is_dns1123(&item.project) {
            return Err(invalid(
                &format!("scope[{i}].project"),
                format!("'{}' is not a project name", item.project),
            ));
        }
        let named = [
            ("space", &item.space),
            ("endpoint", &item.endpoint),
            ("pipeline", &item.pipeline),
        ];
        if named.iter().filter(|(_, v)| v.is_some()).count() > 1 {
            return Err(invalid(
                &format!("scope[{i}]"),
                "a scope item names at most one of space, endpoint, pipeline".into(),
            ));
        }
        for (field, value) in named {
            if let Some(value) = value.as_deref().filter(|v| *v != "*" && !is_dns1123(v)) {
                return Err(invalid(
                    &format!("scope[{i}].{field}"),
                    format!("'{value}' is neither a name nor *"),
                ));
            }
        }
        if item.access == ItemAccess::Write && !new.writes {
            return Err(invalid(
                &format!("scope[{i}].access"),
                "a write item needs writes: true".into(),
            ));
        }
    }
    Ok(())
}

/// A `personalData` tick needs a ceiling that allows it (AG-158).
fn validate_personal(scope: &[ScopeItem], ceiling: &Ceiling) -> Result<(), ApiError> {
    match scope.iter().position(|item| item.personal_data) {
        Some(i) if !ceiling.personal_data => Err(above_ceiling(
            &format!("scope[{i}].personalData"),
            "your organization keeps the attributes a model marks personalData out of AI connector answers; untick it, or ask an organization admin for a DelegationPolicy that allows it".into(),
        )),
        _ => Ok(()),
    }
}

fn validate_clients(clients: &[String]) -> Result<(), ApiError> {
    if clients.len() > MAX_CLIENTS {
        return Err(invalid(
            "allowedClients",
            format!("at most {MAX_CLIENTS} clients"),
        ));
    }
    for (i, client) in clients.iter().enumerate() {
        let plain = client
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-._:/".contains(&b));
        if client.is_empty() || client.len() > 512 || !plain {
            return Err(invalid(
                &format!("allowedClients[{i}]"),
                "a client is an OAuth client id: a realm client such as mcp-local or a CIMD https URL".into(),
            ));
        }
    }
    Ok(())
}

/// A connector as an organization administrator reads it (T-5975): its grant and how much it is
/// used, never what a call carried.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(as = ConnectorUsage)]
pub struct Overview {
    #[serde(flatten)]
    pub connector: Connector,
    /// Calls in the last 24 hours, allowed and refused.
    pub calls_per_day: i64,
    /// Refused calls in the last 24 hours.
    pub denials_per_day: i64,
    /// [`DENIALS_FLAG`] refused calls or more in the last 24 hours.
    pub flagged: bool,
}

impl Overview {
    fn of(connector: Connector, calls_per_day: i64, denials_per_day: i64) -> Self {
        Self {
            connector,
            calls_per_day,
            denials_per_day,
            flagged: denials_per_day >= DENIALS_FLAG,
        }
    }
}

fn refused(verdict: &str) -> bool {
    verdict.starts_with("refused")
}

/// One row of a connector's audit (AG-147).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(as = ConnectorCall)]
pub struct Call {
    #[schema(value_type = String, format = DateTime)]
    pub at: DateTime<Utc>,
    /// The Keycloak subject of the token, the owner's unless the call was refused for it.
    pub subject: String,
    pub client: Option<String>,
    /// The tool, or the MCP method of a call that names none.
    pub tool: String,
    /// `project/kind/name`, as far as the call names them.
    pub target: Option<String>,
    /// `allowed`, `refused: <why>` or `error`.
    pub verdict: String,
    pub duration_ms: i32,
}

/// The memory arm: the connectors, and each audit row beside its connector's id.
type Held = (Vec<Record>, Vec<(String, Call)>);
type CallRow = (
    Odt,
    String,
    Option<String>,
    String,
    Option<String>,
    String,
    i32,
);

enum Inner {
    Postgres(sqlx::PgPool),
    Memory(Mutex<Held>),
}

pub struct ConnectorStore {
    inner: Inner,
}

type Odt = time::OffsetDateTime;
type OverviewRow = (
    String,
    String,
    String,
    sqlx::types::Json<GrantDoc>,
    Odt,
    Option<Odt>,
    Option<Odt>,
    i64,
    i64,
);
type Row = (
    String,
    String,
    String,
    sqlx::types::Json<GrantDoc>,
    Odt,
    Option<Odt>,
    Option<Odt>,
);
macro_rules! columns {
    () => {
        "id, owner, name, grant_doc, created_at, last_used_at, revoked_at"
    };
}

fn record((id, owner, name, grant, created_at, last_used_at, revoked_at): Row) -> Record {
    Record {
        id,
        owner,
        name,
        grant: grant.0,
        created_at: odt_to_chrono(created_at),
        last_used_at: last_used_at.map(odt_to_chrono),
        revoked_at: revoked_at.map(odt_to_chrono),
    }
}

fn db_error(err: sqlx::Error) -> ApiError {
    ApiError::Internal(format!("the connector store failed: {err}"))
}

fn full(owner_has: usize) -> Result<(), ApiError> {
    if owner_has >= MAX_PER_PERSON {
        return Err(ApiError::Conflict(format!(
            "you hold {MAX_PER_PERSON} live connectors already; revoke one first"
        )));
    }
    Ok(())
}

fn taken(name: &str) -> ApiError {
    ApiError::Conflict(format!("you hold a live connector named {name} already"))
}

impl ConnectorStore {
    pub fn new(db: Option<sqlx::PgPool>) -> Self {
        Self {
            inner: match db {
                Some(pool) => Inner::Postgres(pool),
                None => Inner::Memory(Mutex::default()),
            },
        }
    }

    fn memory(rows: &Mutex<Held>) -> std::sync::MutexGuard<'_, Held> {
        rows.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Keeps a validated connector for `owner`; at most [`MAX_PER_PERSON`] live ones, one name each.
    pub async fn create(
        &self,
        owner: &str,
        new: NewConnector,
        base: &str,
    ) -> Result<Connector, ApiError> {
        let now = Utc::now();
        let record = Record {
            id: new_id(),
            owner: owner.to_owned(),
            name: new.name,
            grant: GrantDoc {
                segments: new.segments,
                scope: new.scope,
                writes: new.writes,
                expires_at: new.expires_at,
                allowed_clients: new.allowed_clients,
            },
            created_at: now,
            last_used_at: None,
            revoked_at: None,
        };
        match &self.inner {
            Inner::Postgres(pool) => {
                let mut tx = pool.begin().await.map_err(db_error)?;
                // One person's creates in a row, so two at once cannot both pass the count.
                sqlx::query("SELECT pg_advisory_xact_lock(hashtext('connectors/' || $1))")
                    .bind(owner)
                    .execute(&mut *tx)
                    .await
                    .map_err(db_error)?;
                let (live,): (i64,) = sqlx::query_as(
                    "SELECT count(*) FROM connectors WHERE owner = $1 AND revoked_at IS NULL",
                )
                .bind(owner)
                .fetch_one(&mut *tx)
                .await
                .map_err(db_error)?;
                full(usize::try_from(live).unwrap_or(usize::MAX))?;
                let inserted = sqlx::query(
                    "INSERT INTO connectors (id, owner, name, grant_doc, created_at) VALUES ($1, $2, $3, $4, $5) \
                     ON CONFLICT DO NOTHING",
                )
                .bind(&record.id)
                .bind(owner)
                .bind(&record.name)
                .bind(sqlx::types::Json(&record.grant))
                .bind(chrono_to_odt(now))
                .execute(&mut *tx)
                .await
                .map_err(db_error)?;
                if inserted.rows_affected() == 0 {
                    return Err(taken(&record.name));
                }
                tx.commit().await.map_err(db_error)?;
            }
            Inner::Memory(rows) => {
                let mut rows = Self::memory(rows);
                let live: Vec<&Record> = rows
                    .0
                    .iter()
                    .filter(|r| r.owner == owner && r.revoked_at.is_none())
                    .collect();
                full(live.len())?;
                if live.iter().any(|r| r.name == record.name) {
                    return Err(taken(&record.name));
                }
                rows.0.push(record.clone());
            }
        }
        Ok(record.view(base, now))
    }

    /// Replaces the grant of the owner's connector `id` that is not revoked (an expired one
    /// lives again under a new `expiresAt`); `false` when there is none. The name stays.
    pub async fn update(&self, id: &str, owner: &str, new: NewConnector) -> Result<bool, ApiError> {
        let grant = GrantDoc {
            segments: new.segments,
            scope: new.scope,
            writes: new.writes,
            expires_at: new.expires_at,
            allowed_clients: new.allowed_clients,
        };
        match &self.inner {
            Inner::Postgres(pool) => {
                let done = sqlx::query(
                    "UPDATE connectors SET grant_doc = $3 WHERE id = $1 AND owner = $2 AND revoked_at IS NULL",
                )
                .bind(id)
                .bind(owner)
                .bind(sqlx::types::Json(&grant))
                .execute(pool)
                .await
                .map_err(db_error)?;
                Ok(done.rows_affected() == 1)
            }
            Inner::Memory(rows) => {
                let mut rows = Self::memory(rows);
                let found = rows
                    .0
                    .iter_mut()
                    .find(|r| r.id == id && r.owner == owner && r.revoked_at.is_none());
                Ok(found.map(|r| r.grant = grant).is_some())
            }
        }
    }

    /// The connector `id`, whoever owns it: the caller compares the owner.
    pub async fn get(&self, id: &str, base: &str) -> Result<Option<Connector>, ApiError> {
        let now = Utc::now();
        match &self.inner {
            Inner::Postgres(pool) => {
                let row: Option<Row> = sqlx::query_as(concat!(
                    "SELECT ",
                    columns!(),
                    " FROM connectors WHERE id = $1"
                ))
                .bind(id)
                .fetch_optional(pool)
                .await
                .map_err(db_error)?;
                Ok(row.map(|row| record(row).view(base, now)))
            }
            Inner::Memory(rows) => Ok(Self::memory(rows)
                .0
                .iter()
                .find(|r| r.id == id)
                .map(|r| r.view(base, now))),
        }
    }

    /// The owner's connectors, newest first, revoked ones included.
    pub async fn of_owner(&self, owner: &str, base: &str) -> Result<Vec<Connector>, ApiError> {
        let now = Utc::now();
        match &self.inner {
            Inner::Postgres(pool) => {
                let rows: Vec<Row> = sqlx::query_as(concat!(
                    "SELECT ",
                    columns!(),
                    " FROM connectors WHERE owner = $1 ORDER BY created_at DESC LIMIT 200"
                ))
                .bind(owner)
                .fetch_all(pool)
                .await
                .map_err(db_error)?;
                Ok(rows
                    .into_iter()
                    .map(|row| record(row).view(base, now))
                    .collect())
            }
            Inner::Memory(rows) => Ok(Self::memory(rows)
                .0
                .iter()
                .rev()
                .filter(|r| r.owner == owner)
                .map(|r| r.view(base, now))
                .collect()),
        }
    }

    /// Revokes the owner's live connector `id`; `false` when there is none to revoke.
    pub async fn revoke(&self, id: &str, owner: &str) -> Result<bool, ApiError> {
        match &self.inner {
            Inner::Postgres(pool) => {
                let done = sqlx::query(
                    "UPDATE connectors SET revoked_at = now() WHERE id = $1 AND owner = $2 AND revoked_at IS NULL",
                )
                .bind(id)
                .bind(owner)
                .execute(pool)
                .await
                .map_err(db_error)?;
                Ok(done.rows_affected() == 1)
            }
            Inner::Memory(rows) => {
                let mut rows = Self::memory(rows);
                let found = rows
                    .0
                    .iter_mut()
                    .find(|r| r.id == id && r.owner == owner && r.revoked_at.is_none());
                Ok(found.map(|r| r.revoked_at = Some(Utc::now())).is_some())
            }
        }
    }

    /// Every connector of the organization with its last day's calls and denials, live ones first
    /// and then newest first, at most `OVERVIEW_PAGE` (T-5975).
    pub async fn overview(&self, base: &str) -> Result<Vec<Overview>, ApiError> {
        let now = Utc::now();
        match &self.inner {
            Inner::Postgres(pool) => {
                let rows: Vec<OverviewRow> = sqlx::query_as(concat!(
                    "SELECT ",
                    columns!(),
                    ", (SELECT count(*) FROM connector_calls k WHERE k.connector = connectors.id \
                       AND k.at > now() - interval '1 day'), \
                     (SELECT count(*) FROM connector_calls k WHERE k.connector = connectors.id \
                       AND k.at > now() - interval '1 day' AND k.verdict LIKE 'refused%') \
                     FROM connectors ORDER BY revoked_at IS NULL DESC, created_at DESC LIMIT $1"
                ))
                .bind(OVERVIEW_PAGE)
                .fetch_all(pool)
                .await
                .map_err(db_error)?;
                Ok(rows
                    .into_iter()
                    .map(
                        |(id, owner, name, grant, created, used, revoked, calls, denials)| {
                            let row = (id, owner, name, grant, created, used, revoked);
                            Overview::of(record(row).view(base, now), calls, denials)
                        },
                    )
                    .collect())
            }
            Inner::Memory(rows) => {
                let rows = Self::memory(rows);
                let since = now - Duration::days(1);
                let mut records: Vec<&Record> = rows.0.iter().rev().collect();
                records.sort_by_key(|r| r.revoked_at.is_some());
                Ok(records
                    .into_iter()
                    .take(usize::try_from(OVERVIEW_PAGE).unwrap_or(500))
                    .map(|r| {
                        let day = || rows.1.iter().filter(|(id, c)| *id == r.id && c.at > since);
                        let calls = i64::try_from(day().count()).unwrap_or(i64::MAX);
                        let denials = day().filter(|(_, c)| refused(&c.verdict)).count();
                        Overview::of(
                            r.view(base, now),
                            calls,
                            i64::try_from(denials).unwrap_or(i64::MAX),
                        )
                    })
                    .collect())
            }
        }
    }

    /// Revokes every live connector of `owner`, as offboarding does (T-5975): how many it revoked.
    pub async fn revoke_all(&self, owner: &str) -> Result<u64, ApiError> {
        match &self.inner {
            Inner::Postgres(pool) => Ok(sqlx::query(
                "UPDATE connectors SET revoked_at = now() WHERE owner = $1 AND revoked_at IS NULL",
            )
            .bind(owner)
            .execute(pool)
            .await
            .map_err(db_error)?
            .rows_affected()),
            Inner::Memory(rows) => {
                let now = Utc::now();
                let mut rows = Self::memory(rows);
                let mut done = 0;
                for r in rows
                    .0
                    .iter_mut()
                    .filter(|r| r.owner == owner && r.revoked_at.is_none())
                {
                    r.revoked_at = Some(now);
                    done += 1;
                }
                Ok(done)
            }
        }
    }

    /// Keeps one audit row; an allowed call also marks the connector used.
    pub async fn record(&self, connector: &str, call: Call) -> Result<(), ApiError> {
        let used = call.verdict == "allowed";
        match &self.inner {
            Inner::Postgres(pool) => {
                sqlx::query(
                    "INSERT INTO connector_calls (connector, at, subject, client, tool, target, verdict, duration_ms) \
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
                )
                .bind(connector)
                .bind(chrono_to_odt(call.at))
                .bind(&call.subject)
                .bind(&call.client)
                .bind(&call.tool)
                .bind(&call.target)
                .bind(&call.verdict)
                .bind(call.duration_ms)
                .execute(pool)
                .await
                .map_err(db_error)?;
                sqlx::query(
                    "DELETE FROM connector_calls WHERE connector = $1 AND at < now() - make_interval(days => $2)",
                )
                .bind(connector)
                .bind(i32::try_from(CALLS_KEPT_DAYS).unwrap_or(30))
                .execute(pool)
                .await
                .map_err(db_error)?;
                if used {
                    sqlx::query("UPDATE connectors SET last_used_at = $2 WHERE id = $1")
                        .bind(connector)
                        .bind(chrono_to_odt(call.at))
                        .execute(pool)
                        .await
                        .map_err(db_error)?;
                }
            }
            Inner::Memory(rows) => {
                let mut rows = Self::memory(rows);
                if used {
                    if let Some(r) = rows.0.iter_mut().find(|r| r.id == connector) {
                        r.last_used_at = Some(call.at);
                    }
                }
                let oldest = call.at - Duration::days(CALLS_KEPT_DAYS);
                rows.1.retain(|(_, c)| c.at >= oldest);
                rows.1.push((connector.to_owned(), call));
            }
        }
        Ok(())
    }

    /// The connector's newest audit rows first, at most [`CALLS_PAGE`].
    pub async fn calls(&self, connector: &str) -> Result<Vec<Call>, ApiError> {
        match &self.inner {
            Inner::Postgres(pool) => {
                let rows: Vec<CallRow> =
                    sqlx::query_as(
                        "SELECT at, subject, client, tool, target, verdict, duration_ms FROM connector_calls \
                         WHERE connector = $1 ORDER BY at DESC, id DESC LIMIT $2",
                    )
                    .bind(connector)
                    .bind(CALLS_PAGE)
                    .fetch_all(pool)
                    .await
                    .map_err(db_error)?;
                Ok(rows
                    .into_iter()
                    .map(
                        |(at, subject, client, tool, target, verdict, duration_ms)| Call {
                            at: odt_to_chrono(at),
                            subject,
                            client,
                            tool,
                            target,
                            verdict,
                            duration_ms,
                        },
                    )
                    .collect())
            }
            Inner::Memory(rows) => Ok(Self::memory(rows)
                .1
                .iter()
                .rev()
                .filter(|(id, _)| id == connector)
                .take(usize::try_from(CALLS_PAGE).unwrap_or(200))
                .map(|(_, call)| call.clone())
                .collect()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn op(name: &str) -> &'static Operation {
        crate::ops::find(name).expect("registered")
    }

    fn item(project: &str, endpoint: Option<&str>) -> ScopeItem {
        ScopeItem {
            project: project.into(),
            space: None,
            endpoint: endpoint.map(str::to_owned),
            pipeline: None,
            access: ItemAccess::Read,
            personal_data: false,
        }
    }

    fn connector(segments: &[&str], scope: Vec<ScopeItem>) -> Connector {
        Record {
            id: new_id(),
            owner: "sub-jana".into(),
            name: "c".into(),
            grant: GrantDoc {
                segments: segments.iter().map(|s| (*s).to_owned()).collect(),
                scope,
                writes: false,
                expires_at: Utc::now() + Duration::days(1),
                allowed_clients: vec![],
            },
            created_at: Utc::now(),
            last_used_at: None,
            revoked_at: None,
        }
        .view("https://portal.test", Utc::now())
    }

    /// T-5956, AG-149: a segment that proposes plans; only `writes` brings the apply, and an
    /// apply needs `write` on the item; a plan stays within the segments' kinds and the scope.
    #[test]
    fn a_plan_is_held_to_the_scope_and_an_apply_to_the_writes_switch() {
        let mut c = connector(&["context"], vec![item("doprava", None)]);
        let access = c.access();
        assert!(access.names(op(PLAN)));
        assert!(!access.names(op(APPLY)), "writes off: no apply");
        assert_eq!(c.may_change("doprava", "DataModel", "bikes", false), Ok(()));
        assert!(c
            .may_change("doprava", "DataModel", "bikes", true)
            .expect_err("writes off")
            .contains("writes off"));
        assert!(c
            .may_change("doprava", "Pipeline", "p", false)
            .expect_err("not a context kind")
            .contains("not Pipeline"));
        assert!(c.may_change("other", "DataModel", "bikes", false).is_err());
        c.writes = true;
        assert!(c.access().names(op(APPLY)));
        assert!(c
            .may_change("doprava", "DataModel", "bikes", true)
            .expect_err("read item")
            .contains("only reads"));
        c.scope[0].access = ItemAccess::Write;
        assert_eq!(c.may_change("doprava", "DataModel", "bikes", true), Ok(()));
        // A data-read connector plans nothing.
        let read = connector(&["data-read"], vec![item("doprava", None)]);
        assert!(!read.access().names(op(PLAN)));
        // Narrowed to one Endpoint: that Endpoint alone.
        let narrow = connector(&["context"], vec![item("doprava", Some("counters"))]);
        assert!(narrow.lists(op(PLAN), "doprava"));
        assert_eq!(
            narrow.may_change("doprava", "Endpoint", "counters", false),
            Ok(())
        );
        assert!(narrow
            .may_change("doprava", "Endpoint", "other", false)
            .is_err());
    }

    fn new(segments: &[&str], writes: bool, days: i64) -> NewConnector {
        NewConnector {
            name: "doprava-in-claude".into(),
            segments: segments.iter().map(|s| (*s).to_owned()).collect(),
            scope: vec![item("doprava", None)],
            writes,
            expires_at: Utc::now() + Duration::days(days),
            allowed_clients: vec![],
        }
    }

    #[test]
    fn every_preset_lists_registered_read_only_tools_snapshot() {
        let listed = |segment: &str| -> Vec<&'static str> {
            let c = connector(&[segment], vec![item("doprava", None)]);
            let access = c.access();
            crate::ops::registry()
                .iter()
                .filter(|op| access.names(op))
                .map(|op| op.name)
                .collect()
        };
        for (segment, tools, _) in SEGMENTS {
            for tool in *tools {
                let op = op(tool);
                // The plan saves nothing but is offered only to who may propose (T-5956).
                assert!(
                    op.annotations.read_only_hint || op.name == PLAN,
                    "{segment}: {tool} is not read-only"
                );
            }
            let mut want: Vec<&str> = tools.to_vec();
            want.sort_unstable();
            let mut got = listed(segment);
            got.sort_unstable();
            assert_eq!(got, want, "{segment}");
        }
        // The snapshot of the default preset, so a change to it is a reviewed diff.
        let mut data_read = listed("data-read");
        data_read.sort_unstable();
        assert_eq!(
            data_read,
            [
                "jc_data_query",
                "jc_kpi_compute",
                "jc_resource_get",
                "jc_resource_list",
                "jc_schema_get"
            ]
        );
        // admin is every segment, and still no write, approval or cross-project tool.
        let admin = listed(ADMIN);
        for absent in [
            "jc_resource_propose",
            "jc_change_approve",
            "jc_person_list",
            "jc_endpoint_list_all",
        ] {
            assert!(!admin.contains(&absent), "admin lists {absent}");
        }
    }

    #[test]
    fn a_call_is_held_to_the_project_the_kind_and_the_named_object() {
        let whole = connector(&["data-read"], vec![item("doprava", None)]);
        let get = op("jc_resource_get");
        let list = op("jc_resource_list");
        assert_eq!(
            whole.admits(list, "doprava", &json!({ "kind": "Endpoint" })),
            Ok(())
        );
        let err = whole
            .admits(list, "air", &json!({ "kind": "Endpoint" }))
            .expect_err("other project");
        assert!(err.contains("does not reach project air"), "{err}");
        // data-read reads no Role, whatever the person may read.
        let err = whole
            .admits(get, "doprava", &json!({ "kind": "Role", "name": "x" }))
            .expect_err("kind");
        assert!(err.contains("read only"), "{err}");

        let narrow = connector(&["data-read"], vec![item("doprava", Some("counters"))]);
        let named = json!({ "kind": "Endpoint", "name": "counters" });
        assert_eq!(narrow.admits(get, "doprava", &named), Ok(()));
        let err = narrow
            .admits(
                get,
                "doprava",
                &json!({ "kind": "Endpoint", "name": "parking" }),
            )
            .expect_err("unticked Endpoint");
        assert!(err.contains("does not reach Endpoint parking"), "{err}");
        // A list cannot be held to the named Endpoints, so a narrowed project refuses it and
        // tools/list does not offer it.
        assert!(narrow
            .admits(list, "doprava", &json!({ "kind": "Endpoint" }))
            .is_err());
        assert!(!narrow.lists(list, "doprava"));
        assert!(narrow.lists(get, "doprava"));
        assert!(narrow.lists(op("jc_kpi_compute"), "doprava"));
        // query_data names its Endpoint by `endpoint`: the ticked one reads, another is refused.
        let query = op("jc_data_query");
        assert!(narrow.lists(query, "doprava"));
        assert_eq!(
            narrow.admits(query, "doprava", &json!({ "endpoint": "counters" })),
            Ok(())
        );
        let err = narrow
            .admits(query, "doprava", &json!({ "endpoint": "parking" }))
            .expect_err("unticked Endpoint");
        assert!(err.contains("does not reach Endpoint parking"), "{err}");
        assert!(narrow.admits(query, "doprava", &json!({})).is_err());
        assert!(!narrow.lists(get, "air"));
        assert_eq!(
            narrow.admits(
                op("jc_schema_get"),
                "doprava",
                &json!({ "kind": "Endpoint" })
            ),
            Ok(())
        );
        // A DataModel is no object a narrowed item names.
        assert!(narrow
            .admits(
                get,
                "doprava",
                &json!({ "kind": "DataModel", "name": "counters" })
            )
            .is_err());
        let star = connector(&["data-read"], vec![item("doprava", Some("*"))]);
        assert_eq!(
            star.admits(
                get,
                "doprava",
                &json!({ "kind": "Endpoint", "name": "any" })
            ),
            Ok(())
        );
    }

    #[test]
    fn the_default_ceiling_refuses_more_than_data_read_for_thirty_days() {
        let now = Utc::now();
        assert!(validate(&new(&["data-read"], false, 29), &DEFAULT_CEILING, now).is_ok());
        let denied = |n: NewConnector, field: &str| match validate(&n, &DEFAULT_CEILING, now) {
            Err(ApiError::Denied(why)) => assert!(why.starts_with(field), "{why}"),
            other => panic!("{field}: {other:?}"),
        };
        denied(new(&["pipeline"], false, 1), "segments[0]");
        denied(new(&["data-read"], true, 1), "writes");
        denied(new(&["data-read"], false, 31), "expiresAt");
        let invalid = |n: NewConnector, field: &str| match validate(&n, &DEFAULT_CEILING, now) {
            Err(ApiError::Invalid { errors, .. }) => assert_eq!(errors, vec![field.to_owned()]),
            other => panic!("{field}: {other:?}"),
        };
        invalid(new(&["everything"], false, 1), "segments[0]");
        invalid(new(&[], false, 1), "segments");
        invalid(new(&["data-read"], false, -1), "expiresAt");
        let mut bad = new(&["data-read"], false, 1);
        bad.name = "Doprava In Claude".into();
        invalid(bad, "name");
        let mut bad = new(&["data-read"], false, 1);
        bad.scope = vec![];
        invalid(bad, "scope");
        let mut bad = new(&["data-read"], false, 1);
        bad.scope[0].endpoint = Some("a".into());
        bad.scope[0].space = Some("b".into());
        invalid(bad, "scope[0]");
        let mut bad = new(&["data-read"], false, 1);
        bad.scope[0].access = ItemAccess::Write;
        invalid(bad, "scope[0].access");
        let mut bad = new(&["data-read"], false, 1);
        bad.allowed_clients = vec!["evil\nclient".into()];
        invalid(bad, "allowedClients[0]");
    }

    #[test]
    fn a_personal_data_tick_needs_a_ceiling_that_allows_it() {
        let now = Utc::now();
        let mut ticked = new(&["data-read"], false, 1);
        ticked.scope[0].personal_data = true;
        match validate(&ticked, &DEFAULT_CEILING, now) {
            Err(ApiError::Denied(why)) => {
                assert!(why.starts_with("scope[0].personalData"), "{why}")
            }
            other => panic!("{other:?}"),
        }
        let allows = Ceiling {
            personal_data: true,
            ..DEFAULT_CEILING
        };
        assert!(validate(&ticked, &allows, now).is_ok());
    }

    #[test]
    fn personal_attributes_show_only_through_a_ticked_item_that_reaches_the_endpoint() {
        let ticked = |endpoint: Option<&str>| ScopeItem {
            personal_data: true,
            ..item("doprava", endpoint)
        };
        let args = |endpoint: &str| json!({ "project": "doprava", "endpoint": endpoint });
        let plain = connector(&["data-read"], vec![item("doprava", None)]);
        assert!(!plain.shows_personal("doprava", &args("hlasenia")));
        let whole = connector(&["data-read"], vec![ticked(None)]);
        assert!(whole.shows_personal("doprava", &args("hlasenia")));
        assert!(!whole.shows_personal("skolstvo", &args("hlasenia")));
        let one = connector(
            &["data-read"],
            vec![ticked(Some("hlasenia")), item("doprava", Some("scitace"))],
        );
        assert!(one.shows_personal("doprava", &args("hlasenia")));
        assert!(!one.shows_personal("doprava", &args("scitace")));
        assert!(!one.shows_personal("doprava", &json!({ "project": "doprava" })));
        let space = connector(
            &["data-read"],
            vec![ScopeItem {
                space: Some("doprava".into()),
                ..ticked(None)
            }],
        );
        assert!(!space.shows_personal("doprava", &args("hlasenia")));
    }

    #[test]
    fn only_published_vendor_clients_bind() {
        assert!(binds("https://claude.ai/oauth/mcp-client-metadata"));
        assert!(binds("https://chatgpt.com/connector/oauth/client.json"));
        assert!(!binds(
            "https://claude.ai/oauth/claude-code-client-metadata"
        ));
        assert!(!binds("mcp-local"));
        assert!(!binds("http://claude.ai/x"));
        assert!(!binds("https://claude.ai.evil.example/x"));
    }

    #[test]
    fn ids_are_26_base32_characters() {
        let id = new_id();
        assert!(is_id(&id), "{id}");
        assert_ne!(id, new_id());
        assert!(!is_id("ABCDEFGHIJKLMNOPQRSTUVWXYZ"));
        assert!(!is_id("a"));
        assert!(!is_id("abcdefghijklmnopqrstuvwxy1"));
    }

    #[test]
    fn an_expired_or_revoked_connector_is_no_longer_active() {
        let mut record = Record {
            id: new_id(),
            owner: "o".into(),
            name: "n".into(),
            grant: GrantDoc {
                segments: vec!["data-read".into()],
                scope: vec![item("doprava", None)],
                writes: false,
                expires_at: Utc::now() - Duration::seconds(1),
                allowed_clients: vec![],
            },
            created_at: Utc::now(),
            last_used_at: None,
            revoked_at: None,
        };
        let view = record.view("https://portal.test/", Utc::now());
        assert_eq!((view.state.as_str(), view.is_active()), ("expired", false));
        assert_eq!(view.url, format!("https://portal.test/c/{}", record.id));
        record.revoked_at = Some(Utc::now());
        assert_eq!(
            record.view("https://portal.test", Utc::now()).state,
            "revoked"
        );
    }

    #[tokio::test]
    async fn the_memory_store_keeps_twenty_live_connectors_one_name_each_and_their_calls() {
        let store = ConnectorStore::new(None);
        let base = "https://portal.test";
        let mut first = None;
        for n in 0..MAX_PER_PERSON {
            let mut ask = new(&["data-read"], false, 1);
            ask.name = format!("c{n}");
            let made = store.create("jana", ask, base).await.expect("created");
            first.get_or_insert(made.id);
        }
        let mut ask = new(&["data-read"], false, 1);
        ask.name = "one-more".into();
        assert!(matches!(
            store.create("jana", ask, base).await,
            Err(ApiError::Conflict(_))
        ));
        // Another person has their own twenty; a revoke frees a place and keeps the record.
        let mut ask = new(&["data-read"], false, 1);
        ask.name = "c0".into();
        assert!(store.create("petra", ask, base).await.is_ok());
        let first = first.expect("one made");
        assert!(
            !store.revoke(&first, "petra").await.expect("revoke"),
            "not petra's"
        );
        assert!(store.revoke(&first, "jana").await.expect("revoke"));
        assert!(!store.revoke(&first, "jana").await.expect("revoke"), "once");
        let mut ask = new(&["data-read"], false, 1);
        ask.name = "c0".into();
        assert!(
            store.create("jana", ask, base).await.is_ok(),
            "the name of a revoked one is free"
        );
        assert_eq!(
            store.of_owner("jana", base).await.expect("list").len(),
            MAX_PER_PERSON + 1
        );

        let call = |verdict: &str| Call {
            at: Utc::now(),
            subject: "jana".into(),
            client: Some("mcp-local".into()),
            tool: "tools/list".into(),
            target: None,
            verdict: verdict.into(),
            duration_ms: 3,
        };
        store.record(&first, call("allowed")).await.expect("kept");
        store
            .record(&first, call("refused: revoked"))
            .await
            .expect("kept");
        let calls = store.calls(&first).await.expect("calls");
        assert_eq!(
            calls.iter().map(|c| c.verdict.as_str()).collect::<Vec<_>>(),
            ["refused: revoked", "allowed"]
        );
        let used = store.get(&first, base).await.expect("get").expect("there");
        assert!(used.last_used_at.is_some());
    }

    /// T-5975: offboarding revokes every live connector of one person and nobody else's; the
    /// overview lists live ones first, then the revoked.
    #[tokio::test]
    async fn revoke_all_ends_one_persons_connectors_and_the_overview_lists_live_first() {
        let store = ConnectorStore::new(None);
        for (owner, name) in [("jana", "a"), ("jana", "b"), ("petra", "c")] {
            let mut ask = new(&["data-read"], false, 1);
            ask.name = name.into();
            store.create(owner, ask, "").await.expect("created");
        }
        assert_eq!(store.revoke_all("jana").await.expect("revoked"), 2);
        assert_eq!(store.revoke_all("jana").await.expect("again"), 0);
        let listed = store.overview("").await.expect("overview");
        let rows: Vec<(&str, &str)> = listed
            .iter()
            .map(|o| (o.connector.name.as_str(), o.connector.state.as_str()))
            .collect();
        assert_eq!(rows, [("c", "active"), ("b", "revoked"), ("a", "revoked")]);
    }
}
