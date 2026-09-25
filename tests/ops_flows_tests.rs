//! `jc_flow_start` through every door of the registry (T-1534; AG-64, PF-50, CC-24, CC-26, CC-59,
//! MF-24).
//!
//! What was there before this file: the REST route `POST …/flows` is tested in
//! `edge_flow_branding_tests.rs` (a flow names its blueprint, every refusal before a branch exists),
//! `blueprint_gallery_tests.rs` (the gallery's role filter, a namespace escape) and
//! `edge_change_lane_tests.rs`. No test called the operation through the registry.
//!
//! API/01 §13 and R20: a blueprint the caller may not run answers exactly like one that does not
//! exist, so an unknown name is a `404` that lists nothing; the gallery (`GET /api/v1/blueprints`)
//! is where a caller learns the names she may run.

mod common;

use axum::http::StatusCode;
use common::doors::{self, mcp, run, session, steward, stranger, viewer, PROJECT};
use common::{envelope, forge, state_on};
use joinedcontext_portal::auth::session::Identity;
use joinedcontext_portal::permissions::ORG_NAMESPACE;
use joinedcontext_portal::state::AppState;
use serde_json::{json, Value};
use wiremock::MockServer;

const ROLE: &str = "domain-editor";

const TEMPLATE: &str = "apiVersion: joinedcontext.com/v1alpha1
kind: Dashboard
metadata:
  name: alert-{{ title }}
spec:
  title: {{ title }}
";

/// The template writes a literal secret into the manifest it renders.
const LEAKY: &str = "apiVersion: joinedcontext.com/v1alpha1
kind: Dashboard
metadata:
  name: alert-{{ title }}
spec:
  title: {{ title }}
  apiKey: sk-live-{{ title }}
";

fn with_role(identity: Identity) -> Identity {
    Identity {
        roles: vec![ROLE.to_owned()],
        ..identity
    }
}

fn blueprint(name: &str, template: &str, roles: Value) -> Value {
    json!({
        "version": "1.2.0",
        "category": "alerting",
        "riskClass": "green",
        "allowedRoles": roles,
        "parameterSchema": {
            "type": "object",
            "required": ["title"],
            "properties": { "title": { "type": "string", "pattern": "^[a-z0-9-]+$" } },
        },
        "templates": [{ "name": name, "template": template }],
    })
}

async fn world() -> (MockServer, AppState) {
    let server = forge().await;
    let state = doors::state_with(state_on(&server));
    for (name, template, roles) in [
        ("threshold-alert", TEMPLATE, json!([ROLE])),
        ("leaky-alert", LEAKY, json!([ROLE])),
        ("cross-city-sharing", TEMPLATE, json!(["org-admin"])),
    ] {
        state.mirror.upsert(envelope(
            "Blueprint",
            name,
            ORG_NAMESPACE,
            blueprint("dashboard", template, roles),
        ));
    }
    // The steward also proposes Dashboards; the viewer reads them.
    state.mirror.upsert(envelope(
        "Role",
        "dashboard-role",
        ORG_NAMESPACE,
        json!({ "rules": [{ "kinds": ["Dashboard"], "verbs": ["read", "propose"] }] }),
    ));
    state.mirror.upsert(envelope(
        "RoleBinding",
        "dashboard-binding",
        ORG_NAMESPACE,
        json!({
            "subjects": [{ "group": "city-stewards" }],
            "role": "dashboard-role",
            "scope": { "project": PROJECT },
        }),
    ));
    (server, state)
}

fn flow(blueprint: &str, parameters: Value) -> Value {
    json!({ "blueprint": blueprint, "version": "1.2.0", "parameters": parameters })
}

async fn forge_writes(server: &MockServer) -> usize {
    server
        .received_requests()
        .await
        .unwrap_or_default()
        .iter()
        .filter(|request| request.method.as_str() != "GET")
        .count()
}

/// CC-24, CC-32: a steward who holds the blueprint's role runs it through the session, MCP and a
/// run whose profile names the operation, and each gets one Change.
#[tokio::test]
async fn every_door_runs_a_blueprint_into_one_change() {
    let (_server, state) = world().await;
    for caller in [
        session(with_role(steward())),
        mcp(with_role(steward())),
        run(with_role(steward()), &["jc_flow_start"]),
    ] {
        let change = doors::call(
            "jc_flow_start",
            &caller,
            &state,
            flow("threshold-alert", json!({ "title": "air" })),
        )
        .await;
        assert_eq!(StatusCode::OK, change.status, "{}", change.text());
        assert!(
            change.body["changeId"].as_str().is_some(),
            "{}",
            change.text()
        );
        assert_eq!("green", change.body["lane"], "{}", change.text());
    }
}

/// CC-59, R20: a blueprint whose roles the caller does not hold answers exactly like a name nobody
/// published: the same 404, naming no other blueprint.
#[tokio::test]
async fn a_blueprint_the_caller_may_not_run_is_not_there_like_an_unknown_one() {
    let (server, state) = world().await;
    let caller = mcp(with_role(steward()));
    let hidden = doors::call(
        "jc_flow_start",
        &caller,
        &state,
        flow("cross-city-sharing", json!({ "title": "air" })),
    )
    .await;
    let unknown = doors::call(
        "jc_flow_start",
        &caller,
        &state,
        flow("no-such-blueprint", json!({ "title": "air" })),
    )
    .await;
    assert_eq!(StatusCode::NOT_FOUND, hidden.status, "{}", hidden.text());
    assert_eq!(StatusCode::NOT_FOUND, unknown.status, "{}", unknown.text());
    for answer in [&hidden, &unknown] {
        assert!(
            !answer.text().contains("threshold-alert"),
            "{}",
            answer.text()
        );
    }
    // Without the realm role, the runnable blueprint is not there either.
    let roleless = doors::call(
        "jc_flow_start",
        &session(steward()),
        &state,
        flow("threshold-alert", json!({ "title": "air" })),
    )
    .await;
    assert_eq!(
        StatusCode::NOT_FOUND,
        roleless.status,
        "{}",
        roleless.text()
    );
    assert_eq!(0, forge_writes(&server).await);
}

/// CC-24, CC-26: parameters are validated before anything is drafted: every violation at once, and
/// a stale version is a conflict; neither reaches the forge.
#[tokio::test]
async fn parameters_and_version_are_checked_before_anything_is_drafted() {
    let (server, state) = world().await;
    let caller = session(with_role(steward()));
    let invalid = doors::call(
        "jc_flow_start",
        &caller,
        &state,
        flow("threshold-alert", json!({ "title": "Not A Slug!" })),
    )
    .await;
    assert_eq!(
        StatusCode::BAD_REQUEST,
        invalid.status,
        "{}",
        invalid.text()
    );
    assert!(
        invalid.body["errors"]
            .as_array()
            .is_some_and(|errors| !errors.is_empty()),
        "{}",
        invalid.text()
    );
    let missing = doors::call(
        "jc_flow_start",
        &caller,
        &state,
        flow("threshold-alert", json!({})),
    )
    .await;
    assert_eq!(
        StatusCode::BAD_REQUEST,
        missing.status,
        "{}",
        missing.text()
    );

    let stale = doors::call(
        "jc_flow_start",
        &caller,
        &state,
        json!({ "blueprint": "threshold-alert", "version": "1.1.0", "parameters": { "title": "air" } }),
    )
    .await;
    assert_eq!(StatusCode::CONFLICT, stale.status, "{}", stale.text());

    let unknown_field = doors::call(
        "jc_flow_start",
        &caller,
        &state,
        json!({ "blueprint": "threshold-alert", "version": "1.2.0", "parameters": {}, "lane": "green" }),
    )
    .await;
    assert_eq!(
        StatusCode::UNPROCESSABLE_ENTITY,
        unknown_field.status,
        "{}",
        unknown_field.text()
    );
    assert_eq!(
        0,
        forge_writes(&server).await,
        "a refused flow drafted something"
    );
}

/// MF-24: a blueprint that renders a literal secret is refused at the door, naming the field and
/// never the value.
#[tokio::test]
async fn a_blueprint_that_renders_a_secret_is_refused() {
    let (server, state) = world().await;
    let refused = doors::call(
        "jc_flow_start",
        &mcp(with_role(steward())),
        &state,
        flow("leaky-alert", json!({ "title": "air" })),
    )
    .await;
    assert_eq!(
        StatusCode::BAD_REQUEST,
        refused.status,
        "{}",
        refused.text()
    );
    assert!(refused.text().contains("apiKey"), "{}", refused.text());
    assert!(!refused.text().contains("sk-live"), "{}", refused.text());
    assert_eq!(0, forge_writes(&server).await);
}

/// PF-50, AG-70: holding the blueprint's role is not a binding: a viewer with the role, a person
/// with no binding and a run whose profile does not name the operation propose nothing.
#[tokio::test]
async fn the_role_on_the_card_is_not_a_binding_in_the_project() {
    let (server, state) = world().await;
    for (who, caller) in [
        ("viewer", session(with_role(viewer()))),
        ("viewer over mcp", mcp(with_role(viewer()))),
        ("stranger", session(with_role(stranger()))),
        (
            "run without it",
            run(with_role(steward()), &["jc_resource_list"]),
        ),
    ] {
        let refused = doors::call(
            "jc_flow_start",
            &caller,
            &state,
            flow("threshold-alert", json!({ "title": "air" })),
        )
        .await;
        assert_eq!(
            StatusCode::FORBIDDEN,
            refused.status,
            "{who}: {}",
            refused.text()
        );
    }
    assert_eq!(0, forge_writes(&server).await);
}

/// AG-64: the REST route and `POST …/ops/jc_flow_start` answer each person alike.
#[tokio::test]
async fn the_rest_route_and_the_ops_door_answer_alike() {
    let (_server, state) = world().await;
    for (identity, body) in [
        (
            with_role(viewer()),
            flow("threshold-alert", json!({ "title": "air" })),
        ),
        (
            with_role(steward()),
            flow("cross-city-sharing", json!({ "title": "air" })),
        ),
        (with_role(steward()), flow("threshold-alert", json!({}))),
        (
            with_role(stranger()),
            flow("threshold-alert", json!({ "title": "air" })),
        ),
    ] {
        let rest = doors::http(
            &state,
            identity.clone(),
            "POST",
            "/api/v1/projects/ovzdusie/flows",
            Some(body.clone()),
        )
        .await;
        let door = doors::post_op(&state, identity.clone(), "jc_flow_start", body).await;
        assert!(rest.status.is_client_error(), "{}", rest.text());
        assert_eq!(
            rest.status,
            door.status,
            "{}: {} vs {}",
            identity.username,
            rest.text(),
            door.text()
        );
    }
}

/// The App a blueprint renders is one address for the organization (AP-14a): a name another
/// project's App holds is refused at this door as at a hand-written one, before a branch exists.
#[tokio::test]
async fn a_blueprint_rendering_an_app_another_project_holds_is_refused() {
    const APP: &str = "apiVersion: joinedcontext.com/v1alpha1
kind: App
metadata:
  name: {{ title }}
spec:
  kind: static
  source:
    path: ./src
  build:
    node: \"22\"
  visibility: project
  dataNeeds: []
";
    let (server, state) = world().await;
    state.mirror.upsert(envelope(
        "Blueprint",
        "app-starter",
        ORG_NAMESPACE,
        blueprint("app", APP, json!([ROLE])),
    ));
    state.mirror.upsert(envelope(
        "Role",
        "app-role",
        ORG_NAMESPACE,
        json!({ "rules": [{ "kinds": ["App"], "verbs": ["read", "propose"] }] }),
    ));
    state.mirror.upsert(envelope(
        "RoleBinding",
        "app-binding",
        ORG_NAMESPACE,
        json!({
            "subjects": [{ "group": "city-stewards" }],
            "role": "app-role",
            "scope": { "project": PROJECT },
        }),
    ));
    state.mirror.upsert(envelope(
        "App",
        "board",
        "doprava",
        json!({ "kind": "static", "visibility": "public" }),
    ));

    let refused = doors::call(
        "jc_flow_start",
        &session(with_role(steward())),
        &state,
        flow("app-starter", json!({ "title": "board" })),
    )
    .await;
    assert_eq!(StatusCode::FORBIDDEN, refused.status, "{}", refused.text());
    assert!(refused.text().contains("AP-14a"), "{}", refused.text());
    assert_eq!(
        0,
        forge_writes(&server).await,
        "no branch for a refused name"
    );

    let free = doors::call(
        "jc_flow_start",
        &session(with_role(steward())),
        &state,
        flow("app-starter", json!({ "title": "board-2" })),
    )
    .await;
    assert_eq!(StatusCode::OK, free.status, "{}", free.text());
}
