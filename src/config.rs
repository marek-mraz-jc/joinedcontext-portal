use axum_extra::extract::cookie::Key;
use std::net::SocketAddr;
use std::time::Duration;
use url::Url;

/// Portal server configuration. Secrets are redacted in `Debug` so a config dump
/// never puts a client secret or a cookie key into the log (CC-40).
#[derive(Clone)]
pub struct Config {
    /// The address to listen on (`JC_PORTAL_BIND`, default `0.0.0.0:8080`).
    pub bind: SocketAddr,
    /// The address a browser reaches this Portal at (`JC_PORTAL_PUBLIC_URL`, default
    /// `http://localhost:8080`). Every redirect URI, every link the Portal writes into a merge
    /// request and the host a generated application is served on are derived from it.
    pub public_base_url: Url,
    /// The realm humans sign in against: `JC_OIDC_ISSUER`, `JC_OIDC_CLIENT_ID` and
    /// `JC_OIDC_CLIENT_SECRET` (a secret), all three together or none, plus the optional
    /// `JC_OIDC_CA_FILE` for a realm behind a private CA.
    ///
    /// `None` disables login: no session can be minted, so every protected route
    /// answers 401. Configuration is fail-closed, never fail-open.
    pub oidc: Option<OidcConfig>,
    /// Whether an `X-Access-Token` header is believed to come from the APISIX edge and is
    /// verified as if it were `Authorization: Bearer` (ADR-N-019, AP-28). The deployment sets
    /// it behind the edge, which strips the header from every client request first; a Portal
    /// without an edge in front leaves it off and the header is ignored
    /// (`JC_TRUST_EDGE_TOKEN`, the literal string `true` to turn it on; default `false`).
    pub trust_edge_token: bool,
    /// What the deployment says it switched on, for the organization setup page (T-2748).
    pub setup: SetupStatements,
    /// The key every session cookie is sealed with (`JC_PORTAL_COOKIE_KEY`, at least 64
    /// bytes). A secret. Unset means an ephemeral key: the Portal runs, and every session ends
    /// at the next restart.
    pub cookie_key: Key,
    /// Keys a session cookie may still be sealed with, during a rotation
    /// (`JC_PORTAL_COOKIE_KEY_PREVIOUS`, comma-separated, each held to the same length as the
    /// active one; T-0973). Secrets.
    ///
    /// A cookie key is the Portal's alone, so unlike the webhook secret it can change in one
    /// step — but every signed-in person's cookie is sealed with the old one, and swapping the
    /// key without a window signs everybody out. The active key seals; these only open, and a
    /// key stays here for as long as a session sealed with it may live.
    pub cookie_keys_previous: Vec<Key>,
    /// How often the reconciler re-reads the configuration repository
    /// (`JC_PORTAL_SYNC_INTERVAL`, whole seconds, default `60`).
    pub sync_interval: Duration,
    /// The secret the forge signs its webhook calls with (`JC_GITEA_WEBHOOK_SECRET`). A
    /// secret. `None` leaves the hook route refusing every call, so a change is picked up at
    /// the next sync rather than at the push.
    pub gitea_webhook_secret: Option<String>,
    /// The secret this Portal accepted before the current one, during a rotation
    /// (`JC_GITEA_WEBHOOK_SECRET_PREVIOUS`). A secret (T-0982).
    ///
    /// A webhook secret is shared with the forge, so the two sides cannot change at the same
    /// instant: the new one is written here as the active secret and the old one stays accepted
    /// until the forge's own hook is updated, then it is removed. Without it a rotation is a
    /// window in which every push is refused, which is why nobody rotates.
    pub gitea_webhook_secret_previous: Option<String>,
    /// Base URL of a project's Bento pipeline runner with `{project}` still in it, e.g.
    /// `http://pipeline-runner.{project}-pipeline-runner.svc.cluster.local:4195`
    /// (`JC_PORTAL_PIPELINE_RUNNER_URL`). `None` leaves the metrics route answering 503
    /// instead of guessing a service name.
    pub pipeline_runner_url: Option<String>,
    /// The platform host the context spaces are served on, which is where a declared
    /// `Subscription` is written (`JC_PORTAL_GATEWAY_URL`,
    /// `/cs/{space}/ngsi-ld/v1/subscriptions`, T-0931). `None`
    /// leaves subscriptions read from the repository and written nowhere.
    pub gateway_url: Option<String>,
    /// The Keycloak client the Context Gateway holds (`JC_PORTAL_GATEWAY_CLIENT_ID`), which
    /// is the only caller `GET /internal/previews` answers (PF-46, AG-52). `None` leaves that route refusing every call:
    /// a Portal that was not told whose token to expect must not fall back to trusting the
    /// NetworkPolicy alone.
    pub gateway_client_id: Option<String>,
    /// The Keycloak client `jc-agent-proxy` holds (`JC_PORTAL_AGENT_PROXY_CLIENT_ID`), which is
    /// the only caller the run callbacks on the internal listener answer (AG-52, T-2271). It replaced `JC_AGENT_PROXY_TOKEN`, one string both
    /// sides held. `None` leaves those routes refusing every call.
    pub agent_proxy_client_id: Option<String>,
    /// The Keycloak client the project's pipeline runner holds
    /// (`JC_PORTAL_PIPELINE_RUNNER_CLIENT_ID`), which is the only caller
    /// `POST /internal/pipeline-tests/{id}` answers (AG-52, T-2271). `None` refuses every call.
    pub pipeline_runner_client_id: Option<String>,
    /// The context broker as the Portal reaches it inside the cluster, which is where a
    /// declared `ContextSourceRegistration` is written, in the tenant of its hub space
    /// (`POST /ngsi-ld/v1/csourceRegistrations`, T-0345, SP-08). It is also the address the
    /// registration tells the broker to read a member at, because a hub reads a member's tenant
    /// on the same broker (PF-48; `JC_PORTAL_BROKER_URL`). `None` leaves registrations read
    /// from the repository and written nowhere.
    pub broker_url: Option<String>,
    /// The organization's domain, the third segment of every URN this instance writes
    /// (`JC_PORTAL_ORG_DOMAIN`; `urn:ngsi-ld:{Type}:{orgDomain}:{space}:{localId}`).
    pub org_domain: Option<String>,
    /// Where a pipeline test's harness posts what it produced (PL-43): the Portal's internal
    /// listener as the project's runner reaches it, e.g. `http://portal-internal:9090`
    /// (`JC_PORTAL_PIPELINE_TEST_CAPTURE_URL`). `None` means the test route answers 503.
    pub pipeline_test_capture_url: Option<String>,
    /// Base URL of the stateless Model Tools service (`JC_PORTAL_MODEL_TOOLS_URL`), e.g.
    /// `http://model-tools.tools.svc.cluster.local:8080`. `None` leaves the LinkML preview
    /// routes answering 503 instead of guessing a service name (DM-18).
    pub model_tools_url: Option<String>,
    /// Base URL of the `jc-functions` runtime (`JC_FUNCTIONS_URL`), e.g.
    /// `http://jc-functions.jc-system.svc.cluster.local:8080`. `None` leaves the function routes
    /// answering 503 (SDK-23).
    pub functions_url: Option<String>,
    /// Root of the built app bundles, one directory per app (`JC_PORTAL_APPS_DIR`). `None`
    /// leaves every
    /// `/apps/{name}/` path answering 404 rather than reading a guessed directory (AP-14).
    pub apps_dir: Option<String>,
    /// Where this replica keeps the builds it fetched from the package registry, one
    /// `{name}/{hex}` directory per build (`JC_PORTAL_APPS_CACHE_DIR`, AP-102); it must be
    /// writable, and `{apps_dir}` need not be. `None` fetches nothing, and an App whose
    /// `status.build` names a build keeps serving the bundle the image ships.
    pub apps_cache_dir: Option<String>,
    /// The origin apps are served from (`JC_PORTAL_APPS_URL`, e.g. `https://{domain}`; AP-26,
    /// ADR-N-019). When set, `/apps/*` is served only on that origin and answered with a `308`
    /// to it on any other host, above all the Portal's own: an app on the Portal origin would
    /// call the Portal API with the viewer's session (T-2476). `None` serves on every host, as
    /// a Portal without an edge in front of it does.
    pub apps_url: Option<Url>,
    /// The file the deployment renders `global.branding` into (`JC_BRANDING_FILE`; UI-30,
    /// OPS-46). `None` serves
    /// neutral joinedcontext defaults, which is what an installation without branding looks
    /// like; it is never an error.
    pub branding_file: Option<String>,
    /// The directory the ConfigMap `jc-validation-results` is mounted at (`JC_HEALTH_DIR`;
    /// OPS-53): one digest per validation check, read on every request to
    /// `/api/v1/organization/health`. `None` answers an empty list; it is never an error.
    pub health_dir: Option<String>,
    /// PostgreSQL connection string of the preferences tier (`JC_PORTAL_DATABASE_URL`,
    /// UI-09). A secret: it carries a password, so it is redacted in `Debug`. `None` runs the Portal without preferences: those routes answer
    /// 503, everything else works.
    pub database_url: Option<String>,
    /// The group (or realm role) whose members may do everything everywhere, so the first
    /// `RoleBinding` can be written into an empty repository (`JC_PORTAL_BOOTSTRAP_ADMINS`,
    /// default `portal-approver`; T-0526, PF-50).
    pub bootstrap_admins: String,
    /// The usernames the Portal's own live journeys sign in as, the only people whose runs may
    /// carry `X-JC-Run-Origin: journey` (`JC_PORTAL_JOURNEY_USERS`, comma-separated; default
    /// none, so no one can mark a run; AG-93, T-2816).
    pub journey_users: Vec<String>,
    /// The client the reconciler manages the realm's groups with: a `ServiceAccount` client
    /// holding `manage-users` and `query-groups` of `realm-management` and nothing else
    /// (`JC_PORTAL_KEYCLOAK_ADMIN_CLIENT_ID` and `JC_PORTAL_KEYCLOAK_ADMIN_CLIENT_SECRET`, a
    /// secret, both together or neither; PF-63). `None` leaves the `Group` manifests read and the realm written by nobody.
    pub keycloak_admin: Option<(String, String)>,
    /// Where an App's four Kubernetes objects are applied (`JC_PORTAL_APPS_NAMESPACE` with
    /// `JC_PORTAL_ORG_DOMAIN`; AP-13, AP-18, T-0411). `None` leaves
    /// the reconciler reading apps and applying nothing, which is what a Portal outside a
    /// cluster does; it is never a guess, because guessing a namespace here would mean writing
    /// a Deployment into somebody else's.
    pub app_settings: Option<crate::apps::reconciler::Settings>,
    /// Where an App's build pods run and on which runner images (`JC_PORTAL_BUILD_NAMESPACE`
    /// with `JC_PORTAL_BUILD_IMAGE_NODE`, `JC_PORTAL_BUILD_IMAGE_RUST` and the forge's API base;
    /// `JC_PORTAL_BUILD_CACHE_SIZE`, default `1Gi`; AP-130, AP-131). `None` starts no build pod,
    /// and an App's build waits in the forge's queue.
    pub build_pods: Option<crate::apps::build_pods::Settings>,
    /// Where a builder run's workspace is scheduled and how the proxy reaches this Portal
    /// (AG-33, AG-40). `None` leaves every agent-run route answering 503: without a namespace
    /// to schedule into and a proxy for the workspace to speak to, a run has nowhere to happen.
    pub agent_settings: Option<AgentSettings>,
    /// Where a run tests each version before it offers publication (SDK-38): the sandbox
    /// namespace (`JC_PORTAL_APP_TESTS_NAMESPACE`) and the lane's builder image pinned by digest
    /// (`JC_PORTAL_APP_TESTS_IMAGE`), both or neither. `None` runs no tests in the run, says so on
    /// it, and leaves the build lane's check as the only one (SDK-24).
    pub app_tests: Option<crate::agents::sandbox::SandboxSettings>,
    /// Where basemap tiles and styles come from (AP-67). `None` disables the basemap route:
    /// tile requests answer 404 and generated maps render on a plain canvas.
    pub basemap: Option<BasemapConfig>,
    /// The artifact store and the root credential the reconciler mints per-organization
    /// credentials with (PF-32, ADR-N-015). `None` leaves the store untouched: a Portal outside
    /// a cluster reconciles a repository and issues nothing.
    pub artifact_store: Option<crate::artifact_store::Settings>,
    /// Which backend resolves a pipeline's `secretRef`s (PL-15, CC-06). A deployment setting,
    /// never a manifest field; `None` leaves a pipeline that declares one undeployed.
    pub pipeline_secrets: Option<crate::pipeline_secrets::Backend>,
}

/// The installation's own part of an organization's setup, as the deployment renders it from the
/// values that switch each on (T-2748, API/01 §25). Unset is "not said", which the setup page
/// shows as not done: it never claims what nobody stated.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SetupStatements {
    /// The realm's login theme (`JC_SETUP_LOGIN_THEME`); unset or blank says nothing about it.
    pub login_theme: Option<String>,
    /// The realm sends mail (`JC_SETUP_SMTP`, the literal `true`).
    pub smtp: bool,
    /// The databases are backed up to an object store (`JC_SETUP_BACKUPS`, the literal `true`).
    pub backups: bool,
}

impl SetupStatements {
    fn from_vars(lookup: &impl Fn(&str) -> Option<String>) -> Self {
        let yes = |key: &str| lookup(key).is_some_and(|v| v.trim() == "true");
        Self {
            login_theme: lookup("JC_SETUP_LOGIN_THEME")
                .map(|theme| theme.trim().to_owned())
                .filter(|theme| !theme.is_empty()),
            smtp: yes("JC_SETUP_SMTP"),
            backups: yes("JC_SETUP_BACKUPS"),
        }
    }
}

impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("bind", &self.bind)
            .field("public_base_url", &self.public_base_url.as_str())
            .field("oidc", &self.oidc)
            .field("trust_edge_token", &self.trust_edge_token)
            .field("setup", &self.setup)
            .field("cookie_key", &"[redacted]")
            .field(
                "cookie_keys_previous",
                &format_args!("[{} redacted]", self.cookie_keys_previous.len()),
            )
            .field("sync_interval", &self.sync_interval)
            .field(
                "gitea_webhook_secret",
                &self.gitea_webhook_secret.as_ref().map(|_| "[redacted]"),
            )
            .field(
                "gitea_webhook_secret_previous",
                &self
                    .gitea_webhook_secret_previous
                    .as_ref()
                    .map(|_| "[redacted]"),
            )
            .field("pipeline_runner_url", &self.pipeline_runner_url)
            .field("gateway_url", &self.gateway_url)
            .field("gateway_client_id", &self.gateway_client_id)
            .field("agent_proxy_client_id", &self.agent_proxy_client_id)
            .field("pipeline_runner_client_id", &self.pipeline_runner_client_id)
            .field("broker_url", &self.broker_url)
            .field("org_domain", &self.org_domain)
            .field("pipeline_test_capture_url", &self.pipeline_test_capture_url)
            .field("model_tools_url", &self.model_tools_url)
            .field("functions_url", &self.functions_url)
            .field("apps_dir", &self.apps_dir)
            .field("apps_cache_dir", &self.apps_cache_dir)
            .field("apps_url", &self.apps_url.as_ref().map(Url::as_str))
            .field("artifact_store", &self.artifact_store)
            .field("pipeline_secrets", &self.pipeline_secrets)
            .field("branding_file", &self.branding_file)
            .field("health_dir", &self.health_dir)
            .field(
                "database_url",
                &self.database_url.as_ref().map(|_| "[redacted]"),
            )
            .field("app_settings", &self.app_settings)
            .field("build_pods", &self.build_pods)
            .field("agent_settings", &self.agent_settings)
            .field("basemap", &self.basemap)
            .finish()
    }
}

/// Where an App's Kubernetes objects are applied, or `None` when this Portal applies none
/// (AP-13, AP-18, T-0411).
///
/// All three values are needed together: the namespace to write into, the organization domain
/// that becomes a policy's assigner, and the host the app's endpoint is served on. The host is
/// read off configuration the Portal already has, so an installation states two variables
/// rather than three, and any missing one leaves the converger off instead of guessing a
/// namespace and deploying into somebody else's.
/// Where the artifact store is and the root credential to mint with (PF-32, ADR-N-015).
///
/// `JC_PORTAL_ARTIFACT_STORE_ENDPOINT`, `JC_PORTAL_ARTIFACT_STORE_ACCESS_KEY` and
/// `JC_PORTAL_ARTIFACT_STORE_SECRET_KEY` (the last two secrets) name the store and the root
/// credential; `JC_PORTAL_ARTIFACT_STORE_BUCKET` (default `jc-artifacts`) and
/// `JC_PORTAL_ARTIFACT_STORE_REGION` (default `us-east-1`) are the same in every installation
/// this platform deploys, so they have defaults.
///
/// All-or-nothing on purpose: an endpoint without the root credential would sign every admin
/// request with nothing and log a refusal each sync, and a credential without an endpoint has
/// no store to reach. Missing means the reconciler issues no credentials at all, which is what
/// a Portal outside a cluster does.
fn artifact_store_settings(
    lookup: &impl Fn(&str) -> Option<String>,
) -> Option<crate::artifact_store::Settings> {
    let present = |var: &str| lookup(var).filter(|v| !v.trim().is_empty());
    let endpoint = present("JC_PORTAL_ARTIFACT_STORE_ENDPOINT")?;
    let root_access_key = present("JC_PORTAL_ARTIFACT_STORE_ACCESS_KEY")?;
    let root_secret_key = present("JC_PORTAL_ARTIFACT_STORE_SECRET_KEY")?;
    Some(crate::artifact_store::Settings {
        endpoint: endpoint.trim_end_matches('/').to_owned(),
        // The bucket and the region are the same in every installation this platform deploys
        // (Architecture/17 §4), so they have defaults; the endpoint and the credential never do.
        bucket: present("JC_PORTAL_ARTIFACT_STORE_BUCKET")
            .unwrap_or_else(|| "jc-artifacts".to_owned()),
        region: present("JC_PORTAL_ARTIFACT_STORE_REGION")
            .unwrap_or_else(|| "us-east-1".to_owned()),
        root_access_key,
        root_secret_key,
    })
}

/// Which secret backend the reconciler resolves a pipeline's references with (PL-15, CC-06).
///
/// `JC_PORTAL_SOPS_AGE_KEY_FILE` names the age key file and chooses SOPS; otherwise
/// `JC_PORTAL_OPENBAO_ADDR` and `JC_PORTAL_OPENBAO_ROLE` choose OpenBao, with
/// `JC_PORTAL_OPENBAO_JWT_PATH` (default
/// `/var/run/secrets/kubernetes.io/serviceaccount/token`) for the ServiceAccount token it logs
/// in with. The key file is a path to a secret, never the secret itself.
///
/// SOPS first, because the repository is a store this Portal already has in its hands every
/// sync and OpenBao is a component a deployment has to run. Naming neither is not an error: a
/// Portal without a backend refuses only the pipelines that declare a reference, and says so on
/// each of them.
fn pipeline_secret_backend(
    lookup: &impl Fn(&str) -> Option<String>,
) -> Option<crate::pipeline_secrets::Backend> {
    let present = |var: &str| lookup(var).filter(|v| !v.trim().is_empty());
    if let Some(age_key_file) = present("JC_PORTAL_SOPS_AGE_KEY_FILE") {
        return Some(crate::pipeline_secrets::Backend::Sops {
            age_key_file: age_key_file.into(),
        });
    }
    let address = present("JC_PORTAL_OPENBAO_ADDR")?;
    Some(crate::pipeline_secrets::Backend::OpenBao {
        address,
        // The Kubernetes auth role this Portal logs in as. Named here rather than defaulted:
        // a role guessed wrong is a login refused on every sync with no line saying why.
        role: present("JC_PORTAL_OPENBAO_ROLE")?,
        jwt_path: present("JC_PORTAL_OPENBAO_JWT_PATH")
            .unwrap_or_else(|| "/var/run/secrets/kubernetes.io/serviceaccount/token".to_owned())
            .into(),
    })
}

/// `JC_PORTAL_APPS_URL`: an absolute `http(s)` origin with nothing after it. A path would be
/// dropped by the redirect anyway, so it is refused here rather than silently ignored.
fn apps_url(lookup: &impl Fn(&str) -> Option<String>) -> Result<Option<Url>, ConfigError> {
    let Some(raw) = lookup("JC_PORTAL_APPS_URL").filter(|v| !v.trim().is_empty()) else {
        return Ok(None);
    };
    let invalid = |reason: &str| ConfigError::Invalid {
        var: "JC_PORTAL_APPS_URL",
        reason: reason.to_owned(),
    };
    let url: Url = raw
        .trim()
        .parse()
        .map_err(|e: url::ParseError| invalid(&e.to_string()))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(invalid("an http(s) origin such as https://example.org"));
    }
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err(invalid("an origin only, without a path, query or fragment"));
    }
    Ok(Some(url))
}

/// Where build pods run (AP-130): nothing when `JC_PORTAL_BUILD_NAMESPACE` is unset, and every
/// other part required once it is, because a namespace with no image would start pods that
/// never run.
fn build_pod_settings(
    lookup: &impl Fn(&str) -> Option<String>,
) -> Result<Option<crate::apps::build_pods::Settings>, ConfigError> {
    let set = |var: &str| {
        lookup(var)
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
    };
    let Some(namespace) = set("JC_PORTAL_BUILD_NAMESPACE") else {
        return Ok(None);
    };
    if !crate::resource::is_dns1123(&namespace) {
        return Err(ConfigError::Invalid {
            var: "JC_PORTAL_BUILD_NAMESPACE",
            reason: format!(
                "'{namespace}' is not a Kubernetes name (lowercase letters, digits, '-')"
            ),
        });
    }
    let image = |var: &'static str| match set(var) {
        Some(image) if image.contains("@sha256:") && !image.chars().any(char::is_whitespace) => {
            Ok(image)
        }
        Some(image) => Err(ConfigError::Invalid {
            var,
            reason: format!("'{image}' is not an image pinned by digest (name@sha256:…)"),
        }),
        None => Err(ConfigError::Invalid {
            var,
            reason: "JC_PORTAL_BUILD_NAMESPACE is set, and a build pod needs its image".into(),
        }),
    };
    let forge = set("JC_GITEA_URL").ok_or_else(|| ConfigError::Invalid {
        var: "JC_PORTAL_BUILD_NAMESPACE",
        reason: "a build pod registers with the forge, and JC_GITEA_URL is not set".into(),
    })?;
    let cache_size = set("JC_PORTAL_BUILD_CACHE_SIZE").unwrap_or_else(|| "1Gi".into());
    let digits = cache_size.trim_end_matches("Gi").trim_end_matches("Mi");
    if digits.is_empty()
        || digits.len() == cache_size.len()
        || !digits.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(ConfigError::Invalid {
            var: "JC_PORTAL_BUILD_CACHE_SIZE",
            reason: format!("'{cache_size}' is not a size such as 512Mi or 1Gi"),
        });
    }
    Ok(Some(crate::apps::build_pods::Settings {
        namespace,
        forge,
        node_image: image("JC_PORTAL_BUILD_IMAGE_NODE")?,
        rust_image: image("JC_PORTAL_BUILD_IMAGE_RUST")?,
        cache_size,
    }))
}

/// Where an App's objects are applied: `JC_PORTAL_APPS_NAMESPACE` and `JC_PORTAL_ORG_DOMAIN`,
/// both or neither, with the host taken from the public URL rather than configured twice
/// (AP-13).
///
/// A pod-backed App also needs (AP-108):
///
/// - `JC_PORTAL_APPS_REGISTRY` — the host, and port if any, of the forge's container registry;
///   an App's image is composed as `{registry}/{forge organization}/app-{name}@{digest}`, the
///   organization being the applications' own when they have one of their own.
/// - `JC_GITEA_APPS_OWNER` — the forge organization the generated applications' repositories,
///   packages and images live in, apart from the configuration's (PF-106); the configuration's
///   organization when unset.
/// - `JC_GITEA_APPS_TOKEN` — the token of the applications' own machine user, which writes their
///   repositories and packages and nothing of the configuration's; set with the owner or not at
///   all.
/// - `JC_PORTAL_APPS_PULL_SECRET_NAME` — the name of the `dockerconfigjson` Secret in the apps
///   namespace a node pulls app images with (a forge token that reads packages only).
/// - `JC_PORTAL_APISIX_NAMESPACE` — the namespace the installation runs APISIX in, the only one
///   whose pods reach an app pod; default `apisix`.
/// - `JC_PORTAL_RELEASE` — the installation's release name; a project's pod-backed Apps run in
///   `{release}-{project}-apps`, bound to the ClusterRole `{release}-portal-apps` (AP-116).
/// - `JC_PORTAL_SERVICE_ACCOUNT` — the Portal's ServiceAccount in `JC_PORTAL_APPS_NAMESPACE`, the
///   subject of the RoleBinding in each project's apps namespace (AP-116).
fn app_settings(
    lookup: &impl Fn(&str) -> Option<String>,
    public_base_url: &Url,
) -> Result<Option<crate::apps::reconciler::Settings>, ConfigError> {
    let set = |var: &str| {
        lookup(var)
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
    };
    let (Some(namespace), Some(org_domain), Some(host)) = (
        set("JC_PORTAL_APPS_NAMESPACE"),
        set("JC_PORTAL_ORG_DOMAIN"),
        public_base_url.host_str().map(str::to_owned),
    ) else {
        return Ok(None);
    };
    let name = |var: &'static str, value: Option<String>| match value {
        Some(value) if !crate::resource::is_dns1123(&value) => Err(ConfigError::Invalid {
            var,
            reason: format!("'{value}' is not a Kubernetes name (lowercase letters, digits, '-')"),
        }),
        other => Ok(other),
    };
    let apisix_namespace = name(
        "JC_PORTAL_APISIX_NAMESPACE",
        set("JC_PORTAL_APISIX_NAMESPACE"),
    )?
    .unwrap_or_else(|| "apisix".to_owned());
    let pull_secret = name(
        "JC_PORTAL_APPS_PULL_SECRET_NAME",
        set("JC_PORTAL_APPS_PULL_SECRET_NAME"),
    )?;
    let image_repository = match set("JC_PORTAL_APPS_REGISTRY") {
        None => None,
        Some(registry) => {
            // A host and an optional port: a scheme or a path would compose a reference no
            // node resolves, and it is the one part of an image an App cannot name (AP-108).
            if !is_registry_host(&registry) {
                return Err(ConfigError::Invalid {
                    var: "JC_PORTAL_APPS_REGISTRY",
                    reason: format!(
                        "'{registry}' is not a registry host such as forge.example.org or \
                         forge.example.org:5000"
                    ),
                });
            }
            // The applications' organization when there is one (PF-106): their images are
            // published there, beside their repositories.
            let owner = set("JC_GITEA_APPS_OWNER")
                .or_else(|| set("JC_GITEA_OWNER"))
                .ok_or_else(|| ConfigError::Invalid {
                    var: "JC_PORTAL_APPS_REGISTRY",
                    reason: "the images live under the forge's organization, and JC_GITEA_OWNER \
                             is not set"
                        .to_owned(),
                })?;
            Some(format!("{registry}/{owner}"))
        }
    };
    let release = name("JC_PORTAL_RELEASE", set("JC_PORTAL_RELEASE"))?;
    let service_account = name(
        "JC_PORTAL_SERVICE_ACCOUNT",
        set("JC_PORTAL_SERVICE_ACCOUNT"),
    )?;
    Ok(Some(crate::apps::reconciler::Settings {
        host,
        namespace,
        org_domain,
        apisix_namespace,
        image_repository,
        pull_secret,
        release,
        service_account,
    }))
}

/// The run's test sandbox (SDK-38): `JC_PORTAL_APP_TESTS_NAMESPACE`, a Kubernetes name, and
/// `JC_PORTAL_APP_TESTS_IMAGE`, an image reference pinned by `@sha256:` digest, both or neither.
fn app_tests(
    lookup: &impl Fn(&str) -> Option<String>,
) -> Result<Option<crate::agents::sandbox::SandboxSettings>, ConfigError> {
    let set = |var: &str| {
        lookup(var)
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
    };
    match (
        set("JC_PORTAL_APP_TESTS_NAMESPACE"),
        set("JC_PORTAL_APP_TESTS_IMAGE"),
    ) {
        (None, None) => Ok(None),
        (Some(namespace), Some(image)) => {
            if !crate::resource::is_dns1123(&namespace) {
                return Err(ConfigError::Invalid {
                    var: "JC_PORTAL_APP_TESTS_NAMESPACE",
                    reason: format!(
                        "'{namespace}' is not a Kubernetes name (lowercase letters, digits, '-')"
                    ),
                });
            }
            // The model's code runs on it, so it is the lane's own image and nothing a tag
            // could move (non-negotiable: images by digest).
            let pinned = image.split_once("@sha256:").is_some_and(|(name, hex)| {
                !name.is_empty()
                    && hex.len() == 64
                    && hex
                        .bytes()
                        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            });
            if !pinned || image.chars().any(char::is_whitespace) {
                return Err(ConfigError::Invalid {
                    var: "JC_PORTAL_APP_TESTS_IMAGE",
                    reason: format!(
                        "'{image}' is not an image pinned by digest, such as \
                         ghcr.io/org/joinedcontext-app-builder@sha256:<64 hex>"
                    ),
                });
            }
            Ok(Some(crate::agents::sandbox::SandboxSettings {
                namespace,
                image,
            }))
        }
        (Some(_), None) | (None, Some(_)) => Err(ConfigError::Invalid {
            var: "JC_PORTAL_APP_TESTS_NAMESPACE",
            reason: "JC_PORTAL_APP_TESTS_NAMESPACE and JC_PORTAL_APP_TESTS_IMAGE go together"
                .to_owned(),
        }),
    }
}

/// `forge.example.org` or `forge.example.org:5000`: lowercase DNS labels and an optional port.
fn is_registry_host(value: &str) -> bool {
    let (host, port_ok) = match value.split_once(':') {
        None => (value, true),
        Some((host, port)) => (host, port.parse::<u16>().is_ok_and(|port| port > 0)),
    };
    port_ok
        && host.split('.').all(|label| {
            !label.is_empty()
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}

/// Where a builder run happens and how the credential proxy reaches this Portal (ADR-N-020).
///
/// `JC_AGENTS_NAMESPACE` and `JC_AGENT_PROXY_BASE` are set together or not at all;
/// `JC_PORTAL_NAMESPACE` (default: the workspaces' own namespace), `JC_INTERNAL_BIND` (default
/// `0.0.0.0:9090`), `JC_AGENT_RUN_TTL` (whole seconds, default `1200`) and
/// `JC_AGENT_APPROVAL_TTL` (whole seconds a run waits for its change's approval, default
/// `604800`) tune the rest. None of them is a secret: the proxy presents its own ServiceAccount
/// token, which is why `JC_AGENT_PROXY_TOKEN` is gone (T-2271).
///
/// The namespace and the proxy are needed together: a workspace with no proxy has no way to
/// reach the model, the data or the forge, and a proxy with no namespace has nothing to serve.
/// The token is the proxy's own credential on the internal listener, and it is the reason this
/// block is all-or-nothing rather than three independent variables: two of the three set is a
/// misconfiguration, not a Portal that runs agent runs unauthenticated.
#[derive(Clone)]
pub struct AgentSettings {
    /// Namespace the workspace Jobs, their ServiceAccounts and their NetworkPolicies go into.
    pub namespace: String,
    /// Namespace the Portal itself runs in, which is the only place a workspace's ingress rule
    /// admits from (AG-39). Unset means the Portal shares the workspaces' namespace, the same
    /// assumption the proxy's egress rule already makes.
    pub portal_namespace: String,
    /// Base URL of `jc-agent-proxy` as a workspace sees it, e.g.
    /// `http://jc-agent-proxy.agents.svc.cluster.local:8080`.
    pub proxy_base: String,
    /// Where the internal listener binds. APISIX routes nothing to it, and a NetworkPolicy
    /// opens it to the proxy alone (AG-52).
    pub internal_bind: SocketAddr,
    /// Wall clock of one run, in seconds. The Job carries the same number as its
    /// `activeDeadlineSeconds`, so the two cannot disagree about when a run is over.
    pub run_ttl_secs: i64,
    /// How long a run that built an application waits for its change's approval, in seconds
    /// (`JC_AGENT_APPROVAL_TTL`, T-2772): the run's own wall clock stops when it proposes, and
    /// an approver has days, not what was left of the build's twenty minutes.
    pub approval_ttl_secs: i64,
}

impl std::fmt::Debug for AgentSettings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentSettings")
            .field("namespace", &self.namespace)
            .field("portal_namespace", &self.portal_namespace)
            .field("proxy_base", &self.proxy_base)
            .field("internal_bind", &self.internal_bind)
            .field("run_ttl_secs", &self.run_ttl_secs)
            .field("approval_ttl_secs", &self.approval_ttl_secs)
            .finish()
    }
}

/// The agent runner block, or `None` when this Portal runs no agent (AG-33, AG-40).
fn agent_settings(
    lookup: &impl Fn(&str) -> Option<String>,
) -> Result<Option<AgentSettings>, ConfigError> {
    let namespace = lookup("JC_AGENTS_NAMESPACE").filter(|v| !v.trim().is_empty());
    let proxy_base = lookup("JC_AGENT_PROXY_BASE").filter(|v| !v.trim().is_empty());
    // `JC_AGENT_PROXY_TOKEN` was the third of these until T-2271: one string the Portal and the
    // proxy both held, which is the static key between cluster services CLAUDE.md rules out. The
    // proxy presents its own ServiceAccount token now (`JC_PORTAL_AGENT_PROXY_CLIENT_ID` says whose
    // token the callbacks accept), so there is no shared secret left to configure here.
    let (namespace, proxy_base) = match (namespace, proxy_base) {
        (None, None) => return Ok(None),
        (Some(namespace), Some(proxy_base)) => (namespace, proxy_base),
        _ => {
            return Err(ConfigError::Invalid {
                var: "JC_AGENTS_NAMESPACE",
                reason: "JC_AGENTS_NAMESPACE and JC_AGENT_PROXY_BASE must be set together"
                    .to_string(),
            })
        }
    };

    let probe: Url = proxy_base
        .parse()
        .map_err(|e: url::ParseError| ConfigError::Invalid {
            var: "JC_AGENT_PROXY_BASE",
            reason: e.to_string(),
        })?;
    if probe.scheme() != "http" && probe.scheme() != "https" {
        return Err(ConfigError::Invalid {
            var: "JC_AGENT_PROXY_BASE",
            reason: format!("scheme '{}' is not http or https", probe.scheme()),
        });
    }

    let internal_bind: SocketAddr = lookup("JC_INTERNAL_BIND")
        .unwrap_or_else(|| Config::DEFAULT_INTERNAL_BIND.to_string())
        .parse()
        .map_err(|e: std::net::AddrParseError| ConfigError::Invalid {
            var: "JC_INTERNAL_BIND",
            reason: e.to_string(),
        })?;

    let run_ttl_secs = match lookup("JC_AGENT_RUN_TTL") {
        Some(value) => value.parse::<i64>().map_err(|e| ConfigError::Invalid {
            var: "JC_AGENT_RUN_TTL",
            reason: e.to_string(),
        })?,
        None => Config::DEFAULT_RUN_TTL_SECS,
    };
    if run_ttl_secs <= 0 {
        return Err(ConfigError::Invalid {
            var: "JC_AGENT_RUN_TTL",
            reason: "a run needs a positive wall clock".to_string(),
        });
    }

    let approval_ttl_secs = match lookup("JC_AGENT_APPROVAL_TTL") {
        Some(value) => value.parse::<i64>().map_err(|e| ConfigError::Invalid {
            var: "JC_AGENT_APPROVAL_TTL",
            reason: e.to_string(),
        })?,
        None => Config::DEFAULT_APPROVAL_TTL_SECS,
    };
    if approval_ttl_secs <= 0 {
        return Err(ConfigError::Invalid {
            var: "JC_AGENT_APPROVAL_TTL",
            reason: "a run waiting for approval needs a positive lease".to_string(),
        });
    }

    let portal_namespace = lookup("JC_PORTAL_NAMESPACE")
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| namespace.clone());

    Ok(Some(AgentSettings {
        namespace,
        portal_namespace,
        proxy_base: proxy_base.trim_end_matches('/').to_owned(),
        internal_bind,
        run_ttl_secs,
        approval_ttl_secs,
    }))
}

/// Configuration for the platform basemap proxy (AP-67).
///
/// `JC_BASEMAP_URL` (an `https` template holding `{z}`, `{x}` and `{y}`) turns the proxy on
/// and `JC_BASEMAP_ATTRIBUTION` is then required, because a tile source that is served without
/// its attribution is served against its licence. `JC_BASEMAP_MAX_ZOOM` (default `19`),
/// `JC_BASEMAP_CACHE_DIR` (default `/tmp/basemap-cache`), `JC_BASEMAP_CACHE_MAX_BYTES`
/// (default `268435456`) and `JC_BASEMAP_CACHE_TTL_SECS` (default `604800`) tune the cache.
/// `JC_BASEMAP_KEY_FILE` names a file holding the tile provider's key — a path to a secret,
/// and the reason the browser fetches tiles from the Portal rather than from the provider.
#[derive(Clone)]
pub struct BasemapConfig {
    pub url_template: String,
    pub attribution: String,
    pub max_zoom: u8,
    pub key: Option<String>,
    pub cache_dir: std::path::PathBuf,
    pub cache_max_bytes: u64,
    pub cache_ttl_secs: u64,
    pub allow_http: bool,
}

impl BasemapConfig {
    pub fn for_tests(
        url_template: String,
        attribution: String,
        cache_dir: std::path::PathBuf,
    ) -> Self {
        Self {
            url_template,
            attribution,
            max_zoom: 19,
            key: None,
            cache_dir,
            cache_max_bytes: 1024 * 1024,
            cache_ttl_secs: 3600,
            allow_http: true,
        }
    }
}

impl std::fmt::Debug for BasemapConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BasemapConfig")
            .field("url_template", &self.url_template)
            .field("attribution", &self.attribution)
            .field("max_zoom", &self.max_zoom)
            .field("key", &self.key.as_ref().map(|_| "<redacted>"))
            .field("cache_dir", &self.cache_dir)
            .field("cache_max_bytes", &self.cache_max_bytes)
            .field("cache_ttl_secs", &self.cache_ttl_secs)
            .field("allow_http", &self.allow_http)
            .finish()
    }
}

/// The basemap configuration block, or `None` when this Portal proxies no basemap (AP-67).
fn basemap_config(
    lookup: &impl Fn(&str) -> Option<String>,
) -> Result<Option<BasemapConfig>, ConfigError> {
    let url_template = match lookup("JC_BASEMAP_URL").filter(|v| !v.trim().is_empty()) {
        Some(url) => url.trim().to_string(),
        None => return Ok(None),
    };

    if !url_template.contains("{z}")
        || !url_template.contains("{x}")
        || !url_template.contains("{y}")
    {
        return Err(ConfigError::Invalid {
            var: "JC_BASEMAP_URL",
            reason: "template must contain {z}, {x}, and {y}".to_string(),
        });
    }

    let dummy = url_template
        .replace("{z}", "0")
        .replace("{x}", "0")
        .replace("{y}", "0")
        .replace("{ext}", "png")
        .replace("{key}", "key");
    let probe: Url = dummy
        .parse()
        .map_err(|e: url::ParseError| ConfigError::Invalid {
            var: "JC_BASEMAP_URL",
            reason: e.to_string(),
        })?;
    if probe.scheme() != "https" {
        return Err(ConfigError::Invalid {
            var: "JC_BASEMAP_URL",
            reason: format!("scheme '{}' is not https", probe.scheme()),
        });
    }

    let attribution = match lookup("JC_BASEMAP_ATTRIBUTION").filter(|v| !v.trim().is_empty()) {
        Some(attr) => attr.trim().to_string(),
        None => {
            return Err(ConfigError::Invalid {
                var: "JC_BASEMAP_ATTRIBUTION",
                reason: "JC_BASEMAP_ATTRIBUTION is required when JC_BASEMAP_URL is set".to_string(),
            })
        }
    };

    let max_zoom = match lookup("JC_BASEMAP_MAX_ZOOM").filter(|v| !v.trim().is_empty()) {
        Some(val) => val.parse::<u8>().map_err(|e| ConfigError::Invalid {
            var: "JC_BASEMAP_MAX_ZOOM",
            reason: e.to_string(),
        })?,
        None => 19,
    };

    let key = match lookup("JC_BASEMAP_KEY_FILE").filter(|v| !v.trim().is_empty()) {
        Some(path) => {
            let content = std::fs::read_to_string(&path).map_err(|e| ConfigError::Invalid {
                var: "JC_BASEMAP_KEY_FILE",
                reason: format!("{path}: {e}"),
            })?;
            Some(content.trim().to_string())
        }
        None => None,
    };

    let cache_dir = std::path::PathBuf::from(
        lookup("JC_BASEMAP_CACHE_DIR")
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| "/tmp/basemap-cache".to_string()),
    );

    let cache_max_bytes =
        match lookup("JC_BASEMAP_CACHE_MAX_BYTES").filter(|v| !v.trim().is_empty()) {
            Some(val) => val.parse::<u64>().map_err(|e| ConfigError::Invalid {
                var: "JC_BASEMAP_CACHE_MAX_BYTES",
                reason: e.to_string(),
            })?,
            None => 268_435_456,
        };

    let cache_ttl_secs = match lookup("JC_BASEMAP_CACHE_TTL_SECS").filter(|v| !v.trim().is_empty())
    {
        Some(val) => val.parse::<u64>().map_err(|e| ConfigError::Invalid {
            var: "JC_BASEMAP_CACHE_TTL_SECS",
            reason: e.to_string(),
        })?,
        None => 604_800,
    };

    Ok(Some(BasemapConfig {
        url_template,
        attribution,
        max_zoom,
        key,
        cache_dir,
        cache_max_bytes,
        cache_ttl_secs,
        allow_http: false,
    }))
}

/// Keycloak realm the portal authenticates humans against (CC-40).
#[derive(Clone)]
pub struct OidcConfig {
    pub issuer: Url,
    pub client_id: String,
    client_secret: String,
    /// PEM of an extra root the discovery client trusts, on top of the compiled-in Mozilla
    /// bundle. An instance whose issuer is served by a private CA (a self-signed cluster
    /// issuer, an internal PKI) is unreachable without it: the binary carries `webpki-roots`
    /// alone, so no mounted file or `SSL_CERT_FILE` is consulted. Verification stays on;
    /// this only widens what a valid chain may end in.
    pub extra_ca_pem: Option<Vec<u8>>,
}

impl OidcConfig {
    pub fn client_secret(&self) -> &str {
        &self.client_secret
    }
}

impl std::fmt::Debug for OidcConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OidcConfig")
            .field("issuer", &self.issuer.as_str())
            .field("client_id", &self.client_id)
            .field("client_secret", &"[redacted]")
            .finish()
    }
}

/// Errors raised when parsing configuration parameters.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ConfigError {
    #[error("invalid configuration for {var}: {reason}")]
    Invalid { var: &'static str, reason: String },
}

impl Config {
    pub const DEFAULT_BIND: &'static str = "0.0.0.0:8080";
    const DEFAULT_BOOTSTRAP_ADMINS: &'static str = "platform-admins";
    pub const DEFAULT_PUBLIC_URL: &'static str = "http://localhost:8080";
    /// The internal listener's default. Port 9090, which the edge does not route (AG-52).
    pub const DEFAULT_INTERNAL_BIND: &'static str = "0.0.0.0:9090";
    /// Wall clock of one builder run when the deployment names none: twenty minutes, the
    /// window AG-43 gives a run before it expires.
    pub const DEFAULT_RUN_TTL_SECS: i64 = 1_200;
    /// Seven days: a change proposed on Friday is still there to approve on Monday (T-2772).
    pub const DEFAULT_APPROVAL_TTL_SECS: i64 = 604_800;
    /// `Key::from` panics below 64 bytes, so the length is checked before it is called.
    pub const MIN_COOKIE_KEY_LEN: usize = 64;

    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_vars(|k| std::env::var(k).ok())
    }

    pub fn from_vars(lookup: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let bind_str = lookup("JC_PORTAL_BIND").unwrap_or_else(|| Self::DEFAULT_BIND.to_string());
        let bind: SocketAddr =
            bind_str
                .parse()
                .map_err(|e: std::net::AddrParseError| ConfigError::Invalid {
                    var: "JC_PORTAL_BIND",
                    reason: e.to_string(),
                })?;

        let url_str =
            lookup("JC_PORTAL_PUBLIC_URL").unwrap_or_else(|| Self::DEFAULT_PUBLIC_URL.to_string());
        let public_base_url: Url =
            url_str
                .parse()
                .map_err(|e: url::ParseError| ConfigError::Invalid {
                    var: "JC_PORTAL_PUBLIC_URL",
                    reason: e.to_string(),
                })?;

        let oidc = match (
            lookup("JC_OIDC_ISSUER"),
            lookup("JC_OIDC_CLIENT_ID"),
            lookup("JC_OIDC_CLIENT_SECRET"),
        ) {
            (None, None, None) => None,
            (Some(issuer), Some(client_id), Some(client_secret)) => Some(OidcConfig {
                issuer: issuer
                    .parse()
                    .map_err(|e: url::ParseError| ConfigError::Invalid {
                        var: "JC_OIDC_ISSUER",
                        reason: e.to_string(),
                    })?,
                client_id,
                client_secret,
                // Unreadable means misconfigured, not "carry on with fewer roots": a start-up
                // error names the file, a silent fallback would be a confusing 500 at login.
                extra_ca_pem: match lookup("JC_OIDC_CA_FILE") {
                    None => None,
                    Some(path) => Some(std::fs::read(&path).map_err(|e| ConfigError::Invalid {
                        var: "JC_OIDC_CA_FILE",
                        reason: format!("{path}: {e}"),
                    })?),
                },
            }),
            _ => {
                return Err(ConfigError::Invalid {
                    var: "JC_OIDC_ISSUER",
                    reason: "JC_OIDC_ISSUER, JC_OIDC_CLIENT_ID and JC_OIDC_CLIENT_SECRET must be \
                             set together"
                        .to_string(),
                })
            }
        };

        let cookie_key = match lookup("JC_PORTAL_COOKIE_KEY") {
            Some(material) if material.len() >= Self::MIN_COOKIE_KEY_LEN => {
                Key::from(material.as_bytes())
            }
            Some(_) => {
                return Err(ConfigError::Invalid {
                    var: "JC_PORTAL_COOKIE_KEY",
                    reason: format!("at least {} bytes required", Self::MIN_COOKIE_KEY_LEN),
                })
            }
            None => {
                tracing::warn!(
                    "JC_PORTAL_COOKIE_KEY is unset: using an ephemeral key, sessions do not \
                     survive a restart"
                );
                Key::generate()
            }
        };

        // The keys a rotation is still letting in. Several, comma-separated, because a second
        // rotation can start before the first one's sessions have all expired; each is held to
        // the same length as the active one, since a short key here would be the way in.
        let cookie_keys_previous = match lookup("JC_PORTAL_COOKIE_KEY_PREVIOUS") {
            Some(material) => {
                let mut keys = Vec::new();
                for part in material.split(',').map(str::trim).filter(|p| !p.is_empty()) {
                    if part.len() < Self::MIN_COOKIE_KEY_LEN {
                        return Err(ConfigError::Invalid {
                            var: "JC_PORTAL_COOKIE_KEY_PREVIOUS",
                            reason: format!("at least {} bytes required", Self::MIN_COOKIE_KEY_LEN),
                        });
                    }
                    keys.push(Key::from(part.as_bytes()));
                }
                keys
            }
            None => Vec::new(),
        };

        let sync_interval_secs = match lookup("JC_PORTAL_SYNC_INTERVAL") {
            Some(val) => val.parse::<u64>().map_err(|e| ConfigError::Invalid {
                var: "JC_PORTAL_SYNC_INTERVAL",
                reason: e.to_string(),
            })?,
            None => 60,
        };
        let sync_interval = Duration::from_secs(sync_interval_secs);

        let gitea_webhook_secret = lookup("JC_GITEA_WEBHOOK_SECRET");
        let gitea_webhook_secret_previous = lookup("JC_GITEA_WEBHOOK_SECRET_PREVIOUS");

        // The space surface's base: one host, no path. A typo here is a subscription that never
        // reaches its broker, so it is refused at startup like every other address.
        let gateway_url = match lookup("JC_PORTAL_GATEWAY_URL") {
            Some(value) => {
                let parsed: Url =
                    value
                        .parse()
                        .map_err(|e: url::ParseError| ConfigError::Invalid {
                            var: "JC_PORTAL_GATEWAY_URL",
                            reason: e.to_string(),
                        })?;
                if parsed.scheme() != "http" && parsed.scheme() != "https" {
                    return Err(ConfigError::Invalid {
                        var: "JC_PORTAL_GATEWAY_URL",
                        reason: format!("scheme '{}' is not http or https", parsed.scheme()),
                    });
                }
                Some(value.trim_end_matches('/').to_owned())
            }
            None => None,
        };

        // The broker's own address, checked the same way: a typo here is a registration the
        // hub never learns about, and a hub that federates nothing looks exactly like a hub
        // whose members are empty.
        let broker_url = match lookup("JC_PORTAL_BROKER_URL") {
            Some(value) => {
                let parsed: Url =
                    value
                        .parse()
                        .map_err(|e: url::ParseError| ConfigError::Invalid {
                            var: "JC_PORTAL_BROKER_URL",
                            reason: e.to_string(),
                        })?;
                if parsed.scheme() != "http" && parsed.scheme() != "https" {
                    return Err(ConfigError::Invalid {
                        var: "JC_PORTAL_BROKER_URL",
                        reason: format!("scheme '{}' is not http or https", parsed.scheme()),
                    });
                }
                Some(value.trim_end_matches('/').to_owned())
            }
            None => None,
        };

        // The template is not a URL until `{project}` is filled in, so it is checked against a
        // stand-in: an operator learns about a typo at startup, not on the first scrape.
        let pipeline_runner_url = match lookup("JC_PORTAL_PIPELINE_RUNNER_URL") {
            Some(template) => {
                let probe: Url = template.replace("{project}", "project").parse().map_err(
                    |e: url::ParseError| ConfigError::Invalid {
                        var: "JC_PORTAL_PIPELINE_RUNNER_URL",
                        reason: e.to_string(),
                    },
                )?;
                if probe.scheme() != "http" && probe.scheme() != "https" {
                    return Err(ConfigError::Invalid {
                        var: "JC_PORTAL_PIPELINE_RUNNER_URL",
                        reason: format!("scheme '{}' is not http or https", probe.scheme()),
                    });
                }
                Some(template)
            }
            None => None,
        };

        let pipeline_test_capture_url = match lookup("JC_PORTAL_PIPELINE_TEST_CAPTURE_URL") {
            Some(raw) => {
                let url: Url = raw
                    .parse()
                    .map_err(|e: url::ParseError| ConfigError::Invalid {
                        var: "JC_PORTAL_PIPELINE_TEST_CAPTURE_URL",
                        reason: e.to_string(),
                    })?;
                if url.scheme() != "http" && url.scheme() != "https" {
                    return Err(ConfigError::Invalid {
                        var: "JC_PORTAL_PIPELINE_TEST_CAPTURE_URL",
                        reason: format!("scheme '{}' is not http or https", url.scheme()),
                    });
                }
                Some(raw.trim_end_matches('/').to_owned())
            }
            None => None,
        };

        let functions_url = match lookup("JC_FUNCTIONS_URL") {
            Some(raw) => {
                let url: Url = raw
                    .parse()
                    .map_err(|e: url::ParseError| ConfigError::Invalid {
                        var: "JC_FUNCTIONS_URL",
                        reason: e.to_string(),
                    })?;
                if url.scheme() != "http" && url.scheme() != "https" {
                    return Err(ConfigError::Invalid {
                        var: "JC_FUNCTIONS_URL",
                        reason: format!("scheme '{}' is not http or https", url.scheme()),
                    });
                }
                Some(raw.trim_end_matches('/').to_owned())
            }
            None => None,
        };

        let model_tools_url = match lookup("JC_PORTAL_MODEL_TOOLS_URL") {
            Some(raw) => {
                let url: Url = raw
                    .parse()
                    .map_err(|e: url::ParseError| ConfigError::Invalid {
                        var: "JC_PORTAL_MODEL_TOOLS_URL",
                        reason: e.to_string(),
                    })?;
                if url.scheme() != "http" && url.scheme() != "https" {
                    return Err(ConfigError::Invalid {
                        var: "JC_PORTAL_MODEL_TOOLS_URL",
                        reason: format!("scheme '{}' is not http or https", url.scheme()),
                    });
                }
                Some(raw)
            }
            None => None,
        };

        // Only the literal `true` turns it on: a misspelling must not open the door (ADR-N-019).
        let trust_edge_token = lookup("JC_TRUST_EDGE_TOKEN").is_some_and(|v| v.trim() == "true");
        let setup = SetupStatements::from_vars(&lookup);

        let apps_dir = lookup("JC_PORTAL_APPS_DIR");
        let apps_cache_dir =
            lookup("JC_PORTAL_APPS_CACHE_DIR").filter(|dir| !dir.trim().is_empty());
        let apps_url = apps_url(&lookup)?;
        let app_settings = app_settings(&lookup, &public_base_url)?;
        let build_pods = build_pod_settings(&lookup)?;
        let agent_settings = agent_settings(&lookup)?;
        let app_tests = app_tests(&lookup)?;
        let basemap = basemap_config(&lookup)?;
        let branding_file = lookup("JC_BRANDING_FILE").filter(|path| !path.trim().is_empty());
        let health_dir = lookup("JC_HEALTH_DIR").filter(|path| !path.trim().is_empty());
        let database_url = lookup("JC_PORTAL_DATABASE_URL").filter(|url| !url.trim().is_empty());
        let bootstrap_admins = lookup("JC_PORTAL_BOOTSTRAP_ADMINS")
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| Self::DEFAULT_BOOTSTRAP_ADMINS.to_owned());
        let journey_users = lookup("JC_PORTAL_JOURNEY_USERS")
            .map(|v| {
                v.split(',')
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();

        // Both halves or neither: an id without a secret would send an unauthenticated token
        // request every tick and log a refusal every time.
        let keycloak_admin = match (
            lookup("JC_PORTAL_KEYCLOAK_ADMIN_CLIENT_ID").filter(|v| !v.trim().is_empty()),
            lookup("JC_PORTAL_KEYCLOAK_ADMIN_CLIENT_SECRET").filter(|v| !v.trim().is_empty()),
        ) {
            (Some(id), Some(secret)) => Some((id, secret)),
            (Some(_), None) => {
                return Err(ConfigError::Invalid {
                    var: "JC_PORTAL_KEYCLOAK_ADMIN_CLIENT_SECRET",
                    reason: "the group reconciler has a client id and no secret".to_owned(),
                })
            }
            _ => None,
        };

        let artifact_store = artifact_store_settings(&lookup);
        let pipeline_secrets = pipeline_secret_backend(&lookup);

        Ok(Self {
            bind,
            public_base_url,
            oidc,
            trust_edge_token,
            setup,
            cookie_key,
            cookie_keys_previous,
            sync_interval,
            gitea_webhook_secret,
            gitea_webhook_secret_previous,
            pipeline_runner_url,
            gateway_url,
            gateway_client_id: lookup("JC_PORTAL_GATEWAY_CLIENT_ID")
                .filter(|v| !v.trim().is_empty()),
            agent_proxy_client_id: lookup("JC_PORTAL_AGENT_PROXY_CLIENT_ID")
                .filter(|v| !v.trim().is_empty()),
            pipeline_runner_client_id: lookup("JC_PORTAL_PIPELINE_RUNNER_CLIENT_ID")
                .filter(|v| !v.trim().is_empty()),
            broker_url,
            org_domain: lookup("JC_PORTAL_ORG_DOMAIN").filter(|v| !v.trim().is_empty()),
            pipeline_test_capture_url,
            model_tools_url,
            functions_url,
            apps_dir,
            apps_cache_dir,
            apps_url,
            branding_file,
            health_dir,
            database_url,
            bootstrap_admins,
            journey_users,
            keycloak_admin,
            app_settings,
            build_pods,
            agent_settings,
            app_tests,
            basemap,
            artifact_store,
            pipeline_secrets,
        })
    }

    pub fn for_tests() -> Self {
        Self {
            bind: SocketAddr::from(([127, 0, 0, 1], 0)),
            public_base_url: Url::parse("http://localhost:8080")
                .unwrap_or_else(|_| unreachable!("valid test url")),
            oidc: None,
            trust_edge_token: false,
            setup: SetupStatements::default(),
            artifact_store: None,
            pipeline_secrets: None,
            cookie_key: Key::generate(),
            cookie_keys_previous: Vec::new(),
            sync_interval: Duration::ZERO,
            gitea_webhook_secret: None,
            gitea_webhook_secret_previous: None,
            pipeline_runner_url: None,
            gateway_url: None,
            gateway_client_id: None,
            agent_proxy_client_id: None,
            pipeline_runner_client_id: None,
            broker_url: None,
            org_domain: None,
            pipeline_test_capture_url: None,
            model_tools_url: None,
            functions_url: None,
            app_settings: None,
            build_pods: None,
            agent_settings: None,
            app_tests: None,
            basemap: None,
            apps_dir: None,
            apps_cache_dir: None,
            apps_url: None,
            branding_file: None,
            health_dir: None,
            database_url: None,
            // The dev realm's approver role: a test session that carries it may do everything,
            // one that does not is bound by whatever Role/RoleBinding the test puts in the mirror.
            bootstrap_admins: "portal-approver".to_owned(),
            journey_users: Vec::new(),
            keycloak_admin: None,
        }
    }

    /// Redirect URI registered for this portal in the Keycloak client (CC-40).
    pub fn redirect_uri(&self) -> String {
        format!(
            "{}/api/v1/auth/callback",
            self.public_base_url.as_str().trim_end_matches('/')
        )
    }
}

/// The configuration reference is generated from the doc comments of this module, so a
/// variable read without one is caught here rather than in the docs lane (T-2140, OPS-27).
#[cfg(test)]
#[path = "config_documentation_tests.rs"]
mod config_documentation_tests;

#[cfg(test)]
mod tests {
    use super::*;

    /// T-2772: a run waiting for approval has seven days unless `JC_AGENT_APPROVAL_TTL` says
    /// otherwise, and a lease that is not a positive number of seconds is refused at start.
    #[test]
    fn the_approval_lease_defaults_to_a_week_and_refuses_nonsense() {
        let with = |ttl: Option<&'static str>| {
            agent_settings(&move |name: &str| match name {
                "JC_AGENTS_NAMESPACE" => Some("agents".to_owned()),
                "JC_AGENT_PROXY_BASE" => Some("http://proxy:8080".to_owned()),
                "JC_AGENT_APPROVAL_TTL" => ttl.map(str::to_owned),
                _ => None,
            })
        };
        let settings = |ttl| with(ttl).ok().flatten().map(|s| s.approval_ttl_secs);
        assert_eq!(settings(None), Some(604_800));
        assert_eq!(settings(Some("172800")), Some(172_800));
        for bad in ["0", "-5", "a week"] {
            assert!(with(Some(bad)).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_test_sandbox_is_a_namespace_and_an_image_pinned_by_digest_or_nothing() {
        let with = |namespace: &'static str, image: &'static str| {
            Config::from_vars(move |name| match name {
                "JC_PORTAL_APP_TESTS_NAMESPACE" => Some(namespace.to_owned()),
                "JC_PORTAL_APP_TESTS_IMAGE" => Some(image.to_owned()),
                _ => None,
            })
        };
        let digest = "a".repeat(64);
        let image: &'static str = Box::leak(
            format!("ghcr.io/x/joinedcontext-app-builder:main@sha256:{digest}").into_boxed_str(),
        );
        let settings = with("dev-app-tests", image).unwrap().app_tests.unwrap();
        assert_eq!(settings.namespace, "dev-app-tests");
        assert_eq!(settings.image, image);
        assert_eq!(Config::from_vars(|_| None).unwrap().app_tests, None);
        assert_eq!(with(" ", " ").unwrap().app_tests, None);
        for (namespace, image) in [
            ("dev-app-tests", "ghcr.io/x/joinedcontext-app-builder:main"),
            ("dev-app-tests", "ghcr.io/x/builder@sha256:ABC"),
            ("Dev_Tests", image),
            ("dev-app-tests", ""),
            ("", image),
        ] {
            assert!(
                with(namespace, image).is_err(),
                "{namespace} {image} was accepted"
            );
        }
    }

    #[test]
    fn the_apps_origin_is_an_origin_and_nothing_else() {
        let with = |value: &'static str| {
            Config::from_vars(move |name| (name == "JC_PORTAL_APPS_URL").then(|| value.to_owned()))
        };
        assert_eq!(Config::from_vars(|_| None).unwrap().apps_url, None);
        assert_eq!(with("  ").unwrap().apps_url, None);
        assert_eq!(
            with("https://example.org")
                .unwrap()
                .apps_url
                .unwrap()
                .as_str(),
            "https://example.org/"
        );
        for refused in [
            "example.org",
            "ftp://example.org",
            "https://example.org/apps",
            "https://example.org/?x=1",
        ] {
            assert!(
                matches!(
                    with(refused),
                    Err(ConfigError::Invalid {
                        var: "JC_PORTAL_APPS_URL",
                        ..
                    })
                ),
                "{refused}"
            );
        }
    }

    #[test]
    fn default_values() {
        let config = Config::from_vars(|_| None).expect("default config");
        assert_eq!(
            config.bind,
            "0.0.0.0:8080".parse().expect("parse default bind")
        );
        assert_eq!(config.public_base_url.as_str(), "http://localhost:8080/");
    }

    #[test]
    fn custom_valid_values() {
        let config = Config::from_vars(|k| match k {
            "JC_PORTAL_BIND" => Some("127.0.0.1:9090".to_string()),
            "JC_PORTAL_PUBLIC_URL" => Some("https://portal.example.com".to_string()),
            _ => None,
        })
        .expect("custom config");
        assert_eq!(
            config.bind,
            "127.0.0.1:9090".parse().expect("parse custom bind")
        );
        assert_eq!(
            config.public_base_url.as_str(),
            "https://portal.example.com/"
        );
    }

    #[test]
    fn invalid_bind_produces_error() {
        let err = Config::from_vars(|k| match k {
            "JC_PORTAL_BIND" => Some("invalid-bind".to_string()),
            _ => None,
        })
        .expect_err("should fail with invalid bind");

        match err {
            ConfigError::Invalid { var, .. } => assert_eq!(var, "JC_PORTAL_BIND"),
        }
    }

    #[test]
    fn invalid_public_url_produces_error() {
        let err = Config::from_vars(|k| match k {
            "JC_PORTAL_PUBLIC_URL" => Some("not a valid url".to_string()),
            _ => None,
        })
        .expect_err("should fail with invalid url");

        match err {
            ConfigError::Invalid { var, .. } => assert_eq!(var, "JC_PORTAL_PUBLIC_URL"),
        }
    }

    #[test]
    fn partial_oidc_configuration_is_rejected() {
        let err = Config::from_vars(|k| match k {
            "JC_OIDC_ISSUER" => Some("https://idm.example.sk/realms/bb".to_string()),
            _ => None,
        })
        .expect_err("partial oidc config must fail closed");
        match err {
            ConfigError::Invalid { var, .. } => assert_eq!(var, "JC_OIDC_ISSUER"),
        }
    }

    #[test]
    fn complete_oidc_configuration_is_accepted_and_redacts_the_secret() {
        let config = Config::from_vars(|k| match k {
            "JC_OIDC_ISSUER" => Some("https://idm.example.sk/realms/bb".to_string()),
            "JC_OIDC_CLIENT_ID" => Some("portal".to_string()),
            "JC_OIDC_CLIENT_SECRET" => Some("s3cr3t".to_string()),
            _ => None,
        })
        .expect("oidc config");
        let oidc = config.oidc.as_ref().expect("oidc present");
        assert_eq!(oidc.client_id, "portal");
        assert_eq!(oidc.client_secret(), "s3cr3t");
        let dumped = format!("{config:?}");
        assert!(
            !dumped.contains("s3cr3t"),
            "client secret leaked into Debug: {dumped}"
        );
        assert!(dumped.contains("[redacted]"));
    }

    #[test]
    fn oidc_ca_file_is_read_from_disk() {
        let path = std::env::temp_dir().join(format!("jc-portal-ca-{}.pem", std::process::id()));
        std::fs::write(&path, b"-----BEGIN CERTIFICATE-----\nnot-a-real-one\n").expect("write pem");
        let config = Config::from_vars(|k| match k {
            "JC_OIDC_ISSUER" => Some("https://idm.example.sk/realms/bb".to_string()),
            "JC_OIDC_CLIENT_ID" => Some("portal".to_string()),
            "JC_OIDC_CLIENT_SECRET" => Some("s3cr3t".to_string()),
            "JC_OIDC_CA_FILE" => Some(path.display().to_string()),
            _ => None,
        })
        .expect("oidc config with a ca file");
        let _ = std::fs::remove_file(&path);
        let pem = config
            .oidc
            .as_ref()
            .expect("oidc present")
            .extra_ca_pem
            .as_ref()
            .expect("ca pem loaded");
        assert!(pem.starts_with(b"-----BEGIN CERTIFICATE-----"));
    }

    #[test]
    fn oidc_configuration_without_a_ca_file_carries_no_extra_root() {
        let config = Config::from_vars(|k| match k {
            "JC_OIDC_ISSUER" => Some("https://idm.example.sk/realms/bb".to_string()),
            "JC_OIDC_CLIENT_ID" => Some("portal".to_string()),
            "JC_OIDC_CLIENT_SECRET" => Some("s3cr3t".to_string()),
            _ => None,
        })
        .expect("oidc config");
        assert!(config.oidc.expect("oidc present").extra_ca_pem.is_none());
    }

    #[test]
    fn unreadable_oidc_ca_file_stops_start_up() {
        let err = Config::from_vars(|k| match k {
            "JC_OIDC_ISSUER" => Some("https://idm.example.sk/realms/bb".to_string()),
            "JC_OIDC_CLIENT_ID" => Some("portal".to_string()),
            "JC_OIDC_CLIENT_SECRET" => Some("s3cr3t".to_string()),
            "JC_OIDC_CA_FILE" => Some("/nonexistent/jc-portal/ca.crt".to_string()),
            _ => None,
        })
        .expect_err("a mount that is not there must fail closed, not lose the root silently");
        match err {
            ConfigError::Invalid { var, reason } => {
                assert_eq!(var, "JC_OIDC_CA_FILE");
                assert!(
                    reason.contains("/nonexistent/jc-portal/ca.crt"),
                    "the operator needs the path in the message: {reason}"
                );
            }
        }
    }

    #[test]
    fn short_cookie_key_is_rejected() {
        let err = Config::from_vars(|k| match k {
            "JC_PORTAL_COOKIE_KEY" => Some("too-short".to_string()),
            _ => None,
        })
        .expect_err("short cookie key must fail");
        match err {
            ConfigError::Invalid { var, .. } => assert_eq!(var, "JC_PORTAL_COOKIE_KEY"),
        }
    }

    #[test]
    fn redirect_uri_is_derived_from_the_public_base_url() {
        let config = Config::from_vars(|k| match k {
            "JC_PORTAL_PUBLIC_URL" => Some("https://portal.example.sk".to_string()),
            _ => None,
        })
        .expect("config");
        assert_eq!(
            config.redirect_uri(),
            "https://portal.example.sk/api/v1/auth/callback"
        );
    }

    #[test]
    fn for_tests_provides_valid_config() {
        let cfg = Config::for_tests();
        assert_eq!(cfg.bind.port(), 0);
    }

    #[test]
    fn sync_interval_and_webhook_secret_configuration() {
        let config = Config::from_vars(|k| match k {
            "JC_PORTAL_SYNC_INTERVAL" => Some("30".to_string()),
            "JC_GITEA_WEBHOOK_SECRET" => Some("my-secret".to_string()),
            _ => None,
        })
        .expect("config");
        assert_eq!(config.sync_interval, Duration::from_secs(30));
        assert_eq!(config.gitea_webhook_secret.as_deref(), Some("my-secret"));

        let debug = format!("{config:?}");
        assert!(!debug.contains("my-secret"));
        assert!(debug.contains("[redacted]"));

        let err = Config::from_vars(|k| match k {
            "JC_PORTAL_SYNC_INTERVAL" => Some("not-a-number".to_string()),
            _ => None,
        })
        .expect_err("should reject invalid sync interval");
        match err {
            ConfigError::Invalid { var, .. } => assert_eq!(var, "JC_PORTAL_SYNC_INTERVAL"),
        }
    }

    /// T-0411, AP-18: a Portal deploys an app only when it is told where. Guessing a namespace
    /// would mean writing a Deployment into somebody else's.
    #[test]
    fn build_pods_start_only_with_a_namespace_and_then_need_pinned_images() {
        let complete = |k: &str| match k {
            "JC_PORTAL_PUBLIC_URL" => Some("https://bb.example.sk".to_string()),
            "JC_PORTAL_BUILD_NAMESPACE" => Some("dev".to_string()),
            "JC_PORTAL_BUILD_IMAGE_NODE" => Some("r.example.org/builder@sha256:aa".to_string()),
            "JC_PORTAL_BUILD_IMAGE_RUST" => Some("r.example.org/rust@sha256:bb".to_string()),
            "JC_GITEA_URL" => Some("http://gitea-http.dev.svc.cluster.local:3000".to_string()),
            _ => None,
        };
        let settings = Config::from_vars(complete)
            .expect("a complete configuration")
            .build_pods
            .expect("every part is there");
        assert_eq!(settings.cache_size, "1Gi");
        assert_eq!(
            settings.forge,
            "http://gitea-http.dev.svc.cluster.local:3000"
        );

        let without_namespace = Config::from_vars(|k| match k {
            "JC_PORTAL_BUILD_NAMESPACE" => None,
            other => complete(other),
        })
        .expect("a Portal without build pods is still a Portal");
        assert!(without_namespace.build_pods.is_none());

        for (var, value) in [
            ("JC_PORTAL_BUILD_IMAGE_RUST", None),
            (
                "JC_PORTAL_BUILD_IMAGE_NODE",
                Some("r.example.org/builder:latest"),
            ),
            ("JC_PORTAL_BUILD_NAMESPACE", Some("Dev_ns")),
            ("JC_PORTAL_BUILD_CACHE_SIZE", Some("1TB")),
            ("JC_PORTAL_BUILD_CACHE_SIZE", Some("Gi")),
            ("JC_GITEA_URL", None),
        ] {
            let refused = Config::from_vars(|k| match k == var {
                true => value.map(str::to_owned),
                false => complete(k),
            });
            assert!(refused.is_err(), "{var}={value:?} was accepted");
        }
    }

    #[test]
    fn app_settings_need_every_part_and_derive_the_one_they_can() {
        let complete = |k: &str| match k {
            "JC_PORTAL_PUBLIC_URL" => Some("https://bb.example.sk".to_string()),
            "JC_PORTAL_APPS_NAMESPACE" => Some("joinedcontext".to_string()),
            "JC_PORTAL_ORG_DOMAIN" => Some("banskabystrica.sk".to_string()),
            _ => None,
        };
        let settings = Config::from_vars(complete)
            .expect("a complete configuration")
            .app_settings
            .expect("every part is there");
        assert_eq!(settings.namespace, "joinedcontext");
        assert_eq!(settings.org_domain, "banskabystrica.sk");
        // Not a variable of its own: the host is the Portal's public URL. No realm and no
        // sidecar image any more: the login front is the edge's one `edge` client (ADR-N-019).
        assert_eq!(settings.host, "bb.example.sk");

        for missing in ["JC_PORTAL_APPS_NAMESPACE", "JC_PORTAL_ORG_DOMAIN"] {
            let config = Config::from_vars(|k| match k == missing {
                true => None,
                false => complete(k),
            })
            .expect("a Portal without apps is still a Portal");
            assert!(config.app_settings.is_none(), "{missing} was not needed");
        }
    }

    /// AP-108: a pod-backed App's image is composed from the registry and the forge's
    /// organization, pulled with the named Secret, and reached from the configured APISIX
    /// namespace; a registry that is not a bare host, or a name that is not a Kubernetes name,
    /// stops the Portal at start rather than rendering a pod no node can pull.
    #[test]
    fn app_settings_compose_the_image_repository_and_refuse_what_no_node_resolves() {
        let with = |extra: Vec<(&'static str, &'static str)>| {
            move |k: &str| match k {
                "JC_PORTAL_PUBLIC_URL" => Some("https://bb.example.sk".to_string()),
                "JC_PORTAL_APPS_NAMESPACE" => Some("joinedcontext".to_string()),
                "JC_PORTAL_ORG_DOMAIN" => Some("banskabystrica.sk".to_string()),
                _ => extra
                    .iter()
                    .find(|(key, _)| *key == k)
                    .map(|(_, value)| (*value).to_string()),
            }
        };
        let plain = Config::from_vars(with(vec![]))
            .unwrap()
            .app_settings
            .unwrap();
        assert_eq!(plain.apisix_namespace, "apisix");
        assert_eq!((plain.image_repository, plain.pull_secret), (None, None));

        let dev = Config::from_vars(with(vec![
            ("JC_PORTAL_APPS_REGISTRY", "2.28.67.127.sslip.io"),
            ("JC_GITEA_OWNER", "joinedcontext"),
            ("JC_PORTAL_APPS_PULL_SECRET_NAME", "app-registry"),
            ("JC_PORTAL_APISIX_NAMESPACE", "dev"),
        ]))
        .unwrap()
        .app_settings
        .unwrap();
        assert_eq!(
            dev.image_of("air-quality", "sha256:ab").as_deref(),
            Some("2.28.67.127.sslip.io/joinedcontext/app-air-quality@sha256:ab")
        );
        assert_eq!(dev.pull_secret.as_deref(), Some("app-registry"));
        assert_eq!(dev.apisix_namespace, "dev");

        // PF-106: an installation whose applications have their own organization publishes and
        // pulls their images there.
        let apart = Config::from_vars(with(vec![
            ("JC_PORTAL_APPS_REGISTRY", "2.28.67.127.sslip.io"),
            ("JC_GITEA_OWNER", "joinedcontext"),
            ("JC_GITEA_APPS_OWNER", "joinedcontext-apps"),
        ]))
        .unwrap()
        .app_settings
        .unwrap();
        assert_eq!(
            apart.image_of("air-quality", "sha256:ab").as_deref(),
            Some("2.28.67.127.sslip.io/joinedcontext-apps/app-air-quality@sha256:ab")
        );

        for (var, value) in [
            ("JC_PORTAL_APPS_REGISTRY", "https://forge.example.org"),
            ("JC_PORTAL_APPS_REGISTRY", "forge.example.org/git"),
            ("JC_PORTAL_APPS_REGISTRY", "forge.example.org:"),
            ("JC_PORTAL_APPS_REGISTRY", "Forge.example.org"),
            ("JC_PORTAL_APPS_PULL_SECRET_NAME", "App_Registry"),
            ("JC_PORTAL_APISIX_NAMESPACE", "dev/x"),
        ] {
            match Config::from_vars(with(vec![
                (var, value),
                ("JC_GITEA_OWNER", "joinedcontext"),
            ])) {
                Err(ConfigError::Invalid { var: refused, .. }) => {
                    assert_eq!(refused, var, "{value}")
                }
                Ok(_) => panic!("{var}={value} was accepted"),
            }
        }
        match Config::from_vars(with(vec![("JC_PORTAL_APPS_REGISTRY", "forge.example.org")])) {
            Err(ConfigError::Invalid { reason, .. }) => assert!(reason.contains("JC_GITEA_OWNER")),
            Ok(_) => panic!("a registry without the forge's organization was accepted"),
        }
    }

    /// ADR-N-019: the edge token is trusted on the literal `true` and on nothing else.
    #[test]
    fn the_edge_token_is_trusted_only_when_asked_for_in_so_many_words() {
        assert!(!Config::from_vars(|_| None).unwrap().trust_edge_token);
        for value in ["1", "yes", "TRUE", ""] {
            let config = Config::from_vars(|k| match k {
                "JC_TRUST_EDGE_TOKEN" => Some(value.to_string()),
                _ => None,
            })
            .unwrap();
            assert!(!config.trust_edge_token, "{value:?} opened the door");
        }
        let config = Config::from_vars(|k| match k {
            "JC_TRUST_EDGE_TOKEN" => Some("true".to_string()),
            _ => None,
        })
        .unwrap();
        assert!(config.trust_edge_token);
    }

    /// T-2748: the setup statements are read as said, and unset, blank or misspelled is "not said".
    #[test]
    fn the_setup_statements_say_only_what_the_deployment_said() {
        let silent = Config::from_vars(|_| None).unwrap().setup;
        assert_eq!(silent, SetupStatements::default());
        let said = Config::from_vars(|k| match k {
            "JC_SETUP_LOGIN_THEME" => Some(" joinedcontext ".to_string()),
            "JC_SETUP_SMTP" => Some("true".to_string()),
            "JC_SETUP_BACKUPS" => Some("yes".to_string()),
            _ => None,
        })
        .unwrap()
        .setup;
        assert_eq!(said.login_theme.as_deref(), Some("joinedcontext"));
        assert!(said.smtp && !said.backups);
        let blank = Config::from_vars(|k| (k == "JC_SETUP_LOGIN_THEME").then(|| "  ".to_string()))
            .unwrap()
            .setup;
        assert_eq!(blank.login_theme, None);
    }

    #[test]
    fn basemap_configuration_validation() {
        let config = Config::from_vars(|k| match k {
            "JC_BASEMAP_URL" => Some("https://tiles.example.com/{z}/{x}/{y}.png".to_string()),
            "JC_BASEMAP_ATTRIBUTION" => Some("OpenStreetMap".to_string()),
            _ => None,
        })
        .expect("valid basemap config");
        let bm = config.basemap.expect("basemap present");
        assert_eq!(bm.max_zoom, 19);
        assert_eq!(bm.attribution, "OpenStreetMap");
        assert!(!bm.allow_http);

        // Missing attribution when url is present
        let err = Config::from_vars(|k| match k {
            "JC_BASEMAP_URL" => Some("https://tiles.example.com/{z}/{x}/{y}.png".to_string()),
            _ => None,
        })
        .expect_err("attribution required");
        assert!(matches!(
            err,
            ConfigError::Invalid {
                var: "JC_BASEMAP_ATTRIBUTION",
                ..
            }
        ));

        // http url is rejected from environment
        let err = Config::from_vars(|k| match k {
            "JC_BASEMAP_URL" => Some("http://tiles.example.com/{z}/{x}/{y}.png".to_string()),
            "JC_BASEMAP_ATTRIBUTION" => Some("OSM".to_string()),
            _ => None,
        })
        .expect_err("http rejected");
        assert!(matches!(
            err,
            ConfigError::Invalid {
                var: "JC_BASEMAP_URL",
                ..
            }
        ));
    }
}
