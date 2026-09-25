//! The APISIX file the edge serves (ADR-N-030, AP-112, T-2668).
//!
//! Helm renders the platform's shared routes into the ConfigMap `apisix-standalone-base`. Every
//! run, this wave reads that base, adds the routes of each published App whose Keycloak client
//! is in place, and writes the result into the Secret `apisix-standalone-config`, which APISIX
//! mounts and reloads. It writes only when the file changed, so an unchanged run is no reload,
//! and a base change reaches the edge on the next run.
//!
//! Every App is served on a host of its own, `{name}.apps.{domain}` (ADR-N-037, AP-133): the
//! browser's same-origin policy is then what keeps one App's storage, cookies and frames from
//! every other App, the forge and the endpoints. The App's host routes the App and the slugs of
//! the endpoints it reads, nothing else, and its old path on the apex answers a `308` there.
//!
//! An App's routes copy the base's own plugin chains, the `apps-surface` plugin config for the
//! App and `context-endpoint` for its endpoint, and change only the login: the App's client, its
//! secret, its cookie host-only on its host. Header stripping, security headers and rate limits
//! therefore stay where helm renders them. The composed file holds every App's client secret,
//! which is why it is a Secret; nothing here logs it or puts it in an error.

use std::collections::BTreeMap;

use base64::Engine as _;
use jc_core::kinds::AppLifecycle;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use super::app_clients::{client_id, ClientSecret};
use crate::apps::kube::{KubeClient, KubeError};
use crate::apps::reconciler::{Settings, APP_PORT};
use crate::store::Mirror;

/// The ConfigMap helm renders the shared routes into.
pub const BASE_CONFIG_MAP: &str = "apisix-standalone-base";
/// The Secret APISIX mounts its rule file from.
pub const SERVED_SECRET: &str = "apisix-standalone-config";
/// The key both objects keep the file under.
pub const FILE_KEY: &str = "apisix.yaml";
/// Set on the Secret once this wave wrote it: from then on helm no longer renders it.
pub const COMPOSED_BY: &str = "joinedcontext.com/composed-by";
const COMPOSED_BY_VALUE: &str = "portal";
/// APISIX standalone reads a file only when it ends with this line.
const END_MARKER: &str = "#END";
const APP_PRIORITY: u64 = 30;
const ENDPOINT_PRIORITY: u64 = 35;
/// The base's plugin config an App's own route is modelled on: the edge login, the header strip,
/// the rate limit and the security headers of a page.
const APPS_SURFACE: &str = "apps-surface";
/// The base's route and plugin config an App's endpoint route is modelled on; its host is the
/// apex, the domain every App's host sits under.
const CONTEXT_ENDPOINT: &str = "context-endpoint";
/// The base's route whose upstream is the Portal, which serves a `static` App's files.
const PORTAL_UI: &str = "portal-ui";

/// Where an App's own route sends its requests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Upstream {
    /// A `service` or `fullstack` App: its Service `app-{name}` in this namespace.
    Pod { namespace: String },
    /// A `static` App: the Portal's static host, the upstream of `portal-ui`.
    Static,
}

/// One published App, as the edge file needs it.
#[derive(Debug, Clone)]
pub struct EdgeApp {
    pub name: String,
    /// `visibility: public`: an anonymous request passes through (AP-28).
    pub public: bool,
    pub upstream: Upstream,
    pub secret: ClientSecret,
    /// The endpoints the App reads, the only ones its host routes (AP-133).
    pub slugs: Vec<String>,
}

/// The host an App is served on, under the apex (AP-133).
pub fn app_host(name: &str, apex: &str) -> String {
    format!("{name}.apps.{apex}")
}

/// Why the base could not be composed. Never carries a client secret.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ComposeError {
    #[error("the base {BASE_CONFIG_MAP} is not an APISIX file: {0}")]
    Unreadable(String),
    #[error("the base {BASE_CONFIG_MAP} has no {0}, which the App routes are modelled on")]
    Missing(String),
}

/// The composed file, and the Apps that got no route with the reason.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Composed {
    pub file: String,
    pub skipped: Vec<(String, String)>,
}

fn by_id<'a>(document: &'a Value, list: &str, id: &str) -> Result<&'a Value, ComposeError> {
    document
        .get(list)
        .and_then(Value::as_array)
        .and_then(|items| items.iter().find(|item| item["id"] == id))
        .ok_or_else(|| ComposeError::Missing(format!("{list} entry {id}")))
}

fn ids(document: &Value, list: &str) -> Vec<String> {
    document
        .get(list)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item["id"].as_str().map(str::to_owned))
        .collect()
}

fn push(document: &mut Value, list: &str, item: Value) {
    if let Some(items) = document.get_mut(list).and_then(Value::as_array_mut) {
        items.push(item);
    } else {
        document[list] = json!([item]);
    }
}

/// The session cookie's encryption key for one App: its own, so a cookie of one App decrypts at
/// no other App's route, and derived from the client secret, so it survives restarts and
/// changes when the secret does.
fn session_secret(app: &str, secret: &ClientSecret) -> String {
    let mut hash = Sha256::new();
    hash.update(b"joinedcontext app session\0");
    hash.update(app.as_bytes());
    hash.update(b"\0");
    hash.update(secret.expose().as_bytes());
    hash.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// The base's `openid-connect` login made the App's own, on its own host (ADR-N-030, AP-29):
/// the cookie is host-only on `/`, because the plugin sets no `Domain` on it.
fn login(template: &Value, host: &str, app: &EdgeApp, unauth_action: &str) -> Value {
    let name = app.name.as_str();
    let mut plugin = template.clone();
    plugin["client_id"] = json!(client_id(name));
    plugin["client_secret"] = json!(app.secret.expose());
    plugin["redirect_uri"] = json!(format!("https://{host}/callback"));
    plugin["logout_path"] = json!("/logout");
    plugin["post_logout_redirect_uri"] = json!(format!("https://{host}/"));
    plugin["unauth_action"] = json!(unauth_action);
    if !plugin["session"].is_object() {
        plugin["session"] = json!({});
    }
    plugin["session"]["secret"] = json!(session_secret(name, &app.secret));
    plugin["session"]["cookie_name"] = json!(format!("jc_app_{}", name.replace('-', "_")));
    plugin["session"]["cookie_path"] = json!("/");
    if let Some(session) = plugin["session"].as_object_mut() {
        session.remove("cookie_domain");
    }
    plugin
}

/// Sets `proxy-rewrite.regex_uri`, keeping whatever else the template's `proxy-rewrite` does.
fn rewrite_uri(plugins: &mut Value, from: String, to: String) {
    if !plugins["proxy-rewrite"].is_object() {
        plugins["proxy-rewrite"] = json!({});
    }
    plugins["proxy-rewrite"]["regex_uri"] = json!([from, to]);
}

/// Only the App's own origin and the Portal frame an App (AP-122, OPS-34): the App route adds
/// `frame-ancestors 'self'` plus the Portal's host and drops `X-Frame-Options`, whose
/// `SAMEORIGIN` would refuse the Portal. The header is added beside the App's own policy, never
/// over it: a browser enforces both, so the App's `connect-src` and the rest stay as its
/// upstream sent them.
fn framed_by_portal(plugins: &mut Value, host: &str) {
    if !plugins["response-rewrite"].is_object() {
        plugins["response-rewrite"] = json!({});
    }
    let rewrite = &mut plugins["response-rewrite"];
    if !rewrite["headers"].is_object() {
        rewrite["headers"] = json!({});
    }
    let headers = &mut rewrite["headers"];
    if let Some(set) = headers.get_mut("set").and_then(Value::as_object_mut) {
        set.retain(|name, _| !name.eq_ignore_ascii_case("x-frame-options"));
    }
    // No scheme: APISIX refuses an `add` entry with a second `:` (its pattern is
    // `^[^:]+:[^:]*[^/]$`) and drops the whole plugin config, so every App route answered 503.
    // A source without a scheme takes the App page's own, https.
    let policy = format!("Content-Security-Policy: frame-ancestors 'self' portal.{host}");
    push(headers, "add", json!(policy));
    push(headers, "remove", json!("X-Frame-Options"));
}

/// The base with every App's routes added, ending `#END` (AP-112, AP-133).
pub fn compose(base: &str, apps: &[EdgeApp]) -> Result<Composed, ComposeError> {
    let mut document: Value =
        serde_yaml_ng::from_str(base).map_err(|err| ComposeError::Unreadable(err.to_string()))?;
    if !document.is_object() {
        return Err(ComposeError::Unreadable("not a mapping".into()));
    }
    let endpoint_route = by_id(&document, "routes", CONTEXT_ENDPOINT)?.clone();
    let portal_route = by_id(&document, "routes", PORTAL_UI)?.clone();
    let surface_plugins = by_id(&document, "plugin_configs", APPS_SURFACE)?["plugins"].clone();
    let endpoint_plugins = by_id(&document, "plugin_configs", CONTEXT_ENDPOINT)?["plugins"].clone();
    let template = surface_plugins
        .get("openid-connect")
        .filter(|plugin| plugin.is_object())
        .ok_or_else(|| ComposeError::Missing(format!("openid-connect on {APPS_SURFACE}")))?
        .clone();
    let apex = endpoint_route["host"]
        .as_str()
        .ok_or_else(|| ComposeError::Missing(format!("host on route {CONTEXT_ENDPOINT}")))?
        .to_owned();
    let static_upstream = portal_route["upstream_id"].clone();
    let endpoint_upstream = endpoint_route["upstream_id"].clone();

    let taken: Vec<String> = ["routes", "upstreams", "plugin_configs"]
        .iter()
        .flat_map(|list| ids(&document, list))
        .collect();
    let mut apps: Vec<&EdgeApp> = apps.iter().collect();
    apps.sort_by(|a, b| a.name.cmp(&b.name));
    let mut skipped = Vec::new();
    for app in apps {
        let name = app.name.as_str();
        let own = format!("app-{name}");
        let endpoint = format!("app-{name}-endpoint");
        let moved = format!("app-{name}-moved");
        let host = app_host(name, &apex);
        if let Some(id) = [&own, &endpoint, &moved]
            .into_iter()
            .find(|id| taken.contains(id))
        {
            skipped.push((
                name.to_owned(),
                format!("the base already has an entry {id}"),
            ));
            continue;
        }

        let mut plugins = surface_plugins.clone();
        framed_by_portal(&mut plugins, &apex);
        plugins["openid-connect"] = login(
            &template,
            &host,
            app,
            if app.public { "pass" } else { "auth" },
        );
        if app.upstream == Upstream::Static {
            // The static host keeps a bundle under `/apps/{name}/`; the browser only ever sees
            // the App's host. A bundle built for the old path asks for `/apps/{name}/…` itself,
            // which lands on the same file.
            // ponytail: the optional prefix goes once every App is rebuilt for its host.
            rewrite_uri(
                &mut plugins,
                format!("^/(?:apps/{name}/)?(.*)$"),
                format!("/apps/{name}/$1"),
            );
        }
        push(
            &mut document,
            "plugin_configs",
            json!({ "id": own, "desc": format!("App {name} behind its own login"), "plugins": plugins }),
        );

        // The endpoint route answers the App's own requests: a request without a session is
        // a 401 for a non-public App, not a redirect a fetch cannot follow. The session's token
        // reaches the gateway as the bearer it verifies, and the prefix is stripped.
        let mut plugins = endpoint_plugins.clone();
        let mut oidc = login(
            &template,
            &host,
            app,
            if app.public { "pass" } else { "deny" },
        );
        oidc["access_token_in_authorization_header"] = json!(true);
        plugins["openid-connect"] = oidc;
        // An SDK built before the App had a host sends its calls under `/apps/{name}`; the
        // prefix is stripped, and the slug is still one of the App's own.
        rewrite_uri(
            &mut plugins,
            format!("^(?:/apps/{name})?(/api/endpoint/.*)$"),
            "$1".to_owned(),
        );
        if !app.slugs.is_empty() {
            push(
                &mut document,
                "plugin_configs",
                json!({ "id": endpoint, "desc": format!("App {name}'s endpoint behind its own login"), "plugins": plugins }),
            );
        }

        let upstream_id = match &app.upstream {
            Upstream::Pod { namespace } => {
                let mut nodes = Map::new();
                nodes.insert(
                    format!("app-{name}.{namespace}.svc.cluster.local:{APP_PORT}"),
                    json!(1),
                );
                push(
                    &mut document,
                    "upstreams",
                    json!({
                        "id": own,
                        "type": "roundrobin",
                        "nodes": nodes,
                        "timeout": { "connect": 6, "send": 30, "read": 30 },
                    }),
                );
                json!(own)
            }
            Upstream::Static => static_upstream.clone(),
        };
        push(
            &mut document,
            "routes",
            json!({
                "id": own,
                "name": own,
                "desc": format!("App {name}"),
                "uri": "/*",
                "host": host,
                "priority": APP_PRIORITY,
                "upstream_id": upstream_id,
                "plugin_config_id": own,
            }),
        );
        // The App's own endpoints and no other slug: a page of one App cannot reach another
        // App's data through its host (AP-133). An App that reads none gets no route, so every
        // `/api/endpoint/` path on its host is the App's own 404. The delivery path the base
        // refuses on `/api/endpoint/` is refused here too and never reaches the gateway (R46).
        if !app.slugs.is_empty() {
            let uris: Vec<String> = app
                .slugs
                .iter()
                .flat_map(|slug| {
                    [
                        format!("/api/endpoint/{slug}/*"),
                        format!("/apps/{name}/api/endpoint/{slug}/*"),
                    ]
                })
                .collect();
            push(
                &mut document,
                "routes",
                json!({
                    "id": endpoint,
                    "name": endpoint,
                    "desc": format!("App {name}'s endpoint"),
                    "uris": uris,
                    "host": host,
                    "priority": ENDPOINT_PRIORITY,
                    "vars": [["uri", "!", "~~", format!("^(?:/apps/{name})?/api/endpoint/[^/]+/egress/")]],
                    "upstream_id": endpoint_upstream,
                    "plugin_config_id": endpoint,
                }),
            );
        }
        // The old address: a `308` to the host that reaches no upstream and runs no login, so
        // a bookmark still arrives and the apex never sets an App's cookie (ADR-N-037 §3).
        push(
            &mut document,
            "routes",
            json!({
                "id": moved,
                "name": moved,
                "desc": format!("App {name} moved to its own host"),
                "uris": [format!("/apps/{name}"), format!("/apps/{name}/*")],
                "host": apex,
                "priority": APP_PRIORITY,
                "plugins": {
                    "redirect": {
                        "regex_uri": [format!("^/apps/{name}/?(.*)$"), format!("https://{host}/$1")],
                        "ret_code": 308,
                        "append_query_string": true,
                    },
                },
            }),
        );
    }
    let body = serde_yaml_ng::to_string(&document)
        .map_err(|err| ComposeError::Unreadable(err.to_string()))?;
    Ok(Composed {
        file: format!("{body}{END_MARKER}\n"),
        skipped,
    })
}

/// The published Apps whose client is in place, as the edge file routes them.
pub fn edge_apps(
    mirror: &Mirror,
    secrets: &BTreeMap<String, ClientSecret>,
    settings: &Settings,
) -> (Vec<EdgeApp>, Vec<(String, String)>) {
    let mut apps = Vec::new();
    let mut skipped = Vec::new();
    for envelope in mirror.matching(|envelope| {
        envelope.kind == "App"
            && envelope.spec.get("lifecycle").and_then(Value::as_str)
                == Some(AppLifecycle::Published.as_str())
    }) {
        let name = envelope.metadata.name.clone();
        let Some(secret) = secrets.get(&name) else {
            // No client yet (or a blocked one, AP-114): the shared surface keeps answering.
            continue;
        };
        let project = envelope.metadata.namespace.clone().unwrap_or_default();
        let upstream = match envelope.spec.get("kind").and_then(Value::as_str) {
            Some("service" | "fullstack") => match settings.apps_namespace(&project) {
                Ok(namespace) => Upstream::Pod { namespace },
                Err(err) => {
                    skipped.push((name, err.to_string()));
                    continue;
                }
            },
            _ => Upstream::Static,
        };
        let public = envelope.spec.get("visibility").and_then(Value::as_str) == Some("public");
        if apps.iter().any(|app: &EdgeApp| app.name == name) {
            continue;
        }
        let spec: jc_core::kinds::AppSpec = match serde_json::from_value(envelope.spec.clone()) {
            Ok(spec) => spec,
            Err(err) => {
                skipped.push((name, format!("the App does not parse: {err}")));
                continue;
            }
        };
        let slugs = crate::apps::static_host::served_endpoints(mirror, &project, &name, &spec)
            .into_iter()
            .map(|endpoint| endpoint.slug)
            .collect();
        apps.push(EdgeApp {
            name,
            public,
            upstream,
            secret: secret.clone(),
            slugs,
        });
    }
    (apps, skipped)
}

/// What one run did to the served file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EdgeOutcome {
    /// The Secret already held this file.
    Unchanged { apps: usize },
    /// The Secret was rewritten; APISIX reloads it.
    Written { apps: usize },
    /// Nothing was written, and why. The edge keeps serving the last file.
    Failed(String),
}

/// The served file of one installation, in the APISIX namespace.
pub struct EdgeFile {
    kube: KubeClient,
    /// Where APISIX runs, and both objects live.
    namespace: String,
}

/// A kube error as a sentence that names the object and the status, never the body sent.
fn said(object: &str, err: &KubeError) -> String {
    match err {
        KubeError::Api { status, .. } => {
            format!("the API server answered {status} for {object}")
        }
        other => format!("{object}: {other}"),
    }
}

impl EdgeFile {
    pub fn new(kube: KubeClient, namespace: String) -> Self {
        Self { kube, namespace }
    }

    /// Composes the file for these Apps and writes it when it differs from what is served.
    pub async fn converge(&self, apps: &[EdgeApp]) -> (EdgeOutcome, Vec<(String, String)>) {
        let base = match self
            .kube
            .get_config_map(&self.namespace, BASE_CONFIG_MAP)
            .await
        {
            Ok(Some(map)) => map["data"][FILE_KEY].as_str().map(str::to_owned),
            Ok(None) => None,
            Err(err) => {
                return (
                    EdgeOutcome::Failed(said(&format!("ConfigMap {BASE_CONFIG_MAP}"), &err)),
                    Vec::new(),
                )
            }
        };
        let Some(base) = base else {
            return (
                EdgeOutcome::Failed(format!(
                    "the ConfigMap {BASE_CONFIG_MAP} in {} has no {FILE_KEY}; the apisix configuration chart renders it",
                    self.namespace
                )),
                Vec::new(),
            );
        };
        let composed = match compose(&base, apps) {
            Ok(composed) => composed,
            Err(err) => return (EdgeOutcome::Failed(err.to_string()), Vec::new()),
        };
        let routed = apps.len() - composed.skipped.len();
        let served = match self
            .kube
            .get("v1", "Secret", &self.namespace, SERVED_SECRET)
            .await
        {
            Ok(Some(secret)) => secret,
            Ok(None) => {
                return (
                    EdgeOutcome::Failed(format!(
                        "the Secret {SERVED_SECRET} in {} is not there; the apisix configuration chart seeds it",
                        self.namespace
                    )),
                    composed.skipped,
                )
            }
            Err(err) => {
                return (
                    EdgeOutcome::Failed(said(&format!("Secret {SERVED_SECRET}"), &err)),
                    composed.skipped,
                )
            }
        };
        let engine = base64::engine::general_purpose::STANDARD;
        let current = served["data"][FILE_KEY]
            .as_str()
            .and_then(|encoded| engine.decode(encoded).ok());
        let marked = served["metadata"]["annotations"][COMPOSED_BY] == COMPOSED_BY_VALUE;
        if marked && current.as_deref() == Some(composed.file.as_bytes()) {
            return (EdgeOutcome::Unchanged { apps: routed }, composed.skipped);
        }
        let mut next = served;
        if let Some(object) = next.as_object_mut() {
            object.remove("stringData");
        }
        next["data"] = json!({ FILE_KEY: engine.encode(composed.file.as_bytes()) });
        if !next["metadata"]["annotations"].is_object() {
            next["metadata"]["annotations"] = json!({});
        }
        next["metadata"]["annotations"][COMPOSED_BY] = json!(COMPOSED_BY_VALUE);
        match self.kube.replace(&next).await {
            Ok(()) => (EdgeOutcome::Written { apps: routed }, composed.skipped),
            Err(err) => (
                EdgeOutcome::Failed(said(&format!("Secret {SERVED_SECRET}"), &err)),
                composed.skipped,
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = r#"plugin_configs:
  - id: apps-surface
    desc: "Static apps"
    plugins:
      request-id:
        include_in_response: true
      openid-connect:
        client_id: edge
        client_secret: ${{EDGE_CLIENT_SECRET}}
        discovery: https://idm.city.example/realms/city/.well-known/openid-configuration
        unauth_action: auth
        redirect_uri: https://city.example/apps/callback
        logout_path: /apps/logout
        session:
          secret: ${{OIDC_SESSION_SECRET}}
          cookie_name: jc_edge_apps
          cookie_path: /apps/
      response-rewrite:
        headers:
          set:
            X-Content-Type-Options: nosniff
            X-Frame-Options: SAMEORIGIN
  - id: context-endpoint
    plugins:
      serverless-pre-function:
        phase: rewrite
        functions: ["return function() end"]
      proxy-rewrite:
        headers:
          set:
            X-Forwarded-Proto: https
upstreams:
  - id: portal-ui
    type: roundrobin
    nodes:
      "portal.jc.svc.cluster.local:8080": 1
  - id: context-endpoint
    type: roundrobin
    nodes:
      "context-gateway.jc.svc.cluster.local:8080": 1
routes:
  - id: portal-ui
    uri: /*
    host: portal.city.example
    priority: 1
    upstream_id: portal-ui
  - id: context-endpoint
    uri: /api/endpoint/*
    host: city.example
    priority: 20
    upstream_id: context-endpoint
    plugin_config_id: context-endpoint
#END
"#;

    fn app(name: &str, public: bool, upstream: Upstream) -> EdgeApp {
        EdgeApp {
            name: name.into(),
            public,
            upstream,
            secret: ClientSecret::from(format!("secret-of-{name}")),
            slugs: vec![format!("slug-of-{name}")],
        }
    }

    fn parsed(file: &str) -> Value {
        serde_yaml_ng::from_str(file).expect("the composed file is YAML")
    }

    #[test]
    fn no_app_leaves_the_base_as_it_is_and_ends_the_file() {
        let composed = compose(BASE, &[]).expect("composes");
        assert!(composed.file.ends_with("\n#END\n"), "{}", composed.file);
        assert_eq!(
            parsed(&composed.file),
            parsed(BASE),
            "the base changed on the way"
        );
        assert!(composed.file.contains("${{EDGE_CLIENT_SECRET}}"));
    }

    #[test]
    fn each_app_gets_its_own_login_route_and_endpoint_route() {
        let composed = compose(
            BASE,
            &[app(
                "air-quality",
                false,
                Upstream::Pod {
                    namespace: "jc-helsinki-apps".into(),
                },
            )],
        )
        .expect("composes");
        let file = parsed(&composed.file);

        let route = by_id(&file, "routes", "app-air-quality").expect("the App route");
        assert_eq!(route["uri"], "/*");
        assert_eq!(route["host"], "air-quality.apps.city.example");
        assert_eq!(route["priority"], 30);
        assert_eq!(route["upstream_id"], "app-air-quality");
        let upstream = by_id(&file, "upstreams", "app-air-quality").expect("its upstream");
        assert_eq!(
            upstream["nodes"],
            json!({ "app-air-quality.jc-helsinki-apps.svc.cluster.local:8080": 1 })
        );

        let plugins =
            &by_id(&file, "plugin_configs", "app-air-quality").expect("its plugins")["plugins"];
        assert_eq!(
            plugins["request-id"],
            json!({ "include_in_response": true })
        );
        let oidc = &plugins["openid-connect"];
        assert_eq!(oidc["client_id"], "app-air-quality");
        assert_eq!(oidc["client_secret"], "secret-of-air-quality");
        assert_eq!(oidc["unauth_action"], "auth");
        assert_eq!(
            oidc["redirect_uri"],
            "https://air-quality.apps.city.example/callback"
        );
        assert_eq!(oidc["logout_path"], "/logout");
        assert_eq!(
            oidc["post_logout_redirect_uri"],
            "https://air-quality.apps.city.example/"
        );
        assert_eq!(oidc["session"]["cookie_name"], "jc_app_air_quality");
        assert_eq!(oidc["session"]["cookie_path"], "/");
        let session = oidc["session"]["secret"]
            .as_str()
            .expect("a session secret");
        assert_eq!(session.len(), 64);
        assert!(
            !session.contains("secret-of"),
            "the client secret is the cookie key"
        );

        let endpoint =
            by_id(&file, "routes", "app-air-quality-endpoint").expect("the endpoint route");
        assert_eq!(endpoint["host"], "air-quality.apps.city.example");
        assert_eq!(
            endpoint["uris"],
            json!([
                "/api/endpoint/slug-of-air-quality/*",
                "/apps/air-quality/api/endpoint/slug-of-air-quality/*"
            ])
        );
        assert_eq!(endpoint["priority"], 35);
        assert_eq!(endpoint["upstream_id"], "context-endpoint");
        assert_eq!(
            endpoint["vars"],
            json!([[
                "uri",
                "!",
                "~~",
                "^(?:/apps/air-quality)?/api/endpoint/[^/]+/egress/"
            ]])
        );
        let plugins = &by_id(&file, "plugin_configs", "app-air-quality-endpoint")
            .expect("its plugins")["plugins"];
        assert_eq!(plugins["serverless-pre-function"]["phase"], "rewrite");
        assert_eq!(
            plugins["proxy-rewrite"]["regex_uri"],
            json!(["^(?:/apps/air-quality)?(/api/endpoint/.*)$", "$1"])
        );
        assert_eq!(
            plugins["proxy-rewrite"]["headers"]["set"]["X-Forwarded-Proto"],
            "https"
        );
        assert_eq!(plugins["openid-connect"]["unauth_action"], "deny");
        assert_eq!(
            plugins["openid-connect"]["access_token_in_authorization_header"],
            true
        );
        assert_eq!(
            plugins["openid-connect"]["session"]["cookie_name"],
            "jc_app_air_quality"
        );

        // The template is untouched, and a pod App's path is its own.
        let surface = by_id(&file, "plugin_configs", "apps-surface").expect("the surface");
        assert_eq!(surface["plugins"]["openid-connect"]["client_id"], "edge");
        let own = &by_id(&file, "plugin_configs", "app-air-quality").expect("plugins")["plugins"];
        assert!(own.get("proxy-rewrite").is_none(), "{own}");
    }

    #[test]
    fn a_public_app_passes_and_a_static_app_is_served_by_the_static_host() {
        let composed =
            compose(BASE, &[app("hsl-transport", true, Upstream::Static)]).expect("composes");
        let file = parsed(&composed.file);
        let route = by_id(&file, "routes", "app-hsl-transport").expect("the App route");
        assert_eq!(route["upstream_id"], "portal-ui");
        assert!(by_id(&file, "upstreams", "app-hsl-transport").is_err());
        // The static host keeps the bundle under its folder; a path already there lands on the
        // same file.
        let own = &by_id(&file, "plugin_configs", "app-hsl-transport").expect("plugins")["plugins"];
        let rewrite = &own["proxy-rewrite"]["regex_uri"];
        assert_eq!(rewrite[1], "/apps/hsl-transport/$1");
        let pattern = regex::Regex::new(rewrite[0].as_str().expect("a pattern")).expect("compiles");
        for (path, rest) in [
            ("/", ""),
            ("/assets/index.js", "assets/index.js"),
            ("/apps/hsl-transport/assets/index.js", "assets/index.js"),
            ("/api/functions/count", "api/functions/count"),
        ] {
            assert_eq!(&pattern.captures(path).expect(path)[1], rest, "{path}");
        }
        for id in ["app-hsl-transport", "app-hsl-transport-endpoint"] {
            let plugins = &by_id(&file, "plugin_configs", id).expect("plugins")["plugins"];
            assert_eq!(plugins["openid-connect"]["unauth_action"], "pass", "{id}");
        }
    }

    #[test]
    fn only_the_portal_frames_an_app_and_the_shared_surface_keeps_its_frame_rule() {
        let composed = compose(
            BASE,
            &[
                app("hsl-transport", true, Upstream::Static),
                app(
                    "air-quality",
                    false,
                    Upstream::Pod {
                        namespace: "jc-helsinki-apps".into(),
                    },
                ),
            ],
        )
        .expect("composes");
        let file = parsed(&composed.file);
        for id in ["app-hsl-transport", "app-air-quality"] {
            let headers = &by_id(&file, "plugin_configs", id).expect("plugins")["plugins"]
                ["response-rewrite"]["headers"];
            assert_eq!(
                headers["set"],
                json!({ "X-Content-Type-Options": "nosniff" }),
                "{id}"
            );
            assert_eq!(
                headers["add"],
                json!(["Content-Security-Policy: frame-ancestors 'self' portal.city.example"]),
                "{id}"
            );
            // APISIX's schema for `response-rewrite.headers.add`: one `:` and no trailing `/`.
            for entry in headers["add"].as_array().expect("add") {
                let entry = entry.as_str().expect("a string");
                assert_eq!(entry.matches(':').count(), 1, "{id}: {entry}");
                assert!(!entry.ends_with('/'), "{id}: {entry}");
            }
            assert_eq!(headers["remove"], json!(["X-Frame-Options"]), "{id}");
        }
        // The endpoint route answers JSON and is framed by nobody; the fallback keeps SAMEORIGIN.
        let endpoint = &by_id(&file, "plugin_configs", "app-air-quality-endpoint")
            .expect("plugins")["plugins"];
        assert!(endpoint.get("response-rewrite").is_none());
        let surface = &by_id(&file, "plugin_configs", "apps-surface").expect("the surface")
            ["plugins"]["response-rewrite"]["headers"]["set"];
        assert_eq!(surface["X-Frame-Options"], "SAMEORIGIN");
    }

    #[test]
    fn a_surface_without_a_response_rewrite_still_gets_the_frame_rule() {
        let base = BASE.replace(
            "      response-rewrite:\n        headers:\n          set:\n            X-Content-Type-Options: nosniff\n            X-Frame-Options: SAMEORIGIN\n",
            "",
        );
        assert_ne!(base, BASE, "the fixture changed");
        let composed = compose(&base, &[app("a", false, Upstream::Static)]).expect("composes");
        let file = parsed(&composed.file);
        let headers = &by_id(&file, "plugin_configs", "app-a").expect("plugins")["plugins"]
            ["response-rewrite"]["headers"];
        assert_eq!(headers["remove"], json!(["X-Frame-Options"]));
        assert!(headers["add"][0]
            .as_str()
            .is_some_and(|value| value.ends_with("frame-ancestors 'self' portal.city.example")));
    }

    #[test]
    fn two_apps_never_share_a_cookie_or_its_key() {
        let composed = compose(
            BASE,
            &[
                app("b-app", false, Upstream::Static),
                app("a-app", false, Upstream::Static),
            ],
        )
        .expect("composes");
        let file = parsed(&composed.file);
        let session = |id: &str| {
            by_id(&file, "plugin_configs", id).expect("plugins")["plugins"]["openid-connect"]
                ["session"]
                .clone()
        };
        assert_ne!(
            session("app-a-app")["secret"],
            session("app-b-app")["secret"]
        );
        assert_ne!(
            session("app-a-app")["cookie_name"],
            session("app-b-app")["cookie_name"]
        );
        // Sorted by name, so the same Apps always compose the same file.
        let again = compose(
            BASE,
            &[
                app("a-app", false, Upstream::Static),
                app("b-app", false, Upstream::Static),
            ],
        )
        .expect("composes");
        assert_eq!(composed.file, again.file);
    }

    #[test]
    fn a_base_without_the_surfaces_is_refused_by_name() {
        let without = BASE.replace("id: context-endpoint", "id: something-else");
        assert_eq!(
            compose(&without, &[]),
            Err(ComposeError::Missing(
                "routes entry context-endpoint".into()
            ))
        );
        assert!(matches!(
            compose("routes: [", &[]),
            Err(ComposeError::Unreadable(_))
        ));
    }

    #[test]
    fn an_app_whose_id_the_base_holds_gets_no_route() {
        let base = BASE.replace(
            "routes:\n",
            "routes:\n  - id: app-portal\n    uri: /x\n    upstream_id: portal-ui\n",
        );
        let composed = compose(&base, &[app("portal", false, Upstream::Static)]).expect("composes");
        assert_eq!(composed.skipped.len(), 1);
        assert!(!composed.file.contains("secret-of-portal"));
    }

    #[test]
    fn a_base_without_the_portal_route_is_refused_by_name() {
        let without = BASE.replace("id: portal-ui\n    uri", "id: elsewhere\n    uri");
        assert_eq!(
            compose(&without, &[]),
            Err(ComposeError::Missing("routes entry portal-ui".into()))
        );
    }

    /// AP-133: an App's host routes its own slugs and no other App's; an App that reads no
    /// endpoint gets no endpoint route at all.
    #[test]
    fn an_app_host_routes_its_own_slugs_only() {
        let mut reads_none = app("bare", false, Upstream::Static);
        reads_none.slugs.clear();
        let composed = compose(
            BASE,
            &[
                app("a-app", false, Upstream::Static),
                app("b-app", true, Upstream::Static),
                reads_none,
            ],
        )
        .expect("composes");
        let file = parsed(&composed.file);
        for route in file["routes"].as_array().expect("routes") {
            let text = route.to_string();
            match route["host"].as_str() {
                Some("a-app.apps.city.example") => assert!(!text.contains("b-app"), "{text}"),
                Some("b-app.apps.city.example") => assert!(!text.contains("a-app"), "{text}"),
                _ => {}
            }
        }
        assert!(by_id(&file, "routes", "app-bare-endpoint").is_err());
        assert!(by_id(&file, "plugin_configs", "app-bare-endpoint").is_err());
        assert!(by_id(&file, "routes", "app-bare").is_ok());
    }

    /// ADR-N-037 §3: the old path on the apex is a 308 to the host with no login and no
    /// upstream, the rest of the path and the query carried over.
    #[test]
    fn the_old_path_moves_to_the_host_without_a_session() {
        let composed =
            compose(BASE, &[app("air-quality", false, Upstream::Static)]).expect("composes");
        let file = parsed(&composed.file);
        let moved = by_id(&file, "routes", "app-air-quality-moved").expect("the redirect");
        assert_eq!(moved["host"], "city.example");
        assert_eq!(
            moved["uris"],
            json!(["/apps/air-quality", "/apps/air-quality/*"])
        );
        assert!(moved.get("upstream_id").is_none());
        assert!(moved.get("plugin_config_id").is_none());
        let plugins = moved["plugins"].as_object().expect("plugins");
        assert_eq!(plugins.keys().collect::<Vec<_>>(), ["redirect"]);
        let redirect = &plugins["redirect"];
        assert_eq!(redirect["ret_code"], 308);
        assert_eq!(redirect["append_query_string"], true);
        assert_eq!(
            redirect["regex_uri"][1],
            "https://air-quality.apps.city.example/$1"
        );
        let pattern = regex::Regex::new(redirect["regex_uri"][0].as_str().expect("a pattern"))
            .expect("compiles");
        for (path, rest) in [
            ("/apps/air-quality", ""),
            ("/apps/air-quality/", ""),
            ("/apps/air-quality/stations/5", "stations/5"),
        ] {
            assert_eq!(&pattern.captures(path).expect(path)[1], rest, "{path}");
        }
        assert!(!moved.to_string().contains("secret-of"));
    }

    #[test]
    fn a_compose_error_never_carries_a_secret() {
        let err = compose("[", &[app("a", false, Upstream::Static)]).expect_err("unreadable");
        assert!(!err.to_string().contains("secret-of"));
    }
}
