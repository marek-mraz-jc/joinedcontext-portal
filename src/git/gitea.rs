//! Gitea REST API client (CC-03, CC-32, CC-34, CC-41, CC-42, CC-44).
//!
//! Mutations in joinedcontext commit to Git merge requests server-side. Commits are attributed
//! to the signed-in human author, while the service token only authenticates the HTTP call.

use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::error::ApiError;

/// Gitea repository client.
#[derive(Clone)]
pub struct GiteaClient {
    pub base: Url,
    /// Where a browser reaches the same forge: the API talks to the cluster-internal service,
    /// but a "Source" link opens in the user's browser, which resolves no `.svc.cluster.local`
    /// name. `JC_GITEA_PUBLIC_URL`; the API base when unset.
    pub public_base: Url,
    pub owner: String,
    pub repo: String,
    token: String,
    pub http: reqwest::Client,
}

impl std::fmt::Debug for GiteaClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GiteaClient")
            .field("base", &self.base.as_str())
            .field("owner", &self.owner)
            .field("repo", &self.repo)
            .field("token", &"[redacted]")
            .finish()
    }
}

/// Errors returned by the Gitea client.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum GitError {
    #[error("git config error: {0}")]
    Config(String),
    #[error("git transport error: {0}")]
    Transport(String),
    #[error("git resource not found")]
    NotFound,
    #[error("git conflict: {0}")]
    Conflict(String),
    #[error("git api error {status}: {message}")]
    Api { status: u16, message: String },
}

impl From<GitError> for ApiError {
    fn from(err: GitError) -> Self {
        match err {
            GitError::NotFound => {
                ApiError::NotFound("resource not found in git repository".to_string())
            }
            GitError::Conflict(msg) => ApiError::Conflict(msg),
            other => {
                tracing::error!(error = %other, "git error");
                ApiError::Internal("git operation failed".to_string())
            }
        }
    }
}

/// A workflow run of an application's repository, as the App page links it (AP-86, AP-103).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRun {
    /// `queued`, `in_progress`, `waiting` or `completed`, as the forge says it.
    pub status: String,
    /// `success`, `failure`, `cancelled`… once the run is completed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conclusion: Option<String>,
    /// The commit the run built.
    pub commit: String,
    /// The run's page, behind the forge's sign-in (PF-81).
    pub url: String,
}

#[derive(Deserialize)]
struct WorkflowRunsResponse {
    #[serde(default)]
    workflow_runs: Vec<WorkflowRunResponse>,
}

#[derive(Deserialize)]
struct WorkflowRunResponse {
    #[serde(default)]
    status: String,
    #[serde(default)]
    conclusion: Option<String>,
    #[serde(default)]
    head_sha: String,
    #[serde(default)]
    run_number: Option<u64>,
}

/// An Actions artifact of a repository and the commit its run built (AP-104).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Artifact {
    pub id: u64,
    pub size: u64,
    /// The workflow run that uploaded it.
    pub run: u64,
    pub commit: String,
}

#[derive(Deserialize)]
struct ArtifactsResponse {
    #[serde(default)]
    artifacts: Vec<ArtifactResponse>,
}

#[derive(Deserialize)]
struct ArtifactResponse {
    id: u64,
    name: String,
    #[serde(default)]
    size_in_bytes: u64,
    workflow_run: ArtifactRunResponse,
}

#[derive(Deserialize)]
struct ArtifactRunResponse {
    id: u64,
    #[serde(default)]
    head_sha: String,
}

/// A body read to its end, refused once it passes `limit` bytes rather than held in memory.
async fn read_capped(
    mut res: reqwest::Response,
    limit: u64,
    what: &str,
) -> Result<Vec<u8>, GitError> {
    let mut bytes = Vec::new();
    while let Some(chunk) = res
        .chunk()
        .await
        .map_err(|e| GitError::Transport(e.to_string()))?
    {
        if (bytes.len() + chunk.len()) as u64 > limit {
            return Err(GitError::Transport(format!(
                "{what} is larger than {limit} bytes"
            )));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// Human author attributed on commits (CC-44).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Author<'a> {
    pub name: &'a str,
    pub email: &'a str,
}

/// File content read from repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoFile {
    pub sha: String,
    pub content: String,
}

/// One file a pull request changes; `deleted` when it is gone from the head branch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangedFile {
    pub path: String,
    pub deleted: bool,
    /// Whether the merge request adds the file, as the forge's own diff status says: the
    /// difference between creating a resource and changing one, without a second read of the
    /// base branch (T-0861).
    pub added: bool,
}

#[derive(Deserialize)]
struct ChangedFileDto {
    filename: String,
    #[serde(default)]
    status: String,
}

/// File write specification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileWrite<'a> {
    pub path: &'a str,
    pub branch: &'a str,
    pub message: &'a str,
    pub content: &'a str,
    pub sha: Option<&'a str>,
    pub author: Author<'a>,
}

/// File deletion specification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileDelete<'a> {
    pub path: &'a str,
    pub branch: &'a str,
    pub message: &'a str,
    pub sha: &'a str,
    pub author: Author<'a>,
}

/// Pull request representation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequest {
    pub number: u64,
    pub url: String,
    pub state: String,
    pub title: String,
    pub body: String,
    pub head_branch: String,
    /// The commit the head branch pointed at when the forge answered, when it said (Gitea
    /// always does). A review reads every file at this ref and the merge is pinned to it, so a
    /// push between the two is refused instead of merged unread (PF-57, T-1683).
    pub head_sha: String,
    pub base_branch: String,
    pub created_at: String,
    pub author_name: String,
    pub author_email: Option<String>,
    pub mergeable: Option<bool>,
    pub merged: bool,
}

impl PullRequest {
    /// The ref a review reads every file at: the commit the forge reported, or the branch when
    /// it reported none. Reading the branch and merging the branch is two reads of a moving
    /// target; reading this and merging with `head_commit_id` is one (PF-57, T-1683).
    pub fn head_ref(&self) -> &str {
        if self.head_sha.is_empty() {
            &self.head_branch
        } else {
            &self.head_sha
        }
    }
}

/// One commit of the repository, as the revision picker shows it (MF-16, CC-49).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Commit {
    pub sha: String,
    /// First line of the commit message: the picker renders history as plain sentences.
    pub message: String,
    pub author: String,
    pub email: Option<String>,
    pub date: String,
}

/// Pull request review action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ReviewEvent {
    #[serde(rename = "APPROVED")]
    Approve,
    #[serde(rename = "REQUEST_CHANGES")]
    RequestChanges,
    #[serde(rename = "COMMENT")]
    Comment,
}

/// Pull request merge style.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MergeStyle {
    Merge,
    Squash,
    Rebase,
}

// Request and response DTOs for Gitea REST API
#[derive(Deserialize)]
struct RepoDetailsResponse {
    default_branch: String,
}

#[derive(Deserialize)]
struct BranchDetailsResponse {
    commit: CommitIdDto,
}

#[derive(Deserialize)]
struct CommitIdDto {
    id: String,
}

#[derive(Serialize)]
struct CreateBranchPayload<'a> {
    new_branch_name: &'a str,
    old_branch_name: &'a str,
}

#[derive(Deserialize)]
struct ContentsDto {
    sha: String,
    #[serde(default)]
    content: String,
}

#[derive(Serialize)]
struct PutFilePayload<'a> {
    content: String,
    message: &'a str,
    branch: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    sha: Option<&'a str>,
    author: Author<'a>,
    committer: Author<'a>,
}

#[derive(Serialize)]
struct ChangeFilesPayload<'a> {
    files: Vec<ChangeFileDto>,
    message: &'a str,
    branch: &'a str,
    author: Author<'a>,
    committer: Author<'a>,
}

#[derive(Serialize)]
struct ChangeFileDto {
    operation: &'static str,
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sha: Option<String>,
}

#[derive(Serialize)]
struct DeleteFilePayload<'a> {
    message: &'a str,
    branch: &'a str,
    sha: &'a str,
    author: Author<'a>,
    committer: Author<'a>,
}

#[derive(Deserialize)]
struct FileCommitResponse {
    #[serde(default)]
    commit: Option<FileCommitShaDto>,
    #[serde(default)]
    sha: Option<String>,
}

#[derive(Deserialize)]
struct FileCommitShaDto {
    sha: String,
}

#[derive(Deserialize)]
struct CommitDto {
    sha: String,
    #[serde(default)]
    commit: Option<CommitDetailsDto>,
}

#[derive(Deserialize)]
struct CommitDetailsDto {
    #[serde(default)]
    message: String,
    #[serde(default)]
    author: Option<CommitAuthorDto>,
}

#[derive(Deserialize)]
struct CommitAuthorDto {
    #[serde(default)]
    name: String,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    date: String,
}

#[derive(Serialize)]
struct CreatePullRequestPayload<'a> {
    head: &'a str,
    base: &'a str,
    title: &'a str,
    body: &'a str,
}

#[derive(Deserialize)]
struct GiteaPullResponse {
    number: u64,
    html_url: String,
    state: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    head: Option<BranchRefDto>,
    #[serde(default)]
    base: Option<BranchRefDto>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    user: Option<GiteaUserDto>,
    #[serde(default)]
    mergeable: Option<bool>,
    #[serde(default)]
    merged: bool,
}

#[derive(Deserialize)]
struct BranchRefDto {
    #[serde(rename = "ref", default)]
    git_ref: String,
    #[serde(default)]
    sha: String,
}

#[derive(Deserialize)]
struct GiteaUserDto {
    #[serde(default)]
    login: Option<String>,
    #[serde(default)]
    full_name: Option<String>,
    #[serde(default)]
    email: Option<String>,
}

impl From<GiteaPullResponse> for PullRequest {
    fn from(raw: GiteaPullResponse) -> Self {
        let author_name = raw
            .user
            .as_ref()
            .and_then(|u| {
                u.full_name
                    .as_deref()
                    .filter(|s| !s.trim().is_empty())
                    .or(u.login.as_deref())
            })
            .unwrap_or_default()
            .to_string();
        let author_email = raw.user.and_then(|u| u.email);
        let (head_branch, head_sha) = raw.head.map(|h| (h.git_ref, h.sha)).unwrap_or_default();
        let base_branch = raw.base.map(|b| b.git_ref).unwrap_or_default();

        PullRequest {
            number: raw.number,
            url: raw.html_url,
            state: raw.state,
            title: raw.title,
            body: raw.body.unwrap_or_default(),
            head_branch,
            head_sha,
            base_branch,
            created_at: raw.created_at.unwrap_or_default(),
            author_name,
            author_email,
            mergeable: raw.mergeable,
            merged: raw.merged,
        }
    }
}

/// One push mirror of a repository, as `GET push_mirrors` lists it.
#[derive(Debug, Clone, Deserialize)]
pub struct PushMirror {
    pub remote_name: String,
    pub remote_address: String,
    /// What the last sync failed with; empty when it succeeded or has not run yet.
    #[serde(default)]
    pub last_error: String,
}

#[derive(Serialize)]
struct ReviewPayload<'a> {
    event: ReviewEvent,
    body: &'a str,
}

#[derive(Serialize)]
struct MergePayload<'a> {
    #[serde(rename = "Do")]
    do_field: MergeStyle,
    merge_message_field: &'a str,
    /// The commit the caller reviewed. Gitea refuses the merge when the branch has moved past
    /// it, which is the only race-free way to merge what was approved (T-1683).
    #[serde(skip_serializing_if = "Option::is_none")]
    head_commit_id: Option<&'a str>,
}

#[derive(Deserialize)]
struct GitTreeResponse {
    #[serde(default)]
    tree: Vec<GitTreeEntryDto>,
    #[serde(default)]
    truncated: bool,
}

#[derive(Deserialize)]
struct GitTreeEntryDto {
    path: String,
    #[serde(rename = "type")]
    entry_type: String,
    #[serde(default)]
    sha: String,
}

impl GiteaClient {
    pub fn new(
        base: Url,
        owner: impl Into<String>,
        repo: impl Into<String>,
        token: impl Into<String>,
    ) -> Result<Self, GitError> {
        let http = reqwest::ClientBuilder::new()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|e| GitError::Transport(e.to_string()))?;

        Ok(Self {
            public_base: base.clone(),
            base,
            owner: owner.into(),
            repo: repo.into(),
            token: token.into(),
            http,
        })
    }

    /// Reads the forge's configuration from the environment.
    ///
    /// `JC_GITEA_URL` (the API base the Portal dials), `JC_GITEA_OWNER`, `JC_GITEA_REPO` and
    /// `JC_GITEA_TOKEN` (a secret: the token every push and merge request is written with).
    /// `JC_GITEA_PUBLIC_URL` is the address a browser follows a "Source" link to, which differs
    /// from the API base whenever the forge is reached through the edge; the API base when it
    /// is unset.
    ///
    /// Fail-closed: returns `Ok(None)` if all four are absent, or an error if partially set.
    pub fn from_env(lookup: impl Fn(&str) -> Option<String>) -> Result<Option<Self>, GitError> {
        match (
            lookup("JC_GITEA_URL"),
            lookup("JC_GITEA_OWNER"),
            lookup("JC_GITEA_REPO"),
            lookup("JC_GITEA_TOKEN"),
        ) {
            (None, None, None, None) => Ok(None),
            (Some(url), Some(owner), Some(repo), Some(token)) => {
                let base = Url::parse(&url)
                    .map_err(|e| GitError::Config(format!("invalid JC_GITEA_URL: {e}")))?;
                let mut client = Self::new(base, owner, repo, token)?;
                if let Some(public) = lookup("JC_GITEA_PUBLIC_URL") {
                    client.public_base = Url::parse(&public)
                        .map_err(|e| GitError::Config(format!("invalid JC_GITEA_PUBLIC_URL: {e}")))?;
                }
                Ok(Some(client))
            }
            _ => Err(GitError::Config(
                "JC_GITEA_URL, JC_GITEA_OWNER, JC_GITEA_REPO and JC_GITEA_TOKEN must be set together"
                    .to_string(),
            )),
        }
    }

    /// Browser URL of one file at a git ref, the page a "Source" link opens (never the API URL).
    pub fn browse_url(&self, path: &str, git_ref: &str) -> String {
        self.signed_in(&format!(
            "{}/{}/{}/src/branch/{}/{}",
            self.public_base.as_str().trim_end_matches('/'),
            self.owner,
            self.repo,
            git_ref,
            path.trim_start_matches('/'),
        ))
    }

    /// Browser URL of a pull request. Gitea's own `html_url` carries its ROOT_URL, which on a
    /// cluster is the internal service name no browser resolves.
    pub fn pull_url(&self, number: u64) -> String {
        self.signed_in(&format!(
            "{}/{}/{}/pulls/{number}",
            self.public_base.as_str().trim_end_matches('/'),
            self.owner,
            self.repo,
        ))
    }

    /// A forge page behind the forge's own sign-in (PF-81). A Portal session is not a forge
    /// session, and the configuration repository is private, so a link straight to the file
    /// answers 404 instead of offering the Keycloak button. `redirect_to` carries the path
    /// back; Gitea returns only to a local one, which is why the host is dropped here.
    fn signed_in(&self, url: &str) -> String {
        let Ok(target) = Url::parse(url) else {
            return url.to_owned();
        };
        let mut login = self.public_base.clone();
        // `join` resolves against the last path segment, so a base without the trailing slash
        // would put /user/login beside the prefix instead of inside it.
        if !login.path().ends_with('/') {
            login.set_path(&format!("{}/", login.path()));
        }
        let Ok(mut login) = login.join("user/login") else {
            return url.to_owned();
        };
        login
            .query_pairs_mut()
            .append_pair("redirect_to", target.path());
        login.into()
    }

    /// A pull request as the Portal hands it on: with a public forge configured, its link is
    /// the public one; without, Gitea's own `html_url` is the best there is.
    fn pull(&self, raw: GiteaPullResponse) -> PullRequest {
        let mut pull = PullRequest::from(raw);
        if self.public_base != self.base {
            pull.url = self.pull_url(pull.number);
        }
        pull
    }

    fn repo_url(&self, path: &str) -> Result<Url, GitError> {
        let clean_base = self.base.as_str().trim_end_matches('/');
        let path = path.trim_start_matches('/');
        let full = if path.is_empty() {
            format!("{clean_base}/api/v1/repos/{}/{}", self.owner, self.repo)
        } else {
            format!(
                "{clean_base}/api/v1/repos/{}/{}/{path}",
                self.owner, self.repo
            )
        };
        Url::parse(&full).map_err(|e| GitError::Config(format!("invalid url '{full}': {e}")))
    }

    async fn send(&self, builder: reqwest::RequestBuilder) -> Result<reqwest::Response, GitError> {
        builder
            .header(
                reqwest::header::AUTHORIZATION,
                format!("token {}", self.token),
            )
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .await
            .map_err(|e| GitError::Transport(e.to_string()))
    }

    async fn check_status(res: reqwest::Response) -> Result<reqwest::Response, GitError> {
        let status = res.status();
        if status.is_success() {
            Ok(res)
        } else if status == reqwest::StatusCode::NOT_FOUND {
            Err(GitError::NotFound)
        } else if status == reqwest::StatusCode::CONFLICT {
            let message = res.text().await.unwrap_or_default();
            Err(GitError::Conflict(message))
        } else {
            let status_code = status.as_u16();
            let message = res.text().await.unwrap_or_default();
            Err(GitError::Api {
                status: status_code,
                message,
            })
        }
    }

    /// The same forge, organization and token, another repository of the organization: an
    /// application's own repository beside the configuration one (AP-75).
    pub fn for_repository(&self, repo: impl Into<String>) -> Self {
        Self {
            repo: repo.into(),
            ..self.clone()
        }
    }

    /// The `https` address a person clones the repository from: the forge's public URL, never
    /// the cluster-internal one (AP-77, AP-78).
    pub fn clone_url(&self) -> String {
        format!(
            "{}/{}/{}.git",
            self.public_base.as_str().trim_end_matches('/'),
            self.owner,
            self.repo
        )
    }

    /// Creates the repository in the organization unless it is already there, private and
    /// initialised on `main` so a branch can be cut from it; answers whether it created one.
    ///
    /// An existing repository is never recreated or overwritten, and a creation that lost a race
    /// with another (the forge's 409) is the same answer as finding it (AP-75).
    pub async fn ensure_repository(&self, description: &str) -> Result<bool, GitError> {
        let res = self.send(self.http.get(self.repo_url("")?)).await?;
        match Self::check_status(res).await {
            Ok(_) => return Ok(false),
            Err(GitError::NotFound) => {}
            Err(err) => return Err(err),
        }
        let full = format!(
            "{}/api/v1/orgs/{}/repos",
            self.base.as_str().trim_end_matches('/'),
            self.owner
        );
        let url = Url::parse(&full)
            .map_err(|e| GitError::Config(format!("invalid url '{full}': {e}")))?;
        let payload = serde_json::json!({
            "name": self.repo,
            "description": description,
            "private": true,
            "auto_init": true,
            "default_branch": "main",
        });
        let res = self.send(self.http.post(url).json(&payload)).await?;
        match Self::check_status(res).await {
            Ok(_) => Ok(true),
            Err(GitError::Conflict(_)) => Ok(false),
            Err(err) => Err(err),
        }
    }

    /// The push mirrors of the repository: where each one pushes, and what its last sync said
    /// (AP-79). Answers only for a caller that administers the repository.
    pub async fn push_mirrors(&self) -> Result<Vec<PushMirror>, GitError> {
        let res = self
            .send(self.http.get(self.repo_url("push_mirrors")?))
            .await?;
        let res = Self::check_status(res).await?;
        res.json()
            .await
            .map_err(|e| GitError::Transport(format!("failed to parse push mirrors: {e}")))
    }

    /// Adds a push mirror that syncs on every commit, with a periodic sync behind it for a
    /// commit whose sync failed (AP-79).
    ///
    /// The credential travels in its own members and never inside `remote_address`: the forge
    /// shows the address on the repository's settings page and in `push_mirrors`, and stores the
    /// credential encrypted.
    pub async fn add_push_mirror(
        &self,
        remote_address: &str,
        username: &str,
        password: &str,
    ) -> Result<(), GitError> {
        let payload = serde_json::json!({
            "remote_address": remote_address,
            "remote_username": username,
            "remote_password": password,
            "interval": "8h0m0s",
            "sync_on_commit": true,
        });
        let url = self.repo_url("push_mirrors")?;
        let res = self.send(self.http.post(url).json(&payload)).await?;
        Self::check_status(res).await?;
        Ok(())
    }

    /// Removes one push mirror by the name the forge gave it.
    pub async fn delete_push_mirror(&self, remote_name: &str) -> Result<(), GitError> {
        let url = self.repo_url(&format!("push_mirrors/{remote_name}"))?;
        let res = self.send(self.http.delete(url)).await?;
        Self::check_status(res).await?;
        Ok(())
    }

    /// Pushes every mirror of the repository now instead of at its next commit or interval.
    pub async fn sync_push_mirrors(&self) -> Result<(), GitError> {
        let url = self.repo_url("push_mirrors-sync")?;
        let res = self.send(self.http.post(url)).await?;
        Self::check_status(res).await?;
        Ok(())
    }

    /// `GET ""` — returns the repository's default branch.
    pub async fn default_branch(&self) -> Result<String, GitError> {
        let url = self.repo_url("")?;
        let res = self.send(self.http.get(url)).await?;
        let res = Self::check_status(res).await?;
        let repo: RepoDetailsResponse = res.json().await.map_err(|e| {
            GitError::Transport(format!("failed to parse repository response: {e}"))
        })?;
        Ok(repo.default_branch)
    }

    /// The repository's page, behind the forge's sign-in (AP-103, PF-81).
    pub fn repository_page_url(&self) -> String {
        self.signed_in(&format!(
            "{}/{}/{}",
            self.public_base.as_str().trim_end_matches('/'),
            self.owner,
            self.repo
        ))
    }

    /// The page of one version of a generic package of the organization (AP-101, AP-103).
    pub fn package_page_url(&self, package: &str, version: &str) -> String {
        self.signed_in(&format!(
            "{}/{}/-/packages/generic/{package}/{version}",
            self.public_base.as_str().trim_end_matches('/'),
            self.owner,
        ))
    }

    /// `GET /actions/runs?limit=1` — the newest workflow run of the repository, `None` before
    /// the first one. The link is built from the public URL, never Gitea's own `html_url`,
    /// which carries the cluster-internal ROOT_URL (PF-81).
    pub async fn latest_run(&self) -> Result<Option<WorkflowRun>, GitError> {
        let mut url = self.repo_url("actions/runs")?;
        url.query_pairs_mut().append_pair("limit", "1");
        let res = self.send(self.http.get(url)).await?;
        let res = Self::check_status(res).await?;
        let runs: WorkflowRunsResponse = res
            .json()
            .await
            .map_err(|e| GitError::Transport(format!("failed to parse the workflow runs: {e}")))?;
        Ok(runs.workflow_runs.into_iter().next().map(|run| {
            let page = format!(
                "{}/{}/{}/actions",
                self.public_base.as_str().trim_end_matches('/'),
                self.owner,
                self.repo
            );
            WorkflowRun {
                url: self.signed_in(&match run.run_number {
                    Some(number) => format!("{page}/runs/{number}"),
                    None => page,
                }),
                status: run.status,
                conclusion: run.conclusion.filter(|c| !c.is_empty()),
                commit: run.head_sha,
            }
        }))
    }

    /// `POST /actions/workflows/{file}/dispatches` — runs the workflow `file` on `git_ref`
    /// (AP-103). A refusal keeps the forge's own words, which is what a person acts on.
    pub async fn dispatch_workflow(&self, file: &str, git_ref: &str) -> Result<(), GitError> {
        let url = self.repo_url(&format!("actions/workflows/{file}/dispatches"))?;
        let res = self
            .send(
                self.http
                    .post(url)
                    .json(&serde_json::json!({ "ref": git_ref })),
            )
            .await?;
        Self::check_status(res).await?;
        Ok(())
    }

    /// `GET /actions/artifacts?name={name}` — the repository's artifacts of that exact name, each
    /// with the commit its run built (AP-104).
    pub async fn artifacts_named(&self, name: &str) -> Result<Vec<Artifact>, GitError> {
        let mut url = self.repo_url("actions/artifacts")?;
        url.query_pairs_mut().append_pair("name", name);
        let res = Self::check_status(self.send(self.http.get(url)).await?).await?;
        let listed: ArtifactsResponse = res
            .json()
            .await
            .map_err(|e| GitError::Transport(format!("failed to parse the artifacts: {e}")))?;
        Ok(listed
            .artifacts
            .into_iter()
            .filter(|artifact| artifact.name == name)
            .map(|artifact| Artifact {
                id: artifact.id,
                size: artifact.size_in_bytes,
                run: artifact.workflow_run.id,
                commit: artifact.workflow_run.head_sha,
            })
            .collect())
    }

    /// `GET /actions/artifacts/{id}/zip` — the bytes the run uploaded, at most `limit` of them.
    ///
    /// The forge answers with a redirect to a signed address on its ROOT_URL, the public host the
    /// cluster may not reach, so the signed path is fetched from the API base the Portal dials;
    /// the signature is the grant and no token goes with it.
    pub async fn download_artifact(&self, id: u64, limit: u64) -> Result<Vec<u8>, GitError> {
        let url = self.repo_url(&format!("actions/artifacts/{id}/zip"))?;
        let res = self.send(self.http.get(url)).await?;
        let res = if res.status().is_redirection() {
            let signed = res
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| Url::parse(value).ok())
                .ok_or_else(|| GitError::Transport("the forge redirected nowhere".into()))?;
            let mut here = self.base.clone();
            here.set_path(signed.path());
            here.set_query(signed.query());
            self.http
                .get(here)
                .timeout(Duration::from_secs(120))
                .send()
                .await
                .map_err(|e| GitError::Transport(e.to_string()))?
        } else {
            res
        };
        read_capped(
            Self::check_status(res).await?,
            limit,
            &format!("artifact {id}"),
        )
        .await
    }

    fn generic_package_url(
        &self,
        package: &str,
        version: &str,
        file: &str,
    ) -> Result<Url, GitError> {
        let full = format!(
            "{}/api/packages/{}/generic/{package}/{version}/{file}",
            self.base.as_str().trim_end_matches('/'),
            self.owner
        );
        Url::parse(&full).map_err(|e| GitError::Config(format!("invalid url '{full}': {e}")))
    }

    /// `PUT /api/packages/{owner}/generic/{package}/{version}/{file}` — one file of a generic
    /// package of the organization (AP-101). A file the version already holds is a
    /// `GitError::Conflict`: the registry never replaces one.
    pub async fn put_generic_file(
        &self,
        package: &str,
        version: &str,
        file: &str,
        bytes: Vec<u8>,
    ) -> Result<(), GitError> {
        let url = self.generic_package_url(package, version, file)?;
        let res = self
            .send(
                self.http
                    .put(url)
                    .timeout(Duration::from_secs(120))
                    .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
                    .body(bytes),
            )
            .await?;
        Self::check_status(res).await?;
        Ok(())
    }

    /// `GET /api/packages/{owner}/generic/{package}/{version}/{file}`, at most `limit` bytes.
    pub async fn get_generic_file(
        &self,
        package: &str,
        version: &str,
        file: &str,
        limit: u64,
    ) -> Result<Vec<u8>, GitError> {
        let url = self.generic_package_url(package, version, file)?;
        let res = self
            .send(self.http.get(url).timeout(Duration::from_secs(120)))
            .await?;
        read_capped(
            Self::check_status(res).await?,
            limit,
            &format!("{package}/{version}/{file}"),
        )
        .await
    }

    /// A registry token for pushing to `{owner}/{image}` of the forge's container registry,
    /// asked of `/v2/token` with this client's own token (AP-107). The token realm the registry
    /// names carries ROOT_URL, the public host the cluster may not reach, so the token is asked
    /// of the API base the Portal dials.
    async fn registry_token(&self, image: &str) -> Result<String, GitError> {
        let mut url = Url::parse(&format!(
            "{}/v2/token",
            self.base.as_str().trim_end_matches('/')
        ))
        .map_err(|e| GitError::Config(e.to_string()))?;
        url.query_pairs_mut()
            .append_pair("service", "container_registry")
            .append_pair(
                "scope",
                &format!("repository:{}/{image}:push,pull", self.owner),
            );
        let res = self
            .http
            .get(url)
            .basic_auth(&self.owner, Some(&self.token))
            .send()
            .await
            .map_err(|e| GitError::Transport(e.to_string()))?;
        #[derive(Deserialize)]
        struct Token {
            token: String,
        }
        let token: Token =
            Self::check_status(res).await?.json().await.map_err(|e| {
                GitError::Transport(format!("failed to parse the registry token: {e}"))
            })?;
        Ok(token.token)
    }

    /// Pushes an image to `{owner}/{image}:{tag}` of the forge's container registry: every blob
    /// it does not hold yet, then the manifest's bytes as they are, and answers the digest the
    /// registry says it stored (AP-107). A blob goes up in one request with its digest, so the
    /// registry checks each one itself.
    pub async fn push_image(
        &self,
        image: &str,
        tag: &str,
        blobs: &[(&str, &[u8])],
        manifest_type: &str,
        manifest: &[u8],
    ) -> Result<String, GitError> {
        let bearer = self.registry_token(image).await?;
        let base = format!(
            "{}/v2/{}/{image}",
            self.base.as_str().trim_end_matches('/'),
            self.owner
        );
        let parse = |url: String| Url::parse(&url).map_err(|e| GitError::Config(e.to_string()));
        let send = |builder: reqwest::RequestBuilder| async {
            builder
                .bearer_auth(&bearer)
                .timeout(Duration::from_secs(300))
                .send()
                .await
                .map_err(|e| GitError::Transport(e.to_string()))
        };
        for (digest, bytes) in blobs {
            let held = send(self.http.head(parse(format!("{base}/blobs/{digest}"))?)).await?;
            if held.status().is_success() {
                continue;
            }
            let mut upload = parse(format!("{base}/blobs/uploads/"))?;
            upload.query_pairs_mut().append_pair("digest", digest);
            let res = send(
                self.http
                    .post(upload)
                    .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
                    .body(bytes.to_vec()),
            )
            .await?;
            Self::check_status(res).await?;
        }
        let res = send(
            self.http
                .put(parse(format!("{base}/manifests/{tag}"))?)
                .header(reqwest::header::CONTENT_TYPE, manifest_type)
                .body(manifest.to_vec()),
        )
        .await?;
        let res = Self::check_status(res).await?;
        res.headers()
            .get("docker-content-digest")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
            .ok_or_else(|| GitError::Transport("the registry answered no digest".into()))
    }

    /// `GET /git/trees/{git_ref}?recursive=true&per_page=1000` — retrieves the Git tree.
    pub async fn list_tree(&self, git_ref: &str) -> Result<Vec<String>, GitError> {
        Ok(self
            .list_tree_blobs(git_ref)
            .await?
            .into_iter()
            .map(|(path, _)| path)
            .collect())
    }

    /// The tree's files with their blob ids, so two trees compare without reading a file.
    ///
    /// A branch whose name carries a slash — every workspace branch, `workspace/{name}` (CC-76) —
    /// is resolved to its head commit first: Gitea's `git/trees/{ref}` answers `404` for such a
    /// name, encoded or not, so every read of a copy's tree came back "not found" and the copy
    /// showed the project instead of itself (T-2266).
    pub async fn list_tree_blobs(&self, git_ref: &str) -> Result<Vec<(String, String)>, GitError> {
        let resolved = if git_ref.contains('/') {
            self.branch_head(git_ref).await?
        } else {
            git_ref.to_owned()
        };
        let git_ref = resolved.as_str();
        let mut url = self.repo_url(&format!("git/trees/{git_ref}"))?;
        url.query_pairs_mut()
            .append_pair("recursive", "true")
            .append_pair("per_page", "1000");

        let res = self.send(self.http.get(url)).await?;
        let res = Self::check_status(res).await?;
        let status_code = res.status().as_u16();
        let raw: GitTreeResponse = res
            .json()
            .await
            .map_err(|e| GitError::Transport(format!("failed to parse tree response: {e}")))?;

        if raw.truncated {
            return Err(GitError::Api {
                status: status_code,
                message: "git tree was truncated".to_string(),
            });
        }

        let paths = raw
            .tree
            .into_iter()
            .filter(|entry| entry.entry_type == "blob")
            .map(|entry| (entry.path, entry.sha))
            .collect();

        Ok(paths)
    }

    /// `GET /branches/{branch}` — returns the head commit id for the given branch.
    pub async fn branch_head(&self, branch: &str) -> Result<String, GitError> {
        let url = self.repo_url(&format!("branches/{branch}"))?;
        let res = self.send(self.http.get(url)).await?;
        let res = Self::check_status(res).await?;
        let branch_dto: BranchDetailsResponse = res
            .json()
            .await
            .map_err(|e| GitError::Transport(format!("failed to parse branch response: {e}")))?;
        Ok(branch_dto.commit.id)
    }

    /// `POST /branches` — creates a new branch from an existing one.
    pub async fn create_branch(&self, new_branch: &str, from_branch: &str) -> Result<(), GitError> {
        let url = self.repo_url("branches")?;
        let payload = CreateBranchPayload {
            new_branch_name: new_branch,
            old_branch_name: from_branch,
        };
        let res = self.send(self.http.post(url).json(&payload)).await?;
        Self::check_status(res).await?;
        Ok(())
    }

    /// `DELETE /branches/{branch}` — drops a branch; one already gone is no error (T-0886).
    pub async fn delete_branch(&self, branch: &str) -> Result<(), GitError> {
        let url = self.repo_url(&format!("branches/{branch}"))?;
        let res = self.send(self.http.delete(url)).await?;
        match Self::check_status(res).await {
            Ok(_) | Err(GitError::NotFound) => Ok(()),
            Err(err) => Err(err),
        }
    }

    /// `GET /contents/{path}?ref={git_ref}` — reads a file and decodes its base64 content.
    pub async fn get_file(&self, path: &str, git_ref: &str) -> Result<Option<RepoFile>, GitError> {
        let mut url = self.repo_url(&format!("contents/{}", path.trim_start_matches('/')))?;
        url.query_pairs_mut().append_pair("ref", git_ref);

        let res = self.send(self.http.get(url)).await?;
        if res.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let res = Self::check_status(res).await?;
        let raw: ContentsDto = res
            .json()
            .await
            .map_err(|e| GitError::Transport(format!("failed to parse contents response: {e}")))?;

        let clean_base64: String = raw.content.chars().filter(|c| !c.is_whitespace()).collect();
        let decoded_bytes = STANDARD
            .decode(clean_base64.as_bytes())
            .map_err(|e| GitError::Transport(format!("invalid base64 content: {e}")))?;
        let content = String::from_utf8(decoded_bytes)
            .map_err(|e| GitError::Transport(format!("content is not valid utf-8: {e}")))?;

        Ok(Some(RepoFile {
            sha: raw.sha,
            content,
        }))
    }

    /// `PUT /contents/{path}` — creates or replaces a file with human commit attribution.
    pub async fn put_file(&self, req: &FileWrite<'_>) -> Result<String, GitError> {
        let url = self.repo_url(&format!("contents/{}", req.path.trim_start_matches('/')))?;
        let encoded = STANDARD.encode(req.content.as_bytes());
        let payload = PutFilePayload {
            content: encoded,
            message: req.message,
            branch: req.branch,
            sha: req.sha,
            author: req.author,
            committer: req.author,
        };
        let res = self.send(self.http.put(url).json(&payload)).await?;
        let res = Self::check_status(res).await?;
        let body: FileCommitResponse = res
            .json()
            .await
            .map_err(|e| GitError::Transport(format!("failed to parse commit response: {e}")))?;
        let commit_sha = body
            .commit
            .map(|c| c.sha)
            .or(body.sha)
            .ok_or_else(|| GitError::Transport("missing commit sha in response".to_string()))?;
        Ok(commit_sha)
    }

    /// `POST /contents` — one commit on `branch` that creates or replaces every
    /// `(path, content)` of `uploads` and deletes every `(path, blob sha)` of `deletes`, with
    /// human commit attribution. `upload` needs no blob sha, so a run commits what it changed
    /// without reading each file first; only a deletion names the blob it removes.
    pub async fn change_files(
        &self,
        branch: &str,
        message: &str,
        author: Author<'_>,
        uploads: &[(String, String)],
        deletes: &[(String, String)],
    ) -> Result<String, GitError> {
        let url = self.repo_url("contents")?;
        let payload = ChangeFilesPayload {
            files: uploads
                .iter()
                .map(|(path, content)| ChangeFileDto {
                    operation: "upload",
                    path: path.trim_start_matches('/').to_owned(),
                    content: Some(STANDARD.encode(content.as_bytes())),
                    sha: None,
                })
                .chain(deletes.iter().map(|(path, sha)| ChangeFileDto {
                    operation: "delete",
                    path: path.trim_start_matches('/').to_owned(),
                    content: None,
                    sha: Some(sha.clone()),
                }))
                .collect(),
            message,
            branch,
            author,
            committer: author,
        };
        let res = self.send(self.http.post(url).json(&payload)).await?;
        let res = Self::check_status(res).await?;
        let body: FileCommitResponse = res
            .json()
            .await
            .map_err(|e| GitError::Transport(format!("failed to parse commit response: {e}")))?;
        body.commit
            .map(|c| c.sha)
            .ok_or_else(|| GitError::Transport("missing commit sha in response".to_string()))
    }

    /// `DELETE /contents/{path}` — deletes a file with human commit attribution.
    pub async fn delete_file(&self, req: &FileDelete<'_>) -> Result<String, GitError> {
        let url = self.repo_url(&format!("contents/{}", req.path.trim_start_matches('/')))?;
        let payload = DeleteFilePayload {
            message: req.message,
            branch: req.branch,
            sha: req.sha,
            author: req.author,
            committer: req.author,
        };
        let res = self.send(self.http.delete(url).json(&payload)).await?;
        let res = Self::check_status(res).await?;
        let body: Result<FileCommitResponse, _> = res.json().await;
        let commit_sha = match body {
            Ok(b) => b.commit.map(|c| c.sha).or(b.sha).unwrap_or_default(),
            Err(_) => String::new(),
        };
        Ok(commit_sha)
    }

    /// `GET /commits?sha={git_ref}&path={path}&limit={limit}` — the history of one path.
    ///
    /// The forge is the only source: the mirror knows the manifests of one revision, never how
    /// they got there, so a revision picker that read the mirror would have nothing to show.
    pub async fn list_commits(
        &self,
        git_ref: &str,
        path: &str,
        limit: usize,
    ) -> Result<Vec<Commit>, GitError> {
        let mut url = self.repo_url("commits")?;
        url.query_pairs_mut()
            .append_pair("sha", git_ref)
            .append_pair("path", path)
            .append_pair("limit", &limit.to_string())
            .append_pair("stat", "false")
            .append_pair("verification", "false")
            .append_pair("files", "false");

        let res = self.send(self.http.get(url)).await?;
        let res = Self::check_status(res).await?;
        let raw: Vec<CommitDto> = res
            .json()
            .await
            .map_err(|e| GitError::Transport(format!("failed to parse commits response: {e}")))?;

        Ok(raw
            .into_iter()
            .map(|dto| {
                let details = dto.commit.unwrap_or(CommitDetailsDto {
                    message: String::new(),
                    author: None,
                });
                let author = details.author.unwrap_or(CommitAuthorDto {
                    name: String::new(),
                    email: None,
                    date: String::new(),
                });
                Commit {
                    sha: dto.sha,
                    message: details
                        .message
                        .lines()
                        .next()
                        .unwrap_or_default()
                        .to_string(),
                    author: author.name,
                    email: author.email,
                    date: author.date,
                }
            })
            .collect())
    }

    /// `GET /pulls?state={state}&sort=recentupdate&limit=50` — retrieves pull requests.
    pub async fn list_pull_requests(&self, state: &str) -> Result<Vec<PullRequest>, GitError> {
        let mut url = self.repo_url("pulls")?;
        url.query_pairs_mut()
            .append_pair("state", state)
            .append_pair("sort", "recentupdate")
            .append_pair("limit", "50");

        let res = self.send(self.http.get(url)).await?;
        let res = Self::check_status(res).await?;
        let raw_list: Vec<GiteaPullResponse> = res
            .json()
            .await
            .map_err(|e| GitError::Transport(format!("failed to parse pull requests list: {e}")))?;
        Ok(raw_list.into_iter().map(|raw| self.pull(raw)).collect())
    }

    /// `POST /pulls` — creates a new pull request.
    pub async fn create_pull_request(
        &self,
        head: &str,
        base: &str,
        title: &str,
        body: &str,
    ) -> Result<PullRequest, GitError> {
        let url = self.repo_url("pulls")?;
        let payload = CreatePullRequestPayload {
            head,
            base,
            title,
            body,
        };
        let res = self.send(self.http.post(url).json(&payload)).await?;
        let res = Self::check_status(res).await?;
        let raw: GiteaPullResponse = res
            .json()
            .await
            .map_err(|e| GitError::Transport(format!("failed to parse pull request: {e}")))?;
        Ok(self.pull(raw))
    }

    /// `GET /pulls/{number}/files` — every file the pull request changes, all pages.
    pub async fn pull_request_files(&self, number: u64) -> Result<Vec<ChangedFile>, GitError> {
        const PAGE: usize = 50;
        let mut files = Vec::new();
        for page in 1.. {
            let mut url = self.repo_url(&format!("pulls/{number}/files"))?;
            url.query_pairs_mut()
                .append_pair("page", &page.to_string())
                .append_pair("limit", &PAGE.to_string());
            let res = self.send(self.http.get(url)).await?;
            let res = Self::check_status(res).await?;
            let raw: Vec<ChangedFileDto> = res.json().await.map_err(|e| {
                GitError::Transport(format!("failed to parse pull request files: {e}"))
            })?;
            let count = raw.len();
            files.extend(raw.into_iter().map(|dto| ChangedFile {
                deleted: dto.status == "deleted",
                added: dto.status == "added",
                path: dto.filename,
            }));
            if count < PAGE {
                break;
            }
        }
        Ok(files)
    }

    /// `GET /pulls/{number}` — retrieves an existing pull request.
    pub async fn pull_request(&self, number: u64) -> Result<PullRequest, GitError> {
        let url = self.repo_url(&format!("pulls/{number}"))?;
        let res = self.send(self.http.get(url)).await?;
        let res = Self::check_status(res).await?;
        let raw: GiteaPullResponse = res
            .json()
            .await
            .map_err(|e| GitError::Transport(format!("failed to parse pull request: {e}")))?;
        Ok(self.pull(raw))
    }

    /// `POST /pulls/{number}/reviews` — submits a review on the pull request.
    pub async fn review(
        &self,
        number: u64,
        event: ReviewEvent,
        body: &str,
    ) -> Result<(), GitError> {
        let url = self.repo_url(&format!("pulls/{number}/reviews"))?;
        let payload = ReviewPayload { event, body };
        let res = self.send(self.http.post(url).json(&payload)).await?;
        Self::check_status(res).await?;
        Ok(())
    }

    /// `PATCH /pulls/{number}` with `state: closed` — closes the pull request without merging,
    /// which is what the Portal reads back as a rejected change.
    pub async fn close_pull_request(&self, number: u64) -> Result<(), GitError> {
        let url = self.repo_url(&format!("pulls/{number}"))?;
        let res = self
            .send(
                self.http
                    .patch(url)
                    .json(&serde_json::json!({ "state": "closed" })),
            )
            .await?;
        Self::check_status(res).await?;
        Ok(())
    }

    /// `POST /pulls/{number}/merge` — merges the pull request.
    /// Merges pull request `number`.
    ///
    /// `head_commit_id` is the commit whose content the caller approved: the forge refuses the
    /// merge when the branch has moved past it, so nothing is merged that nobody reviewed
    /// (PF-57, T-1683). `None` only where there is nothing to review — a proposal this Portal
    /// wrote and merges in the same call.
    pub async fn merge(
        &self,
        number: u64,
        style: MergeStyle,
        message: &str,
        head_commit_id: Option<&str>,
    ) -> Result<(), GitError> {
        let url = self.repo_url(&format!("pulls/{number}/merge"))?;
        let payload = MergePayload {
            do_field: style,
            merge_message_field: message,
            head_commit_id: head_commit_id.filter(|sha| !sha.is_empty()),
        };
        let res = self.send(self.http.post(url).json(&payload)).await?;
        Self::check_status(res).await?;
        Ok(())
    }
}

#[cfg(test)]
mod browse_url_tests {
    use super::GiteaClient;

    fn env(public: Option<&str>) -> impl Fn(&str) -> Option<String> + '_ {
        move |name| match name {
            "JC_GITEA_URL" => Some("http://gitea-http.dev.svc.cluster.local:3000".to_string()),
            "JC_GITEA_OWNER" => Some("joinedcontext".to_string()),
            "JC_GITEA_REPO" => Some("configuration".to_string()),
            "JC_GITEA_TOKEN" => Some("t".to_string()),
            "JC_GITEA_PUBLIC_URL" => public.map(str::to_string),
            _ => None,
        }
    }

    /// A "Source" link opens in a browser, which resolves no cluster-internal name — and
    /// carries the forge's sign-in, because a Portal session is not a forge session and the
    /// repository is private (PF-81).
    #[test]
    fn the_source_link_uses_the_public_forge_url_behind_the_sign_in() {
        let client = GiteaClient::from_env(env(Some("https://city.example/git")))
            .expect("config")
            .expect("configured");
        assert_eq!(
            client.browse_url("projects/helsinki/pipelines/p/pipeline.yaml", "main"),
            "https://city.example/git/user/login?redirect_to=%2Fgit%2Fjoinedcontext%2Fconfiguration%2Fsrc%2Fbranch%2Fmain%2Fprojects%2Fhelsinki%2Fpipelines%2Fp%2Fpipeline.yaml"
        );
    }

    /// Without a public URL the API base is the best the Portal knows.
    #[test]
    fn the_source_link_falls_back_to_the_api_base() {
        let client = GiteaClient::from_env(env(None))
            .expect("config")
            .expect("configured");
        assert_eq!(
            client.browse_url("a.yaml", "main"),
            "http://gitea-http.dev.svc.cluster.local:3000/user/login\
             ?redirect_to=%2Fjoinedcontext%2Fconfiguration%2Fsrc%2Fbranch%2Fmain%2Fa.yaml"
        );
    }

    /// The merge request a change links is opened in a browser too (AP-71).
    #[test]
    fn the_merge_request_link_uses_the_public_forge_url() {
        let client = GiteaClient::from_env(env(Some("https://city.example/git/")))
            .expect("config")
            .expect("configured");
        assert_eq!(
            client.pull_url(110),
            "https://city.example/git/user/login\
             ?redirect_to=%2Fgit%2Fjoinedcontext%2Fconfiguration%2Fpulls%2F110"
        );
    }

    #[test]
    fn an_invalid_public_url_is_a_config_error() {
        assert!(GiteaClient::from_env(env(Some("not a url"))).is_err());
    }
}
