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
use serde::{Deserialize, Serialize};
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

/// The pipeline's space when the caller may propose it; 404 when they cannot read it.
fn proposable_pipeline(
    state: &AppState,
    user: &CurrentUser,
    project: &str,
    pipeline: &str,
    propose: bool,
) -> Result<Option<String>, ApiError> {
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
    Ok(space)
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
    if request.space.is_empty() || !effective.may_read_in("ContextSpace", Some(&request.space)) {
        return Err(gone());
    }
    if !effective.may_in("ContextSpace", Verb::Approve, Some(&request.space)) {
        return Err(ApiError::Denied(format!(
            "only an owner of context space '{}' decides its access requests (PL-91)",
            request.space
        )));
    }
    crate::auth::session::require_second_factor(&user.0.identity, &state.config)?;
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
    let mut events = vec![event(&request.project, None)];
    // A typed name that names no Endpoint has no owner to tell (T-4946).
    if !request.space.is_empty() {
        events.push(event(&request.endpoint_project, Some(&request.space)));
    }
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

/// One Endpoint a pipeline may ask for, as the request form offers it (PL-90, T-4946): names
/// and the model's types and attribute names, never the space's data.
#[derive(Debug, Serialize, ToSchema)]
pub struct Requestable {
    pub project: String,
    pub name: String,
    pub space: String,
    /// The classes of the space's compiled model with their attribute names; empty when the
    /// space has no compiled model, and then the request cannot name a type yet.
    pub types: Vec<RequestableType>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct RequestableType {
    #[serde(rename = "type")]
    pub entity_type: String,
    pub attrs: Vec<String>,
}

/// The Context Space of `endpoint` when it is another space than the pipeline's own.
fn other_space<'a>(
    (project, space): (&str, Option<&str>),
    endpoint: &'a crate::resource::ResourceEnvelope,
) -> Option<&'a str> {
    let owner = endpoint.metadata.namespace.as_deref().unwrap_or_default();
    let endpoint_space = crate::resource::reference_name(&endpoint.spec["contextSpaceRef"])?;
    (endpoint.kind == "Endpoint" && !(owner == project && Some(endpoint_space) == space))
        .then_some(endpoint_space)
}

/// Whether the request form offers `endpoint` to the pipeline of `project` on `space`, with what
/// it may name there (PL-90, T-4946): an Endpoint of another Context Space that the caller may
/// read in its project, or whose audience is the organization or the public. The form's list and
/// the door's model check use this one rule, so neither tells the caller of an Endpoint, a type or
/// an attribute they may not read (PF-59, PF-61).
fn requestable(
    state: &AppState,
    user: &CurrentUser,
    pipeline: (&str, Option<&str>),
    endpoint: &crate::resource::ResourceEnvelope,
) -> Option<Requestable> {
    let owner = endpoint.metadata.namespace.as_deref().unwrap_or_default();
    let name = endpoint.metadata.name.as_str();
    if !is_dns1123(owner) || !is_dns1123(name) {
        return None;
    }
    let endpoint_space = other_space(pipeline, endpoint)?;
    let open = matches!(
        endpoint.spec["audience"].as_str(),
        Some("organization" | "public")
    );
    let readable = || {
        let effective = crate::permissions::for_request(state, &user.0.identity, owner);
        effective.may_read_project() && effective.may_read_in("Endpoint", Some(endpoint_space))
    };
    if !open && !readable() {
        return None;
    }
    let types = state
        .model_schemas
        .get(owner, endpoint_space)
        .map(|model| {
            model
                .classes
                .keys()
                .map(|class| RequestableType {
                    entity_type: class.clone(),
                    attrs: model
                        .attributes(class)
                        .map(|found| found.attributes.iter().map(|a| a.name.clone()).collect())
                        .unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_default();
    Some(Requestable {
        project: owner.to_owned(),
        name: name.to_owned(),
        space: endpoint_space.to_owned(),
        types,
    })
}

/// The types and attributes of `types` that `endpoint` does not serve, one line each naming the
/// field; nothing when the space has no compiled model, whose owner judges the names instead.
fn unserved(endpoint: &Requestable, types: &[requests::TypeGrant]) -> Vec<String> {
    if endpoint.types.is_empty() {
        return Vec::new();
    }
    let mut problems = Vec::new();
    for (at, grant) in types.iter().enumerate() {
        let Some(served) = endpoint
            .types
            .iter()
            .find(|t| t.entity_type == grant.entity_type)
        else {
            problems.push(format!(
                "types[{at}].type: '{}' is no type of endpoint '{}/{}'",
                grant.entity_type, endpoint.project, endpoint.name
            ));
            continue;
        };
        for attr in grant.attrs.iter().filter(|a| !served.attrs.contains(a)) {
            problems.push(format!(
                "types[{at}].attrs: '{attr}' is no attribute of {} at endpoint '{}/{}'",
                grant.entity_type, endpoint.project, endpoint.name
            ));
        }
    }
    problems
}

#[utoipa::path(
    get,
    path = "/api/v1/projects/{project}/pipelines/{name}/access-requests/endpoints",
    summary = "List The Endpoints A Pipeline May Ask For",
    description = "The Endpoints of other Context Spaces the caller may read, or whose audience is the organization or the public, each with the types and attribute names of its space's model (PL-90): the request form's choices. Any other Endpoint is asked for by its typed name. Names only, never data.",
    tag = "pipelines",
    params(
        ("project" = String, Path, description = "The pipeline's project"),
        ("name" = String, Path, description = "The pipeline"),
    ),
    responses(
        (status = 200, description = "`{ items }` of the Endpoints, by project and name", body = Object),
        (status = 403, description = "The caller may not propose this pipeline", body = crate::error::ProblemDetails),
        (status = 404, description = "No such pipeline", body = crate::error::ProblemDetails),
    )
)]
pub(crate) async fn list_requestable(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((project, pipeline)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let space = proposable_pipeline(&state, &user, &project, &pipeline, true)?;
    let mut items: Vec<Requestable> = state
        .mirror
        .matching(|env| env.kind == "Endpoint")
        .iter()
        .filter_map(|endpoint| requestable(&state, &user, (&project, space.as_deref()), endpoint))
        .collect();
    items.sort_by(|a, b| (&a.project, &a.name).cmp(&(&b.project, &b.name)));
    Ok(Json(json!({ "items": items })))
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
    request_body(
        content = NewRequest,
        content_type = "application/json",
        example = json!({ "endpoint": { "project": "helsinki", "name": "air-quality" }, "operations": "read", "types": [{ "type": "AirQualityObserved", "attrs": ["pm10", "no2"] }], "until": "2027-01-01T00:00:00Z", "reason": "Daily air-quality KPI for the city board" })
    ),
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
    let space = proposable_pipeline(&state, &user, &project, &pipeline, true)?;
    let Json(body) = body.map_err(|e| ApiError::BadRequest(e.body_text()))?;
    let requested_at = now();
    let request = new_request(
        &state,
        &user,
        (&project, &pipeline, space.as_deref()),
        body,
        requested_at,
    )?;
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
    Ok((StatusCode::CREATED, Json(outgoing(&request, requested_at))).into_response())
}

/// The request as its pipeline's side reads it: without the Endpoint's space, which would tell
/// whether a typed name exists (T-4946).
fn outgoing(request: &AccessRequest, at: OffsetDateTime) -> Value {
    let mut view = request.view(at);
    if let Some(fields) = view.as_object_mut() {
        fields.remove("space");
    }
    view
}

/// The request as it will be stored, or why it is refused (PL-90).
fn new_request(
    state: &AppState,
    user: &CurrentUser,
    (project, pipeline, pipeline_space): (&str, &str, Option<&str>),
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
    if !is_dns1123(&owner) || !is_dns1123(&name) {
        return Err(ApiError::BadRequest(format!(
            "endpoint.name: '{owner}/{name}' is no project and endpoint name (lowercase letters, digits and '-')"
        )));
    }
    let held = state.mirror.get(&owner, "Endpoint", &name);
    // The pipeline's own project and space are the caller's to read: saying so leaks nothing.
    if owner == project
        && held
            .as_ref()
            .is_some_and(|endpoint| other_space((project, pipeline_space), endpoint).is_none())
    {
        return Err(ApiError::BadRequest(format!(
            "endpoint.name: endpoint '{name}' serves the pipeline's own space; a pipeline writes and reads its own space without a request"
        )));
    }
    let offered = held
        .as_ref()
        .and_then(|endpoint| requestable(state, user, (project, pipeline_space), endpoint));
    // T-4946: a name the form offers is checked against its model here. Any other typed name, an
    // Endpoint the caller may not read or one that does not exist, gets the same answer: the
    // request waits, unchecked, for an owner of the Endpoint's space, who judges its types and
    // attributes. A name that exists nowhere waits with no space, where no owner ever sees it.
    let space = match offered {
        Some(endpoint) => {
            let unserved = unserved(&endpoint, &types);
            if !unserved.is_empty() {
                return Err(ApiError::Invalid {
                    detail: format!(
                        "the request names types or attributes endpoint '{owner}/{name}' does not serve (PL-90)"
                    ),
                    errors: unserved,
                });
            }
            Some(endpoint.space)
        }
        None => None,
    };
    let checked = space.is_some();
    let space = space
        .or_else(|| {
            held.as_ref()
                .and_then(|endpoint| other_space((project, pipeline_space), endpoint))
                .map(str::to_owned)
        })
        .unwrap_or_default();
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
    if checked
        && requests::already_granted(
            &policies,
            &request.account(),
            &request.types,
            request.operations,
        )
    {
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
        json!({ "items": found.iter().map(|r| outgoing(r, at)).collect::<Vec<_>>() }),
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
        .filter(|r| {
            !r.space.is_empty() && effective.may_in("ContextSpace", Verb::Approve, Some(&r.space))
        })
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
    request_body(
        content = Decision,
        content_type = "application/json",
        example = json!({ "reason": "The KPI project ended" })
    ),
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
    // Declining closes the request for good, so it is a person's in a Portal session; approving
    // and revoking only propose a Change a person still approves (AG-133, PF-58).
    if user.0.identity.client.is_some() {
        return Err(ApiError::Denied(
            "an access request is declined by a person in the Portal, never with a service \
             account's or an agent's token (AG-133, PF-58)"
                .into(),
        ));
    }
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
    request_body(
        content = Decision,
        content_type = "application/json",
        example = json!({ "reason": "The KPI project ended" })
    ),
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
        .route(
            "/projects/{project}/pipelines/{name}/access-requests/endpoints",
            get(list_requestable),
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
