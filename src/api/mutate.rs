use std::hash::{Hash, Hasher};

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::Value;

use crate::api::dry_run::{self, DryRunQuery, DryRunResult};
use crate::auth::session::Front;
use crate::auth::CurrentUser;
use crate::change::{self, Change, ChangeMeta, ChangePhase, ChangeStatus, Operation};
use crate::error::{ApiError, ProblemDetails};
use crate::git::{Author, FileWrite, GitError};
use crate::plan;
use crate::resource::{self, ResourceEnvelope};
use crate::state::AppState;

/// Field names whose string values are credentials wherever they appear: refused on a write
/// (MF-24), redacted in a plan diff (CC-06) and dropped from an export (MF-17).
pub const SECRET_KEYS: &[&str] = &[
    "password",
    "token",
    "secret",
    "clientSecret",
    "apiKey",
    "client_secret",
    "api_key",
    // A CKAN instance is named by `apiTokenRef`; a pasted `apiToken` is the same mistake as
    // a pasted password and is refused the same way (EP-67).
    "apiToken",
    "api_token",
    // The keys a runner input writes a credential under, which the runner's own catalog did not
    // call secrets (T-2239). `key` is deliberately absent: a `secretRef` has one, and so does
    // every map in a manifest — the runner's own rule guards the paths where `key` is a private
    // key (`tls.client_certs[].key`, `jc_core::kinds::bento_inputs::SECRET_FIELDS`).
    "access_token",
    "accessToken",
    "access_token_secret",
    "accessTokenSecret",
    "consumer_secret",
    "consumerSecret",
    "auth_secret",
    "authSecret",
    "account_key",
    "accountKey",
    "bot_token",
    "botToken",
    "private_key",
    "privateKey",
    "private_key_pass",
    "privateKeyPass",
    "passphrase",
    "user_jwt",
    "userJwt",
    "user_nkey_seed",
    "userNkeySeed",
];

/// Detects string-valued literal secrets in manifest payloads (MF-24).
///
/// Returns the first offending key name if any string-valued key named `password`, `token`,
/// `secret`, `clientSecret` or `apiKey` exists at any depth. Object-valued secret references
/// (such as `secretRef: { name: "..." }`) are permitted.
pub fn find_literal_secret(val: &Value) -> Option<String> {
    match val {
        Value::Object(map) => {
            for (k, v) in map {
                // Any scalar: YAML reads `password: 123456` unquoted as a number, and it is still a
                // secret typed into a manifest (T-2540). `null` is an absent value.
                let scalar = v.is_string() || v.is_number() || v.is_boolean();
                if SECRET_KEYS.contains(&k.as_str()) && scalar {
                    return Some(k.clone());
                }
                if let Some(found) = find_literal_secret(v) {
                    return Some(found);
                }
            }
            None
        }
        Value::Array(arr) => {
            for item in arr {
                if let Some(found) = find_literal_secret(item) {
                    return Some(found);
                }
            }
            None
        }
        _ => None,
    }
}

fn parse_body_to_value(headers: &HeaderMap, bytes: &[u8]) -> Result<Value, ApiError> {
    let ct = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/json");
    let mime = ct.split(';').next().unwrap_or("").trim();

    if mime.is_empty() || mime == "application/json" || mime == "text/json" {
        serde_json::from_slice(bytes)
            .map_err(|e| ApiError::BadRequest(format!("invalid json body: {e}")))
    } else if mime == "application/yaml" || mime == "application/x-yaml" || mime == "text/yaml" {
        serde_yaml_ng::from_slice(bytes)
            .map_err(|e| ApiError::BadRequest(format!("invalid yaml body: {e}")))
    } else {
        Err(ApiError::UnsupportedMediaType(format!(
            "content type '{mime}' is not supported; expected application/json or application/yaml"
        )))
    }
}

fn parse_patch_to_value(headers: &HeaderMap, bytes: &[u8]) -> Result<Value, ApiError> {
    let ct = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let mime = ct.split(';').next().unwrap_or("").trim();

    if mime == "application/merge-patch+json" {
        serde_json::from_slice(bytes)
            .map_err(|e| ApiError::BadRequest(format!("invalid json patch: {e}")))
    } else if mime == "application/apply-patch+yaml" {
        serde_yaml_ng::from_slice(bytes)
            .map_err(|e| ApiError::BadRequest(format!("invalid yaml patch: {e}")))
    } else {
        Err(ApiError::UnsupportedMediaType(format!(
            "content type '{mime}' is not supported for PATCH; expected application/merge-patch+json or application/apply-patch+yaml"
        )))
    }
}

/// The branch a proposal lives on: one per project, kind, name and operation, so a retry
/// lands on the same pull request and a second proposal finds the open one (T-0883).
pub fn branch_name(project: &str, kind: &str, name: &str, operation: Operation) -> String {
    let op_str = match operation {
        Operation::Create => "create",
        Operation::Update => "update",
        Operation::Delete => "delete",
    };
    let kind_lower = kind.to_ascii_lowercase();

    let mut hasher = std::hash::DefaultHasher::new();
    (project, kind, name, operation).hash(&mut hasher);
    let hash_val = hasher.finish();
    let hex = format!("{hash_val:016x}");
    let short = &hex[..8];

    format!("portal/{op_str}-{kind_lower}-{name}-{short}")
}

/// Refuses a manifest the workspace does not cover (CC-76): another project, a resource not in
/// its list, a space not in its subtree.
pub(crate) fn within_workspace(
    workspace: &crate::ops::workspaces::Workspace,
    project: &str,
    kind: &str,
    envelope: &ResourceEnvelope,
) -> Result<(), ApiError> {
    let name = &envelope.metadata.name;
    let outside = |what: String| {
        Err(ApiError::BadRequest(format!(
            "workspace '{}' does not cover {what}; open one that does, or propose it on its own",
            workspace.name
        )))
    };
    if workspace.project != project {
        return outside(format!("project '{project}'"));
    }
    let space = if kind == "ContextSpace" {
        None
    } else {
        crate::permissions::space_ref(&serde_json::to_value(envelope).unwrap_or_default())
    };
    if !workspace.scope.covers(kind, name, space.as_deref()) {
        return outside(format!("{kind} '{name}'"));
    }
    Ok(())
}

/// The open change whose pull request still uses `branch`, if any (T-0883, T-0886).
pub(crate) async fn open_change_on(
    state: &AppState,
    gitea: &crate::git::GiteaClient,
    branch: &str,
    project: &str,
) -> Result<Option<ChangeMeta>, ApiError> {
    // A forge that answers 404 here has no repository at all, and the next step says so.
    let pulls = match gitea.list_pull_requests("open").await {
        Ok(pulls) => pulls,
        Err(GitError::NotFound) => Vec::new(),
        Err(err) => return Err(err.into()),
    };
    // A retry after a rejection opens on `{branch}-{nonce}` (T-0887): the same resource.
    let suffixed = format!("{branch}_");
    Ok(pulls
        .into_iter()
        .find(|pr| pr.head_branch == branch || pr.head_branch.starts_with(&suffixed))
        .map(|pr| crate::api::changes::change_meta(state, gitea, pr.number, project)))
}

/// The branch a proposal is written on, starting from the default branch. A branch left by
/// an earlier attempt is recreated, never reused: it may hold that attempt's writes (a file
/// already deleted, another content), which turned a delete into a forge 404 (T-0886). One a
/// live pull request still uses is left alone and the caller told (CC-34).
/// Whether main holds the resource the checks read from the mirror otherwise, at the path the
/// change writes (T-2674): another spec, labels, annotations, title or description. Only what both
/// say for certain counts: a resource the mirror does not hold yet (the branch read covers that),
/// no file at that path (a manifest kept under another path) or one the envelope cannot read is no
/// evidence, and the namespace is left out, which a file may leave to its path.
fn moved_on_main(
    judged: Option<&ResourceEnvelope>,
    on_main: Option<&crate::git::RepoFile>,
) -> bool {
    let (Some(judged), Some(Ok(main))) = (
        judged,
        on_main.map(|file| serde_yaml_ng::from_str::<ResourceEnvelope>(&file.content)),
    ) else {
        return false;
    };
    let (a, b) = (&judged.metadata, &main.metadata);
    judged.spec != main.spec
        || a.labels != b.labels
        || a.annotations != b.annotations
        || a.title != b.title
        || a.description != b.description
}

pub(crate) async fn create_or_reuse_branch(
    gitea: &crate::git::GiteaClient,
    branch: &str,
    default_branch: &str,
) -> Result<String, ApiError> {
    match gitea.create_branch(branch, default_branch).await {
        Ok(()) => Ok(branch.to_string()),
        Err(GitError::Conflict(_)) => {
            let suffixed = format!("{branch}_");
            if let Some(open) = gitea
                .list_pull_requests("open")
                .await?
                .into_iter()
                .find(|pr| pr.head_branch == branch || pr.head_branch.starts_with(&suffixed))
            {
                return Err(ApiError::Conflict(format!(
                    "a change is already open on this resource: chg-{:08x}; approve or reject it first",
                    open.number
                )));
            }
            // The forge closes, a moment later, every pull request whose head is a branch that
            // was deleted, matched by name: a request opened on the recreated name is closed at
            // birth (T-0887). The stale branch goes, the change opens on a fresh name; `_` is
            // no character of a resource name, so the list still reads the name (T-0889).
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or_default();
            let fresh = format!("{suffixed}{nanos:08x}");
            tracing::info!(stale = %branch, branch = %fresh, from = %default_branch, "replacing a stale branch");
            gitea.delete_branch(branch).await?;
            gitea.create_branch(&fresh, default_branch).await?;
            Ok(fresh)
        }
        Err(other) => Err(other.into()),
    }
}

/// The one status a proposal may carry: the build lane's `status.build` on an App (AP-73).
///
/// Everything else about `status` is refused as it always was, and so is a `status.build` from a
/// caller no role names as the build lane — the role whose `propose` on `App` is constrained to
/// that field is the field's only writer, and the refusal says so.
fn build_lane_write(
    state: &AppState,
    identity: &crate::auth::session::Identity,
    project: &str,
    kind: &str,
    body: &Value,
) -> Result<(), ApiError> {
    let computed = || {
        ApiError::BadRequest(
            "status is computed by the platform and cannot be specified in the manifest (MF-04)"
                .to_owned(),
        )
    };
    if kind != "App" {
        return Err(computed());
    }
    // `status.build` and nothing beside it: a phase or a condition is the reconciler's.
    let status = body.get("status").and_then(Value::as_object);
    let build_only = status.is_some_and(|members| {
        members.len() == 1 && members.contains_key("build") && !members["build"].is_null()
    });
    if !build_only {
        return Err(computed());
    }
    if !crate::permissions::for_request(state, identity, project)
        .may_write_status_field("App", "status.build")
    {
        return Err(ApiError::Denied(
            "status.build is written by the build lane when it publishes the artifact: the one \
             role whose propose on App is constrained to that field writes it, and nobody else \
             (AP-13a, AP-73)"
                .to_owned(),
        ));
    }
    // The lane writes the build of an App on `main` and nothing else of it (AP-73): a stolen
    // lane token can neither create an App nor change what one reads, shows or who opens it.
    let name = body
        .pointer("/metadata/name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let Some(current) = state.mirror.get(project, "App", name) else {
        return Err(ApiError::Denied(format!(
            "status.build is written back to an App on main; project {project} holds no App \
             '{name}' (AP-73)"
        )));
    };
    let map_at = |pointer: &str| -> std::collections::BTreeMap<String, String> {
        body.pointer(pointer)
            .and_then(|value| serde_json::from_value(value.clone()).ok())
            .unwrap_or_default()
    };
    if body.get("spec") != Some(&current.spec)
        || map_at("/metadata/labels") != current.metadata.labels
        || map_at("/metadata/annotations") != current.metadata.annotations
    {
        return Err(ApiError::Denied(format!(
            "the build lane writes status.build and nothing else: the spec, labels and \
             annotations of App '{name}' must stay as they are on main (AP-73)"
        )));
    }
    Ok(())
}

pub(crate) fn resolve_repo_path(
    envelope: &ResourceEnvelope,
    kind_info: &resource::KindInfo,
    project: &str,
) -> Result<String, ApiError> {
    // An Endpoint, a DataModel and a Subscription are filed under the space their
    // `contextSpaceRef` names, as jc-core's `context_space` says; every other kind under the
    // project's own space.
    let by_reference = matches!(kind_info.kind, "Endpoint" | "DataModel" | "Subscription");
    let space = envelope
        .metadata
        .labels
        .get("joinedcontext.com/space")
        .cloned()
        .or_else(|| {
            by_reference
                .then(|| crate::api::assistant::ref_name(&envelope.spec["contextSpaceRef"]))
                .flatten()
        })
        .or_else(|| envelope.metadata.namespace.clone());

    resource::repository_path(
        kind_info,
        project,
        space.as_deref(),
        &envelope.metadata.name,
    )
    .map_err(ApiError::BadRequest)
}

pub(crate) fn author_credentials(
    identity: &crate::auth::session::Identity,
    project: &str,
) -> (String, String) {
    let author_name = identity
        .name
        .as_deref()
        .unwrap_or(&identity.username)
        .to_string();
    let fallback_email = format!("{}@{project}.local", identity.username);
    let author_email = identity
        .email
        .as_deref()
        .unwrap_or(&fallback_email)
        .to_string();
    (author_name, author_email)
}

/// Shared mutation engine: validates manifest constraints, plans diffs, and submits
/// merge requests to Git under human authorship (MF-12, CC-03, CC-44, CC-63).
#[allow(clippy::too_many_arguments)]
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(untagged)]
pub enum ProposeOutcome {
    DryRun(DryRunResult),
    Change(Change),
    /// Committed to a workspace's branch; no Change exists until the workspace is brought back
    /// (CC-76, CC-79).
    Workspace(WorkspaceCommit),
}

/// What a proposal into a workspace wrote (CC-76).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, utoipa::ToSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCommit {
    pub workspace: String,
    pub branch: String,
    /// The manifest's path in the repository.
    pub path: String,
    pub lane: crate::change::Lane,
}

impl ProposeOutcome {
    pub fn into_value(self) -> serde_json::Value {
        match self {
            Self::DryRun(dr) => serde_json::to_value(dr).unwrap_or(serde_json::Value::Null),
            Self::Change(chg) => serde_json::json!({
                "changeId": chg.metadata.name,
                "lane": chg.status.lane,
                "url": chg.status.merge_request,
                "change": chg,
            }),
            Self::Workspace(commit) => {
                serde_json::to_value(commit).unwrap_or(serde_json::Value::Null)
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn propose(
    user: &CurrentUser,
    state: &AppState,
    project: &str,
    plural: &str,
    path_name: Option<&str>,
    operation: Operation,
    dry_run: bool,
    body_val: Value,
) -> Result<Response, ApiError> {
    let outcome = propose_with_identity(
        &user.0.identity,
        state,
        project,
        plural,
        path_name,
        operation,
        dry_run,
        body_val,
    )
    .await?;

    match outcome {
        ProposeOutcome::DryRun(res) => Ok((StatusCode::OK, Json(res)).into_response()),
        ProposeOutcome::Change(change) => Ok((StatusCode::ACCEPTED, Json(change)).into_response()),
        ProposeOutcome::Workspace(commit) => Ok((StatusCode::OK, Json(commit)).into_response()),
    }
}

/// The check this person just ran, kept under the manifest's own kind and name (PF-57): one
/// place, because a rejected manifest records the same kind of verdict a passing one does.
async fn record_check_as(
    user: &CurrentUser,
    front: Front,
    state: &AppState,
    project: &str,
    manifest: &Value,
    verdict: &crate::ops::verdict::Verdict,
) {
    let caller = crate::ops::Caller {
        identity: user.0.identity.clone(),
        via: match front {
            Front::Portal | Front::Edge => crate::ops::Via::Session,
            Front::Bearer => crate::ops::Via::Bearer,
        },
        access: None,
    };
    crate::ops::record_check(&caller, state, project, manifest, verdict).await;
}

/// The REST doors of a manifest that names no draft (PF-57, owner decision T-0956): its dry run
/// records a verdict under the manifest's own kind and name, and its proposal needs that verdict,
/// green and fresh for the same manifest, exactly as the draft door and the operations do. A
/// proposal that became a Change forgets the draft its check created.
#[allow(clippy::too_many_arguments)]
async fn propose_checked(
    user: &CurrentUser,
    front: Front,
    state: &AppState,
    project: &str,
    plural: &str,
    path_name: Option<&str>,
    operation: Operation,
    dry_run: bool,
    body_val: Value,
    workspace: Option<&str>,
    confirm: Option<&str>,
) -> Result<Response, ApiError> {
    let manifest = body_val.clone();
    if dry_run {
        let answer = propose_with_identity(
            &user.0.identity,
            state,
            project,
            plural,
            path_name,
            operation,
            true,
            body_val,
        )
        .await;
        let outcome = match answer {
            Ok(outcome) => outcome,
            Err(err) => {
                // A check that rejects the manifest records the red verdict and answers it, the way
                // a `DataSource` always has (T-2234): one shape for one outcome. Anything that is
                // not a judgement about the manifest stays the error it was.
                let Some(mut refused) = crate::api::dry_run::refused_check(&err, &manifest) else {
                    return Err(err);
                };
                let verdict = refused
                    .verdict
                    .clone()
                    .expect("refused_check sets a verdict");
                // The red verdict reaches the draft the person is working in and writes none of its
                // own: what this check refused can be a credential typed into the manifest, and a
                // draft created to hold it would store the value the refusal exists to stop.
                crate::ops::record_refused_check(state, project, &manifest, &verdict).await;
                refused.verdict = Some(verdict);
                return Ok((StatusCode::OK, Json(refused)).into_response());
            }
        };
        let ProposeOutcome::DryRun(mut result) = outcome else {
            return Err(ApiError::Internal("a dry run proposed a change".into()));
        };
        let verdict = if manifest.get("kind") == Some(&Value::from("DataSource")) {
            let answer =
                serde_json::to_value(&result).map_err(|e| ApiError::Internal(e.to_string()))?;
            crate::ops::datasource_verdict(&answer, &manifest)
        } else {
            // A dry run that got this far answered `valid: true`: every fault of the manifest is a
            // refusal above, where `refused_check` turns it into the findings (T-2234). So the
            // empty list here is a green verdict's own, and not a red one with nothing to resolve.
            crate::ops::verdict::Verdict::new(
                result.valid,
                Vec::new(),
                serde_json::to_value(&result.plan).ok(),
                &manifest,
            )
        };
        record_check_as(user, front, state, project, &manifest, &verdict).await;
        result.verdict = Some(verdict);
        return Ok((StatusCode::OK, Json(result)).into_response());
    }
    let outcome = propose_gated_in(
        &user.0.identity,
        state,
        project,
        plural,
        path_name,
        operation,
        body_val,
        workspace,
    )
    .await?;
    crate::ops::forget_check(state, project, &manifest).await;
    match outcome {
        ProposeOutcome::DryRun(res) => Ok((StatusCode::OK, Json(res)).into_response()),
        // A person at the Portal who administers every kind of it has it approved now (PF-58);
        // a bearer caller never does (AG-11).
        ProposeOutcome::Change(change) if front != Front::Bearer => {
            let kind = manifest
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let change = crate::api::changes::approve_as_proposed(
                state,
                &user.0.identity,
                project,
                kind,
                change,
                confirm,
            )
            .await;
            Ok((StatusCode::ACCEPTED, Json(change)).into_response())
        }
        ProposeOutcome::Change(change) => Ok((StatusCode::ACCEPTED, Json(change)).into_response()),
        ProposeOutcome::Workspace(commit) => Ok((StatusCode::OK, Json(commit)).into_response()),
    }
}

/// Shared mutation engine that operates on `Identity`: validates manifest constraints, plans diffs,
/// and submits merge requests to Git under human authorship (MF-12, CC-03, CC-44, CC-63).
/// Called by both session-based REST routes and the operations registry / MCP server. Asks for no
/// verdict: the draft door has asked already, and a published application was checked by its
/// preview. A manifest proposed without a draft goes through [`propose_gated`].
#[allow(clippy::too_many_arguments)]
pub async fn propose_with_identity(
    identity: &crate::auth::session::Identity,
    state: &AppState,
    project: &str,
    plural: &str,
    path_name: Option<&str>,
    operation: Operation,
    dry_run: bool,
    body_val: Value,
) -> Result<ProposeOutcome, ApiError> {
    propose_engine(
        identity, state, project, plural, path_name, operation, dry_run, body_val, false, None,
    )
    .await
}

/// [`propose_with_identity`] into the workspace `workspace`: the same checks (PF-82), then a
/// commit to its branch and no pull request; the workspace comes back as one Change (CC-76,
/// CC-79).
#[allow(clippy::too_many_arguments)]
pub async fn propose_into_workspace(
    identity: &crate::auth::session::Identity,
    state: &AppState,
    project: &str,
    plural: &str,
    path_name: Option<&str>,
    operation: Operation,
    body_val: Value,
    workspace: &str,
) -> Result<ProposeOutcome, ApiError> {
    propose_engine(
        identity,
        state,
        project,
        plural,
        path_name,
        operation,
        false,
        body_val,
        false,
        Some(workspace),
    )
    .await
}

/// [`propose_with_identity`] for a manifest that names no draft (PF-57, owner decision T-0956):
/// once the manifest has passed every check of its own, its proposal needs the verdict its check
/// recorded, green and fresh for this exact manifest, before anything reaches the forge.
#[allow(clippy::too_many_arguments)]
pub async fn propose_gated(
    identity: &crate::auth::session::Identity,
    state: &AppState,
    project: &str,
    plural: &str,
    path_name: Option<&str>,
    operation: Operation,
    body_val: Value,
) -> Result<ProposeOutcome, ApiError> {
    propose_gated_in(
        identity, state, project, plural, path_name, operation, body_val, None,
    )
    .await
}

/// [`propose_gated`] into a workspace when one is named: the REST doors' `?workspace=`
/// (API/01 §22), which asks for the same verdict as a write outside one (PF-82).
#[allow(clippy::too_many_arguments)]
pub async fn propose_gated_in(
    identity: &crate::auth::session::Identity,
    state: &AppState,
    project: &str,
    plural: &str,
    path_name: Option<&str>,
    operation: Operation,
    body_val: Value,
    workspace: Option<&str>,
) -> Result<ProposeOutcome, ApiError> {
    propose_engine(
        identity, state, project, plural, path_name, operation, false, body_val, true, workspace,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn propose_engine(
    identity: &crate::auth::session::Identity,
    state: &AppState,
    project: &str,
    plural: &str,
    path_name: Option<&str>,
    operation: Operation,
    dry_run: bool,
    mut body_val: Value,
    gated: bool,
    workspace: Option<&str>,
) -> Result<ProposeOutcome, ApiError> {
    // The manifest as it was sent, which is what its check judged and what the verdict is fresh for.
    let received = gated.then(|| body_val.clone());
    // 0. The files a manifest names but cannot contain (a Mapping's golden examples, DM-39),
    // taken out of the body the way `draft` is, before anything reads it as an envelope.
    let sidecar_files = body_val.as_object_mut().and_then(|map| map.remove("files"));
    // A Pipeline is written at v1alpha2 whoever writes it: the UI, an agent or MCP (PL-54).
    if operation != Operation::Delete {
        pipeline_second_shape(&mut body_val);
    }

    // 1. Resolve plural catalogue entry
    let kind_info = resource::by_plural(plural).ok_or_else(|| {
        ApiError::NotFound(format!(
            "plural '{plural}' not found in project '{project}'"
        ))
    })?;

    // 1a. Whether the caller may propose this kind here at all, before anything of the
    //     manifest is read: a viewer's create is a 403 whatever it sends, never a validation
    //     answer that teaches the kind's schema (T-2576, PF-50, PF-51). What the content may
    //     be is step 4c's.
    //     An App's default group is proposed by whoever may propose the App (AP-119).
    if !crate::groups::for_proposal(
        state,
        identity,
        project,
        kind_info.kind,
        operation == Operation::Update,
        &body_val,
    )
    .may(kind_info.kind, jc_core::kinds::Verb::Propose)
    {
        return Err(ApiError::Denied(format!(
            "no role grants propose on {} in project {project} (PF-50)",
            kind_info.kind
        )));
    }

    // 2. Deserialize envelope and validate apiVersion, kind and path name
    let mut envelope: ResourceEnvelope = serde_json::from_value(body_val.clone())
        .map_err(|e| ApiError::BadRequest(format!("invalid resource envelope: {e}")))?;

    if !jc_core::serves(&envelope.kind, &envelope.api_version) {
        return Err(ApiError::BadRequest(format!(
            "apiVersion '{}' is not supported (expected '{}')",
            envelope.api_version,
            resource::API_VERSION
        )));
    }

    if envelope.kind != kind_info.kind {
        return Err(ApiError::BadRequest(format!(
            "kind '{}' does not match plural '{}' (expected '{}')",
            envelope.kind, plural, kind_info.kind
        )));
    }

    if let Some(expected_name) = path_name {
        if envelope.metadata.name != expected_name {
            return Err(ApiError::BadRequest(format!(
                "metadata.name '{}' does not match path '{}'",
                envelope.metadata.name, expected_name
            )));
        }
    }

    // 3. Namespace validation and default filling
    match envelope.metadata.namespace.as_deref() {
        None | Some("") => {
            envelope.metadata.namespace = Some(project.to_string());
        }
        Some(ns) if ns == project => {}
        Some(foreign) => {
            return Err(ApiError::BadRequest(format!(
                "metadata.namespace '{foreign}' does not match project '{project}'"
            )));
        }
    }

    // 3a. One string written over a stored legacy map replaces the entry it resolves to and keeps
    //     every other language, whichever door sent it (UI-50, T-2764).
    if operation == Operation::Update {
        if let Some(stored) = state
            .mirror
            .get(project, kind_info.kind, &envelope.metadata.name)
        {
            keep_languages(&mut envelope.metadata.title, stored.metadata.title.as_ref());
            keep_languages(
                &mut envelope.metadata.description,
                stored.metadata.description.as_ref(),
            );
            body_val["metadata"] = serde_json::to_value(&envelope.metadata)
                .map_err(|e| ApiError::Internal(e.to_string()))?;
        }
    }

    // 4. Metadata DNS-1123, status rejection (MF-04) and secret rejection (MF-24)
    resource::validate_meta(&envelope.metadata).map_err(ApiError::BadRequest)?;

    // `status` is the platform's own computation and no manifest carries it (MF-04) — with one
    // door: the build lane writes `status.build` back in the commit that publishes the artifact
    // an App runs (AP-13a, AP-73). That write keeps its status; every other one is refused.
    let build_write = if body_val.get("status").is_some() || envelope.status.is_some() {
        build_lane_write(state, identity, project, kind_info.kind, &body_val)?;
        true
    } else {
        false
    };

    if let Some(secret_key) = find_literal_secret(&body_val) {
        return Err(ApiError::BadRequest(format!(
            "literal secret in field '{secret_key}' is forbidden; use secretRef instead (MF-24)"
        )));
    }

    // A digest is not something a person types: the build lane writes it back when it publishes
    // the image it built here, and an App deploys what it names. Typed in, or carried in from
    // another instance, it would run an image this platform never built (AP-11, AP-13a).
    if let Some(key) = crate::apps::converge::BUILT_ANNOTATIONS
        .into_iter()
        .find(|key| envelope.metadata.annotations.contains_key(*key))
    {
        return Err(ApiError::BadRequest(format!(
            "annotation '{key}' is written by the build lane when it publishes an image and \
             cannot be set in a proposal (AP-11, AP-13a)"
        )));
    }

    // A published static App names its repository, unless the Portal image ships its bundle
    // (AP-87). jc-core believes the annotation; this door checks the bundle is really here, so
    // the annotation cannot publish an application nothing serves.
    if operation != Operation::Delete {
        if let Some(refusal) =
            crate::apps::static_host::unshipped_claim(state.config.apps_dir.as_deref(), &envelope)
        {
            return Err(ApiError::BadRequest(refusal));
        }
    }

    // 4a'. A kind jc-core does not define is a kind no loader can read: `jcctl`, the Portal's
    //       own sync and the gateway's store all refuse an unknown kind and refuse the whole
    //       repository with it, so one such file stops configuration reaching every endpoint.
    //       What is left of that gap is the seed entity: a plain `.json` NGSI-LD entity (CC-72),
    //       never a `kind: Entity` manifest. `Subscription` closed it with jc-core-v0.7.30 and
    //       is written like any other kind now (T-0833, T-0913).
    if jc_core::registry::by_kind(kind_info.kind).is_none() {
        return Err(ApiError::BadRequest(format!(
            "kind '{}' is declared but not defined by the platform yet, and a repository holding \
             one stops loading for every component; it cannot be written (CC-72, T-0833)",
            kind_info.kind
        )));
    }

    // 4b. The kind's own parse and invariants (T-0412, CC-08, MF-24). `jcctl apply` would
    //     refuse this manifest on `main`, after an approval; refusing it here turns a broken
    //     repository into a form error that names the field. Kinds without a jc-core type
    //     (PORTAL_ONLY_KINDS) have nothing to check against and pass as before.
    if let Some(checked) = jc_core::registry::validate_yaml(
        kind_info.kind,
        &serde_json::to_string(&envelope).map_err(|e| ApiError::Internal(e.to_string()))?,
    ) {
        checked.map_err(|e| {
            ApiError::BadRequest(format!("spec is not a valid {}: {e}", kind_info.kind))
        })?;
    }

    // 4d. A projection names only what its model version has (MP-01, T-2558): the same check
    //     `jcctl validate` runs, so the two cannot disagree about what is stale, and every stale
    //     name is listed at once. The model is looked up in this project only, so a model of
    //     another project is absent and nothing of it is named (R20).
    if kind_info.kind == "ModelProjection" && operation != Operation::Delete {
        check_projection(state, project, &envelope.spec).await?;
    }

    // 4c. A ServiceAccount's Keycloak client id is derived, `{project}-{name}`, and the hyphen
    //     is a character of both, so another project's account may derive the same id. The
    //     gateway resolves such an id to nobody (T-1454); refusing it here keeps a proposal from
    //     switching off the other project's account. The other account is not named: it may live
    //     in a project the author cannot read (PF-59).
    if kind_info.kind == "ServiceAccount" {
        use jc_core::kinds::service_account::keycloak_client_id;
        let id = keycloak_client_id(project, &envelope.metadata.name);
        let taken = state.mirror.namespaces().into_iter().any(|namespace| {
            state
                .mirror
                .list(
                    &namespace,
                    "ServiceAccount",
                    &crate::store::ListOptions::default(),
                )
                .items
                .iter()
                .any(|account| {
                    (namespace.as_str(), account.metadata.name.as_str())
                        != (project, envelope.metadata.name.as_str())
                        && keycloak_client_id(&namespace, &account.metadata.name) == id
                })
        });
        if taken {
            return Err(ApiError::BadRequest(format!(
                "metadata.name '{}' gives the Keycloak client id '{id}', which another \
                 ServiceAccount already derives; choose another name (T-1456)",
                envelope.metadata.name
            )));
        }
    }

    // 4b''. An agent profile names only operations this Portal registers (MF-40): jc-core checks
    //       the shape of an operation name, the registry is the Portal's to know.
    if kind_info.kind == "AgentProfile" {
        let unknown = envelope
            .spec
            .pointer("/access/operations")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .find(|name| crate::ops::find(name).is_none());
        if let Some(name) = unknown {
            return Err(ApiError::BadRequest(format!(
                "spec.access.operations names '{name}', which is not a registered operation (MF-40)"
            )));
        }
    }

    // 4b'. A public dashboard reads only through public Endpoints (UI-19, T-0528): the one
    //      rule that spans three manifests, so it is checked against the mirror here.
    crate::dashboards::check(
        &state.mirror,
        project,
        kind_info.kind,
        &envelope.metadata.name,
        &envelope.spec,
    )?;

    // 4b-quota. What the project may hold (PF-73, PF-74): the count the repository would have
    //       after this write, against the quota in force. Refused here, before a Change exists,
    //       so every door - the route, an operation, the assistant, an import - refuses it.
    if operation != Operation::Delete {
        crate::quotas::check(
            &state.mirror,
            project,
            kind_info.kind,
            &envelope.metadata.name,
            &envelope.spec,
        )?;
    }

    // 4b-contact. A catalogue record publishes its contact point to everyone, so a person's own
    //       address is refused at every door (EP-80, T-2789).
    if operation != Operation::Delete {
        crate::catalog::check_contact(&state.mirror, identity, kind_info.kind, &envelope.spec)?;
    }

    // 4c. Who may propose this kind here, with this content (T-0526, PF-50): the bindings of
    //     the organization repository, before a Change exists. 403 names the verb or the field.
    //     A build write was judged by `build_lane_write`: the lane's rule, the App on main and
    //     nothing of it changed (AP-73).
    if !build_write {
        crate::groups::for_proposal(
            state,
            identity,
            project,
            kind_info.kind,
            operation == Operation::Update,
            &body_val,
        )
        .check(
            kind_info.kind,
            jc_core::kinds::Verb::Propose,
            Some(&body_val),
        )?;
    }
    // 4d. Nobody grants above their own rights (PF-52, AG-77).
    crate::permissions::within_own_rights(state, identity, &body_val, "proposer")?;

    // 4e. A Context Space name is unique in the organization (PF-44, PF-76): a name another
    //     project holds is refused here — after the caller's right to propose one at all, so
    //     nobody probes the organization's names through this door, and before a Change exists,
    //     so every door answers the same refusal, the dry run included.
    if operation != Operation::Delete {
        crate::spaces::check(
            state,
            identity,
            project,
            kind_info.kind,
            &envelope.metadata.name,
            &envelope.spec,
        )?;
    }

    // 4f. An App name is one address for the organization (AP-14a): `/apps/{name}/` carries no
    //     project, so another project's App of the same name is refused before a Change exists.
    if operation != Operation::Delete {
        crate::apps::names::check(
            state,
            identity,
            project,
            kind_info.kind,
            &envelope.metadata.name,
        )?;
    }

    // 4g. A Group name is one Keycloak group for the organization (AP-115): one owned by the
    //     organization or another App, or held by the realm unmanaged, is refused here.
    if operation != Operation::Delete {
        crate::groups::check(state, identity, kind_info.kind, &envelope.metadata)?;
    }

    // Every resource this manifest names has to be there, so a person meets a missing name in the
    // form they typed it into and not in the reconciler's log (MF-13, T-2233).
    if operation != Operation::Delete {
        crate::references::check(&state.mirror, project, kind_info.kind, &envelope.spec)?;
    }

    // 4h. Every role of an App comes with its default group, in the same Change (AP-118,
    //     ADR-N-031): the group of a new role and its access entry are written, the group of a
    //     role taken away, or of a retired App, is removed. A project in its own repository
    //     (layout 2) cannot carry an organization file in its Change, so its Apps keep their
    //     access as written. A build write leaves the App as it is on main (AP-73).
    let default_groups = if kind_info.kind == "App"
        && operation != Operation::Delete
        && !build_write
        && state.mirror.repository_of(project).is_none()
    {
        let planned = crate::apps::default_groups::plan(state, identity, project, &mut envelope)?;
        crate::apps::default_groups::release(&mut envelope, &planned.removed);
        planned
    } else {
        crate::apps::default_groups::DefaultGroups::default()
    };

    // 4d. A new space comes with its one model, in the same Change (DM-61, DM-62, ADR-N-033),
    //     whoever creates it: the form, the API, the assistant or MCP.
    let space_model = if kind_info.kind == "ContextSpace" && operation == Operation::Create {
        space_model(state, project, &mut envelope)
    } else {
        Vec::new()
    };

    // 5. Diff against current mirror state
    let current = state
        .mirror
        .get(project, kind_info.kind, &envelope.metadata.name);
    let mut plan = plan::diff(current.as_ref(), Some(&envelope));

    // The same folder as the manifest, so a path is checked against where it will be written.
    let manifest_path = resolve_repo_path(&envelope, kind_info, project)?;
    let mut sidecars = sidecars(sidecar_files, &manifest_path)?;
    let folder = manifest_path.rsplit_once('/').map_or("", |(dir, _)| dir);
    for (relative, content) in space_model {
        let full = format!("{folder}/{relative}");
        // A caller that sent the model's files itself keeps its own.
        if !sidecars.iter().any(|(path, _)| *path == full) {
            sidecars.push((full, content));
        }
    }
    for (path, content) in &sidecars {
        plan.fields.push(plan::FieldChange {
            path: format!("files.{path}"),
            from: None,
            to: Some(Value::from(content.len())),
        });
    }

    // 5a. What an App grants rides in the same change as the App (CC-61, AP-96, T-2632): the
    //     gateway reads endpoints and policies from the repository alone, so a grant nobody
    //     commits is a grant it never enforces. The reviewer reads each one in the plan.
    // A build write leaves the App as it is on main (AP-73), so it carries no grant either.
    let mut grants = if kind_info.kind == "App" && operation != Operation::Delete && !build_write {
        app_grants(state, project, &envelope)?
    } else {
        AppGrants::default()
    };
    group_files(&default_groups, project, &mut grants)?;
    plan.fields.extend(grants.review.iter().cloned());

    // 6. Risk-classified approval lane
    let lane = change::classify(kind_info.kind, operation, &envelope.spec);
    // OPS-16: the one series no other component can produce. A rise in red proposals is a
    // change in what people are asking the platform to do.
    crate::telemetry::proposed(lane, kind_info.kind);

    // 7. Dry run short-circuit; an `http` DataSource is also fetched once (MF-39).
    if dry_run {
        let probe = if kind_info.kind == "DataSource" {
            crate::api::pipeline_test::probe_source(state, project, &envelope.spec).await
        } else {
            None
        };
        return Ok(ProposeOutcome::DryRun(DryRunResult {
            valid: true,
            restarts_stream: crate::plan::restarts_stream(kind_info.kind, &plan),
            lane,
            plan,
            probe,
            verdict: None,
            findings: if kind_info.kind == "Environment" {
                // An overlay is where the domain is written out (CC-73).
                Vec::new()
            } else {
                crate::api::dry_run::literal_domain_findings(
                    &envelope.spec,
                    // No fallback: an instance that does not know its domain finds nothing.
                    &crate::api::assistant::org_domain(state, ""),
                )
            },
        }));
    }

    // 7a. The verdict, after every check of the manifest's own and before the forge (T-0956).
    if let Some(received) = &received {
        crate::ops::verdict_for_manifest(state, project, received).await?;
    }

    // 8. Commit to Git merge request via Gitea client
    let gitea = state
        .forge_for(project)
        .ok_or_else(|| ApiError::Unavailable("git forge is not configured".into()))?;
    let gitea: &crate::git::GiteaClient = &gitea;

    let default_branch = gitea.default_branch().await?;

    // 8a. Every check above judged the body against the mirror, and a fresh branch starts at
    //     main. A mirror that has not caught up with main on this resource would put the body
    //     over a newer main, and whatever the checks took for unchanged would revert what main
    //     moved to: the build lane's status write once undid the bootstrap's new pin (T-2674).
    if workspace.is_none() {
        let on_main = gitea.get_file(&manifest_path, &default_branch).await?;
        if moved_on_main(current.as_ref(), on_main.as_ref()) {
            return Err(ApiError::Conflict(format!(
                "{} '{}' changed on {default_branch} after the Portal last read it; read it \
                 again and send the change once more",
                kind_info.kind, envelope.metadata.name
            )));
        }
    }

    // 8b. A lane's build is checked against the App's repository and published by the Portal
    //     before anything is written: the lane's token names a build, it never makes one
    //     (AP-101, AP-104).
    if build_write {
        crate::apps::built::check_and_publish(
            gitea,
            project,
            &envelope.metadata.name,
            &envelope.spec,
            body_val.pointer("/status/build").unwrap_or(&Value::Null),
        )
        .await?;
    }

    let op_str = match operation {
        Operation::Create => "create",
        Operation::Update => "update",
        Operation::Delete => "delete",
    };

    let branch = match workspace {
        // A workspace is one branch for everything it holds (CC-76): no per-resource branch,
        // no pull request, and a change open on `main` does not stop an edit here.
        Some(name) => {
            let open = state
                .workspaces
                .live(name)
                .await
                .map_err(|err| ApiError::NotFound(err.to_string()))?;
            within_workspace(&open, project, kind_info.kind, &envelope)?;
            if !crate::ops::workspaces::owns(&open, identity) {
                return Err(ApiError::Denied(format!(
                    "workspace '{name}' belongs to {}; only its owner writes into it",
                    open.owner
                )));
            }
            let branch = open.branch();
            match gitea.create_branch(&branch, &default_branch).await {
                Ok(()) | Err(GitError::Conflict(_)) => {}
                Err(err) => return Err(err.into()),
            }
            branch
        }
        None => {
            let branch = branch_name(project, kind_info.kind, &envelope.metadata.name, operation);
            // One open change per resource (CC-34): the branch is one per resource and
            // operation, so a second proposal while one is pending would rewrite the open pull
            // request under its approver. Refused before anything is written, naming the change
            // to decide first (T-0883).
            if let Some(pending) = open_change_on(state, gitea, &branch, project).await? {
                return Err(ApiError::Conflict(format!(
                    "a change for {} '{}' is already open: {}; approve or reject it first",
                    kind_info.kind, envelope.metadata.name, pending.name
                )));
            }
            create_or_reuse_branch(gitea, &branch, &default_branch).await?
        }
    };
    let repo_path = manifest_path;

    let mut envelope_to_commit = envelope.clone();
    if !build_write {
        envelope_to_commit.strip_status();
    }
    let yaml_content = serde_yaml_ng::to_string(&envelope_to_commit)
        .map_err(|e| ApiError::Internal(format!("serialize manifest to yaml: {e}")))?;

    // Gitea wants the blob sha of the file being replaced, which only `get_file` knows;
    // `status.observedRevision` is a commit id and would be rejected. Asking the branch (not the
    // mirror) also covers a manifest that exists in Git but has not been mirrored yet.
    let existing_sha = gitea
        .get_file(&repo_path, &branch)
        .await
        .ok()
        .flatten()
        .map(|f| f.sha);

    let (author_name, author_email) = author_credentials(identity, project);
    let commit_msg = format!("{op_str} {} {}", kind_info.kind, envelope.metadata.name);

    let file_write = FileWrite {
        path: &repo_path,
        branch: &branch,
        message: &commit_msg,
        content: &yaml_content,
        sha: existing_sha.as_deref(),
        author: Author {
            name: &author_name,
            email: &author_email,
        },
    };

    // The files first: a reviewer opening the merge request never reads a manifest naming a file
    // the change does not carry, and a refusal on one of them leaves no manifest behind.
    for (path, content) in &sidecars {
        let existing = gitea
            .get_file(path, &branch)
            .await
            .ok()
            .flatten()
            .map(|f| f.sha);
        gitea
            .put_file(&FileWrite {
                path,
                branch: &branch,
                message: &commit_msg,
                content,
                sha: existing.as_deref(),
                author: Author {
                    name: &author_name,
                    email: &author_email,
                },
            })
            .await?;
    }

    if !grants.uploads.is_empty() || !grants.removed.is_empty() {
        let mut deletes = Vec::new();
        for path in &grants.removed {
            if let Some(file) = gitea.get_file(path, &branch).await? {
                deletes.push((path.clone(), file.sha));
            }
        }
        gitea
            .change_files(
                &branch,
                &commit_msg,
                Author {
                    name: &author_name,
                    email: &author_email,
                },
                &grants.uploads,
                &deletes,
            )
            .await?;
    }

    gitea.put_file(&file_write).await?;

    if let Some(name) = workspace {
        return Ok(ProposeOutcome::Workspace(WorkspaceCommit {
            workspace: name.to_owned(),
            branch,
            path: repo_path,
            lane,
        }));
    }

    let pr_title = format!("{op_str} {} {}", kind_info.kind, envelope.metadata.name);
    let pr_body = format!(
        "Proposed {op_str} of {} `{}` in project `{project}` via joinedcontext Portal.",
        kind_info.kind, envelope.metadata.name
    );

    let pr = gitea
        .create_pull_request(&branch, &default_branch, &pr_title, &pr_body)
        .await?;

    // 9. Answer 202 Accepted with Change resource
    let change_meta = crate::api::changes::change_meta(state, gitea, pr.number, project);
    let change_status = ChangeStatus::new(lane, ChangePhase::PendingApproval, plan.summary)
        .in_repository(&pr.repository)
        .with_merge_request(pr.url.clone());
    let change = Change::new(change_meta, change_status);

    // 10. The build lane's write, checked and published in 8b, is approved by the Portal: a person
    //     approved the source, the lane approves nothing (AP-73, AP-104, AG-11).
    let change = if build_write {
        crate::api::changes::approve_build(state, gitea, &pr, &repo_path, change).await
    } else {
        change
    };

    Ok(ProposeOutcome::Change(change))
}

/// The grants one App proposal commits and removes (CC-61, AP-96).
#[derive(Default)]
struct AppGrants {
    /// `(path, yaml)` of the App's Endpoint and every Policy it compiles to.
    uploads: Vec<(String, String)>,
    /// Paths of generated grants of this App that it no longer compiles to: a role taken away,
    /// a need removed, or the App leaving `preview`/`published`, where it grants nothing.
    removed: Vec<String>,
    /// One line per grant, so the review names who may do what (AP-98).
    review: Vec<plan::FieldChange>,
}

/// Compiles an App's Endpoint and Policies for the change that proposes it (T-2632).
///
/// The slug is the App's Endpoint's own once it has one, and a fresh one (EP-02) the first time,
/// so republishing never moves the endpoint under its readers. Only what the reconciler generated
/// is replaced or removed: an Endpoint or Policy of the same name somebody wrote by hand is
/// refused, never overwritten.
fn app_grants(
    state: &AppState,
    project: &str,
    envelope: &ResourceEnvelope,
) -> Result<AppGrants, ApiError> {
    use crate::apps::reconciler::{generate_slug, grants, RenderError, GENERATOR};
    use jc_core::annotations::GENERATED_BY;

    let name = &envelope.metadata.name;
    let endpoint_name = format!("app-{name}");
    let generated = |env: &ResourceEnvelope| {
        env.metadata
            .annotations
            .get(GENERATED_BY)
            .map(String::as_str)
            == Some(GENERATOR)
    };
    let current_endpoint = state.mirror.get(project, "Endpoint", &endpoint_name);
    if let Some(endpoint) = current_endpoint.as_ref().filter(|env| !generated(env)) {
        return Err(ApiError::Conflict(format!(
            "Endpoint '{}' in project '{project}' was not generated for App '{name}', and the \
             App's own endpoint has that name: rename one of them (AP-04, T-2632)",
            endpoint.metadata.name
        )));
    }
    let slug = current_endpoint
        .as_ref()
        .and_then(|env| env.spec.get("slug").and_then(Value::as_str))
        .and_then(|slug| jc_core::kinds::EndpointSlug::new(slug).ok())
        .unwrap_or_else(generate_slug);

    let manifest: jcctl::loader::RawManifest = serde_json::from_value(
        serde_json::to_value(envelope).map_err(|e| ApiError::Internal(e.to_string()))?,
    )
    .map_err(|e| ApiError::Internal(format!("the App as a manifest: {e}")))?;
    let domain = crate::api::assistant::org_domain(state, project);
    let compiled = match grants(&manifest, &slug, &domain) {
        Ok((endpoint, policies)) => std::iter::once(endpoint).chain(policies).collect(),
        // A draft or a retired App grants nothing (AP-18, AP-21).
        Err(RenderError::NotDeployable { .. }) => Vec::new(),
        Err(err) => return Err(ApiError::BadRequest(err.to_string())),
    };

    let mut out = AppGrants::default();
    let mut kept = std::collections::BTreeSet::new();
    for raw in compiled {
        let env: ResourceEnvelope = serde_json::from_value(
            serde_json::to_value(&raw).map_err(|e| ApiError::Internal(e.to_string()))?,
        )
        .map_err(|e| ApiError::Internal(format!("a generated {}: {e}", raw.kind)))?;
        if raw.kind == "Policy" {
            if let Some(held) = state
                .mirror
                .get(project, "Policy", &env.metadata.name)
                .filter(|held| !generated(held))
            {
                return Err(ApiError::Conflict(format!(
                    "Policy '{}' in project '{project}' was not generated for App '{name}' and \
                     has the name its grant needs: rename it (AP-05, T-2632)",
                    held.metadata.name
                )));
            }
            out.review.push(plan::FieldChange {
                path: format!("grants.{}", env.metadata.name),
                from: None,
                to: Some(Value::from(review_line(name, &env.spec))),
            });
        }
        // The same check the App itself passed: a grant the gateway's loader would refuse
        // fails here, as a form error, not after the approval.
        if let Some(checked) = jc_core::registry::validate_yaml(
            &raw.kind,
            &serde_json::to_string(&env).map_err(|e| ApiError::Internal(e.to_string()))?,
        ) {
            checked.map_err(|e| {
                ApiError::BadRequest(format!("the App's {} is not valid: {e}", raw.kind))
            })?;
        }
        let info = resource::by_kind(&raw.kind)
            .ok_or_else(|| ApiError::Internal(format!("no catalogue entry for {}", raw.kind)))?;
        let path = resolve_repo_path(&env, info, project)?;
        kept.insert((raw.kind.clone(), env.metadata.name.clone()));
        let yaml = serde_yaml_ng::to_string(&env)
            .map_err(|e| ApiError::Internal(format!("serialize {}: {e}", raw.kind)))?;
        out.uploads.push((path, yaml));
    }

    for held in held_grants(state, project, name) {
        if kept.contains(&(held.kind.clone(), held.metadata.name.clone())) {
            continue;
        }
        let info = resource::by_kind(&held.kind)
            .ok_or_else(|| ApiError::Internal(format!("no catalogue entry for {}", held.kind)))?;
        out.removed.push(resolve_repo_path(&held, info, project)?);
        out.review.push(plan::FieldChange {
            path: format!("grants.{}", held.metadata.name),
            from: Some(Value::from(held.kind.clone())),
            to: None,
        });
    }
    Ok(out)
}

/// The default groups an App's Change writes and removes (AP-118), as files and review lines
/// beside its grants; a group removed with members in it is said in the plan.
fn group_files(
    groups: &crate::apps::default_groups::DefaultGroups,
    project: &str,
    grants: &mut AppGrants,
) -> Result<(), ApiError> {
    let info = resource::by_kind("Group")
        .ok_or_else(|| ApiError::Internal("no catalogue entry for Group".into()))?;
    for group in &groups.written {
        let yaml = serde_yaml_ng::to_string(group)
            .map_err(|e| ApiError::Internal(format!("serialize Group: {e}")))?;
        grants
            .uploads
            .push((resolve_repo_path(group, info, project)?, yaml));
        grants.review.push(plan::FieldChange {
            path: format!("groups.{}", group.metadata.name),
            from: None,
            to: Some(Value::from("an empty default group, ready to assign")),
        });
    }
    for group in &groups.removed {
        grants
            .removed
            .push(resolve_repo_path(group, info, project)?);
        grants.review.push(plan::FieldChange {
            path: format!("groups.{}", group.metadata.name),
            from: Some(Value::from("Group")),
            to: None,
        });
    }
    for (index, warning) in groups.warnings.iter().enumerate() {
        grants.review.push(plan::FieldChange {
            path: format!("warnings.groups.{index}"),
            from: None,
            to: Some(Value::from(warning.clone())),
        });
    }
    Ok(())
}

/// The Endpoint and Policies the reconciler generated for App `app` of `project` (T-2632).
///
/// A generated Policy is the App's when it is granted to the App's endpoint, one of its roles, or
/// its service account: by name alone, `app-bikes-2-1` could be App `bikes-2`'s.
pub(crate) fn held_grants(state: &AppState, project: &str, app: &str) -> Vec<ResourceEnvelope> {
    use jc_core::annotations::GENERATED_BY;
    let endpoint_name = format!("app-{app}");
    let caller = jc_core::kinds::endpoint_role(project, &endpoint_name, None);
    let role_of_app = format!("{caller}/");
    let this_apps = |assignee: &Value| {
        let id = assignee["id"].as_str().unwrap_or_default();
        match assignee["kind"].as_str() {
            Some("role") => id == caller || id.starts_with(&role_of_app),
            Some("serviceAccount") => id == endpoint_name,
            _ => false,
        }
    };
    state.mirror.matching(|env| {
        env.metadata.namespace.as_deref() == Some(project)
            && env
                .metadata
                .annotations
                .get(GENERATED_BY)
                .map(String::as_str)
                == Some(crate::apps::reconciler::GENERATOR)
            && ((env.kind == "Endpoint" && env.metadata.name == endpoint_name)
                || (env.kind == "Policy" && this_apps(&env.spec["assignee"])))
    })
}

/// One grant as a reviewer reads it: who, which operations, on which types (AP-98).
fn review_line(app: &str, policy: &Value) -> String {
    let join = |value: &Value, key: &str| {
        value
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        if key.is_empty() {
                            item.as_str().map(str::to_owned)
                        } else {
                            item.get(key).and_then(Value::as_str).map(str::to_owned)
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default()
    };
    let operations = join(&policy["operations"], "");
    let types = join(&policy["information"][0]["entities"], "type");
    let who = policy["assignee"]["id"]
        .as_str()
        .and_then(|id| id.rsplit_once('/'))
        .map(|(_, last)| last.to_owned())
        .filter(|last| last != &format!("app-{app}"));
    match who {
        Some(role) => format!("role {role} of {app} can {operations} {types}"),
        None => format!("everyone who can open {app} can {operations} {types}"),
    }
}

/// What a body's `files` member commits beside the manifest, each path resolved against the
/// manifest's own folder (DM-39, `API/01 §4`).
///
/// A Mapping cannot be accepted without a golden test, and the two documents that test reads are
/// files, not manifest fields. Rather than a route per kind that needs one, the propose body
/// carries them and the Change commits them to the same branch. Every path stays under the
/// manifest's folder: the body decides what a change contains, so a path that climbs out of it
/// would let a proposal of a Mapping rewrite a Policy, a Role binding or the project file, under
/// the propose permission of a different kind.
const MAX_SIDECARS: usize = 16;
const MAX_SIDECAR_BYTES: usize = 256 * 1024;

/// A `ModelProjection` against the LinkML of the DataModel version it references (MP-01).
async fn check_projection(state: &AppState, project: &str, spec: &Value) -> Result<(), ApiError> {
    use jc_core::kinds::{DataModelSpec, ModelProjectionSpec};
    // The kind's own parse ran above; a spec it accepted parses here too.
    let projection: ModelProjectionSpec = serde_json::from_value(spec.clone())
        .map_err(|e| ApiError::BadRequest(format!("spec is not a valid ModelProjection: {e}")))?;
    let wanted = &projection.data_model_ref;
    let model = state
        .mirror
        .get(project, "DataModel", &wanted.name)
        .and_then(|model| serde_json::from_value::<DataModelSpec>(model.spec).ok())
        .ok_or_else(|| {
            ApiError::BadRequest(format!(
                "spec.dataModelRef names DataModel '{}', which this project does not declare \
                 (MP-01)",
                wanted.name
            ))
        })?;
    if model.version.major().to_string() != wanted.version {
        return Err(ApiError::BadRequest(format!(
            "spec.dataModelRef names version {} of DataModel '{}', which is at {} (MP-01)",
            wanted.version, wanted.name, model.version
        )));
    }
    let linkml = crate::api::datamodels::read_source(state, project, &wanted.name).await?;
    projection
        .check_against_linkml(&linkml)
        .map_err(|e| ApiError::BadRequest(format!("spec is not a valid ModelProjection: {e}")))
}

fn sidecars(files: Option<Value>, manifest_path: &str) -> Result<Vec<(String, String)>, ApiError> {
    let Some(files) = files else {
        return Ok(Vec::new());
    };
    let files = files.as_object().ok_or_else(|| {
        ApiError::BadRequest(
            "'files' is an object of path to file content; see API/01 §4".to_owned(),
        )
    })?;
    if files.len() > MAX_SIDECARS {
        return Err(ApiError::BadRequest(format!(
            "a proposal carries at most {MAX_SIDECARS} files beside its manifest, not {}; a repository's worth of files is an import (POST …/import)",
            files.len()
        )));
    }
    let folder = manifest_path.rsplit_once('/').map_or("", |(dir, _)| dir);

    let mut written: Vec<(String, String)> = Vec::new();
    let mut bytes = 0usize;
    for (path, content) in files {
        let content = content.as_str().ok_or_else(|| {
            ApiError::BadRequest(format!(
                "file '{path}' is not text; its content is a string"
            ))
        })?;
        let relative = path.strip_prefix("./").unwrap_or(path);
        let bad = relative.is_empty()
            || relative.starts_with('/')
            || relative.contains('\\')
            || relative.contains('\0')
            || relative
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..");
        if bad {
            return Err(ApiError::BadRequest(format!(
                "file path '{path}' is not a path under the manifest's own folder; it is relative, has no '..' and no leading '/'"
            )));
        }
        let full = format!("{folder}/{relative}");
        if written.iter().any(|(already, _)| already == &full) {
            return Err(ApiError::BadRequest(format!(
                "file path '{path}' is sent twice"
            )));
        }
        bytes += content.len();
        if bytes > MAX_SIDECAR_BYTES {
            return Err(ApiError::BadRequest(format!(
                "the files beside the manifest are more than {MAX_SIDECAR_BYTES} bytes together; a repository's worth of files is an import (POST …/import)"
            )));
        }
        written.push((full, content.to_owned()));
    }
    Ok(written)
}

/// The empty model a new space is created with, as files beside the space manifest, and the
/// space's `spec.dataModelRef` naming it (DM-61, DM-62).
///
/// A space that already names a model keeps it, and a space the project already holds a model
/// for gets no second one: the model is named by the space, so reusing another project's types
/// is an `imports` entry of this model, never a second model (ADR-N-033). The model is a draft
/// with no classes, the shape DM-57 gives a model created by name; its first class is written
/// in the model editor.
fn space_model(
    state: &AppState,
    project: &str,
    envelope: &mut ResourceEnvelope,
) -> Vec<(String, String)> {
    let space = envelope.metadata.name.clone();
    let named = envelope
        .spec
        .get("dataModelRef")
        .is_some_and(|reference| !reference.is_null());
    let held = state
        .mirror
        .find(|model| {
            model.kind == "DataModel"
                && model.metadata.namespace.as_deref() == Some(project)
                && crate::api::assistant::ref_name(&model.spec["contextSpaceRef"]).as_deref()
                    == Some(space.as_str())
        })
        .is_some();
    if named || held {
        return Vec::new();
    }
    let Some(spec) = envelope.spec.as_object_mut() else {
        return Vec::new();
    };
    spec.insert(
        "dataModelRef".into(),
        serde_json::json!({ "kind": "DataModel", "name": space }),
    );
    let manifest = serde_json::json!({
        "apiVersion": resource::API_VERSION,
        "kind": "DataModel",
        "metadata": { "name": space, "namespace": project },
        "spec": {
            "contextSpaceRef": space,
            "linkml": format!("./{space}.linkml.yaml"),
            "version": "0.1.0",
            "lifecycle": "draft",
            "classes": [],
        }
    });
    let base = match state.config.org_domain.as_deref() {
        Some(domain) if !domain.is_empty() => format!("https://{domain}/models/{project}/{space}"),
        _ => format!("urn:joinedcontext:model:{project}:{space}"),
    };
    // A prefix is an NCName, which a DNS label that starts with a digit is not.
    let prefix = if project.starts_with(|c: char| c.is_ascii_alphabetic()) {
        project.to_owned()
    } else {
        "local".to_owned()
    };
    let source = format!(
        "id: {base}\n\
         name: {space}\n\
         description: The types of the {space} space, one class per entity type (DM-61).\n\
         prefixes:\n\
         \x20 linkml: https://w3id.org/linkml/\n\
         \x20 ngsi-ld: https://uri.etsi.org/ngsi-ld/\n\
         \x20 {prefix}: {base}/\n\
         default_prefix: {prefix}\n\
         default_range: string\n\
         imports:\n\
         \x20 - linkml:types\n\
         \x20 - ngsi-ld-core\n\
         classes: {{}}\n"
    );
    let manifest = serde_yaml_ng::to_string(&manifest).unwrap_or_default();
    vec![
        (format!("datamodels/{space}.yaml"), manifest),
        (format!("datamodels/{space}.linkml.yaml"), source),
    ]
}

/// What a proposal of one resource sends: the manifest, and beside it the draft the form holds
/// (AG-61) and the files the manifest names but cannot contain (DM-39). Both are taken out of the
/// body before it is read as an envelope; the type is what the OpenAPI document says, so the
/// generated client sends them without a cast (T-1488).
#[derive(Debug, serde::Deserialize, utoipa::ToSchema)]
pub struct ResourceProposal {
    #[serde(flatten)]
    pub manifest: ResourceEnvelope,
    /// The draft this proposal is made from; the proposal then takes the draft's own manifest.
    #[serde(default)]
    pub draft: Option<crate::ops::DraftRef>,
    /// Files beside the manifest, by path relative to its folder, each a text: at most 16 and
    /// 256 KiB together.
    #[serde(default)]
    pub files: Option<std::collections::BTreeMap<String, String>>,
}

/// The `draft` member a form sends beside its manifest (AG-61), taken out of the body.
fn take_draft(body: &mut Value) -> Option<Value> {
    body.as_object_mut().and_then(|map| map.remove("draft"))
}

/// A form proposing or checking the draft it holds: the registered operation of the kind
/// owns the check and the gate (PF-57), so this door reaches the same operation as MCP and
/// the ops route (ADR-N-021) instead of parsing the reference as a manifest. The body's
/// manifest is what a check verifies; a proposal takes the draft's own manifest.
#[allow(clippy::too_many_arguments)]
async fn propose_draft(
    user: CurrentUser,
    front: Front,
    state: &AppState,
    project: &str,
    plural: &str,
    dry_run: bool,
    draft: Value,
    manifest: Value,
) -> Result<Response, ApiError> {
    let name = match (plural, dry_run) {
        ("datasources", true) => "jc_datasource_check",
        (_, true) => "jc_manifest_dry_run",
        ("endpoints", false) => "jc_endpoint_propose",
        ("datasources", false) => "jc_datasource_propose",
        ("pipelines", false) => "jc_pipeline_propose",
        ("spaces", false) => "jc_space_propose",
        ("datamodels", false) => "jc_model_propose",
        // Every other kind proposes through the registry's one propose (AG-77, ADR-N-021): the
        // draft names its own kind, so a Dashboard, a Role or an App draft reaches the operation
        // MCP and the assistant reach, instead of a 400 in the form alone (T-0842).
        (_, false) => "jc_resource_propose",
    };
    let op = crate::ops::find(name)
        .ok_or_else(|| ApiError::Internal(format!("operation '{name}' is not registered")))?;
    let caller = crate::ops::Caller {
        identity: user.0.identity,
        via: match front {
            Front::Portal | Front::Edge => crate::ops::Via::Session,
            Front::Bearer => crate::ops::Via::Bearer,
        },
        access: None,
    };
    let input = if dry_run {
        serde_json::json!({ "draft": draft, "manifest": manifest })
    } else {
        serde_json::json!({ "draft": draft })
    };
    // The pages read the same Change envelope the plain door answers (ChangeNotice, its
    // review link); the operation wraps it as `change` beside `changeId` and `lane`.
    let result = crate::ops::call(op, &caller, state, project, input)
        .await
        .map(
            |mut output| match output.get_mut("change").map(Value::take) {
                Some(change) if change.is_object() => change,
                _ => output,
            },
        );
    crate::api::ops::respond(op, result)
}

#[utoipa::path(
    post,
    path = "/api/v1/projects/{project}/{plural}",
    summary = "Propose Resource",
    description = "Proposes creating or changing a resource of any kind from its manifest or a draft; the change waits for a person's approval.",
    tag = "resources",
    params(
        ("project" = String, Path, description = "Project name"),
        ("plural" = String, Path, description = "Resource kind plural"),
        ("dryRun" = Option<String>, Query, description = "Set to 'All' for dry run"),
        ("confirm" = Option<String>, Query, description = "The resource's name typed back: an administrator's own red-lane change is approved as it is proposed only with it (PF-58, CC-39)"),
    ),
    request_body(content = ResourceProposal, example = json!({
            "apiVersion": "joinedcontext.com/v1alpha1",
            "kind": "Endpoint",
            "metadata": { "name": "helsinki-air", "namespace": "helsinki", "title": "Air quality" },
            "spec": {
                "contextSpaceRef": "air",
                "slug": "mluyob4nz52lok3ssk7pgn5vwt",
                "audience": "organization",
                "enabledRepresentations": ["ngsi-ld", "geojson"]
            }
        })),
    responses(
        (status = 202, description = "Change proposal accepted", body = Change),
        (status = 200, description = "Dry run validation result", body = DryRunResult),
        (status = 400, description = "Bad request", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 404, description = "Not found", body = ProblemDetails),
        (status = 415, description = "Unsupported media type", body = ProblemDetails),
        (status = 503, description = "Git forge unavailable", body = ProblemDetails),
    )
)]
pub async fn create(
    user: CurrentUser,
    front: Front,
    State(state): State<AppState>,
    Path((project, plural)): Path<(String, String)>,
    Query(dry_run_q): Query<DryRunQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let is_dry = dry_run::is_dry_run(&dry_run_q)?;
    let mut body_val = parse_body_to_value(&headers, &body)?;
    if let Some(draft) = take_draft(&mut body_val) {
        if dry_run_q.workspace.is_some() {
            return Err(ApiError::BadRequest(
                "a draft is proposed on its own; send the manifest to write it into a workspace"
                    .into(),
            ));
        }
        return propose_draft(
            user, front, &state, &project, &plural, is_dry, draft, body_val,
        )
        .await;
    }
    propose_checked(
        &user,
        front,
        &state,
        &project,
        &plural,
        None,
        Operation::Create,
        is_dry,
        body_val,
        dry_run_q.workspace.as_deref(),
        dry_run_q.confirm.as_deref(),
    )
    .await
}

#[utoipa::path(
    put,
    path = "/api/v1/projects/{project}/{plural}/{name}",
    summary = "Propose Resource",
    description = "Proposes creating or changing a resource of any kind from its manifest or a draft; the change waits for a person's approval.",
    tag = "resources",
    params(
        ("project" = String, Path, description = "Project name"),
        ("plural" = String, Path, description = "Resource kind plural"),
        ("name" = String, Path, description = "Resource name"),
        ("dryRun" = Option<String>, Query, description = "Set to 'All' for dry run"),
        ("confirm" = Option<String>, Query, description = "The resource's name typed back: an administrator's own red-lane change is approved as it is proposed only with it (PF-58, CC-39)"),
    ),
    request_body(content = ResourceProposal, example = json!({
            "apiVersion": "joinedcontext.com/v1alpha1",
            "kind": "Endpoint",
            "metadata": { "name": "helsinki-air", "namespace": "helsinki", "title": "Air quality" },
            "spec": {
                "contextSpaceRef": "air",
                "slug": "mluyob4nz52lok3ssk7pgn5vwt",
                "audience": "organization",
                "enabledRepresentations": ["ngsi-ld", "geojson"]
            }
        })),
    responses(
        (status = 202, description = "Change proposal accepted", body = Change),
        (status = 200, description = "Dry run validation result", body = DryRunResult),
        (status = 400, description = "Bad request", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 404, description = "Not found", body = ProblemDetails),
        (status = 415, description = "Unsupported media type", body = ProblemDetails),
        (status = 503, description = "Git forge unavailable", body = ProblemDetails),
    )
)]
pub async fn replace(
    user: CurrentUser,
    front: Front,
    State(state): State<AppState>,
    Path((project, plural, name)): Path<(String, String, String)>,
    Query(dry_run_q): Query<DryRunQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let is_dry = dry_run::is_dry_run(&dry_run_q)?;
    let mut body_val = parse_body_to_value(&headers, &body)?;
    if let Some(draft) = take_draft(&mut body_val) {
        if dry_run_q.workspace.is_some() {
            return Err(ApiError::BadRequest(
                "a draft is proposed on its own; send the manifest to write it into a workspace"
                    .into(),
            ));
        }
        return propose_draft(
            user, front, &state, &project, &plural, is_dry, draft, body_val,
        )
        .await;
    }
    propose_checked(
        &user,
        front,
        &state,
        &project,
        &plural,
        Some(&name),
        Operation::Update,
        is_dry,
        body_val,
        dry_run_q.workspace.as_deref(),
        dry_run_q.confirm.as_deref(),
    )
    .await
}

#[utoipa::path(
    patch,
    path = "/api/v1/projects/{project}/{plural}/{name}",
    summary = "Propose Resource",
    description = "Proposes creating or changing a resource of any kind from its manifest or a draft; the change waits for a person's approval.",
    tag = "resources",
    params(
        ("project" = String, Path, description = "Project name"),
        ("plural" = String, Path, description = "Resource kind plural"),
        ("name" = String, Path, description = "Resource name"),
        ("dryRun" = Option<String>, Query, description = "Set to 'All' for dry run"),
        ("confirm" = Option<String>, Query, description = "The resource's name typed back: an administrator's own red-lane change is approved as it is proposed only with it (PF-58, CC-39)"),
    ),
    // Declared by hand: the handler takes the raw `Bytes` because the media type decides how the
    // body is parsed, and utoipa cannot derive a schema from that extractor.
    request_body(
        content = Object,
        description = "RFC 7386 merge patch, as JSON or as the YAML apply-patch document",
        content_type = "application/merge-patch+json",
        example = json!({ "spec": { "audience": "organization" } }),
    ),
    responses(
        (status = 202, description = "Change proposal accepted", body = Change),
        (status = 200, description = "Dry run validation result", body = DryRunResult),
        (status = 400, description = "Bad request", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 404, description = "Not found", body = ProblemDetails),
        (status = 415, description = "Unsupported media type", body = ProblemDetails),
        (status = 503, description = "Git forge unavailable", body = ProblemDetails),
    )
)]
pub async fn patch(
    user: CurrentUser,
    front: Front,
    State(state): State<AppState>,
    Path((project, plural, name)): Path<(String, String, String)>,
    Query(dry_run_q): Query<DryRunQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let is_dry = dry_run::is_dry_run(&dry_run_q)?;
    let patch_val = parse_patch_to_value(&headers, &body)?;

    if patch_val.get("status").is_some() {
        return Err(ApiError::BadRequest(
            "status is computed by the platform and cannot be specified in the manifest (MF-04)"
                .into(),
        ));
    }

    if let Some(secret_key) = find_literal_secret(&patch_val) {
        return Err(ApiError::BadRequest(format!(
            "literal secret in field '{secret_key}' is forbidden; use secretRef instead (MF-24)"
        )));
    }

    let kind_info = resource::by_plural(&plural).ok_or_else(|| {
        ApiError::NotFound(format!(
            "plural '{plural}' not found in project '{project}'"
        ))
    })?;

    let mirror = match dry_run_q.workspace.as_deref() {
        Some(workspace) => std::sync::Arc::new(
            crate::ops::workspaces::mirror_of(&state, &user.0.identity, workspace, &project)
                .await?,
        ),
        None => state.mirror.clone(),
    };
    let current = mirror.get(&project, kind_info.kind, &name).ok_or_else(|| {
        ApiError::NotFound(format!(
            "resource '{name}' not found in project '{project}'"
        ))
    })?;

    let mut curr_to_patch = current;
    curr_to_patch.strip_status();
    let mut desired_val = serde_json::to_value(&curr_to_patch).map_err(|e| {
        ApiError::Internal(format!("failed to serialize current resource to json: {e}"))
    })?;

    plan::merge_patch(&mut desired_val, &patch_val);

    propose_checked(
        &user,
        front,
        &state,
        &project,
        &plural,
        Some(&name),
        Operation::Update,
        is_dry,
        desired_val,
        dry_run_q.workspace.as_deref(),
        dry_run_q.confirm.as_deref(),
    )
    .await
}

/// A Pipeline sent in the first shape, rewritten as the second (PL-54, ADR-N-023):
/// `source` → `sources: [source]`, `compute` → `steps: [compute]`, `targetEndpoint` with its
/// `output` → `outputs: [{ targetEndpoint, type, mode }]`, and `apiVersion` v1alpha2. Anything
/// already in the second shape, mixed, or with no `source` (its input lives in `bento.yaml`,
/// which v1alpha2 has no place for) is left as it came, for validation to judge.
pub(crate) fn pipeline_second_shape(body: &mut Value) {
    if body.get("kind").and_then(Value::as_str) != Some("Pipeline") {
        return;
    }
    let Some(spec) = body.get_mut("spec").and_then(Value::as_object_mut) else {
        return;
    };
    let second = ["sources", "steps", "outputs"]
        .iter()
        .any(|key| spec.contains_key(*key));
    if second || !spec.contains_key("source") || !spec.contains_key("targetEndpoint") {
        return;
    }
    if let Some(source) = spec.remove("source") {
        spec.insert("sources".to_owned(), Value::Array(vec![source]));
    }
    if let Some(compute) = spec.remove("compute") {
        spec.insert("steps".to_owned(), Value::Array(vec![compute]));
    }
    let mut output = serde_json::Map::new();
    if let Some(target) = spec.remove("targetEndpoint") {
        output.insert("targetEndpoint".to_owned(), target);
    }
    if let Some(Value::Object(written)) = spec.remove("output") {
        output.extend(written);
    }
    spec.insert(
        "outputs".to_owned(),
        Value::Array(vec![Value::Object(output)]),
    );
    body["apiVersion"] = Value::String(jc_core::API_VERSION_V1ALPHA2.to_owned());
}

/// `sent` over `stored` (UI-50, T-2764): a plain string over a legacy language map goes into the
/// entry the map resolves to (`en`, else its first language) and the other languages stay. A map,
/// or a string over a string, is what the person wrote.
fn keep_languages(sent: &mut Option<jc_core::i18n::Text>, stored: Option<&jc_core::i18n::Text>) {
    use jc_core::i18n::Text;
    let (Some(Text::Plain(text)), Some(Text::Localized(map))) = (sent.as_ref(), stored) else {
        return;
    };
    let Some(locale) = map
        .get("en")
        .map(|_| "en".to_owned())
        .or_else(|| map.iter().next().map(|(locale, _)| locale.to_owned()))
    else {
        return;
    };
    let mut kept = map.clone();
    // The key came out of the map itself, so the insert cannot refuse it.
    if kept.insert(&locale, text.clone()).is_ok() {
        *sent = Some(Text::Localized(kept));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::session::{Identity, Session};
    use crate::change::Lane;
    use crate::config::Config;
    use crate::resource::ObjectMeta;
    use http_body_util::BodyExt;
    use serde_json::json;

    fn dummy_user() -> CurrentUser {
        CurrentUser(Session {
            identity: Identity {
                client: None,
                subject: "sub-123".into(),
                username: "demo.developer".into(),
                email: Some("demo@example.com".into()),
                name: Some("Demo Developer".into()),
                roles: vec![],
                groups: vec!["portal-approver".into()],
            },
            expires_at: 9_999_999_999,
            issued_at: 1000,
            id_token: "dummy-token".into(),
            access_expires_at: 9_999_999_999,
            refresh_token: None,
        })
    }

    #[test]
    fn detects_literal_secrets_and_permits_secret_refs() {
        assert_eq!(
            find_literal_secret(&json!({ "password": "supersecret" })),
            Some("password".into())
        );
        assert_eq!(
            find_literal_secret(&json!({ "spec": { "token": "ghp_123" } })),
            Some("token".into())
        );
        assert_eq!(
            find_literal_secret(&json!({ "spec": { "nested": { "clientSecret": "plain" } } })),
            Some("clientSecret".into())
        );
        assert_eq!(
            find_literal_secret(&json!({ "apiKey": "12345" })),
            Some("apiKey".into())
        );
        // T-2540, MF-24: a number or a boolean under a credential name is a literal too.
        assert_eq!(
            find_literal_secret(&json!({ "spec": { "password": 123456 } })),
            Some("password".into())
        );
        assert_eq!(
            find_literal_secret(&json!({ "spec": { "token": true } })),
            Some("token".into())
        );
        assert_eq!(
            find_literal_secret(&json!({ "spec": { "password": null } })),
            None
        );

        assert_eq!(
            find_literal_secret(&json!({
                "spec": {
                    "password": {
                        "secretRef": { "name": "db-secret", "key": "password" }
                    }
                }
            })),
            None
        );
        assert_eq!(
            find_literal_secret(&json!({
                "spec": {
                    "secretRef": { "name": "vault-key" }
                }
            })),
            None
        );
        assert_eq!(
            find_literal_secret(&json!({
                "metadata": { "name": "public-air" },
                "spec": { "audience": "public" }
            })),
            None
        );
    }

    #[tokio::test]
    async fn propose_dry_run_create_returns_dry_run_result() {
        let state = AppState::new(Config::for_tests(), None);
        let user = dummy_user();
        let payload = json!({
            "apiVersion": resource::API_VERSION,
            "kind": "ContextSpace",
            "metadata": {
                "name": "mobility",
                "namespace": "ovzdusie"
            },
            "spec": {
                "isSandbox": true
            }
        });

        let resp = propose(
            &user,
            &state,
            "ovzdusie",
            "spaces",
            None,
            Operation::Create,
            true,
            payload,
        )
        .await
        .expect("dry run create should succeed");

        assert_eq!(resp.status(), StatusCode::OK);
        let body_bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let result: DryRunResult = serde_json::from_slice(&body_bytes).unwrap();
        assert!(result.valid);
        assert_eq!(result.lane, Lane::Green);
        assert_eq!(result.plan.summary.create, 1);
        assert_eq!(result.plan.summary.update, 0);
    }

    #[tokio::test]
    async fn propose_validation_rejects_wrong_apiversion_or_kind() {
        let state = AppState::new(Config::for_tests(), None);
        let user = dummy_user();

        let bad_api = json!({
            "apiVersion": "v1",
            "kind": "ContextSpace",
            "metadata": { "name": "mobility" },
            "spec": {}
        });
        let err = propose(
            &user,
            &state,
            "ovzdusie",
            "spaces",
            None,
            Operation::Create,
            true,
            bad_api,
        )
        .await
        .unwrap_err();
        match err {
            ApiError::BadRequest(msg) => assert!(msg.contains("apiVersion")),
            other => panic!("expected BadRequest, got {other:?}"),
        }

        let bad_kind = json!({
            "apiVersion": resource::API_VERSION,
            "kind": "Endpoint",
            "metadata": { "name": "mobility" },
            "spec": {}
        });
        let err2 = propose(
            &user,
            &state,
            "ovzdusie",
            "spaces",
            None,
            Operation::Create,
            true,
            bad_kind,
        )
        .await
        .unwrap_err();
        match err2 {
            ApiError::BadRequest(msg) => assert!(msg.contains("kind 'Endpoint'")),
            other => panic!("expected BadRequest, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn propose_validation_rejects_foreign_namespace_and_fills_absent() {
        let state = AppState::new(Config::for_tests(), None);
        let user = dummy_user();

        let foreign_ns = json!({
            "apiVersion": resource::API_VERSION,
            "kind": "ContextSpace",
            "metadata": {
                "name": "mobility",
                "namespace": "foreign-project"
            },
            "spec": {}
        });
        let err = propose(
            &user,
            &state,
            "ovzdusie",
            "spaces",
            None,
            Operation::Create,
            true,
            foreign_ns,
        )
        .await
        .unwrap_err();
        match err {
            ApiError::BadRequest(msg) => assert!(msg.contains("foreign-project")),
            other => panic!("expected BadRequest, got {other:?}"),
        }

        let absent_ns = json!({
            "apiVersion": resource::API_VERSION,
            "kind": "ContextSpace",
            "metadata": {
                "name": "mobility"
            },
            "spec": {}
        });
        let resp = propose(
            &user,
            &state,
            "ovzdusie",
            "spaces",
            None,
            Operation::Create,
            true,
            absent_ns,
        )
        .await
        .expect("absent namespace should be filled in as project");
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn propose_validation_rejects_status_and_literal_secrets() {
        let state = AppState::new(Config::for_tests(), None);
        let user = dummy_user();

        let with_status = json!({
            "apiVersion": resource::API_VERSION,
            "kind": "ContextSpace",
            "metadata": { "name": "mobility" },
            "spec": {},
            "status": { "phase": "Live" }
        });
        let err = propose(
            &user,
            &state,
            "ovzdusie",
            "spaces",
            None,
            Operation::Create,
            true,
            with_status,
        )
        .await
        .unwrap_err();
        match err {
            ApiError::BadRequest(msg) => assert!(msg.contains("status")),
            other => panic!("expected BadRequest, got {other:?}"),
        }

        let with_secret = json!({
            "apiVersion": resource::API_VERSION,
            "kind": "ContextSpace",
            "metadata": { "name": "mobility" },
            "spec": {
                "auth": { "password": "supersecretpassword" }
            }
        });
        let err2 = propose(
            &user,
            &state,
            "ovzdusie",
            "spaces",
            None,
            Operation::Create,
            true,
            with_secret,
        )
        .await
        .unwrap_err();
        match err2 {
            ApiError::BadRequest(msg) => assert!(msg.contains("literal secret")),
            other => panic!("expected BadRequest, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn propose_rejects_name_mismatch_on_replace() {
        let state = AppState::new(Config::for_tests(), None);
        let user = dummy_user();

        let payload = json!({
            "apiVersion": resource::API_VERSION,
            "kind": "ContextSpace",
            "metadata": { "name": "mobility-b" },
            "spec": {}
        });
        let err = propose(
            &user,
            &state,
            "ovzdusie",
            "spaces",
            Some("mobility-a"),
            Operation::Update,
            true,
            payload,
        )
        .await
        .unwrap_err();
        match err {
            ApiError::BadRequest(msg) => assert!(msg.contains("mobility-b")),
            other => panic!("expected BadRequest, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn propose_non_dry_run_without_gitea_answers_503() {
        let state = AppState::new(Config::for_tests(), None);
        let user = dummy_user();
        let payload = json!({
            "apiVersion": resource::API_VERSION,
            "kind": "ContextSpace",
            "metadata": { "name": "mobility" },
            "spec": {}
        });

        let err = propose(
            &user,
            &state,
            "ovzdusie",
            "spaces",
            None,
            Operation::Create,
            false,
            payload,
        )
        .await
        .unwrap_err();

        match err {
            ApiError::Unavailable(msg) => assert!(msg.contains("git forge")),
            other => panic!("expected Unavailable, got {other:?}"),
        }
    }

    #[test]
    fn parse_patch_content_types() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            "application/json".parse().expect("header"),
        );
        let err = parse_patch_to_value(&headers, b"{}").unwrap_err();
        match err {
            ApiError::UnsupportedMediaType(msg) => {
                assert!(msg.contains("application/merge-patch+json"))
            }
            other => panic!("expected UnsupportedMediaType, got {other:?}"),
        }

        let mut headers_valid = HeaderMap::new();
        headers_valid.insert(
            header::CONTENT_TYPE,
            "application/merge-patch+json".parse().expect("header"),
        );
        let val = parse_patch_to_value(&headers_valid, b"{\"spec\":{\"audience\":\"public\"}}")
            .expect("parse valid json patch");
        assert_eq!(val["spec"]["audience"], "public");

        let mut headers_yaml = HeaderMap::new();
        headers_yaml.insert(
            header::CONTENT_TYPE,
            "application/apply-patch+yaml".parse().expect("header"),
        );
        let val_yaml = parse_patch_to_value(&headers_yaml, b"spec:\n  audience: public\n")
            .expect("parse valid yaml patch");
        assert_eq!(val_yaml["spec"]["audience"], "public");
    }

    #[test]
    fn a_space_scoped_resource_is_filed_under_the_space_it_references() {
        let endpoint = |spec: serde_json::Value| ResourceEnvelope {
            api_version: resource::API_VERSION.into(),
            kind: "Endpoint".into(),
            metadata: ObjectMeta {
                name: "citybikes-2046-all".into(),
                namespace: Some("helsinki".into()),
                ..Default::default()
            },
            spec,
            status: None,
        };
        let info = resource::by_kind("Endpoint").expect("Endpoint");
        for reference in [
            json!("citybikes-2046"),
            json!({ "kind": "ContextSpace", "name": "citybikes-2046" }),
        ] {
            assert_eq!(
                resolve_repo_path(
                    &endpoint(json!({ "contextSpaceRef": reference })),
                    info,
                    "helsinki"
                )
                .expect("a path"),
                "projects/helsinki/spaces/citybikes-2046/endpoints/citybikes-2046-all.yaml"
            );
        }
        assert_eq!(
            resolve_repo_path(&endpoint(json!({})), info, "helsinki").expect("a path"),
            "projects/helsinki/spaces/helsinki/endpoints/citybikes-2046-all.yaml"
        );
    }

    #[tokio::test]
    async fn patch_merges_with_current_and_plans_diff() {
        let state = AppState::new(Config::for_tests(), None);
        state.mirror.upsert(ResourceEnvelope {
            api_version: resource::API_VERSION.into(),
            kind: "ContextSpace".into(),
            metadata: ObjectMeta {
                name: "mobility".into(),
                namespace: Some("ovzdusie".into()),
                ..Default::default()
            },
            spec: json!({ "isSandbox": false }),
            status: None,
        });

        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            "application/merge-patch+json".parse().expect("header"),
        );
        let patch_body = Bytes::from(r#"{"spec":{"isSandbox":true}}"#);

        let user = dummy_user();
        let resp = patch(
            user,
            Front::Portal,
            State(state),
            Path(("ovzdusie".into(), "spaces".into(), "mobility".into())),
            Query(DryRunQuery {
                workspace: None,
                dry_run: Some("All".into()),
                confirm: None,
            }),
            headers,
            patch_body,
        )
        .await
        .expect("patch dry run should succeed");

        assert_eq!(resp.status(), StatusCode::OK);
        let body_bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let result: DryRunResult = serde_json::from_slice(&body_bytes).unwrap();
        assert!(result.valid);
        assert_eq!(result.lane, Lane::Green);
        assert_eq!(result.plan.summary.update, 1);
        assert_eq!(result.plan.fields.len(), 1);
        assert_eq!(result.plan.fields[0].path, "spec.isSandbox");
        assert_eq!(result.plan.fields[0].from, Some(json!(false)));
        assert_eq!(result.plan.fields[0].to, Some(json!(true)));
    }
}

#[cfg(test)]
mod second_shape_tests {
    use super::pipeline_second_shape;
    use serde_json::json;

    fn first() -> serde_json::Value {
        json!({
            "apiVersion": "joinedcontext.com/v1alpha1",
            "kind": "Pipeline",
            "metadata": { "name": "p", "namespace": "helsinki" },
            "spec": {
                "class": "resident",
                "source": { "dataSourceRef": { "kind": "DataSource", "name": "gbfs" } },
                "compute": { "kind": "bloblang", "bloblang": "root = this" },
                "targetEndpoint": "urn:ngsi-ld:Endpoint:hel.fi:helsinki:ops",
                "output": { "type": "BikeHireDockingStation", "mode": "upsert" },
                "secretRefs": [{ "name": "s", "key": "k", "envVar": "V" }]
            }
        })
    }

    #[test]
    fn a_first_shape_pipeline_is_written_as_the_second() {
        let mut body = first();
        pipeline_second_shape(&mut body);
        assert_eq!(body["apiVersion"], "joinedcontext.com/v1alpha2");
        let spec = &body["spec"];
        assert_eq!(spec["sources"][0]["dataSourceRef"]["name"], "gbfs");
        assert_eq!(spec["steps"][0]["bloblang"], "root = this");
        assert_eq!(
            spec["outputs"][0]["targetEndpoint"],
            "urn:ngsi-ld:Endpoint:hel.fi:helsinki:ops"
        );
        assert_eq!(spec["outputs"][0]["type"], "BikeHireDockingStation");
        assert_eq!(spec["outputs"][0]["mode"], "upsert");
        for gone in ["source", "compute", "targetEndpoint", "output"] {
            assert!(spec.get(gone).is_none(), "{gone} is left behind");
        }
        assert_eq!(
            spec["secretRefs"][0]["envVar"], "V",
            "what is not moved stays"
        );
        // The result is a Pipeline jc-core accepts at v1alpha2.
        let text = serde_json::to_string(&body).expect("json");
        jc_core::registry::validate_yaml("Pipeline", &text)
            .expect("a catalogued kind")
            .expect("valid at v1alpha2");
    }

    #[test]
    fn a_pipeline_without_compute_or_output_gets_no_steps_and_a_bare_output() {
        let mut body = first();
        let spec = body["spec"].as_object_mut().expect("spec");
        spec.remove("compute");
        spec.remove("output");
        pipeline_second_shape(&mut body);
        assert!(body["spec"].get("steps").is_none());
        assert_eq!(
            body["spec"]["outputs"],
            json!([{ "targetEndpoint": "urn:ngsi-ld:Endpoint:hel.fi:helsinki:ops" }])
        );
    }

    #[test]
    fn what_is_not_a_first_shape_pipeline_is_left_as_it_came() {
        // Its input lives in bento.yaml: v1alpha2 has no place for it.
        let mut no_source = first();
        no_source["spec"]
            .as_object_mut()
            .expect("spec")
            .remove("source");
        let before = no_source.clone();
        pipeline_second_shape(&mut no_source);
        assert_eq!(no_source, before);

        // Already the second shape, or mixed: validation judges it, not a rewrite.
        let mut mixed = first();
        mixed["spec"]["outputs"] = json!([]);
        let before = mixed.clone();
        pipeline_second_shape(&mut mixed);
        assert_eq!(mixed, before);

        let mut other = json!({ "kind": "Endpoint", "apiVersion": "joinedcontext.com/v1alpha1", "spec": { "source": 1, "targetEndpoint": 2 } });
        let before = other.clone();
        pipeline_second_shape(&mut other);
        assert_eq!(other, before);

        let mut no_spec = json!({ "kind": "Pipeline" });
        pipeline_second_shape(&mut no_spec);
        assert_eq!(no_spec, json!({ "kind": "Pipeline" }));
    }

    #[test]
    fn the_targets_of_either_shape_are_read() {
        let first = first();
        assert_eq!(
            crate::resource::pipeline_targets(&first["spec"]),
            vec!["urn:ngsi-ld:Endpoint:hel.fi:helsinki:ops"]
        );
        let second = json!({ "outputs": [
            { "targetEndpoint": "urn:ngsi-ld:Endpoint:hel.fi:helsinki:a" },
            { "mode": "upsert" },
            { "targetEndpoint": "urn:ngsi-ld:Endpoint:hel.fi:helsinki:b" }
        ] });
        assert_eq!(crate::resource::pipeline_targets(&second).len(), 2);
        assert!(crate::resource::pipeline_targets(&json!({})).is_empty());
    }
}
