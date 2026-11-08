//! The internal listener's personal connectors (UI-98, EP-123, T-4531, T-5970): what the gateway
//! reads to serve `/api/mcp/me/{name}` to one person's token, from the connector store (API/14).

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::auth::Identity;
use crate::connectors::{Ceiling, Connector, ADMIN};
use crate::error::ApiError;
use crate::people::PeopleError;
use crate::state::AppState;

/// Whether the connector reads data through the gateway: active and carrying `data-read`.
fn reads_data(connector: &Connector) -> bool {
    connector.is_active()
        && connector
            .segments
            .iter()
            .any(|s| s == "data-read" || s == ADMIN)
}

/// The connector as the gateway may serve it under the owner's ceiling today (F-07), as the
/// `/c/{id}` door judges a call: an approval that still queues stands in for the ceiling;
/// otherwise a connector older than the ceiling allows or without an allowed data-reading
/// segment goes, and its scope and clients keep only what the ceiling allows (none left: it
/// goes). A connector keeping personal data never goes, because the gateway does not withhold it.
fn served(
    ceiling: &Ceiling,
    mut connector: Connector,
    now: chrono::DateTime<chrono::Utc>,
) -> Option<Connector> {
    if connector.scope.iter().any(|item| item.personal_data) {
        return None;
    }
    if ceiling.honours(&connector) {
        return Some(connector);
    }
    let aged = now > connector.granted_at + chrono::Duration::days(ceiling.max_days());
    let reads = connector
        .segments
        .iter()
        .any(|s| (s == "data-read" || s == ADMIN) && ceiling.allows_segment(s));
    if aged || !reads {
        return None;
    }
    connector.scope.retain(|item| {
        ceiling.allows_project_name(&item.project)
            && ceiling.allows_endpoint(&item.project, item.endpoint.as_deref())
    });
    let had_clients = !connector.allowed_clients.is_empty();
    connector
        .allowed_clients
        .retain(|client| ceiling.allows_client(client));
    (!connector.scope.is_empty() && (!had_clients || !connector.allowed_clients.is_empty()))
        .then_some(connector)
}

/// The owner as the realm names them: e-mail, groups and realm roles, so the ceiling binds as at
/// sign-in. `None` when the realm has no such person. Without a realm admin (tests, a Portal
/// without one) only what the `sub` alone binds.
async fn owner(state: &AppState, sub: &str) -> Result<Option<Identity>, ApiError> {
    let mut identity = Identity {
        client: None,
        subject: sub.to_owned(),
        username: sub.to_owned(),
        email: None,
        name: None,
        roles: Vec::new(),
        groups: Vec::new(),
        second_factor: false,
    };
    let Some(people) = state.people.as_ref() else {
        return Ok(Some(identity));
    };
    let unreachable = |err: PeopleError| {
        tracing::warn!(error = ?err, "the realm did not name a connector's owner");
        ApiError::Unavailable("the realm did not answer; try again shortly".into())
    };
    let admin = people.admin().await.map_err(unreachable)?;
    let user = match admin.get(sub).await {
        Ok(user) => user,
        Err(PeopleError::NotFound) => return Ok(None),
        Err(err) => return Err(unreachable(err)),
    };
    let (groups, roles) = admin
        .groups_and_realm_roles(&user.id)
        .await
        .map_err(unreachable)?;
    identity.username = user.username;
    identity.email = user.email;
    identity.groups = groups;
    identity.roles = roles;
    Ok(Some(identity))
}

/// One person's data-reading connectors by their Keycloak `sub`, for the gateway's own client
/// only (PF-46): name, id, scope, expiry and allowed clients, nothing about who calls; only those
/// the owner's ceiling still allows. A `sub` with none answers an empty list, so the answer never
/// says whether a person exists.
pub async fn connectors(
    State(state): State<AppState>,
    Path(sub): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    crate::auth::internal::authenticate_gateway(&state, &headers).await?;
    let Some(identity) = owner(&state, &sub).await? else {
        return Ok(Json(json!({ "connectors": [] })));
    };
    let ceiling = Ceiling::of(&state.mirror, &identity);
    let now = chrono::Utc::now();
    let base = crate::api::connectors::base(&state);
    let connectors: Vec<Value> = state
        .connectors
        .of_owner(&sub, &base)
        .await?
        .into_iter()
        .filter(reads_data)
        .filter_map(|c| served(&ceiling, c, now))
        .map(|c| {
            json!({
                "id": c.id,
                "name": c.name,
                "scope": c.scope,
                "expiresAt": c.expires_at,
                "allowedClients": c.allowed_clients,
            })
        })
        .collect();
    Ok(Json(json!({ "connectors": connectors })))
}

pub fn router() -> Router<AppState> {
    Router::new().route("/internal/connectors/{sub}", get(connectors))
}
