//! A published App's backend learns the caller's roles from the Portal (AP-109, AP-92,
//! Architecture/16 §13).

mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::{json, Value};
use tower::ServiceExt;

use common::{envelope, person, send};
use joinedcontext_portal::state::AppState;

const ME: &str = "/api/v1/projects/helsinki/apps/air-quality/me";

fn app(lifecycle: &str) -> Value {
    json!({
        "kind": "fullstack",
        "source": { "git": {
            "url": "https://forge.example/joinedcontext/helsinki_air-quality.git",
            "ref": "8c56954a1f0e3d2c1b0a99887766554433221100",
        }},
        "build": { "rust": "1.90", "node": "22" },
        "visibility": "project",
        "lifecycle": lifecycle,
        "dataNeeds": [{
            "contextSpaceRef": { "kind": "ContextSpace", "name": "helsinki" },
            "types": ["AirQualityObserved"],
            "operations": ["queryEntity"],
        }],
        "roles": [
            { "name": "viewer", "title": { "en": "Viewer" } },
            { "name": "steward", "title": { "en": "Steward" } },
        ],
        "access": [
            { "role": "steward", "subjects": [{ "user": "jana@hel.fi" }] },
            { "role": "viewer", "subjects": [{ "group": "air-readers" }, { "user": "JANA@hel.fi" }] },
        ],
    })
}

fn state_with(lifecycle: &str) -> AppState {
    let state = AppState::new(joinedcontext_portal::config::Config::for_tests(), None);
    state
        .mirror
        .upsert(envelope("App", "air-quality", "helsinki", app(lifecycle)));
    state
}

fn body(text: &str) -> Value {
    serde_json::from_str(text).expect("a JSON answer")
}

/// AP-92, AP-109: the roles come from the verified identity against `spec.access`, by e-mail
/// (any case) and by group, in the order `spec.roles` declares them; a person who holds none
/// gets an empty list, and nobody needs a rule in the project to ask about themselves.
#[tokio::test]
async fn the_answer_is_the_callers_roles_from_spec_access_and_nobody_elses() {
    let state = state_with("published");

    let jana = send(&state, person("jana"), "GET", ME, None).await;
    assert_eq!(jana.status, StatusCode::OK, "{}", jana.text);
    assert_eq!(
        body(&jana.text),
        json!({ "id": "sub-jana", "name": "jana", "email": "jana@hel.fi", "roles": ["viewer", "steward"] })
    );

    let mut reader = person("vera");
    reader.groups = vec!["air-readers".into()];
    assert_eq!(
        body(&send(&state, reader, "GET", ME, None).await.text)["roles"],
        json!(["viewer"])
    );

    let otto = send(&state, person("otto"), "GET", ME, None).await;
    assert_eq!(otto.status, StatusCode::OK, "{}", otto.text);
    assert_eq!(body(&otto.text)["roles"], json!([]));
    assert!(
        !otto.text.contains("jana"),
        "the answer names nobody but the caller: {}",
        otto.text
    );
}

/// AP-109: an App that is not published, or not in this project, is a `404`; no credential is a
/// `401`; and one person's answer is never kept by a shared cache.
#[tokio::test]
async fn an_unpublished_app_is_not_found_and_an_anonymous_caller_is_refused() {
    for lifecycle in ["draft", "preview", "retired"] {
        let answer = send(&state_with(lifecycle), person("jana"), "GET", ME, None).await;
        assert_eq!(
            answer.status,
            StatusCode::NOT_FOUND,
            "{lifecycle}: {}",
            answer.text
        );
    }
    let state = state_with("published");
    let elsewhere = send(
        &state,
        person("jana"),
        "GET",
        "/api/v1/projects/espoo/apps/air-quality/me",
        None,
    )
    .await;
    assert_eq!(elsewhere.status, StatusCode::NOT_FOUND);

    let anonymous = joinedcontext_portal::server::app(state.clone())
        .oneshot(Request::get(ME).body(Body::empty()).expect("a request"))
        .await
        .expect("a response");
    assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);

    let config = state.config.clone();
    let response = joinedcontext_portal::server::app(state)
        .oneshot(
            Request::get(ME)
                .header(
                    axum::http::header::COOKIE,
                    common::cookie(&config, person("jana")),
                )
                .body(Body::empty())
                .expect("a request"),
        )
        .await
        .expect("a response");
    assert_eq!(response.status(), StatusCode::OK);
    let cache = response.headers()["cache-control"]
        .to_str()
        .unwrap_or_default();
    assert!(cache.contains("no-store"), "{cache}");
}
