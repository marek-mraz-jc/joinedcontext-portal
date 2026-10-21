//! `GET /api/v1/projects/{project}/flow-map`: every path data takes through the project, from
//! MQTT broker or DataSource to space and on through derived and KPI pipelines (T-4862).

use std::collections::BTreeMap;

use axum::extract::{Path, Query, State};
use axum::routing::get;
use axum::{Json, Router};
use jc_core::kinds::Verb;

use crate::auth::CurrentUser;
use crate::error::ApiError;
use crate::flow_map::{FlowMap, FlowRun, Reader};
use crate::resource::{is_dns1123, is_manifest_name};
use crate::state::AppState;

#[derive(Debug, Default, serde::Deserialize, utoipa::IntoParams)]
pub struct FlowMapQuery {
    /// Only the paths that read or write this Context Space.
    pub space: Option<String>,
}

#[utoipa::path(
    get,
    path = "/api/v1/projects/{project}/flow-map",
    summary = "Read Data Flow Map",
    description = "Every MQTT broker, DataSource, Pipeline, Endpoint and Context Space of the project the caller may read, with the edges between them: which source feeds which pipeline, which Endpoint it reads and writes, the Policy that grants the pipelines account each read and write (or `missing` with the fix), each pipeline's phase and latest run. Another project's Endpoint a pipeline reads is named only, unless the caller reads that project.",
    tag = "resources",
    params(
        ("project" = String, Path, description = "Project name"),
        FlowMapQuery,
    ),
    responses(
        (status = 200, description = "The map", body = FlowMap),
        (status = 400, description = "Not a space name", body = crate::error::ProblemDetails),
        (status = 401, description = "Not signed in", body = crate::error::ProblemDetails),
        (status = 404, description = "No such project the caller may read", body = crate::error::ProblemDetails),
    )
)]
pub async fn get_flow_map(
    user: CurrentUser,
    State(state): State<AppState>,
    Path(project): Path<String>,
    Query(query): Query<FlowMapQuery>,
) -> Result<Json<FlowMap>, ApiError> {
    let effective = crate::permissions::for_request(&state, &user.0.identity, &project);
    if !is_dns1123(&project) || !effective.may_read_project() {
        return Err(ApiError::NotFound(format!("project '{project}' not found")));
    }
    let space = query.space.as_deref();
    if let Some(space) = space.filter(|s| !is_manifest_name("ContextSpace", s)) {
        return Err(ApiError::BadRequest(format!(
            "'{space}' is not a space name"
        )));
    }
    let runs = last_runs(&state, &project).await;
    Ok(Json(map_for(&state, &user, &effective, &runs, space)))
}

/// The map as this caller reads it: their grants in the project, and per other project whether
/// they read its Endpoints.
fn map_for(
    state: &AppState,
    user: &CurrentUser,
    effective: &crate::permissions::Effective,
    runs: &BTreeMap<String, FlowRun>,
    space: Option<&str>,
) -> FlowMap {
    let may = |kind: &str, space: Option<&str>| effective.may_in(kind, Verb::Read, space);
    let may_project = |other: &str| {
        crate::permissions::for_request(state, &user.0.identity, other).may_read("Endpoint")
    };
    let reader = Reader {
        may: &may,
        may_project: &may_project,
    };
    crate::flow_map::build(&state.mirror, &effective.project, &reader, runs, space)
}

/// The latest run of each pipeline of the project; a log that cannot be read leaves the map
/// without runs rather than without a map.
async fn last_runs(state: &AppState, project: &str) -> BTreeMap<String, FlowRun> {
    let mut runs = BTreeMap::new();
    let pipelines = state
        .mirror
        .list(project, "Pipeline", &Default::default())
        .items;
    for pipeline in pipelines {
        let name = pipeline.metadata.name;
        match state.pipeline_log.runs(project, &name, 1).await {
            Ok(latest) => {
                if let Some(run) = latest.first() {
                    runs.insert(name, FlowRun::of(run));
                }
            }
            Err(error) => {
                tracing::warn!(%project, pipeline = %name, %error, "the flow map read no runs");
                break;
            }
        }
    }
    runs
}

pub fn router() -> Router<AppState> {
    Router::new().route("/projects/{project}/flow-map", get(get_flow_map))
}
