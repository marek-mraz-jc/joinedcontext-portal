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
        .route("/connectors/options", get(connector_options))
        .route(
            "/connectors/{id}",
            get(get_connector)
                .patch(edit_connector)
                .delete(revoke_connector),
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
    let items = state
        .connectors
        .of_owner(&identity.subject, &base(&state))
        .await?;
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
            segments: DEFAULT_CEILING
                .segments
                .iter()
                .map(|s| (*s).to_owned())
                .collect(),
            writes: DEFAULT_CEILING.writes,
            max_days: DEFAULT_CEILING.max_days,
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
    connectors::validate(&new, &DEFAULT_CEILING, chrono::Utc::now())?;
    reachable(&state, identity, &new)?;
    if !state.connectors.update(&id, &identity.subject, new).await? {
        return Err(not_found());
    }
    Ok(Json(own(&state, identity, &id).await?))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resource::{ObjectMeta, ResourceEnvelope, API_VERSION};
    use serde_json::json;

    fn envelope(
        kind: &str,
        name: &str,
        namespace: &str,
        spec: serde_json::Value,
    ) -> ResourceEnvelope {
        ResourceEnvelope {
            api_version: API_VERSION.to_owned(),
            kind: kind.to_owned(),
            metadata: ObjectMeta::new(name, namespace),
            spec,
            status: None,
        }
    }

    /// A reader of project `helsinki` alone; `espoo` exists beside it.
    fn world() -> AppState {
        let state = AppState::new(crate::config::Config::for_tests(), None);
        let org = crate::permissions::ORG_NAMESPACE;
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

    fn reader() -> CurrentUser {
        CurrentUser(crate::auth::session::Session {
            identity: Identity {
                client: None,
                subject: "f:1:reader".to_owned(),
                username: "reader@hel.fi".to_owned(),
                email: Some("reader@hel.fi".to_owned()),
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

    fn patch(body: serde_json::Value) -> Result<Json<ConnectorPatch>, JsonRejection> {
        Ok(Json(serde_json::from_value(body).expect("patch")))
    }

    #[tokio::test]
    async fn the_options_list_only_what_the_reader_reads_and_an_edit_asks_again() {
        let state = world();
        let Json(options) = connector_options(reader(), State(state.clone()))
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
            reader(),
            State(state.clone()),
            Query(CreateParams { dry_run: None }),
            Ok(Json(new)),
        )
        .await
        .expect("created");
        assert_eq!(created.status(), StatusCode::CREATED);
        let id = state
            .connectors
            .of_owner("f:1:reader", "https://portal.test")
            .await
            .expect("list")[0]
            .id
            .clone();

        let edit = |body| {
            edit_connector(
                reader(),
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
}
