//! Every published App gets a Keycloak client of its own (ADR-N-030, AP-111, T-2677).
//!
//! Against a mocked Keycloak admin API: a published App with no client gets one created with its
//! redirects under `/apps/{name}/` and its secret read back; a client edited in the console is
//! written back and the drift reported; a client of that id that this platform did not create is
//! never touched and the App is reported; a managed client whose App is gone is deleted; a draft
//! App gets nothing; and no secret ever reaches an outcome.

use joinedcontext_portal::reconciler::app_clients::{desired, AppClientSync};
use joinedcontext_portal::reconciler::groups::{MANAGED_BY, MANAGED_VALUE};
use joinedcontext_portal::resource::{ObjectMeta, ResourceEnvelope, API_VERSION};
use joinedcontext_portal::store::Mirror;
use serde_json::{json, Value};
use wiremock::matchers::{method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

const REALM: &str = "/admin/realms/bb";
const HOST: &str = "city.example";

fn app(project: &str, name: &str, lifecycle: &str) -> ResourceEnvelope {
    ResourceEnvelope {
        api_version: API_VERSION.to_owned(),
        kind: "App".to_owned(),
        metadata: ObjectMeta::new(name, project),
        spec: json!({ "class": "static", "lifecycle": lifecycle }),
        status: None,
    }
}

fn mirror_with(apps: Vec<ResourceEnvelope>) -> Mirror {
    let mirror = Mirror::new();
    for envelope in apps {
        mirror.upsert(envelope);
    }
    mirror
}

async fn realm() -> MockServer {
    let keycloak = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/realms/bb/protocol/openid-connect/token"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({ "access_token": "admin-token", "expires_in": 60 })),
        )
        .mount(&keycloak)
        .await;
    keycloak
}

fn sync(keycloak: &MockServer) -> AppClientSync {
    AppClientSync::new(
        &format!("{}/realms/bb", keycloak.uri()),
        "portal-api".to_owned(),
        "portal-api-credential".to_owned(),
        HOST.to_owned(),
    )
    .expect("a realm issuer")
}

/// The realm answers `GET /clients?clientId={id}` with `found`.
async fn client_lookup(keycloak: &MockServer, id: &str, found: Value) {
    Mock::given(method("GET"))
        .and(path(format!("{REALM}/clients")))
        .and(query_param("clientId", id))
        .respond_with(ResponseTemplate::new(200).set_body_json(found))
        .mount(keycloak)
        .await;
}

/// The list the wave reads to find managed clients no App names any more.
async fn app_client_list(keycloak: &MockServer, listed: Value) {
    Mock::given(method("GET"))
        .and(path(format!("{REALM}/clients")))
        .and(query_param("search", "true"))
        .respond_with(ResponseTemplate::new(200).set_body_json(listed))
        .mount(keycloak)
        .await;
}

async fn secret_of(keycloak: &MockServer, uuid: &str, value: &str) {
    Mock::given(method("GET"))
        .and(path(format!("{REALM}/clients/{uuid}/client-secret")))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({ "type": "secret", "value": value })),
        )
        .mount(keycloak)
        .await;
}

/// What the run wrote, as `METHOD path`.
async fn wrote(keycloak: &MockServer) -> Vec<String> {
    keycloak
        .received_requests()
        .await
        .unwrap_or_default()
        .iter()
        .filter(|r| r.method.as_str() != "GET" && !r.url.path().ends_with("/token"))
        .map(|r| format!("{} {}", r.method.as_str(), r.url.path()))
        .collect()
}

fn managed_client(uuid: &str, project: &str, name: &str) -> Value {
    let mut client = desired(project, name, HOST);
    client["id"] = json!(uuid);
    client
}

#[tokio::test]
async fn a_published_app_with_no_client_gets_one_and_its_secret_is_read_back() {
    let keycloak = realm().await;
    // Missing on the first lookup, present once created.
    Mock::given(method("GET"))
        .and(path(format!("{REALM}/clients")))
        .and(query_param("clientId", "app-bikes"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([])))
        .up_to_n_times(1)
        .mount(&keycloak)
        .await;
    client_lookup(
        &keycloak,
        "app-bikes",
        json!([managed_client("uuid-bikes", "helsinki", "bikes")]),
    )
    .await;
    Mock::given(method("POST"))
        .and(path(format!("{REALM}/clients")))
        .respond_with(ResponseTemplate::new(201))
        .mount(&keycloak)
        .await;
    secret_of(&keycloak, "uuid-bikes", "generated-by-keycloak").await;
    app_client_list(&keycloak, json!([])).await;

    let run = sync(&keycloak)
        .converge(&mirror_with(vec![app("helsinki", "bikes", "published")]))
        .await;

    assert_eq!(run.outcomes.len(), 1);
    assert_eq!(run.outcomes[0].error, None, "{:?}", run.outcomes);
    assert_eq!(
        wrote(&keycloak).await,
        vec![format!("POST {REALM}/clients")]
    );
    let created = keycloak
        .received_requests()
        .await
        .unwrap_or_default()
        .into_iter()
        .find(|r| r.method.as_str() == "POST" && r.url.path() == format!("{REALM}/clients"))
        .expect("the client was created");
    let body: Value = serde_json::from_slice(&created.body).expect("json");
    assert_eq!(
        body["redirectUris"],
        json!(["https://city.example/apps/bikes/*"])
    );
    assert_eq!(body["directAccessGrantsEnabled"], false);
    assert_eq!(body["attributes"][MANAGED_BY], MANAGED_VALUE);
    assert_eq!(
        run.secrets.get("bikes").map(|s| s.expose()),
        Some("generated-by-keycloak")
    );
    assert!(
        !format!("{run:?}").contains("generated-by-keycloak"),
        "a secret never shows in a run's debug output"
    );
}

#[tokio::test]
async fn a_client_edited_in_the_console_is_written_back_and_the_drift_reported() {
    let keycloak = realm().await;
    let mut edited = managed_client("uuid-bikes", "helsinki", "bikes");
    edited["directAccessGrantsEnabled"] = json!(true);
    edited["redirectUris"] = json!(["*"]);
    client_lookup(&keycloak, "app-bikes", json!([edited])).await;
    Mock::given(method("PUT"))
        .and(path(format!("{REALM}/clients/uuid-bikes")))
        .respond_with(ResponseTemplate::new(204))
        .mount(&keycloak)
        .await;
    secret_of(&keycloak, "uuid-bikes", "kept").await;
    app_client_list(&keycloak, json!([])).await;

    let run = sync(&keycloak)
        .converge(&mirror_with(vec![app("helsinki", "bikes", "published")]))
        .await;

    assert_eq!(
        wrote(&keycloak).await,
        vec![format!("PUT {REALM}/clients/uuid-bikes")]
    );
    let drift = &run.outcomes[0].drift;
    assert_eq!(drift.len(), 2, "{drift:?}");
    assert!(drift
        .iter()
        .any(|d| d.starts_with("directAccessGrantsEnabled")));
    assert!(drift.iter().any(|d| d.starts_with("redirectUris")));
}

#[tokio::test]
async fn a_client_this_platform_did_not_create_is_never_touched() {
    let keycloak = realm().await;
    client_lookup(
        &keycloak,
        "app-bikes",
        json!([{ "id": "uuid-foreign", "clientId": "app-bikes", "attributes": {} }]),
    )
    .await;
    app_client_list(
        &keycloak,
        json!([{ "id": "uuid-foreign", "clientId": "app-bikes", "attributes": {} }]),
    )
    .await;

    let run = sync(&keycloak)
        .converge(&mirror_with(vec![app("helsinki", "bikes", "published")]))
        .await;

    assert!(wrote(&keycloak).await.is_empty());
    assert!(run.secrets.is_empty());
    let error = run.outcomes[0].error.as_deref().unwrap_or_default();
    assert!(error.contains("did not create"), "{error}");
}

#[tokio::test]
async fn a_managed_client_whose_app_is_gone_is_deleted_and_a_draft_gets_none() {
    let keycloak = realm().await;
    app_client_list(
        &keycloak,
        json!([
            managed_client("uuid-old", "helsinki", "old"),
            // An unmanaged `app-*` client of somebody else stays.
            { "id": "uuid-theirs", "clientId": "app-theirs", "attributes": {} },
            // Not an app client at all.
            { "id": "uuid-edge", "clientId": "edge", "attributes": { MANAGED_BY: MANAGED_VALUE } },
        ]),
    )
    .await;
    Mock::given(method("DELETE"))
        .and(path(format!("{REALM}/clients/uuid-old")))
        .respond_with(ResponseTemplate::new(204))
        .mount(&keycloak)
        .await;

    let run = sync(&keycloak)
        .converge(&mirror_with(vec![app("helsinki", "drafty", "draft")]))
        .await;

    assert_eq!(
        wrote(&keycloak).await,
        vec![format!("DELETE {REALM}/clients/uuid-old")]
    );
    assert_eq!(run.outcomes.len(), 1);
    assert_eq!(run.outcomes[0].app, "old");
    assert!(run.secrets.is_empty());
}

#[tokio::test]
async fn a_realm_that_refuses_the_token_is_one_failure_and_writes_nothing() {
    let keycloak = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/realms/bb/protocol/openid-connect/token"))
        .respond_with(ResponseTemplate::new(401))
        .mount(&keycloak)
        .await;

    let run = sync(&keycloak)
        .converge(&mirror_with(vec![app("helsinki", "bikes", "published")]))
        .await;

    assert_eq!(run.outcomes.len(), 1);
    assert_eq!(run.outcomes[0].app, "*");
    assert!(run.outcomes[0].error.is_some());
    assert!(wrote(&keycloak).await.is_empty());
}
