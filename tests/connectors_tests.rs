//! Personal MCP connectors (UI-98, EP-123, T-4531): kept per person, a favourite only when the
//! person may read it, and handed out on the internal listener to the gateway's client alone.
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
            json!({ "slug": format!("{name}1"), "audience": audience }),
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

fn connectors(endpoints: &[&str]) -> Value {
    json!({ "connectors": [{ "name": "fav", "select": { "endpoints": endpoints } }] })
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
async fn a_persons_connectors_reach_the_gateway_and_nobody_else() {
    let Some(url) = database_url() else {
        eprintln!("skipped: JC_PORTAL_TEST_DATABASE_URL is not set");
        return;
    };
    let state = state(&url).await;
    let (a, b) = (fresh("a"), fresh("b"));
    let saved = common::send(
        &state,
        common::person(&a),
        "PUT",
        "/api/v1/preferences",
        Some(connectors(&["air1"])),
    )
    .await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.text);

    let theirs = common::send(
        &state,
        common::person(&b),
        "GET",
        "/api/v1/preferences",
        None,
    )
    .await;
    assert_eq!(theirs.status, StatusCode::OK);
    assert!(
        !theirs.text.contains("fav"),
        "B sees none of A's: {}",
        theirs.text
    );

    let sub_a = format!("sub-{a}");
    let (status, body) = internal(&state, &sub_a, &common::REALM.workload(GATEWAY_CLIENT)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["connectors"][0]["select"]["endpoints"],
        json!(["air1"])
    );
    let (status, body) = internal(
        &state,
        &format!("sub-{b}"),
        &common::REALM.workload(GATEWAY_CLIENT),
    )
    .await;
    assert_eq!(
        (status, body),
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
        assert!(!body.to_string().contains("air1"));
    }
}

#[tokio::test]
async fn an_endpoint_the_person_cannot_read_is_not_starred() {
    let Some(url) = database_url() else {
        eprintln!("skipped: JC_PORTAL_TEST_DATABASE_URL is not set");
        return;
    };
    let state = state(&url).await;
    let a = fresh("a");
    for slug in ["inner1", "nosuch1"] {
        let refused = common::send(
            &state,
            common::person(&a),
            "PUT",
            "/api/v1/preferences",
            Some(connectors(&["air1", slug])),
        )
        .await;
        assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.text);
        assert!(refused.text.contains(slug), "{}", refused.text);
    }
    let eleven: Vec<Value> = (0..11)
        .map(|i| json!({ "name": format!("c{i}") }))
        .collect();
    let refused = common::send(
        &state,
        common::person(&a),
        "PUT",
        "/api/v1/preferences",
        Some(json!({ "connectors": eleven })),
    )
    .await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST);
    let mine = common::send(
        &state,
        common::person(&a),
        "GET",
        "/api/v1/preferences",
        None,
    )
    .await;
    assert_eq!(mine.text, "{}", "nothing refused was kept");
}

/// Binds `{who}@hel.fi` to reading spaces in `project` (and so the project itself).
fn bind_space_reader(state: &AppState, who: &str, project: &str) {
    let org = joinedcontext_portal::permissions::ORG_NAMESPACE;
    state.mirror.upsert(common::envelope(
        "Role",
        "space-readers",
        org,
        json!({ "rules": [{ "kinds": ["ContextSpace"], "verbs": ["read"] }] }),
    ));
    state.mirror.upsert(common::envelope(
        "RoleBinding",
        &format!("{who}-spaces-in-{project}"),
        org,
        json!({ "subjects": [{ "user": format!("{who}@hel.fi") }], "role": "space-readers",
                "scope": { "project": project } }),
    ));
}

/// A connector's projects and spaces are picked from what the person reads, and the server checks
/// each one again on save (T-4948): a project or space they cannot read, of another organization's
/// or one that does not exist, is refused by the same answer, naming the field.
#[tokio::test]
async fn a_connector_selects_only_projects_and_spaces_the_person_reads() {
    let Some(url) = database_url() else {
        eprintln!("skipped: JC_PORTAL_TEST_DATABASE_URL is not set");
        return;
    };
    let state = state(&url).await;
    let a = fresh("a");
    for (project, space) in [("mesto", "air"), ("mesto", "noise"), ("kraj", "roads")] {
        state
            .mirror
            .upsert(common::envelope("ContextSpace", space, project, json!({})));
    }
    bind_space_reader(&state, &a, "mesto");
    // `kraj` is readable through an App grant alone: its spaces are not.
    common::bind(&state.mirror, &a, "kraj");
    let put = |select: Value| {
        let state = state.clone();
        let a = a.clone();
        async move {
            common::send(
                &state,
                common::person(&a),
                "PUT",
                "/api/v1/preferences",
                Some(json!({ "connectors": [{ "name": "pick", "select": select }] })),
            )
            .await
        }
    };

    let saved = put(json!({ "projects": ["mesto", "kraj"], "spaces": ["mesto/air"] })).await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.text);

    for (field, value) in [
        ("projects", "elsewhere"),
        ("projects", "nosuch"),
        ("spaces", "kraj/roads"),
        ("spaces", "elsewhere/air"),
        ("spaces", "mesto/nosuch"),
    ] {
        state.mirror.upsert(common::envelope(
            "ContextSpace",
            "air",
            "elsewhere",
            json!({}),
        ));
        let refused = put(json!({ field: [value] })).await;
        assert_eq!(
            refused.status,
            StatusCode::BAD_REQUEST,
            "{value}: {}",
            refused.text
        );
        let body: Value = serde_json::from_str(&refused.text).unwrap_or(Value::Null);
        assert_eq!(body["errors"], json!([field]), "{value}: {}", refused.text);
        assert!(
            body["detail"]
                .as_str()
                .is_some_and(|d| d.ends_with(&format!("'{value}' is not one you may read"))),
            "{value}: unknown and unreadable read alike: {}",
            refused.text
        );
    }
}

/// T-4949, UI-98: a viewer of a project adds an Endpoint they read to their own connectors (the
/// write is to their own preferences and reaches nothing they could not read already); the same
/// organization Endpoint is refused to a person with no grant in its project.
#[tokio::test]
async fn a_viewer_adds_an_endpoint_they_read_and_a_stranger_cannot() {
    let Some(url) = database_url() else {
        eprintln!("skipped: JC_PORTAL_TEST_DATABASE_URL is not set");
        return;
    };
    let state = state(&url).await;
    let org = joinedcontext_portal::permissions::ORG_NAMESPACE;
    let viewer = fresh("viewer");
    state.mirror.upsert(common::envelope(
        "Role",
        "endpoint-viewers",
        org,
        json!({ "rules": [{ "kinds": ["Endpoint"], "verbs": ["read"] }] }),
    ));
    state.mirror.upsert(common::envelope(
        "RoleBinding",
        &format!("{viewer}-reads-mesto"),
        org,
        json!({ "subjects": [{ "user": format!("{viewer}@hel.fi") }], "role": "endpoint-viewers",
                "scope": { "project": "mesto" } }),
    ));
    let added = common::send(
        &state,
        common::person(&viewer),
        "PUT",
        "/api/v1/preferences",
        Some(connectors(&["inner1"])),
    )
    .await;
    assert_eq!(added.status, StatusCode::OK, "{}", added.text);
    assert!(added.text.contains("inner1"), "{}", added.text);

    let stranger = fresh("stranger");
    let refused = common::send(
        &state,
        common::person(&stranger),
        "PUT",
        "/api/v1/preferences",
        Some(connectors(&["inner1"])),
    )
    .await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.text);
    assert!(refused.text.contains("inner1"), "{}", refused.text);
}
