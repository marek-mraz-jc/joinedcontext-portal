//! `POST /apps/{name}/api/services/ai/complete`: an App's completion through `jc-agent-proxy` as
//! the Portal's service account naming the App, held to its `aiTokensPerDay`, with the model the
//! platform chooses (AP-169, AP-165, API/06 §3, T-3584). The proxy is a stub with recorded
//! answers; no model is called. Runs when `JC_PORTAL_TEST_DATABASE_URL` points at a PostgreSQL.

mod common;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use serde_json::{json, Value};
use tower::ServiceExt;
use wiremock::matchers::{body_string_contains, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use common::envelope;
use joinedcontext_portal::auth::oidc::OidcClient;
use joinedcontext_portal::config::Config;
use joinedcontext_portal::state::AppState;

const APP: &str = "road-defects";

async fn database() -> Option<sqlx::PgPool> {
    let url = std::env::var("JC_PORTAL_TEST_DATABASE_URL")
        .ok()
        .filter(|url| !url.trim().is_empty());
    let Some(url) = url else {
        eprintln!("skipped: JC_PORTAL_TEST_DATABASE_URL is not set");
        return None;
    };
    Some(
        joinedcontext_portal::db::connect(&url)
            .await
            .expect("the test database answers and migrates"),
    )
}

/// A project of its own per test, so the day's counters never meet in the shared database.
fn project(test: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or_default();
    format!("{test}-{nanos}")
}

/// A stub proxy answering a completion with `content` and 70 + 30 tokens, or with `status`.
async fn proxy(project: &str, content: &str, status: u16) -> MockServer {
    let proxy = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/llm/chat/completions"))
        .and(wiremock::matchers::header(
            "x-jc-app",
            format!("{project}/{APP}").as_str(),
        ))
        .and(wiremock::matchers::header(
            "authorization",
            "Bearer portal-service",
        ))
        .respond_with(ResponseTemplate::new(status).set_body_json(json!({
            "choices": [{ "index": 0, "message": { "role": "assistant", "content": content } }],
            "usage": { "prompt_tokens": 70, "completion_tokens": 30, "total_tokens": 100 }
        })))
        .mount(&proxy)
        .await;
    proxy
}

/// A Portal whose realm mints its service token, holding the organization with `org_services`,
/// the `app-builder` profile and App `road-defects` with `ai` and a 150-token day.
async fn state(proxy: &MockServer, project: &str, org_services: Value) -> Option<AppState> {
    let db = database().await?;
    Mock::given(method("POST"))
        .and(path("/realms/banskabystrica/protocol/openid-connect/token"))
        .and(body_string_contains("client_credentials"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "access_token": "portal-service", "token_type": "Bearer", "expires_in": 300
        })))
        .mount(common::REALM.server)
        .await;
    let config = Config::from_vars(|key| match key {
        "JC_AGENTS_NAMESPACE" => Some("agents".to_owned()),
        "JC_AGENT_PROXY_BASE" => Some(proxy.uri()),
        "JC_OIDC_ISSUER" => Some(common::REALM.issuer.clone()),
        "JC_OIDC_CLIENT_ID" => Some("portal-api".to_owned()),
        "JC_OIDC_CLIENT_SECRET" => Some("secret".to_owned()),
        _ => None,
    })
    .expect("config");
    let oidc = OidcClient::discover(
        config.oidc.as_ref().expect("a realm"),
        "https://portal.test/api/v1/auth/callback",
    )
    .await
    .expect("discovery");
    let mut state = AppState::new(config, Some(oidc));
    state.db = Some(db);
    state.mirror.upsert(envelope(
        "Organization",
        "helsinki",
        "org",
        json!({ "domain": "hel.fi", "locales": ["en"], "defaultLocale": "en",
                "policies": { "apps": { "services": org_services } } }),
    ));
    state.mirror.upsert(envelope(
        "AgentProfile",
        "app-builder",
        "org",
        json!({
            "role": "builder",
            "runtime": {
                "image": "ghcr.io/all-hands-ai/agent-server:v1.4.0",
                "digest": "sha256:1111111111111111111111111111111111111111111111111111111111111111"
            },
            "model": { "provider": "openai-compatible", "name": "deepseek/deepseek-v4.1-flash", "maxTokensPerRun": 400000 },
            "limits": { "stepsPerRun": 120, "wallClock": "PT20M", "concurrentRunsPerOrganization": 2, "requestsPerMinute": 60, "maxResponseBytes": 2097152 },
            "egress": { "allowedHosts": [] },
            "tools": ["shell"],
            "workspace": { "cpu": "1", "memory": "2Gi", "ephemeralStorage": "4Gi" },
        }),
    ));
    state.mirror.upsert(envelope(
        "App",
        APP,
        project,
        json!({
            "kind": "ui", "source": { "path": "." }, "build": {}, "visibility": "project",
            "lifecycle": "published", "dataNeeds": [], "services": ["ai"],
            "limits": { "aiTokensPerDay": 150 },
        }),
    ));
    Some(state)
}

async fn complete(state: &AppState, body: Value) -> (StatusCode, Value, String) {
    let token = common::REALM.person_token(APP, "jana", &[]);
    let request = Request::post(format!("/apps/{APP}/api/services/ai/complete"))
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .expect("a request");
    let response = joinedcontext_portal::server::app(state.clone())
        .oneshot(request)
        .await
        .expect("a response");
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("a body");
    let text = String::from_utf8_lossy(&bytes).into_owned();
    (
        status,
        serde_json::from_str(&text).unwrap_or(Value::Null),
        text,
    )
}

fn ask() -> Value {
    json!({ "messages": [{ "role": "user", "content": "A pothole on Hlavná 4: how bad?" }] })
}

async fn sent(proxy: &MockServer) -> Vec<Value> {
    proxy
        .received_requests()
        .await
        .unwrap_or_default()
        .iter()
        .filter_map(|request| serde_json::from_slice(&request.body).ok())
        .collect()
}

#[tokio::test]
async fn a_completion_counts_its_tokens_until_the_day_is_spent() {
    let project = project("ai-day");
    let proxy = proxy(&project, "Severity 3.", 200).await;
    let Some(state) = state(&proxy, &project, json!(["identity", "data", "ai"])).await else {
        return;
    };
    let (status, body, text) = complete(&state, ask()).await;
    assert_eq!(status, StatusCode::OK, "{text}");
    assert_eq!(
        body,
        json!({ "text": "Severity 3.", "tokens": { "in": 70, "out": 30 } })
    );
    // 100 of 150 used: the next answer may take the 50 left and no more.
    let (status, _, text) = complete(&state, ask()).await;
    assert_eq!(status, StatusCode::OK, "{text}");
    let (status, body, text) = complete(&state, ask()).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{text}");
    assert_eq!(
        (body["service"].as_str(), body["quota"].as_str()),
        (Some("ai"), Some("aiTokensPerDay"))
    );
    assert!(
        body["resetAt"]
            .as_str()
            .is_some_and(|at| at.ends_with("T00:00:00Z")),
        "{text}"
    );

    let sent = sent(&proxy).await;
    assert_eq!(sent.len(), 2, "the spent call never reached the proxy");
    assert_eq!(
        sent[0]["model"], "deepseek/deepseek-v4.1-flash",
        "the platform's model"
    );
    assert_eq!(
        sent[0]["max_tokens"], 150,
        "never more than the day has left"
    );
    assert_eq!(sent[1]["max_tokens"], 50);
}

#[tokio::test]
async fn a_schema_answer_is_its_json_or_a_502() {
    let project = project("ai-schema");
    let schema = json!({ "type": "object", "required": ["severity"],
                         "properties": { "severity": { "type": "integer" } } });
    let proxy = proxy(&project, "{\"severity\": 3}", 200).await;
    let Some(state) = state(&proxy, &project, json!(["ai"])).await else {
        return;
    };
    let mut asked = ask();
    asked["schema"] = schema.clone();
    let (status, body, text) = complete(&state, asked.clone()).await;
    assert_eq!(status, StatusCode::OK, "{text}");
    assert_eq!(body["json"], json!({ "severity": 3 }));
    assert!(sent(&proxy).await[0].to_string().contains("JSON Schema"));

    let prose = self::proxy(&project, "It is a bad one.", 200).await;
    let Some(state) = self::state(&prose, &project, json!(["ai"])).await else {
        return;
    };
    let (status, body, text) = complete(&state, asked).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "{text}");
    assert_eq!(body["type"], "https://joinedcontext.com/errors/no-json");
}

#[tokio::test]
async fn a_refused_key_is_the_installations_and_ai_off_never_reaches_the_proxy() {
    let project = project("ai-key");
    let proxy = proxy(&project, "", 402).await;
    let Some(state) = state(&proxy, &project, json!(["ai"])).await else {
        return;
    };
    let (status, body, text) = complete(&state, ask()).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{text}");
    assert_eq!(
        body["type"],
        "https://joinedcontext.com/errors/no-model-key"
    );

    let off = self::proxy(&project, "x", 200).await;
    let Some(state) = self::state(&off, &project, json!(["identity", "data"])).await else {
        return;
    };
    let (status, body, text) = complete(&state, ask()).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{text}");
    assert_eq!(body["layer"], "organization");
    assert!(sent(&off).await.is_empty());
}
