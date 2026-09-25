//! T-2889, API/01 §28: a space's size is the broker's count of its tenant, read with the same
//! rights as the space, kept for five minutes, and a broker that cannot answer is a reason, never
//! a zero.

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use axum_extra::extract::cookie::PrivateCookieJar;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use joinedcontext_portal::auth::session::{self, Identity, Session};
use joinedcontext_portal::config::Config;
use joinedcontext_portal::permissions::ORG_NAMESPACE;
use joinedcontext_portal::resource::{ObjectMeta, ResourceEnvelope, API_VERSION};
use joinedcontext_portal::server;
use joinedcontext_portal::state::AppState;

const PROJECT: &str = "helsinki";
const READER: &str = "sami.air@hel.fi";
const STRANGER: &str = "nobody@hel.fi";

fn envelope(kind: &str, name: &str, namespace: &str, spec: Value) -> ResourceEnvelope {
    ResourceEnvelope {
        api_version: API_VERSION.into(),
        kind: kind.into(),
        metadata: ObjectMeta {
            name: name.into(),
            namespace: Some(namespace.into()),
            ..Default::default()
        },
        spec,
        status: None,
    }
}

fn cookie(config: &Config, email: &str) -> String {
    use axum::response::IntoResponse;
    let now = session::now_unix();
    let username = email.split('@').next().unwrap_or(email).to_owned();
    let session = Session {
        identity: Identity {
            client: None,
            subject: format!("f:1:{username}"),
            username,
            email: Some(email.to_owned()),
            name: None,
            roles: Vec::new(),
            groups: Vec::new(),
        },
        expires_at: now + 3600,
        issued_at: now,
        id_token: "id-token-placeholder".into(),
        access_expires_at: now + 3600,
        refresh_token: None,
    };
    let jar = session::store(PrivateCookieJar::new(config.cookie_key.clone()), &session)
        .expect("store session");
    let response = (jar, StatusCode::OK).into_response();
    response
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .map(|raw| raw.split(';').next().unwrap_or_default().to_owned())
        .collect::<Vec<_>>()
        .join("; ")
}

/// Two spaces of helsinki and a reader bound to `air` alone, against a broker at `broker`.
fn world(broker: Option<String>) -> AppState {
    let state = AppState::new(
        Config {
            broker_url: broker,
            ..Config::for_tests()
        },
        None,
    );
    for space in ["air", "mobility"] {
        state
            .mirror
            .upsert(envelope("ContextSpace", space, PROJECT, json!({})));
    }
    state.mirror.upsert(envelope(
        "Role",
        "space-reader",
        ORG_NAMESPACE,
        json!({ "rules": [{ "kinds": ["ContextSpace", "Project"], "verbs": ["read"] }] }),
    ));
    state.mirror.upsert(envelope(
        "RoleBinding",
        "air-readers",
        ORG_NAMESPACE,
        json!({ "subjects": [{ "user": READER }], "role": "space-reader",
                "scope": { "contextSpace": "air" } }),
    ));
    state
}

async fn get(state: &AppState, email: &str, uri: &str) -> (StatusCode, Value) {
    let request = Request::builder()
        .uri(uri)
        .header(header::COOKIE, cookie(&state.config, email))
        .body(Body::empty())
        .expect("a request");
    let response = server::app(state.clone())
        .oneshot(request)
        .await
        .expect("a response");
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("a body")
        .to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

const AIR: &str = "/api/v1/projects/helsinki/spaces/air/usage";

#[tokio::test]
async fn a_reader_gets_the_brokers_count_and_a_second_read_is_kept() {
    let broker = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/q/tenants/air"))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            json!({ "tenant": "air", "counts": { "entities": 14232, "subscriptions": 1 } }),
        ))
        .expect(1)
        .mount(&broker)
        .await;
    let state = world(Some(broker.uri()));

    let (status, body) = get(&state, READER, AIR).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["entities"], json!(14232));
    assert!(body["observedAt"].is_string(), "{body}");
    // Within five minutes the same answer is shown and the broker is not asked again.
    let (status, again) = get(&state, READER, AIR).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(again, body);
}

#[tokio::test]
async fn a_space_the_broker_has_no_tenant_for_holds_nothing() {
    let broker = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/q/tenants/air"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&broker)
        .await;
    let (status, body) = get(&world(Some(broker.uri())), READER, AIR).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["entities"], json!(0));
}

#[tokio::test]
async fn a_space_the_caller_may_not_read_is_404_and_the_broker_is_not_asked() {
    let broker = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200))
        .expect(0)
        .mount(&broker)
        .await;
    let state = world(Some(broker.uri()));
    for (who, uri) in [
        (READER, "/api/v1/projects/helsinki/spaces/mobility/usage"),
        (STRANGER, AIR),
        (READER, "/api/v1/projects/helsinki/spaces/nowhere/usage"),
    ] {
        let (status, body) = get(&state, who, uri).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{who} {uri}: {body}");
    }
}

#[tokio::test]
async fn a_broker_that_cannot_answer_is_a_reason_and_never_a_zero() {
    let broker = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/q/tenants/air"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&broker)
        .await;
    let (status, body) = get(&world(Some(broker.uri())), READER, AIR).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert!(body.to_string().contains("500"), "{body}");

    let (status, body) = get(&world(None), READER, AIR).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert!(body.to_string().contains("JC_PORTAL_BROKER_URL"), "{body}");
}
