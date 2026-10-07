//! `GET /api/v1/app-templates`: the gallery of App templates a person starts from (T-3263,
//! AP-141). The same samples the build run adapts (SDK-24), each with its purpose and the data it
//! needs; a run started from one names it in its prompt as `(template: {name})`.

use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;
use utoipa::ToSchema;

use crate::agents::samples::{self, Template};
use crate::auth::CurrentUser;
use crate::error::ProblemDetails;
use crate::state::AppState;

#[derive(Debug, Serialize, ToSchema)]
pub struct AppTemplates {
    /// Every template, by name.
    pub templates: Vec<Template>,
}

#[utoipa::path(
    get,
    path = "/api/v1/app-templates",
    summary = "List App Templates",
    description = "The App templates of this Portal, each with what it is for, for whom and the data it needs. Starting a run whose prompt names `(template: {name})` builds from that template.",
    tag = "apps",
    responses(
        (status = 200, description = "Every template", body = AppTemplates),
        (status = 401, description = "Unauthorized", body = ProblemDetails)
    )
)]
pub async fn list_templates(_user: CurrentUser) -> Json<AppTemplates> {
    Json(AppTemplates {
        templates: samples::templates(),
    })
}

pub fn router() -> Router<AppState> {
    Router::new().route("/app-templates", get(list_templates))
}
