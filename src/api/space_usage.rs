//! `GET /api/v1/projects/{project}/spaces/{space}/usage`: how much a space holds, as the broker
//! counts it (API/01 §29, T-2889).

use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Json, Router};

use crate::auth::CurrentUser;
use crate::error::ApiError;
use crate::resource::is_dns1123;
use crate::space_usage::SpaceUsage;
use crate::state::AppState;

#[utoipa::path(
    get,
    path = "/api/v1/projects/{project}/spaces/{space}/usage",
    summary = "Read Space Usage",
    description = "The entity count of one space, read from the broker that holds it and kept for five minutes. `0` for a space the broker has no tenant for yet. The same count for everyone who reads the space.",
    tag = "spaces",
    params(
        ("project" = String, Path, description = "Project name"),
        ("space" = String, Path, description = "Context Space name"),
    ),
    responses(
        (status = 200, description = "The space's usage", body = crate::space_usage::SpaceUsage),
        (status = 401, description = "Not signed in", body = crate::error::ProblemDetails),
        (status = 404, description = "No such space the caller may read", body = crate::error::ProblemDetails),
        (status = 503, description = "No broker is configured, or it did not answer", body = crate::error::ProblemDetails),
    )
)]
pub async fn get_usage(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((project, space)): Path<(String, String)>,
) -> Result<Json<SpaceUsage>, ApiError> {
    let effective = crate::permissions::for_request(&state, &user.0.identity, &project);
    let readable = is_dns1123(&project)
        && is_dns1123(&space)
        && effective.may_read_project()
        && effective.may_read_in("ContextSpace", Some(&space))
        && state.mirror.get(&project, "ContextSpace", &space).is_some();
    if !readable {
        return Err(ApiError::NotFound(format!(
            "context space '{space}' not found in project '{project}'"
        )));
    }
    state
        .space_usage
        .usage(&space)
        .await
        .map(Json)
        .map_err(ApiError::Unavailable)
}

pub fn router() -> Router<AppState> {
    Router::new().route("/projects/{project}/spaces/{space}/usage", get(get_usage))
}
