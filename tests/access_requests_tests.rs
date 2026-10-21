//! API/01 §47, PL-90…PL-93, T-4863: a pipeline asks another project's space for access, an owner
//! there approves it as a Change of their own project, and revokes it later. Runs when
//! `JC_PORTAL_TEST_DATABASE_URL` points at a PostgreSQL the test may write to; otherwise it says
//! so and returns.

mod common;

use std::sync::Arc;

use axum::http::StatusCode;
use serde_json::{json, Value};

use joinedcontext_portal::config::Config;
use joinedcontext_portal::git::GiteaClient;
use joinedcontext_portal::permissions::ORG_NAMESPACE;
use joinedcontext_portal::state::AppState;

const KPIS: &str = "city-kpis";
const HELSINKI: &str = "helsinki";

fn unique(base: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or_default();
    format!("{base}-{nanos:x}")
}

fn role(state: &AppState, name: &str, user: &str, project: &str, kinds: &[&str], verbs: &[&str]) {
    state.mirror.upsert(common::envelope(
        "Role",
        name,
        ORG_NAMESPACE,
        json!({ "rules": [{ "kinds": kinds, "verbs": verbs }] }),
    ));
    state.mirror.upsert(common::envelope(
        "RoleBinding",
        &format!("{name}-{user}"),
        ORG_NAMESPACE,
        json!({ "subjects": [{ "user": format!("{user}@hel.fi") }], "role": name, "scope": { "project": project } }),
    ));
}

/// `jana` stewards the KPI pipeline; `olli` owns Helsinki's air space; `eve` reads Helsinki only.
async fn state(pool: sqlx::PgPool, pipeline: &str, pipeline_identity: bool) -> AppState {
    world(pipeline, pipeline_identity).await.with_db(pool)
}

/// The same world without a database: the request form's list and the request door's refusals
/// answer before anything is stored.
async fn world(pipeline: &str, pipeline_identity: bool) -> AppState {
    let gitea = common::forge().await;
    let client = GiteaClient::new(
        gitea.uri().parse().expect("mock url"),
        "test-owner",
        "test-repo",
        "token-xyz",
    )
    .expect("client");
    std::mem::forget(gitea);
    let mut config = Config::for_tests();
    config.pipeline_identity = pipeline_identity;
    let state = AppState::new(config, None).with_gitea(Arc::new(client));
    for (project, space) in [(KPIS, "kpi"), (HELSINKI, "air")] {
        state.mirror.upsert(common::envelope(
            "Project",
            project,
            ORG_NAMESPACE,
            json!({}),
        ));
        state.mirror.upsert(common::envelope(
            "ContextSpace",
            space,
            project,
            json!({ "broker": "antares" }),
        ));
    }
    state.mirror.upsert(common::envelope(
        "Pipeline",
        pipeline,
        KPIS,
        json!({ "contextSpaceRef": "kpi", "class": "scheduled", "schedule": "*/15 * * * *" }),
    ));
    state.mirror.upsert(common::envelope(
        "Endpoint",
        "air-quality",
        HELSINKI,
        json!({ "contextSpaceRef": "air", "slug": "zt4qm7ge2xdv6ksb3ncf5arw2y", "audience": "project-list", "allowedProjects": ["traffic"] }),
    ));
    role(
        &state,
        "kpi-steward",
        "jana",
        KPIS,
        &["Pipeline"],
        &["read", "propose"],
    );
    let owner = ["ContextSpace", "Endpoint", "Policy", "Group"];
    let verbs = ["read", "propose", "approve"];
    role(&state, "air-owner", "olli", HELSINKI, &owner, &verbs);
    role(
        &state,
        "air-reader",
        "eve",
        HELSINKI,
        &["ContextSpace", "Endpoint"],
        &["read"],
    );
    state
}

async fn pool() -> Option<sqlx::PgPool> {
    let url = std::env::var("JC_PORTAL_TEST_DATABASE_URL")
        .ok()
        .filter(|u| !u.trim().is_empty());
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

fn ask() -> Value {
    json!({
        "endpoint": { "project": HELSINKI, "name": "air-quality" },
        "operations": "read",
        "types": [{ "type": "AirQualityObserved", "attrs": ["pm10", "pm25"] }],
        "until": "2099-01-31T23:59:59Z",
        "reason": "air index for the city dashboard",
    })
}

async fn send(
    state: &AppState,
    who: &str,
    verb: &str,
    uri: &str,
    body: Option<Value>,
) -> common::Answer {
    common::send(state, common::person(who), verb, uri, body).await
}

/// PL-90, PL-91, PL-93: request, approve as a Change of Helsinki, revoke; nothing is granted
/// before the approval and the requester never reads Helsinki's spaces through the request.
#[tokio::test]
async fn a_request_is_approved_in_the_owning_project_and_revoked_there() {
    let Some(pool) = pool().await else { return };
    let pipeline = unique("air");
    let state = state(pool, &pipeline, true).await;
    let filed = send(
        &state,
        "jana",
        "POST",
        &format!("/api/v1/projects/{KPIS}/pipelines/{pipeline}/access-requests"),
        Some(ask()),
    )
    .await;
    assert_eq!(filed.status, StatusCode::CREATED, "{}", filed.text);
    let request: Value = serde_json::from_str(&filed.text).expect("json");
    let id = request["id"].as_str().expect("an id").to_owned();
    assert_eq!(request["state"], "pending");
    assert_eq!(request["account"], format!("{KPIS}/pl-{pipeline}"));
    assert!(
        state
            .mirror
            .list(HELSINKI, "Policy", &Default::default())
            .items
            .is_empty(),
        "a request grants nothing on its own"
    );

    // The same pipeline asking again for the same Endpoint is the open request, not a second one.
    let again = send(
        &state,
        "jana",
        "POST",
        &format!("/api/v1/projects/{KPIS}/pipelines/{pipeline}/access-requests"),
        Some(ask()),
    )
    .await;
    assert_eq!(again.status, StatusCode::CONFLICT, "{}", again.text);

    // A reader of Helsinki who owns no space there sees no request and decides none.
    let inbox = send(
        &state,
        "eve",
        "GET",
        &format!("/api/v1/projects/{HELSINKI}/access-requests"),
        None,
    )
    .await;
    assert_eq!(inbox.status, StatusCode::OK, "{}", inbox.text);
    assert!(!inbox.text.contains(&id), "{}", inbox.text);
    let refused = send(
        &state,
        "eve",
        "POST",
        &format!("/api/v1/projects/{HELSINKI}/access-requests/{id}/approve"),
        None,
    )
    .await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN, "{}", refused.text);
    // The requester cannot open Helsinki's inbox at all.
    let theirs = send(
        &state,
        "jana",
        "GET",
        &format!("/api/v1/projects/{HELSINKI}/access-requests"),
        None,
    )
    .await;
    assert_eq!(theirs.status, StatusCode::NOT_FOUND, "{}", theirs.text);

    let inbox = send(
        &state,
        "olli",
        "GET",
        &format!("/api/v1/projects/{HELSINKI}/access-requests"),
        None,
    )
    .await;
    assert!(inbox.text.contains(&id), "{}", inbox.text);
    let approved = send(
        &state,
        "olli",
        "POST",
        &format!("/api/v1/projects/{HELSINKI}/access-requests/{id}/approve"),
        None,
    )
    .await;
    assert_eq!(approved.status, StatusCode::ACCEPTED, "{}", approved.text);
    let change: Value = serde_json::from_str(&approved.text).expect("json");
    assert_eq!(change["kind"], "Change", "{}", approved.text);

    let mine = send(
        &state,
        "jana",
        "GET",
        &format!("/api/v1/projects/{KPIS}/pipelines/{pipeline}/access-requests"),
        None,
    )
    .await;
    let mine: Value = serde_json::from_str(&mine.text).expect("json");
    assert_eq!(mine["items"][0]["state"], "approved");
    assert_eq!(mine["items"][0]["decidedBy"], "olli");
    assert_eq!(mine["items"][0]["change"], change["metadata"]["name"]);

    // The grant merged: the revoke ends it now.
    let request: joinedcontext_portal::access_requests::AccessRequest =
        joinedcontext_portal::access_requests::get(state.db.as_ref().expect("db"), HELSINKI, &id)
            .await
            .expect("read")
            .expect("there");
    let endpoint =
        json!({ "spec": { "audience": "project-list", "allowedProjects": ["traffic"] } });
    let policy =
        joinedcontext_portal::access_requests::grant_bundle(&request, &endpoint)[1].clone();
    state
        .mirror
        .upsert(serde_json::from_value(policy).expect("an envelope"));
    let no_reason = send(
        &state,
        "olli",
        "POST",
        &format!("/api/v1/projects/{HELSINKI}/access-requests/{id}/revoke"),
        Some(json!({ "reason": " " })),
    )
    .await;
    assert_eq!(
        no_reason.status,
        StatusCode::BAD_REQUEST,
        "{}",
        no_reason.text
    );
    let revoked = send(
        &state,
        "olli",
        "POST",
        &format!("/api/v1/projects/{HELSINKI}/access-requests/{id}/revoke"),
        Some(json!({ "reason": "the index moved to another source" })),
    )
    .await;
    assert_eq!(revoked.status, StatusCode::ACCEPTED, "{}", revoked.text);
    let mine = send(
        &state,
        "jana",
        "GET",
        &format!("/api/v1/projects/{KPIS}/pipelines/{pipeline}/access-requests"),
        None,
    )
    .await;
    assert!(
        mine.text.contains("\"revoked\"") && mine.text.contains("the index moved"),
        "{}",
        mine.text
    );
}

/// PL-91: the requester never approves their own request, even holding the owner's rights.
#[tokio::test]
async fn the_requester_does_not_approve_their_own_request() {
    let Some(pool) = pool().await else { return };
    let pipeline = unique("self");
    let state = state(pool, &pipeline, true).await;
    role(
        &state,
        "air-owner-too",
        "jana",
        HELSINKI,
        &["ContextSpace", "Endpoint", "Policy", "Group"],
        &["read", "propose", "approve"],
    );
    let filed = send(
        &state,
        "jana",
        "POST",
        &format!("/api/v1/projects/{KPIS}/pipelines/{pipeline}/access-requests"),
        Some(ask()),
    )
    .await;
    assert_eq!(filed.status, StatusCode::CREATED, "{}", filed.text);
    let id = serde_json::from_str::<Value>(&filed.text).expect("json")["id"]
        .as_str()
        .expect("id")
        .to_owned();
    let own = send(
        &state,
        "jana",
        "POST",
        &format!("/api/v1/projects/{HELSINKI}/access-requests/{id}/approve"),
        None,
    )
    .await;
    assert_eq!(own.status, StatusCode::FORBIDDEN, "{}", own.text);
    assert!(own.text.contains("self-approval"), "{}", own.text);
    let declined = send(
        &state,
        "olli",
        "POST",
        &format!("/api/v1/projects/{HELSINKI}/access-requests/{id}/decline"),
        Some(json!({ "reason": "use the open endpoint" })),
    )
    .await;
    assert_eq!(declined.status, StatusCode::OK, "{}", declined.text);
    let late = send(
        &state,
        "olli",
        "POST",
        &format!("/api/v1/projects/{HELSINKI}/access-requests/{id}/approve"),
        None,
    )
    .await;
    assert_eq!(late.status, StatusCode::CONFLICT, "{}", late.text);
}

/// PL-90: who may not propose the pipeline asks nothing; a wildcard, a shared account or an
/// unknown endpoint is refused before anything is stored.
#[tokio::test]
async fn a_request_is_refused_before_it_is_stored() {
    let Some(pool) = pool().await else { return };
    let pipeline = unique("bad");
    let state = state(pool.clone(), &pipeline, true).await;
    let uri = format!("/api/v1/projects/{KPIS}/pipelines/{pipeline}/access-requests");
    assert_eq!(
        send(&state, "eve", "POST", &uri, Some(ask())).await.status,
        StatusCode::NOT_FOUND
    );
    role(&state, "kpi-reader", "rita", KPIS, &["Pipeline"], &["read"]);
    assert_eq!(
        send(&state, "rita", "POST", &uri, Some(ask())).await.status,
        StatusCode::FORBIDDEN
    );
    let mut wildcard = ask();
    wildcard["types"][0]["attrs"] = json!(["*"]);
    assert_eq!(
        send(&state, "jana", "POST", &uri, Some(wildcard))
            .await
            .status,
        StatusCode::BAD_REQUEST
    );
    let mut all = ask();
    all["types"][0]["attrs"] = json!([]);
    assert_eq!(
        send(&state, "jana", "POST", &uri, Some(all)).await.status,
        StatusCode::BAD_REQUEST
    );
    let mut nowhere = ask();
    nowhere["endpoint"]["name"] = json!("not-there");
    assert_eq!(
        send(&state, "jana", "POST", &uri, Some(nowhere))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    let shared = state_shared(pool, &pipeline).await;
    let answer = send(&shared, "jana", "POST", &uri, Some(ask())).await;
    assert_eq!(answer.status, StatusCode::CONFLICT, "{}", answer.text);
    assert!(
        answer.text.contains("JC_PORTAL_PIPELINE_IDENTITY"),
        "{}",
        answer.text
    );
    let mine = send(&state, "jana", "GET", &uri, None).await;
    assert_eq!(
        serde_json::from_str::<Value>(&mine.text).expect("json")["items"],
        json!([]),
        "nothing was stored"
    );
}

async fn state_shared(pool: sqlx::PgPool, pipeline: &str) -> AppState {
    state(pool, pipeline, false).await
}

/// Helsinki's `air` space compiles a model whose AirQualityObserved has `pm10` and `pm25`, and
/// the KPI project has an Endpoint on the pipeline's own space.
fn modelled(state: &AppState) {
    use joinedcontext_portal::pipeline_validation::ModelSchema;
    state
        .model_schemas
        .replace(std::collections::HashMap::from([(
            (HELSINKI.to_owned(), "air".to_owned()),
            Arc::new(ModelSchema::compile(
                "air",
                "1.0.0",
                &json!({ "definitions": { "AirQualityObserved": { "properties": {
                    "pm10": { "type": "number", "x-ngsi-ld-kind": "Property" },
                    "pm25": { "type": "number", "x-ngsi-ld-kind": "Property" }
                }}}}),
                &["AirQualityObserved".to_owned()],
                false,
            )),
        )]));
    state.mirror.upsert(common::envelope(
        "Endpoint",
        "kpi-out",
        KPIS,
        json!({ "contextSpaceRef": "kpi", "slug": "q8m2d7x4k9w3n6p5r1t0v2b7cz", "audience": "project-list" }),
    ));
}

/// T-4946: the request form lists the Endpoints of other spaces with their model's types and
/// attributes, never the pipeline's own space, and only to a person who may propose the pipeline.
#[tokio::test]
async fn the_form_lists_endpoints_of_other_spaces_with_their_types() {
    let pipeline = unique("air");
    let state = world(&pipeline, true).await;
    modelled(&state);
    let uri = format!("/api/v1/projects/{KPIS}/pipelines/{pipeline}/access-requests/endpoints");
    let listed = send(&state, "jana", "GET", &uri, None).await;
    assert_eq!(listed.status, StatusCode::OK, "{}", listed.text);
    let body: Value = serde_json::from_str(&listed.text).expect("json");
    let items = body["items"].as_array().expect("items");
    assert_eq!(items.len(), 1, "{}", listed.text);
    assert_eq!(items[0]["project"], HELSINKI);
    assert_eq!(items[0]["name"], "air-quality");
    assert_eq!(items[0]["types"][0]["type"], "AirQualityObserved");
    assert_eq!(items[0]["types"][0]["attrs"], json!(["pm10", "pm25"]));
    assert!(!listed.text.contains("kpi-out"), "{}", listed.text);

    // Eve may not propose the pipeline: she learns nothing of it, nor of the Endpoints.
    let refused = send(&state, "eve", "GET", &uri, None).await;
    assert_eq!(refused.status, StatusCode::NOT_FOUND, "{}", refused.text);
}

/// T-4946: the request door applies the list's rule to every submitted value: a type or an
/// attribute the Endpoint does not serve is refused naming the field, the pipeline's own space and
/// an Endpoint of a project that does not exist answer the same not found, and an allowed request
/// passes every check (here it reaches the missing store).
#[tokio::test]
async fn the_door_refuses_what_the_form_would_not_offer() {
    let pipeline = unique("air");
    let state = world(&pipeline, true).await;
    modelled(&state);
    let uri = format!("/api/v1/projects/{KPIS}/pipelines/{pipeline}/access-requests");
    let with = |endpoint: Value, types: Value| {
        let mut body = ask();
        body["endpoint"] = endpoint;
        body["types"] = types;
        Some(body)
    };
    let air = json!({ "project": HELSINKI, "name": "air-quality" });

    let allowed = send(&state, "jana", "POST", &uri, Some(ask())).await;
    assert_eq!(
        allowed.status,
        StatusCode::SERVICE_UNAVAILABLE,
        "{}",
        allowed.text
    );

    let no_type = with(
        air.clone(),
        json!([{ "type": "WeatherObserved", "attrs": ["pm10"] }]),
    );
    let refused = send(&state, "jana", "POST", &uri, no_type).await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.text);
    assert!(refused.text.contains("types[0].type"), "{}", refused.text);

    let no_attr = with(
        air,
        json!([{ "type": "AirQualityObserved", "attrs": ["pm10", "secret"] }]),
    );
    let refused = send(&state, "jana", "POST", &uri, no_attr).await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.text);
    assert!(
        refused.text.contains("types[0].attrs: 'secret'"),
        "{}",
        refused.text
    );

    let types = json!([{ "type": "AirQualityObserved", "attrs": ["pm10"] }]);
    let own = with(json!({ "project": KPIS, "name": "kpi-out" }), types.clone());
    let own = send(&state, "jana", "POST", &uri, own).await;
    let elsewhere = with(
        json!({ "project": "other-org-city", "name": "air-quality" }),
        types,
    );
    let elsewhere = send(&state, "jana", "POST", &uri, elsewhere).await;
    for answer in [&own, &elsewhere] {
        assert_eq!(answer.status, StatusCode::NOT_FOUND, "{}", answer.text);
        assert!(answer.text.contains("endpoint.name"), "{}", answer.text);
    }
}
