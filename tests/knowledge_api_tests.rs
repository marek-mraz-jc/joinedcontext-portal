//! The knowledge administration routes (API/01 §34, T-3057, AG-113): the caller's permission is
//! checked before jc-assistant is asked, the assistant is asked with the Portal's own token, the
//! sources list joins the manifests with what the assistant holds, and its answers reach the
//! caller in the Portal's own words.

mod common;

use serde_json::{json, Value};
use wiremock::matchers::{body_json, header, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

use joinedcontext_portal::auth::oidc::OidcClient;
use joinedcontext_portal::auth::Identity;
use joinedcontext_portal::config::Config;
use joinedcontext_portal::state::AppState;
use joinedcontext_portal::store::Mirror;

const ASSISTANT_PATH: &str = "/internal/v1/projects/helsinki/knowledge";

async fn realm() -> MockServer {
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
    realm
}

struct Rig {
    state: AppState,
    assistant: MockServer,
    _realm: Option<MockServer>,
}

async fn rig() -> Rig {
    let realm = realm().await;
    let issuer = format!("{}/realms/helsinki", realm.uri());
    rig_on(issuer, Some(realm)).await
}

/// The rig on the process's signing realm, so a person can call with a bearer of their own.
async fn rig_on_signing_realm() -> Rig {
    Mock::given(method("POST"))
        .and(path("/realms/banskabystrica/protocol/openid-connect/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "access_token": "the-portals-own-token", "token_type": "Bearer", "expires_in": 300
        })))
        .mount(common::REALM.server)
        .await;
    rig_on(common::REALM.issuer.clone(), None).await
}

async fn rig_on(issuer: String, realm: Option<MockServer>) -> Rig {
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
    mirror.upsert(common::envelope("KnowledgeSource", "web", "helsinki", json!({
        "source": "website", "startUrls": ["https://www.hel.fi/"], "visibility": "public", "schedule": "0 3 * * *"
    })));
    mirror.upsert(common::envelope(
        "KnowledgeSource",
        "catalogue",
        "helsinki",
        json!({
            "source": "ckan", "ckanInstanceRef": "hel-fi", "visibility": "public"
        }),
    ));
    mirror.upsert(common::envelope(
        "AssistantDeployment",
        "public",
        "helsinki",
        json!({
            "publicId": "helsinki-public", "channel": "internal", "sources": ["web"]
        }),
    ));
    let state = AppState::new(config, Some(oidc)).with_mirror(std::sync::Arc::new(mirror));
    Rig {
        state,
        assistant,
        _realm: realm,
    }
}

/// One request with the person's own bearer, as a script or the edge in front sends it.
async fn send_as_bearer(
    state: &AppState,
    token: &str,
    uri: &str,
    body: Value,
) -> (u16, String, String) {
    use axum::body::Body;
    use axum::http::{header as h, Request};
    use tower::ServiceExt;
    let response = joinedcontext_portal::server::app(state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(uri)
                .header(h::AUTHORIZATION, format!("Bearer {token}"))
                .header(h::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .expect("request"),
        )
        .await
        .expect("response");
    let status = response.status().as_u16();
    let kind = response
        .headers()
        .get(h::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let bytes = http_body_util::BodyExt::collect(response.into_body())
        .await
        .expect("body")
        .to_bytes();
    (status, kind, String::from_utf8_lossy(&bytes).into_owned())
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

/// AG-113: the sources the manifests declare, joined with what the assistant holds, asked with
/// the Portal's own token; one not crawled yet says so.
#[tokio::test]
async fn the_sources_join_the_manifests_with_what_the_assistant_holds() {
    let r = rig().await;
    Mock::given(method("GET"))
        .and(path(format!("{ASSISTANT_PATH}/sources")))
        .and(header("authorization", "Bearer the-portals-own-token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"items": [
            {"source": "web", "state": "crawled", "lastCrawl": "2026-10-06T03:00:00Z", "pages": 120, "pagesIncluded": 110, "documents": 14, "passages": 900, "embedded": 900, "job": {"state": "done", "attempts": 1, "error": null}}
        ]})))
        .mount(&r.assistant)
        .await;
    let answer = common::send(
        &r.state,
        admin(),
        "GET",
        "/api/v1/projects/helsinki/knowledge/sources",
        None,
    )
    .await;
    assert_eq!(answer.status, 200, "{}", answer.text);
    let body: Value = serde_json::from_str(&answer.text).expect("json");
    let items = body["items"].as_array().expect("items");
    let web = items.iter().find(|i| i["source"] == "web").expect("web");
    assert_eq!(
        (
            web["state"].clone(),
            web["pages"].clone(),
            web["type"].clone()
        ),
        (json!("crawled"), json!(120), json!("website"))
    );
    assert_eq!(web["startUrls"], json!(["https://www.hel.fi/"]));
    let catalogue = items
        .iter()
        .find(|i| i["source"] == "catalogue")
        .expect("catalogue");
    assert_eq!(
        (catalogue["state"].clone(), catalogue["type"].clone()),
        (json!("not-crawled"), json!("ckan"))
    );
}

/// AG-113: a caller who may not read the project's sources learns nothing, and a caller who
/// may read them but not propose one cannot steer them; neither reaches the assistant.
#[tokio::test]
async fn nobody_without_the_permission_reaches_the_assistant() {
    let r = rig().await;
    let stranger = common::person("nobody");
    for (http, uri, body) in [
        ("GET", "/api/v1/projects/helsinki/knowledge/sources", None),
        (
            "GET",
            "/api/v1/projects/helsinki/knowledge/sources/web/pages",
            None,
        ),
        (
            "GET",
            "/api/v1/projects/helsinki/knowledge/deployments/public/usage",
            None,
        ),
        (
            "POST",
            "/api/v1/projects/helsinki/knowledge/sources/web/inclusion",
            Some(json!({"pages": [1], "included": false})),
        ),
        (
            "POST",
            "/api/v1/projects/helsinki/knowledge/sources/web/recrawl",
            None,
        ),
        (
            "POST",
            "/api/v1/projects/helsinki/knowledge/deployments/public/chat",
            Some(json!({"message": "Ahoj"})),
        ),
    ] {
        let answer = common::send(&r.state, stranger.clone(), http, uri, body).await;
        assert_eq!(answer.status, 404, "{http} {uri}: {}", answer.text);
    }
    assert_eq!(asked(&r.assistant).await, 0);
}

/// The tree a level at a time, the passages of one page, and an inclusion forwarded as it was
/// asked; the bounds are checked here first.
#[tokio::test]
async fn reads_and_an_inclusion_are_forwarded_and_bounded() {
    let r = rig().await;
    Mock::given(method("GET"))
        .and(path(format!("{ASSISTANT_PATH}/sources/web/pages")))
        .and(query_param("parent", "12"))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            json!({"items": [{"id": 13, "url": "https://www.hel.fi/a", "depth": 2}]}),
        ))
        .mount(&r.assistant)
        .await;
    Mock::given(method("GET"))
        .and(path(format!("{ASSISTANT_PATH}/sources/web/passages")))
        .and(query_param("page", "13"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"items": [{"ordinal": 0, "text": "Kirjasto", "lang": "fi", "url": "https://www.hel.fi/a"}]})))
        .mount(&r.assistant)
        .await;
    Mock::given(method("POST"))
        .and(path(format!("{ASSISTANT_PATH}/sources/web/inclusion")))
        .and(body_json(
            json!({"pages": [12], "documents": [], "subtree": true, "included": false}),
        ))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"pages": 2, "documents": 1, "passagesRemoved": 30})),
        )
        .mount(&r.assistant)
        .await;
    let level = common::send(
        &r.state,
        admin(),
        "GET",
        "/api/v1/projects/helsinki/knowledge/sources/web/pages?parent=12",
        None,
    )
    .await;
    assert_eq!(level.status, 200, "{}", level.text);
    assert!(level.text.contains("\"id\":13"));
    let passages = common::send(
        &r.state,
        admin(),
        "GET",
        "/api/v1/projects/helsinki/knowledge/sources/web/passages?page=13",
        None,
    )
    .await;
    assert!(passages.text.contains("Kirjasto"));
    let changed = common::send(
        &r.state,
        admin(),
        "POST",
        "/api/v1/projects/helsinki/knowledge/sources/web/inclusion",
        Some(json!({"pages": [12], "subtree": true, "included": false})),
    )
    .await;
    assert_eq!(changed.status, 200, "{}", changed.text);
    assert!(changed.text.contains("\"passagesRemoved\":30"));

    let before = asked(&r.assistant).await;
    for (uri, body) in [
        (
            "/api/v1/projects/helsinki/knowledge/sources/web/inclusion",
            json!({"included": false}),
        ),
        (
            "/api/v1/projects/helsinki/knowledge/sources/web/inclusion",
            json!({"pages": vec![1; 501], "included": false}),
        ),
        (
            "/api/v1/projects/helsinki/knowledge/sources/web/inclusion",
            json!({"pages": [1], "included": false, "extra": true}),
        ),
    ] {
        let answer = common::send(&r.state, admin(), "POST", uri, Some(body.clone())).await;
        assert!(
            answer.status == 400 || answer.status == 422,
            "{body}: {} {}",
            answer.status,
            answer.text
        );
    }
    let both = common::send(
        &r.state,
        admin(),
        "GET",
        "/api/v1/projects/helsinki/knowledge/sources/web/passages?page=1&document=2",
        None,
    )
    .await;
    assert_eq!(both.status, 400);
    let bad_name = common::send(
        &r.state,
        admin(),
        "GET",
        "/api/v1/projects/helsinki/knowledge/sources/Not_A_Name/pages",
        None,
    )
    .await;
    assert_eq!(bad_name.status, 404);
    assert_eq!(
        asked(&r.assistant).await,
        before,
        "nothing out of bounds reached the assistant"
    );
}

/// The assistant's own answers in the Portal's words: a waiting crawl is 409, an unknown
/// deployment 404 before it is asked, its refusal of the Portal's token 503, and no address 503.
#[tokio::test]
async fn the_assistants_answers_reach_the_caller_as_the_portals() {
    let r = rig().await;
    Mock::given(method("POST"))
        .and(path(format!("{ASSISTANT_PATH}/sources/web/recrawl")))
        .respond_with(ResponseTemplate::new(409).set_body_json(
            json!({"status": 409, "detail": "a crawl of this source is already queued or running"}),
        ))
        .mount(&r.assistant)
        .await;
    Mock::given(method("GET"))
        .and(path(format!("{ASSISTANT_PATH}/sources/web/documents")))
        .respond_with(ResponseTemplate::new(401).set_body_json(json!({"status": 401})))
        .mount(&r.assistant)
        .await;
    let waiting = common::send(
        &r.state,
        admin(),
        "POST",
        "/api/v1/projects/helsinki/knowledge/sources/web/recrawl",
        None,
    )
    .await;
    assert_eq!(waiting.status, 409);
    assert!(waiting.text.contains("already queued"));
    let refused = common::send(
        &r.state,
        admin(),
        "GET",
        "/api/v1/projects/helsinki/knowledge/sources/web/documents",
        None,
    )
    .await;
    assert_eq!(refused.status, 503);
    assert!(refused.text.contains("does not accept this Portal's token"));
    let unknown = common::send(
        &r.state,
        admin(),
        "GET",
        "/api/v1/projects/helsinki/knowledge/deployments/nikde/usage",
        None,
    )
    .await;
    assert_eq!(unknown.status, 404);

    let mut without = r.state.clone();
    let mut config = (*without.config).clone();
    config.knowledge_url = None;
    without.config = std::sync::Arc::new(config);
    let none = common::send(
        &without,
        admin(),
        "GET",
        "/api/v1/projects/helsinki/knowledge/sources",
        None,
    )
    .await;
    assert_eq!(none.status, 503);
    assert!(none.text.contains("JC_PORTAL_KNOWLEDGE_URL"));
}

const CHAT: &str = "/api/v1/projects/helsinki/knowledge/deployments/public/chat";
const EVENTS: &str = "event: conversation\ndata: {\"id\":\"6f1c0e9e-3b1a-4d7e-9b51-2c4f8f2a7c11\"}\n\nevent: answer\ndata: {\"text\":\"Dobrý deň [1]\"}\n\nevent: done\ndata: {\"tokens\":12}\n\n";

/// API/05 §1.7, AG-115: the question goes to the assistant with the Portal's token, the
/// person's name and the person's own token, and the events come back as they were sent.
#[tokio::test]
async fn a_question_reaches_the_assistant_as_the_person_and_its_events_come_back() {
    let r = rig_on_signing_realm().await;
    let person =
        common::REALM.person_token_of("portal-api", "portal-api", "anna", &["portal-approver"]);
    Mock::given(method("POST"))
        .and(path(format!("{ASSISTANT_PATH}/deployments/public/chat")))
        .and(header("authorization", "Bearer the-portals-own-token"))
        .and(header("x-jc-person", "anna@hel.fi"))
        .and(header("x-jc-person-token", person.as_str()))
        .and(body_json(json!({"message": "Kde sú stanice?", "history": [{"role": "user", "text": "Ahoj"}], "connectors": []})))
        .respond_with(ResponseTemplate::new(200).insert_header("content-type", "text/event-stream").set_body_string(EVENTS))
        .expect(1)
        .mount(&r.assistant)
        .await;
    let (status, kind, text) = send_as_bearer(
        &r.state,
        &person,
        CHAT,
        json!({"message": "Kde sú stanice?", "history": [{"role": "user", "text": "Ahoj"}], "connectors": []}),
    )
    .await;
    assert_eq!(status, 200, "{text}");
    assert_eq!(kind, "text/event-stream");
    assert_eq!(text, EVENTS);
}

/// AG-115: a Portal cookie session holds no access token, so none is passed on; the assistant
/// then offers no connector that needs one.
#[tokio::test]
async fn a_cookie_session_passes_no_token_on() {
    let r = rig().await;
    Mock::given(method("POST"))
        .and(path(format!("{ASSISTANT_PATH}/deployments/public/chat")))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(EVENTS),
        )
        .mount(&r.assistant)
        .await;
    let answer = common::send(
        &r.state,
        admin(),
        "POST",
        CHAT,
        Some(json!({"message": "Ahoj"})),
    )
    .await;
    assert_eq!(answer.status, 200, "{}", answer.text);
    let received = r.assistant.received_requests().await.unwrap_or_default();
    assert_eq!(received.len(), 1);
    assert!(received[0].headers.get("x-jc-person-token").is_none());
    assert_eq!(
        received[0]
            .headers
            .get("x-jc-person")
            .map(|v| v.to_str().unwrap_or_default()),
        Some("anna")
    );
}

/// AG-98, AG-115: a body outside API/05 §1.1 or an unknown deployment never reaches the
/// assistant; its refusals reach the person in the Portal's words.
#[tokio::test]
async fn the_chat_refuses_before_the_assistant_is_asked_and_relays_its_refusals() {
    let r = rig().await;
    for (uri, body) in [
        (CHAT, json!({"message": "Ahoj", "secret": "x"})),
        (CHAT, json!({"history": []})),
        (
            "/api/v1/projects/helsinki/knowledge/deployments/nikde/chat",
            json!({"message": "Ahoj"}),
        ),
        (
            "/api/v1/projects/helsinki/knowledge/deployments/NIKDE/chat",
            json!({"message": "Ahoj"}),
        ),
    ] {
        let answer = common::send(&r.state, admin(), "POST", uri, Some(body.clone())).await;
        assert!(
            answer.status.is_client_error(),
            "{uri} {body}: {} {}",
            answer.status,
            answer.text
        );
    }
    let huge = "a".repeat(70 * 1024);
    let answer = common::send(
        &r.state,
        admin(),
        "POST",
        CHAT,
        Some(json!({"message": huge})),
    )
    .await;
    assert_eq!(answer.status, 413);
    assert_eq!(asked(&r.assistant).await, 0);

    Mock::given(method("POST"))
        .and(path(format!("{ASSISTANT_PATH}/deployments/public/chat")))
        .respond_with(ResponseTemplate::new(409).set_body_json(
            json!({"status": 409, "detail": "This assistant has no budget yet: an administrator sets budget.tokensPerDay on it before anyone can ask."}),
        ))
        .up_to_n_times(1)
        .mount(&r.assistant)
        .await;
    let no_budget = common::send(
        &r.state,
        admin(),
        "POST",
        CHAT,
        Some(json!({"message": "Ahoj"})),
    )
    .await;
    assert_eq!(no_budget.status, 409);
    assert!(no_budget.text.contains("budget.tokensPerDay"));
    Mock::given(method("POST"))
        .and(path(format!("{ASSISTANT_PATH}/deployments/public/chat")))
        .respond_with(ResponseTemplate::new(429).set_body_json(
            json!({"status": 429, "detail": "The assistant is answering many questions. Ask again in a moment."}),
        ))
        .mount(&r.assistant)
        .await;
    let busy = common::send(
        &r.state,
        admin(),
        "POST",
        CHAT,
        Some(json!({"message": "Ahoj"})),
    )
    .await;
    assert_eq!(busy.status, 429);
    assert!(busy.text.contains("Ask again in a moment"));
}
