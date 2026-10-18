//! The stored assistant conversations (API/01 §34, API/05 §3.1, AG-99, T-4670): only the
//! assistant's administrator reads them and only one who may delete a deployment erases one,
//! neither a member nor a stranger reaches jc-assistant, the filter goes on as asked, and every
//! call leaves an `assistant.transcript` activity record.

mod common;

use serde_json::{json, Value};
use wiremock::matchers::{header, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

use joinedcontext_portal::activity::ActivityFilter;
use joinedcontext_portal::auth::oidc::OidcClient;
use joinedcontext_portal::auth::Identity;
use joinedcontext_portal::config::Config;
use joinedcontext_portal::state::AppState;
use joinedcontext_portal::store::Mirror;

const ASSISTANT_PATH: &str = "/internal/v1/projects/helsinki/knowledge/conversations";
const LIST: &str = "/api/v1/projects/helsinki/knowledge/conversations";
const ONE: &str = "11111111-1111-4111-8111-111111111111";

async fn rig() -> (AppState, MockServer, MockServer) {
    let realm = MockServer::start().await;
    let issuer = format!("{}/realms/helsinki", realm.uri());
    Mock::given(method("GET"))
        .and(path("/realms/helsinki/.well-known/openid-configuration"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "issuer": issuer,
            "authorization_endpoint": format!("{issuer}/protocol/openid-connect/auth"),
            "token_endpoint": format!("{issuer}/protocol/openid-connect/token"),
            "jwks_uri": format!("{issuer}/protocol/openid-connect/certs"),
            "response_types_supported": ["code"],
            "subject_types_supported": ["public"],
            "id_token_signing_alg_values_supported": ["ES256"]
        })))
        .mount(&realm)
        .await;
    Mock::given(method("GET"))
        .and(path("/realms/helsinki/protocol/openid-connect/certs"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "keys": [] })))
        .mount(&realm)
        .await;
    Mock::given(method("POST"))
        .and(path("/realms/helsinki/protocol/openid-connect/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "access_token": "the-portals-own-token", "token_type": "Bearer", "expires_in": 300
        })))
        .mount(&realm)
        .await;
    let assistant = MockServer::start().await;
    let mut config = Config::from_vars(|key| {
        match key {
            "JC_OIDC_ISSUER" => Some(issuer.as_str()),
            "JC_OIDC_CLIENT_ID" => Some("portal-api"),
            "JC_OIDC_CLIENT_SECRET" => Some("test-secret"),
            "JC_PORTAL_BOOTSTRAP_ADMINS" => Some("portal-approver"),
            _ => None,
        }
        .map(str::to_owned)
    })
    .expect("config");
    config.knowledge_url = Some(assistant.uri());
    let oidc = OidcClient::discover(
        config.oidc.as_ref().expect("a realm"),
        "https://portal.test/api/v1/auth/callback",
    )
    .await
    .expect("discovery");
    let mirror = Mirror::new();
    mirror.upsert(common::envelope(
        "AssistantDeployment",
        "obcan",
        "helsinki",
        json!({ "publicId": "helsinki-public", "channel": "internal", "sources": [] }),
    ));
    // A member who may read the deployment and approve nothing.
    mirror.upsert(common::envelope(
        "Role",
        "assistant-reader",
        joinedcontext_portal::permissions::ORG_NAMESPACE,
        json!({ "rules": [{ "kinds": ["AssistantDeployment", "KnowledgeSource"], "verbs": ["read"] }] }),
    ));
    mirror.upsert(common::envelope(
        "RoleBinding",
        "jana-assistant",
        joinedcontext_portal::permissions::ORG_NAMESPACE,
        json!({ "subjects": [{ "user": "jana@hel.fi" }], "role": "assistant-reader", "scope": { "project": "helsinki" } }),
    ));
    // The assistant's reviewer: approve without delete.
    mirror.upsert(common::envelope(
        "Role",
        "assistant-reviewer",
        joinedcontext_portal::permissions::ORG_NAMESPACE,
        json!({ "rules": [{ "kinds": ["AssistantDeployment"], "verbs": ["read", "approve"] }] }),
    ));
    mirror.upsert(common::envelope(
        "RoleBinding",
        "eva-assistant",
        joinedcontext_portal::permissions::ORG_NAMESPACE,
        json!({ "subjects": [{ "user": "eva@hel.fi" }], "role": "assistant-reviewer", "scope": { "project": "helsinki" } }),
    ));
    let state = AppState::new(config, Some(oidc)).with_mirror(std::sync::Arc::new(mirror));
    (state, assistant, realm)
}

fn admin() -> Identity {
    let mut person = common::person("anna");
    person.groups = vec!["portal-approver".into()];
    person
}

async fn asked(assistant: &MockServer) -> usize {
    assistant
        .received_requests()
        .await
        .unwrap_or_default()
        .len()
}

async fn recorded(state: &AppState) -> Vec<Value> {
    let filter = ActivityFilter {
        kinds: vec!["assistant.transcript".into()],
        limit: 50,
        ..Default::default()
    };
    let page = state
        .activity
        .list("helsinki", &filter)
        .await
        .expect("a page");
    page.items.iter().map(|e| e.details.clone()).collect()
}

#[tokio::test]
async fn only_the_administrator_reads_and_a_member_or_stranger_never_reaches_the_assistant() {
    let (state, assistant, _realm) = rig().await;
    let detail = format!("{LIST}/{ONE}");
    for who in [common::person("nobody"), common::person("jana")] {
        for (http, uri) in [
            ("GET", LIST),
            ("GET", detail.as_str()),
            ("DELETE", detail.as_str()),
        ] {
            let answer = common::send(&state, who.clone(), http, uri, None).await;
            assert_eq!(
                answer.status, 403,
                "{} {http} {uri}: {}",
                who.username, answer.text
            );
            assert!(
                answer.text.contains("AssistantDeployment"),
                "{}",
                answer.text
            );
        }
    }
    assert_eq!(asked(&assistant).await, 0);
    assert!(recorded(&state).await.is_empty(), "a refusal reads nothing");

    Mock::given(method("GET"))
        .and(path(ASSISTANT_PATH))
        .and(header("authorization", "Bearer the-portals-own-token"))
        .and(query_param("status", "timeout"))
        .and(query_param("sort", "costUsd"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "items": [{"id": ONE, "turns": 2, "costUsd": 0.0046}], "nextCursor": null
        })))
        .mount(&assistant)
        .await;
    Mock::given(method("GET"))
        .and(path(format!("{ASSISTANT_PATH}/{ONE}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": ONE, "turns": [{"turn": 1, "question": "Kedy?", "steps": []}]
        })))
        .mount(&assistant)
        .await;
    let list = common::send(
        &state,
        common::person("eva"),
        "GET",
        &format!("{LIST}?status=timeout&sort=costUsd"),
        None,
    )
    .await;
    assert_eq!(list.status, 200, "{}", list.text);
    let body: Value = serde_json::from_str(&list.text).expect("json");
    assert_eq!(body["items"][0]["id"], ONE);
    let one = common::send(&state, admin(), "GET", &detail, None).await;
    assert_eq!(one.status, 200, "{}", one.text);
    let body: Value = serde_json::from_str(&one.text).expect("json");
    assert_eq!(body["turns"][0]["question"], "Kedy?");

    let records = recorded(&state).await;
    assert_eq!(records.len(), 2, "{records:?}");
    assert!(records.iter().any(|r| r["actor"] == "eva"
        && r["of"]["status"] == "timeout"
        && r["of"]["sort"] == "costUsd"));
    assert!(records
        .iter()
        .any(|r| r["actor"] == "anna" && r["of"] == ONE));
}

#[tokio::test]
async fn an_erase_needs_delete_and_a_bad_id_or_filter_never_reaches_the_assistant() {
    let (state, assistant, _realm) = rig().await;
    let detail = format!("{LIST}/{ONE}");
    let reviewer = common::send(&state, common::person("eva"), "DELETE", &detail, None).await;
    assert_eq!(
        reviewer.status, 403,
        "approve alone erases nothing: {}",
        reviewer.text
    );

    for (uri, status) in [
        (format!("{LIST}/not-a-uuid"), 404),
        (format!("{LIST}/{}", ONE.replace('1', "g")), 404),
        (format!("{LIST}?colour=red"), 400),
        (format!("{LIST}?limit=many"), 400),
    ] {
        let answer = common::send(&state, admin(), "GET", &uri, None).await;
        assert_eq!(answer.status.as_u16(), status, "{uri}: {}", answer.text);
    }
    assert_eq!(asked(&assistant).await, 0);

    Mock::given(method("DELETE"))
        .and(path(format!("{ASSISTANT_PATH}/{ONE}")))
        .and(header("authorization", "Bearer the-portals-own-token"))
        .respond_with(ResponseTemplate::new(204))
        .up_to_n_times(1)
        .mount(&assistant)
        .await;
    Mock::given(method("DELETE"))
        .and(path(format!("{ASSISTANT_PATH}/{ONE}")))
        .respond_with(
            ResponseTemplate::new(404).set_body_json(json!({"detail": "no such conversation"})),
        )
        .mount(&assistant)
        .await;
    let erased = common::send(&state, admin(), "DELETE", &detail, None).await;
    assert_eq!(erased.status, 204, "{}", erased.text);
    let again = common::send(&state, admin(), "DELETE", &detail, None).await;
    assert_eq!(again.status, 404, "{}", again.text);
    let records = recorded(&state).await;
    assert_eq!(
        records.len(),
        1,
        "the erase is recorded, the refused one not: {records:?}"
    );
    assert_eq!(records[0]["action"], "erased a stored conversation");
}
