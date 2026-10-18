//! The knowledge assistant's administration in the Portal (API/01 §34, T-3057, AG-113): what a
//! project's `KnowledgeSource`s hold once crawled, read and steered here, answered by
//! `jc-assistant`'s internal paths. The caller's permission is checked first and nothing reaches
//! the assistant for a caller who lacks it; the assistant is asked with the Portal's own token.

use std::time::Duration;

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use jc_core::kinds::assistant::{KnowledgeSourceSpec, SourceType};
use jc_core::kinds::Verb;
use serde::Deserialize;
use serde_json::{json, Value};
use utoipa::{IntoParams, ToSchema};

use crate::auth::CurrentUser;
use crate::error::ApiError;
use crate::resource::is_dns1123;
use crate::state::AppState;
use crate::store::ListOptions;

/// The most ids one inclusion call may name.
pub const MAX_IDS: usize = 500;

/// One level of the page tree.
#[derive(Debug, Deserialize, IntoParams)]
#[serde(deny_unknown_fields)]
pub struct Level {
    /// The page whose children to list; none lists the roots.
    pub parent: Option<i64>,
    /// Instead of one level: at most 100 pages of the whole source whose title or address holds
    /// it, case and diacritics ignored; 2 to 100 characters (UI-99).
    pub q: Option<String>,
}

/// A trial of the search `search_documents` runs, over one source (UI-99, T-4659).
#[derive(Debug, Deserialize, IntoParams)]
#[serde(deny_unknown_fields)]
pub struct Tried {
    /// 1 to 300 characters.
    pub q: String,
    /// 1 to 10 hits, 5 when absent.
    pub limit: Option<u8>,
}

/// The page or the document whose passages to show; exactly one.
#[derive(Debug, Deserialize, IntoParams)]
#[serde(deny_unknown_fields)]
pub struct PassagesOf {
    pub page: Option<i64>,
    pub document: Option<i64>,
}

/// Include or exclude pages, their subtrees, and documents (API/01 §34).
#[derive(Debug, Deserialize, serde::Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct InclusionRequest {
    /// Page ids of this source.
    #[serde(default)]
    pub pages: Vec<i64>,
    /// Document ids of this source.
    #[serde(default)]
    pub documents: Vec<i64>,
    /// Whether every page below the named ones, and the documents they link, change too.
    #[serde(default)]
    pub subtree: bool,
    /// `false` excludes: their passages go at once and the choice holds over later crawls.
    pub included: bool,
}

/// One turn of what the person's chat holds (API/05 §1.1).
#[derive(Debug, Deserialize, serde::Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ChatTurn {
    /// `user` or `assistant`.
    pub role: String,
    pub text: String,
}

/// A question to an assistant (API/05 §1.1); `jc-assistant` holds every bound.
#[derive(Debug, Deserialize, serde::Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ChatRequest {
    /// The id the first answer gave, to continue its conversation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation: Option<String>,
    /// 1 to 4,000 characters.
    pub message: String,
    /// At most 6 earlier turns.
    #[serde(default)]
    pub history: Vec<ChatTurn>,
    /// The connectors switched on; none sent leaves every one on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connectors: Option<Vec<String>>,
}

/// The largest question body (API/05 §1.1).
const MAX_CHAT_BODY: usize = 64 * 1024;
/// The largest upload: the most any source's `upload.maxBytes` allows (T-4184).
const MAX_UPLOAD_BODY: usize = jc_core::kinds::assistant::MAX_UPLOAD_BYTES as usize;
/// The longest an answer may take: six model calls and their tools (AG-107).
const CHAT_TIMEOUT: Duration = Duration::from_secs(300);

/// Read access to the project's sources, or not there at all (R20).
fn readable(state: &AppState, user: &CurrentUser, project: &str) -> Result<(), ApiError> {
    let effective = crate::permissions::for_request(state, &user.0.identity, project);
    if is_dns1123(project) && effective.may_read_project() && effective.may_read("KnowledgeSource")
    {
        Ok(())
    } else {
        Err(ApiError::NotFound(format!("project '{project}' not found")))
    }
}

/// Write access: proposing a `KnowledgeSource` is what steering one takes (AG-113).
fn writable(state: &AppState, user: &CurrentUser, project: &str) -> Result<(), ApiError> {
    readable(state, user, project)?;
    crate::permissions::for_request(state, &user.0.identity, project).check(
        "KnowledgeSource",
        Verb::Propose,
        None,
    )
}

fn named(what: &str, name: &str) -> Result<(), ApiError> {
    if is_dns1123(name) {
        Ok(())
    } else {
        Err(ApiError::NotFound(format!("{what} '{name}' not found")))
    }
}

/// One client for the assistant, without redirects: its address is configuration, and the
/// Portal's token goes nowhere else.
fn http() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_default()
    })
}

/// Asks `jc-assistant` at `path` (under `/internal/v1/projects/`) with the Portal's own token and
/// returns its status and body. Its `401` is this Portal's misconfiguration, not the caller's.
async fn ask(
    state: &AppState,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> Result<(StatusCode, Value), ApiError> {
    let with = move |request: reqwest::RequestBuilder| match body {
        Some(body) => request.json(&body),
        None => request,
    };
    ask_with(state, method, path, Duration::from_secs(20), with).await
}

/// [`ask`] with the request's body and time limit chosen by the caller: an upload's raw bytes.
async fn ask_with(
    state: &AppState,
    method: reqwest::Method,
    path: &str,
    timeout: Duration,
    with: impl FnOnce(reqwest::RequestBuilder) -> reqwest::RequestBuilder,
) -> Result<(StatusCode, Value), ApiError> {
    let base = state.config.knowledge_url.as_deref().ok_or_else(|| {
        ApiError::Unavailable(
            "this Portal has no knowledge assistant address (JC_PORTAL_KNOWLEDGE_URL)".into(),
        )
    })?;
    let oidc = state.oidc.as_ref().ok_or_else(|| {
        ApiError::Unavailable("this Portal has no Keycloak client to ask the assistant with".into())
    })?;
    let token = oidc.service_token().await.map_err(|err| {
        ApiError::Unavailable(format!("no token for the knowledge assistant: {err}"))
    })?;
    let request = http()
        .request(method, format!("{base}/internal/v1/projects/{path}"))
        .bearer_auth(token)
        .timeout(timeout);
    let answer = with(request).send().await.map_err(|err| {
        tracing::warn!(error = %err.without_url(), "the knowledge assistant did not answer");
        ApiError::Unavailable("the knowledge assistant did not answer; try again shortly".into())
    })?;
    let status = StatusCode::from_u16(answer.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let body: Value = answer.json().await.unwrap_or(Value::Null);
    let detail = || {
        body.get("detail")
            .and_then(Value::as_str)
            .unwrap_or("no reason given")
            .to_owned()
    };
    match status.as_u16() {
        200..=299 => Ok((status, body)),
        400 => Err(ApiError::BadRequest(detail())),
        404 => Err(ApiError::NotFound(detail())),
        409 => Err(ApiError::Conflict(detail())),
        413 => Err(ApiError::TooLarge(detail())),
        415 => Err(ApiError::UnsupportedMediaType(detail())),
        401 | 403 => {
            tracing::error!("the knowledge assistant refused the Portal's own token");
            Err(ApiError::Unavailable(
                "the knowledge assistant does not accept this Portal's token".into(),
            ))
        }
        _ => Err(ApiError::Unavailable(format!(
            "the knowledge assistant answered {status}"
        ))),
    }
}

/// What a source is, from its manifest: for the list, beside what it holds.
fn summary(name: &str, spec: &KnowledgeSourceSpec) -> Value {
    json!({
        "source": name,
        "type": match spec.source {
            SourceType::Website => "website",
            SourceType::Ckan => "ckan",
            SourceType::Catalogue => "catalogue",
            SourceType::Guide => "guide",
            SourceType::Upload => "upload",
        },
        "startUrls": spec.start_urls,
        // The spaces a catalogue source reads; empty is every space of the project (AG-116).
        "contextSpaces": spec.context_spaces,
        "ckanInstanceRef": spec.ckan_instance_ref,
        // The CKAN organizations a ckan source narrows to; empty is every one (MF-51).
        "organizations": spec.organizations,
        "schedule": spec.schedule,
        "visibility": spec.visibility,
        "include": spec.include,
        "exclude": spec.exclude,
    })
}

#[utoipa::path(
    get,
    path = "/api/v1/projects/{project}/knowledge/sources",
    summary = "List Knowledge Sources",
    description = "Every KnowledgeSource the project declares, with what the assistant holds of it: pages, documents, passages, the last crawl and the last job; `state: not-crawled` before its first crawl (API/01 §34).",
    tag = "knowledge",
    params(("project" = String, Path, description = "Project name")),
    responses(
        (status = 200, description = "The sources", body = Object),
        (status = 401, description = "Not signed in", body = crate::error::ProblemDetails),
        (status = 404, description = "No such project the caller may read the sources of", body = crate::error::ProblemDetails),
        (status = 503, description = "The knowledge assistant is not reachable", body = crate::error::ProblemDetails),
    )
)]
pub async fn list_sources(
    user: CurrentUser,
    State(state): State<AppState>,
    Path(project): Path<String>,
) -> Result<Json<Value>, ApiError> {
    readable(&state, &user, &project)?;
    let (_, held) = ask(
        &state,
        reqwest::Method::GET,
        &format!("{project}/knowledge/sources"),
        None,
    )
    .await?;
    let held = held
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let items: Vec<Value> = state
        .mirror
        .list(&project, "KnowledgeSource", &ListOptions::default())
        .items
        .into_iter()
        .filter_map(|env| {
            let spec: KnowledgeSourceSpec = serde_json::from_value(env.spec).ok()?;
            let mut item = summary(&env.metadata.name, &spec);
            match held.iter().find(|h| {
                h.get("source").and_then(Value::as_str) == Some(env.metadata.name.as_str())
            }) {
                Some(found) => {
                    for key in [
                        "state",
                        "lastCrawl",
                        "pages",
                        "pagesIncluded",
                        "documents",
                        "passages",
                        "embedded",
                        "pending",
                        "failed",
                        "languages",
                        "job",
                    ] {
                        item[key] = found.get(key).cloned().unwrap_or(Value::Null);
                    }
                }
                None => item["state"] = json!("not-crawled"),
            }
            Some(item)
        })
        .collect();
    Ok(Json(json!({ "items": items })))
}

#[utoipa::path(
    get,
    path = "/api/v1/projects/{project}/knowledge/sources/{source}/pages",
    summary = "Read A Level Of The Page Tree",
    description = "The pages under `parent`, or the roots without it, or with `q` at most 100 pages of the whole source whose title or address holds it: depth, status, language, title, description, published and modified, whether included and who excluded it, and how many children, documents and passages each holds.",
    tag = "knowledge",
    params(
        ("project" = String, Path, description = "Project name"),
        ("source" = String, Path, description = "KnowledgeSource name"),
        Level,
    ),
    responses(
        (status = 200, description = "The pages", body = Object),
        (status = 400, description = "`q` is not 2 to 100 characters", body = crate::error::ProblemDetails),
        (status = 401, description = "Not signed in", body = crate::error::ProblemDetails),
        (status = 404, description = "No such project or crawled source", body = crate::error::ProblemDetails),
        (status = 503, description = "The knowledge assistant is not reachable", body = crate::error::ProblemDetails),
    )
)]
pub async fn list_pages(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((project, source)): Path<(String, String)>,
    Query(level): Query<Level>,
) -> Result<Json<Value>, ApiError> {
    readable(&state, &user, &project)?;
    named("source", &source)?;
    // The serializer is not `Send`: it ends before the await.
    let query = {
        let mut query = url::form_urlencoded::Serializer::new(String::new());
        if let Some(parent) = level.parent {
            query.append_pair("parent", &parent.to_string());
        }
        if let Some(q) = &level.q {
            query.append_pair("q", q);
        }
        query.finish()
    };
    let query = if query.is_empty() {
        query
    } else {
        format!("?{query}")
    };
    let (_, body) = ask(
        &state,
        reqwest::Method::GET,
        &format!("{project}/knowledge/sources/{source}/pages{query}"),
        None,
    )
    .await?;
    Ok(Json(body))
}

#[utoipa::path(
    get,
    path = "/api/v1/projects/{project}/knowledge/sources/{source}/search",
    summary = "Try A Source's Search",
    description = "The hits the MCP tool `search_documents` would answer from this one source (API/05 §4), each with its title, address, publisher, description, dates, language, passage and score; internal passages too, as an internal deployment would read them.",
    tag = "knowledge",
    params(
        ("project" = String, Path, description = "Project name"),
        ("source" = String, Path, description = "KnowledgeSource name"),
        Tried,
    ),
    responses(
        (status = 200, description = "The hits, best first", body = Object),
        (status = 400, description = "`q` is not 1 to 300 characters or `limit` not 1 to 10", body = crate::error::ProblemDetails),
        (status = 401, description = "Not signed in", body = crate::error::ProblemDetails),
        (status = 404, description = "No such project or crawled source", body = crate::error::ProblemDetails),
        (status = 503, description = "The knowledge assistant is not reachable", body = crate::error::ProblemDetails),
    )
)]
pub async fn try_search(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((project, source)): Path<(String, String)>,
    Query(tried): Query<Tried>,
) -> Result<Json<Value>, ApiError> {
    readable(&state, &user, &project)?;
    named("source", &source)?;
    let query = {
        let mut query = url::form_urlencoded::Serializer::new(String::new());
        query.append_pair("q", &tried.q);
        if let Some(limit) = tried.limit {
            query.append_pair("limit", &limit.to_string());
        }
        query.finish()
    };
    let (_, body) = ask(
        &state,
        reqwest::Method::GET,
        &format!("{project}/knowledge/sources/{source}/search?{query}"),
        None,
    )
    .await?;
    Ok(Json(body))
}

#[utoipa::path(
    get,
    path = "/api/v1/projects/{project}/knowledge/sources/{source}/documents",
    summary = "List A Source's Documents",
    description = "The documents (PDFs) the source's pages link: size, pages, whether on another host, included or who excluded it, passages.",
    tag = "knowledge",
    params(
        ("project" = String, Path, description = "Project name"),
        ("source" = String, Path, description = "KnowledgeSource name"),
    ),
    responses(
        (status = 200, description = "The documents", body = Object),
        (status = 401, description = "Not signed in", body = crate::error::ProblemDetails),
        (status = 404, description = "No such project or crawled source", body = crate::error::ProblemDetails),
        (status = 503, description = "The knowledge assistant is not reachable", body = crate::error::ProblemDetails),
    )
)]
pub async fn list_documents(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((project, source)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    readable(&state, &user, &project)?;
    named("source", &source)?;
    let (_, body) = ask(
        &state,
        reqwest::Method::GET,
        &format!("{project}/knowledge/sources/{source}/documents"),
        None,
    )
    .await?;
    Ok(Json(body))
}

#[utoipa::path(
    get,
    path = "/api/v1/projects/{project}/knowledge/sources/{source}/errors",
    summary = "List A Source's Crawl Errors",
    description = "The pages and documents whose last read failed, newest first, at most 50: url, kind (`page` or `document`) and reason (`HTTP 404`, a network error). Needs `propose` on KnowledgeSource; a viewer sees the counts alone (API/01 §34, T-4197).",
    tag = "knowledge",
    params(
        ("project" = String, Path, description = "Project name"),
        ("source" = String, Path, description = "KnowledgeSource name"),
    ),
    responses(
        (status = 200, description = "The errors", body = Object),
        (status = 401, description = "Not signed in", body = crate::error::ProblemDetails),
        (status = 403, description = "The caller may not propose a KnowledgeSource", body = crate::error::ProblemDetails),
        (status = 404, description = "No such project or crawled source", body = crate::error::ProblemDetails),
        (status = 503, description = "The knowledge assistant is not reachable", body = crate::error::ProblemDetails),
    )
)]
pub async fn list_errors(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((project, source)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    writable(&state, &user, &project)?;
    named("source", &source)?;
    let (_, body) = ask(
        &state,
        reqwest::Method::GET,
        &format!("{project}/knowledge/sources/{source}/errors"),
        None,
    )
    .await?;
    Ok(Json(body))
}

#[utoipa::path(
    get,
    path = "/api/v1/projects/{project}/knowledge/sources/{source}/pages/{page}/links",
    summary = "List A Page's Links",
    description = "Every link the page carries: to another page of the site, to a document, or off the site.",
    tag = "knowledge",
    params(
        ("project" = String, Path, description = "Project name"),
        ("source" = String, Path, description = "KnowledgeSource name"),
        ("page" = i64, Path, description = "Page id"),
    ),
    responses(
        (status = 200, description = "The links", body = Object),
        (status = 401, description = "Not signed in", body = crate::error::ProblemDetails),
        (status = 404, description = "No such project, source or page", body = crate::error::ProblemDetails),
        (status = 503, description = "The knowledge assistant is not reachable", body = crate::error::ProblemDetails),
    )
)]
pub async fn list_links(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((project, source, page)): Path<(String, String, i64)>,
) -> Result<Json<Value>, ApiError> {
    readable(&state, &user, &project)?;
    named("source", &source)?;
    let (_, body) = ask(
        &state,
        reqwest::Method::GET,
        &format!("{project}/knowledge/sources/{source}/pages/{page}/links"),
        None,
    )
    .await?;
    Ok(Json(body))
}

#[utoipa::path(
    get,
    path = "/api/v1/projects/{project}/knowledge/sources/{source}/passages",
    summary = "Preview Passages",
    description = "The passages the assistant answers from, of one page (`?page=`) or one document (`?document=`), in order.",
    tag = "knowledge",
    params(
        ("project" = String, Path, description = "Project name"),
        ("source" = String, Path, description = "KnowledgeSource name"),
        PassagesOf,
    ),
    responses(
        (status = 200, description = "The passages", body = Object),
        (status = 400, description = "Neither or both of page and document", body = crate::error::ProblemDetails),
        (status = 401, description = "Not signed in", body = crate::error::ProblemDetails),
        (status = 404, description = "No such project or crawled source", body = crate::error::ProblemDetails),
        (status = 503, description = "The knowledge assistant is not reachable", body = crate::error::ProblemDetails),
    )
)]
pub async fn list_passages(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((project, source)): Path<(String, String)>,
    Query(of): Query<PassagesOf>,
) -> Result<Json<Value>, ApiError> {
    readable(&state, &user, &project)?;
    named("source", &source)?;
    let query = match (of.page, of.document) {
        (Some(page), None) => format!("page={page}"),
        (None, Some(document)) => format!("document={document}"),
        _ => {
            return Err(ApiError::BadRequest(
                "name one page or one document: ?page= or ?document=".into(),
            ))
        }
    };
    let (_, body) = ask(
        &state,
        reqwest::Method::GET,
        &format!("{project}/knowledge/sources/{source}/passages?{query}"),
        None,
    )
    .await?;
    Ok(Json(body))
}

#[utoipa::path(
    post,
    path = "/api/v1/projects/{project}/knowledge/sources/{source}/inclusion",
    summary = "Include Or Exclude Pages And Documents",
    description = "Excluding removes the passages of what it names at once and holds over every later crawl; including indexes it again at the next crawl. Needs `propose` on KnowledgeSource (AG-113).",
    tag = "knowledge",
    params(
        ("project" = String, Path, description = "Project name"),
        ("source" = String, Path, description = "KnowledgeSource name"),
    ),
    request_body(
        content = InclusionRequest,
        description = "At most 500 page and document ids.",
        content_type = "application/json",
        example = json!({ "pages": [12], "documents": [], "subtree": true, "included": false })
    ),
    responses(
        (status = 200, description = "What changed: pages, documents, passagesRemoved", body = Object),
        (status = 400, description = "No id, or more than 500", body = crate::error::ProblemDetails),
        (status = 401, description = "Not signed in", body = crate::error::ProblemDetails),
        (status = 403, description = "The caller may not propose a KnowledgeSource", body = crate::error::ProblemDetails),
        (status = 404, description = "No such project or crawled source", body = crate::error::ProblemDetails),
        (status = 503, description = "The knowledge assistant is not reachable", body = crate::error::ProblemDetails),
    )
)]
pub async fn set_inclusion(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((project, source)): Path<(String, String)>,
    Json(change): Json<InclusionRequest>,
) -> Result<Json<Value>, ApiError> {
    writable(&state, &user, &project)?;
    named("source", &source)?;
    if change.pages.is_empty() && change.documents.is_empty() {
        return Err(ApiError::BadRequest(
            "name at least one page or document".into(),
        ));
    }
    if change.pages.len() + change.documents.len() > MAX_IDS {
        return Err(ApiError::BadRequest(format!(
            "at most {MAX_IDS} pages and documents in one call"
        )));
    }
    let body = serde_json::to_value(&change).map_err(|err| ApiError::Internal(err.to_string()))?;
    let (_, counts) = ask(
        &state,
        reqwest::Method::POST,
        &format!("{project}/knowledge/sources/{source}/inclusion"),
        Some(body),
    )
    .await?;
    Ok(Json(counts))
}

#[utoipa::path(
    post,
    path = "/api/v1/projects/{project}/knowledge/sources/{source}/recrawl",
    summary = "Recrawl A Source Now",
    description = "Queues a crawl of the source now instead of at its schedule. Needs `propose` on KnowledgeSource (AG-113).",
    tag = "knowledge",
    params(
        ("project" = String, Path, description = "Project name"),
        ("source" = String, Path, description = "KnowledgeSource name"),
    ),
    responses(
        (status = 202, description = "The queued job", body = Object),
        (status = 401, description = "Not signed in", body = crate::error::ProblemDetails),
        (status = 403, description = "The caller may not propose a KnowledgeSource", body = crate::error::ProblemDetails),
        (status = 404, description = "No such project or declared source", body = crate::error::ProblemDetails),
        (status = 409, description = "A crawl is already queued or running", body = crate::error::ProblemDetails),
        (status = 503, description = "The knowledge assistant is not reachable", body = crate::error::ProblemDetails),
    )
)]
pub async fn recrawl(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((project, source)): Path<(String, String)>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    writable(&state, &user, &project)?;
    named("source", &source)?;
    let (status, job) = ask(
        &state,
        reqwest::Method::POST,
        &format!("{project}/knowledge/sources/{source}/recrawl"),
        None,
    )
    .await?;
    Ok((status, Json(job)))
}

/// The file an upload names (API/01 §34): `jc-assistant` holds the rules for it.
#[derive(Debug, Deserialize, IntoParams)]
#[serde(deny_unknown_fields)]
pub struct FileName {
    /// The file's name, its extension saying what it is: 1 to 200 characters, no `/` or `\\`.
    pub name: String,
}

/// The longest an upload may take: 50 MiB sent on and read into passages.
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(120);

/// One upload or removal in the project's activity, beside the crawls it replaces.
async fn record(state: &AppState, project: &str, kind: &str, summary: String, details: Value) {
    let event = crate::activity::ActivityEvent {
        time: chrono::Utc::now(),
        project: project.to_owned(),
        space: None,
        kind: kind.to_owned(),
        source: "portal".to_owned(),
        summary,
        severity: "info".to_owned(),
        correlation_id: None,
        details,
    };
    if let Err(err) = state.activity.append(&[event]).await {
        tracing::warn!(error = %err, kind, "the knowledge file change was not recorded");
    }
}

#[utoipa::path(
    get,
    path = "/api/v1/projects/{project}/knowledge/sources/{source}/files",
    summary = "List A Source's Files",
    description = "The files uploaded to a `source: upload`, newest first, with the passages each was read into (API/01 §34, T-4184).",
    tag = "knowledge",
    params(
        ("project" = String, Path, description = "Project name"),
        ("source" = String, Path, description = "KnowledgeSource name"),
    ),
    responses(
        (status = 200, description = "`items`: id, name, mime, bytes, passages, status", body = Object),
        (status = 401, description = "Not signed in", body = crate::error::ProblemDetails),
        (status = 404, description = "No such project or declared source", body = crate::error::ProblemDetails),
        (status = 409, description = "The source is not a `source: upload`", body = crate::error::ProblemDetails),
        (status = 503, description = "The knowledge assistant is not reachable", body = crate::error::ProblemDetails),
    )
)]
pub async fn list_files(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((project, source)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    readable(&state, &user, &project)?;
    named("source", &source)?;
    let (_, files) = ask(
        &state,
        reqwest::Method::GET,
        &format!("{project}/knowledge/sources/{source}/files"),
        None,
    )
    .await?;
    Ok(Json(files))
}

#[utoipa::path(
    post,
    path = "/api/v1/projects/{project}/knowledge/sources/{source}/files",
    summary = "Upload A File To A Source",
    description = "Reads the raw body, a PDF, DOCX, XLSX or UTF-8 text file (CSV, Markdown), into the source's passages; the assistant answers from it at once. At most the source's `upload.maxBytes` (50 MiB) and `upload.maxFiles`. Needs `propose` on KnowledgeSource (AG-113, T-4184).",
    tag = "knowledge",
    params(
        ("project" = String, Path, description = "Project name"),
        ("source" = String, Path, description = "KnowledgeSource name"),
        FileName,
    ),
    request_body(content = String, content_type = "application/octet-stream", description = "The file's bytes", example = json!("Obec,Obyvatelia\nBanská Bystrica,75000\n")),
    responses(
        (status = 201, description = "The file: id, name, mime, bytes, passages, status", body = Object),
        (status = 400, description = "No usable file name", body = crate::error::ProblemDetails),
        (status = 401, description = "Not signed in", body = crate::error::ProblemDetails),
        (status = 403, description = "The caller may not propose a KnowledgeSource", body = crate::error::ProblemDetails),
        (status = 404, description = "No such project or declared source", body = crate::error::ProblemDetails),
        (status = 409, description = "Not a `source: upload`, or it holds its `maxFiles` already", body = crate::error::ProblemDetails),
        (status = 413, description = "Larger than the source's `upload.maxBytes`", body = crate::error::ProblemDetails),
        (status = 415, description = "Not a PDF, DOCX, XLSX or UTF-8 text file", body = crate::error::ProblemDetails),
        (status = 503, description = "The knowledge assistant is not reachable", body = crate::error::ProblemDetails),
    )
)]
pub async fn upload_file(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((project, source)): Path<(String, String)>,
    Query(file): Query<FileName>,
    body: axum::body::Bytes,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    writable(&state, &user, &project)?;
    named("source", &source)?;
    let bytes = body.len();
    let name = file.name;
    let query = [("name", name.clone())];
    let (status, added) = ask_with(
        &state,
        reqwest::Method::POST,
        &format!("{project}/knowledge/sources/{source}/files"),
        UPLOAD_TIMEOUT,
        move |request| {
            request
                .query(&query)
                .header(header::CONTENT_TYPE, "application/octet-stream")
                .body(body)
        },
    )
    .await?;
    record(
        &state,
        &project,
        "knowledge.file.uploaded",
        format!("{} uploaded {name} to {source}", user.0.identity.username),
        json!({
            "actor": user.0.identity.username,
            "source": source,
            "name": name,
            "bytes": bytes,
            "id": added.get("id"),
            "passages": added.get("passages"),
        }),
    )
    .await;
    Ok((status, Json(added)))
}

#[utoipa::path(
    delete,
    path = "/api/v1/projects/{project}/knowledge/sources/{source}/files/{id}",
    summary = "Remove A File From A Source",
    description = "Removes the uploaded file and its passages at once. Needs `propose` on KnowledgeSource (AG-113, T-4184).",
    tag = "knowledge",
    params(
        ("project" = String, Path, description = "Project name"),
        ("source" = String, Path, description = "KnowledgeSource name"),
        ("id" = i64, Path, description = "The file's id"),
    ),
    responses(
        (status = 204, description = "Removed"),
        (status = 401, description = "Not signed in", body = crate::error::ProblemDetails),
        (status = 403, description = "The caller may not propose a KnowledgeSource", body = crate::error::ProblemDetails),
        (status = 404, description = "No such project, source or file", body = crate::error::ProblemDetails),
        (status = 409, description = "The source is not a `source: upload`", body = crate::error::ProblemDetails),
        (status = 503, description = "The knowledge assistant is not reachable", body = crate::error::ProblemDetails),
    )
)]
pub async fn remove_file(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((project, source, id)): Path<(String, String, i64)>,
) -> Result<StatusCode, ApiError> {
    writable(&state, &user, &project)?;
    named("source", &source)?;
    ask(
        &state,
        reqwest::Method::DELETE,
        &format!("{project}/knowledge/sources/{source}/files/{id}"),
        None,
    )
    .await?;
    record(
        &state,
        &project,
        "knowledge.file.removed",
        format!(
            "{} removed file {id} from {source}",
            user.0.identity.username
        ),
        json!({ "actor": user.0.identity.username, "source": source, "id": id }),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    get,
    path = "/api/v1/projects/{project}/knowledge/deployments/{deployment}/usage",
    summary = "Read An Assistant's Usage",
    description = "Requests and model tokens per day of one AssistantDeployment, the last 30 days.",
    tag = "knowledge",
    params(
        ("project" = String, Path, description = "Project name"),
        ("deployment" = String, Path, description = "AssistantDeployment name"),
    ),
    responses(
        (status = 200, description = "Usage per day", body = Object),
        (status = 401, description = "Not signed in", body = crate::error::ProblemDetails),
        (status = 404, description = "No such project or deployment the caller may read", body = crate::error::ProblemDetails),
        (status = 503, description = "The knowledge assistant is not reachable", body = crate::error::ProblemDetails),
    )
)]
pub async fn deployment_usage(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((project, deployment)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let effective = crate::permissions::for_request(&state, &user.0.identity, &project);
    if !(is_dns1123(&project)
        && effective.may_read_project()
        && effective.may_read("AssistantDeployment"))
    {
        return Err(ApiError::NotFound(format!("project '{project}' not found")));
    }
    named("deployment", &deployment)?;
    if state
        .mirror
        .get(&project, "AssistantDeployment", &deployment)
        .is_none()
    {
        return Err(ApiError::NotFound(format!(
            "deployment '{deployment}' not found"
        )));
    }
    let (_, body) = ask(
        &state,
        reqwest::Method::GET,
        &format!("{project}/knowledge/deployments/{deployment}/usage"),
        None,
    )
    .await?;
    Ok(Json(body))
}

#[utoipa::path(
    post,
    path = "/api/v1/projects/{project}/knowledge/deployments/{deployment}/chat",
    summary = "Ask an Assistant",
    description = "One question to the project's AssistantDeployment as the signed-in person, answered as the Server-Sent Events of API/05 §1.3. An internal deployment reads its internal passages and the organization's Endpoints with the person's own token, which the Portal passes on and keeps no copy of; any other channel answers as it answers a visitor (API/05 §1.7, AG-115).",
    tag = "knowledge",
    params(
        ("project" = String, Path, description = "Project name"),
        ("deployment" = String, Path, description = "AssistantDeployment name"),
    ),
    request_body(
        content = ChatRequest,
        description = "API/05 §1.1: the question, the last turns the chat holds, the connectors switched on.",
        content_type = "application/json",
        example = json!({
            "message": "Where are the air quality stations?",
            "history": [{ "role": "user", "text": "Hello" }, { "role": "assistant", "text": "Hello! Ask me about the city's data." }],
            "connectors": ["helsinki-weather"]
        })
    ),
    responses(
        (status = 200, description = "The answer, as Server-Sent Events", content_type = "text/event-stream", body = String),
        (status = 400, description = "The question breaks a bound of API/05 §1.1", body = crate::error::ProblemDetails),
        (status = 401, description = "Not signed in", body = crate::error::ProblemDetails),
        (status = 404, description = "No such project or deployment the caller may read", body = crate::error::ProblemDetails),
        (status = 409, description = "The deployment has no budget yet", body = crate::error::ProblemDetails),
        (status = 429, description = "The deployment's per-minute limit is reached", body = crate::error::ProblemDetails),
        (status = 503, description = "The knowledge assistant is not reachable", body = crate::error::ProblemDetails),
    )
)]
pub async fn chat(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((project, deployment)): Path<(String, String)>,
    headers: HeaderMap,
    Json(question): Json<ChatRequest>,
) -> Result<Response, ApiError> {
    let effective = crate::permissions::for_request(&state, &user.0.identity, &project);
    if !(is_dns1123(&project)
        && effective.may_read_project()
        && effective.may_read("AssistantDeployment"))
    {
        return Err(ApiError::NotFound(format!("project '{project}' not found")));
    }
    named("deployment", &deployment)?;
    if state
        .mirror
        .get(&project, "AssistantDeployment", &deployment)
        .is_none()
    {
        return Err(ApiError::NotFound(format!(
            "deployment '{deployment}' not found"
        )));
    }
    let base = state.config.knowledge_url.as_deref().ok_or_else(|| {
        ApiError::Unavailable(
            "this Portal has no knowledge assistant address (JC_PORTAL_KNOWLEDGE_URL)".into(),
        )
    })?;
    let oidc = state.oidc.as_ref().ok_or_else(|| {
        ApiError::Unavailable("this Portal has no Keycloak client to ask the assistant with".into())
    })?;
    let token = oidc.service_token().await.map_err(|err| {
        ApiError::Unavailable(format!("no token for the knowledge assistant: {err}"))
    })?;
    let mut request = http()
        .post(format!(
            "{base}/internal/v1/projects/{project}/knowledge/deployments/{deployment}/chat"
        ))
        .bearer_auth(token)
        .header("x-jc-person", &user.0.identity.username)
        .timeout(CHAT_TIMEOUT)
        .json(&question);
    // The person's own token, for an internal deployment's connectors (AG-115): passed on,
    // never kept or logged here.
    if let Some(person) =
        crate::agents::identity::persons_token(&headers, state.config.trust_edge_token)
    {
        request = request.header("x-jc-person-token", person);
    }
    let answer = request.send().await.map_err(|err| {
        tracing::warn!(error = %err.without_url(), "the knowledge assistant did not answer");
        ApiError::Unavailable("the knowledge assistant did not answer; try again shortly".into())
    })?;
    let status = answer.status().as_u16();
    if !(200..300).contains(&status) {
        let body: Value = answer.json().await.unwrap_or(Value::Null);
        let detail = body
            .get("detail")
            .and_then(Value::as_str)
            .unwrap_or("no reason given")
            .to_owned();
        return Err(match status {
            400 => ApiError::BadRequest(detail),
            404 => ApiError::NotFound(detail),
            409 => ApiError::Conflict(detail),
            429 => ApiError::TooManyRequests(detail),
            401 | 403 => {
                tracing::error!("the knowledge assistant refused the Portal's own token");
                ApiError::Unavailable(
                    "the knowledge assistant does not accept this Portal's token".into(),
                )
            }
            _ => ApiError::Unavailable(format!("the knowledge assistant answered {status}")),
        });
    }
    // The events as they come, so the person sees each tool and the answer when it is there.
    let events = futures_util::stream::unfold(Some(answer), |answer| async move {
        let mut answer = answer?;
        match answer.chunk().await {
            Ok(Some(bytes)) => Some((Ok::<_, std::io::Error>(bytes), Some(answer))),
            Ok(None) => None,
            Err(err) => {
                tracing::warn!(error = %err.without_url(), "the assistant's answer broke off");
                Some((Err(std::io::Error::other("the answer broke off")), None))
            }
        }
    });
    Ok((
        [
            (header::CONTENT_TYPE, "text/event-stream"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        [("x-accel-buffering", "no")],
        Body::from_stream(events),
    )
        .into_response())
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/projects/{project}/knowledge/sources", get(list_sources))
        .route(
            "/projects/{project}/knowledge/sources/{source}/pages",
            get(list_pages),
        )
        .route(
            "/projects/{project}/knowledge/sources/{source}/documents",
            get(list_documents),
        )
        .route(
            "/projects/{project}/knowledge/sources/{source}/search",
            get(try_search),
        )
        .route(
            "/projects/{project}/knowledge/sources/{source}/errors",
            get(list_errors),
        )
        .route(
            "/projects/{project}/knowledge/sources/{source}/pages/{page}/links",
            get(list_links),
        )
        .route(
            "/projects/{project}/knowledge/sources/{source}/passages",
            get(list_passages),
        )
        .route(
            "/projects/{project}/knowledge/sources/{source}/inclusion",
            post(set_inclusion),
        )
        .route(
            "/projects/{project}/knowledge/sources/{source}/recrawl",
            post(recrawl),
        )
        .route(
            "/projects/{project}/knowledge/sources/{source}/files",
            get(list_files)
                .post(upload_file)
                .layer(DefaultBodyLimit::max(MAX_UPLOAD_BODY)),
        )
        .route(
            "/projects/{project}/knowledge/sources/{source}/files/{id}",
            delete(remove_file),
        )
        .route(
            "/projects/{project}/knowledge/deployments/{deployment}/usage",
            get(deployment_usage),
        )
        .route(
            "/projects/{project}/knowledge/deployments/{deployment}/chat",
            post(chat).layer(DefaultBodyLimit::max(MAX_CHAT_BODY)),
        )
}
