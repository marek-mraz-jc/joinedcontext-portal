use axum::extract::{Path, Query, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::auth::CurrentUser;
use crate::error::{ApiError, ProblemDetails};
use crate::resource::selector::{FieldSelector, LabelSelector};
use crate::resource::{by_plural, ResourceEnvelope, API_VERSION};
use crate::state::AppState;
use crate::store::ListOptions;

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ResourceList {
    pub api_version: String,
    pub kind: String,
    pub metadata: ListMeta,
    pub items: Vec<ResourceEnvelope>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListMeta {
    #[serde(rename = "continue", skip_serializing_if = "Option::is_none")]
    pub continue_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining_item_count: Option<usize>,
}

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    #[serde(default, rename = "labelSelector")]
    pub label_selector: Option<String>,
    #[serde(default, rename = "fieldSelector")]
    pub field_selector: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default, rename = "continue")]
    pub continue_token: Option<String>,
    #[serde(default)]
    pub revision: Option<String>,
    /// Read inside this workspace: its branch over `main` (CC-76).
    #[serde(default)]
    pub workspace: Option<String>,
}

/// The query of a single read.
#[derive(Debug, Default, Deserialize)]
pub struct GetQuery {
    /// Read inside this workspace: its branch over `main` (CC-76).
    #[serde(default)]
    pub workspace: Option<String>,
    /// Read the project as it stood at this commit id (MF-11).
    pub revision: Option<String>,
}

#[utoipa::path(
    get,
    path = "/api/v1/projects/{project}/{plural}",
    summary = "List Resources",
    description = "Lists the resources of one kind in the project, optionally of one context space.",
    tag = "resources",
    params(
        ("project" = String, Path, description = "Project name"),
        ("plural" = String, Path, description = "Resource kind plural"),
        ("labelSelector" = Option<String>, Query, description = "Label selector"),
        ("fieldSelector" = Option<String>, Query, description = "Field selector"),
        ("limit" = Option<usize>, Query, description = "Page limit"),
        ("continue" = Option<String>, Query, description = "Pagination continue token"),
        ("revision" = Option<String>, Query, description = "Read the project as it stood at this commit id (MF-11)"),
        ("workspace" = Option<String>, Query, description = "Read inside this workspace (CC-76)"),
    ),
    responses(
        (status = 200, description = "List of resources", body = ResourceList),
        (status = 400, description = "A bad selector or limit, a revision that is not a commit id, or one beside a workspace", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 404, description = "Resource not found", body = ProblemDetails)
    )
)]
pub async fn list(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((project, plural)): Path<(String, String)>,
    Query(query): Query<ListQuery>,
) -> Result<Json<ResourceList>, ApiError> {
    // One body for a plural that is not a kind, a kind no binding of the caller reads and a
    // project no binding covers: what the caller may not read is not there (PF-59, R20).
    let not_found = || {
        ApiError::NotFound(format!(
            "plural '{plural}' not found in project '{project}'"
        ))
    };
    let kind_info = by_plural(&plural).ok_or_else(not_found)?;
    if !crate::permissions::for_request(&state, &user.0.identity, &project).may_read(kind_info.kind)
    {
        return Err(not_found());
    }

    let limit = match query.limit {
        Some(0) => return Err(ApiError::BadRequest("limit must be greater than 0".into())),
        Some(n) if n > 500 => Some(500),
        Some(n) => Some(n),
        None => None,
    };

    let label_selector = match query.label_selector.as_deref() {
        Some(raw) if !raw.trim().is_empty() => {
            Some(LabelSelector::parse(raw).map_err(|e| ApiError::BadRequest(e.to_string()))?)
        }
        _ => None,
    };

    let field_selector = match query.field_selector.as_deref() {
        Some(raw) if !raw.trim().is_empty() => {
            Some(FieldSelector::parse(raw).map_err(|e| ApiError::BadRequest(e.to_string()))?)
        }
        _ => None,
    };

    let opts = ListOptions {
        label_selector,
        field_selector,
        limit,
        continue_token: query.continue_token,
    };

    let page = match (query.workspace.as_deref(), query.revision.as_deref()) {
        (Some(_), Some(_)) => return Err(both()),
        (Some(name), None) => {
            crate::ops::workspaces::mirror_of(&state, &user.0.identity, name, &project)
                .await?
                .list(&project, kind_info.kind, &opts)
        }
        (None, Some(revision)) => mirror_at(&state, &project, revision, not_found)
            .await?
            .list(&project, kind_info.kind, &opts),
        (None, None) => state.mirror.list(&project, kind_info.kind, &opts),
    };

    let remaining_item_count = if page.continue_token.is_some() {
        Some(page.remaining)
    } else {
        None
    };

    Ok(Json(ResourceList {
        api_version: API_VERSION.to_string(),
        kind: "List".to_string(),
        metadata: ListMeta {
            continue_token: page.continue_token,
            remaining_item_count,
        },
        items: page.items,
    }))
}

#[utoipa::path(
    get,
    path = "/api/v1/projects/{project}/{plural}/{name}",
    summary = "Get Resource",
    description = "Reads one resource's manifest and status by kind and name.",
    tag = "resources",
    params(
        ("project" = String, Path, description = "Project name"),
        ("plural" = String, Path, description = "Resource kind plural"),
        ("name" = String, Path, description = "Resource name"),
        ("workspace" = Option<String>, Query, description = "Read inside this workspace (CC-76)"),
        ("revision" = Option<String>, Query, description = "Read the project as it stood at this commit id (MF-11)"),
    ),
    responses(
        (status = 200, description = "Resource envelope", body = ResourceEnvelope),
        (status = 400, description = "A revision that is not a commit id, or one beside a workspace", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 404, description = "Resource not found", body = ProblemDetails)
    )
)]
pub async fn get_resource(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((project, plural, name)): Path<(String, String, String)>,
    Query(query): Query<GetQuery>,
) -> Result<Json<ResourceEnvelope>, ApiError> {
    // The same 404 body for an unknown plural and for a resource that exists but is not
    // visible: existence is never disclosed (R20).
    let not_found = || {
        ApiError::NotFound(format!(
            "resource '{name}' not found in project '{project}'"
        ))
    };
    let kind_info = by_plural(&plural).ok_or_else(not_found)?;
    if !crate::permissions::for_request(&state, &user.0.identity, &project).may_read(kind_info.kind)
    {
        return Err(not_found());
    }
    let envelope = match (query.workspace.as_deref(), query.revision.as_deref()) {
        (Some(_), Some(_)) => return Err(both()),
        (Some(workspace), None) => {
            crate::ops::workspaces::mirror_of(&state, &user.0.identity, workspace, &project)
                .await?
                .get(&project, kind_info.kind, &name)
        }
        (None, Some(revision)) => mirror_at(&state, &project, revision, not_found).await?.get(
            &project,
            kind_info.kind,
            &name,
        ),
        (None, None) => state.mirror.get(&project, kind_info.kind, &name),
    }
    .ok_or_else(not_found)?;

    Ok(Json(envelope))
}

fn both() -> ApiError {
    ApiError::BadRequest("read a workspace or a revision, not both".into())
}

/// The project as it stood at one commit (MF-11, MF-16): its subtree of the repository at
/// `revision`, loaded the way the live mirror is, with no status, because status is what the
/// Portal computes now and a past commit has none (MF-04).
///
/// Only a commit id is a revision. A branch name would read a workspace's unmerged edits past
/// the workspace's own door (CC-76). A commit the forge does not know answers the caller's own
/// 404, so a guessed sha tells nothing (R20); the read grants are the caller's current ones,
/// checked before this runs, so a binding that once allowed a read does not allow it now.
// ponytail: one forge read per file per request; cache by commit id if history reads get hot.
async fn mirror_at(
    state: &AppState,
    project: &str,
    revision: &str,
    not_found: impl Fn() -> ApiError,
) -> Result<crate::store::Mirror, ApiError> {
    if !crate::api::export::is_commit(revision) {
        return Err(ApiError::BadRequest(
            "revision is a commit id: 7 to 40 lowercase hex digits".into(),
        ));
    }
    let gitea = state
        .forge_for(project)
        .ok_or_else(|| ApiError::Unavailable("no repository is configured".into()))?;
    let gitea: &crate::git::GiteaClient = &gitea;
    let paths = match gitea.list_tree(revision).await {
        Ok(paths) => paths,
        Err(crate::git::GitError::NotFound) => return Err(not_found()),
        Err(crate::git::GitError::Api { status, .. }) if (400..500).contains(&status) => {
            return Err(not_found())
        }
        Err(err) => return Err(err.into()),
    };
    let prefix = format!("projects/{project}/");
    let mirror = crate::store::Mirror::new();
    for path in paths {
        if !path.starts_with(&prefix) || !(path.ends_with(".yaml") || path.ends_with(".yml")) {
            continue;
        }
        let Some(file) = gitea.get_file(&path, revision).await? else {
            continue;
        };
        let Some(mut envelope) = crate::store::envelope_of(&file.content) else {
            continue;
        };
        match envelope.metadata.namespace.as_deref() {
            None | Some("") => envelope.metadata.namespace = Some(project.to_owned()),
            Some(namespace) if namespace != project => continue,
            Some(_) => {}
        }
        envelope.strip_status();
        mirror.upsert(envelope);
    }
    Ok(mirror)
}

/// `GET /api/v1/endpoints` (PF-60, PF-61): every Endpoint of every project this caller may
/// read, each carrying the project it lives in. An `org-admin` bound at organization scope sees
/// all of them, a project's steward those of their projects, a binding scoped to one context
/// space only that space's, and a person no binding names an empty list — never a 403, because
/// what is not readable is not there (R20).
#[utoipa::path(
    get,
    path = "/api/v1/endpoints",
    summary = "List Endpoints Everywhere",
    description = "Every Endpoint of every project the caller may read, each with the project it lives in.",
    tag = "resources",
    responses(
        (status = 200, description = "Every Endpoint the caller may read, across projects", body = ResourceList),
        (status = 401, description = "Unauthorized", body = ProblemDetails)
    )
)]
pub async fn list_endpoints_everywhere(
    user: CurrentUser,
    State(state): State<AppState>,
) -> Result<Json<ResourceList>, ApiError> {
    let mut items = Vec::new();
    for project in state.mirror.namespaces() {
        let effective = crate::permissions::for_request(&state, &user.0.identity, &project);
        if !effective.may_read("Endpoint") {
            continue;
        }
        items.extend(
            state
                .mirror
                .list(&project, "Endpoint", &ListOptions::default())
                .items
                .into_iter()
                .filter(|env| {
                    effective.may_read_manifest(
                        "Endpoint",
                        &serde_json::to_value(env).unwrap_or(serde_json::Value::Null),
                    )
                }),
        );
    }
    items.sort_by(|a, b| {
        (a.metadata.namespace.as_deref(), a.metadata.name.as_str())
            .cmp(&(b.metadata.namespace.as_deref(), b.metadata.name.as_str()))
    });
    Ok(Json(ResourceList {
        api_version: API_VERSION.to_string(),
        kind: "List".to_string(),
        metadata: ListMeta {
            continue_token: None,
            remaining_item_count: None,
        },
        items,
    }))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/endpoints", get(list_endpoints_everywhere))
        .route(
            "/projects/{project}/{plural}",
            get(list).post(crate::api::mutate::create),
        )
        .route(
            "/projects/{project}/{plural}/{name}",
            get(get_resource)
                .put(crate::api::mutate::replace)
                .patch(crate::api::mutate::patch)
                .delete(crate::api::delete::delete_resource),
        )
}
