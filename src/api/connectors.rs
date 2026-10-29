//! `/api/v1/connectors`: a person's own connectors (AG-142, AG-147, API/14 §2, T-5950).
//!
//! Scoped by the caller's Keycloak `sub`: another person's connector answers the same `404` as
//! an id that does not exist. A connector's own token is not a token for these routes (its
//! audience is `/c/{id}`), so no connector creates, widens or revokes a connector (AG-151); a
//! workload's account is refused too, since a connector is a person's grant.

use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::auth::session::Identity;
use crate::auth::CurrentUser;
use crate::connectors::{self, Call, Ceiling, Connector, NewConnector};
use crate::error::{ApiError, ProblemDetails};
use crate::permissions::ORG_NAMESPACE;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/connectors", get(list_connectors).post(create_connector))
        .route("/connectors/options", get(connector_options))
        .route(
            "/connectors/{id}",
            get(get_connector)
                .patch(edit_connector)
                .delete(revoke_connector),
        )
        .route("/connectors/{id}/activity", get(connector_activity))
        .route("/connectors/pending", get(pending_connectors))
        .route("/connectors/{id}/approve", post(approve_connector))
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ConnectorList {
    pub items: Vec<Connector>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ConnectorCalls {
    pub items: Vec<Call>,
}

/// What the caller may put in a connector today: the ceiling, and per project they read the
/// spaces, Endpoints and pipelines they read there (the "My connectors" tree, T-5951).
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorOptions {
    /// Every preset a connector may name; those outside `ceiling.segments` need approval.
    pub segments: Vec<String>,
    pub ceiling: CeilingView,
    pub projects: Vec<ProjectReach>,
    /// The realm's MCP clients a connector may be bound to, e.g. `mcp-local` (Claude Code).
    pub clients: Vec<ClientChoice>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ClientChoice {
    pub id: String,
    /// Whether naming it binds the connector (a published client id) or only says whom it is
    /// meant for (a loopback client anyone can name, AG-153).
    pub is_boundary: bool,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CeilingView {
    /// The presets a connector of the caller may carry, e.g. `["data-read"]`.
    pub segments: Vec<String>,
    /// Whether a connector of the caller may hold a write item.
    pub writes: bool,
    /// The longest life a connector may get, in days.
    pub max_days: i64,
}

/// One project the caller reads, with the objects of it they read, in name order.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectReach {
    pub project: String,
    pub spaces: Vec<String>,
    pub endpoints: Vec<String>,
    pub pipelines: Vec<String>,
}

/// The fields of a connector its owner may change (JSON merge patch, API/14 §2); the name stays.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectorPatch {
    #[serde(default)]
    pub segments: Option<Vec<String>>,
    #[serde(default)]
    pub scope: Option<Vec<connectors::ScopeItem>>,
    #[serde(default)]
    pub writes: Option<bool>,
    /// RFC 3339, e.g. `2026-11-27T00:00:00Z`.
    #[serde(default)]
    #[schema(value_type = Option<String>, format = DateTime)]
    pub expires_at: Option<chrono::DateTime<chrono::Utc>>,
    #[serde(default)]
    pub allowed_clients: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, IntoParams)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateParams {
    /// `All` validates only: nothing is kept.
    #[serde(default)]
    pub dry_run: Option<String>,
}

pub(crate) fn base(state: &AppState) -> String {
    state
        .config
        .public_base_url
        .as_str()
        .trim_end_matches('/')
        .to_owned()
}

fn not_found() -> ApiError {
    ApiError::NotFound("no such connector".into())
}

/// A connector is a person's grant; a workload's account holds none.
fn person(state: &AppState, identity: &Identity) -> Result<(), ApiError> {
    // Keycloak names a client's own user `service-account-<client>`, and a token naming no
    // user at all is its client's: either is a workload's even where no ServiceAccount
    // manifest claims it.
    let workload = identity.username.starts_with("service-account-")
        || identity.client.as_deref() == Some(identity.username.as_str());
    if workload || crate::permissions::is_service_account(&state.mirror, identity) {
        return Err(ApiError::Denied(
            "a connector is a person's grant; a service account holds none (AG-142)".into(),
        ));
    }
    Ok(())
}

/// The caller's connector `id`, or the one answer for every other case.
async fn own(state: &AppState, identity: &Identity, id: &str) -> Result<Connector, ApiError> {
    if !connectors::is_id(id) {
        return Err(not_found());
    }
    match state.connectors.get(id, &base(state)).await? {
        Some(c) if c.owner == identity.subject => {
            Ok(marked(c, &Ceiling::of(&state.mirror, identity)))
        }
        _ => Err(not_found()),
    }
}

/// The "narrowed by policy" marks of a live connector: what its owner's ceiling takes away today.
fn marked(mut connector: Connector, ceiling: &Ceiling) -> Connector {
    if connector.is_active() && !ceiling.honours(&connector) {
        connector.narrowed_by = ceiling.narrowing(&connector);
    }
    connector
}

/// The owner's half of a new connector: each scope item is in a project they read today, and a
/// named object exists there (AG-150: a connector never reaches past its owner).
fn reachable(state: &AppState, identity: &Identity, new: &NewConnector) -> Result<(), ApiError> {
    for (i, item) in new.scope.iter().enumerate() {
        let rights = crate::permissions::for_request(state, identity, &item.project);
        if !rights.may_read_project() {
            return Err(ApiError::Denied(format!(
                "scope[{i}].project: you hold no right in project {}, so a connector of yours cannot reach it",
                item.project
            )));
        }
        let named = [
            ("space", "ContextSpace", &item.space),
            ("endpoint", "Endpoint", &item.endpoint),
            ("pipeline", "Pipeline", &item.pipeline),
        ];
        for (field, kind, name) in named {
            let Some(name) = name.as_deref().filter(|n| *n != "*") else {
                continue;
            };
            // One answer for an object that is not there and one the owner may not read, so a
            // refusal tells nothing about what the owner cannot see.
            let readable = state
                .mirror
                .get(&item.project, kind, name)
                .is_some_and(|env| rights.may_read_envelope(kind, &env));
            if !readable {
                return Err(ApiError::Unprocessable {
                    detail: format!("project {} has no {kind} {name} you may read", item.project),
                    errors: vec![format!("scope[{i}].{field}")],
                });
            }
        }
    }
    Ok(())
}

#[utoipa::path(
    get,
    path = "/api/v1/connectors",
    summary = "List My Connectors",
    description = "The caller's connectors, newest first, revoked and expired ones included (API/14 §2).",
    tag = "connectors",
    responses(
        (status = 200, description = "The caller's connectors", body = ConnectorList),
        (status = 401, description = "Not signed in", body = ProblemDetails),
        (status = 403, description = "A service account holds no connector", body = ProblemDetails),
    )
)]
pub async fn list_connectors(
    user: CurrentUser,
    State(state): State<AppState>,
) -> Result<Json<ConnectorList>, ApiError> {
    let identity = &user.0.identity;
    person(&state, identity)?;
    let ceiling = Ceiling::of(&state.mirror, identity);
    let items = state
        .connectors
        .of_owner(&identity.subject, &base(&state))
        .await?
        .into_iter()
        .map(|c| marked(c, &ceiling))
        .collect();
    Ok(Json(ConnectorList { items }))
}

/// The names of `kind` in `project` the caller reads, in name order.
fn readable_names(
    state: &AppState,
    rights: &crate::permissions::Effective,
    project: &str,
    kind: &str,
) -> Vec<String> {
    state
        .mirror
        .list(project, kind, &crate::store::ListOptions::default())
        .items
        .into_iter()
        .filter(|env| rights.may_read_envelope(kind, env))
        .map(|env| env.metadata.name)
        .collect()
}

#[utoipa::path(
    get,
    path = "/api/v1/connectors/options",
    summary = "What My Connector May Reach",
    description = "The presets, the caller's ceiling and, per project the caller reads, the spaces, Endpoints and pipelines they read: what a new connector may name. Create checks every item again (T-5951, AG-150).",
    tag = "connectors",
    responses(
        (status = 200, description = "What a connector of the caller may name", body = ConnectorOptions),
        (status = 401, description = "Not signed in", body = ProblemDetails),
        (status = 403, description = "A service account holds no connector", body = ProblemDetails),
    )
)]
pub async fn connector_options(
    user: CurrentUser,
    State(state): State<AppState>,
) -> Result<Json<ConnectorOptions>, ApiError> {
    let identity = &user.0.identity;
    person(&state, identity)?;
    let ceiling = Ceiling::of(&state.mirror, identity);
    let projects = state
        .mirror
        .namespaces()
        .into_iter()
        .filter_map(|project| {
            let rights = crate::permissions::for_request(&state, identity, &project);
            rights.may_read_project().then(|| ProjectReach {
                spaces: readable_names(&state, &rights, &project, "ContextSpace"),
                endpoints: readable_names(&state, &rights, &project, "Endpoint"),
                pipelines: readable_names(&state, &rights, &project, "Pipeline"),
                project,
            })
        })
        .collect();
    let mut segments: Vec<String> = connectors::SEGMENTS
        .iter()
        .map(|(name, _, _)| (*name).to_owned())
        .collect();
    segments.push(connectors::ADMIN.to_owned());
    Ok(Json(ConnectorOptions {
        segments,
        ceiling: CeilingView {
            segments: ceiling.segments(),
            writes: ceiling.writes(),
            max_days: ceiling.max_days(),
        },
        projects,
        clients: state
            .config
            .connector_clients
            .iter()
            .map(|id| ClientChoice {
                id: id.clone(),
                is_boundary: connectors::binds(id),
            })
            .collect(),
    }))
}

#[utoipa::path(
    post,
    path = "/api/v1/connectors",
    summary = "Create a Connector",
    description = "Creates a connector of the caller: an MCP server at `/c/{id}` reaching only its scope, with the caller's own rights read again at every call. At most 20 live connectors per person (AG-142, API/14 §2).",
    tag = "connectors",
    params(CreateParams),
    request_body(
        content = NewConnector,
        content_type = "application/json",
        example = json!({ "name": "doprava-in-claude", "segments": ["data-read"],
                          "scope": [{ "project": "doprava", "endpoint": "bike-counters", "access": "read" }],
                          "expiresAt": "2026-11-27T00:00:00Z",
                          "allowedClients": ["https://claude.ai/oauth/mcp-client-metadata"] })
    ),
    responses(
        (status = 201, description = "Created: `active`, or `pending` when it asks above the caller's DelegationPolicy ceiling and that policy queues such requests (AG-150)", body = Connector),
        (status = 200, description = "dryRun=All: valid, nothing kept", body = Object),
        (status = 400, description = "A field out of shape; errors names it", body = ProblemDetails),
        (status = 401, description = "Not signed in", body = ProblemDetails),
        (status = 403, description = "Above the organization's ceiling, or a project the caller holds no right in; the detail names the field", body = ProblemDetails),
        (status = 409, description = "A live connector of that name, or 20 live ones already", body = ProblemDetails),
        (status = 422, description = "A scope item names an object the project lacks", body = ProblemDetails),
    )
)]
pub async fn create_connector(
    user: CurrentUser,
    State(state): State<AppState>,
    Query(params): Query<CreateParams>,
    body: Result<Json<NewConnector>, JsonRejection>,
) -> Result<Response, ApiError> {
    let identity = &user.0.identity;
    person(&state, identity)?;
    let Json(new) = body.map_err(|e| ApiError::BadRequest(e.body_text()))?;
    let ceiling = Ceiling::of(&state.mirror, identity);
    let above = connectors::validate(&new, &ceiling, chrono::Utc::now())?;
    reachable(&state, identity, &new)?;
    match params.dry_run.as_deref() {
        None => {}
        Some("All") => {
            return Ok(Json(serde_json::json!({
                "valid": true,
                "pending": !above.is_empty(),
                "aboveCeiling": above,
            }))
            .into_response());
        }
        Some(_) => {
            return Err(ApiError::Invalid {
                detail: "dryRun takes All".into(),
                errors: vec!["dryRun".into()],
            })
        }
    }
    let queued = !above.is_empty();
    let connector = state
        .connectors
        .create(&identity.subject, new, above, &base(&state))
        .await?;
    if queued {
        notify_admins(&state, identity, &connector).await;
    }
    Ok((StatusCode::CREATED, Json(connector)).into_response())
}

#[utoipa::path(
    get,
    path = "/api/v1/connectors/{id}",
    summary = "Get My Connector",
    tag = "connectors",
    params(("id" = String, Path, description = "The connector id")),
    responses(
        (status = 200, description = "The connector", body = Connector),
        (status = 401, description = "Not signed in", body = ProblemDetails),
        (status = 404, description = "No connector of the caller's with this id", body = ProblemDetails),
    )
)]
pub async fn get_connector(
    user: CurrentUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Connector>, ApiError> {
    Ok(Json(own(&state, &user.0.identity, &id).await?))
}

#[utoipa::path(
    patch,
    path = "/api/v1/connectors/{id}",
    summary = "Edit My Connector",
    description = "Changes the presets, scope, writes, expiry or allowed clients of the caller's connector that is not revoked; the result is checked as a new one is, against the ceiling and the caller's rights today (API/14 §2, T-5951).",
    tag = "connectors",
    params(("id" = String, Path, description = "The connector id")),
    request_body(
        content = ConnectorPatch,
        content_type = "application/merge-patch+json",
        example = json!({ "scope": [{ "project": "doprava", "access": "read" }], "expiresAt": "2026-11-27T00:00:00Z" })
    ),
    responses(
        (status = 200, description = "The connector as it is now", body = Connector),
        (status = 400, description = "A field out of shape; errors names it", body = ProblemDetails),
        (status = 401, description = "Not signed in", body = ProblemDetails),
        (status = 403, description = "Above the ceiling, or a project the caller holds no right in; the detail names the field", body = ProblemDetails),
        (status = 404, description = "No live connector of the caller's with this id", body = ProblemDetails),
        (status = 422, description = "A scope item names an object the caller does not read", body = ProblemDetails),
    )
)]
pub async fn edit_connector(
    user: CurrentUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
    body: Result<Json<ConnectorPatch>, JsonRejection>,
) -> Result<Json<Connector>, ApiError> {
    let identity = &user.0.identity;
    person(&state, identity)?;
    let current = own(&state, identity, &id).await?;
    let Json(patch) = body.map_err(|e| ApiError::BadRequest(e.body_text()))?;
    let new = NewConnector {
        name: current.name,
        segments: patch.segments.unwrap_or(current.segments),
        scope: patch.scope.unwrap_or(current.scope),
        writes: patch.writes.unwrap_or(current.writes),
        expires_at: patch.expires_at.unwrap_or(current.expires_at),
        allowed_clients: patch.allowed_clients.unwrap_or(current.allowed_clients),
    };
    // Decided (worker-t5953, owner may override): an edit is judged against today's ceiling like a
    // create; above it under a queueing policy the connector waits again unless its approval
    // already covers every line, because an approval covers what was asked then; options: keep
    // any approval (an edit would widen past it), refuse every edit above the ceiling.
    let above = connectors::validate(
        &new,
        &Ceiling::of(&state.mirror, identity),
        chrono::Utc::now(),
    )?;
    reachable(&state, identity, &new)?;
    let approval = current
        .approval
        .filter(|_| !above.is_empty() && above.iter().all(|l| current.above_ceiling.contains(l)));
    if !state
        .connectors
        .update(&id, &identity.subject, new, above, approval)
        .await?
    {
        return Err(not_found());
    }
    let connector = own(&state, identity, &id).await?;
    if connector.state == "pending" {
        notify_admins(&state, identity, &connector).await;
    }
    Ok(Json(connector))
}

#[utoipa::path(
    delete,
    path = "/api/v1/connectors/{id}",
    summary = "Revoke My Connector",
    description = "The connector turns `revoked`; the next call through it is refused (AG-145).",
    tag = "connectors",
    params(("id" = String, Path, description = "The connector id")),
    responses(
        (status = 204, description = "Revoked"),
        (status = 401, description = "Not signed in", body = ProblemDetails),
        (status = 403, description = "Refused by the request guard", body = ProblemDetails),
        (status = 404, description = "No live connector of the caller's with this id", body = ProblemDetails),
    )
)]
pub async fn revoke_connector(
    user: CurrentUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let identity = &user.0.identity;
    own(&state, identity, &id).await?;
    if state.connectors.revoke(&id, &identity.subject).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(not_found())
    }
}

#[utoipa::path(
    get,
    path = "/api/v1/connectors/{id}/activity",
    summary = "My Connector's Calls",
    description = "Every call through the connector, newest first, at most 200 of the last 30 days: person, client, tool, target, verdict, duration; never a token or an input value (AG-147).",
    tag = "connectors",
    params(("id" = String, Path, description = "The connector id")),
    responses(
        (status = 200, description = "The audit rows", body = ConnectorCalls),
        (status = 401, description = "Not signed in", body = ProblemDetails),
        (status = 404, description = "No connector of the caller's with this id", body = ProblemDetails),
    )
)]
pub async fn connector_activity(
    user: CurrentUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<ConnectorCalls>, ApiError> {
    let connector = own(&state, &user.0.identity, &id).await?;
    let items = state.connectors.calls(&connector.id).await?;
    Ok(Json(ConnectorCalls { items }))
}

/// Only an administrator of the organization's ceiling, a person, sees or decides requests above
/// it: whoever may approve a `DelegationPolicy` change (AG-150, AG-151).
fn administrator(state: &AppState, identity: &Identity) -> Result<(), ApiError> {
    person(state, identity)?;
    // Any client's token, an AI client's or a token-exchanged agent's: only the person in the
    // Portal decides (AG-151); a Portal session carries no client.
    if identity.client.is_some() {
        return Err(ApiError::Denied(
            "a client's token decides no connector request; approve it signed in to the Portal (AG-151)"
                .into(),
        ));
    }
    let org = crate::permissions::for_request(state, identity, ORG_NAMESPACE);
    if !org.administers_organization()
        && !org.may("DelegationPolicy", jc_core::kinds::Verb::Approve)
    {
        return Err(ApiError::Denied(
            "only an administrator of the organization, or a person who may approve a DelegationPolicy change, decides connector requests above the ceiling (AG-150)".into(),
        ));
    }
    Ok(())
}

/// The approver holds every right the connector asks for, project by project (PF-51,
/// `within_own_rights`): `read` on each kind its segments reach, `propose` where an item writes.
fn within_own_rights(
    state: &AppState,
    identity: &Identity,
    connector: &Connector,
) -> Result<(), ApiError> {
    let (_, kinds) = connector.reach();
    for (i, item) in connector.scope.iter().enumerate() {
        let rights = crate::permissions::for_request(state, identity, &item.project);
        let verb = match item.access {
            connectors::ItemAccess::Read => jc_core::kinds::Verb::Read,
            connectors::ItemAccess::Write => jc_core::kinds::Verb::Propose,
        };
        if let Some(kind) = kinds.iter().find(|k| !rights.may(k, verb)) {
            return Err(ApiError::Denied(format!(
                "scope[{i}]: the connector asks {verb:?} on {kind} in project {}, which you do not hold; nobody approves above their own rights (PF-51)",
                item.project
            )));
        }
    }
    Ok(())
}

#[utoipa::path(
    get,
    path = "/api/v1/connectors/pending",
    summary = "Connector Requests Above the Ceiling",
    description = "Every live connector waiting for an administrator, oldest first, with what it asks above its owner's DelegationPolicy ceiling (AG-150). Only an administrator of the organization, or a person who may approve a DelegationPolicy change, reads it.",
    tag = "connectors",
    responses(
        (status = 200, description = "The pending connectors", body = ConnectorList),
        (status = 401, description = "Not signed in", body = ProblemDetails),
        (status = 403, description = "Not an administrator of the ceiling, or an AI client's token", body = ProblemDetails),
    )
)]
pub async fn pending_connectors(
    user: CurrentUser,
    State(state): State<AppState>,
) -> Result<Json<ConnectorList>, ApiError> {
    administrator(&state, &user.0.identity)?;
    let items = state.connectors.pending(&base(&state)).await?;
    Ok(Json(ConnectorList { items }))
}

#[utoipa::path(
    post,
    path = "/api/v1/connectors/{id}/approve",
    summary = "Approve a Connector Request",
    description = "Lets a `pending` connector through: it turns `active` and calls run with what it asked, while a DelegationPolicy binding its owner still queues requests. The approver is an administrator of the organization or a person who may approve a DelegationPolicy change, not the owner, and holds every right the connector asks for (AG-150, PF-51); an AI client's token is refused (AG-151).",
    tag = "connectors",
    params(("id" = String, Path, description = "The connector id")),
    responses(
        (status = 200, description = "Approved", body = Connector),
        (status = 401, description = "Not signed in", body = ProblemDetails),
        (status = 403, description = "Not an administrator, the owner, a right the approver lacks, or an AI client's token; the detail says which", body = ProblemDetails),
        (status = 404, description = "No pending connector with this id", body = ProblemDetails),
    )
)]
pub async fn approve_connector(
    user: CurrentUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Connector>, ApiError> {
    let identity = &user.0.identity;
    administrator(&state, identity)?;
    if !connectors::is_id(&id) {
        return Err(not_found());
    }
    let connector = match state.connectors.get(&id, &base(&state)).await? {
        Some(c) if c.state == "pending" => c,
        _ => return Err(not_found()),
    };
    if connector.owner == identity.subject {
        return Err(ApiError::Denied(
            "you asked for this connector; another administrator approves it (AG-150)".into(),
        ));
    }
    within_own_rights(&state, identity, &connector)?;
    if !state.connectors.approve(&id, &identity.subject).await? {
        return Err(not_found());
    }
    state
        .connectors
        .get(&id, &base(&state))
        .await?
        .map(Json)
        .ok_or_else(not_found)
}

/// How far ahead the owner learns a connector ends (T-5979).
const EXPIRY_NOTICE_DAYS: i64 = 7;

/// The audiences whose notices `identity` may act on today (T-5979): the approvers of each
/// project where they hold `approve`, and the deciders of connector requests. Judged at read, so
/// a person who lost the right gets no new notice of it.
pub(crate) fn audiences(state: &AppState, identity: &Identity) -> Vec<String> {
    let mut audiences: Vec<String> = state
        .mirror
        .namespaces()
        .into_iter()
        .filter(|project| {
            crate::api::changes::may_approve_anything(state, identity, project).is_ok()
        })
        .map(|project| crate::entity_comments::approvers_of(&project))
        .collect();
    if administrator(state, identity).is_ok() {
        audiences.push(crate::entity_comments::CONNECTOR_ADMINS.to_owned());
    }
    audiences
}

/// Leaves `me` one notice per live connector of theirs that ends within
/// [`EXPIRY_NOTICE_DAYS`] days; a new expiry is a new notice.
pub(crate) async fn notify_expiring(
    state: &AppState,
    identity: &Identity,
    me: &str,
) -> Result<(), ApiError> {
    let now = chrono::Utc::now();
    let soon = now + chrono::Duration::days(EXPIRY_NOTICE_DAYS);
    for connector in state
        .connectors
        .of_owner(&identity.subject, &base(state))
        .await?
    {
        if !connector.is_active() || connector.expires_at <= now || connector.expires_at > soon {
            continue;
        }
        let key = format!(
            "connector.expiring:{}:{}",
            connector.id,
            connector.expires_at.timestamp()
        );
        state
            .comments
            .notify(
                me,
                crate::entity_comments::Notice {
                    kind: "connector.expiring",
                    project: "",
                    about: &connector.id,
                    author: "",
                    author_name: "",
                    connector: &connector.name,
                    link: CONNECTORS_PAGE,
                    key: &key,
                },
            )
            .await
            .map_err(|err| {
                tracing::warn!(error = %err, "notifications not reachable");
                ApiError::Unavailable("the notifications could not be written".into())
            })?;
    }
    Ok(())
}

/// Tells the deciders of connector requests that `connector` waits above the ceiling (T-5979):
/// the owner's name and the connector's, never its scope. A notice that cannot be written is
/// logged and the request stays queued.
async fn notify_admins(state: &AppState, identity: &Identity, connector: &Connector) {
    let author = identity.username.to_ascii_lowercase();
    // One notice per request: the same lines asked again are the same event (T-5979).
    use sha2::{Digest, Sha256};
    let asked = Sha256::digest(connector.above_ceiling.join("\n").as_bytes());
    let key = format!("connector.pending:{}:{:x}", connector.id, asked);
    let notice = crate::entity_comments::Notice {
        kind: "connector.pending",
        project: "",
        about: &connector.id,
        author: &author,
        author_name: identity.name.as_deref().unwrap_or(&identity.username),
        connector: &connector.name,
        link: CONNECTORS_PAGE,
        key: &key,
    };
    let audience = crate::entity_comments::CONNECTOR_ADMINS;
    if let Err(err) = state.comments.notify(audience, notice).await {
        tracing::warn!(error = %err, connector = %connector.id, "connector admins not notified");
    }
}

/// The page a person manages their connectors on.
pub(crate) const CONNECTORS_PAGE: &str = "/ai-connectors";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::permissions::ORG_NAMESPACE;
    use crate::resource::{ObjectMeta, ResourceEnvelope, API_VERSION};
    use crate::store::Mirror;
    use serde_json::{json, Value};
    use std::sync::Arc;

    fn envelope(kind: &str, name: &str, namespace: &str, spec: Value) -> ResourceEnvelope {
        ResourceEnvelope {
            api_version: API_VERSION.to_owned(),
            kind: kind.to_owned(),
            metadata: ObjectMeta::new(name, namespace),
            spec,
            status: None,
        }
    }

    /// A reader of project `helsinki` alone; `espoo` exists beside it.
    fn reader_world() -> AppState {
        let state = AppState::new(Config::for_tests(), None);
        let org = ORG_NAMESPACE;
        state.mirror.upsert(envelope(
            "Role",
            "reader",
            org,
            json!({ "rules": [{ "kinds": ["Endpoint", "ContextSpace", "Pipeline"], "verbs": ["read"] }] }),
        ));
        state.mirror.upsert(envelope(
            "RoleBinding",
            "reader",
            org,
            json!({ "subjects": [{ "user": "reader@hel.fi" }], "role": "reader", "scope": { "project": "helsinki" } }),
        ));
        for project in ["helsinki", "espoo"] {
            state
                .mirror
                .upsert(envelope("ContextSpace", "air", project, json!({})));
            state.mirror.upsert(envelope(
                "Endpoint",
                &format!("{project}-air"),
                project,
                json!({ "contextSpaceRef": "air" }),
            ));
        }
        state
    }

    fn manifest(kind: &str, name: &str, spec: Value) -> ResourceEnvelope {
        envelope(kind, name, ORG_NAMESPACE, spec)
    }

    fn person(email: &str) -> Identity {
        Identity {
            client: None,
            subject: format!("sub-{email}"),
            username: email.to_owned(),
            email: Some(email.to_owned()),
            name: None,
            roles: vec![],
            groups: vec![],
            second_factor: false,
        }
    }

    /// Petra reads the data-read kinds in project doprava and proposes nothing there.
    fn world() -> AppState {
        let state = AppState::new(Config::for_tests(), None);
        state.mirror.upsert(manifest(
            "Role",
            "reader",
            json!({ "rules": [{ "kinds": ["Endpoint", "ContextSpace", "DataModel"], "verbs": ["read"] }] }),
        ));
        state.mirror.upsert(manifest(
            "RoleBinding",
            "petra-reads-doprava",
            json!({ "subjects": [{ "user": "petra@hel.fi" }], "role": "reader",
                    "scope": { "project": "doprava" } }),
        ));
        state
    }

    async fn asked(state: &AppState, access: &str, writes: bool) -> Connector {
        let new: NewConnector = serde_json::from_value(json!({
            "name": format!("asks-{access}"), "segments": ["data-read"],
            "scope": [{ "project": "doprava", "access": access }], "writes": writes,
            "expiresAt": (chrono::Utc::now() + chrono::Duration::days(1)).to_rfc3339(),
        }))
        .expect("request");
        state
            .connectors
            .create(
                "sub-jana@hel.fi",
                new,
                vec!["writes: above".into()],
                "https://portal.test",
            )
            .await
            .expect("kept")
    }

    #[tokio::test]
    async fn an_approver_holds_every_right_the_connector_asks_for() {
        let state = world();
        let petra = person("petra@hel.fi");
        let reads = asked(&state, "read", false).await;
        let ok = within_own_rights(&state, &petra, &reads);
        assert!(ok.is_ok(), "{ok:?}");
        // A write item asks `propose`, which Petra does not hold in doprava.
        let writes = asked(&state, "write", true).await;
        match within_own_rights(&state, &petra, &writes) {
            Err(ApiError::Denied(why)) => {
                assert!(
                    why.starts_with("scope[0]") && why.contains("doprava"),
                    "{why}"
                )
            }
            other => panic!("approved above her rights: {other:?}"),
        }
        // Nobody holds anything in a project no binding names.
        let nobody = person("eva@hel.fi");
        assert!(within_own_rights(&state, &nobody, &reads).is_err());
    }

    #[test]
    fn only_a_person_who_approves_delegation_policies_decides_requests() {
        let state = world();
        // Petra reads but approves no DelegationPolicy change.
        assert!(matches!(
            administrator(&state, &person("petra@hel.fi")),
            Err(ApiError::Denied(_))
        ));
        let mut admin = person("admin@hel.fi");
        admin.groups = vec![state.config.bootstrap_admins.clone()];
        assert!(administrator(&state, &admin).is_ok());
        // The same administrator through an AI client's token decides nothing (AG-151).
        admin.client = Some("mcp-local".into());
        match administrator(&state, &admin) {
            Err(ApiError::Denied(why)) => assert!(why.contains("AG-151"), "{why}"),
            other => panic!("{other:?}"),
        }
        // Nor through an agent's token exchanged for the administrator (no connector client).
        admin.client = Some("agent-runner".into());
        match administrator(&state, &admin) {
            Err(ApiError::Denied(why)) => assert!(why.contains("AG-151"), "{why}"),
            other => panic!("an agent token decided a request: {other:?}"),
        }
        // A workload's account is no person.
        let mut workload = person("service-account-pipeline");
        workload.groups = vec![state.config.bootstrap_admins.clone()];
        assert!(administrator(&state, &workload).is_err());
    }

    fn user(username: &str) -> CurrentUser {
        CurrentUser(crate::auth::session::Session {
            identity: Identity {
                client: None,
                subject: format!("f:1:{username}"),
                username: username.to_owned(),
                email: None,
                name: None,
                roles: Vec::new(),
                groups: Vec::new(),
                second_factor: false,
            },
            expires_at: 0,
            issued_at: 0,
            id_token: String::new(),
            access_expires_at: 0,
            refresh_token: None,
        })
    }

    fn body(name: &str) -> Result<Json<NewConnector>, JsonRejection> {
        let expires = chrono::Utc::now() + chrono::Duration::days(7);
        Ok(Json(
            serde_json::from_value(json!({
                "name": name, "segments": ["data-read"],
                "scope": [{ "project": "doprava", "access": "read" }],
                "expiresAt": expires.to_rfc3339(),
            }))
            .expect("a valid request"),
        ))
    }

    fn dry(run: Option<&str>) -> Query<CreateParams> {
        Query(CreateParams {
            dry_run: run.map(str::to_owned),
        })
    }

    #[tokio::test]
    async fn create_refuses_workloads_strangers_and_bad_dry_runs_then_keeps_the_owners() {
        let mirror = Arc::new(Mirror::new());
        mirror.upsert(envelope(
            "Role",
            "reader",
            ORG_NAMESPACE,
            json!({ "rules": [{ "kinds": ["*"], "verbs": ["read"] }] }),
        ));
        mirror.upsert(envelope(
            "RoleBinding",
            "reader",
            ORG_NAMESPACE,
            json!({ "subjects": [{ "user": "ana" }], "role": "reader", "scope": { "project": "doprava" } }),
        ));
        let state = AppState::new(Config::for_tests(), None).with_mirror(mirror);
        let create = |who: &str, run: Option<&str>, name: &str| {
            create_connector(user(who), State(state.clone()), dry(run), body(name))
        };

        let workload = create("service-account-etl", None, "a").await;
        assert!(matches!(workload, Err(ApiError::Denied(why)) if why.contains("AG-142")));
        let stranger = create("bob", None, "a").await;
        assert!(
            matches!(stranger, Err(ApiError::Denied(why)) if why.starts_with("scope[0].project"))
        );
        let bad_name = create("ana", None, "Not A Label").await;
        assert!(matches!(bad_name, Err(ApiError::Invalid { errors, .. }) if errors == ["name"]));
        let bad_run = create("ana", Some("Some"), "a").await;
        assert!(matches!(bad_run, Err(ApiError::Invalid { errors, .. }) if errors == ["dryRun"]));

        let checked = create("ana", Some("All"), "a").await.expect("dry run");
        assert_eq!(checked.status(), StatusCode::OK);
        assert!(state
            .connectors
            .of_owner("f:1:ana", "")
            .await
            .expect("list")
            .is_empty());
        let created = create("ana", None, "a").await.expect("created");
        assert_eq!(created.status(), StatusCode::CREATED);
        assert_eq!(
            state
                .connectors
                .of_owner("f:1:ana", "")
                .await
                .expect("list")
                .len(),
            1
        );
    }

    fn patch(body: Value) -> Result<Json<ConnectorPatch>, JsonRejection> {
        Ok(Json(serde_json::from_value(body).expect("patch")))
    }

    #[tokio::test]
    async fn the_options_list_only_what_the_reader_reads_and_an_edit_asks_again() {
        let state = reader_world();
        let Json(options) = connector_options(user("reader@hel.fi"), State(state.clone()))
            .await
            .expect("options");
        assert_eq!(
            serde_json::to_value(&options.projects).expect("json"),
            json!([{ "project": "helsinki", "spaces": ["air"], "endpoints": ["helsinki-air"], "pipelines": [] }])
        );
        assert_eq!(options.ceiling.segments, vec!["data-read"]);

        let expires = (chrono::Utc::now() + chrono::Duration::days(7)).to_rfc3339();
        let new: NewConnector = serde_json::from_value(json!({
            "name": "air", "segments": ["data-read"], "expiresAt": expires,
            "scope": [{ "project": "helsinki", "access": "read" }]
        }))
        .expect("new");
        let created = create_connector(
            user("reader@hel.fi"),
            State(state.clone()),
            Query(CreateParams { dry_run: None }),
            Ok(Json(new)),
        )
        .await
        .expect("created");
        assert_eq!(created.status(), StatusCode::CREATED);
        let id = state
            .connectors
            .of_owner("f:1:reader@hel.fi", "https://portal.test")
            .await
            .expect("list")[0]
            .id
            .clone();

        let edit = |body| {
            edit_connector(
                user("reader@hel.fi"),
                State(state.clone()),
                Path(id.clone()),
                patch(body),
            )
        };
        let Err(ApiError::Denied(detail)) =
            edit(json!({ "scope": [{ "project": "espoo", "access": "read" }] })).await
        else {
            panic!("another project is refused");
        };
        assert!(detail.starts_with("scope[0].project"), "{detail}");
        let Err(ApiError::Unprocessable { errors, .. }) = edit(
            json!({ "scope": [{ "project": "helsinki", "endpoint": "nope", "access": "read" }] }),
        )
        .await
        else {
            panic!("an Endpoint the project lacks is refused");
        };
        assert_eq!(errors, vec!["scope[0].endpoint"]);
        let Json(edited) = edit(json!({ "scope": [{ "project": "helsinki", "endpoint": "helsinki-air", "access": "read" }] }))
            .await
            .expect("edited");
        assert_eq!(edited.scope[0].endpoint.as_deref(), Some("helsinki-air"));
        assert_eq!(edited.name, "air");
    }

    #[tokio::test]
    async fn an_edit_above_a_queueing_ceiling_waits_again_unless_its_approval_covers_it() {
        let state = reader_world();
        state.mirror.upsert(envelope(
            "DelegationPolicy",
            "readers-a-week",
            ORG_NAMESPACE,
            json!({ "subjects": [{ "kind": "Group", "name": "readers" }],
                    "projects": ["helsinki"], "maxExpiry": "P7D", "aboveCeiling": "queue" }),
        ));
        state.mirror.upsert(envelope(
            "Group",
            "readers",
            ORG_NAMESPACE,
            json!({ "members": [{ "user": "reader@hel.fi" }] }),
        ));
        // The reader also reads espoo, which the policy leaves out.
        state.mirror.upsert(envelope(
            "RoleBinding",
            "reader-espoo",
            ORG_NAMESPACE,
            json!({ "subjects": [{ "user": "reader@hel.fi" }], "role": "reader", "scope": { "project": "espoo" } }),
        ));
        let days = |n: i64| (chrono::Utc::now() + chrono::Duration::days(n)).to_rfc3339();
        let new: NewConnector = serde_json::from_value(json!({
            "name": "air", "segments": ["data-read"], "expiresAt": days(5),
            "scope": [{ "project": "helsinki", "access": "read" }]
        }))
        .expect("new");
        let created = state
            .connectors
            .create("f:1:reader@hel.fi", new, Vec::new(), "https://portal.test")
            .await
            .expect("created");
        let edit = |body| {
            edit_connector(
                user("reader@hel.fi"),
                State(state.clone()),
                Path(created.id.clone()),
                patch(body),
            )
        };
        let Json(longer) = edit(json!({ "expiresAt": days(20) })).await.expect("kept");
        assert_eq!(longer.state, "pending");
        assert_eq!(longer.above_ceiling.len(), 1, "{:?}", longer.above_ceiling);
        assert!(state
            .connectors
            .approve(&created.id, "sub-admin")
            .await
            .expect("approved"));
        // The same ask again keeps the approval; a new line above the ceiling waits again.
        let Json(again) = edit(json!({ "expiresAt": days(20) })).await.expect("kept");
        assert!(
            again.approval.is_some() && again.state != "pending",
            "{again:?}"
        );
        let both = json!([{ "project": "helsinki", "access": "read" }, { "project": "espoo", "access": "read" }]);
        let Json(wider) = edit(json!({ "scope": both, "expiresAt": days(20) }))
            .await
            .expect("kept");
        assert_eq!(wider.state, "pending");
        assert!(wider.approval.is_none());
        // Back inside the ceiling the connector lives with nothing above it.
        let one = json!([{ "project": "helsinki", "access": "read" }]);
        let Json(inside) = edit(json!({ "scope": one, "expiresAt": days(5) }))
            .await
            .expect("edited");
        assert!(
            inside.state != "pending" && inside.above_ceiling.is_empty(),
            "{inside:?}"
        );
    }
}
