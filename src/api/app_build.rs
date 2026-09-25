//! The build of a `static` application on the forge, as its App page shows it (AP-103, ADR-N-028).
//!
//! The build is the repository's `.gitea/workflows/build.yml` (AP-100): the Portal starts
//! nothing, it links the repository, the newest run and the package, and Rebuild dispatches the
//! workflow on the default branch. The repository is `{project}_{app}` (AP-75), derived from the
//! path and never read from the manifest, so no manifest points a dispatch at another repository.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use jc_core::kinds::Verb;
use serde::Serialize;
use utoipa::ToSchema;

use crate::agents::repository;
use crate::auth::CurrentUser;
use crate::error::{ApiError, ProblemDetails};
use crate::git::{GitError, GiteaClient, WorkflowRun};
use crate::state::AppState;

/// The workflow every application repository carries (AP-100).
const WORKFLOW_FILE: &str = "build.yml";

/// Where an application's build is, and whether this person may ask for another (AP-103).
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AppBuild {
    /// The repository's page; `null` for an App not built on the forge.
    pub repository_url: Option<String>,
    /// The newest workflow run, `null` before the first.
    pub run: Option<WorkflowRun>,
    /// The package of `status.build.commit`, `null` while the App has no build.
    pub package_url: Option<String>,
    pub rebuild: Rebuild,
}

/// Whether Rebuild is offered, and why not when it is not (PF-50, UI-44).
#[derive(Debug, Serialize, ToSchema)]
pub struct Rebuild {
    pub allowed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/projects/{project}/apps/{name}/build", get(build))
        .route("/projects/{project}/apps/{name}/rebuild", post(rebuild))
}

/// The App as this person may see it, its repository when it is built on the forge, and the
/// forge client. An App the caller may not read is the same `404` as one that does not exist.
fn app_of(
    state: &AppState,
    user: &CurrentUser,
    project: &str,
    name: &str,
) -> Result<(serde_json::Value, Option<GiteaClient>), ApiError> {
    let not_found = || ApiError::NotFound(format!("app '{name}' not found"));
    let app = state
        .mirror
        .get(project, "App", name)
        .and_then(|app| serde_json::to_value(app).ok())
        .ok_or_else(not_found)?;
    if !crate::permissions::for_request(state, &user.0.identity, project)
        .may_read_manifest("App", &app)
    {
        return Err(not_found());
    }
    let gitea = state
        .gitea
        .as_deref()
        .ok_or_else(|| ApiError::Unavailable("no forge is configured".into()))?;
    let on_forge = app
        .pointer("/spec/source/git")
        .is_some_and(|git| !git.is_null());
    Ok((
        app,
        on_forge.then(|| gitea.for_application(repository::name(project, name))),
    ))
}

/// Why this person may not rebuild, or `None` when they may.
fn rebuild_refusal(state: &AppState, user: &CurrentUser, project: &str) -> Option<String> {
    (!crate::permissions::for_request(state, &user.0.identity, project).may("App", Verb::Propose))
        .then(|| format!("Rebuild needs propose on App in project {project}"))
}

const NOT_ON_FORGE: &str =
    "the App is not built on the forge: it names no spec.source.git of its own (AP-100)";

#[utoipa::path(
    get,
    path = "/api/v1/projects/{project}/apps/{name}/build",
    summary = "Where An Application's Build Is",
    description = "The repository, the newest workflow run and the package of an application built on the forge, and whether Rebuild is offered.",
    tag = "apps",
    params(
        ("project" = String, Path, description = "Project name"),
        ("name" = String, Path, description = "App name"),
    ),
    responses(
        (status = 200, description = "The build's links", body = AppBuild),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 404, description = "No such App the caller may read", body = ProblemDetails),
        (status = 503, description = "No forge is configured", body = ProblemDetails)
    )
)]
pub async fn build(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((project, name)): Path<(String, String)>,
) -> Result<Json<AppBuild>, ApiError> {
    let (app, repo) = app_of(&state, &user, &project, &name)?;
    let Some(repo) = repo else {
        return Ok(Json(AppBuild {
            repository_url: None,
            run: None,
            package_url: None,
            rebuild: Rebuild {
                allowed: false,
                reason: Some(NOT_ON_FORGE.into()),
            },
        }));
    };
    let run = match repo.latest_run().await {
        Ok(run) => run,
        // A repository with Actions off, or not created yet, has no run to link.
        Err(GitError::NotFound) => None,
        Err(err) => {
            tracing::warn!(app = %name, error = %err, "the application's workflow runs were not read");
            None
        }
    };
    let build = |field: &str| {
        app.pointer(&format!("/status/build/{field}"))
            .and_then(serde_json::Value::as_str)
    };
    let package_url = build("commit")
        .zip(build("digest"))
        .map(|(commit, digest)| {
            repo.package_page_url(
                &crate::apps::built::package(&name),
                &crate::apps::built::version(commit, digest),
            )
        });
    let refusal = rebuild_refusal(&state, &user, &project);
    Ok(Json(AppBuild {
        repository_url: Some(repo.repository_page_url()),
        run,
        package_url,
        rebuild: Rebuild {
            allowed: refusal.is_none(),
            reason: refusal,
        },
    }))
}

#[utoipa::path(
    post,
    path = "/api/v1/projects/{project}/apps/{name}/rebuild",
    summary = "Rebuild An Application",
    description = "Dispatches the application's build.yml on its repository's default branch.",
    tag = "apps",
    params(
        ("project" = String, Path, description = "Project name"),
        ("name" = String, Path, description = "App name"),
    ),
    responses(
        (status = 202, description = "The forge accepted the dispatch"),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "The caller may not propose App here", body = ProblemDetails),
        (status = 404, description = "No such App the caller may read", body = ProblemDetails),
        (status = 409, description = "The App is not built on the forge", body = ProblemDetails),
        (status = 503, description = "No forge, or the forge refused the dispatch", body = ProblemDetails)
    )
)]
pub async fn rebuild(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((project, name)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    let (_, repo) = app_of(&state, &user, &project, &name)?;
    if let Some(reason) = rebuild_refusal(&state, &user, &project) {
        return Err(ApiError::Denied(reason));
    }
    let repo = repo.ok_or_else(|| ApiError::Conflict(NOT_ON_FORGE.into()))?;
    let refused = |err: GitError| {
        ApiError::Unavailable(format!(
            "the forge did not start the build of '{name}': {err}"
        ))
    };
    let branch = repo.default_branch().await.map_err(refused)?;
    repo.dispatch_workflow(WORKFLOW_FILE, &branch)
        .await
        .map_err(refused)?;
    tracing::info!(app = %name, project = %project, by = %user.0.identity.username, "rebuild dispatched");
    Ok(StatusCode::ACCEPTED.into_response())
}
