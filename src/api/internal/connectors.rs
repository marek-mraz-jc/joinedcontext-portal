//! The internal listener's personal connectors (UI-98, EP-123, T-4531): what the gateway reads to
//! serve `/api/mcp/me/{name}` to one person's token.

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::api::preferences::Preferences;
use crate::error::ApiError;
use crate::state::AppState;

/// One person's connectors by their Keycloak `sub`, for the gateway's own client only (PF-46).
/// A `sub` with no row or no connectors answers an empty list, so the answer never says whether
/// a person exists; there is no listing form.
pub async fn connectors(
    State(state): State<AppState>,
    Path(sub): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    crate::auth::internal::authenticate_gateway(&state, &headers).await?;
    let pool = state
        .db
        .as_ref()
        .ok_or_else(|| ApiError::Unavailable("no preferences database is configured".into()))?;
    let stored = crate::db::load_preferences(pool, &sub).await.map_err(|e| {
        tracing::error!(error = %e, "preferences database call failed");
        ApiError::Internal("the preferences database did not answer".into())
    })?;
    let connectors = stored
        .and_then(|value| serde_json::from_value::<Preferences>(value).ok())
        .map(|preferences| preferences.connectors)
        .unwrap_or_default();
    Ok(Json(json!({ "connectors": connectors })))
}

pub fn router() -> Router<AppState> {
    Router::new().route("/internal/connectors/{sub}", get(connectors))
}
