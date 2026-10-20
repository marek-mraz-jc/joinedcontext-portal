//! Pipeline access requests (API/01 §47, PL-90…PL-93, T-4863).
//!
//! A person who may propose a Pipeline files the request in the pipeline's project; the request
//! waits in the Endpoint's project, where an owner of the Endpoint's space (`approve` on its
//! ContextSpace) approves, declines or later revokes it. Approving and revoking propose a Change
//! of the owning project as the approver, through the import door, so every check of a proposal
//! (who may propose a Policy there, nobody granting above their own rights, the lane) applies.

use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use jc_core::kinds::Verb;
use serde::Deserialize;
use serde_json::{json, Value};
use time::OffsetDateTime;
use utoipa::ToSchema;

use crate::access_requests::{self as requests, AccessRequest, EndpointName, NewRequest};
use crate::auth::CurrentUser;
use crate::error::ApiError;
use crate::resource::is_dns1123;
use crate::state::AppState;
use crate::store::ListOptions;

/// Why an owner declines or revokes.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct Decision {
    pub reason: String,
}

fn pool(state: &AppState) -> Result<&sqlx::PgPool, ApiError> {
    state.db.as_ref().ok_or_else(|| {
        ApiError::Unavailable("this Portal keeps no access requests (no database)".into())
    })
}

fn store_error(err: sqlx::Error) -> ApiError {
    tracing::warn!(error = %err, "the access requests were not read or written");
    ApiError::Unavailable("the access requests could not be read or written; try again".into())
}

fn now() -> OffsetDateTime {
    OffsetDateTime::now_utc()
}

/// The pipeline's manifest and space when the caller may propose it; 404 when they cannot read it.
fn proposable_pipeline(
    state: &AppState,
    user: &CurrentUser,
    project: &str,
    pipeline: &str,
    propose: bool,
) -> Result<(), ApiError> {
    let effective = crate::permissions::for_request(state, &user.0.identity, project);
    let gone = || {
        ApiError::NotFound(format!(
            "pipeline '{pipeline}' not found in project '{project}'"
        ))
    };
    let held = (is_dns1123(project) && is_dns1123(pipeline))
        .then(|| state.mirror.get(project, "Pipeline", pipeline))
        .flatten()
        .ok_or_else(gone)?;
    let manifest = serde_json::to_value(&held).unwrap_or(Value::Null);
    if !effective.may_read_project() || !effective.may_read_manifest("Pipeline", &manifest) {
        return Err(gone());
    }
    let space = crate::permissions::space_ref(&manifest);
    if propose && !effective.may_in("Pipeline", Verb::Propose, space.as_deref()) {
        return Err(ApiError::Denied(format!(
            "asking for access for pipeline '{pipeline}' needs propose on it in project '{project}' (PL-90)"
        )));
    }
    Ok(())
}

/// The request `id` of `project` when the caller owns its space: 404 when they cannot read the
/// space, 403 when they read it but do not own it.
async fn owned_request(
    state: &AppState,
    user: &CurrentUser,
    project: &str,
    id: &str,
) -> Result<AccessRequest, ApiError> {
    let gone = || {
        ApiError::NotFound(format!(
            "access request '{id}' not found in project '{project}'"
        ))
    };
    if !is_dns1123(project) || !requests::is_id(id) {
        return Err(gone());
    }
    let effective = crate::permissions::for_request(state, &user.0.identity, project);
    if !effective.may_read_project() {
        return Err(gone());
    }
    let request = requests::get(pool(state)?, project, id)
        .await
        .map_err(store_error)?
        .ok_or_else(gone)?;
    if !effective.may_read_in("ContextSpace", Some(&request.space)) {
        return Err(gone());
    }
    if !effective.may_in("ContextSpace", Verb::Approve, Some(&request.space)) {
        return Err(ApiError::Denied(format!(
            "only an owner of context space '{}' decides its access requests (PL-91)",
            request.space
        )));
    }
    Ok(request)
}

/// Records one step of a request in the activity of both projects.
async fn record(state: &AppState, user: &CurrentUser, request: &AccessRequest, what: &str) {
    let actor = &user.0.identity.username;
    let details = json!({
        "actor": actor,
        "action": what,
        "request": request.id,
        "pipeline": { "project": request.project, "name": request.pipeline },
        "endpoint": { "project": request.endpoint_project, "name": request.endpoint },
    });
    let event = |project: &str, space: Option<&str>| crate::activity::ActivityEvent {
        time: chrono::Utc::now(),
        project: project.to_owned(),
        space: space.map(str::to_owned),
        kind: "access-request".to_owned(),
        source: "portal".to_owned(),
        summary: format!(
            "{actor} {what}: pipeline {}/{} on endpoint {}/{}",
            request.project, request.pipeline, request.endpoint_project, request.endpoint
        ),
        severity: "info".to_owned(),
        correlation_id: None,
        details: details.clone(),
    };
    let events = [
        event(&request.endpoint_project, Some(&request.space)),
        event(&request.project, None),
    ];
    if let Err(err) = state.activity.append(&events).await {
        tracing::warn!(error = %err, "an access request step was not recorded");
    }
}

/// Proposes `manifests` into `project` as the caller, checked first as every import is (PF-57).
async fn propose(
    state: &AppState,
    user: &CurrentUser,
    project: &str,
    manifests: Vec<Value>,
) -> Result<Value, ApiError> {
    let bytes = serde_json::to_vec(&manifests).map_err(|e| ApiError::Internal(e.to_string()))?;
    for dry_run in [true, false] {
        let options: crate::api::import::ImportOptions =
            serde_json::from_value(json!({ "conflictPolicy": "replace", "dryRun": dry_run }))
                .map_err(|e| ApiError::Internal(e.to_string()))?;
        let (_, answer) =
            crate::api::import::import_bundle(state, &user.0.identity, project, &bytes, options)
                .await?;
        if !dry_run {
            return Ok(answer);
        }
    }
    Err(ApiError::Internal(
        "the proposal ended without a Change".into(),
    ))
}

fn change_name(change: &Value) -> Option<&str> {
    change["metadata"]["name"].as_str()
}

fn policies_of(state: &AppState, project: &str) -> Vec<Value> {
    state
        .mirror
        .list(project, "Policy", &ListOptions::default())
        .items
        .into_iter()
        .filter_map(|policy| serde_json::to_value(policy).ok())
        .collect()
}

fn endpoint_of(state: &AppState, project: &str, name: &str) -> Option<Value> {
    (is_dns1123(project) && is_dns1123(name))
        .then(|| state.mirror.get(project, "Endpoint", name))
        .flatten()
        .and_then(|endpoint| serde_json::to_value(endpoint).ok())
}

#[utoipa::path(
    post,
    path = "/api/v1/projects/{project}/pipelines/{name}/access-requests",
    summary = "Request Access For A Pipeline",
    description = "Asks an owner of another space's Endpoint for the pipeline's read or write there (PL-90). Grants nothing until an owner approves it.",
    tag = "pipelines",
    params(
        ("project" = String, Path, description = "The pipeline's project"),
        ("name" = String, Path, description = "The pipeline"),
    ),
    request_body = NewRequest,
    responses(
        (status = 201, description = "The request, pending", body = Object),
        (status = 400, description = "The request names too much, too little or a bad name", body = crate::error::ProblemDetails),
        (status = 403, description = "The caller may not propose this pipeline", body = crate::error::ProblemDetails),
        (status = 404, description = "No such pipeline or endpoint", body = crate::error::ProblemDetails),
        (status = 409, description = "Already granted, already asked, or the deployment's streams share one account", body = crate::error::ProblemDetails),
        (status = 503, description = "No database", body = crate::error::ProblemDetails),
    )
)]
pub(crate) async fn file_request(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((project, pipeline)): Path<(String, String)>,
    body: Result<Json<NewRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    proposable_pipeline(&state, &user, &project, &pipeline, true)?;
    let Json(body) = body.map_err(|e| ApiError::BadRequest(e.body_text()))?;
    let requested_at = now();
    let request = new_request(&state, &user, (&project, &pipeline), body, requested_at)?;
    if !requests::insert(pool(&state)?, &request)
        .await
        .map_err(store_error)?
    {
        return Err(ApiError::Conflict(format!(
            "pipeline '{pipeline}' already has an open or granted request for endpoint '{}/{}'",
            request.endpoint_project, request.endpoint
        )));
    }
    record(&state, &user, &request, "asked for access").await;
    Ok((StatusCode::CREATED, Json(request.view(requested_at))).into_response())
}

/// The request as it will be stored, or why it is refused (PL-90).
fn new_request(
    state: &AppState,
    user: &CurrentUser,
    (project, pipeline): (&str, &str),
    body: NewRequest,
    at: OffsetDateTime,
) -> Result<AccessRequest, ApiError> {
    if !state.config.pipeline_identity {
        return Err(ApiError::Conflict(
            "this deployment runs every pipeline under the project's shared account, so a grant \
             would reach all of them; it needs JC_PORTAL_PIPELINE_IDENTITY=pipeline first (PL-19)"
                .into(),
        ));
    }
    let types = requests::checked_types(&body.types).map_err(ApiError::BadRequest)?;
    let until = requests::checked_until(body.until.as_deref(), at).map_err(ApiError::BadRequest)?;
    let reason = requests::reason(&body.reason).map_err(ApiError::BadRequest)?;
    let EndpointName {
        project: owner,
        name,
    } = body.endpoint;
    let endpoint = endpoint_of(state, &owner, &name).ok_or_else(|| {
        ApiError::NotFound(format!("endpoint '{name}' not found in project '{owner}'"))
    })?;
    let space = crate::resource::reference_name(&endpoint["spec"]["contextSpaceRef"])
        .map(str::to_owned)
        .ok_or_else(|| {
            ApiError::Conflict(format!("endpoint '{owner}/{name}' names no context space"))
        })?;
    let request = AccessRequest {
        id: requests::new_id(),
        project: project.to_owned(),
        pipeline: pipeline.to_owned(),
        endpoint_project: owner,
        endpoint: name,
        space,
        operations: body.operations,
        types,
        until,
        reason,
        state: "pending".into(),
        requested_by: user.0.identity.username.clone(),
        requested_at: at,
        decided_by: None,
        decided_at: None,
        decision_reason: None,
        change: None,
    };
    if !is_dns1123(&request.policy_name()) {
        return Err(ApiError::BadRequest(format!(
            "the grant's Policy name '{}' is longer than 63 characters; a shorter pipeline or endpoint name fits",
            request.policy_name()
        )));
    }
    let policies = policies_of(state, &request.endpoint_project);
    if requests::already_granted(
        &policies,
        &request.account(),
        &request.types,
        request.operations,
    ) {
        return Err(ApiError::Conflict(format!(
            "pipeline '{pipeline}' already holds this access on endpoint '{}/{}'",
            request.endpoint_project, request.endpoint
        )));
    }
    Ok(request)
}

#[utoipa::path(
    get,
    path = "/api/v1/projects/{project}/pipelines/{name}/access-requests",
    summary = "List A Pipeline's Access Requests",
    description = "The pipeline's requests and their state, outgoing (PL-90): names and the grant asked for, never the space's data.",
    tag = "pipelines",
    params(
        ("project" = String, Path, description = "The pipeline's project"),
        ("name" = String, Path, description = "The pipeline"),
    ),
    responses(
        (status = 200, description = "The requests, newest first", body = Object),
        (status = 404, description = "No such pipeline", body = crate::error::ProblemDetails),
        (status = 503, description = "No database", body = crate::error::ProblemDetails),
    )
)]
pub(crate) async fn list_outgoing(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((project, pipeline)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    proposable_pipeline(&state, &user, &project, &pipeline, false)?;
    let found = requests::outgoing(pool(&state)?, &project, &pipeline)
        .await
        .map_err(store_error)?;
    let at = now();
    Ok(Json(
        json!({ "items": found.iter().map(|r| r.view(at)).collect::<Vec<_>>() }),
    ))
}

#[utoipa::path(
    get,
    path = "/api/v1/projects/{project}/access-requests",
    summary = "List Access Requests Into A Project",
    description = "The requests into the spaces of this project the caller owns, incoming (PL-91).",
    tag = "spaces",
    params(("project" = String, Path, description = "The owning project")),
    responses(
        (status = 200, description = "The requests, newest first", body = Object),
        (status = 404, description = "No such project", body = crate::error::ProblemDetails),
        (status = 503, description = "No database", body = crate::error::ProblemDetails),
    )
)]
pub(crate) async fn list_incoming(
    user: CurrentUser,
    State(state): State<AppState>,
    Path(project): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let effective = crate::permissions::for_request(&state, &user.0.identity, &project);
    if !is_dns1123(&project) || !effective.may_read_project() {
        return Err(ApiError::NotFound(format!("project '{project}' not found")));
    }
    let found = requests::incoming(pool(&state)?, &project)
        .await
        .map_err(store_error)?;
    let at = now();
    let items: Vec<Value> = found
        .iter()
        .filter(|r| effective.may_in("ContextSpace", Verb::Approve, Some(&r.space)))
        .map(|r| r.view(at))
        .collect();
    Ok(Json(json!({ "items": items })))
}

#[utoipa::path(
    post,
    path = "/api/v1/projects/{project}/access-requests/{id}/approve",
    summary = "Approve An Access Request",
    description = "Proposes the grant as a Change of this project, authored by the caller: the Endpoint admitting the pipeline's project and one Policy for its account (PL-91). The requester may not approve their own request.",
    tag = "spaces",
    params(
        ("project" = String, Path, description = "The owning project"),
        ("id" = String, Path, description = "The request"),
    ),
    responses(
        (status = 202, description = "The Change that grants it", body = crate::change::Change),
        (status = 403, description = "Not an owner of the space, or the requester themself", body = crate::error::ProblemDetails),
        (status = 404, description = "No such request", body = crate::error::ProblemDetails),
        (status = 409, description = "Already decided, or the endpoint is gone", body = crate::error::ProblemDetails),
    )
)]
pub(crate) async fn approve_request(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((project, id)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    let request = owned_request(&state, &user, &project, &id).await?;
    if request.requested_by == user.0.identity.username {
        return Err(ApiError::SelfApproval(format!(
            "you filed access request {id}; another owner of space '{}' approves it (PL-91)",
            request.space
        )));
    }
    if request.state != "pending" {
        return Err(ApiError::Conflict(format!(
            "access request {id} is {} already",
            request.state
        )));
    }
    let endpoint = endpoint_of(&state, &project, &request.endpoint).ok_or_else(|| {
        ApiError::Conflict(format!(
            "endpoint '{}' is no longer in project '{project}'; decline the request",
            request.endpoint
        ))
    })?;
    let change = propose(
        &state,
        &user,
        &project,
        requests::grant_bundle(&request, &endpoint),
    )
    .await?;
    decided(
        &state,
        &user,
        &request,
        ("pending", "approved"),
        None,
        change_name(&change),
    )
    .await?;
    record(&state, &user, &request, "approved access").await;
    Ok((StatusCode::ACCEPTED, Json(change)).into_response())
}

/// Moves the request on; 409 when another owner moved it first.
async fn decided(
    state: &AppState,
    user: &CurrentUser,
    request: &AccessRequest,
    states: (&str, &str),
    reason: Option<&str>,
    change: Option<&str>,
) -> Result<(), ApiError> {
    let moved = requests::decide(
        pool(state)?,
        &request.id,
        states,
        &user.0.identity.username,
        reason,
        change,
    )
    .await
    .map_err(store_error)?;
    if moved {
        Ok(())
    } else {
        Err(ApiError::Conflict(format!(
            "access request {} was decided by someone else meanwhile",
            request.id
        )))
    }
}

fn decision(body: Result<Json<Decision>, JsonRejection>) -> Result<String, ApiError> {
    let Json(body) = body.map_err(|e| ApiError::BadRequest(e.body_text()))?;
    requests::reason(&body.reason).map_err(ApiError::BadRequest)
}

#[utoipa::path(
    post,
    path = "/api/v1/projects/{project}/access-requests/{id}/decline",
    summary = "Decline An Access Request",
    description = "Declines a pending request with a reason the requester reads (PL-91). Nothing is proposed.",
    tag = "spaces",
    params(
        ("project" = String, Path, description = "The owning project"),
        ("id" = String, Path, description = "The request"),
    ),
    request_body = Decision,
    responses(
        (status = 200, description = "The request, declined", body = Object),
        (status = 400, description = "No reason", body = crate::error::ProblemDetails),
        (status = 403, description = "Not an owner of the space", body = crate::error::ProblemDetails),
        (status = 404, description = "No such request", body = crate::error::ProblemDetails),
        (status = 409, description = "Already decided", body = crate::error::ProblemDetails),
    )
)]
pub(crate) async fn decline_request(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((project, id)): Path<(String, String)>,
    body: Result<Json<Decision>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let mut request = owned_request(&state, &user, &project, &id).await?;
    let reason = decision(body)?;
    decided(
        &state,
        &user,
        &request,
        ("pending", "declined"),
        Some(&reason),
        None,
    )
    .await?;
    record(&state, &user, &request, "declined access").await;
    request.state = "declined".into();
    request.decided_by = Some(user.0.identity.username.clone());
    request.decision_reason = Some(reason);
    Ok(Json(request.view(now())))
}

#[utoipa::path(
    post,
    path = "/api/v1/projects/{project}/access-requests/{id}/revoke",
    summary = "Revoke An Approved Access Request",
    description = "Proposes the grant's Policy ended now, and the Endpoint without the pipeline's project when nothing else names it (PL-93).",
    tag = "spaces",
    params(
        ("project" = String, Path, description = "The owning project"),
        ("id" = String, Path, description = "The request"),
    ),
    request_body = Decision,
    responses(
        (status = 202, description = "The Change that revokes it", body = crate::change::Change),
        (status = 400, description = "No reason", body = crate::error::ProblemDetails),
        (status = 403, description = "Not an owner of the space", body = crate::error::ProblemDetails),
        (status = 404, description = "No such request", body = crate::error::ProblemDetails),
        (status = 409, description = "Not approved", body = crate::error::ProblemDetails),
    )
)]
pub(crate) async fn revoke_request(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((project, id)): Path<(String, String)>,
    body: Result<Json<Decision>, JsonRejection>,
) -> Result<Response, ApiError> {
    let request = owned_request(&state, &user, &project, &id).await?;
    let reason = decision(body)?;
    if request.state != "approved" {
        return Err(ApiError::Conflict(format!(
            "access request {id} is {}, not approved",
            request.state
        )));
    }
    let endpoint = endpoint_of(&state, &project, &request.endpoint).unwrap_or(Value::Null);
    let manifests =
        requests::revoke_bundle(&request, &endpoint, &policies_of(&state, &project), now());
    if manifests.is_empty() {
        return Err(ApiError::Conflict(format!(
            "the grant of access request {id} is not on main yet; approve or close its Change first"
        )));
    }
    let change = propose(&state, &user, &project, manifests).await?;
    decided(
        &state,
        &user,
        &request,
        ("approved", "revoked"),
        Some(&reason),
        change_name(&change),
    )
    .await?;
    record(&state, &user, &request, "revoked access").await;
    Ok((StatusCode::ACCEPTED, Json(change)).into_response())
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/projects/{project}/pipelines/{name}/access-requests",
            post(file_request).get(list_outgoing),
        )
        .route("/projects/{project}/access-requests", get(list_incoming))
        .route(
            "/projects/{project}/access-requests/{id}/approve",
            post(approve_request),
        )
        .route(
            "/projects/{project}/access-requests/{id}/decline",
            post(decline_request),
        )
        .route(
            "/projects/{project}/access-requests/{id}/revoke",
            post(revoke_request),
        )
}
