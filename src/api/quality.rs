//! `GET /api/v1/projects/{project}/spaces/{space}/quality`: the last data-quality run's report
//! of one space (DM-74, API/01 §27).

use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::auth::CurrentUser;
use crate::error::ApiError;
use crate::quality::SpaceQuality;
use crate::resource::is_dns1123;
use crate::state::AppState;

#[utoipa::path(
    get,
    path = "/api/v1/projects/{project}/spaces/{space}/quality",
    summary = "Read Data Quality",
    description = "The last daily run's report of one space: entities checked and invalid, the failing rules with examples, and the freshness of each pipeline writing into it. `{}` before the first run. Example ids only for a caller who reads Entity in the space (DM-74).",
    tag = "spaces",
    params(
        ("project" = String, Path, description = "Project name"),
        ("space" = String, Path, description = "Context Space name"),
    ),
    responses(
        (status = 200, description = "The report, or `{}` when the space was not checked yet", body = crate::quality::SpaceQuality),
        (status = 401, description = "Not signed in", body = crate::error::ProblemDetails),
        (status = 404, description = "No such space the caller may read", body = crate::error::ProblemDetails),
    )
)]
pub async fn get_quality(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((project, space)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let effective = crate::permissions::for_request(&state, &user.0.identity, &project);
    let readable = is_dns1123(&project)
        && effective.may_read_project()
        && effective.may_read_in("ContextSpace", Some(&space))
        && state.mirror.get(&project, "ContextSpace", &space).is_some();
    if !readable {
        return Err(ApiError::NotFound(format!(
            "context space '{space}' not found in project '{project}'"
        )));
    }
    let Some(quality) = state.quality.get(&project, &space) else {
        return Ok(Json(json!({})));
    };
    let reads_entities = effective.may_read_in("Entity", Some(&space));
    serde_json::to_value(for_caller(quality, reads_entities))
        .map(Json)
        .map_err(|err| ApiError::Internal(err.to_string()))
}

/// The counts are the space's; which entities they are is for whoever reads its entities.
fn for_caller(mut quality: SpaceQuality, reads_entities: bool) -> SpaceQuality {
    if !reads_entities {
        for rule in &mut quality.rules {
            rule.examples.clear();
        }
    }
    quality
}

pub fn router() -> Router<AppState> {
    Router::new().route(
        "/projects/{project}/spaces/{space}/quality",
        get(get_quality),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quality::RuleCount;

    fn report() -> SpaceQuality {
        SpaceQuality {
            observed_at: "2026-09-25T02:00:00Z".parse().unwrap(),
            checked: 10,
            invalid: 1,
            truncated: false,
            rules: vec![RuleCount {
                rule: "sh:minCount".into(),
                path: "name".into(),
                count: 1,
                examples: vec!["urn:ngsi-ld:Station:hel.fi:bikes:1".into()],
            }],
            freshness: Vec::new(),
        }
    }

    // DM-74: a caller who reads the space and not its entities learns the counts, not the ids.
    #[test]
    fn example_ids_are_only_for_whoever_reads_the_entities() {
        let hidden = for_caller(report(), false);
        assert!(hidden.rules[0].examples.is_empty());
        assert_eq!((hidden.checked, hidden.rules[0].count), (10, 1));
        assert_eq!(for_caller(report(), true), report());
    }
}
