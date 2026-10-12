//! Every `MqttBroker`'s release against a mocked API server (T-3994, ADR-N-048 §2.6, MF-54).
//!
//! One converge applies the template once per broker, by its own `mqtt-` names; a changed limit
//! reaches the release; a refused manifest is not applied and its release is not retired; a
//! broker whose manifest is gone loses its objects and no other broker does; without the template
//! nothing is applied or removed.

use jc_core::kinds::mqtt_broker::release_name;
use jc_core::kinds::MqttBrokerSpec;
use joinedcontext_portal::apps::kube::KubeClient;
use joinedcontext_portal::reconciler::mqtt_brokers::{Broker, MqttBrokers, TEMPLATE_KEY};
use serde_json::{json, Value};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

const NAMESPACE: &str = "jc-mqtt";

const TEMPLATE: &str = "\
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: __RELEASE__
  namespace: jc-mqtt
  labels:
    app.kubernetes.io/part-of: mqtt-brokers
    app.kubernetes.io/managed-by: joinedcontext-portal
    app.kubernetes.io/instance: __RELEASE__
data:
  rmqtt.toml: |
    listener.tcp.external.max_connections = __CONNECTIONS__
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: __RELEASE__
  namespace: jc-mqtt
  labels:
    app.kubernetes.io/part-of: mqtt-brokers
    app.kubernetes.io/managed-by: joinedcontext-portal
    app.kubernetes.io/instance: __RELEASE__
spec:
  template:
    metadata:
      annotations:
        checksum/config: __CONFIG_HASH__
";

fn broker(project: &str, name: &str, connections: u32) -> Broker {
    let spec: MqttBrokerSpec = serde_json::from_value(json!({
        "roles": [{"name": "camera", "serviceAccounts": ["cam"], "publish": ["cameras/${clientid}/#"]}],
        "limits": {"maxConnections": connections},
    }))
    .expect("a broker reads");
    Broker {
        project: project.to_owned(),
        name: name.to_owned(),
        release: release_name(project, name),
        spec: Ok(spec),
    }
}

fn refused(project: &str, name: &str) -> Broker {
    Broker {
        spec: Err("role `camera` names ServiceAccount `cam-west`, which no manifest of this project declares (MF-54)".to_owned()),
        ..broker(project, name, 10)
    }
}

/// What the cluster holds: the objects of `releases`, labelled as the reconciler labels them.
fn held(kind: &str, releases: &[&str]) -> Value {
    json!({ "items": releases.iter().map(|release| json!({
        "kind": kind,
        "metadata": { "name": release, "labels": { "app.kubernetes.io/instance": release } },
    })).collect::<Vec<_>>() })
}

async fn cluster(template: Option<&str>, releases: &[&str]) -> MockServer {
    let server = MockServer::start().await;
    let map = format!("/api/v1/namespaces/{NAMESPACE}/configmaps/broker-template");
    let response = match template {
        Some(text) => {
            ResponseTemplate::new(200).set_body_json(json!({ "data": { TEMPLATE_KEY: text } }))
        }
        None => ResponseTemplate::new(404).set_body_json(json!({ "message": "not found" })),
    };
    Mock::given(method("GET"))
        .and(path(map))
        .respond_with(response)
        .mount(&server)
        .await;
    for (route, kind) in [
        (
            format!("/api/v1/namespaces/{NAMESPACE}/configmaps"),
            "ConfigMap",
        ),
        (
            format!("/apis/apps/v1/namespaces/{NAMESPACE}/deployments"),
            "Deployment",
        ),
    ] {
        Mock::given(method("GET"))
            .and(path(route))
            .respond_with(ResponseTemplate::new(200).set_body_json(held(kind, releases)))
            .mount(&server)
            .await;
    }
    for verb in ["PATCH", "DELETE"] {
        Mock::given(method(verb))
            .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
            .mount(&server)
            .await;
    }
    server
}

fn calls(received: &[Request], verb: &str) -> Vec<String> {
    let mut paths: Vec<String> = received
        .iter()
        .filter(|request| request.method.as_str() == verb)
        .map(|request| request.url.path().to_owned())
        .collect();
    paths.sort();
    paths
}

fn reconciler(server: &MockServer) -> MqttBrokers {
    MqttBrokers::new(
        KubeClient::with_token(&server.uri(), "token").expect("a client"),
        NAMESPACE.to_owned(),
    )
}

#[tokio::test]
async fn three_brokers_in_two_projects_are_three_releases_and_a_gone_one_loses_only_its_own() {
    let server = cluster(
        Some(TEMPLATE),
        &["mqtt-helsinki-cameras", "mqtt-helsinki-gone"],
    )
    .await;
    let brokers = [
        broker("espoo", "cameras", 10),
        broker("helsinki", "cameras", 10),
        broker("helsinki", "doors", 10),
    ];
    let failed = reconciler(&server).converge(&brokers, true).await;
    assert!(failed.is_empty(), "{failed:?}");

    let received = server.received_requests().await.expect("recorded");
    let applied = calls(&received, "PATCH");
    assert_eq!(applied.len(), 6, "{applied:?}");
    for release in [
        "mqtt-espoo-cameras",
        "mqtt-helsinki-cameras",
        "mqtt-helsinki-doors",
    ] {
        assert!(applied.contains(&format!(
            "/api/v1/namespaces/{NAMESPACE}/configmaps/{release}"
        )));
        assert!(applied.contains(&format!(
            "/apis/apps/v1/namespaces/{NAMESPACE}/deployments/{release}"
        )));
    }
    assert_eq!(
        calls(&received, "DELETE"),
        [
            format!("/api/v1/namespaces/{NAMESPACE}/configmaps/mqtt-helsinki-gone"),
            format!("/apis/apps/v1/namespaces/{NAMESPACE}/deployments/mqtt-helsinki-gone"),
        ]
    );
    // The retirement asks only for what the reconciler made.
    let listed = received
        .iter()
        .find(|request| {
            request.method.as_str() == "GET" && request.url.path().ends_with("/deployments")
        })
        .expect("listed");
    assert!(listed
        .url
        .query()
        .unwrap_or_default()
        .contains("managed-by%3Djoinedcontext-portal"));
}

#[tokio::test]
async fn a_changed_limit_reaches_the_release_and_restarts_it() {
    let server = cluster(Some(TEMPLATE), &[]).await;
    let reconciler = reconciler(&server);
    assert!(reconciler
        .converge(&[broker("helsinki", "cameras", 10)], true)
        .await
        .is_empty());
    assert!(reconciler
        .converge(&[broker("helsinki", "cameras", 25)], true)
        .await
        .is_empty());
    let bodies: Vec<Value> = server
        .received_requests()
        .await
        .expect("recorded")
        .iter()
        .filter(|request| request.method.as_str() == "PATCH")
        .map(|request| serde_json::from_slice(&request.body).expect("JSON"))
        .collect();
    let toml = |i: usize| {
        bodies[i]["data"]["rmqtt.toml"]
            .as_str()
            .unwrap_or_default()
            .to_owned()
    };
    assert!(
        toml(0).contains("= 10") && toml(2).contains("= 25"),
        "{bodies:?}"
    );
    let hash = |i: usize| {
        bodies[i]["spec"]["template"]["metadata"]["annotations"]["checksum/config"].clone()
    };
    assert_ne!(
        hash(1),
        hash(3),
        "the Deployment rolls when its config changes"
    );
}

#[tokio::test]
async fn a_refused_manifest_is_not_applied_and_keeps_its_running_release() {
    let server = cluster(
        Some(TEMPLATE),
        &["mqtt-helsinki-cameras", "mqtt-helsinki-doors"],
    )
    .await;
    let brokers = [
        broker("helsinki", "cameras", 10),
        refused("helsinki", "doors"),
    ];
    let failed = reconciler(&server).converge(&brokers, true).await;
    assert!(
        failed.is_empty(),
        "the refusal is the caller's to report: {failed:?}"
    );
    let received = server.received_requests().await.expect("recorded");
    assert!(calls(&received, "PATCH")
        .iter()
        .all(|p| !p.ends_with("mqtt-helsinki-doors")));
    assert_eq!(calls(&received, "DELETE"), Vec::<String>::new());
}

#[tokio::test]
async fn a_run_where_a_repository_did_not_stage_retires_nothing() {
    let server = cluster(Some(TEMPLATE), &["mqtt-helsinki-gone"]).await;
    let failed = reconciler(&server)
        .converge(&[broker("helsinki", "cameras", 10)], false)
        .await;
    assert!(failed.is_empty(), "{failed:?}");
    let received = server.received_requests().await.expect("recorded");
    assert_eq!(calls(&received, "DELETE"), Vec::<String>::new());
}

#[tokio::test]
async fn without_the_template_nothing_is_applied_or_removed_and_the_run_says_why() {
    let server = cluster(None, &["mqtt-helsinki-gone"]).await;
    let failed = reconciler(&server)
        .converge(&[broker("helsinki", "cameras", 10)], true)
        .await;
    assert!(failed["*"].contains("broker-template"), "{failed:?}");
    let received = server.received_requests().await.expect("recorded");
    assert!(calls(&received, "PATCH").is_empty());
    assert!(calls(&received, "DELETE").is_empty());
}

#[tokio::test]
async fn an_apply_the_api_server_refuses_is_that_brokers_failure_alone() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(format!(
            "/api/v1/namespaces/{NAMESPACE}/configmaps/broker-template"
        )))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({ "data": { TEMPLATE_KEY: TEMPLATE } })),
        )
        .mount(&server)
        .await;
    Mock::given(method("PATCH"))
        .and(path(format!(
            "/api/v1/namespaces/{NAMESPACE}/configmaps/mqtt-espoo-cameras"
        )))
        .respond_with(ResponseTemplate::new(403).set_body_json(json!({ "message": "forbidden" })))
        .mount(&server)
        .await;
    Mock::given(method("PATCH"))
        .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
        .mount(&server)
        .await;
    let failed = reconciler(&server)
        .converge(
            &[
                broker("espoo", "cameras", 10),
                broker("helsinki", "cameras", 10),
            ],
            false,
        )
        .await;
    assert_eq!(failed.keys().collect::<Vec<_>>(), ["espoo/cameras"]);
    assert!(failed["espoo/cameras"].contains("forbidden"));
}
