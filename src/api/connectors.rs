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
        .route(
            "/connectors/{id}",
            get(get_connector).delete(revoke_connector),
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

#[derive(Debug, Deserialize, IntoParams)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateParams {
    /// `All` validates only: nothing is kept.
    #[serde(default)]
    pub dry_run: Option<String>,
}

fn base(state: &AppState) -> String {
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
            if state.mirror.get(&item.project, kind, name).is_none() {
                return Err(ApiError::Unprocessable {
                    detail: format!("project {} has no {kind} {name}", item.project),
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
    let connector = state
        .connectors
        .create(&identity.subject, new, above, &base(&state))
        .await?;
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
    if identity
        .client
        .as_deref()
        .is_some_and(|c| state.config.connector_clients.iter().any(|k| k == c))
    {
        return Err(ApiError::Denied(
            "an AI client's token decides no connector request; approve it in the Portal (AG-151)"
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::resource::{ObjectMeta, ResourceEnvelope, API_VERSION};
    use serde_json::json;

    fn manifest(kind: &str, name: &str, spec: serde_json::Value) -> ResourceEnvelope {
        ResourceEnvelope {
            api_version: API_VERSION.to_owned(),
            kind: kind.to_owned(),
            metadata: ObjectMeta::new(name, ORG_NAMESPACE),
            spec,
            status: None,
        }
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
        // A workload's account is no person.
        let mut workload = person("service-account-pipeline");
        workload.groups = vec![state.config.bootstrap_admins.clone()];
        assert!(administrator(&state, &workload).is_err());
    }
}
