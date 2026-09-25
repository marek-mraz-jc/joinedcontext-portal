//! Shared application state: configuration, the discovered OIDC client and the
//! back-channel logout marks.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use axum::extract::FromRef;
use axum_extra::extract::cookie::Key;

use crate::agents::events::AgentEventHub;
use crate::agents::store::AgentStore;
use crate::auth::bearer::BearerVerifier;
use crate::auth::oidc::OidcClient;
use crate::auth::session::Session;
use crate::branding::Branding;
use crate::config::Config;
use crate::git::GiteaClient;
use crate::ops::drafts::{DraftHub, DraftStore};
use crate::reconciler::{Leadership, StreamDeployer, Syncer};
use crate::store::Mirror;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    /// `None` when no Keycloak realm is configured: login answers 503, every protected
    /// route answers 401. Fail closed.
    pub oidc: Option<Arc<OidcClient>>,
    /// Verifies `Authorization: Bearer` tokens against the realm JWKS. `None` without a realm:
    /// every bearer call answers 401. Fail closed.
    pub bearer: Option<Arc<BearerVerifier>>,
    pub mirror: Arc<Mirror>,
    /// `None` when no forge is configured: every write answers 503. A Portal that cannot
    /// open a merge request must not fall back to a local write (CC-03).
    pub gitea: Option<Arc<GiteaClient>>,
    /// Where application repositories are copied to on GitHub (AP-79). `None` when the
    /// installation keeps them on its forge alone.
    pub github_mirror: Option<Arc<crate::git::github_mirror::GithubMirror>>,
    pub syncer: Option<Arc<Syncer>>,
    /// The `SyncSource` loop (MF-27…MF-32). `None` without a forge, or when the outbound HTTP
    /// client could not be built: the sync routes answer 503 and nothing syncs, rather than a
    /// loop that quietly reaches nothing.
    pub sync: Option<Arc<crate::sync::driver::Driver>>,
    /// The preferences tier (UI-09). `None` without a database: the preferences routes answer
    /// 503 and nothing else notices.
    pub db: Option<sqlx::PgPool>,
    /// The people of the realm, through the admin client (PF-90). `None` without that client:
    /// the people routes then answer 503.
    pub people: Option<Arc<crate::people::People>>,
    /// Builder runs and their event streams (AG-43, AG-45). Always present, durable only when
    /// there is a database; [`AgentStore::is_durable`] is what says which.
    pub agents: Arc<AgentStore>,
    /// The live half of a run's stream: what a connected browser is handed as the events
    /// arrive, while the store is what a reconnecting one replays from (AG-45).
    pub agent_events: Arc<AgentEventHub>,
    /// Drafts shared across browser windows, assistant runs and MCP clients (AG-61, UI-47).
    pub drafts: DraftStore,
    /// Live hub for draft change events (UI-47).
    pub draft_events: DraftHub,
    /// The workspace registry (CC-76): durable with a database, in memory without one.
    pub workspaces: crate::ops::workspaces::WorkspaceStore,
    /// The renders of running workspace previews, by branch head (CC-78).
    pub previews: Arc<crate::ops::previews::Renders>,
    /// What is happening in a project (UI-31, OPS-48). Always present, durable only when there
    /// is a database: without one, the Portal shows what happened since it started.
    pub activity: crate::activity::ActivityStore,
    /// The live half of the activity stream: the tail a connected browser follows.
    pub activity_events: crate::activity::ActivityHub,
    /// What authorises a run through the sync webhook route, by source (MF-44). Always present;
    /// empty until the reconciler has resolved a pass, so the door is shut before it is opened.
    pub webhook_secrets: Arc<crate::sync::webhook_secrets::Accepted>,
    /// The compiled model of every space that names one: what the reconciler renders the
    /// validation stage from and the rejected route names a rule by (PL-60, PL-61).
    pub model_schemas: Arc<crate::pipeline_validation::ModelSchemas>,
    /// The records each pipeline's stage refused (PL-61): durable with a database, in memory
    /// without one.
    pub rejected: Arc<crate::pipeline_outcomes::RejectedStore>,
    /// Each pipeline's runs and their log (PL-62), durable with a database.
    pub pipeline_log: Arc<crate::pipeline_log::LogStore>,
    /// What the last drift scan found, by project (CC-21). Always present; empty until the
    /// reconciler has run one, which is a different answer from "nothing drifted".
    pub drift: Arc<crate::reconciler::drift::Store>,
    /// What the last data-quality run found, by space (DM-74). Empty until the leader has run
    /// one, which the API answers as "not checked yet".
    pub quality: Arc<crate::quality::Store>,
    /// The space surface a resolution writes through (UI-26). `None` without a gateway address
    /// or a realm client: the two buttons answer 503 rather than writing nowhere.
    pub drift_watch: Option<Arc<crate::reconciler::drift::Watch>>,
    /// The realm's clients and groups this platform did not create, as the last reconcile run
    /// listed them (AP-114, AP-115). Always present; empty until a run has listed the realm.
    pub foreign_names: Arc<crate::reconciler::foreign::ForeignNames>,
    /// Where a workspace Job is written. `None` outside a cluster, exactly like
    /// `app_settings`: a run is then refused rather than scheduled nowhere (AG-33).
    pub kube: Option<Arc<crate::apps::kube::KubeClient>>,
    /// Where a run tests each version before it offers publication (SDK-38). `None` without the
    /// sandbox's settings or outside a cluster: the run says its tests were not run.
    pub app_tests: Option<Arc<crate::agents::sandbox::Sandbox>>,
    /// `sub` → unix second of the last back-channel logout for that user. Sessions issued
    /// at or before the mark are refused.
    /// ponytail: per-replica map; move it to the preferences database when the portal
    /// runs more than one replica (the reconciler is leader-elected, the UI is not).
    revocations: Arc<RwLock<HashMap<String, i64>>>,
    /// What each bearer subject has spent on `/api/v1/mcp` in the current minute (AG-60): the
    /// unix second the window opened and the calls counted in it.
    /// ponytail: per-replica map, like `revocations`; one bucket per subject is enough while
    /// the Portal is one replica.
    mcp_calls: Arc<RwLock<HashMap<String, (i64, u32)>>>,
    /// The MCP calls that outlive their request (AG-60): a client starts one, polls it and
    /// reads its result through `tasks/*`.
    pub mcp_tasks: crate::mcp::tasks::McpTasks,
    /// The questions a Yellow or Red MCP call is waiting on (AG-63).
    pub mcp_elicitations: crate::mcp::elicitation::McpElicitations,
}

/// How long a logout mark is kept: a day past the longest a session lives, so no session can
/// outlive the mark that refuses it (PF-11).
const REVOCATION_TTL_SECS: i64 = 48 * 3600;

impl AppState {
    /// The forge client for `project`'s own files (CC-87): in layout 2 its own repository,
    /// spoken to in render paths (`projects/{project}/…`); the organization repository
    /// otherwise. `None` when no forge is configured.
    pub fn forge_for(&self, project: &str) -> Option<Arc<GiteaClient>> {
        let organization = self.gitea.as_ref()?;
        Some(match self.mirror.repository_of(project) {
            Some(repository) => Arc::new(organization.for_project(repository, project)),
            None => Arc::clone(organization),
        })
    }

    pub fn new(config: Config, oidc: Option<OidcClient>) -> Self {
        let bearer = config
            .oidc
            .as_ref()
            .map(|o| Arc::new(BearerVerifier::new(&o.issuer, &o.client_id)));
        let draft_events = DraftHub::new();
        let drafts = DraftStore::new(None).with_hub(draft_events.clone());
        let activity_events = crate::activity::ActivityHub::new();
        let activity = crate::activity::ActivityStore::new(None).with_hub(activity_events.clone());
        Self {
            bearer,
            config: Arc::new(config),
            oidc: oidc.map(Arc::new),
            mirror: Arc::new(Mirror::new()),
            gitea: None,
            github_mirror: None,
            syncer: None,
            sync: None,
            db: None,
            agents: Arc::new(AgentStore::new(None)),
            agent_events: Arc::new(AgentEventHub::new()),
            drafts,
            draft_events,
            workspaces: crate::ops::workspaces::WorkspaceStore::new(None),
            previews: Arc::default(),
            activity,
            activity_events,
            webhook_secrets: Arc::new(crate::sync::webhook_secrets::Accepted::new()),
            drift: Arc::new(crate::reconciler::drift::Store::default()),
            quality: Arc::new(crate::quality::Store::default()),
            model_schemas: Arc::default(),
            rejected: Arc::new(crate::pipeline_outcomes::RejectedStore::new(None)),
            pipeline_log: Arc::new(crate::pipeline_log::LogStore::new(None)),
            drift_watch: None,
            foreign_names: Arc::default(),
            people: None,
            kube: None,
            app_tests: None,
            revocations: Arc::new(RwLock::new(HashMap::new())),
            mcp_calls: Arc::new(RwLock::new(HashMap::new())),
            mcp_tasks: crate::mcp::tasks::McpTasks::new(),
            mcp_elicitations: crate::mcp::elicitation::McpElicitations::new(),
        }
    }

    /// A run's test sandbox (SDK-38), as a test gives it one.
    pub fn with_app_tests(mut self, sandbox: Arc<crate::agents::sandbox::Sandbox>) -> Self {
        self.app_tests = Some(sandbox);
        self
    }

    pub fn with_mirror(mut self, mirror: Arc<Mirror>) -> Self {
        self.mirror = mirror;
        self
    }

    pub fn with_gitea(mut self, gitea: Arc<GiteaClient>) -> Self {
        self.gitea = Some(gitea);
        self
    }

    pub fn with_github_mirror(
        mut self,
        mirror: Arc<crate::git::github_mirror::GithubMirror>,
    ) -> Self {
        self.github_mirror = Some(mirror);
        self
    }

    pub fn with_syncer(mut self, syncer: Arc<Syncer>) -> Self {
        self.syncer = Some(syncer);
        self
    }

    pub fn with_db(mut self, db: sqlx::PgPool) -> Self {
        self.agents = Arc::new(AgentStore::new(Some(db.clone())));
        self.drafts = DraftStore::new(Some(db.clone())).with_hub(self.draft_events.clone());
        self.draft_events.connect(db.clone());
        self.workspaces = crate::ops::workspaces::WorkspaceStore::new(Some(db.clone()));
        self.activity = crate::activity::ActivityStore::new(Some(db.clone()))
            .with_hub(self.activity_events.clone());
        self.rejected = Arc::new(crate::pipeline_outcomes::RejectedStore::new(Some(
            db.clone(),
        )));
        self.pipeline_log = Arc::new(crate::pipeline_log::LogStore::new(Some(db.clone())));
        self.db = Some(db);
        self
    }

    /// Builds the state for a configuration, discovering the Keycloak realm when one is set and
    /// picking up the forge from the environment. Both failures are fatal at startup: the caller
    /// only prints them, so one boxed error is enough for the two kinds.
    pub async fn from_config(
        config: Config,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let oidc = match config.oidc.as_ref() {
            Some(oidc_config) => {
                Some(OidcClient::discover(oidc_config, &config.redirect_uri()).await?)
            }
            None => None,
        };
        // A half-configured forge is a configuration error, not a reason to run without one:
        // `from_env` answers `Ok(None)` only when all four variables are absent.
        let gitea = GiteaClient::from_env(|key| std::env::var(key).ok())?;
        // The same rule for the GitHub copy of application repositories (AP-79): off when both
        // of its variables are absent, a startup error when only one is.
        let github_mirror =
            crate::git::github_mirror::GithubMirror::from_env(|key| std::env::var(key).ok())?;
        // A configured database that cannot be reached or migrated is fatal, like a half-configured
        // forge: better one clear startup error than a Portal that silently forgets preferences.
        let db = match config.database_url.as_deref() {
            Some(url) => Some(crate::db::connect(url).await?),
            None => None,
        };
        let mut state = Self::new(config, oidc);
        state.agents = Arc::new(AgentStore::new(db.clone()));
        if !state.agents.is_durable() {
            tracing::info!(
                "no database: a builder run and its stream live only until this process ends"
            );
        }
        state.drafts = DraftStore::new(db.clone()).with_hub(state.draft_events.clone());
        if let Some(db) = &db {
            state.draft_events.connect(db.clone());
        }
        state.workspaces = crate::ops::workspaces::WorkspaceStore::new(db.clone());
        state.activity =
            crate::activity::ActivityStore::new(db.clone()).with_hub(state.activity_events.clone());
        state.rejected = Arc::new(crate::pipeline_outcomes::RejectedStore::new(db.clone()));
        state.pipeline_log = Arc::new(crate::pipeline_log::LogStore::new(db.clone()));
        state.db = db;
        // What the process before this one refused stays refused (T-0980).
        state.load_revocations().await;
        // A builder run is scheduled into the cluster this Portal runs in (AG-33). The client is
        // the same in-cluster one the app converger uses; outside a cluster it stays `None` and
        // a run is refused rather than recorded with no pod behind it.
        if state.config.agent_settings.is_some() {
            match crate::apps::kube::KubeClient::in_cluster() {
                Ok(Some(kube)) => state.kube = Some(Arc::new(kube)),
                Ok(None) => tracing::info!(
                    "no ServiceAccount mount: a builder run is driven by its caller, not scheduled"
                ),
                Err(err) => tracing::warn!(
                    error = %err,
                    "the ServiceAccount mount is unreadable, so no builder workspace is scheduled"
                ),
            }
        }
        // The run's test sandbox (SDK-38): its own client, in the namespace that fences it.
        if let Some(settings) = state.config.app_tests.clone() {
            match crate::apps::kube::KubeClient::in_cluster() {
                Ok(Some(kube)) => {
                    state.app_tests = Some(Arc::new(crate::agents::sandbox::Sandbox::new(
                        kube, settings,
                    )))
                }
                Ok(None) => tracing::info!(
                    "no ServiceAccount mount: a run's tests are left to the build lane"
                ),
                Err(err) => tracing::warn!(
                    error = %err,
                    "the ServiceAccount mount is unreadable, so a run's tests are left to the build lane"
                ),
            }
        }
        // The people of the realm, managed with the admin client that manages its groups (PF-90).
        if let (Some(oidc), Some((id, secret))) = (
            state.config.oidc.as_ref(),
            state.config.keycloak_admin.clone(),
        ) {
            state.people =
                crate::people::People::new(oidc.issuer.as_str(), id, secret).map(Arc::new);
        }
        // Warm the key cache so the first bearer call does not pay for the fetch; a realm that
        // is down at startup only costs a warning, the next unknown `kid` fetches again.
        if let Some(bearer) = state.bearer.as_ref() {
            if let Err(err) = bearer.refresh().await {
                tracing::warn!(error = %err, "JWKS not loaded at startup");
            }
        }
        if let Some(client) = gitea {
            let client = Arc::new(client);
            let mut syncer = Syncer::new(Arc::clone(&client), Arc::clone(&state.mirror))
                .with_webhook_secrets(Arc::clone(&state.webhook_secrets))
                .with_activity(state.activity.clone())
                .with_pipeline_outcomes(
                    Arc::clone(&state.rejected),
                    Arc::clone(&state.pipeline_log),
                )
                .with_apps_cache_dir(state.config.apps_cache_dir.clone());
            // The root credential of the artifact store reaches this one object and no other,
            // and no workload gets it: every organization is served a derived, scoped pair
            // instead (PF-32, ADR-N-015).
            if let Some(settings) = state.config.artifact_store.clone() {
                match crate::artifact_store::Client::new(settings) {
                    Ok(store) => syncer = syncer.with_artifact_store(Arc::new(store)),
                    Err(err) => {
                        tracing::warn!(error = %err, "the artifact store endpoint is unusable, so no organization credential is issued")
                    }
                }
            }
            // The Secrets this reconciler writes into its own namespace: an organization's
            // artifact-store reader (T-0925) and the pipeline runner's environment (T-0927).
            // Outside a cluster there is nowhere to write one, which is not an error.
            match (
                crate::apps::kube::KubeClient::in_cluster(),
                crate::apps::kube::KubeClient::own_namespace(),
            ) {
                (Ok(Some(kube)), Some(namespace)) => {
                    syncer = syncer.with_credential_secrets(Arc::new(kube), namespace);
                }
                (Err(err), _) => {
                    tracing::warn!(error = %err, "the ServiceAccount mount is unreadable, so no credential is handed over")
                }
                _ => tracing::info!("no cluster: credentials are resolved and handed to nobody"),
            }
            // What resolves a pipeline's `secretRef`s (T-0927, PL-15). Without it a pipeline
            // that declares one is not deployed, with the reason on the Pipeline; the values
            // reach the runner through the same Secret writer the credentials above use.
            if let Some(backend) = state.config.pipeline_secrets.clone() {
                syncer =
                    syncer.with_pipeline_secrets(crate::pipeline_secrets::Resolver::new(backend));
            }

            // A person's removal finishes once its Change is merged (PF-93): the pending ones are
            // in the database, so the step runs only with one and with the realm's admin client.
            if let (Some(people), Some(pool)) = (state.people.clone(), state.db.clone()) {
                syncer = syncer.with_people(people, pool);
            }
            // With a database the replicas elect one reconciler; without one there is nothing
            // to elect with, and a Portal that runs alone reconciles alone (T-0191, CC-03).
            if let Some(pool) = state.db.as_ref() {
                syncer = syncer.with_leadership(Arc::new(Leadership::reconciler(pool.clone())));
                // PF-41: the challenge lives in the database, so the check runs only with one.
                let host = state.config.public_base_url.host_str().map(str::to_owned);
                match (crate::domain_verification::NetLookup::new(), host) {
                    (Ok(lookup), Some(host)) => {
                        syncer = syncer.with_domain_verification(Arc::new(
                            crate::domain_verification::Verifier::new(pool.clone(), lookup, host),
                        ));
                    }
                    (Err(err), _) => {
                        tracing::warn!(error = %err, "no domain is verified: the resolver did not start")
                    }
                    (_, None) => {
                        tracing::warn!("no domain is verified: the public URL names no host")
                    }
                }
            }
            // Applying an app's objects needs two halves: a cluster to write into and the
            // settings that say where. Either missing leaves the reconciler reading apps and
            // deploying nothing, which is what a Portal on a laptop does (T-0411, AP-18). No
            // realm is needed: the login front is the edge's one client (AP-27, ADR-N-019).
            match (
                state.config.app_settings.clone(),
                crate::apps::kube::KubeClient::in_cluster(),
            ) {
                (Some(settings), Ok(Some(kube))) => {
                    // The edge file has its own client: the converger owns the other one.
                    match crate::apps::kube::KubeClient::in_cluster() {
                        Ok(Some(edge_kube)) => {
                            let namespace = settings.apisix_namespace.clone();
                            syncer = syncer.with_edge_file(
                                Arc::new(crate::reconciler::edge_file::EdgeFile::new(
                                    edge_kube, namespace,
                                )),
                                settings.clone(),
                            );
                        }
                        _ => tracing::warn!(
                            "no second API client: the edge serves helm's base alone"
                        ),
                    }
                    syncer = syncer.with_converger(Arc::new(
                        crate::apps::converge::Converger::new(kube, settings),
                    ));
                }
                (_, Err(err)) => {
                    tracing::warn!(error = %err, "the ServiceAccount mount is unreadable, so no app is deployed")
                }
                _ => tracing::info!("no app settings or no cluster: apps are read, not deployed"),
            }
            // The realm's managed groups (PF-63). Without an admin client the manifests are
            // still read and served; nothing in the realm is written.
            match (
                state.config.oidc.as_ref(),
                state.config.keycloak_admin.clone(),
            ) {
                (Some(oidc), Some((id, secret))) => {
                    match crate::reconciler::groups::GroupSync::new(
                        oidc.issuer.as_str(),
                        id,
                        secret,
                    ) {
                        Some(groups) => {
                            syncer = syncer.with_groups(Arc::new(
                                groups.with_foreign(Arc::clone(&state.foreign_names)),
                            ))
                        }
                        None => tracing::warn!(
                            "the issuer is not a realm URL, so no Keycloak group is managed"
                        ),
                    }
                }
                _ => tracing::info!(
                    "no Keycloak admin client: Group manifests are read, the realm is not written"
                ),
            }
            // Every published App's own client (ADR-N-030, AP-111). It is written as the Portal
            // client's own service account, the one identity the realm gives `manage-clients`;
            // the group credential above stays limited to group memberships (T-0411, T-0866).
            match (
                state.config.oidc.as_ref(),
                state
                    .config
                    .app_settings
                    .as_ref()
                    .map(|settings| settings.host.clone()),
            ) {
                (Some(oidc), Some(host)) => {
                    match crate::reconciler::app_clients::AppClientSync::new(
                        oidc.issuer.as_str(),
                        oidc.client_id.clone(),
                        oidc.client_secret().to_owned(),
                        host,
                    ) {
                        Some(clients) => {
                            syncer = syncer.with_app_clients(Arc::new(
                                clients.with_foreign(Arc::clone(&state.foreign_names)),
                            ))
                        }
                        None => tracing::warn!(
                            "the issuer is not a realm URL, so no App client is managed"
                        ),
                    }
                }
                _ => tracing::info!("no login client or no apps host: no App client is managed"),
            }
            // Every ServiceAccount bound to a workload gets its federated client (PF-47), written
            // by the same identity as the App clients.
            if let Some(oidc) = state.config.oidc.as_ref() {
                match crate::reconciler::workload_clients::WorkloadClientSync::new(
                    oidc.issuer.as_str(),
                    oidc.client_id.clone(),
                    oidc.client_secret().to_owned(),
                ) {
                    Some(clients) => syncer = syncer.with_workload_clients(Arc::new(clients)),
                    None => tracing::warn!(
                        "the issuer is not a realm URL, so no workload client is managed"
                    ),
                }
            }
            if let Some(url) = state.config.pipeline_runner_url.clone() {
                let deployer = StreamDeployer::new(url);
                // A refused record reaches the Portal on the listener the test harness reaches
                // (PL-61); without that address the stream writes as it did, unvalidated.
                let deployer = match state.config.pipeline_test_capture_url.clone() {
                    Some(internal) => {
                        deployer.with_validation(internal, Arc::clone(&state.model_schemas))
                    }
                    None => {
                        tracing::warn!("no internal listener address for the runner: pipelines are not validated before they write");
                        deployer
                    }
                };
                syncer = syncer.with_streams(Arc::new(deployer));
            } else {
                tracing::info!("no pipeline runner: DataSource pipelines stay Pending");
            }
            // A declared Subscription reaches its space through the space surface, as this
            // Portal's own service account (T-0931, CC-72). Without the address, the realm
            // client or the organization's domain there is no write to make: the manifests are
            // read and served, and no broker is touched.
            match (
                state.config.gateway_url.clone(),
                state.config.oidc.as_ref(),
                state.config.keycloak_admin.clone(),
                state.config.org_domain.clone(),
            ) {
                (Some(base), Some(oidc), Some((id, secret)), Some(domain)) => {
                    syncer = syncer.with_subscriptions(Arc::new(
                        crate::reconciler::subscriptions::SubscriptionSync::new(
                            base,
                            oidc.issuer.as_str(),
                            id,
                            secret,
                            domain,
                        ),
                    ));
                }
                _ => tracing::info!(
                    "no gateway address, realm client or organization domain: Subscription \
                     manifests are read, no broker is written"
                ),
            }
            // An Endpoint that declares `spec.publish.ckan` becomes a dataset in its catalogue on
            // every run, and one that stopped declaring it loses the dataset (EP-62, T-2405). The
            // host is this Portal's own public host, which is where the endpoints answer; the
            // token comes from the instance's `apiTokenRef`, through the repository's encrypted
            // secrets when this Portal holds the age identity, and otherwise from the variable the
            // reference itself names.
            {
                let age_key_file = match state.config.pipeline_secrets.as_ref() {
                    Some(crate::pipeline_secrets::Backend::Sops { age_key_file }) => {
                        Some(age_key_file.clone())
                    }
                    _ => None,
                };
                let host = state
                    .config
                    .public_base_url
                    .host_str()
                    .unwrap_or("localhost")
                    .to_owned();
                let mut catalogue =
                    crate::reconciler::ckan::CkanSync::new(host).with_age_key_file(age_key_file);
                let organisation =
                    crate::branding::Branding::load(state.config.branding_file.as_deref())
                        .organisation;
                if !organisation.trim().is_empty() {
                    catalogue = catalogue.titled(organisation);
                }
                syncer = syncer.with_ckan(Arc::new(catalogue));
            }

            // A declared ContextSourceRegistration is written straight at the broker, in the
            // tenant of its hub space (T-0345, SP-08): it is a control-plane act with no
            // gateway operation behind it and no credential on the hop. Without the broker's
            // address the manifests are read and served and no hub is federated.
            match state.config.broker_url.clone() {
                Some(broker) => {
                    syncer = syncer.with_registrations(Arc::new(
                        crate::reconciler::registrations::RegistrationSync::new(broker),
                    ));
                }
                None => tracing::info!(
                    "no broker address: ContextSourceRegistration manifests are read, no hub is \
                     federated"
                ),
            }
            // Drift (CC-21, UI-25, UI-26): the seed entities a space declares, against what it
            // holds. Configuration cannot drift under T-0421's option B — every component reads
            // it from the repository — so this is the whole of what drift means here. Without
            // the space surface or the realm client there is nothing to compare against, and
            // the API answers "never scanned" rather than "nothing drifted".
            match (
                state.config.gateway_url.clone(),
                state.config.oidc.as_ref(),
                state.config.keycloak_admin.clone(),
            ) {
                (Some(base), Some(oidc), Some((id, secret))) => {
                    let watch = Arc::new(crate::reconciler::drift::Watch::new(
                        base,
                        oidc.issuer.as_str(),
                        id,
                        secret,
                    ));
                    // One watch, two readers: the reconciler scans with it and a resolution
                    // writes through it, so the buttons cannot reach a surface the scan did not.
                    state.drift_watch = Some(Arc::clone(&watch));
                    // The daily data-quality run reads through the same client (DM-74).
                    syncer = syncer.with_quality(Arc::new(crate::quality::Scanner {
                        watch: Arc::clone(&watch),
                        schemas: Arc::clone(&state.model_schemas),
                        mirror: Arc::clone(&state.mirror),
                        org_domain: state.config.org_domain.clone().unwrap_or_default(),
                        store: Arc::clone(&state.quality),
                    }));
                    syncer = syncer.with_drift(watch, Arc::clone(&state.drift));
                }
                _ => tracing::info!(
                    "no gateway address or realm client: seed entities are never compared, so \
                     the drift surface answers that no scan has run"
                ),
            }
            // The `SyncSource` loop needs the forge and a way out to the origins. Without the
            // second there is no loop at all: a driver that cannot fetch would report every
            // source as failing every minute (MF-27).
            match crate::sync::remote::HttpRemote::new() {
                Ok(remote) => {
                    let states = Arc::new(crate::sync::state::States::new(state.db.clone()));
                    if !states.is_durable() {
                        tracing::info!(
                            "no database: sync sources remember their runs only until this \
                             process ends"
                        );
                    }
                    state.sync = Some(Arc::new(crate::sync::driver::Driver::new(
                        Arc::clone(&client),
                        states,
                        Arc::new(remote),
                    )));
                }
                Err(err) => {
                    tracing::warn!(error = %err, "no HTTP client for sync origins; sync sources do not run")
                }
            }
            state.gitea = Some(client);
            state.syncer = Some(Arc::new(syncer));
        }
        // A copy has nothing to copy without the forge it mirrors.
        match (github_mirror, state.gitea.is_some()) {
            (Some(mirror), true) => state.github_mirror = Some(Arc::new(mirror)),
            (Some(_), false) => tracing::warn!(
                "JC_APP_MIRROR_GITHUB_OWNER is set but no forge is configured: application \
                 repositories are not copied to GitHub"
            ),
            (None, _) => {}
        }
        Ok(state)
    }

    /// Marks every session of a subject as logged out (OIDC back-channel logout).
    ///
    /// The mark is written to the database as well as to this process, because a restart used
    /// to clear every mark and re-accept sessions somebody had logged out for as long as their
    /// cookie lived (T-0980). Without a database the mark is this process's alone, which is what
    /// a Portal without one can honestly promise.
    pub async fn revoke_subject(&self, subject: &str, at: i64) {
        if let Ok(mut marks) = self.revocations.write() {
            let mark = marks.entry(subject.to_string()).or_insert(at);
            *mark = (*mark).max(at);
        }
        let Some(db) = self.db.as_ref() else {
            return;
        };
        // A mark outlives every session it could refuse: `REVOCATION_TTL` past the mark itself.
        if let Err(error) = sqlx::query(
            "INSERT INTO revocations (subject, revoked_at, expires_at) VALUES ($1, $2, $3) \
             ON CONFLICT (subject) DO UPDATE SET \
               revoked_at = GREATEST(revocations.revoked_at, EXCLUDED.revoked_at), \
               expires_at = GREATEST(revocations.expires_at, EXCLUDED.expires_at)",
        )
        .bind(subject)
        .bind(at)
        .bind(
            time::OffsetDateTime::from_unix_timestamp(at + REVOCATION_TTL_SECS)
                .unwrap_or_else(|_| time::OffsetDateTime::now_utc()),
        )
        .execute(db)
        .await
        {
            // The mark holds in this process either way; saying so is what a restart needs.
            tracing::error!(%error, "a logout mark was not persisted and a restart will lose it");
        }
    }

    /// Reads the marks a previous process wrote, and drops the ones no session can outlive.
    ///
    /// ponytail: one read at startup, because one replica serves the UI. A second replica would
    /// also have to see a mark the first one wrote, which is a read on the session path or a
    /// notification — neither is worth its cost while the Deployment is one pod.
    pub async fn load_revocations(&self) {
        let Some(db) = self.db.as_ref() else {
            return;
        };
        if let Err(error) = sqlx::query("DELETE FROM revocations WHERE expires_at < now()")
            .execute(db)
            .await
        {
            tracing::warn!(%error, "old logout marks were not trimmed");
        }
        match sqlx::query_as::<_, (String, i64)>(
            "SELECT subject, revoked_at FROM revocations WHERE expires_at >= now()",
        )
        .fetch_all(db)
        .await
        {
            Ok(rows) => {
                if let Ok(mut marks) = self.revocations.write() {
                    for (subject, at) in rows {
                        let mark = marks.entry(subject).or_insert(at);
                        *mark = (*mark).max(at);
                    }
                    tracing::info!(marks = marks.len(), "logout marks read back");
                }
            }
            Err(error) => tracing::error!(
                %error,
                "logout marks could not be read: a session logged out before this start is \
                 accepted again until its cookie expires"
            ),
        }
    }

    /// Counts one MCP call of this subject and says whether it is within the minute's budget
    /// (AG-60). The Portal counts for itself: the edge's bucket is keyed by the raw token and
    /// does not exist for a caller inside the cluster.
    pub fn mcp_call_allowed(&self, subject: &str, limit: u32, now: i64) -> bool {
        let Ok(mut calls) = self.mcp_calls.write() else {
            // A poisoned lock must not open the door wider than it was.
            return false;
        };
        // ponytail: a fixed window that restarts a minute after its first call; a sliding
        // window is the upgrade if bursts at the boundary ever matter.
        let entry = calls.entry(subject.to_string()).or_insert((now, 0));
        if now - entry.0 >= 60 {
            *entry = (now, 0);
        }
        if entry.1 >= limit {
            return false;
        }
        entry.1 += 1;
        true
    }

    pub fn is_revoked(&self, session: &Session) -> bool {
        self.revocations
            .read()
            .ok()
            .and_then(|marks| marks.get(&session.identity.subject).copied())
            .is_some_and(|mark| session.issued_at <= mark)
    }

    /// The branding of this installation, loaded from `JC_BRANDING_FILE` or neutral defaults.
    pub fn branding(&self) -> Branding {
        Branding::load(self.config.branding_file.as_deref())
    }
}

impl FromRef<AppState> for Key {
    fn from_ref(state: &AppState) -> Key {
        state.config.cookie_key.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::session::{now_unix, Identity};

    fn session(subject: &str, issued_at: i64) -> Session {
        Session {
            identity: Identity {
                client: None,
                subject: subject.into(),
                username: "demo.steward".into(),
                email: None,
                name: None,
                roles: Vec::new(),
                groups: Vec::new(),
            },
            expires_at: issued_at + 600,
            issued_at,
            id_token: String::new(),
            access_expires_at: issued_at + 600,
            refresh_token: None,
        }
    }

    #[tokio::test]
    async fn back_channel_logout_revokes_older_sessions_only() {
        let state = AppState::new(Config::for_tests(), None);
        let now = now_unix();
        let old = session("sub-1", now - 10);
        let fresh = session("sub-1", now + 10);
        assert!(!state.is_revoked(&old));

        state.revoke_subject("sub-1", now).await;
        assert!(
            state.is_revoked(&old),
            "session issued before the logout must be refused"
        );
        assert!(!state.is_revoked(&fresh), "a later login must still work");
        assert!(
            !state.is_revoked(&session("sub-2", now - 10)),
            "other users are untouched"
        );
    }

    /// T-0980: without a database the mark is this process's alone, and saying so is the point
    /// of the two paths — neither may panic or lose the in-memory mark.
    #[tokio::test]
    async fn a_portal_without_a_database_still_marks_and_reads_back_nothing() {
        let state = AppState::new(Config::for_tests(), None);
        let now = now_unix();
        state.revoke_subject("sub-1", now).await;
        state.load_revocations().await;
        assert!(state.is_revoked(&session("sub-1", now - 1)));
    }

    /// The mark only ever moves forward: a later logout refuses more, an earlier one refuses
    /// nothing it did not already.
    #[tokio::test]
    async fn a_mark_never_moves_backwards() {
        let state = AppState::new(Config::for_tests(), None);
        let now = now_unix();
        state.revoke_subject("sub-1", now).await;
        state.revoke_subject("sub-1", now - 100).await;
        assert!(
            state.is_revoked(&session("sub-1", now - 1)),
            "the later mark stands"
        );
    }
}
