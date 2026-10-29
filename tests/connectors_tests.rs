//! Personal MCP connectors (UI-98, EP-123, T-4531, T-5970): one store, the connector record of
//! API/14; the old list in a person's preferences moves into it once, read-only and never wider,
//! and the internal listener hands a person's data-reading connectors to the gateway's client
//! alone.
//!
//! Runs when `JC_PORTAL_TEST_DATABASE_URL` points at a PostgreSQL the test may write to; skips
//! with a note otherwise (see preferences_db_tests.rs).

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

use joinedcontext_portal::config::Config;
use joinedcontext_portal::server;
use joinedcontext_portal::state::AppState;

mod common;

const GATEWAY_CLIENT: &str = "context-gateway";

fn database_url() -> Option<String> {
    std::env::var("JC_PORTAL_TEST_DATABASE_URL")
        .ok()
        .filter(|url| !url.trim().is_empty())
}

async fn state(url: &str) -> AppState {
    let config = Config::from_vars(|key| {
        match key {
            "JC_OIDC_ISSUER" => Some(common::REALM.issuer.as_str()),
            "JC_PORTAL_COOKIE_KEY" => {
                Some("cookie-key-of-the-portal-tests-it-seals-no-session-anybody-uses-0001")
            }
            "JC_OIDC_CLIENT_ID" => Some("portal-api"),
            "JC_OIDC_CLIENT_SECRET" => Some("secret"),
            "JC_PORTAL_GATEWAY_CLIENT_ID" => Some(GATEWAY_CLIENT),
            _ => None,
        }
        .map(str::to_owned)
    })
    .expect("config");
    let pool = joinedcontext_portal::db::connect(url)
        .await
        .expect("connect + migrate");
    let state = AppState::new(config, None).with_db(pool);
    state
        .bearer
        .as_ref()
        .expect("a realm")
        .refresh()
        .await
        .expect("jwks");
    for (name, audience) in [("air", "public"), ("inner", "organization")] {
        state.mirror.upsert(common::envelope(
            "Endpoint",
            name,
            "mesto",
            json!({ "contextSpaceRef": "mesto", "slug": slug(name), "audience": audience }),
        ));
    }
    state
}

/// A person no other run of this suite uses, so runs share one database.
fn fresh(tag: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    format!("{tag}{nanos}")
}

/// A 26-character slug of base32 letters.
fn slug(name: &str) -> String {
    name.chars().cycle().take(26).collect()
}

async fn internal(state: &AppState, sub: &str, bearer: &str) -> (StatusCode, Value) {
    let response = server::internal_app(state.clone())
        .oneshot(
            Request::builder()
                .uri(format!("/internal/connectors/{sub}"))
                .header(header::AUTHORIZATION, format!("Bearer {bearer}"))
                .body(Body::empty())
                .expect("a request"),
        )
        .await
        .expect("an answer");
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn old_connectors_move_once_read_only_and_reach_the_gateway_alone() {
    let Some(url) = database_url() else {
        eprintln!("skipped: JC_PORTAL_TEST_DATABASE_URL is not set");
        return;
    };
    let state = state(&url).await;
    let (a, b) = (fresh("a"), fresh("b"));
    let (sub_a, sub_b) = (format!("sub-{a}"), format!("sub-{b}"));
    let pool = state.db.clone().expect("a pool");
    joinedcontext_portal::db::save_preferences(
        &pool,
        &sub_a,
        &json!({
            "theme": "dark",
            "connectors": [
                { "name": "fav", "select": { "endpoints": [slug("air")] } },
                { "name": "whole", "select": {} },
                { "name": "nothing", "select": { "themes": ["AGRI"] } },
            ],
        }),
    )
    .await
    .expect("an old row");

    let gateway = common::REALM.workload(GATEWAY_CLIENT);
    let (status, body) = internal(&state, &sub_a, &gateway).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let mut moved: Vec<Value> = body["connectors"].as_array().expect("a list").clone();
    moved.sort_by_key(|c| c["name"].as_str().map(str::to_owned));
    assert_eq!(
        moved.len(),
        2,
        "a selector taking nothing today moves nowhere: {body}"
    );
    assert_eq!(moved[0]["name"], "fav");
    assert_eq!(
        moved[0]["scope"],
        json!([{ "project": "mesto", "endpoint": "air", "access": "read" }]),
        "a favourite stays that one Endpoint, read-only"
    );
    assert_eq!(moved[1]["name"], "whole");
    assert_eq!(
        moved[1]["scope"],
        json!([{ "project": "mesto", "access": "read" }])
    );
    assert!(moved
        .iter()
        .all(|c| c["id"].as_str().is_some_and(|id| id.len() == 26)));
    assert!(moved.iter().all(|c| c["allowedClients"] == json!([])));

    let mine = state
        .connectors
        .of_owner(&sub_a, "https://portal.test")
        .await
        .expect("the store");
    assert_eq!(mine.len(), 2, "moved once: {mine:?}");
    assert!(mine
        .iter()
        .all(|c| !c.writes && c.segments == ["data-read"]));
    let (status, again) = internal(&state, &sub_a, &gateway).await;
    assert_eq!(
        (status, again["connectors"].as_array().map(Vec::len)),
        (StatusCode::OK, Some(2))
    );

    let kept = joinedcontext_portal::db::load_preferences(&pool, &sub_a)
        .await
        .expect("the row")
        .expect("a row");
    assert_eq!(
        kept,
        json!({ "theme": "dark" }),
        "the old list left, the rest stayed"
    );
    let prefs = common::send(
        &state,
        common::person(&a),
        "GET",
        "/api/v1/preferences",
        None,
    )
    .await;
    assert_eq!(prefs.status, StatusCode::OK);
    assert!(
        prefs.text.contains("dark") && !prefs.text.contains("fav"),
        "{}",
        prefs.text
    );

    let (status, theirs) = internal(&state, &sub_b, &gateway).await;
    assert_eq!(
        (status, theirs),
        (StatusCode::OK, json!({ "connectors": [] }))
    );

    for bearer in [
        common::REALM.workload("some-app"),
        common::REALM.person_token_of(common::INTERNAL_AUDIENCE, "portal-ui", &a, &[]),
        common::REALM.person_token("x", &a, &[]),
        common::REALM.token(GATEWAY_CLIENT, "portal-api"),
    ] {
        let (status, body) = internal(&state, &sub_a, &bearer).await;
        assert!(
            status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN,
            "{status} {body}"
        );
        assert!(!body.to_string().contains("fav"));
    }
}

#[tokio::test]
async fn a_save_of_preferences_never_drops_old_connectors_and_refuses_the_old_field() {
    let Some(url) = database_url() else {
        eprintln!("skipped: JC_PORTAL_TEST_DATABASE_URL is not set");
        return;
    };
    let state = state(&url).await;
    let a = fresh("a");
    let sub_a = format!("sub-{a}");
    let pool = state.db.clone().expect("a pool");
    joinedcontext_portal::db::save_preferences(
        &pool,
        &sub_a,
        &json!({ "connectors": [{ "name": "fav", "select": { "projects": ["mesto"] } }] }),
    )
    .await
    .expect("an old row");
    let saved = common::send(
        &state,
        common::person(&a),
        "PUT",
        "/api/v1/preferences",
        Some(json!({ "theme": "light" })),
    )
    .await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.text);
    let mine = state
        .connectors
        .of_owner(&sub_a, "https://portal.test")
        .await
        .expect("the store");
    assert_eq!(
        mine.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
        ["fav"]
    );

    let old = common::send(
        &state,
        common::person(&a),
        "PUT",
        "/api/v1/preferences",
        Some(json!({ "connectors": [{ "name": "x", "select": {} }] })),
    )
    .await;
    assert_eq!(old.status, StatusCode::BAD_REQUEST, "{}", old.text);
}

#[tokio::test]
async fn only_live_data_reading_connectors_reach_the_gateway() {
    let Some(url) = database_url() else {
        eprintln!("skipped: JC_PORTAL_TEST_DATABASE_URL is not set");
        return;
    };
    let state = state(&url).await;
    let sub = format!("sub-{}", fresh("c"));
    let new = |name: &str, segment: &str| -> joinedcontext_portal::connectors::NewConnector {
        serde_json::from_value(json!({
            "name": name,
            "segments": [segment],
            "scope": [{ "project": "mesto", "access": "read" }],
            "expiresAt": "2999-01-01T00:00:00Z",
        }))
        .expect("a connector")
    };
    let base = "https://portal.test";
    state
        .connectors
        .create(&sub, new("reads", "data-read"), base)
        .await
        .expect("created");
    state
        .connectors
        .create(&sub, new("models", "context"), base)
        .await
        .expect("created");
    let gone = state
        .connectors
        .create(&sub, new("gone", "data-read"), base)
        .await
        .expect("created");
    assert!(state
        .connectors
        .revoke(&gone.id, &sub)
        .await
        .expect("revoked"));
    let (status, body) = internal(&state, &sub, &common::REALM.workload(GATEWAY_CLIENT)).await;
    assert_eq!(status, StatusCode::OK);
    let names: Vec<&str> = body["connectors"]
        .as_array()
        .expect("a list")
        .iter()
        .filter_map(|c| c["name"].as_str())
        .collect();
    assert_eq!(names, ["reads"], "{body}");
}
