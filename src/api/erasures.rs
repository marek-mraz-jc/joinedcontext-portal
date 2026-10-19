//! A data subject's rights in a space (API/01 §46, DM-124, DM-126, DM-127, T-4668): the export of
//! every Entity naming the subject with its history, and the erasure that reaches every copy.
//!
//! The space's owner runs them (`approve` on its ContextSpace). The subject's value travels in the
//! request body, never in a URL an access log keeps; the log holds its keyed hash only. Every
//! call needs a `reason` and is audited with it.

use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use jc_core::kinds::Verb;
use serde::Deserialize;
use serde_json::{json, Value};
use utoipa::ToSchema;

use crate::auth::CurrentUser;
use crate::erasure::{self, Group, SubjectClass};
use crate::error::ApiError;
use crate::resource::is_dns1123;
use crate::state::AppState;

/// A request about one data subject.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SubjectRequest {
    /// The value of the class's `dataSubjectRef` slot.
    pub subject: String,
    /// Why, for the audit record: the request's reference, the legal ground.
    pub reason: String,
}

/// The space's spec when the caller owns it; the 404 every unreadable space gets otherwise.
fn owned(
    state: &AppState,
    user: &CurrentUser,
    project: &str,
    space: &str,
) -> Result<Value, ApiError> {
    let effective = crate::permissions::for_request(state, &user.0.identity, project);
    let held = (is_dns1123(project) && is_dns1123(space))
        .then(|| state.mirror.get(project, "ContextSpace", space))
        .flatten()
        .filter(|_| {
            effective.may_read_project() && effective.may_read_in("ContextSpace", Some(space))
        })
        .ok_or_else(|| {
            ApiError::NotFound(format!(
                "context space '{space}' not found in project '{project}'"
            ))
        })?;
    if !effective.may_in("ContextSpace", Verb::Approve, Some(space)) {
        return Err(ApiError::Denied(format!(
            "only an owner of context space '{space}' runs a data subject's export and erasure (DM-124)"
        )));
    }
    Ok(held.spec)
}

/// The classes of the space's model that name a data subject.
async fn subject_classes(
    state: &AppState,
    (project, space): (&str, &str),
    spec: &Value,
) -> Result<Vec<SubjectClass>, ApiError> {
    let model = crate::resource::reference_name(&spec["dataModelRef"])
        .map(str::to_owned)
        .ok_or_else(|| {
            ApiError::BadRequest(format!("context space '{space}' has no data model"))
        })?;
    let linkml = crate::api::datamodels::read_source(state, project, &model).await?;
    let classes = erasure::subject_classes(&linkml);
    if classes.is_empty() {
        return Err(ApiError::BadRequest(format!(
            "the model '{model}' names no data subject: a class needs the annotation dataSubjectRef (Architecture/11 §9)"
        )));
    }
    if let Some(why) = erasure::hashed_refusal(&classes) {
        return Err(ApiError::Conflict(why));
    }
    Ok(classes)
}

fn checked(body: Result<Json<SubjectRequest>, JsonRejection>) -> Result<SubjectRequest, ApiError> {
    let Json(request) = body.map_err(|e| ApiError::BadRequest(e.body_text()))?;
    let reason = request.reason.trim();
    if reason.is_empty() || reason.chars().count() > erasure::MAX_REASON {
        return Err(ApiError::BadRequest(format!(
            "reason is required, at most {} characters (reason-required)",
            erasure::MAX_REASON
        )));
    }
    if let Some(why) = erasure::subject_refusal(&request.subject) {
        return Err(ApiError::BadRequest(why));
    }
    Ok(request)
}

/// The Entities of each class naming the subject, read through the space surface as the
/// Portal's own account.
async fn named(
    state: &AppState,
    project: &str,
    space: &str,
    classes: &[SubjectClass],
    subject: &str,
) -> Result<(String, Vec<(SubjectClass, Vec<Value>)>), ApiError> {
    let watch = state.drift_watch.as_ref().ok_or_else(no_surface)?;
    let unavailable = |reason: String| {
        tracing::warn!(%reason, "a space was not read for a data subject");
        ApiError::Unavailable("the space did not answer; try again shortly".into())
    };
    let token = watch.scan_token().await.map_err(unavailable)?;
    let segment = crate::spaces::segment(&state.mirror, project, space);
    let mut found = Vec::new();
    for class in classes {
        let q = erasure::subject_query(&class.slot, subject);
        let entities = watch
            .named(&token, &segment, &class.class, &q)
            .await
            .map_err(unavailable)?;
        found.push((class.clone(), entities));
    }
    Ok((token, found))
}

fn no_surface() -> ApiError {
    ApiError::Unavailable("this Portal reads no space surface (no gateway or realm client)".into())
}

async fn audited(
    state: &AppState,
    user: &CurrentUser,
    project: &str,
    space: &str,
    what: &str,
    details: Value,
) {
    let actor = &user.0.identity.username;
    let event = crate::activity::ActivityEvent {
        time: chrono::Utc::now(),
        project: project.to_owned(),
        space: Some(space.to_owned()),
        kind: "personal-data".to_owned(),
        source: "portal".to_owned(),
        summary: format!("{actor} {what}"),
        severity: "info".to_owned(),
        correlation_id: None,
        details: json!({ "actor": actor, "action": what, "of": details }),
    };
    if let Err(err) = state.activity.append(&[event]).await {
        tracing::warn!(error = %err, "a data subject's request was not recorded");
    }
}

fn subject_key(state: &AppState) -> Result<&str, ApiError> {
    state
        .config
        .artifact_store
        .as_ref()
        .map(|settings| settings.root_secret_key.as_str())
        .ok_or_else(|| {
            ApiError::Unavailable(
                "this Portal holds no key to hash a data subject with (JC_PORTAL_ARTIFACT_STORE_SECRET_KEY)".into(),
            )
        })
}

#[utoipa::path(
    post,
    path = "/api/v1/projects/{project}/spaces/{space}/subjects/export",
    summary = "Export a Data Subject",
    description = "Every Entity of the space naming the data subject in its class's `dataSubjectRef` slot, current state and stored history, answered to the caller's session alone (DM-124). The subject is in the body, never the URL. For the space's owners; audited with the reason.",
    tag = "spaces",
    params(
        ("project" = String, Path, description = "Project name"),
        ("space" = String, Path, description = "Context Space name"),
    ),
    request_body(content = SubjectRequest, example = json!({"subject": "r-42", "reason": "Art. 15 request 2026-10-19-07"})),
    responses(
        (status = 200, description = "The subject's Entities with their history", body = Object),
        (status = 400, description = "No reason, a subject that cannot be searched for, or a model that names no subject", body = crate::error::ProblemDetails),
        (status = 401, description = "Not signed in", body = crate::error::ProblemDetails),
        (status = 403, description = "The caller reads the space but does not own it", body = crate::error::ProblemDetails),
        (status = 404, description = "No such space the caller may read", body = crate::error::ProblemDetails),
        (status = 409, description = "The subject slot is ingested as keyedHash and the Portal does not hold the space's key yet", body = crate::error::ProblemDetails),
        (status = 503, description = "The space or the key is not available", body = crate::error::ProblemDetails),
    )
)]
pub(crate) async fn export_subject(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((project, space)): Path<(String, String)>,
    body: Result<Json<SubjectRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    let spec = owned(&state, &user, &project, &space)?;
    let request = checked(body)?;
    let hash = erasure::subject_hash(subject_key(&state)?, &project, &space, &request.subject);
    let classes = subject_classes(&state, (&project, &space), &spec).await?;
    let (token, found) = named(&state, &project, &space, &classes, &request.subject).await?;
    let watch = state.drift_watch.as_ref().ok_or_else(no_surface)?;
    let segment = crate::spaces::segment(&state.mirror, &project, &space);
    let mut entities = Vec::new();
    for (class, held) in found {
        for entity in held {
            let id = entity["id"].as_str().unwrap_or_default().to_owned();
            let history = watch
                .history(&token, &segment, &id)
                .await
                .map_err(|reason| {
                    tracing::warn!(%reason, "an Entity's history was not read for an export");
                    ApiError::Unavailable(
                        "the space's history did not answer; try again shortly".into(),
                    )
                })?;
            entities.push(json!({ "class": class.class, "entity": entity, "history": history }));
        }
    }
    audited(
        &state,
        &user,
        &project,
        &space,
        "exported a data subject's records",
        json!({ "subject": hash, "reason": request.reason.trim(), "entities": entities.len() }),
    )
    .await;
    let body = json!({
        "space": space,
        "subject": hash,
        "exportedAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        "entities": entities,
    });
    // An answer to this session only: never kept by a cache on the way.
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(body)).into_response())
}

#[utoipa::path(
    post,
    path = "/api/v1/projects/{project}/spaces/{space}/erasures",
    summary = "Erase a Data Subject",
    description = "Erases the data subject from the space: the personal Attributes (or the whole Entity of a personal class) of every Entity naming it, from the broker's current state and every version, the CKAN DataStore copy, the Portal's trash and comments and the assistant's stored conversations (DM-126). Answers at once with the erasure, which stays open until every store reports done; the erasure log keeps the subject's keyed hash, never the value (DM-127). For the space's owners; audited with the reason.",
    tag = "spaces",
    params(
        ("project" = String, Path, description = "Project name"),
        ("space" = String, Path, description = "Context Space name"),
    ),
    request_body(content = SubjectRequest, example = json!({"subject": "r-42", "reason": "Art. 17 request 2026-10-19-07"})),
    responses(
        (status = 202, description = "The erasure, its Location and its state per store", body = Object),
        (status = 400, description = "No reason, a subject that cannot be searched for, or a model that names no subject", body = crate::error::ProblemDetails),
        (status = 401, description = "Not signed in", body = crate::error::ProblemDetails),
        (status = 403, description = "The caller reads the space but does not own it", body = crate::error::ProblemDetails),
        (status = 404, description = "No such space the caller may read", body = crate::error::ProblemDetails),
        (status = 409, description = "The subject slot is ingested as keyedHash and the Portal does not hold the space's key yet", body = crate::error::ProblemDetails),
        (status = 503, description = "No database, space surface or key", body = crate::error::ProblemDetails),
    )
)]
pub(crate) async fn erase_subject(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((project, space)): Path<(String, String)>,
    body: Result<Json<SubjectRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    let spec = owned(&state, &user, &project, &space)?;
    let request = checked(body)?;
    let pool = state.db.clone().ok_or_else(|| {
        ApiError::Unavailable("this Portal keeps no erasure log (no database)".into())
    })?;
    let hash = erasure::subject_hash(subject_key(&state)?, &project, &space, &request.subject);
    let classes = subject_classes(&state, (&project, &space), &spec).await?;
    let (_, found) = named(&state, &project, &space, &classes, &request.subject).await?;
    let groups = found
        .into_iter()
        .map(|(class, held)| Group {
            class: class.class,
            entities: held
                .iter()
                .filter_map(|e| e["id"].as_str().map(str::to_owned))
                .collect(),
            attrs: class.attrs,
        })
        .collect();
    let actor = format!("user:{}", user.0.identity.username);
    let mut started = erasure::begin(
        (&project, &space),
        hash.clone(),
        &request.reason,
        &actor,
        groups,
    );
    erasure::insert(&pool, &started).await.map_err(|err| {
        tracing::warn!(error = %err, "an erasure was not logged");
        ApiError::Unavailable("the erasure log could not be written; nothing was erased".into())
    })?;
    audited(
        &state,
        &user,
        &project,
        &space,
        "erased a data subject",
        json!({ "subject": hash, "reason": request.reason.trim(), "erasure": started.id, "entities": started.urns().len() }),
    )
    .await;
    erasure::attempt(&state, &pool, &started, Some(&request.subject)).await;
    if let Ok(Some(now)) = erasure::get(&pool, &project, &space, &started.id).await {
        started = now;
    }
    let location = format!(
        "/api/v1/projects/{project}/spaces/{space}/erasures/{}",
        started.id
    );
    Ok((
        StatusCode::ACCEPTED,
        [(header::LOCATION, location)],
        Json(started.view()),
    )
        .into_response())
}

#[utoipa::path(
    get,
    path = "/api/v1/projects/{project}/spaces/{space}/erasures/{id}",
    summary = "Read an Erasure",
    description = "One erasure of the space: `open` until every store reports done, `done`, or `failed` once a store gave up after an hour, with the counts and the state of each store (DM-126, DM-127). For the space's owners.",
    tag = "spaces",
    params(
        ("project" = String, Path, description = "Project name"),
        ("space" = String, Path, description = "Context Space name"),
        ("id" = String, Path, description = "The erasure's id"),
    ),
    responses(
        (status = 200, description = "The erasure", body = Object),
        (status = 401, description = "Not signed in", body = crate::error::ProblemDetails),
        (status = 403, description = "The caller reads the space but does not own it", body = crate::error::ProblemDetails),
        (status = 404, description = "No such space or erasure", body = crate::error::ProblemDetails),
        (status = 503, description = "No database", body = crate::error::ProblemDetails),
    )
)]
pub(crate) async fn get_erasure(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((project, space, id)): Path<(String, String, String)>,
) -> Result<Json<Value>, ApiError> {
    owned(&state, &user, &project, &space)?;
    let gone = || {
        ApiError::NotFound(format!(
            "erasure '{id}' not found in context space '{space}'"
        ))
    };
    let pool = state.db.as_ref().ok_or_else(|| {
        ApiError::Unavailable("this Portal keeps no erasure log (no database)".into())
    })?;
    if !erasure::is_id(&id) {
        return Err(gone());
    }
    erasure::get(pool, &project, &space, &id)
        .await
        .map_err(|err| {
            tracing::warn!(error = %err, "the erasure log was not read");
            ApiError::Unavailable("the erasure log could not be read".into())
        })?
        .map(|found| Json(found.view()))
        .ok_or_else(gone)
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/projects/{project}/spaces/{space}/subjects/export",
            post(export_subject),
        )
        .route(
            "/projects/{project}/spaces/{space}/erasures",
            post(erase_subject),
        )
        .route(
            "/projects/{project}/spaces/{space}/erasures/{id}",
            get(get_erasure),
        )
}
