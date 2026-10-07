//! Bringing back what a merged removal took (T-3247, API/01 §5).
//!
//! A removal is a Change like every other write, so what it removed is still in the repository at
//! the commit its branch was cut from. Restoring reads every file it deleted there and proposes
//! them again in one new Change, decided by an approver like the first one. What the reconciler
//! threw away with the resource (a pipeline's refused records and runs) does not come back; the
//! entities of a space were never removed with it.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Json, Router};
use jc_core::kinds::Verb;

use crate::api::changes::{change_meta, parse_change_id, resolve_change};
use crate::auth::session::Identity;
use crate::auth::CurrentUser;
use crate::change::{self, Change, ChangePhase, ChangeStatus, Lane, Operation, PlanSummary};
use crate::error::{ApiError, ProblemDetails};
use crate::git::gitea::Author;
use crate::resource::ResourceEnvelope;
use crate::state::AppState;

#[utoipa::path(
    post,
    path = "/api/v1/projects/{project}/changes/{id}/restore",
    summary = "Restore What a Change Removed",
    description = "Proposes again, as one new change, every file a merged change deleted, read at the commit its branch was cut from. Needs `propose` on every kind it brings back.",
    tag = "changes",
    params(
        ("project" = String, Path, description = "Project name"),
        ("id" = String, Path, description = "The merged change that removed something: chg- + 8 hex digits"),
    ),
    responses(
        (status = 202, description = "The restoring change, waiting for an approver", body = Change),
        (status = 400, description = "Not a change id", body = ProblemDetails),
        (status = 401, description = "Not signed in", body = ProblemDetails),
        (status = 403, description = "No `propose` on a kind it brings back", body = ProblemDetails),
        (status = 404, description = "No such change the caller may read", body = ProblemDetails),
        (status = 409, description = "Not merged, removed nothing, or the resource is there again", body = ProblemDetails),
        (status = 503, description = "Git forge unavailable", body = ProblemDetails),
    )
)]
pub async fn restore_change(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((project, id)): Path<(String, String)>,
) -> Result<(StatusCode, Json<Change>), ApiError> {
    let change = restore_change_for(&state, &user.0.identity, &project, &id).await?;
    Ok((StatusCode::ACCEPTED, Json(change)))
}

/// Restores what the merged change `id` removed, as `identity` (T-3247).
pub async fn restore_change_for(
    state: &AppState,
    identity: &Identity,
    project: &str,
    id: &str,
) -> Result<Change, ApiError> {
    let missing = || ApiError::NotFound(format!("change '{id}' not found in project '{project}'"));
    let effective = crate::permissions::for_request(state, identity, project);
    if !effective.may_read_project() {
        return Err(missing());
    }
    // A project's own changes only: an organization change (`chg-org-`) removes no project file.
    parse_change_id(id)?;
    let (gitea, number) = resolve_change(state, project, id)?;
    let gitea: &crate::git::GiteaClient = &gitea;
    let pr = gitea.pull_request(number).await?;
    let branch = pr
        .head_branch
        .strip_prefix("refs/heads/")
        .unwrap_or(&pr.head_branch);
    if !branch.starts_with("portal/") && !branch.starts_with("workspace/") {
        return Err(missing());
    }
    if !pr.merged {
        return Err(ApiError::Conflict(format!(
            "change {id} is not merged, so it removed nothing yet; reject it instead"
        )));
    }
    let home = format!("projects/{project}/");
    let removed: Vec<String> = gitea
        .pull_request_files(number)
        .await?
        .into_iter()
        .filter(|file| file.deleted && file.path.starts_with(&home))
        .map(|file| file.path)
        .collect();
    if removed.is_empty() {
        return Err(ApiError::Conflict(format!(
            "change {id} removed nothing in project '{project}', so there is nothing to restore"
        )));
    }
    if pr.merge_base.is_empty() {
        return Err(ApiError::Unavailable(format!(
            "the forge did not say which commit change {id} was cut from; try again"
        )));
    }

    let default_branch = gitea.default_branch().await?;
    let mut uploads = Vec::with_capacity(removed.len());
    let mut restored: Vec<ResourceEnvelope> = Vec::new();
    for path in &removed {
        if gitea.get_file(path, &default_branch).await?.is_some() {
            return Err(ApiError::Conflict(format!(
                "'{path}' is in the project again, so change {id} has nothing left to restore"
            )));
        }
        let file = gitea.get_file(path, &pr.merge_base).await?.ok_or_else(|| {
            ApiError::Conflict(format!(
                "'{path}' is not in the commit change {id} was cut from; it cannot be restored"
            ))
        })?;
        // Every file answers to a kind: a manifest to its own, a native file (a LinkML source, a
        // bento.yaml) to the kind its directory names, the way an approval reads it (T-1400). A
        // file of no kind is restored by nobody, as it is approved by nobody.
        let manifest = serde_yaml_ng::from_str::<ResourceEnvelope>(&file.content).ok();
        let kind = match &manifest {
            Some(envelope) => envelope.kind.clone(),
            None => crate::api::import::native_kind(path)
                .map(str::to_owned)
                .ok_or_else(|| {
                    ApiError::Conflict(format!(
                        "'{path}' belongs to no kind this platform serves, so it cannot be restored"
                    ))
                })?,
        };
        if !effective.may(&kind, Verb::Propose) {
            return Err(ApiError::Denied(format!(
                "restoring '{path}' needs `propose` on {kind} in project '{project}'"
            )));
        }
        if let Some(envelope) = manifest {
            restored.push(envelope);
        }
        uploads.push((path.clone(), file.content));
    }
    let Some(headline) = restored.first() else {
        return Err(ApiError::Conflict(format!(
            "change {id} removed no manifest in project '{project}', so there is nothing to restore"
        )));
    };

    let restore_branch = format!("portal/restore-{number:08x}");
    let restore_branch =
        crate::api::mutate::create_or_reuse_branch(gitea, &restore_branch, &default_branch).await?;
    let (author_name, author_email) = crate::api::mutate::author_credentials(identity, project);
    let what = format!("{} {}", headline.kind, headline.metadata.name);
    gitea
        .change_files(
            &restore_branch,
            &format!("restore {what}, removed by {id}"),
            Author {
                name: &author_name,
                email: &author_email,
            },
            &uploads,
            &[],
        )
        .await?;
    let opened = gitea
        .create_pull_request(
            &restore_branch,
            &default_branch,
            &format!("restore {what}"),
            &format!(
                "Restores what change {id} removed from project `{project}`, as it was before: {}.",
                removed.join(", ")
            ),
        )
        .await?;

    let lane = restored.iter().fold(Lane::Green, |lane, envelope| {
        crate::api::import::riskiest(lane, change::classify_manifest(envelope, Operation::Create))
    });
    let status = ChangeStatus::new(
        lane,
        ChangePhase::PendingApproval,
        PlanSummary::new(restored.len(), 0, 0),
    )
    .in_repository(&opened.repository)
    .with_merge_request(opened.url);
    Ok(Change::new(
        change_meta(state, gitea, opened.number, project),
        status,
    ))
}

pub fn router() -> Router<AppState> {
    Router::new().route(
        "/projects/{project}/changes/{id}/restore",
        axum::routing::post(restore_change),
    )
}
