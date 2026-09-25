//! Every ServiceAccount bound to a workload gets a federated Keycloak client (PF-47, T-1513).
//!
//! Against a mocked Keycloak admin API: an account with `spec.workload.kubernetes` gets its
//! derived client with `federated-jwt` authentication for its one Kubernetes subject,
//! `client_credentials` only, and audience mappers for the Endpoints of the spaces its roles
//! scope, plus the Portal's audience when a role names a `Role`; no secret is ever read. An
//! account without a workload gets nothing; a console change is written back; a client of that id
//! this platform did not create is never touched; a managed client whose account lost its
//! workload is deleted; and one Kubernetes subject opens one account at most, the first to hold
//! it.

use jc_core::kinds::service_account::KubernetesBinding;
use joinedcontext_portal::reconciler::app_clients::audience_mapper;
use joinedcontext_portal::reconciler::groups::{MANAGED_BY, MANAGED_VALUE};
use joinedcontext_portal::reconciler::workload_clients::{desired, WorkloadClientSync};
use joinedcontext_portal::resource::{ObjectMeta, ResourceEnvelope, API_VERSION};
use joinedcontext_portal::store::Mirror;
use serde_json::{json, Value};
use wiremock::matchers::{method, path, path_regex, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

const REALM: &str = "/admin/realms/bb";
const SLUG: &str = "k7m2qz4tv6xh3n5jb2ryd3wcfa";

fn envelope(kind: &str, project: &str, name: &str, spec: Value) -> ResourceEnvelope {
    ResourceEnvelope {
        api_version: API_VERSION.to_owned(),
        kind: kind.to_owned(),
        metadata: ObjectMeta::new(name, project),
        spec,
        status: None,
    }
}

/// A ServiceAccount of `project` writing into space `air`, bound to `namespace/sa` when given.
fn account(
    project: &str,
    name: &str,
    workload: Option<(&str, &str)>,
    role: &str,
) -> ResourceEnvelope {
    let mut spec = json!({
        "owner": { "user": "jana.kovacova@hel.fi" },
        "purpose": "the air-quality adapter of the environment department",
        "roles": [{ "role": role, "scope": { "contextSpace": "air" } }],
        "credentials": [],
    });
    if let Some((namespace, sa)) = workload {
        spec["workload"] =
            json!({ "kubernetes": { "namespace": namespace, "serviceAccount": sa } });
    }
    envelope("ServiceAccount", project, name, spec)
}

fn endpoint(project: &str, name: &str, space: &str, slug: &str) -> ResourceEnvelope {
    envelope(
        "Endpoint",
        project,
        name,
        json!({ "contextSpaceRef": space, "slug": slug, "audience": "organization" }),
    )
}

fn binding(namespace: &str, sa: &str) -> KubernetesBinding {
    serde_json::from_value(json!({ "namespace": namespace, "serviceAccount": sa }))
        .expect("binding")
}

fn mirror_with(items: Vec<ResourceEnvelope>) -> Mirror {
    let mirror = Mirror::new();
    for item in items {
        mirror.upsert(item);
    }
    mirror
}

async fn realm(listed: Value) -> MockServer {
    let keycloak = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/realms/bb/protocol/openid-connect/token"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({ "access_token": "admin-token", "expires_in": 60 })),
        )
        .mount(&keycloak)
        .await;
    // The full list the wave reads first: who holds a subject, and what is left to delete.
    Mock::given(method("GET"))
        .and(path(format!("{REALM}/clients")))
        .and(query_param("briefRepresentation", "false"))
        .respond_with(ResponseTemplate::new(200).set_body_json(listed))
        .mount(&keycloak)
        .await;
    for verb in ["POST", "PUT", "DELETE"] {
        Mock::given(method(verb))
            .and(path_regex(format!(
                "^{REALM}/clients/[^/]+(/protocol-mappers/models.*)?$"
            )))
            .respond_with(ResponseTemplate::new(204))
            .with_priority(10)
            .mount(&keycloak)
            .await;
    }
    keycloak
}

fn sync(keycloak: &MockServer) -> WorkloadClientSync {
    WorkloadClientSync::new(
        &format!("{}/realms/bb", keycloak.uri()),
        "portal-api".to_owned(),
        "portal-api-credential".to_owned(),
    )
    .expect("a realm issuer")
}

async fn client_lookup(keycloak: &MockServer, id: &str, found: Value) {
    Mock::given(method("GET"))
        .and(path(format!("{REALM}/clients")))
        .and(query_param("clientId", id))
        .respond_with(ResponseTemplate::new(200).set_body_json(found))
        .mount(keycloak)
        .await;
}

async fn mappers(keycloak: &MockServer, uuid: &str, held: Value) {
    Mock::given(method("GET"))
        .and(path(format!(
            "{REALM}/clients/{uuid}/protocol-mappers/models"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(held))
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

/// The bodies the run sent to one `METHOD path`.
async fn bodies(keycloak: &MockServer, verb: &str, at: &str) -> Vec<Value> {
    keycloak
        .received_requests()
        .await
        .unwrap_or_default()
        .iter()
        .filter(|r| r.method.as_str() == verb && r.url.path() == at)
        .map(|r| serde_json::from_slice(&r.body).expect("json"))
        .collect()
}

fn managed_client(uuid: &str, project: &str, name: &str, namespace: &str, sa: &str) -> Value {
    let mut client = desired(project, name, &binding(namespace, sa));
    client["id"] = json!(uuid);
    client
}

/// PF-47: a workload-bound account gets a federated client for its one subject, audienced to the
/// Endpoints of the space its role scopes, and no secret is read or written.
#[tokio::test]
async fn a_bound_account_gets_a_federated_client_and_no_secret() {
    let keycloak = realm(json!([])).await;
    Mock::given(method("GET"))
        .and(path(format!("{REALM}/clients")))
        .and(query_param("clientId", "helsinki-air-adapter"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([])))
        .up_to_n_times(1)
        .mount(&keycloak)
        .await;
    client_lookup(
        &keycloak,
        "helsinki-air-adapter",
        json!([managed_client(
            "uuid-air",
            "helsinki",
            "air-adapter",
            "env-dept",
            "adapter"
        )]),
    )
    .await;
    Mock::given(method("POST"))
        .and(path(format!("{REALM}/clients")))
        .respond_with(ResponseTemplate::new(201))
        .mount(&keycloak)
        .await;
    mappers(&keycloak, "uuid-air", json!([])).await;

    let outcomes = sync(&keycloak)
        .converge(&mirror_with(vec![
            account(
                "helsinki",
                "air-adapter",
                Some(("env-dept", "adapter")),
                "space-writer",
            ),
            endpoint("helsinki", "air-all", "air", SLUG),
            // Another space's endpoint is no audience of this account.
            endpoint(
                "helsinki",
                "bikes-all",
                "bikes",
                "b2ryd3wcfak7m2qz4tv6xh3n5j",
            ),
        ]))
        .await;

    assert_eq!(outcomes.len(), 1, "{outcomes:?}");
    assert_eq!(outcomes[0].app, "helsinki/air-adapter");
    assert_eq!(outcomes[0].error, None, "{outcomes:?}");
    assert_eq!(
        wrote(&keycloak).await,
        vec![
            format!("POST {REALM}/clients"),
            format!("POST {REALM}/clients/uuid-air/protocol-mappers/models"),
        ]
    );
    let created = &bodies(&keycloak, "POST", &format!("{REALM}/clients")).await[0];
    assert_eq!(created["clientId"], "helsinki-air-adapter");
    assert_eq!(created["clientAuthenticatorType"], "federated-jwt");
    assert_eq!(created["attributes"]["jwt.credential.issuer"], "kubernetes");
    assert_eq!(
        created["attributes"]["jwt.credential.sub"],
        "system:serviceaccount:env-dept:adapter"
    );
    assert_eq!(created["attributes"][MANAGED_BY], MANAGED_VALUE);
    assert_eq!(created["serviceAccountsEnabled"], true);
    for flow in [
        "standardFlowEnabled",
        "implicitFlowEnabled",
        "directAccessGrantsEnabled",
        "publicClient",
    ] {
        assert_eq!(created[flow], false, "{flow}");
    }
    let mapper = &bodies(
        &keycloak,
        "POST",
        &format!("{REALM}/clients/uuid-air/protocol-mappers/models"),
    )
    .await[0];
    assert_eq!(mapper["config"]["included.custom.audience"], SLUG);
    let asked: Vec<String> = keycloak
        .received_requests()
        .await
        .unwrap_or_default()
        .iter()
        .map(|r| r.url.path().to_owned())
        .collect();
    assert!(
        !asked.iter().any(|p| p.ends_with("/client-secret")),
        "no secret is read: {asked:?}"
    );
}

/// PF-47: an account that names a `Role` acts on the Portal, so its token carries the Portal's
/// audience besides its endpoints'.
#[tokio::test]
async fn an_account_holding_a_portal_role_gets_the_portal_audience() {
    let keycloak = realm(json!([])).await;
    client_lookup(
        &keycloak,
        "helsinki-air-adapter",
        json!([managed_client(
            "uuid-air",
            "helsinki",
            "air-adapter",
            "env-dept",
            "adapter"
        )]),
    )
    .await;
    mappers(&keycloak, "uuid-air", json!([])).await;

    let outcomes = sync(&keycloak)
        .converge(&mirror_with(vec![
            account(
                "helsinki",
                "air-adapter",
                Some(("env-dept", "adapter")),
                "proposer",
            ),
            envelope(
                "Role",
                "org",
                "proposer",
                json!({ "rules": [{ "kinds": ["Pipeline"], "verbs": ["propose"] }] }),
            ),
            endpoint("helsinki", "air-all", "air", SLUG),
        ]))
        .await;

    assert_eq!(outcomes[0].error, None, "{outcomes:?}");
    let audiences: Vec<Value> = bodies(
        &keycloak,
        "POST",
        &format!("{REALM}/clients/uuid-air/protocol-mappers/models"),
    )
    .await
    .into_iter()
    .map(|m| m["config"]["included.custom.audience"].clone())
    .collect();
    assert_eq!(audiences, vec![json!(SLUG), json!("portal-api")]);
}

/// PF-47: an account with no workload is not this wave's; nothing is written for it.
#[tokio::test]
async fn an_account_without_a_workload_gets_no_client() {
    let keycloak = realm(json!([])).await;

    let outcomes = sync(&keycloak)
        .converge(&mirror_with(vec![account(
            "helsinki",
            "vendor-push",
            None,
            "space-writer",
        )]))
        .await;

    assert!(outcomes.is_empty(), "{outcomes:?}");
    assert!(wrote(&keycloak).await.is_empty());
}

/// PF-47: a client switched to a secret in the console is written back to federated
/// authentication, and the drift names what changed.
#[tokio::test]
async fn a_console_change_is_written_back_and_reported() {
    let mut edited = managed_client("uuid-air", "helsinki", "air-adapter", "env-dept", "adapter");
    edited["clientAuthenticatorType"] = json!("client-secret");
    let keycloak = realm(json!([edited.clone()])).await;
    client_lookup(&keycloak, "helsinki-air-adapter", json!([edited])).await;
    let mut held = audience_mapper(SLUG);
    held["id"] = json!("m-1");
    mappers(&keycloak, "uuid-air", json!([held])).await;

    let outcomes = sync(&keycloak)
        .converge(&mirror_with(vec![
            account(
                "helsinki",
                "air-adapter",
                Some(("env-dept", "adapter")),
                "space-writer",
            ),
            endpoint("helsinki", "air-all", "air", SLUG),
        ]))
        .await;

    assert_eq!(outcomes[0].error, None, "{outcomes:?}");
    assert!(
        outcomes[0]
            .drift
            .iter()
            .any(|d| d.contains("clientAuthenticatorType")),
        "{outcomes:?}"
    );
    assert_eq!(
        wrote(&keycloak).await,
        vec![format!("PUT {REALM}/clients/uuid-air")]
    );
    let written = &bodies(&keycloak, "PUT", &format!("{REALM}/clients/uuid-air")).await[0];
    assert_eq!(written["clientAuthenticatorType"], "federated-jwt");
}

/// PF-47: a client of the derived id this platform did not create is never touched, and the
/// account is reported.
#[tokio::test]
async fn a_client_the_platform_did_not_create_is_left_alone() {
    let foreign =
        json!({ "id": "uuid-hand", "clientId": "helsinki-air-adapter", "attributes": {} });
    let keycloak = realm(json!([foreign.clone()])).await;
    client_lookup(&keycloak, "helsinki-air-adapter", json!([foreign])).await;

    let outcomes = sync(&keycloak)
        .converge(&mirror_with(vec![account(
            "helsinki",
            "air-adapter",
            Some(("env-dept", "adapter")),
            "space-writer",
        )]))
        .await;

    let error = outcomes[0].error.as_deref().unwrap_or_default();
    assert!(error.contains("did not create"), "{outcomes:?}");
    assert!(wrote(&keycloak).await.is_empty());
}

/// PF-47: a managed client whose account no longer names a workload is deleted; a hand-made one
/// in the same list is not.
#[tokio::test]
async fn a_client_whose_account_lost_its_workload_is_deleted() {
    let keycloak = realm(json!([
        managed_client("uuid-air", "helsinki", "air-adapter", "env-dept", "adapter"),
        { "id": "uuid-hand", "clientId": "helsinki-pipelines", "attributes": {} },
    ]))
    .await;

    let outcomes = sync(&keycloak)
        .converge(&mirror_with(vec![account(
            "helsinki",
            "air-adapter",
            None,
            "space-writer",
        )]))
        .await;

    assert_eq!(
        wrote(&keycloak).await,
        vec![format!("DELETE {REALM}/clients/uuid-air")]
    );
    assert_eq!(outcomes.len(), 1, "{outcomes:?}");
    assert_eq!(outcomes[0].app, "helsinki/air-adapter");
    assert_eq!(outcomes[0].error, None);
}

/// PF-47: a second account binding a subject another account's client already holds gets no
/// client, so a later proposal can never take a pod's identity from the account that had it.
#[tokio::test]
async fn a_second_binding_of_a_held_subject_is_refused() {
    let holder = managed_client("uuid-air", "helsinki", "air-adapter", "env-dept", "adapter");
    let keycloak = realm(json!([holder.clone()])).await;
    client_lookup(&keycloak, "helsinki-air-adapter", json!([holder])).await;
    let mut held = audience_mapper(SLUG);
    held["id"] = json!("m-1");
    mappers(&keycloak, "uuid-air", json!([held])).await;

    let outcomes = sync(&keycloak)
        .converge(&mirror_with(vec![
            account(
                "helsinki",
                "air-adapter",
                Some(("env-dept", "adapter")),
                "space-writer",
            ),
            account(
                "kosice",
                "squatter",
                Some(("env-dept", "adapter")),
                "space-writer",
            ),
            endpoint("helsinki", "air-all", "air", SLUG),
        ]))
        .await;

    let of = |label: &str| outcomes.iter().find(|o| o.app == label).expect(label);
    assert_eq!(of("helsinki/air-adapter").error, None, "{outcomes:?}");
    let refused = of("kosice/squatter").error.as_deref().unwrap_or_default();
    assert!(
        refused.contains("already opens the client of helsinki/air-adapter"),
        "{refused}"
    );
    assert!(
        wrote(&keycloak).await.is_empty(),
        "nothing is created for the second binding"
    );
}

/// PF-47: two accounts binding one subject that no client holds yet both wait, and nothing is
/// created, because Keycloak would pick one of them by the subject alone.
#[tokio::test]
async fn two_new_bindings_of_one_subject_both_wait() {
    let keycloak = realm(json!([])).await;

    let outcomes = sync(&keycloak)
        .converge(&mirror_with(vec![
            account(
                "helsinki",
                "air-adapter",
                Some(("env-dept", "adapter")),
                "space-writer",
            ),
            account(
                "kosice",
                "squatter",
                Some(("env-dept", "adapter")),
                "space-writer",
            ),
        ]))
        .await;

    assert_eq!(outcomes.len(), 2, "{outcomes:?}");
    for outcome in &outcomes {
        let error = outcome.error.as_deref().unwrap_or_default();
        assert!(error.contains("is bound by"), "{outcome:?}");
    }
    assert!(wrote(&keycloak).await.is_empty());
}
