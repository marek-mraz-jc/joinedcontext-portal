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
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::auth::session::Identity;
use crate::auth::CurrentUser;
use crate::connectors::{self, Call, Connector, NewConnector, DEFAULT_CEILING};
use crate::error::{ApiError, ProblemDetails};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/connectors", get(list_connectors).post(create_connector))
        .route(
            "/connectors/{id}",
            get(get_connector).delete(revoke_connector),
        )
        .route("/connectors/{id}/activity", get(connector_activity))
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
        Some(c) if c.owner == identity.subject => Ok(c),
        _ => Err(not_found()),
    }
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
    let items = state
        .connectors
        .of_owner(&identity.subject, &base(&state))
        .await?;
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
        (status = 201, description = "Created", body = Connector),
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
    connectors::validate(&new, &DEFAULT_CEILING, chrono::Utc::now())?;
    reachable(&state, identity, &new)?;
    match params.dry_run.as_deref() {
        None => {}
        Some("All") => {
            return Ok(Json(serde_json::json!({ "valid": true })).into_response());
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
        .create(&identity.subject, new, &base(&state))
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
