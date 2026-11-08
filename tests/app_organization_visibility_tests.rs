//! A `visibility: organization` App opens for the Organization that owns its project, never for
//! a person bound only in another Organization of the installation (AP-174, ADR-N-067, T-6689).
//! Both doors read one rule: the "Shared with me" listing and the App's own `…/me`.

mod common;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use serde_json::{json, Value};
use tower::ServiceExt;

use common::{envelope, person, send};
use joinedcontext_portal::config::Config;
use joinedcontext_portal::permissions::ORG_NAMESPACE;
use joinedcontext_portal::state::AppState;

const ME: &str = "/api/v1/projects/espoo/apps/air-map/me";

/// Organization `hel` (the installation's) owns helsinki; `esp` owns espoo, which publishes the
/// organization App `air-map`, and vantaa. `vera` is bound in helsinki, `maria` in vantaa.
fn state() -> AppState {
    let config = Config::from_vars(|key| {
        match key {
            "JC_OIDC_ISSUER" => Some(common::REALM.issuer.as_str()),
            "JC_PORTAL_COOKIE_KEY" => {
                Some("cookie-key-of-the-portal-tests-it-seals-no-session-anybody-uses-0001")
            }
            "JC_OIDC_CLIENT_ID" => Some("portal-api"),
            "JC_OIDC_CLIENT_SECRET" => Some("secret"),
            _ => None,
        }
        .map(str::to_owned)
    })
    .expect("a realm");
    let state = AppState::new(config, None);
    let mirror = &state.mirror;
    mirror.upsert(envelope(
        "Organization",
        "hel",
        ORG_NAMESPACE,
        json!({ "installation": true }),
    ));
    mirror.upsert(envelope("Organization", "esp", ORG_NAMESPACE, json!({})));
    for (project, organization) in [("helsinki", "hel"), ("espoo", "esp"), ("vantaa", "esp")] {
        mirror.upsert(envelope(
            "Project",
            project,
            ORG_NAMESPACE,
            json!({ "organizationRef": organization }),
        ));
    }
    common::bind(mirror, "vera", "helsinki");
    common::bind(mirror, "maria", "vantaa");
    mirror.upsert(envelope(
        "App",
        "air-map",
        "espoo",
        json!({
            "kind": "static",
            "source": { "path": "./src" },
            "build": {},
            "visibility": "organization",
            "lifecycle": "published",
            "dataNeeds": [],
            "roles": [],
            "access": [],
        }),
    ));
    state
}

async fn me(state: &AppState, who: &str) -> (StatusCode, String) {
    let token = common::REALM.person_token("air-map", who, &[]);
    let response = joinedcontext_portal::server::app(state.clone())
        .oneshot(
            Request::get(ME)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())
                .expect("a request"),
        )
        .await
        .expect("a response");
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("a body");
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

async fn shared(state: &AppState, who: &str) -> Vec<Value> {
    let answer = send(state, person(who), "GET", "/api/v1/shared-apps", None).await;
    assert_eq!(answer.status, StatusCode::OK, "{}", answer.text);
    serde_json::from_str(&answer.text).expect("a JSON list")
}

#[tokio::test]
async fn a_person_of_another_organization_is_neither_listed_nor_admitted() {
    let state = state();
    assert!(shared(&state, "vera").await.is_empty());
    let (status, text) = me(&state, "vera").await;
    // The refusal is the 404 of a name never created: it names neither the App nor its members.
    assert_eq!(status, StatusCode::NOT_FOUND, "{text}");
    assert!(!text.contains("maria") && !text.contains("esp\""), "{text}");
}

#[tokio::test]
async fn a_person_of_the_owning_organization_is_listed_and_admitted() {
    let state = state();
    let listed = shared(&state, "maria").await;
    assert_eq!(listed.len(), 1, "{listed:?}");
    assert_eq!(
        (listed[0]["project"].as_str(), listed[0]["name"].as_str()),
        (Some("espoo"), Some("air-map"))
    );
    let (status, text) = me(&state, "maria").await;
    assert_eq!(status, StatusCode::OK, "{text}");
}
