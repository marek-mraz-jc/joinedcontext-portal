//! The reconciler loop against the Git repository (T-0191, MF-04, CC-03, CC-08).
//!
//! Re-reads the declared manifests from Gitea at the default branch HEAD, loads them with
//! `jcctl`, compiles their live status and swaps them into the in-memory mirror atomically.
//!
//! The loading is `jcctl`'s, not the Portal's: the same code that validates a repository for
//! `jcctl plan` decides here what a manifest is, which kinds exist and which two files claim
//! one identity. A Portal that parsed manifests its own way would eventually disagree with
//! the CLI, and the disagreement would show up as a resource that CI accepts and the Portal
//! cannot see.
//!
//! A run that cannot load the repository leaves the mirror on the last revision that loaded
//! and records why in the status. Serving half a repository is worse than serving a slightly
//! old one: a resource missing from the Portal reads as deleted.
//!
//! Only the elected leader reconciles ([`super::leader`]): streams, apps and roles. Every
//! replica loads the repository into its own mirror, a follower read-only, so each one serves
//! the projects and a new pod of a rolling update is ready while the old one holds the lock
//! (OPS-51).

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use utoipa::ToSchema;

use super::groups::GroupSync;
use super::leader::Leadership;
use super::registrations::RegistrationOutcome;
use super::streams::{
    eligible, is_stream_pipeline, make_condition, Bentos, StreamDeployer, StreamOutcome,
};
use super::subscriptions::SubscriptionOutcome;
use crate::activity::{ActivityEvent, ActivityStore};
use crate::apps::converge::{Converger, Outcome};
use crate::git::{Author, FileWrite, GitError, GiteaClient};
use crate::resource::ResourceEnvelope;
use crate::store::Mirror;
use jcctl::loader::Repository;

/// The resident runner's Deployment, which mounts the Secret this reconciler writes (T-0927).
/// One name, because a deployment that runs a second runner gives it the same chart and the
/// same Secret; a runner per project is a task of its own.
const PIPELINE_RUNNER_DEPLOYMENT: &str = "pipeline-runner";

/// Status of the background Git mirror synchronization.
///
/// Served to the browser, so it deliberately never carries a token,
/// repository URL, or branch name.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub last_sync: Option<i64>,
    pub revision: Option<String>,
    pub manifests: usize,
    pub last_error: Option<String>,
    /// Whether this replica is the one that reconciles (CC-03). A Portal without a database
    /// has no election to run and reconciles on its own, so it reports itself as the leader.
    pub leader: bool,
}

/// Errors returned during repository synchronization.
#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error("git error: {0}")]
    Git(#[from] GitError),
    #[error("{0}")]
    Empty(String),
    /// The repository does not load as a set of manifests (CC-08, MF-05, MF-06).
    #[error("repository does not load: {0}")]
    Load(#[from] jcctl::loader::LoadError),
    /// `users/` does not compile: a binding names a role that does not exist, or a spec does
    /// not fit its kind (T-0527).
    #[error("roles do not compile: {0}")]
    Roles(String),
    /// A layout 2 organization does not assemble: its registry, a layout file, or a name two
    /// projects claim (CC-85, CC-86).
    #[error("the organization does not assemble: {0}")]
    Assemble(#[from] jcctl::assemble::AssembleError),
    /// The scratch directory the loader reads from could not be written.
    #[error("cannot stage the repository at {path}: {source}")]
    Scratch {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

/// Background reconciler synchronizing repository manifests into the in-memory mirror.
pub struct Syncer {
    gitea: Arc<GiteaClient>,
    mirror: Arc<Mirror>,
    status: Arc<RwLock<SyncStatus>>,
    running: Arc<Mutex<()>>,
    /// Where a layout 2 organization is assembled, kept between syncs so a project that does
    /// not stage renders as the last assembly left it (CC-86). One per syncer; its syncs run
    /// one at a time behind `running`.
    assembly: PathBuf,
    /// `None` when the Portal has no database: a single replica needs no election.
    leadership: Option<Arc<Leadership>>,
    /// `None` when this Portal applies no app objects: outside a cluster, or without the
    /// settings that say which namespace they belong in (T-0411, AP-18).
    converger: Option<Arc<Converger>>,
    streams: Option<Arc<StreamDeployer>>,
    /// `None` when no gateway address is configured: a `Subscription` is then read from the
    /// repository and written into no broker (T-0931, CC-72).
    registrations: Option<Arc<super::registrations::RegistrationSync>>,
    /// The seed-entity drift scan and what its last run found (CC-21, UI-25, UI-26).
    drift: Option<(Arc<super::drift::Watch>, Arc<super::drift::Store>)>,
    /// The daily data-quality run (DM-74); the leader starts it when it is due.
    quality: Option<Arc<crate::quality::Scanner>>,
    subscriptions: Option<Arc<super::subscriptions::SubscriptionSync>>,
    /// `None` when no Keycloak admin client is configured: the `Group` manifests are then read
    /// and served, and the realm is written by nobody (PF-63).
    groups: Option<Arc<GroupSync>>,
    /// The realm's people and the database of their pending removals (PF-93). `None` leaves a
    /// removal pending until a Portal with both runs.
    people: Option<(Arc<crate::people::People>, sqlx::PgPool)>,
    /// The Keycloak client of every published App (ADR-N-030, AP-111). `None` without an admin
    /// client or an apps host: the Apps are served, and nobody's client is written.
    app_clients: Option<Arc<super::app_clients::AppClientSync>>,
    /// The secret of every App whose client is in place, by App name, as the last run left it:
    /// what the edge file is composed with (AP-112). Never logged.
    app_client_secrets:
        Arc<RwLock<std::collections::BTreeMap<String, super::app_clients::ClientSecret>>>,
    /// The federated client of every ServiceAccount bound to a workload (PF-47). `None` without
    /// a login client: such an account then has no client, and its workload no identity.
    workload_clients: Option<Arc<super::workload_clients::WorkloadClientSync>>,
    /// The MCP hub client's `endpoint:{slug}` scopes (T-2490, EP-88).
    hub_scopes: Option<Arc<super::hub_scopes::HubScopeSync>>,
    /// The APISIX file the edge serves, composed from helm's base and every published App's
    /// routes (ADR-N-030, AP-112), with the settings that say where each App runs. `None`
    /// outside a cluster: the edge then serves helm's base alone.
    edge_file: Option<(
        Arc<super::edge_file::EdgeFile>,
        crate::apps::reconciler::Settings,
    )>,
    /// The certificate and edge Ingress of every published App's host (ADR-N-037, AP-133).
    /// `None` outside a cluster.
    app_hosts: Option<Arc<super::app_hosts::AppHosts>>,
    /// Where a run says what it did (OPS-48). `None` leaves the loop silent, which is what a
    /// Portal built without a state does in a unit test.
    activity: Option<ActivityStore>,
    /// Where this replica fetches the builds the manifests name (AP-102): the run fetches the
    /// missing ones and checks that each named build is actually there (AP-72).
    apps_cache_dir: Option<String>,
    /// The bundles this Portal's image ships (AP-87): a published App with no build of its own
    /// is served from here, and one with neither serves nothing (T-2989).
    apps_dir: Option<String>,
    /// The artifact store's admin API, held with the root credential. `None` leaves every
    /// organization without a scoped credential and the store untouched (PF-32).
    artifact_store: Option<Arc<crate::artifact_store::Client>>,
    /// Where an organization's reader credential is handed to the workloads that serve
    /// artifacts: the cluster to write the Secret into, and the namespace it belongs in
    /// (T-0925). `None` mints the credentials and hands them to nobody.
    credentials: Option<(Arc<crate::apps::kube::KubeClient>, String)>,
    /// Which secret backend answers a pipeline's `secretRef` (T-0927, PL-15). `None` leaves a
    /// pipeline that declares one undeployed, with the reason on the Pipeline.
    pipeline_secrets: Option<crate::pipeline_secrets::Resolver>,
    /// Where each pass leaves the resolved inbound secret of every webhook-driven `SyncSource`
    /// (MF-44, T-2297). `None` leaves the webhook route shut, which is what a Portal with no
    /// reconciler should answer.
    webhook_secrets: Option<Arc<crate::sync::webhook_secrets::Accepted>>,
    /// The open-data catalogue wave (EP-62, T-2405). `None` leaves an Endpoint's
    /// `spec.publish.ckan` a declaration nobody carries out, which is what a Portal with no
    /// gateway host configured can honestly do.
    ckan: Option<Arc<super::ckan::CkanSync>>,
    /// Whether each Organization owns the domain it declares (PF-41, T-2377). `None` without a
    /// database: a challenge that did not outlive a restart would fail every published record.
    domains:
        Option<Arc<crate::domain_verification::Verifier<crate::domain_verification::NetLookup>>>,
    /// Each pipeline's refused records and run log (PL-61, PL-62): a pipeline the repository no
    /// longer holds takes them with it. `None` keeps them, which a unit test's syncer does.
    /// What this replica's streams concluded, shared with the replicas that do not reconcile
    /// (T-2976). `None` without a database: a follower then says it does not know.
    pipeline_status: Option<Arc<crate::pipeline_status::Store>>,
    pipeline_outcomes: Option<(
        Arc<crate::pipeline_outcomes::RejectedStore>,
        Arc<crate::pipeline_log::LogStore>,
    )>,
    /// Each Live stream's written count and when it last moved, across syncs (T-2967).
    stalls: super::stall::StallWatch,
}

impl Syncer {
    pub fn new(gitea: Arc<GiteaClient>, mirror: Arc<Mirror>) -> Self {
        Self {
            gitea,
            mirror,
            status: Arc::new(RwLock::new(SyncStatus {
                leader: true,
                ..SyncStatus::default()
            })),
            running: Arc::new(Mutex::new(())),
            assembly: {
                static SYNCERS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
                let n = SYNCERS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                std::env::temp_dir().join(format!("jc-portal-assembly-{}-{n}", std::process::id()))
            },
            leadership: None,
            converger: None,
            streams: None,
            stalls: super::stall::StallWatch::default(),
            registrations: None,
            drift: None,
            quality: None,
            subscriptions: None,
            groups: None,
            people: None,
            app_clients: None,
            app_client_secrets: Arc::default(),
            workload_clients: None,
            hub_scopes: None,
            edge_file: None,
            app_hosts: None,
            activity: None,
            apps_cache_dir: None,
            apps_dir: None,
            artifact_store: None,
            credentials: None,
            pipeline_secrets: None,
            webhook_secrets: None,
            ckan: None,
            domains: None,
            pipeline_status: None,
            pipeline_outcomes: None,
        }
    }

    /// Makes each run record whether every Organization owns its declared domain (PF-41). The
    /// state is reported on the Organization; nothing here refuses a write.
    pub fn with_domain_verification(
        mut self,
        verifier: Arc<crate::domain_verification::Verifier<crate::domain_verification::NetLookup>>,
    ) -> Self {
        self.domains = Some(verifier);
        self
    }

    /// Makes each run mint the scoped artifact-store credentials of every Organization it reads
    /// (PF-32, ADR-N-015). Without one the store is never touched, which is what a Portal
    /// outside a cluster does.
    pub fn with_artifact_store(mut self, store: Arc<crate::artifact_store::Client>) -> Self {
        self.artifact_store = Some(store);
        self
    }

    /// Which backend resolves a pipeline's `secretRef`s into the runner's environment
    /// (T-0927, PL-15). Writing the Secret needs the cluster too: without
    /// [`with_credential_secrets`](Self::with_credential_secrets) the values resolve and reach
    /// nobody, so the pipelines that need them stay undeployed.
    pub fn with_pipeline_secrets(mut self, resolver: crate::pipeline_secrets::Resolver) -> Self {
        self.pipeline_secrets = Some(resolver);
        self
    }

    /// Where each pass leaves what the sync webhook route authorises a run against (MF-44).
    ///
    /// Every replica resolves them, leader or not: any replica can be the one an origin's hook
    /// reaches, and a follower that held none would answer `401` to a signature that is right.
    pub fn with_webhook_secrets(
        mut self,
        accepted: Arc<crate::sync::webhook_secrets::Accepted>,
    ) -> Self {
        self.webhook_secrets = Some(accepted);
        self
    }

    /// Makes each run hand every organization's reader credential to the workloads that serve
    /// its artifacts, as a Secret in `namespace` (T-0925, PF-32).
    ///
    /// Only the reader travels. The writer stays derived and unwritten: the one process that
    /// holds the root secret can mint it whenever `jcctl` or a build lane asks, and a key that
    /// can replace an artifact has no reason to sit in a namespace a serving pod reads.
    pub fn with_credential_secrets(
        mut self,
        kube: Arc<crate::apps::kube::KubeClient>,
        namespace: impl Into<String>,
    ) -> Self {
        self.credentials = Some((kube, namespace.into()));
        self
    }

    /// Where this replica keeps the builds it fetched, so each run fetches what the mirror
    /// names and says which app names a build that never arrived (AP-72, AP-102).
    pub fn with_apps_cache_dir(mut self, apps_cache_dir: Option<String>) -> Self {
        self.apps_cache_dir = apps_cache_dir;
        self
    }

    /// Where this Portal's image ships App bundles, so a published App with no build and no
    /// shipped bundle reads `Pending` instead of `Live` (AP-13a, T-2989).
    pub fn with_apps_dir(mut self, apps_dir: Option<String>) -> Self {
        self.apps_dir = apps_dir;
        self
    }

    /// Makes each run tell the activity feed what it applied (OPS-48, UI-31).
    pub fn with_activity(mut self, activity: ActivityStore) -> Self {
        self.activity = Some(activity);
        self
    }

    /// Forgets the refused records and the log of a pipeline once it is gone (PL-61, PL-62).
    pub fn with_pipeline_status(mut self, store: Arc<crate::pipeline_status::Store>) -> Self {
        self.pipeline_status = Some(store);
        self
    }

    pub fn with_pipeline_outcomes(
        mut self,
        rejected: Arc<crate::pipeline_outcomes::RejectedStore>,
        log: Arc<crate::pipeline_log::LogStore>,
    ) -> Self {
        self.pipeline_outcomes = Some((rejected, log));
        self
    }

    /// Deploys Bento streams for approved DataSource pipelines on each run (PL-47).
    /// Makes each run bring the realm's managed groups to what the manifests say (PF-63).
    pub fn with_groups(mut self, groups: Arc<GroupSync>) -> Self {
        self.groups = Some(groups);
        self
    }

    /// Makes each run delete the people whose removal Change has been merged (PF-93).
    pub fn with_people(mut self, people: Arc<crate::people::People>, pool: sqlx::PgPool) -> Self {
        self.people = Some((people, pool));
        self
    }

    /// Makes each run bring every published App's Keycloak client to what the App says (AP-111).
    pub fn with_app_clients(mut self, clients: Arc<super::app_clients::AppClientSync>) -> Self {
        self.app_clients = Some(clients);
        self
    }

    /// Makes each run bring every workload-bound ServiceAccount's client to its manifest (PF-47).
    /// Renders the MCP hub client's `endpoint:{slug}` scopes each run (T-2490).
    pub fn with_hub_scopes(mut self, scopes: Arc<super::hub_scopes::HubScopeSync>) -> Self {
        self.hub_scopes = Some(scopes);
        self
    }

    pub fn with_workload_clients(
        mut self,
        clients: Arc<super::workload_clients::WorkloadClientSync>,
    ) -> Self {
        self.workload_clients = Some(clients);
        self
    }

    /// Makes each run write the edge's APISIX file with every published App's routes (AP-112).
    pub fn with_edge_file(
        mut self,
        edge_file: Arc<super::edge_file::EdgeFile>,
        settings: crate::apps::reconciler::Settings,
    ) -> Self {
        self.edge_file = Some((edge_file, settings));
        self
    }

    /// Makes each run give every published App's host its certificate and Ingress (AP-133).
    pub fn with_app_hosts(mut self, hosts: Arc<super::app_hosts::AppHosts>) -> Self {
        self.app_hosts = Some(hosts);
        self
    }

    /// The App client secrets the last run read back, by App name (AP-112).
    pub fn app_client_secrets(
        &self,
    ) -> Arc<RwLock<std::collections::BTreeMap<String, super::app_clients::ClientSecret>>> {
        Arc::clone(&self.app_client_secrets)
    }

    pub fn with_streams(mut self, deployer: Arc<StreamDeployer>) -> Self {
        self.streams = Some(deployer);
        self
    }

    /// Makes each run write what every `Subscription` manifest declares into its space, and
    /// remove the subscription of a manifest that is gone (CC-72, DS-16).
    /// The broker projection of `ContextSourceRegistration` manifests (T-0345, PF-48).
    pub fn with_registrations(
        mut self,
        registrations: Arc<super::registrations::RegistrationSync>,
    ) -> Self {
        self.registrations = Some(registrations);
        self
    }

    pub fn with_subscriptions(
        mut self,
        subscriptions: Arc<super::subscriptions::SubscriptionSync>,
    ) -> Self {
        self.subscriptions = Some(subscriptions);
        self
    }

    /// Makes each run publish every Endpoint that declares `spec.publish.ckan` to its catalogue,
    /// and withdraw the dataset of one that stopped declaring it (EP-62, CC-19).
    pub fn with_ckan(mut self, ckan: Arc<super::ckan::CkanSync>) -> Self {
        self.ckan = Some(ckan);
        self
    }

    /// Makes each run compare the seed entities the repository declares against what the
    /// spaces hold, and keep the answer where the API reads it (CC-21).
    pub fn with_quality(mut self, scanner: Arc<crate::quality::Scanner>) -> Self {
        self.quality = Some(scanner);
        self
    }

    pub fn with_drift(
        mut self,
        watch: Arc<super::drift::Watch>,
        store: Arc<super::drift::Store>,
    ) -> Self {
        self.drift = Some((watch, store));
        self
    }

    /// Makes this replica compete for the reconciler role instead of assuming it (CC-03).
    pub fn with_leadership(mut self, leadership: Arc<Leadership>) -> Self {
        self.status
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .leader = leadership.is_leader();
        self.leadership = Some(leadership);
        self
    }

    /// Applies every App's Kubernetes objects on each run (T-0411).
    ///
    /// A Portal without one reads apps and deploys nothing, which is what running outside a
    /// cluster looks like.
    pub fn with_converger(mut self, converger: Arc<Converger>) -> Self {
        self.converger = Some(converger);
        self
    }

    /// Whether this replica currently reconciles.
    pub fn is_leader(&self) -> bool {
        self.leadership.as_ref().is_none_or(|l| l.is_leader())
    }

    pub fn status(&self) -> SyncStatus {
        self.status
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    /// Synchronizes the mirror once against the Git repository.
    ///
    /// A run that finds another run of this replica in flight waits for it and then runs
    /// itself: a merge that lands while a sync is fetching is not in that sync, and the
    /// approval that asked for the refresh must not wait a whole tick for it (CC-08).
    /// A replica that is not the leader (CC-03) loads the mirror and converges nothing: its
    /// streams, apps and roles are the leader's to apply (OPS-51).
    pub async fn sync_once(&self) -> Result<usize, SyncError> {
        let _guard = self.running.lock().await;

        let leader = self.claim_leadership().await;
        if !leader {
            tracing::debug!("another replica holds the reconciler lock, loading the mirror only");
        }

        let before = self.status();
        match self.do_sync(leader).await {
            Ok((count, revision)) => {
                let landed = before.revision.as_deref() != Some(revision.as_str());
                {
                    let now = crate::auth::session::now_unix();
                    let mut status = self.status.write().unwrap_or_else(|p| p.into_inner());
                    status.last_sync = Some(now);
                    status.revision = Some(revision.clone());
                    status.manifests = count;
                    status.last_error = None;
                    status.leader = leader;
                }
                // Only a revision the mirror had not seen is news: the loop runs every tick and
                // a feed of "nothing changed" is a feed nobody reads.
                if landed {
                    self.say_applied(&revision, count).await;
                }
                Ok(count)
            }
            Err(err) => {
                let message = err.to_string();
                let repeated = before.last_error.as_deref() == Some(message.as_str());
                self.status
                    .write()
                    .unwrap_or_else(|p| p.into_inner())
                    .last_error = Some(message.clone());
                if !repeated {
                    self.say_drifted(&message).await;
                }
                Err(err)
            }
        }
    }

    /// One `config.applied` per project the mirror holds, because a project's feed shows the
    /// runs that touched it and a run touches the whole repository at once.
    async fn say_applied(&self, revision: &str, manifests: usize) {
        if self.activity.is_none() {
            return;
        }
        let short: String = revision.chars().take(7).collect();
        let events: Vec<ActivityEvent> = self
            .mirror
            .namespaces()
            .into_iter()
            .map(|project| ActivityEvent {
                time: chrono::Utc::now(),
                project,
                space: None,
                kind: "config.applied".to_string(),
                source: "reconciler".to_string(),
                summary: format!("The repository at {short} is live: {manifests} manifests."),
                severity: "info".to_string(),
                correlation_id: Some(revision.to_string()),
                details: serde_json::json!({ "revision": revision, "manifests": manifests }),
            })
            .collect();
        self.record(events).await;
    }

    /// A run that could not load the repository: the mirror keeps the last revision that did,
    /// so the feed is the only place this is visible to a person (CC-08).
    async fn say_drifted(&self, message: &str) {
        if self.activity.is_none() {
            return;
        }
        let events: Vec<ActivityEvent> = self
            .mirror
            .namespaces()
            .into_iter()
            .map(|project| ActivityEvent {
                time: chrono::Utc::now(),
                project,
                space: None,
                kind: "config.drifted".to_string(),
                source: "reconciler".to_string(),
                summary: format!("The repository did not load: {message}"),
                severity: "error".to_string(),
                correlation_id: None,
                details: serde_json::Value::Null,
            })
            .collect();
        self.record(events).await;
    }

    /// One `config.drifted` per group the console and the repository disagreed on, so the feed
    /// carries what the reconcile overwrote (PF-63, OPS-48).
    async fn say_group_drift(&self, outcomes: &[super::groups::GroupOutcome]) {
        if self.activity.is_none() {
            return;
        }
        let events: Vec<ActivityEvent> = outcomes
            .iter()
            .filter(|outcome| !outcome.drift.is_empty() || outcome.error.is_some())
            .map(|outcome| ActivityEvent {
                time: chrono::Utc::now(),
                project: crate::permissions::ORG_NAMESPACE.to_string(),
                space: None,
                kind: "config.drifted".to_string(),
                source: "reconciler".to_string(),
                summary: match &outcome.error {
                    Some(err) => format!("Group {}: {err}", outcome.name),
                    None => format!("Group {}: {}", outcome.name, outcome.drift.join("; ")),
                },
                severity: if outcome.error.is_some() {
                    "error".to_string()
                } else {
                    "warning".to_string()
                },
                correlation_id: None,
                details: serde_json::json!({ "group": outcome.name, "drift": outcome.drift }),
            })
            .collect();
        self.record(events).await;
    }

    /// One `catalogue.published` per dataset a run wrote or withdrew, and an `error` for every
    /// Endpoint whose publication did not happen (OPS-48, EP-62).
    ///
    /// A publication that changed nothing is not an event: a feed that says "unchanged" once a
    /// minute per dataset is a feed nobody reads.
    async fn say_published(&self, reports: &[super::ckan::Report]) {
        use super::ckan::Publication;
        if self.activity.is_none() {
            return;
        }
        let events: Vec<ActivityEvent> = reports
            .iter()
            .filter_map(|report| {
                let (summary, severity, details) = match &report.publication {
                    Publication::Published {
                        dataset,
                        outcome,
                        rows,
                    } => {
                        if matches!(
                            outcome,
                            jcctl::publish::ckan::Outcome::Unchanged
                                | jcctl::publish::ckan::Outcome::NotPublished
                        ) {
                            return None;
                        }
                        let rows = match rows {
                            Some(count) => format!(", sheet of {count} rows"),
                            None => String::new(),
                        };
                        (
                            format!("Endpoint {} is dataset {dataset}{rows}.", report.endpoint),
                            "info",
                            serde_json::json!({ "dataset": dataset, "rows": rows }),
                        )
                    }
                    Publication::Withdrawn { dataset } => (
                        format!(
                            "Endpoint {} no longer publishes: dataset {dataset} is withdrawn.",
                            report.endpoint
                        ),
                        "info",
                        serde_json::json!({ "dataset": dataset, "withdrawn": true }),
                    ),
                    // The reason is the publisher's own sentence, which names the reference, the
                    // catalogue or the status and never a credential (EP-67).
                    Publication::Failed(reason) => (
                        format!("Endpoint {} was not published: {reason}", report.endpoint),
                        "error",
                        serde_json::json!({ "reason": reason }),
                    ),
                };
                Some(ActivityEvent {
                    time: chrono::Utc::now(),
                    project: report.project.clone(),
                    space: None,
                    kind: "catalogue.published".to_string(),
                    source: "ckan".to_string(),
                    summary,
                    severity: severity.to_string(),
                    correlation_id: None,
                    details,
                })
            })
            .collect();
        self.record(events).await;
    }

    async fn record(&self, events: Vec<ActivityEvent>) {
        let Some(activity) = self.activity.as_ref() else {
            return;
        };
        if events.is_empty() {
            return;
        }
        if let Err(err) = activity.append(&events).await {
            tracing::warn!(error = %err, "the run is not in the activity feed");
        }
    }

    /// Whether this replica may reconcile now, asking the database every time (T-0191).
    ///
    /// A database that cannot be reached demotes this replica rather than promoting it: two
    /// leaders are worse than none, because none only delays a mirror refresh.
    async fn claim_leadership(&self) -> bool {
        let Some(leadership) = self.leadership.as_ref() else {
            return true;
        };
        match leadership.acquire().await {
            Ok(leader) => {
                self.status
                    .write()
                    .unwrap_or_else(|p| p.into_inner())
                    .leader = leader;
                leader
            }
            Err(err) => {
                tracing::warn!(error = %err, "cannot reach the database to elect a reconciler");
                self.status
                    .write()
                    .unwrap_or_else(|p| p.into_inner())
                    .leader = false;
                false
            }
        }
    }

    /// Whether this replica's mirror holds the repository: a sync of its own succeeded once
    /// (OPS-51). A later failed run keeps the last revision that loaded, so it stays ready.
    pub fn is_ready(&self) -> bool {
        self.status().last_sync.is_some()
    }

    /// The render of the staged organization: itself in layout 1; in layout 2 every registered
    /// project staged from its own repository at its entry's `spec.ref` and assembled with it
    /// (CC-86). A project that does not stage keeps the render the last assembly gave it, and
    /// the rest of the organization renders.
    async fn render(&self, org: Scratch) -> Result<(Render, Repository), SyncError> {
        use jc_core::project::RepositoryRole;
        use jcctl::assemble::{assemble, layout_at, read_registry, Directories};
        if layout_at(org.path(), RepositoryRole::Organization)? == 1 {
            let repository = Repository::load(org.path())?;
            return Ok((
                Render {
                    layout: 1,
                    root: org.path().to_path_buf(),
                    _staged: vec![org],
                    projects: BTreeMap::new(),
                    unstaged: Vec::new(),
                },
                repository,
            ));
        }
        let mut staged = Vec::new();
        let mut directories = BTreeMap::new();
        let mut projects = BTreeMap::new();
        let mut unstaged = Vec::new();
        for (slug, entry) in read_registry(org.path())? {
            let git_ref = entry.spec.git_ref.clone().unwrap_or_default();
            let Some(name) = entry.spec.repository.and_then(|repository| repository.name) else {
                // ponytail: a repository outside the forge (CC-89) is fetched with git by the
                // checkouts sidecar; the Portal reads the forge API, so it keeps the last render.
                tracing::warn!(project = %slug, "a repository outside the forge is not read by the Portal yet");
                continue;
            };
            let client = self.gitea.for_repository(name);
            match stage_project(&client, &git_ref).await {
                Ok(scratch) => {
                    directories.insert(slug.clone(), scratch.path().to_path_buf());
                    staged.push(scratch);
                }
                Err(error) => {
                    tracing::warn!(project = %slug, %git_ref, %error, "the project's repository did not stage; its last render stays");
                    unstaged.push(slug.clone());
                }
            }
            projects.insert(slug, (client, git_ref));
        }
        let into = self.assembly.clone();
        let environment = std::env::var("JC_ENVIRONMENT")
            .ok()
            .filter(|value| !value.trim().is_empty());
        let assembly = assemble(
            org.path(),
            &Directories(directories),
            &into,
            environment.as_deref(),
        )?;
        for finding in &assembly.findings {
            tracing::warn!(project = %finding.slug, path = %finding.path.display(), message = %finding.message, "a project repository's finding");
        }
        staged.push(org);
        Ok((
            Render {
                layout: 2,
                root: into,
                _staged: staged,
                projects,
                unstaged,
            },
            assembly.repository,
        ))
    }

    async fn do_sync(&self, leader: bool) -> Result<(usize, String), SyncError> {
        // 1. Resolve default branch and its commit revision
        let default_branch = self.gitea.default_branch().await?;
        let revision = self.gitea.branch_head(&default_branch).await?;

        // 2, 3. The repository as files on disk, this run's own; in layout 2 the organization
        //       with every registered project mounted at `projects/{slug}/` (CC-86).
        // 4. Load and validate the whole repository the way `jcctl plan` does (CC-08, MF-05).
        let (scratch, repository) = self.render(stage(&self.gitea, &revision).await?).await?;
        for (id, path, expected) in repository.misplaced() {
            tracing::warn!(resource = %id, path = %path.display(), %expected, "manifest is not at the path its kind declares");
        }

        // 4b. The author's mapping beside a Pipeline manifest (PL-03): the loader leaves
        //     `bento.yaml` alone, so the streams read it from the staged tree by name.
        let mut bentos = Bentos::new();
        for (id, resource) in repository.iter() {
            if id.kind != "Pipeline" {
                continue;
            }
            let beside = scratch
                .path()
                .join(&resource.path)
                .with_file_name("bento.yaml");
            if let Ok(text) = std::fs::read_to_string(&beside) {
                let namespace = id
                    .namespace
                    .clone()
                    .unwrap_or_else(|| namespace_of(&resource.path.to_string_lossy()));
                bentos.insert((namespace, id.name.clone()), text);
            }
        }

        // 5. Compile the live status of every resource and swap the mirror in one step, so a
        //    reader never sees a half-built repository (MF-04).
        // The conditions this run starts from, so one that says the same again keeps its time.
        let transitions = super::transitions::Transitions::of(&self.mirror);
        let fresh_mirror = Mirror::new();
        fresh_mirror.set_layout(scratch.layout);
        fresh_mirror.set_repositories(
            scratch
                .projects
                .iter()
                .map(|(slug, (client, _))| (slug.clone(), client.repo.clone()))
                .collect(),
        );
        let mut loaded = 0usize;
        for (_, resource) in repository.iter() {
            let path = resource.path.to_string_lossy().to_string();
            // The kind's own invariants, the check `jcctl validate` runs (T-0412). A manifest
            // that reached `main` before the Portal refused them at write time is still shown,
            // with the reason in the log, so an operator can fix it rather than lose it.
            if let Ok(yaml) = serde_json::to_string(&resource.manifest) {
                if let Some(Err(err)) =
                    jc_core::registry::validate_yaml(&resource.manifest.kind, &yaml)
                {
                    tracing::warn!(path = %path, error = %err, "manifest fails its kind's validation");
                }
            }
            let mut envelope: ResourceEnvelope = match serde_json::to_value(&resource.manifest)
                .and_then(serde_json::from_value)
            {
                Ok(envelope) => envelope,
                Err(err) => {
                    // The loader accepted the envelope, so this is a metadata member the
                    // Portal's own view does not know. Skipping one resource is right
                    // here: the manifest is valid, the Portal simply cannot show it.
                    tracing::warn!(path = %path, error = %err, "manifest does not fit the Portal's resource view");
                    continue;
                }
            };

            if envelope
                .metadata
                .namespace
                .as_deref()
                .unwrap_or("")
                .is_empty()
            {
                envelope.metadata.namespace = Some(namespace_of(&path));
            }

            // The one part of `status` the repository owns: what the build lane wrote back
            // when it published the artifact (AP-13a). The rest is computed here (MF-04).
            let build = envelope
                .status
                .as_ref()
                .and_then(|status| status.build.clone());
            envelope.strip_status();
            envelope.status = Some(crate::resource::Status {
                phase: crate::resource::Phase::Live,
                observed_revision: Some(revision.clone()),
                // The branch, not the revision: a Source link should keep working after the
                // next commit, and the observed revision is right there beside it.
                source_url: Some(scratch.browse_url(&self.gitea, &path, &default_branch)),
                conditions: Vec::new(),
                build,
                domain_verification: None,
            });

            fresh_mirror.upsert(envelope);
            loaded += 1;
        }

        if loaded == 0 {
            return Err(SyncError::Empty(
                "no resource of a known kind in the staged manifests".to_string(),
            ));
        }

        // 5a. What the sync webhook route authorises a run against (MF-44, T-2297). Before the
        //     follower's early return: any replica can be the one an origin's hook reaches, and
        //     a follower holding none would refuse a signature that is right.
        self.resolve_webhook_secrets(&fresh_mirror, scratch.path())
            .await;

        // 5b. Every replica serves `/apps/*` from its own disk, so each one fetches the builds
        //     the new mirror names before anything is leader-only (AP-102).
        if let Some(cache) = self.apps_cache_dir.as_deref() {
            crate::apps::fetch::fetch_missing(&self.gitea, Path::new(cache), &fresh_mirror).await;
        }

        // A follower stops here: what the runner accepted, what the cluster runs and what the
        //    forge enforces are the leader's to converge, so its stream pipelines say so.
        if !leader {
            let saved = match self.pipeline_status.as_ref() {
                Some(store) => store
                    .load(crate::pipeline_status::FRESH)
                    .await
                    .unwrap_or_else(|err| {
                        tracing::warn!(error = %err, "the leader's pipeline phases could not be read");
                        HashMap::new()
                    }),
                None => HashMap::new(),
            };
            serve_leaders_phases(&fresh_mirror, &saved);
            transitions.keep_all(&fresh_mirror);
            self.mirror.replace_all(&fresh_mirror);
            return Ok((loaded, revision));
        }

        // 5a''. A project whose registry entry is gone was deleted (PF-77): its repository is
        //       archived, read-only with its history, never removed. The entry is what the
        //       reviewed Change took away, so nothing else can make a repository go.
        //       ponytail: compares with the last sync of this process; a deletion merged while
        //       the Portal was down leaves its repository open until an operator archives it.
        let registered = fresh_mirror.repositories();
        for (slug, repository) in self.mirror.repositories() {
            if registered.contains_key(&slug) || registered.values().any(|r| *r == repository) {
                continue;
            }
            match self
                .gitea
                .for_repository(repository.as_str())
                .archive_repository()
                .await
            {
                Ok(()) => {
                    tracing::info!(project = %slug, %repository, "a deleted project's repository is archived")
                }
                Err(error) => {
                    tracing::warn!(project = %slug, %repository, %error, "a deleted project's repository did not archive")
                }
            }
        }

        // 5a'. Resolve what every pipeline's `secretRef`s name and hand the values to the
        //      runner as one Secret (T-0927, PL-15). A pipeline whose reference does not
        //      resolve, or whose `envVar` another pipeline already claims, is named here and
        //      refused by the wave below rather than started without its credential.
        let refused = self
            .resolve_pipeline_secrets(&fresh_mirror, scratch.path())
            .await;

        // 5a*. A pipeline the repository no longer holds takes its refused records and its log
        //      with it (PL-61, PL-62); a paused one is still in the repository and keeps them.
        //      Only the leader, only after a sync that loaded, and only in a project this sync
        //      read: a project whose repository did not stage holds nothing in the mirror.
        //      ponytail: a deleted project's rows stay (it holds nothing to compare against);
        //      drop them with the project's archive when PF-77 grows a data purge.
        if let Some((rejected, log)) = self.pipeline_outcomes.as_ref() {
            let mut loaded: std::collections::BTreeMap<String, std::collections::HashSet<String>> =
                Default::default();
            for envelope in fresh_mirror.matching(|_| true) {
                let Some(project) = envelope.metadata.namespace else {
                    continue;
                };
                let names = loaded.entry(project).or_default();
                if envelope.kind == "Pipeline" {
                    names.insert(envelope.metadata.name);
                }
            }
            if let Err(error) = rejected.forget_gone(&loaded).await {
                tracing::warn!(%error, "the refused records of deleted pipelines were not dropped");
            }
            if let Err(error) = log.forget_gone(&loaded).await {
                tracing::warn!(%error, "the run logs of deleted pipelines were not dropped");
            }
        }

        // 5b'. What every `Subscription` manifest declares, written into the space it names
        //      (T-0931, CC-72). The broker holds the effect, so the status of each manifest is
        //      where a person sees whether the declaration arrived.
        if let Some(subscriptions) = self.subscriptions.as_ref() {
            let outcomes = subscriptions
                .converge(
                    &fresh_mirror,
                    &self.mirror,
                    scratch.path(),
                    self.pipeline_secrets.as_ref(),
                )
                .await;
            for (namespace, name, outcome) in outcomes {
                let Some(mut envelope) = fresh_mirror.get(&namespace, "Subscription", &name) else {
                    continue;
                };
                if let Some(status) = envelope.status.as_mut() {
                    match &outcome {
                        SubscriptionOutcome::Written => {
                            status.phase = crate::resource::Phase::Live;
                            status.conditions = Vec::new();
                        }
                        SubscriptionOutcome::Error(reason) => {
                            status.phase = crate::resource::Phase::Error;
                            status.conditions = vec![make_condition(
                                "SubscriptionWritten",
                                "False",
                                "SpaceRefused",
                                reason,
                            )];
                        }
                    }
                }
                fresh_mirror.upsert(envelope);
            }
        }

        // 5b''. Every `ContextSourceRegistration`, written into the tenant of the hub space it
        //       names (T-0345, PF-48). A hub is a configuration, so the manifest's status is
        //       where a person sees whether the member was actually registered.
        if let Some(registrations) = self.registrations.as_ref() {
            let outcomes = registrations.converge(&fresh_mirror, &self.mirror).await;
            for (namespace, name, outcome) in outcomes {
                let Some(mut envelope) =
                    fresh_mirror.get(&namespace, "ContextSourceRegistration", &name)
                else {
                    continue;
                };
                if let Some(status) = envelope.status.as_mut() {
                    match &outcome {
                        RegistrationOutcome::Written => {
                            status.phase = crate::resource::Phase::Live;
                            status.conditions = Vec::new();
                        }
                        RegistrationOutcome::Error(reason) => {
                            status.phase = crate::resource::Phase::Error;
                            status.conditions = vec![make_condition(
                                "RegistrationWritten",
                                "False",
                                "BrokerRefused",
                                reason,
                            )];
                        }
                    }
                }
                fresh_mirror.upsert(envelope);
            }
        }

        // 5c. The realm's managed groups, brought to what `users/groups/` says (PF-63). The
        //     drift lands on the Group manifests of this run's mirror, so the Access page shows
        //     where the console and the repository disagreed.
        //     Beside them, each registered project's `{slug}-readers` and `{slug}-writers`,
        //     filled from its bindings, which the forge maps onto the teams of 5c* (PF-87).
        let projects = fresh_mirror.repositories();
        if let Some(groups) = self.groups.as_ref() {
            let now = chrono::Utc::now();
            let generated: Vec<(String, std::collections::BTreeSet<String>)> = projects
                .keys()
                .flat_map(|slug| {
                    let members = crate::permissions::project_members(&fresh_mirror, slug, now);
                    let [(readers, _), (writers, _)] = super::project_teams::teams_of(slug);
                    [(readers, members.readers), (writers, members.writers)]
                })
                .collect();
            let outcomes = groups.converge_with(&fresh_mirror, &generated).await;
            for outcome in &outcomes {
                match (&outcome.error, outcome.drift.is_empty()) {
                    (Some(err), _) => {
                        tracing::warn!(group = %outcome.name, error = %err, "group did not converge")
                    }
                    (None, false) => {
                        tracing::info!(group = %outcome.name, drift = %outcome.drift.join("; "), "group brought back to the manifest")
                    }
                    (None, true) => {}
                }
                for warning in &outcome.warnings {
                    tracing::warn!(group = %outcome.name, %warning, "group member is not a realm user yet");
                }
            }
            super::groups::record(&fresh_mirror, &outcomes);
            self.say_group_drift(&outcomes).await;
        }

        // 5c*. The forge teams those groups map onto: two per project of layout 2, each
        //      reaching its project's repository alone; a gone project's teams go (PF-87).
        if fresh_mirror.layout() == 2 {
            for outcome in super::project_teams::converge(&self.gitea, &projects).await {
                match (&outcome.error, outcome.changes.is_empty()) {
                    (Some(error), _) => {
                        tracing::warn!(team = %outcome.team, %error, "project team did not converge")
                    }
                    (None, false) => {
                        tracing::info!(team = %outcome.team, changes = %outcome.changes.join("; "), "project team brought to its project")
                    }
                    (None, true) => {}
                }
            }
        }

        // 5c'. People whose removal Change has been decided (PF-93): merged, the Keycloak user
        //      goes; closed unmerged, the pending removal is dropped and the person stays
        //      disabled for an administrator to enable.
        if let Some((people, pool)) = self.people.as_ref() {
            crate::api::people::finish_deletions(people, pool, &self.gitea).await;
        }

        // 5d. Every published App's own Keycloak client (ADR-N-030, AP-111). The secrets it reads
        //     back replace the last run's, so a retired App's secret is gone with its client.
        if let Some(clients) = self.app_clients.as_ref() {
            let run = clients.converge(&fresh_mirror).await;
            super::app_clients::record(&fresh_mirror, &run.outcomes);
            for outcome in &run.outcomes {
                match (&outcome.error, outcome.drift.is_empty()) {
                    (Some(err), _) => {
                        tracing::warn!(app = %outcome.app, error = %err, "app client did not converge")
                    }
                    (None, false) => {
                        tracing::info!(app = %outcome.app, drift = %outcome.drift.join("; "), "app client brought back to the App")
                    }
                    (None, true) => {}
                }
                for warning in &outcome.warnings {
                    tracing::info!(app = %outcome.app, warning = %warning, "app role waits for the realm");
                }
            }
            // A run that failed as a whole (no token, no list) keeps the last secrets, so a
            // realm that is down for a minute does not take every App off the edge.
            if !run
                .outcomes
                .iter()
                .any(|o| o.app == "*" && o.error.is_some())
            {
                *self
                    .app_client_secrets
                    .write()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = run.secrets;
            }
        }

        // 5d'. The federated client of every ServiceAccount bound to a workload (PF-47). Nothing
        //      is read back: no secret opens such a client.
        if let Some(clients) = self.workload_clients.as_ref() {
            for outcome in clients.converge(&fresh_mirror).await {
                match (&outcome.error, outcome.drift.is_empty()) {
                    (Some(err), _) => {
                        tracing::warn!(account = %outcome.app, error = %err, "workload client did not converge")
                    }
                    (None, false) => {
                        tracing::info!(account = %outcome.app, drift = %outcome.drift.join("; "), "workload client brought back to the account")
                    }
                    (None, true) => {}
                }
            }
        }

        // 5d''. One `endpoint:{slug}` scope on the MCP hub's client per Endpoint that serves MCP
        //       (T-2490, EP-88): the connect-time allow-list a hub token carries.
        if let Some(scopes) = self.hub_scopes.as_ref() {
            for outcome in scopes.converge(&fresh_mirror).await {
                if let Some(err) = &outcome.error {
                    tracing::warn!(scope = %outcome.app, error = %err, "hub scope did not converge");
                } else if !outcome.drift.is_empty() {
                    tracing::info!(scope = %outcome.app, drift = %outcome.drift.join("; "), "hub scope brought back to its Endpoint");
                }
                for warning in &outcome.warnings {
                    tracing::info!(scope = %outcome.app, warning = %warning, "hub scopes wait for the realm");
                }
            }
        }

        // 5e. The file the edge serves: helm's base with the routes of every App whose client
        //     the step above has in place (ADR-N-030, AP-112). A failure leaves APISIX serving
        //     the last file it read.
        if let Some((edge_file, settings)) = self.edge_file.as_ref() {
            let secrets = self
                .app_client_secrets
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            let (apps, mut skipped) =
                super::edge_file::edge_apps(&fresh_mirror, &secrets, settings);
            let limits = crate::api::organization_limits::limits_in(&fresh_mirror);
            let (outcome, refused) = edge_file.converge(&apps, limits.as_ref()).await;
            skipped.extend(refused);
            for (app, reason) in &skipped {
                tracing::warn!(%app, %reason, "published App has no route at the edge");
            }
            match outcome {
                super::edge_file::EdgeOutcome::Written { apps } => {
                    tracing::info!(apps, "edge file written")
                }
                super::edge_file::EdgeOutcome::Unchanged { .. } => {}
                super::edge_file::EdgeOutcome::Failed(reason) => {
                    tracing::warn!(%reason, "edge file not written")
                }
            }
        }

        // 5b. Deploy resident streams for eligible DataSource pipelines (PL-47), each with the
        //     validation stage of its space's model at the version the space pins now (PL-60).
        //     After the App clients and the edge file: a runner that cannot restart a stream
        //     answers a PUT only at the timeout, and the edge's routes and protections must not
        //     wait for that (T-2891).
        if let Some(deployer) = self.streams.as_ref() {
            if let Some(schemas) = deployer.model_schemas() {
                schemas.replace(crate::pipeline_validation::load(
                    &repository,
                    scratch.path(),
                ));
            }
            let outcomes = deployer.converge(&fresh_mirror, &bentos, &refused).await;
            // A Live stream that reads nothing is the failure nobody sees: the runner keeps the
            // stream, the Portal says Live, and the counters are the only witness (T-0914). One
            // scrape per project with a Live stream, read for each of them.
            let mut counters: BTreeMap<String, Option<String>> = BTreeMap::new();
            for (ns, _, outcome) in &outcomes {
                if matches!(outcome, StreamOutcome::Live) && !counters.contains_key(ns) {
                    counters.insert(ns.clone(), deployer.metrics(ns).await);
                }
            }
            // The streams Live this run; a paused or deleted one is forgotten by the stall watch.
            let live: std::collections::BTreeSet<(String, String)> = outcomes
                .iter()
                .filter(|(_, _, outcome)| matches!(outcome, StreamOutcome::Live))
                .map(|(ns, name, _)| (ns.clone(), name.clone()))
                .collect();
            let now = std::time::Instant::now();
            for (ns, name, outcome) in outcomes {
                // A sweep that did not deploy is said on its pipeline, beside the pipeline's own
                // outcome; the pipeline keeps writing (PL-64). The sweeps come last, so the
                // pipeline's own outcome has already set its conditions.
                if let Some(pipeline) = name.strip_suffix(".expiry") {
                    if let (StreamOutcome::Error(err), Some(mut envelope)) =
                        (outcome, fresh_mirror.get(&ns, "Pipeline", pipeline))
                    {
                        if let Some(status) = envelope.status.as_mut() {
                            status.conditions.push(make_condition(
                                "ExpirySweep",
                                "False",
                                "RunnerRefused",
                                &err,
                            ));
                        }
                        fresh_mirror.upsert(envelope);
                    }
                    continue;
                }
                let Some(mut envelope) = fresh_mirror.get(&ns, "Pipeline", &name) else {
                    continue;
                };
                let is_stream = serde_json::from_value::<jc_core::kinds::pipeline::PipelineSpec>(
                    envelope.spec.clone(),
                )
                .map(|s| is_stream_pipeline(&s))
                .unwrap_or(false);

                match outcome {
                    StreamOutcome::Live => {
                        // Errors and nothing ever sent, else records in and nothing out for the
                        // stall window (T-2967); an unreachable runner changes neither.
                        let verdict = writing_verdict(
                            &self.stalls,
                            (&ns, &name),
                            counters.get(&ns).and_then(Option::as_deref),
                            bentos.get(&(ns.clone(), name.clone())).map(String::as_str),
                            now,
                        );
                        if let Some(status) = envelope.status.as_mut() {
                            status.phase = crate::resource::Phase::Live;
                            status.conditions = match verdict {
                                Some((reason, said)) => {
                                    vec![make_condition("StreamWriting", "False", reason, &said)]
                                }
                                None => Vec::new(),
                            };
                        }
                        fresh_mirror.upsert(envelope);
                    }
                    StreamOutcome::Error(err) => {
                        if let Some(status) = envelope.status.as_mut() {
                            status.phase = crate::resource::Phase::Error;
                            status.conditions = vec![make_condition(
                                "StreamDeployed",
                                "False",
                                "RunnerRefused",
                                &err,
                            )];
                        }
                        fresh_mirror.upsert(envelope);
                    }
                    StreamOutcome::Skipped(why) => {
                        if is_stream {
                            if let Some(status) = envelope.status.as_mut() {
                                status.phase = crate::resource::Phase::Pending;
                                let reason = if why.contains("quota") {
                                    "QuotaExceeded"
                                } else if why.contains("disabled") || why.contains("paused") {
                                    "Paused"
                                } else {
                                    "Skipped"
                                };
                                status.conditions =
                                    vec![make_condition("StreamDeployed", "False", reason, why)];
                            }
                            fresh_mirror.upsert(envelope);
                        }
                    }
                }
            }
            self.stalls.retain(&live);
        } else {
            mark_streams_pending(
                &fresh_mirror,
                "NoRunner",
                "no pipeline runner is configured (JC_PORTAL_PIPELINE_RUNNER_URL)",
            );
        }

        // A pipeline whose credential did not resolve says so last, over whatever the wave
        // above wrote: it is stopped whether or not this Portal has a runner to deploy to, and
        // the missing reference is the reason the author can act on (T-0927, PL-15). The
        // condition names the reference, never the value.
        for ((namespace, name), reason) in &refused {
            let Some(mut envelope) = fresh_mirror.get(namespace, "Pipeline", name) else {
                continue;
            };
            if let Some(status) = envelope.status.as_mut() {
                status.phase = crate::resource::Phase::Error;
                status.conditions = vec![make_condition(
                    "StreamDeployed",
                    "False",
                    "SecretUnresolved",
                    reason,
                )];
            }
            fresh_mirror.upsert(envelope);
        }

        // What this run concluded about every stream pipeline, for the replicas that serve
        // without reconciling (T-2976). Best effort: a follower that cannot read it says so.
        if let Some(store) = self.pipeline_status.as_ref() {
            if let Err(err) = store.save(&stream_phases(&fresh_mirror)).await {
                tracing::warn!(error = %err, "the pipeline phases were not shared with the other replicas");
            }
        }

        // 5f. The open-data catalogue of every project (EP-62…EP-67, T-2405). Before the mirror
        //     is swapped on purpose: a dataset is withdrawn only when the Endpoint that declared
        //     it was there a run ago, and `self.mirror` is still that run.
        if let Some(catalogue) = self.ckan.as_ref() {
            let reports = catalogue
                .converge(&repository, &self.mirror, scratch.path())
                .await;
            self.say_published(&reports).await;
        }

        transitions.keep_all(&fresh_mirror);
        self.mirror.replace_all(&fresh_mirror);

        // 6. Converge what an App compiles into (T-0411, AP-18, AP-21). The mirror is already
        //    swapped, so a cluster that refuses one object leaves the Portal serving the
        //    repository correctly and says why in the log; one app's failure is not the run's.
        if let Some(converger) = self.converger.as_ref() {
            // What each project may deploy (PF-74); the mirror is already swapped, so this is
            // the repository as it now stands.
            let beyond: std::collections::HashSet<(String, String)> = self
                .mirror
                .namespaces()
                .into_iter()
                .flat_map(|ns| {
                    crate::quotas::beyond(&self.mirror, &ns, "apps")
                        .into_iter()
                        .map(move |name| (ns.clone(), name))
                })
                .collect();
            for (app, outcome) in converger.converge(&repository, &beyond).await {
                match outcome {
                    Ok(Outcome::Applied) => tracing::info!(%app, "app objects applied"),
                    Ok(Outcome::Deleted) => tracing::info!(%app, "app objects deleted"),
                    Ok(Outcome::NamespaceReady) => tracing::debug!(%app, "apps namespace in place"),
                    Ok(Outcome::NamespaceDeleted) => tracing::info!(%app, "apps namespace deleted"),
                    Ok(Outcome::Skipped(why)) => {
                        tracing::debug!(%app, reason = %why, "app deploys nothing")
                    }
                    Err(err) => tracing::warn!(%app, error = %err, "app did not converge"),
                }
            }
        }

        // 6a. Every published App's host: its certificate, requested once, and its edge Ingress;
        //     a retired App's are removed (ADR-N-037, AP-133). An App whose certificate is not
        //     issued yet says so, and reads published only once it is.
        if let (Some(hosts), Some((_, settings))) =
            (self.app_hosts.as_ref(), self.edge_file.as_ref())
        {
            let published: std::collections::BTreeSet<String> = self
                .mirror
                .matching(|env| {
                    env.kind == "App"
                        && env
                            .spec
                            .get("lifecycle")
                            .and_then(serde_json::Value::as_str)
                            == Some(jc_core::kinds::AppLifecycle::Published.as_str())
                })
                .into_iter()
                .map(|env| env.metadata.name)
                .collect();
            let states = hosts.converge(&published, &settings.apex).await;
            if scratch.unstaged.is_empty() {
                hosts.retire(&published).await;
            } else {
                tracing::warn!(projects = ?scratch.unstaged, "no App host is retired this run: a project's repository did not stage, so its Apps may only be missing from this read");
            }
            for (name, state) in states {
                let (reason, message) = match state {
                    super::app_hosts::HostState::Ready => continue,
                    super::app_hosts::HostState::Pending(message) => {
                        ("CertificatePending", message)
                    }
                    super::app_hosts::HostState::Failed(message) => ("HostRefused", message),
                };
                tracing::warn!(app = %name, %reason, %message, "the App's host is not served yet");
                let Some(mut envelope) = self
                    .mirror
                    .find(|env| env.kind == "App" && env.metadata.name == name)
                else {
                    continue;
                };
                if let Some(status) = envelope.status.as_mut() {
                    status.conditions = vec![super::streams::make_condition(
                        "Ready",
                        "False",
                        reason,
                        &format!("the App's host has no certificate yet (AP-133): {message}"),
                    )];
                }
                transitions.keep(&mut envelope);
                self.mirror.upsert(envelope);
            }
        }

        // 6b. An app whose `status.build` names a build this host does not hold keeps the
        //     previous one serving, and says so on the App rather than looking healthy (AP-72).
        for name in
            crate::apps::static_host::build_missing(self.apps_cache_dir.as_deref(), &self.mirror)
        {
            let Some(mut envelope) = self
                .mirror
                .find(|env| env.kind == "App" && env.metadata.name == name)
            else {
                continue;
            };
            if let Some(status) = envelope.status.as_mut() {
                status.conditions = vec![super::streams::make_condition(
                    "Ready",
                    "False",
                    "BuildMissing",
                    "status.build names a build this host does not hold; the previous one keeps \
                     serving (AP-72)",
                )];
            }
            tracing::warn!(app = %name, "the build the manifest names is not on the host");
            transitions.keep(&mut envelope);
            self.mirror.upsert(envelope);
        }

        // 6b'. A published App with no build and no bundle the image ships serves nothing: it
        //      reads Pending with a red Ready, never Live (AP-13a, T-2989).
        for name in crate::apps::static_host::report_unbuilt(
            self.apps_dir.as_deref(),
            &self.mirror,
            &transitions,
        ) {
            tracing::warn!(app = %name, "a published App has no build to serve");
        }

        // 6c. One writer and one reader per Organization in the artifact store, scoped to that
        //     organization's prefixes (PF-31, PF-32). Both are derived from the root credential
        //     this process holds, so the call is an upsert and re-running it changes nothing;
        //     one organization the store refuses is that organization's condition, not the
        //     run's failure, exactly like the app wave above.
        if let Some(store) = self.artifact_store.as_ref() {
            for name in self
                .mirror
                .matching(|envelope| envelope.kind == "Organization")
                .into_iter()
                .map(|envelope| envelope.metadata.name)
            {
                match store.ensure_organization(&name).await {
                    Ok(credentials) => {
                        tracing::info!(
                            organization = %name,
                            issued = credentials.len(),
                            "artifact store credentials are in place"
                        );
                        self.hand_over_reader(&name, store.as_ref()).await;
                    }
                    Err(err) => {
                        tracing::warn!(organization = %name, error = %err, "the artifact store issued no credential");
                        let Some(mut envelope) = self
                            .mirror
                            .find(|env| env.kind == "Organization" && env.metadata.name == name)
                        else {
                            continue;
                        };
                        if let Some(status) = envelope.status.as_mut() {
                            status.conditions = vec![super::streams::make_condition(
                                "ArtifactStoreCredentials",
                                "False",
                                "StoreRefused",
                                &err.to_string(),
                            )];
                        }
                        transitions.keep(&mut envelope);
                        self.mirror.upsert(envelope);
                    }
                }
            }
        }

        // 6d. Whether each Organization owns the domain it declares (PF-41, T-2377): minted,
        //     checked when due and stored, then reported on the Organization's status. A lookup
        //     that fails is a recorded state; a database that fails is a log line, and the
        //     Organization shows no state rather than a stale one.
        if let Some(domains) = self.domains.as_ref() {
            for mut envelope in self
                .mirror
                .matching(|envelope| envelope.kind == "Organization")
            {
                let Some(domain) = envelope.spec["domain"].as_str().map(str::to_owned) else {
                    continue;
                };
                let name = envelope.metadata.name.clone();
                match domains.verify(&name, &domain, chrono::Utc::now()).await {
                    Ok(verification) => {
                        if let Some(status) = envelope.status.as_mut() {
                            status.domain_verification = Some(verification);
                        }
                        self.mirror.upsert(envelope);
                    }
                    Err(err) => {
                        tracing::warn!(organization = %name, error = %err, "the domain verification was not stored")
                    }
                }
            }
        }

        // 7. Compile `users/` into what the forge enforces (T-0527, PF-51, PF-52, CC-41): the
        //    CODEOWNERS, the bindings as data, and the gate that reads them. Written only when
        //    the repository differs, so the commit this makes is seen once by the next run and
        //    changes nothing. A forge that refuses the write costs the run nothing but a line
        //    in the log; the Portal's own check (PF-50) holds either way.
        if let Err(err) = self.publish_roles(&repository, &default_branch).await {
            tracing::warn!(error = %err, "roles were not compiled into the repository");
        }

        // 8. Drift (CC-21): configuration cannot drift, because every component reads it from
        //    the repository (CC-72, T-0421 option B). What can is a space's seed entities, so
        //    that is what the scan compares — against the space surface every other client
        //    reads, as this Portal's own service account, so it reports what a person could
        //    see. Only the leader scans: a follower's answer would be the same read made twice.
        if leader {
            if let Some((watch, store)) = self.drift.as_ref() {
                match watch.scan(scratch.path()).await {
                    Ok(found) => {
                        let drifted: usize = found.values().map(|f| f.entities.len()).sum();
                        store.replace_all(found);
                        if drifted > 0 {
                            tracing::info!(drifted, "seed entities differ from what Git declares");
                        }
                    }
                    // A scan that failed keeps the previous answer rather than replacing it
                    // with an empty one: "nothing drifted" and "nothing was read" are not the
                    // same thing, and the second must not look like the first on the page.
                    Err(err) => tracing::warn!(error = %err, "the drift scan did not complete"),
                }
            }
            // 9. Data quality (DM-74): once a day, in the background; the sync never waits.
            if let Some(scanner) = self.quality.as_ref() {
                scanner.start_if_due();
            }
        }

        Ok((loaded, revision))
    }

    /// Resolves every pipeline's references and writes them into the runner's one Secret.
    ///
    /// Returns the pipelines that must not be deployed, by `(project, name)`, with the reason
    /// for each: a reference that resolved to nothing, a reference with no `envVar`, or a
    /// variable another pipeline of this runner already claims (T-0927).
    ///
    /// Nothing configured is not a failure: a Portal with no backend refuses only the pipelines
    /// that declare a reference, and a Portal outside a cluster resolves them and has nowhere to
    /// write them, which is the same refusal for the same reason.
    async fn resolve_pipeline_secrets(
        &self,
        mirror: &Mirror,
        repository: &std::path::Path,
    ) -> BTreeMap<(String, String), String> {
        use crate::pipeline_secrets::{RunnerEnvironment, SecretError};

        let mut runner = RunnerEnvironment::default();
        for namespace in mirror.namespaces() {
            let page = mirror.list(
                &namespace,
                "Pipeline",
                &crate::store::ListOptions::default(),
            );
            for envelope in page.items {
                let references = pipeline_references(mirror, &namespace, &envelope);
                if references.is_empty() {
                    continue;
                }
                let resolved = match self.pipeline_secrets.as_ref() {
                    Some(resolver) => resolver.resolve(repository, &references).await,
                    None => Err(SecretError::NoBackend {
                        name: references[0].name.clone(),
                    }),
                };
                runner.add(&namespace, &envelope.metadata.name, resolved);
            }
        }

        if !runner.is_empty() {
            let written = match self.credentials.as_ref() {
                Some((kube, namespace)) => self.write_runner_secret(kube, namespace, &runner).await,
                None => {
                    tracing::info!(
                        "no cluster: a pipeline's credentials resolve and reach no runner"
                    );
                    false
                }
            };
            if !written {
                runner.refuse_resolved(
                    "the credential resolved, but the pipeline runner's Secret could not be \
                     written, so the stream would start without it; the Portal's log says why",
                );
            }
        }

        runner.refused().clone()
    }

    /// Resolves the inbound webhook secret of every `SyncSource` that declares one (MF-44).
    ///
    /// Wholesale per pass, like the mirror beside it: a source that was detached, or whose
    /// `spec.webhook` was removed, stops being reachable in the pass that reads it. A source
    /// whose reference does not resolve is left out and said so in the log — the route then
    /// answers it the same `401` as an unknown source, because an unauthenticated door must not
    /// tell a caller which of the two it hit (PF-59).
    ///
    /// Nothing is resolved without a backend, which is a Portal that configured none: those
    /// sources are then unreachable through the webhook rather than reachable by anybody.
    async fn resolve_webhook_secrets(&self, mirror: &Mirror, repository: &std::path::Path) {
        let Some(accepted) = self.webhook_secrets.as_ref() else {
            return;
        };
        let mut resolved: BTreeMap<(String, String), Vec<String>> = BTreeMap::new();
        for namespace in mirror.namespaces() {
            let page = mirror.list(
                &namespace,
                "SyncSource",
                &crate::store::ListOptions::default(),
            );
            for envelope in page.items {
                let name = envelope.metadata.name.clone();
                let Some(block) = envelope.spec.get("webhook") else {
                    continue;
                };
                let block: jc_core::kinds::sync::WebhookAuth = match serde_json::from_value(
                    block.clone(),
                ) {
                    Ok(block) => block,
                    Err(err) => {
                        tracing::warn!(project = %namespace, source = %name, error = %err,
                                "the webhook block of a sync source is not one; it is not reachable through the webhook");
                        continue;
                    }
                };
                let references = crate::sync::webhook_secrets::references(&block);
                let mut secrets = Vec::with_capacity(references.len());
                for reference in references {
                    match self.pipeline_secrets.as_ref() {
                        Some(resolver) => match resolver.one(repository, reference).await {
                            Ok(secret) => secrets.push(secret),
                            // The reference is named, the value never is: this line travels into
                            // a log collector (PL-17, MF-24).
                            Err(err) => tracing::warn!(project = %namespace, source = %name,
                                secret = %reference.name, error = %err,
                                "a sync source's webhook secret does not resolve"),
                        },
                        None => tracing::warn!(project = %namespace, source = %name,
                            secret = %reference.name,
                            "this Portal has no secret backend, so a webhook-driven sync source is not reachable"),
                    }
                }
                if !secrets.is_empty() {
                    resolved.insert((namespace.clone(), name), secrets);
                }
            }
        }
        tracing::debug!(
            sources = resolved.len(),
            "sync sources reachable through the webhook"
        );
        accepted.replace_all(resolved);
    }

    /// Writes the runner's Secret and rolls the runner when its content changed.
    ///
    /// An environment variable is read once, when the pod starts, so a rotated credential
    /// reaches a running pipeline only with a restart. The annotation carries the fingerprint of
    /// the values, so an unchanged environment patches the same bytes and rolls nothing.
    ///
    /// Whether the Secret was written. A roll that fails only delays a rotation, so it is logged
    /// and still counts as written.
    async fn write_runner_secret(
        &self,
        kube: &crate::apps::kube::KubeClient,
        namespace: &str,
        runner: &crate::pipeline_secrets::RunnerEnvironment,
    ) -> bool {
        if let Err(err) = kube.apply(&runner.secret(namespace)).await {
            tracing::warn!(error = %err, "the pipeline runner's secrets were not written");
            return false;
        }
        tracing::info!(
            variables = runner.variables().count(),
            "the pipeline runner's secrets are in place"
        );
        let rollout = serde_json::json!({
            "apiVersion": "apps/v1",
            "kind": "Deployment",
            "metadata": { "name": PIPELINE_RUNNER_DEPLOYMENT, "namespace": namespace },
            "spec": { "template": { "metadata": { "annotations": {
                "joinedcontext.com/pipeline-secrets": runner.fingerprint(),
            }}}},
        });
        if let Err(err) = kube.apply(&rollout).await {
            tracing::warn!(error = %err, "the pipeline runner was not rolled, so a rotated credential is not in its environment yet");
        }
        true
    }

    /// Writes one organization's reader credential into the namespace its serving workloads
    /// read, so a credential the reconciler minted actually reaches them (T-0925, PF-32).
    ///
    /// A cluster that refuses the write costs the run a line in the log and nothing else, the
    /// way one app's failure is not the run's: the credential is derived, so the next sync
    /// writes exactly the same bytes and the one after that too.
    async fn hand_over_reader(&self, organization: &str, store: &crate::artifact_store::Client) {
        let Some((kube, namespace)) = self.credentials.as_ref() else {
            return;
        };
        let reader = store.credential(organization, crate::artifact_store::Role::Reader);
        let secret = crate::artifact_store::reader_secret(namespace, organization, &reader);
        match kube.apply(&secret).await {
            Ok(()) => tracing::info!(
                organization = %organization,
                secret = %crate::artifact_store::reader_secret_name(organization),
                "the artifact store reader is in the namespace that serves"
            ),
            Err(err) => tracing::warn!(
                organization = %organization,
                error = %err,
                "the reader credential was minted and not handed over"
            ),
        }
    }

    /// Writes every managed roles file whose content differs from the branch (T-0527).
    async fn publish_roles(
        &self,
        repository: &jcctl::loader::Repository,
        branch: &str,
    ) -> Result<(), SyncError> {
        let Some(files) =
            jcctl::roles::files(repository).map_err(|e| SyncError::Roles(e.to_string()))?
        else {
            return Ok(());
        };
        for (path, content) in files {
            let existing = self.gitea.get_file(path, branch).await?;
            if existing.as_ref().map(|f| f.content.as_str()) == Some(content.as_str()) {
                continue;
            }
            let message = format!("roles: compile users/ into {path} (T-0527)");
            self.gitea
                .put_file(&FileWrite {
                    path,
                    branch,
                    message: &message,
                    content: &content,
                    sha: existing.as_ref().map(|f| f.sha.as_str()),
                    author: Author {
                        name: crate::sync::proposal::AUTHOR_NAME,
                        email: crate::sync::proposal::AUTHOR_EMAIL,
                    },
                })
                .await?;
            tracing::info!(path, "roles compiled into the repository");
        }
        Ok(())
    }

    /// Spawns the background periodic sync task.
    ///
    /// When `interval` is `Duration::ZERO`, periodic sync is disabled and
    /// the returned handle completes immediately.
    pub fn spawn_periodic(self: Arc<Self>, interval: Duration) -> tokio::task::JoinHandle<()> {
        if interval.is_zero() {
            return tokio::spawn(async {});
        }

        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            // A tick that fell due while a run waited on an approval's sync is not owed.
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                ticker.tick().await;
                if let Err(err) = self.sync_once().await {
                    tracing::warn!(error = %err, "periodic mirror sync failed");
                }
            }
        })
    }
}

/// The status of every stream pipeline `mirror` holds, as this run left it (T-2976).
fn stream_phases(
    mirror: &Mirror,
) -> HashMap<crate::pipeline_status::Key, crate::pipeline_status::Saved> {
    let mut phases = HashMap::new();
    for ns in mirror.namespaces() {
        let page = mirror.list(&ns, "Pipeline", &crate::store::ListOptions::default());
        for envelope in page.items {
            let Ok(spec) = serde_json::from_value::<jc_core::kinds::pipeline::PipelineSpec>(
                envelope.spec.clone(),
            ) else {
                continue;
            };
            let Some(status) = envelope.status.as_ref().filter(|_| eligible(&spec)) else {
                continue;
            };
            phases.insert(
                (ns.clone(), envelope.metadata.name.clone()),
                crate::pipeline_status::Saved {
                    phase: status.phase,
                    conditions: status.conditions.clone(),
                },
            );
        }
    }
    phases
}

/// A follower's stream pipelines: what the leader last concluded where it said something fresh,
/// else `Pending` with the `Follower` reason, because this replica cannot know (T-2976).
fn serve_leaders_phases(
    mirror: &Mirror,
    saved: &HashMap<crate::pipeline_status::Key, crate::pipeline_status::Saved>,
) {
    for ns in mirror.namespaces() {
        let page = mirror.list(&ns, "Pipeline", &crate::store::ListOptions::default());
        for mut envelope in page.items {
            let Ok(spec) = serde_json::from_value::<jc_core::kinds::pipeline::PipelineSpec>(
                envelope.spec.clone(),
            ) else {
                continue;
            };
            if !eligible(&spec) {
                continue;
            }
            let key = (ns.clone(), envelope.metadata.name.clone());
            if let Some(status) = envelope.status.as_mut() {
                match saved.get(&key) {
                    Some(leaders) => {
                        status.phase = leaders.phase;
                        status.conditions = leaders.conditions.clone();
                    }
                    None => {
                        status.phase = crate::resource::Phase::Pending;
                        status.conditions = vec![make_condition(
                            "StreamDeployed",
                            "False",
                            "Follower",
                            "another replica reconciles the streams and has said nothing recent about this one",
                        )];
                    }
                }
            }
            mirror.upsert(envelope);
        }
    }
}

/// Every stream pipeline in `mirror` is `pending` with `StreamDeployed` false for `reason`: this
/// run deployed none of them.
fn mark_streams_pending(mirror: &Mirror, reason: &str, message: &str) {
    for ns in mirror.namespaces() {
        let page = mirror.list(&ns, "Pipeline", &crate::store::ListOptions::default());
        for mut envelope in page.items {
            let Ok(spec) = serde_json::from_value::<jc_core::kinds::pipeline::PipelineSpec>(
                envelope.spec.clone(),
            ) else {
                continue;
            };
            if !eligible(&spec) {
                continue;
            }
            if let Some(status) = envelope.status.as_mut() {
                status.phase = crate::resource::Phase::Pending;
                status.conditions =
                    vec![make_condition("StreamDeployed", "False", reason, message)];
            }
            mirror.upsert(envelope);
        }
    }
}

/// Identifies files that are candidates for ResourceEnvelope manifests.
///
/// The repository holds YAML that is not a manifest at all: the Portal theme, the navigation
/// tree, the locale bundles, the LinkML models and the native pipeline configurations. The
/// loader is strict on purpose, so those are never handed to it; what is handed to it are the
/// directories the manifest layout claims (CC-08).
pub(crate) fn is_candidate_manifest(path: &str) -> bool {
    let clean = path.trim_start_matches('/');
    if clean
        .split('/')
        .any(|segment| segment == ".." || segment.is_empty())
    {
        // The tree comes from the forge, so it is input: nothing that could climb out of the
        // staging directory is a candidate (CC-08).
        return false;
    }
    if clean == "org.yaml" || clean == "bundle.yaml" {
        return true;
    }
    if !clean.ends_with(".yaml") && !clean.ends_with(".yml") {
        return false;
    }
    // A blueprint is an organization-level manifest with a path of its own
    // (`blueprints/{name}/blueprint.yaml`, CC-23), and the flow gallery reads it from the
    // mirror like any other resource (CC-26). Only that one name: the notes and the fixtures
    // beside it are not manifests.
    if clean.starts_with("blueprints/") {
        return clean.ends_with("/blueprint.yaml");
    }
    // Roles and their bindings live beside the projects (T-0525): the Portal reads them for
    // its own checks and compiles them for the forge (T-0527).
    // The builder profiles are organization-level too (AG-26): `agentprofiles/{name}.yaml`.
    clean.starts_with("projects/")
        || clean.starts_with("users/roles/")
        || clean.starts_with("users/assignments/")
        || clean.starts_with("agentprofiles/")
}

/// Whether a staged file is an encrypted secrets file rather than a manifest (CC-06).
///
/// The same names `jcctl` skips when it loads a repository and reads when it resolves a
/// `secretRef`, so one file is never both.
fn is_encrypted_secrets_file(path: &str) -> bool {
    path.rsplit('/')
        .next()
        .is_some_and(jcctl::secrets::sops::is_encrypted_file)
}

/// Prepares one fetched file for the loader, or leaves it out (MF-04, MF-05).
///
/// Two judgements are made here and nowhere else, because the loader is right to refuse both
/// and the Portal is right to survive them. A `status:` block somebody committed is dropped,
/// all but `status.build`, the one member the build lane writes back (AP-13a): status is
/// computed by the server and never read from Git, so a manifest carrying one is sanitised
/// rather than refused. A document of a kind the Portal does not serve is left out:
/// one unknown kind in the repository must not cost every other resource its place in the
/// mirror. Everything past this point is the loader's judgement, including which two files
/// claim one identity and which path a kind belongs at.
///
/// `Ok(None)` means the file held nothing to load.
fn stageable(content: &str) -> Result<Option<String>, serde_yaml_ng::Error> {
    let mut kept: Vec<String> = Vec::new();

    for document in serde_yaml_ng::Deserializer::from_str(content) {
        let mut value = serde_yaml_ng::Value::deserialize(document)?;
        let Some(mapping) = value.as_mapping_mut() else {
            continue;
        };
        // Dropping `status.build` too left every published App without a build to serve (T-2633).
        let build = mapping
            .remove("status")
            .and_then(|mut status| status.as_mapping_mut()?.remove("build"));
        if let Some(build) = build {
            let mut status = serde_yaml_ng::Mapping::new();
            status.insert("build".into(), build);
            mapping.insert("status".into(), status.into());
        }
        // A document without a `kind` is not a manifest (a LinkML source beside its DataModel,
        // a note): nothing for an operator to act on. A kind the catalogue lacks is (OPS-27).
        let Some(kind) = mapping.get("kind").and_then(serde_yaml_ng::Value::as_str) else {
            tracing::debug!("a document without a kind, skipped");
            continue;
        };
        if crate::resource::by_kind(kind).is_none() {
            tracing::warn!(kind = %kind, "manifest of an unknown kind, skipped");
            continue;
        }
        kept.push(serde_yaml_ng::to_string(&value)?);
    }

    if kept.is_empty() {
        return Ok(None);
    }
    Ok(Some(kept.join("---\n")))
}

/// The project a manifest without a namespace belongs to, taken from where it lies (CC-08).
fn namespace_of(path: &str) -> String {
    let clean = path.trim_start_matches('/');
    match clean.split('/').collect::<Vec<_>>().as_slice() {
        ["projects", project, ..] if !project.is_empty() => (*project).to_owned(),
        _ => "org".to_owned(),
    }
}

/// The directory one run stages the fetched manifests in.
///
/// `jcctl` loads a repository from a path, and the Portal reads its repository over the
/// forge API, so the two meet on disk. The directory belongs to one run and is removed when
/// that run ends: nothing from the repository outlives the sync that fetched it.
/// The repository at one revision, staged as files the loader can read (CC-08).
///
/// Its own function because two schedules need it: the mirror the Portal serves from, and the
/// foreign-model mirror that proposes a peer's schema. A second copy of this loop would be a
/// second answer to "which files in the repository are manifests".
pub(crate) async fn stage(gitea: &GiteaClient, revision: &str) -> Result<Scratch, SyncError> {
    stage_repository(gitea, revision, false).await
}

/// One project repository of layout 2 at `revision`, staged as its own root (CC-85): the files
/// that would be manifests under `projects/{slug}/` of layout 1, and its `.jc/layout`.
pub(crate) async fn stage_project(
    gitea: &GiteaClient,
    revision: &str,
) -> Result<Scratch, SyncError> {
    stage_repository(gitea, revision, true).await
}

async fn stage_repository(
    gitea: &GiteaClient,
    revision: &str,
    project: bool,
) -> Result<Scratch, SyncError> {
    let tree_paths = gitea.list_tree(revision).await?;
    let candidate_paths: Vec<String> = tree_paths
        .into_iter()
        .filter(|p| {
            p == jc_core::project::LAYOUT_FILE
                || if project {
                    // The project's own tree is what lay under `projects/{slug}/`; the slug
                    // is the registry's, so any one stands in for it here.
                    is_candidate_manifest(&format!("projects/_/{}", p.trim_start_matches('/')))
                } else {
                    is_candidate_manifest(p)
                }
        })
        .collect();

    if candidate_paths.is_empty() {
        return Err(SyncError::Empty(
            "no manifests found in repository".to_string(),
        ));
    }

    // The staging directory is this run's own and is removed when it ends, whichever way it
    // ends.
    let scratch = Scratch::new(revision)?;
    let mut staged = 0usize;
    for path in &candidate_paths {
        let file = match gitea.get_file(path, revision).await {
            Ok(Some(f)) => f,
            Ok(None) => {
                // The tree listed it and the contents call does not have it: a race with a
                // force-push, not a broken manifest. The next run reads a consistent tree.
                tracing::warn!(path = %path, "candidate manifest listed in git tree not found");
                continue;
            }
            Err(err) => return Err(SyncError::Git(err)),
        };
        if path == jc_core::project::LAYOUT_FILE {
            // Which layout the repository follows (CC-85): read by the assembly, not a manifest.
            scratch.write(path, &file.content)?;
            continue;
        }
        if path.ends_with("/bento.yaml") {
            // Not a manifest: the author's Bento mapping beside a Pipeline (PL-03), staged as
            // written so the streams can render it; the loader skips it by name.
            scratch.write(path, &file.content)?;
            continue;
        }
        if is_encrypted_secrets_file(path) {
            // Not a manifest either: the repository's own `*.enc.yaml`, which the SOPS backend
            // decrypts a Pipeline's `secretRef` from (CC-06, T-0935). It is staged as written
            // because the resolver reads this tree and nothing else; dropping it here is how
            // `demo-feed` came back as "not declared in any encrypted secrets file" while the
            // file sat in the repository. The loader skips it by name.
            scratch.write(path, &file.content)?;
            continue;
        }
        match stageable(&file.content) {
            Ok(Some(text)) => {
                scratch.write(path, &text)?;
                staged += 1;
            }
            // Each unknown kind has said so above; a file of none is not a manifest.
            Ok(None) => {
                tracing::debug!(path = %path, "no document of a kind the Portal serves, skipped")
            }
            Err(err) => {
                tracing::warn!(path = %path, error = %err, "not YAML, skipped")
            }
        }
    }

    if staged == 0 {
        return Err(SyncError::Empty(format!(
            "none of the {} candidate files holds a manifest",
            candidate_paths.len()
        )));
    }
    Ok(scratch)
}

/// The tree one sync loads: the staged organization in layout 1, the assembly in layout 2, with
/// the repository each project is read from.
struct Render {
    /// The organization's `.jc/layout` (CC-85).
    layout: u32,
    root: PathBuf,
    /// The staged checkouts, held so they are removed when the sync that fetched them ends.
    _staged: Vec<Scratch>,
    /// Slug → the project's repository and the ref it renders at.
    projects: BTreeMap<String, (GiteaClient, String)>,
    /// The registered projects whose repository did not stage in this run. What the mirror
    /// holds of them is the last render, or nothing on a replica's first run, so a step that
    /// removes what the mirror lacks waits for a run where this is empty.
    unstaged: Vec<String>,
}

impl Render {
    fn path(&self) -> &Path {
        &self.root
    }

    /// Where a person reads the file at `path` of the render: in its project's repository at
    /// the entry's ref for a mounted project, in the organization's otherwise.
    fn browse_url(&self, organization: &GiteaClient, path: &str, branch: &str) -> String {
        let clean = path.trim_start_matches('/');
        if let Some((slug, rest)) = clean
            .strip_prefix("projects/")
            .and_then(|tail| tail.split_once('/'))
        {
            if let Some((client, git_ref)) = self.projects.get(slug) {
                return client.browse_url(rest, git_ref);
            }
        }
        organization.browse_url(clean, branch)
    }
}

pub(crate) struct Scratch(PathBuf);

impl Scratch {
    pub(crate) fn new(revision: &str) -> Result<Self, SyncError> {
        // One directory per run, never per revision: two runs staging into one directory would
        // read each other's files, and the first to finish would delete the other's.
        static RUNS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let run = RUNS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "jc-portal-sync-{}-{}-{run}",
            std::process::id(),
            revision.get(..12).unwrap_or(revision)
        ));
        std::fs::create_dir_all(&path).map_err(|source| SyncError::Scratch {
            path: path.clone(),
            source,
        })?;
        Ok(Self(path))
    }

    pub(crate) fn path(&self) -> &Path {
        &self.0
    }

    fn write(&self, relative: &str, content: &str) -> Result<(), SyncError> {
        let target = self.0.join(relative.trim_start_matches('/'));
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|source| SyncError::Scratch {
                path: parent.to_path_buf(),
                source,
            })?;
        }
        std::fs::write(&target, content).map_err(|source| SyncError::Scratch {
            path: target,
            source,
        })
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        if let Err(err) = std::fs::remove_dir_all(&self.0) {
            tracing::warn!(path = %self.0.display(), error = %err, "could not remove the sync staging directory");
        }
    }
}

/// What a Live stream's counters say about its writing: errors and nothing ever sent
/// (`NothingWritten`), else records in and nothing out for the stall window (`Stalled`, T-2967).
/// `body` is the runner's scrape, absent when it did not answer; `bento` the author's file, whose
/// stream may write through its processors and never reach the output (T-2979).
fn writing_verdict(
    stalls: &super::stall::StallWatch,
    (project, pipeline): (&str, &str),
    body: Option<&str>,
    bento: Option<&str>,
    now: std::time::Instant,
) -> Option<(&'static str, String)> {
    let body = body?;
    if let Some(said) = failing(body, pipeline) {
        return Some(("NothingWritten", said));
    }
    if bento.is_some_and(super::stall::writes_through_processors) {
        return None;
    }
    let metrics = crate::api::pipelines::scrape(body, pipeline, String::new());
    stalls
        .observe(project, pipeline, &metrics, now)
        .map(|said| ("Stalled", said))
}

/// What a Live stream's counters say when it is not writing (T-0914).
///
/// Errors and nothing sent is a stream that runs and never lands: a source that refuses the
/// runner's token, a mapping that throws on every message. Errors beside writes are the ordinary
/// weather of a stream — a page that failed and was retried — and say nothing on their own.
fn failing(metrics: &str, pipeline: &str) -> Option<String> {
    let counters = crate::api::pipelines::scrape(metrics, pipeline, String::new());
    let errors = counters.errors?;
    if errors == 0 || counters.sent.unwrap_or(0) > 0 {
        return None;
    }
    Some(format!(
        "the stream is running and has written nothing: {errors} error(s) and no message sent \
         since it started; the runner's log names the reason"
    ))
}

/// Every `secretRef` one Pipeline needs: its own, and those of the `DataSource` it reads.
///
/// PL-50 puts a connector's credentials on the `DataSource` (`spec.secrets`) and PL-15 puts the
/// pipeline's own on the Pipeline (`spec.secretRefs`); the runner has one environment and reads
/// both from it, so they are resolved together.
fn pipeline_references(
    mirror: &Mirror,
    namespace: &str,
    envelope: &ResourceEnvelope,
) -> Vec<jc_core::envelope::SecretRef> {
    let list = |value: Option<&serde_json::Value>| -> Vec<jc_core::envelope::SecretRef> {
        value
            .cloned()
            .map(serde_json::from_value)
            .and_then(Result::ok)
            .unwrap_or_default()
    };

    let mut references = list(envelope.spec.get("secretRefs"));
    let data_source = envelope
        .spec
        .pointer("/source/dataSourceRef")
        .and_then(crate::api::assistant::ref_name);
    if let Some(name) = data_source {
        if let Some(source) = mirror.get(namespace, "DataSource", &name) {
            // The connector's `spec.secrets` (PL-50), and every credential its typed fields
            // name (an HTTP source's `authorization.headerRef`, an MQTT password, a TLS CA)
            // under the name its compiled stream expects: `spec.secrets` alone left praha's
            // Golemio key out of the runner (T-2957, T-2880).
            let declared = list(source.spec.get("secrets"));
            let typed: Vec<jc_core::envelope::SecretRef> = serde_json::from_value::<
                jc_core::kinds::data_source::DataSourceSpec,
            >(source.spec.clone())
            .map(|spec| {
                spec.secret_refs()
                    .into_iter()
                    .map(|reference| {
                        let mut named = reference.clone();
                        named.env_var.get_or_insert_with(|| {
                            jc_core::kinds::data_source::env_var_of(&name, reference)
                        });
                        named
                    })
                    .collect()
            })
            .unwrap_or_default();
            for reference in declared.into_iter().chain(typed) {
                if !references.contains(&reference) {
                    references.push(reference);
                }
            }
        }
    }
    references
}

#[cfg(test)]
mod tests {
    use super::*;

    const RUNNING_STREAM: &str = r#"
input_received{stream="aq"} 42
output_sent{stream="aq"} 40
output_error{stream="aq"} 2
input_received{stream="kpi"} 6
output_error{stream="kpi"} 6
"#;

    #[test]
    fn a_stream_that_writes_nothing_and_only_errors_is_said_to_be_failing() {
        // T-0914: the KPI stream on dev was Live for an hour, reading a source that refused its
        // token; the counters were the only witness.
        let said = failing(RUNNING_STREAM, "kpi").expect("a stream that never wrote");
        assert!(said.contains("written nothing"), "{said}");
        assert!(said.contains("6 error"), "{said}");
    }

    #[test]
    fn errors_beside_writes_are_the_weather_and_say_nothing() {
        assert_eq!(failing(RUNNING_STREAM, "aq"), None);
        // A runner that exports no error counter for a stream says nothing about it either.
        assert_eq!(failing(RUNNING_STREAM, "nothing-of-that-name"), None);
    }

    /// What `stageable` logs at `warn`, captured on this thread.
    fn warnings_of(content: &str) -> (Option<String>, String) {
        #[derive(Clone, Default)]
        struct Log(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
        impl std::io::Write for Log {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0
                    .lock()
                    .map_err(|_| std::io::Error::other("poisoned"))?
                    .extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let log = Log::default();
        let writer = log.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::WARN)
            .with_ansi(false)
            .with_writer(move || writer.clone())
            .finish();
        let staged =
            tracing::subscriber::with_default(subscriber, || stageable(content).expect("YAML"));
        let said = String::from_utf8_lossy(&log.0.lock().expect("log")).into_owned();
        (staged, said)
    }

    /// T-2633, AP-13a: the build lane's `status.build` reaches the loader; the rest of status
    /// does not.
    #[test]
    fn staging_keeps_status_build_and_drops_the_rest_of_status() {
        let app = "apiVersion: joinedcontext.com/v1alpha1\nkind: App\nmetadata:\n  name: a\nspec: {}\nstatus:\n  phase: Pending\n  build:\n    commit: abc\n";
        let staged = stageable(app).expect("YAML").expect("an App");
        let value: serde_yaml_ng::Value = serde_yaml_ng::from_str(&staged).expect("YAML");
        assert_eq!(value["status"]["build"]["commit"].as_str(), Some("abc"));
        assert!(value["status"].get("phase").is_none());
        let bare = stageable(&app.replace("  build:\n    commit: abc\n", "")).expect("YAML");
        assert!(!bare.expect("an App").contains("status"));
    }

    /// T-2254, OPS-27: a LinkML source beside its DataModel is not a manifest and says nothing at
    /// `warn`; a manifest of a kind the catalogue lacks still does, and names the kind.
    #[test]
    fn a_document_without_a_kind_is_skipped_quietly_and_an_unknown_kind_is_named() {
        let linkml = "id: https://hel.fi/models/bikes\nname: bikes\nclasses:\n  Station:\n    slots: [name]\n";
        let (staged, said) = warnings_of(linkml);
        assert_eq!(staged, None);
        assert_eq!(said, "");

        let (staged, said) = warnings_of(
            "apiVersion: joinedcontext.com/v1alpha1\nkind: Nonsense\nmetadata:\n  name: x\n",
        );
        assert_eq!(staged, None);
        assert!(said.contains("WARN"), "{said}");
        assert!(said.contains("kind=Nonsense"), "{said}");

        // A known manifest beside a kindless document in one file keeps its place, quietly.
        let (staged, said) = warnings_of("note: not a manifest\n---\napiVersion: joinedcontext.com/v1alpha1\nkind: ContextSpace\nmetadata:\n  name: mobility\n");
        assert!(staged.is_some_and(|text| text.contains("ContextSpace")));
        assert_eq!(said, "");
    }

    use base64::Engine as _;
    use serde_json::json;
    use wiremock::matchers::path as path_matcher;
    use wiremock::matchers::{method, path, path_regex, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// T-0935: the SOPS backend decrypts a Pipeline's `secretRef` from the repository's own
    /// `*.enc.yaml`, and it reads the tree this function stages. While the stager dropped every
    /// file that held no manifest, the resolver answered "not declared in any encrypted secrets
    /// file" for a secret that sat in the repository — with the backend configured, the
    /// identity mounted and the file committed.
    #[tokio::test]
    async fn an_encrypted_secrets_file_is_staged_beside_the_manifests() {
        const ENCRYPTED: &str = "demo-feed:\n    password: ENC[AES256_GCM,data:aaaa,iv:bbbb,tag:cccc,type:str]\nsops:\n    age: []\n";
        let space = "apiVersion: joinedcontext.com/v1alpha1\nkind: ContextSpace\nmetadata:\n  name: mobility\n  namespace: helsinki\nspec:\n  isSandbox: true\n";
        let files = [
            ("projects/helsinki/spaces/mobility/space.yaml", space),
            ("projects/helsinki/secrets/demo-feed.enc.yaml", ENCRYPTED),
        ];

        let server = MockServer::start().await;
        let tree: Vec<serde_json::Value> = files
            .iter()
            .map(|(p, _)| json!({"path": p, "type": "blob"}))
            .collect();
        Mock::given(method("GET"))
            .and(path("/api/v1/repos/test-owner/test-repo/git/trees/rev-1"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({"truncated": false, "tree": tree})),
            )
            .mount(&server)
            .await;
        for (file, content) in files {
            Mock::given(method("GET"))
                .and(path(format!(
                    "/api/v1/repos/test-owner/test-repo/contents/{file}"
                )))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                    "sha": "blob-sha",
                    "content": base64::engine::general_purpose::STANDARD.encode(content),
                })))
                .mount(&server)
                .await;
        }
        let gitea = GiteaClient::new(
            server.uri().parse().expect("forge url"),
            "test-owner",
            "test-repo",
            "token",
        )
        .expect("client");

        let scratch = stage(&gitea, "rev-1").await.expect("the run stages");
        let staged = scratch
            .path()
            .join("projects/helsinki/secrets/demo-feed.enc.yaml");
        assert!(staged.is_file(), "the encrypted file is staged");
        // Byte for byte: a SOPS file whose bytes changed no longer authenticates.
        assert_eq!(
            std::fs::read_to_string(&staged).expect("read the staged file"),
            ENCRYPTED
        );
        assert!(
            scratch
                .path()
                .join("projects/helsinki/spaces/mobility/space.yaml")
                .is_file(),
            "the manifest beside it is staged as before"
        );
    }

    #[test]
    fn only_the_encrypted_names_are_kept_for_the_secret_backend() {
        assert!(is_encrypted_secrets_file("projects/hel/secrets/a.enc.yaml"));
        assert!(is_encrypted_secrets_file("a.enc.yml"));
        // A manifest whose name merely mentions the word is a manifest.
        assert!(!is_encrypted_secrets_file("projects/hel/secrets.yaml"));
        assert!(!is_encrypted_secrets_file("projects/hel/enc.yaml"));
    }

    #[test]
    fn status_defaults() {
        let status = SyncStatus::default();
        assert_eq!(status.last_sync, None);
        assert_eq!(status.revision, None);
        assert_eq!(status.manifests, 0);
        assert_eq!(status.last_error, None);
    }

    #[tokio::test]
    async fn zero_duration_does_not_loop() {
        let gitea = Arc::new(
            GiteaClient::new(
                "http://localhost:3000".parse().unwrap(),
                "test-owner",
                "test-repo",
                "token",
            )
            .unwrap(),
        );
        let mirror = Arc::new(Mirror::new());
        let syncer = Arc::new(Syncer::new(gitea, mirror));
        let handle = syncer.spawn_periodic(Duration::ZERO);
        let res = tokio::time::timeout(Duration::from_millis(100), handle).await;
        assert!(
            res.is_ok(),
            "handle should finish immediately on zero duration"
        );
    }

    #[tokio::test]
    async fn a_sync_asked_for_during_a_sync_runs_after_it() {
        let gitea = Arc::new(
            GiteaClient::new(
                "http://127.0.0.1:9".parse().unwrap(),
                "test-owner",
                "test-repo",
                "token",
            )
            .unwrap(),
        );
        let mirror = Arc::new(Mirror::new());
        let syncer = Arc::new(Syncer::new(gitea, mirror));

        let guard = syncer.running.lock().await;
        let waiting = tokio::spawn({
            let syncer = syncer.clone();
            async move { syncer.sync_once().await }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            !waiting.is_finished(),
            "the second run waits for the first instead of answering Ok(0)"
        );
        drop(guard);
        let res = tokio::time::timeout(Duration::from_secs(5), waiting)
            .await
            .expect("the waiting run proceeds once the first releases the guard")
            .expect("the task joins");
        assert!(
            res.is_err(),
            "the waiting run reached the forge (unreachable here) instead of skipping"
        );
    }

    #[test]
    fn candidate_manifest_path_filtering() {
        assert!(is_candidate_manifest("org.yaml"));
        assert!(is_candidate_manifest("bundle.yaml"));
        assert!(is_candidate_manifest(
            "projects/ovzdusie/spaces/mobility/space.yaml"
        ));
        assert!(is_candidate_manifest(
            "/projects/ovzdusie/spaces/mobility/space.yaml"
        ));
        assert!(is_candidate_manifest("projects/ovzdusie/endpoints/air.yml"));

        // A Blueprint is a manifest kind of its own, so the gallery finds it in the mirror.
        assert!(is_candidate_manifest(
            "blueprints/threshold-alert/blueprint.yaml"
        ));

        assert!(!is_candidate_manifest("README.md"));
        assert!(!is_candidate_manifest("portal/theme.yaml"));
        assert!(!is_candidate_manifest("users/groups.yaml"));
        assert!(is_candidate_manifest("users/roles/steward.yaml"));
        assert!(is_candidate_manifest("users/assignments/stewards.yaml"));
        assert!(is_candidate_manifest("agentprofiles/app-builder.yaml"));
        assert!(!is_candidate_manifest("agentprofiles/README.md"));
        assert!(!is_candidate_manifest("platform-settings.yaml"));
        // Only the blueprint manifest itself, not the notes or fixtures beside it.
        assert!(!is_candidate_manifest(
            "blueprints/threshold-alert/README.md"
        ));
        assert!(!is_candidate_manifest(
            "blueprints/threshold-alert/example.yaml"
        ));
        assert!(
            !is_candidate_manifest("projects/../../etc/passwd.yaml"),
            "the tree comes from the forge: nothing may climb out of the staging directory"
        );
        assert!(!is_candidate_manifest(
            "projects/ovzdusie/spaces/mobility/space.json"
        ));
    }

    #[tokio::test]
    async fn a_run_that_lands_a_new_revision_says_so_once() {
        let server = MockServer::start().await;
        let base_url = server.uri().parse().unwrap();
        let client =
            Arc::new(GiteaClient::new(base_url, "test-owner", "test-repo", "token-xyz").unwrap());
        let mirror = Arc::new(Mirror::new());
        let activity = crate::activity::ActivityStore::new(None);
        let syncer = Arc::new(
            Syncer::new(Arc::clone(&client), Arc::clone(&mirror)).with_activity(activity.clone()),
        );

        mount_repository(&server).await;

        syncer.sync_once().await.expect("sync should succeed");
        let filter = crate::activity::ActivityFilter {
            limit: 50,
            ..Default::default()
        };
        let page = activity.list("ovzdusie", &filter).await.expect("list");
        assert_eq!(page.items.len(), 1, "{:?}", page.items);
        assert_eq!(page.items[0].kind, "config.applied");
        assert_eq!(page.items[0].source, "reconciler");
        assert!(
            page.items[0].summary.contains("commit"),
            "{}",
            page.items[0].summary
        );

        // The loop runs every tick; the same revision is not news twice.
        syncer
            .sync_once()
            .await
            .expect("second sync should succeed");
        let page = activity.list("ovzdusie", &filter).await.expect("list");
        assert_eq!(page.items.len(), 1, "{:?}", page.items);
    }

    #[tokio::test]
    async fn a_repository_that_will_not_load_reaches_the_feed() {
        let server = MockServer::start().await;
        let base_url = server.uri().parse().unwrap();
        let client =
            Arc::new(GiteaClient::new(base_url, "test-owner", "test-repo", "token-xyz").unwrap());
        let mirror = Arc::new(Mirror::new());
        let activity = crate::activity::ActivityStore::new(None);
        let syncer = Arc::new(
            Syncer::new(Arc::clone(&client), Arc::clone(&mirror)).with_activity(activity.clone()),
        );

        mount_repository(&server).await;
        syncer.sync_once().await.expect("the first sync loads");

        // The forge goes away: the mirror keeps what it has and the feed says why.
        server.reset().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/repos/test-owner/test-repo"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        syncer.sync_once().await.expect_err("the second sync fails");

        let page = activity
            .list(
                "ovzdusie",
                &crate::activity::ActivityFilter {
                    kinds: vec!["config.drifted".to_string()],
                    limit: 50,
                    ..Default::default()
                },
            )
            .await
            .expect("list");
        assert_eq!(page.items.len(), 1, "{:?}", page.items);
        assert_eq!(page.items[0].severity, "error");
    }

    /// The one-space repository both the success test and the activity tests read.
    async fn mount_repository(server: &MockServer) {
        Mock::given(method("GET"))
            .and(path("/api/v1/repos/test-owner/test-repo"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "default_branch": "main"
            })))
            .mount(server)
            .await;

        Mock::given(method("GET"))
            .and(path("/api/v1/repos/test-owner/test-repo/branches/main"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "name": "main",
                "commit": { "id": "commit-rev-123" }
            })))
            .mount(server)
            .await;

        Mock::given(method("GET"))
            .and(path(
                "/api/v1/repos/test-owner/test-repo/git/trees/commit-rev-123",
            ))
            .and(query_param("recursive", "true"))
            .and(query_param("per_page", "1000"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "sha": "tree-sha-1",
                "truncated": false,
                "tree": [
                    {
                        "path": "projects/ovzdusie/spaces/mobility/space.yaml",
                        "type": "blob"
                    }
                ]
            })))
            .mount(server)
            .await;

        let manifest_content = "apiVersion: joinedcontext.com/v1alpha1\nkind: ContextSpace\nmetadata:\n  name: mobility\n  namespace: ovzdusie\nspec:\n  isSandbox: true\n";
        let b64 = base64::engine::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            manifest_content.as_bytes(),
        );

        Mock::given(method("GET"))
            .and(path(
                "/api/v1/repos/test-owner/test-repo/contents/projects/ovzdusie/spaces/mobility/space.yaml",
            ))
            .and(query_param("ref", "commit-rev-123"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "sha": "blob-sha-1",
                "content": b64
            })))
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn sync_once_success() {
        let server = MockServer::start().await;
        let base_url = server.uri().parse().unwrap();
        let client =
            Arc::new(GiteaClient::new(base_url, "test-owner", "test-repo", "token-xyz").unwrap());
        let mirror = Arc::new(Mirror::new());
        let syncer = Arc::new(Syncer::new(Arc::clone(&client), Arc::clone(&mirror)));

        mount_repository(&server).await;

        let count = syncer.sync_once().await.expect("sync should succeed");
        assert_eq!(count, 1);

        let status = syncer.status();
        assert_eq!(status.manifests, 1);
        assert_eq!(status.revision.as_deref(), Some("commit-rev-123"));
        assert!(status.last_sync.is_some());
        assert_eq!(status.last_error, None);

        let env = mirror
            .get("ovzdusie", "ContextSpace", "mobility")
            .expect("in mirror");
        assert_eq!(
            env.status.as_ref().map(|s| s.phase),
            Some(crate::resource::Phase::Live)
        );
        assert_eq!(
            env.status
                .as_ref()
                .and_then(|s| s.observed_revision.as_deref()),
            Some("commit-rev-123")
        );
    }

    fn b64(text: &str) -> String {
        base64::engine::Engine::encode(&base64::engine::general_purpose::STANDARD, text.as_bytes())
    }

    async fn mount_file(server: &MockServer, path: &str, git_ref: &str, sha: &str, text: &str) {
        Mock::given(method("GET"))
            .and(path_matcher(format!(
                "/api/v1/repos/test-owner/test-repo/contents/{path}"
            )))
            .and(query_param("ref", git_ref))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "sha": sha,
                "content": b64(text)
            })))
            .mount(server)
            .await;
    }

    const ORG_YAML: &str = "apiVersion: joinedcontext.com/v1alpha1\nkind: Organization\nmetadata:\n  name: hel\nspec:\n  domain: hel.fi\n  locales: [en]\n  defaultLocale: en\n";
    const ROLE_YAML: &str = "apiVersion: joinedcontext.com/v1alpha1\nkind: Role\nmetadata:\n  name: steward\n  namespace: org\nspec:\n  rules:\n    - kinds: [\"*\"]\n      verbs: [propose, approve, delete]\n";
    const BINDING_YAML: &str = "apiVersion: joinedcontext.com/v1alpha1\nkind: RoleBinding\nmetadata:\n  name: stewards\n  namespace: org\nspec:\n  subjects:\n    - group: stewards\n  role: steward\n  scope:\n    organization: hel\n";

    /// T-0527: `users/` is compiled into the five managed files, and only the ones whose
    /// content differs from the branch are written.
    #[tokio::test]
    async fn bindings_are_compiled_into_the_forge() {
        let server = MockServer::start().await;
        let base_url = server.uri().parse().unwrap();
        let client =
            Arc::new(GiteaClient::new(base_url, "test-owner", "test-repo", "token-xyz").unwrap());
        let mirror = Arc::new(Mirror::new());
        let syncer = Arc::new(Syncer::new(Arc::clone(&client), Arc::clone(&mirror)));

        Mock::given(method("GET"))
            .and(path_matcher("/api/v1/repos/test-owner/test-repo"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({ "default_branch": "main" })),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path_matcher(
                "/api/v1/repos/test-owner/test-repo/branches/main",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "name": "main", "commit": { "id": "rev-1" }
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path_matcher(
                "/api/v1/repos/test-owner/test-repo/git/trees/rev-1",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "sha": "tree-1",
                "truncated": false,
                "tree": [
                    { "path": "org.yaml", "type": "blob" },
                    { "path": "users/roles/steward.yaml", "type": "blob" },
                    { "path": "users/assignments/stewards.yaml", "type": "blob" }
                ]
            })))
            .mount(&server)
            .await;
        mount_file(&server, "org.yaml", "rev-1", "b-org", ORG_YAML).await;
        mount_file(
            &server,
            "users/roles/steward.yaml",
            "rev-1",
            "b-role",
            ROLE_YAML,
        )
        .await;
        mount_file(
            &server,
            "users/assignments/stewards.yaml",
            "rev-1",
            "b-binding",
            BINDING_YAML,
        )
        .await;

        // The branch already holds the gate as jcctl renders it: not written again.
        let repo_dir = std::env::temp_dir().join(format!("jc-portal-roles-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&repo_dir);
        for (rel, text) in [
            ("org.yaml", ORG_YAML),
            ("users/roles/steward.yaml", ROLE_YAML),
            ("users/assignments/stewards.yaml", BINDING_YAML),
        ] {
            let full = repo_dir.join(rel);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(full, text).unwrap();
        }
        let expected = jcctl::roles::files(&jcctl::loader::Repository::load(&repo_dir).unwrap())
            .unwrap()
            .expect("a repository with users/ compiles");
        let rego = expected
            .iter()
            .find(|(p, _)| *p == jcctl::roles::ROLES_REGO)
            .map(|(_, c)| c.clone())
            .unwrap();
        let _ = std::fs::remove_dir_all(&repo_dir);
        mount_file(&server, jcctl::roles::ROLES_REGO, "main", "b-rego", &rego).await;
        // A stale CODEOWNERS is replaced with its sha; the others do not exist yet.
        mount_file(&server, "CODEOWNERS", "main", "b-old", "* @nobody\n").await;
        Mock::given(method("PUT"))
            .and(path_regex("^/api/v1/repos/test-owner/test-repo/contents/"))
            .respond_with(ResponseTemplate::new(201).set_body_json(json!({
                "commit": { "sha": "rev-2" }
            })))
            .expect(4)
            .mount(&server)
            .await;

        syncer.sync_once().await.expect("sync should succeed");

        let puts: Vec<_> = server
            .received_requests()
            .await
            .unwrap()
            .into_iter()
            .filter(|r| r.method == "PUT")
            .collect();
        let codeowners = puts
            .iter()
            .find(|r| r.url.path().ends_with("/contents/CODEOWNERS"))
            .expect("CODEOWNERS is written");
        let body: serde_json::Value = serde_json::from_slice(&codeowners.body).unwrap();
        assert_eq!(body["sha"], "b-old");
        assert_eq!(body["branch"], "main");
        let text = String::from_utf8(
            base64::engine::Engine::decode(
                &base64::engine::general_purpose::STANDARD,
                body["content"].as_str().unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
        assert!(text.contains("@hel/stewards"), "{text}");
        assert!(!puts
            .iter()
            .any(|r| r.url.path().ends_with("/contents/policies/roles.rego")));
    }

    #[tokio::test]
    async fn a_repository_of_nothing_loadable_leaves_the_mirror_alone() {
        let server = MockServer::start().await;
        let base_url = server.uri().parse().unwrap();
        let client =
            Arc::new(GiteaClient::new(base_url, "test-owner", "test-repo", "token-xyz").unwrap());
        let mirror = Arc::new(Mirror::new());

        // Pre-seed mirror to prove it is NOT emptied on failure
        mirror.upsert(crate::resource::ResourceEnvelope {
            api_version: crate::resource::API_VERSION.into(),
            kind: "ContextSpace".into(),
            metadata: crate::resource::ObjectMeta {
                name: "existing".into(),
                namespace: Some("ovzdusie".into()),
                ..Default::default()
            },
            spec: json!({}),
            status: None,
        });

        let syncer = Arc::new(Syncer::new(Arc::clone(&client), Arc::clone(&mirror)));

        Mock::given(method("GET"))
            .and(path("/api/v1/repos/test-owner/test-repo"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "default_branch": "main"
            })))
            .mount(&server)
            .await;

        Mock::given(method("GET"))
            .and(path("/api/v1/repos/test-owner/test-repo/branches/main"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "name": "main",
                "commit": { "id": "bad-rev" }
            })))
            .mount(&server)
            .await;

        Mock::given(method("GET"))
            .and(path("/api/v1/repos/test-owner/test-repo/git/trees/bad-rev"))
            .and(query_param("recursive", "true"))
            .and(query_param("per_page", "1000"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "sha": "tree-sha-2",
                "truncated": false,
                "tree": [
                    {
                        "path": "projects/ovzdusie/spaces/invalid/space.yaml",
                        "type": "blob"
                    }
                ]
            })))
            .mount(&server)
            .await;

        let bad_content = "::: not yaml at all :::";
        let b64 = base64::engine::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            bad_content.as_bytes(),
        );

        Mock::given(method("GET"))
            .and(path(
                "/api/v1/repos/test-owner/test-repo/contents/projects/ovzdusie/spaces/invalid/space.yaml",
            ))
            .and(query_param("ref", "bad-rev"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "sha": "blob-sha-2",
                "content": b64
            })))
            .mount(&server)
            .await;

        let err = syncer.sync_once().await.unwrap_err();
        match err {
            SyncError::Empty(message) => {
                assert!(
                    message.contains("none of the 1 candidate files"),
                    "{message}"
                );
            }
            other => panic!("expected an empty-repository error, got {other:?}"),
        }

        // Mirror still holds the pre-seeded resource: a repository that does not load leaves
        // the last one that did in place.
        assert_eq!(mirror.len(), 1);
        assert!(mirror.get("ovzdusie", "ContextSpace", "existing").is_some());

        // Status recorded the error
        let status = syncer.status();
        assert!(status
            .last_error
            .unwrap()
            .contains("none of the 1 candidate files"));
    }

    /// T-2976: a follower serves what the leader last concluded, a Live pipeline stays Live, and
    /// only a pipeline the leader said nothing fresh about is Pending with the Follower reason.
    #[test]
    fn a_follower_serves_the_leaders_phases_and_pending_only_where_it_cannot_know() {
        use crate::pipeline_status::Saved;
        use crate::resource::{ObjectMeta, Phase, ResourceEnvelope, Status, API_VERSION};
        let stream = |name: &str| ResourceEnvelope {
            api_version: API_VERSION.to_owned(),
            kind: "Pipeline".to_owned(),
            metadata: ObjectMeta::new(name, "helsinki"),
            spec: serde_json::json!({
                "class": "auto",
                "period": "60s",
                "source": { "dataSourceRef": { "kind": "DataSource", "name": "hsl" } },
                "compute": { "kind": "bloblang", "bloblang": "root = this" },
                "targetEndpoint": "urn:ngsi-ld:Endpoint:example.org:helsinki:helsinki-all"
            }),
            status: Some(Status {
                phase: Phase::Live,
                observed_revision: None,
                source_url: None,
                conditions: Vec::new(),
                build: None,
                domain_verification: None,
            }),
        };
        let mirror = Mirror::new();
        for name in ["hsl-hfp-vehicles", "stalled", "new-one"] {
            mirror.upsert(stream(name));
        }
        let stalled = vec![make_condition(
            "StreamWriting",
            "False",
            "Stalled",
            "records in, nothing out",
        )];
        let saved = HashMap::from([
            (
                ("helsinki".to_owned(), "hsl-hfp-vehicles".to_owned()),
                Saved {
                    phase: Phase::Live,
                    conditions: Vec::new(),
                },
            ),
            (
                ("helsinki".to_owned(), "stalled".to_owned()),
                Saved {
                    phase: Phase::Live,
                    conditions: stalled.clone(),
                },
            ),
        ]);

        serve_leaders_phases(&mirror, &saved);

        let status = |name: &str| {
            mirror
                .get("helsinki", "Pipeline", name)
                .and_then(|envelope| envelope.status)
                .expect("a status")
        };
        assert_eq!(status("hsl-hfp-vehicles").phase, Phase::Live);
        assert!(status("hsl-hfp-vehicles").conditions.is_empty());
        assert_eq!(status("stalled").conditions, stalled);
        let unknown = status("new-one");
        assert_eq!(unknown.phase, Phase::Pending);
        assert_eq!(unknown.conditions[0].reason.as_deref(), Some("Follower"));
        // And the leader's own record of the same mirror is what a follower reads back.
        assert_eq!(stream_phases(&mirror).len(), 3);
    }

    /// T-2979: a stream whose author's last processor drops every message writes through its
    /// processors (the vehicles reaper deletes with an `http` one) and is not watched for a
    /// stall; its processors' errors still say NothingWritten, and a stream that writes through
    /// its output with the same counters is still Stalled.
    #[test]
    fn a_stream_that_drops_every_message_at_the_end_is_not_stalled() {
        use crate::reconciler::stall::{StallWatch, WINDOW};
        const REAPER: &str = "pipeline:\n  processors:\n    - mapping: root = this\n    - http:\n        url: http://gw/delete\n    - mapping: root = deleted()\n";
        const FILTER: &str =
            "pipeline:\n  processors:\n    - mapping: root = if this.stale { deleted() }\n";
        let took = |received: u64, errors: u64| {
            format!(
                "input_received{{label=\"input\",stream=\"p\"}} {received}\n\
                 output_sent{{label=\"output\",stream=\"p\"}} 0\n\
                 processor_error{{label=\"processor_1\",stream=\"p\"}} {errors}\n"
            )
        };
        let start = std::time::Instant::now();
        let later = start + WINDOW;
        let verdicts = |bento: &str, errors: u64| {
            let stalls = StallWatch::default();
            let first = writing_verdict(
                &stalls,
                ("hel", "p"),
                Some(&took(12, errors)),
                Some(bento),
                start,
            );
            let second = writing_verdict(
                &stalls,
                ("hel", "p"),
                Some(&took(24, errors)),
                Some(bento),
                later,
            );
            (
                first.map(|(reason, _)| reason),
                second.map(|(reason, _)| reason),
            )
        };

        assert_eq!(verdicts(REAPER, 0), (None, None));
        assert_eq!(
            verdicts(REAPER, 3),
            (Some("NothingWritten"), Some("NothingWritten"))
        );
        assert_eq!(verdicts(FILTER, 0), (None, Some("Stalled")));
        // No bento.yaml at all (an inline compute): watched as before.
        let stalls = StallWatch::default();
        assert!(writing_verdict(&stalls, ("hel", "p"), Some(&took(12, 0)), None, start).is_none());
        assert_eq!(
            writing_verdict(&stalls, ("hel", "p"), Some(&took(24, 0)), None, later).map(|(r, _)| r),
            Some("Stalled")
        );
    }

    /// T-2880: an HTTP source's `authorization.headerRef` reaches the runner under the name its
    /// compiled stream reads (`DS_{SOURCE}_{KEY}`), beside the Pipeline's own `secretRefs`.
    #[test]
    fn an_http_sources_header_credential_is_resolved_for_its_pipeline() {
        use crate::resource::{ObjectMeta, ResourceEnvelope, API_VERSION};
        let envelope = |kind: &str, name: &str, spec: serde_json::Value| ResourceEnvelope {
            api_version: API_VERSION.to_owned(),
            kind: kind.to_owned(),
            metadata: ObjectMeta::new(name, "praha"),
            spec,
            status: None,
        };
        let mirror = Mirror::new();
        mirror.upsert(envelope(
            "DataSource",
            "golemio-park-and-ride",
            serde_json::json!({
                "type": "http",
                "http": {
                    "url": "https://api.golemio.cz/v3/parking-measurements",
                    "verb": "GET",
                    "authorization": {
                        "header": "X-Access-Token",
                        "headerRef": { "name": "golemio", "key": "token" }
                    }
                }
            }),
        ));
        let pipeline = envelope(
            "Pipeline",
            "park-and-ride-occupancy",
            serde_json::json!({
                "source": { "dataSourceRef": { "kind": "DataSource", "name": "golemio-park-and-ride" } },
                "secretRefs": [{ "name": "extra", "key": "k", "envVar": "EXTRA" }]
            }),
        );
        let references = pipeline_references(&mirror, "praha", &pipeline);
        let named: Vec<(&str, Option<&str>)> = references
            .iter()
            .map(|r| (r.name.as_str(), r.env_var.as_deref()))
            .collect();
        assert_eq!(
            named,
            [
                ("extra", Some("EXTRA")),
                ("golemio", Some("DS_GOLEMIO_PARK_AND_RIDE_TOKEN"))
            ]
        );
        // A source that names no credential adds none.
        mirror.upsert(envelope(
            "DataSource",
            "golemio-park-and-ride",
            serde_json::json!({ "type": "http", "http": { "url": "https://example.org/x", "verb": "GET" } }),
        ));
        assert_eq!(pipeline_references(&mirror, "praha", &pipeline).len(), 1);
    }
}
