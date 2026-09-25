//! The file the edge serves, written through the API server (T-2668, ADR-N-030, AP-112): the
//! reconciler reads helm's base, adds each App's routes and replaces the Secret APISIX mounts,
//! only when it changed, and never says a client secret in what it reports.

use base64::Engine as _;
use serde_json::{json, Value};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

use jc_core::kinds::OrganizationLimits;
use joinedcontext_portal::apps::kube::KubeClient;
use joinedcontext_portal::reconciler::app_clients::ClientSecret;
use joinedcontext_portal::reconciler::edge_file::{
    compose, EdgeApp, EdgeFile, EdgeLimits, EdgeOutcome, Upstream, COMPOSED_BY,
};

const NS: &str = "apisix";
const BASE_PATH: &str = "/api/v1/namespaces/apisix/configmaps/apisix-standalone-base";
const SECRET_PATH: &str = "/api/v1/namespaces/apisix/secrets/apisix-standalone-config";
const CLIENT_SECRET: &str = "kc-generated-7f3a9c2e";

const BASE: &str = r#"plugin_configs:
  - id: apps-surface
    plugins:
      openid-connect:
        client_id: edge
        client_secret: ${{EDGE_CLIENT_SECRET}}
        unauth_action: auth
        session:
          secret: ${{OIDC_SESSION_SECRET}}
  - id: context-endpoint
    plugins:
      request-id:
        include_in_response: true
upstreams:
  - id: portal-ui
    nodes:
      "portal.jc.svc.cluster.local:8080": 1
  - id: context-endpoint
    nodes:
      "context-gateway.jc.svc.cluster.local:8080": 1
routes:
  - id: portal-ui
    uri: /*
    host: portal.city.example
    upstream_id: portal-ui
  - id: context-endpoint
    uri: /api/endpoint/*
    host: city.example
    upstream_id: context-endpoint
    plugin_config_id: context-endpoint
#END
"#;

fn apps() -> Vec<EdgeApp> {
    vec![EdgeApp {
        name: "air-quality".into(),
        public: false,
        upstream: Upstream::Pod {
            namespace: "jc-helsinki-apps".into(),
        },
        secret: ClientSecret::from(CLIENT_SECRET.to_owned()),
        slugs: vec!["k4y7pq2mzt6vhx3nbwrs5cjd8f".into()],
    }]
}

fn b64(text: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(text)
}

/// The Secret as helm seeded it: the base, helm's own labels and `keep`.
fn seeded(file: &str, annotations: Value) -> Value {
    json!({
        "apiVersion": "v1",
        "kind": "Secret",
        "metadata": {
            "name": "apisix-standalone-config",
            "namespace": NS,
            "resourceVersion": "4711",
            "labels": { "app.kubernetes.io/managed-by": "Helm" },
            "annotations": annotations,
        },
        "type": "Opaque",
        "data": { "apisix.yaml": b64(file) },
    })
}

async fn api(secret: Option<Value>) -> MockServer {
    api_on(BASE, secret).await
}

/// The API server with this base in helm's ConfigMap.
async fn api_on(base: &str, secret: Option<Value>) -> MockServer {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(BASE_PATH))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "apiVersion": "v1", "kind": "ConfigMap",
            "metadata": { "name": "apisix-standalone-base", "namespace": NS },
            "data": { "apisix.yaml": base },
        })))
        .mount(&server)
        .await;
    let answer = match secret {
        Some(secret) => ResponseTemplate::new(200).set_body_json(secret),
        None => ResponseTemplate::new(404).set_body_json(json!({ "kind": "Status", "code": 404 })),
    };
    Mock::given(method("GET"))
        .and(path(SECRET_PATH))
        .respond_with(answer)
        .mount(&server)
        .await;
    server
}

fn edge(server: &MockServer) -> EdgeFile {
    EdgeFile::new(
        KubeClient::with_token(&server.uri(), "token").expect("a client"),
        NS.to_owned(),
    )
}

fn put_body(request: &Request) -> Value {
    serde_json::from_slice(&request.body).expect("a JSON body")
}

/// AP-112: the seeded Secret is replaced with the composed file under its own resourceVersion,
/// keeps helm's labels and `keep`, and is marked as the Portal's from then on.
#[tokio::test]
async fn the_seeded_secret_is_replaced_with_the_composed_file_and_marked() {
    let server = api(Some(seeded(
        BASE,
        json!({ "helm.sh/resource-policy": "keep" }),
    )))
    .await;
    Mock::given(method("PUT"))
        .and(path(SECRET_PATH))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .expect(1)
        .mount(&server)
        .await;

    let (outcome, skipped) = edge(&server).converge(&apps(), None).await;
    assert_eq!(outcome, EdgeOutcome::Written { apps: 1 });
    assert!(skipped.is_empty(), "{skipped:?}");

    let requests = server.received_requests().await.expect("recorded");
    let put = requests
        .iter()
        .find(|r| r.method.as_str() == "PUT")
        .expect("a PUT");
    let body = put_body(put);
    assert_eq!(body["metadata"]["resourceVersion"], "4711");
    assert_eq!(
        body["metadata"]["labels"]["app.kubernetes.io/managed-by"],
        "Helm"
    );
    assert_eq!(
        body["metadata"]["annotations"]["helm.sh/resource-policy"],
        "keep"
    );
    assert_eq!(body["metadata"]["annotations"][COMPOSED_BY], "portal");
    let file = base64::engine::general_purpose::STANDARD
        .decode(body["data"]["apisix.yaml"].as_str().expect("the file"))
        .expect("base64");
    let file = String::from_utf8(file).expect("utf-8");
    assert_eq!(
        file,
        compose(BASE, &apps(), &EdgeLimits::default())
            .expect("composes")
            .file
    );
    assert!(file.contains("app-air-quality") && file.contains(CLIENT_SECRET));
    assert!(file.ends_with("#END\n"));
}

/// An unchanged file is no write, so an unchanged run is no reload.
#[tokio::test]
async fn an_unchanged_file_is_not_written_again() {
    let file = compose(BASE, &apps(), &EdgeLimits::default())
        .expect("composes")
        .file;
    let server = api(Some(seeded(&file, json!({ COMPOSED_BY: "portal" })))).await;
    Mock::given(method("PUT"))
        .respond_with(ResponseTemplate::new(200))
        .expect(0)
        .mount(&server)
        .await;

    let (outcome, _) = edge(&server).converge(&apps(), None).await;
    assert_eq!(outcome, EdgeOutcome::Unchanged { apps: 1 });
}

/// The reconciler never creates the Secret (its Role cannot): a missing one says who seeds it.
#[tokio::test]
async fn a_missing_secret_is_reported_and_not_created() {
    let server = api(None).await;
    Mock::given(method("PUT"))
        .respond_with(ResponseTemplate::new(200))
        .expect(0)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(201))
        .expect(0)
        .mount(&server)
        .await;

    let (outcome, _) = edge(&server).converge(&apps(), None).await;
    let EdgeOutcome::Failed(reason) = outcome else {
        panic!("a missing Secret was not reported: {outcome:?}");
    };
    assert!(reason.contains("configuration chart seeds it"), "{reason}");
}

/// A refused write (a race with another writer, a Role without `update`) is reported by status,
/// and what the API server echoes back never carries the secret into the log.
#[tokio::test]
async fn a_refused_write_is_reported_without_the_file() {
    let server = api(Some(seeded(BASE, json!({})))).await;
    Mock::given(method("PUT"))
        .and(path(SECRET_PATH))
        .respond_with(ResponseTemplate::new(409).set_body_json(json!({
            "kind": "Status",
            "message": format!("Operation cannot be fulfilled: client_secret: {CLIENT_SECRET}"),
        })))
        .mount(&server)
        .await;

    let (outcome, _) = edge(&server).converge(&apps(), None).await;
    let EdgeOutcome::Failed(reason) = outcome else {
        panic!("a refused write was not reported: {outcome:?}");
    };
    assert!(reason.contains("409"), "{reason}");
    assert!(!reason.contains(CLIENT_SECRET), "{reason}");
}

/// T-2892, ADR-N-035: the Organization lowers the web rate; the next run writes the file with
/// the lowered count on the labelled chain, and the served file changes without a helm release.
#[tokio::test]
async fn a_lowered_organization_rate_is_written_on_the_next_run() {
    let base = BASE.replace(
        "  - id: apps-surface\n    plugins:\n",
        "  - id: apps-surface\n    labels:\n      jc-rate-class: web\n    plugins:\n      \
         limit-count:\n        count: 300\n        time_window: 60\n        key: remote_addr\n",
    );
    assert_ne!(base, BASE, "the base carries the label");
    let served = compose(&base, &apps(), &EdgeLimits::of(None, &Default::default()))
        .expect("composes")
        .file;
    let server = api_on(
        &base,
        Some(seeded(&served, json!({ COMPOSED_BY: "portal" }))),
    )
    .await;
    Mock::given(method("PUT"))
        .and(path(SECRET_PATH))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .expect(1)
        .mount(&server)
        .await;
    let limits: OrganizationLimits =
        serde_json::from_value(json!({ "edge": { "requestsPerMinute": { "web": 60 } } }))
            .expect("limits");

    let (outcome, _) = edge(&server).converge(&apps(), Some(&limits)).await;
    assert_eq!(outcome, EdgeOutcome::Written { apps: 1 });

    let requests = server.received_requests().await.expect("recorded");
    let put = requests
        .iter()
        .find(|r| r.method.as_str() == "PUT")
        .expect("a PUT");
    let file = base64::engine::general_purpose::STANDARD
        .decode(
            put_body(put)["data"]["apisix.yaml"]
                .as_str()
                .expect("the file"),
        )
        .expect("base64");
    let file: Value = serde_yaml_ng::from_slice(&file).expect("YAML");
    let surface = file["plugin_configs"]
        .as_array()
        .expect("plugin_configs")
        .iter()
        .find(|pc| pc["id"] == "apps-surface")
        .expect("the surface");
    assert_eq!(surface["plugins"]["limit-count"]["count"], 60);
    // The App's own chain copies the surface, so it counts the lowered rate too.
    let own = file["plugin_configs"]
        .as_array()
        .expect("plugin_configs")
        .iter()
        .find(|pc| pc["id"] == "app-air-quality")
        .expect("the App's chain");
    assert_eq!(own["plugins"]["limit-count"]["count"], 60);
}
