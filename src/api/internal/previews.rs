//! The internal listener's preview list (Architecture/06 §7.2, Architecture/13 §6): what the gateway
//! reads to serve the running workspace previews.

use crate::error::ApiError;
use crate::ops::previews::{self, ServedList};
use crate::state::AppState;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::routing::get;
use axum::{Json, Router};

/// Every running preview for the gateway, on the internal listener only (Architecture/06 §7.2,
/// Architecture/13 §6).
///
/// Manifests hold `secretRef`s and no secret, but they are a project's configuration, so the
/// gateway's own ServiceAccount token is what opens this route (PF-46, AG-52, T-1500). The
/// NetworkPolicy that admits the gateway to this port is the second control and not the only one:
/// a pod that reaches the port through a policy mistake presents no such token and reads nothing.
pub async fn served_previews(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<ServedList>, ApiError> {
    crate::auth::internal::authenticate_gateway(&state, &headers).await?;
    Ok(Json(previews::served(&state).await?))
}

pub fn router() -> Router<AppState> {
    Router::new().route("/internal/previews", get(served_previews))
}
