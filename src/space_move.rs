//! Moving a space to another broker (API/01 §45, PF-115, ADR-N-047 §2.6).
//!
//! One job per space: hold it read-only by the `moving-to` annotation, wait until the gateway's
//! scrape says the hold is in force, stream the source broker's tenant export into the target's
//! import, compare both digests, then switch `brokerRef` and drop the annotation in one commit.
//! Any failure drops the annotation, so the space is read-write again where it was, and purges a
//! target that took the copy. The source keeps its copy; an operator purges it.
//! ponytail: jobs live in memory; a restart forgets one, the annotation keeps the space held,
//! and starting the move again resumes from the hold.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::git::{Author, FileWrite, GiteaClient};

/// The annotation that holds a space read-only while it moves (ADR-N-047 §2.6).
pub const MOVING_TO: &str = "joinedcontext.com/moving-to";
/// The gateway's series of held spaces, one per tenant.
const HELD: &str = "jc_gateway_space_held";

/// Where a move is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum MoveState {
    Holding,
    Copying,
    Comparing,
    Switching,
    Done,
    Failed,
}

/// A broker's digest of one tenant (Antares ADR-0030).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Digest {
    pub entities: u64,
    pub attr_instances: u64,
    pub sha256: String,
}

/// One move, as `GET …/move` answers it.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Move {
    /// `project/space`.
    pub space: String,
    pub from: String,
    pub to: String,
    pub state: MoveState,
    pub reason: Option<String>,
    pub source: Option<Digest>,
    pub target: Option<Digest>,
    #[schema(value_type = String, format = DateTime)]
    pub started_at: DateTime<Utc>,
    #[schema(value_type = Option<String>, format = DateTime)]
    pub ended_at: Option<DateTime<Utc>>,
}

/// Everything one move needs, resolved before it starts.
pub struct Plan {
    pub project: String,
    pub space: String,
    pub tenant: String,
    pub from: String,
    pub to: String,
    /// The source and target brokers' addresses.
    pub source: String,
    pub target: String,
    pub token: String,
    pub gateway: String,
    pub forge: Arc<GiteaClient>,
    /// The space's manifest in the repository.
    pub path: String,
    /// Who started it, for the commit messages.
    pub by: String,
}

/// The moves of this Portal, one per space.
pub struct Moves {
    jobs: Mutex<HashMap<String, Move>>,
    http: reqwest::Client,
    poll: Duration,
    patience: Duration,
}

impl Default for Moves {
    fn default() -> Self {
        Self::new(Duration::from_secs(2), Duration::from_secs(600))
    }
}

impl Moves {
    /// Reads the gateway every `poll` and waits for the hold at most `patience`.
    pub fn new(poll: Duration, patience: Duration) -> Self {
        Self {
            jobs: Mutex::default(),
            // No timeout on the client: an export streams for as long as the tenant is large.
            http: reqwest::Client::new(),
            poll,
            patience,
        }
    }

    /// The last move of `project/space`.
    pub fn get(&self, key: &str) -> Option<Move> {
        lock(&self.jobs).get(key).cloned()
    }

    /// Starts the move in the background; `Err` while another move of the space runs.
    pub fn start(self: &Arc<Self>, plan: Plan) -> Result<Move, String> {
        let key = format!("{}/{}", plan.project, plan.space);
        let job = Move {
            space: key.clone(),
            from: plan.from.clone(),
            to: plan.to.clone(),
            state: MoveState::Holding,
            reason: None,
            source: None,
            target: None,
            started_at: Utc::now(),
            ended_at: None,
        };
        {
            let mut jobs = lock(&self.jobs);
            if jobs.get(&key).is_some_and(|running| {
                !matches!(running.state, MoveState::Done | MoveState::Failed)
            }) {
                return Err(format!(
                    "space '{key}' is already moving; wait for that move to end"
                ));
            }
            jobs.insert(key.clone(), job.clone());
        }
        let moves = Arc::clone(self);
        tokio::spawn(async move { moves.run(&key, &plan).await });
        Ok(job)
    }

    async fn run(&self, key: &str, plan: &Plan) {
        let mut imported = false;
        let outcome = self.steps(key, plan, &mut imported).await;
        let reason = match outcome {
            Ok(()) => None,
            Err(reason) => Some(self.undo(plan, imported, reason).await),
        };
        tracing::info!(space = key, to = %plan.to, failed = reason.is_some(), "space move ended");
        self.set(key, |job| {
            job.state = if reason.is_some() {
                MoveState::Failed
            } else {
                MoveState::Done
            };
            job.reason = reason;
            job.ended_at = Some(Utc::now());
        });
    }

    async fn steps(&self, key: &str, plan: &Plan, imported: &mut bool) -> Result<(), String> {
        let hold = format!(
            "hold space {}/{} read-only to move it to broker {} (started by {}, PF-115)",
            plan.project, plan.space, plan.to, plan.by
        );
        let to = plan.to.clone();
        self.edit(plan, &hold, move |manifest| {
            annotations(manifest).insert(MOVING_TO.into(), to.into());
        })
        .await?;
        self.await_hold(plan).await?;

        self.set(key, |job| job.state = MoveState::Copying);
        self.copy(plan).await?;
        *imported = true;

        self.set(key, |job| job.state = MoveState::Comparing);
        let source = self.digest(&plan.source, plan).await?;
        let target = self.digest(&plan.target, plan).await?;
        let (same, both) = (source == target, (source.clone(), target.clone()));
        self.set(key, |job| {
            job.source = Some(both.0);
            job.target = Some(both.1);
        });
        if !same {
            return Err(format!(
                "the copy does not match: the source holds {} entities and {} history records, \
                 the target {} and {}",
                source.entities, source.attr_instances, target.entities, target.attr_instances
            ));
        }

        self.set(key, |job| job.state = MoveState::Switching);
        let switch = format!(
            "move space {}/{} to broker {} (started by {}, PF-115)",
            plan.project, plan.space, plan.to, plan.by
        );
        let to = plan.to.clone();
        self.edit(plan, &switch, move |manifest| {
            release(manifest);
            spec(manifest).insert("brokerRef".into(), to.into());
        })
        .await
    }

    /// Releases the hold and purges a target that took the copy; answers `reason` with what
    /// could not be undone.
    async fn undo(&self, plan: &Plan, imported: bool, reason: String) -> String {
        let mut reason = reason;
        if imported {
            if let Err(err) = self.purge(&plan.target, plan).await {
                reason.push_str(&format!("; the target's copy was not purged: {err}"));
            }
        }
        let message = format!(
            "release space {}/{}: its move to broker {} failed (PF-115)",
            plan.project, plan.space, plan.to
        );
        if let Err(err) = self.edit(plan, &message, release).await {
            reason.push_str(&format!("; the hold was not released: {err}"));
        }
        reason
    }

    fn set(&self, key: &str, change: impl FnOnce(&mut Move)) {
        if let Some(job) = lock(&self.jobs).get_mut(key) {
            change(job);
        }
    }

    /// Edits the space's manifest on the default branch as the Portal; no commit when nothing
    /// changed, so a resumed move does not commit its hold twice.
    async fn edit(
        &self,
        plan: &Plan,
        message: &str,
        change: impl FnOnce(&mut serde_norway::Mapping),
    ) -> Result<(), String> {
        let failed =
            |err: crate::git::GitError| format!("the repository refused the commit: {err}");
        let branch = plan.forge.default_branch().await.map_err(failed)?;
        let file = plan
            .forge
            .get_file(&plan.path, &branch)
            .await
            .map_err(failed)?
            .ok_or_else(|| {
                format!(
                    "the space's manifest {} is not in the repository",
                    plan.path
                )
            })?;
        let mut manifest: serde_norway::Mapping = serde_norway::from_str(&file.content)
            .map_err(|err| format!("the space's manifest does not parse: {err}"))?;
        let before = manifest.clone();
        change(&mut manifest);
        if manifest == before {
            return Ok(());
        }
        let content = serde_norway::to_string(&manifest).map_err(|err| err.to_string())?;
        plan.forge
            .put_file(&FileWrite {
                path: &plan.path,
                branch: &branch,
                message,
                content: &content,
                sha: Some(&file.sha),
                author: Author {
                    name: crate::sync::proposal::AUTHOR_NAME,
                    email: crate::sync::proposal::AUTHOR_EMAIL,
                },
            })
            .await
            .map(|_| ())
            .map_err(failed)
    }

    /// Waits until the gateway's scrape says it holds the space.
    async fn await_hold(&self, plan: &Plan) -> Result<(), String> {
        let wanted = format!("{HELD}{{space=\"{}\"}} 1", plan.tenant);
        let deadline = tokio::time::Instant::now() + self.patience;
        loop {
            let scrape = self
                .http
                .get(format!("{}/metrics", plan.gateway))
                .timeout(Duration::from_secs(10))
                .send()
                .await
                .ok()
                .filter(|answer| answer.status().is_success());
            if let Some(answer) = scrape {
                if answer
                    .text()
                    .await
                    .unwrap_or_default()
                    .lines()
                    .any(|line| line == wanted)
                {
                    return Ok(());
                }
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(format!(
                    "the gateway did not take the hold within {} seconds, so nothing was copied",
                    self.patience.as_secs()
                ));
            }
            tokio::time::sleep(self.poll).await;
        }
    }

    /// Streams the source's export into the target's import; nothing is held in memory.
    async fn copy(&self, plan: &Plan) -> Result<(), String> {
        let export = self
            .http
            .get(format!("{}/q/tenants/{}/export", plan.source, plan.tenant))
            .bearer_auth(&plan.token)
            .send()
            .await
            .map_err(|err| {
                format!(
                    "the source broker did not answer the export: {}",
                    err.without_url()
                )
            })?;
        if !export.status().is_success() {
            return Err(refusal("the source broker refused the export", export).await);
        }
        let import = self
            .http
            .post(format!("{}/q/tenants/{}/import", plan.target, plan.tenant))
            .bearer_auth(&plan.token)
            .header(reqwest::header::CONTENT_TYPE, "application/x-ndjson")
            .body(reqwest::Body::wrap_stream(export.bytes_stream()))
            .send()
            .await
            .map_err(|err| {
                format!(
                    "the target broker did not take the import: {}",
                    err.without_url()
                )
            })?;
        if !import.status().is_success() {
            return Err(refusal("the target broker refused the import", import).await);
        }
        Ok(())
    }

    async fn digest(&self, broker: &str, plan: &Plan) -> Result<Digest, String> {
        let answer = self
            .http
            .get(format!("{broker}/q/tenants/{}/digest", plan.tenant))
            .bearer_auth(&plan.token)
            .timeout(Duration::from_secs(300))
            .send()
            .await
            .map_err(|err| format!("a broker did not answer its digest: {}", err.without_url()))?;
        if !answer.status().is_success() {
            return Err(refusal("a broker refused its digest", answer).await);
        }
        answer
            .json()
            .await
            .map_err(|err| format!("a broker's digest does not read: {err}"))
    }

    async fn purge(&self, broker: &str, plan: &Plan) -> Result<(), String> {
        let answer = self
            .http
            .delete(format!("{broker}/q/tenants/{}", plan.tenant))
            .bearer_auth(&plan.token)
            .timeout(Duration::from_secs(300))
            .send()
            .await
            .map_err(|err| err.without_url().to_string())?;
        match answer.status().is_success() {
            true => Ok(()),
            false => Err(refusal("the broker refused the purge", answer).await),
        }
    }
}

fn lock<T>(held: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    held.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// `what: status: detail`, the broker's problem detail cut to a sentence.
async fn refusal(what: &str, answer: reqwest::Response) -> String {
    let status = answer.status();
    let body: serde_json::Value = answer.json().await.unwrap_or_default();
    match body["detail"].as_str().or(body["title"].as_str()) {
        Some(detail) => format!(
            "{what}: {status}: {}",
            detail.chars().take(300).collect::<String>()
        ),
        None => format!("{what}: {status}"),
    }
}

fn member<'a>(map: &'a mut serde_norway::Mapping, key: &str) -> &'a mut serde_norway::Mapping {
    let value = map
        .entry(key.into())
        .or_insert_with(|| serde_norway::Value::Mapping(Default::default()));
    if !value.is_mapping() {
        *value = serde_norway::Value::Mapping(Default::default());
    }
    value.as_mapping_mut().expect("a mapping")
}

fn annotations(manifest: &mut serde_norway::Mapping) -> &mut serde_norway::Mapping {
    member(member(manifest, "metadata"), "annotations")
}

/// Drops the hold, and the annotations with it when it was the only one.
fn release(manifest: &mut serde_norway::Mapping) {
    let metadata = member(manifest, "metadata");
    let annotations = member(metadata, "annotations");
    annotations.remove(MOVING_TO);
    if annotations.is_empty() {
        metadata.remove("annotations");
    }
}

fn spec(manifest: &mut serde_norway::Mapping) -> &mut serde_norway::Mapping {
    member(manifest, "spec")
}
