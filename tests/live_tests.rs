//! API/01 §32, T-3105: a view watches a type of a space it may read and hears which entities and
//! attributes changed, from the gateway's delivery to `/live-notify/{key}`, which needs no session
//! and refuses a key the Portal never made.

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use axum_extra::extract::cookie::PrivateCookieJar;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

use joinedcontext_portal::auth::csrf::{CSRF_COOKIE, CSRF_HEADER};
use joinedcontext_portal::auth::session::{self, Identity, Session};
use joinedcontext_portal::config::Config;
use joinedcontext_portal::permissions::ORG_NAMESPACE;
use joinedcontext_portal::resource::{ObjectMeta, ResourceEnvelope, API_VERSION};
use joinedcontext_portal::server;
use joinedcontext_portal::state::AppState;

const PROJECT: &str = "helsinki";
const READER: &str = "sami.air@hel.fi";
const OTHER: &str = "anna.air@hel.fi";
const STRANGER: &str = "nobody@hel.fi";
const CSRF: &str = "test-csrf-token-12345";

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
        + &format!("; {CSRF_COOKIE}={CSRF}")
}

/// Two spaces of helsinki; two readers bound to `air` alone.
fn world() -> AppState {
    let state = AppState::new(Config::for_tests(), None);
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
        json!({ "subjects": [{ "user": READER }, { "user": OTHER }], "role": "space-reader",
                "scope": { "contextSpace": "air" } }),
    ));
    state
}

async fn call(
    state: &AppState,
    email: &str,
    method: &str,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::COOKIE, cookie(&state.config, email))
        .header(CSRF_HEADER, CSRF)
        .header(header::CONTENT_TYPE, "application/json")
        .body(body.map_or_else(Body::empty, |b| Body::from(b.to_string())))
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

const LIVE: &str = "/api/v1/projects/helsinki/spaces/air/live?type=AirQualityObserved";

#[tokio::test]
async fn a_reader_watches_a_type_and_hears_a_delivered_change_by_name() {
    let state = world();
    let request = Request::builder()
        .uri(LIVE)
        .header(header::COOKIE, cookie(&state.config, READER))
        .body(Body::empty())
        .expect("a request");
    let response = server::app(state.clone())
        .oneshot(request)
        .await
        .expect("a response");
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap_or_default()
        .starts_with("text/event-stream"));
    let mut body = response.into_body();

    // The gateway delivers with no session and no CSRF token: the key is the credential.
    let key = state.live.key("air", "AirQualityObserved");
    let delivery = Request::builder()
        .method("POST")
        .uri(format!("/live-notify/{key}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({ "data": [{ "id": "urn:ngsi-ld:AirQualityObserved:hel.fi:air:1", "pm10": 40 }] }).to_string(),
        ))
        .expect("a request");
    let delivered = server::app(state.clone())
        .oneshot(delivery)
        .await
        .expect("a response");
    assert_eq!(delivered.status(), StatusCode::NO_CONTENT);

    let frame = tokio::time::timeout(std::time::Duration::from_secs(5), body.frame())
        .await
        .expect("an event in time")
        .expect("a frame")
        .expect("no error");
    let text = String::from_utf8(frame.into_data().expect("data").to_vec()).expect("utf-8");
    assert!(text.starts_with("event: changed"), "{text}");
    assert!(
        text.contains("\"ids\":[\"urn:ngsi-ld:AirQualityObserved:hel.fi:air:1\"]"),
        "{text}"
    );
    assert!(text.contains("\"attrs\":[\"pm10\"]"), "{text}");
    assert!(!text.contains("40"), "no value is passed on: {text}");
}

#[tokio::test]
async fn a_key_the_portal_never_made_is_a_404_and_a_huge_body_is_refused() {
    let state = world();
    let post = |uri: String, body: String| {
        Request::builder()
            .method("POST")
            .uri(uri)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body))
            .expect("a request")
    };
    let answer = server::app(state.clone())
        .oneshot(post(
            format!("/live-notify/{}", "a".repeat(64)),
            "{}".into(),
        ))
        .await
        .expect("a response");
    assert_eq!(answer.status(), StatusCode::NOT_FOUND);
    let big = format!("{{\"data\":\"{}\"}}", "x".repeat(2 * 1024 * 1024));
    let answer = server::app(state.clone())
        .oneshot(post(
            format!("/live-notify/{}", state.live.key("air", "T")),
            big,
        ))
        .await
        .expect("a response");
    assert_eq!(answer.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn a_space_the_caller_may_not_read_or_a_type_that_is_no_name_is_refused() {
    let state = world();
    assert_eq!(
        call(&state, STRANGER, "GET", LIVE, None).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &state,
            READER,
            "GET",
            "/api/v1/projects/helsinki/spaces/mobility/live?type=Road",
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &state,
            READER,
            "GET",
            "/api/v1/projects/helsinki/spaces/air/live?type=1;drop",
            None
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call(
            &state,
            READER,
            "GET",
            "/api/v1/projects/helsinki/spaces/air/live",
            None
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
}
