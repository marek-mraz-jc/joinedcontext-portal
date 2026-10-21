//! A Pipeline proposes only on a green record check of the spec it proposes (T-4840, PF-57): the
//! workbench's validation step judges the sample's records where their write would be judged and
//! keeps the verdict; a dry run alone, a red check or a spec changed since is a 409 that says
//! which, through the REST door the editor proposes by.
mod common;

use std::collections::HashMap;
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::{envelope, person, send};
use joinedcontext_portal::auth::csrf::{CSRF_COOKIE, CSRF_HEADER};
use joinedcontext_portal::config::Config;
use joinedcontext_portal::permissions::ORG_NAMESPACE;
use joinedcontext_portal::pipeline_validation::ModelSchema;
use joinedcontext_portal::state::AppState;
use joinedcontext_portal::store::Mirror;
use serde_json::{json, Value};
use tower::ServiceExt;

const PROJECT: &str = "gate";

/// `dev` proposes pipelines, `jana` only reads them; the `bikes` space names its model and the
/// Endpoint `bikes-write` writes into it.
fn state() -> AppState {
    let mirror = Arc::new(Mirror::new());
    for (role, verbs, who) in [
        ("author", json!(["propose", "read"]), "dev"),
        ("reader", json!(["read"]), "jana"),
    ] {
        mirror.upsert(envelope(
            "Role",
            &format!("pipeline-{role}"),
            ORG_NAMESPACE,
            json!({ "rules": [{ "kinds": ["Pipeline", "DataSource"], "verbs": verbs }] }),
        ));
        mirror.upsert(envelope(
            "RoleBinding",
            &format!("{who}-{role}"),
            ORG_NAMESPACE,
            json!({
                "subjects": [{ "user": format!("{who}@hel.fi") }],
                "role": format!("pipeline-{role}"),
                "scope": { "project": PROJECT },
            }),
        ));
    }
    mirror.upsert(envelope(
        "ContextSpace",
        "bikes",
        PROJECT,
        json!({ "urnSegment": "bikes", "dataModelRef": { "kind": "DataModel", "name": "bikes" } }),
    ));
    mirror.upsert(envelope(
        "Endpoint",
        "bikes-write",
        PROJECT,
        json!({ "contextSpaceRef": "bikes", "slug": "k7r2m4xq9vbn3tdw6hcy5pajfe" }),
    ));
    mirror.upsert(envelope(
        "DataSource",
        "stations-csv",
        PROJECT,
        json!({ "type": "http", "http": { "url": "https://feeds.example/stations.csv" } }),
    ));
    let mut config = Config::for_tests();
    config.org_domain = Some("hel.fi".into());
    config.oidc = Config::from_vars(|key| {
        match key {
            "JC_OIDC_ISSUER" => Some(common::REALM.issuer.as_str()),
            "JC_OIDC_CLIENT_ID" => Some("portal-api"),
            "JC_OIDC_CLIENT_SECRET" => Some("secret"),
            _ => None,
        }
        .map(str::to_owned)
    })
    .expect("a realm")
    .oidc;
    let state = AppState::new(config, None).with_mirror(mirror);
    state.model_schemas.replace(HashMap::from([(
        (PROJECT.to_owned(), "bikes".to_owned()),
        Arc::new(ModelSchema::compile(
            "bikes",
            "1.2.0",
            &json!({ "definitions": { "BikeStation": {
                "properties": { "capacity": { "type": "integer" } }
            }}}),
            &["BikeStation".to_owned()],
            false,
        )),
    )]));
    state
}

fn pipeline(class: &str) -> Value {
    json!({
        "apiVersion": "joinedcontext.com/v1alpha2",
        "kind": "Pipeline",
        "metadata": { "name": "stations", "namespace": PROJECT },
        "spec": {
            "class": class,
            "sources": [{ "dataSourceRef": { "kind": "DataSource", "name": "stations-csv" } }],
            "outputs": [{ "targetEndpoint": "urn:ngsi-ld:Endpoint:hel.fi:bikes:bikes-write" }]
        }
    })
}

fn station(capacity: Value) -> Value {
    json!({ "id": "urn:ngsi-ld:BikeStation:01", "type": "BikeStation",
            "capacity": { "type": "Property", "value": capacity } })
}

async fn dry_run(state: &AppState, manifest: &Value) {
    let answer = send(
        state,
        person("dev"),
        "POST",
        &format!("/api/v1/projects/{PROJECT}/pipelines?dryRun=All"),
        Some(manifest.clone()),
    )
    .await;
    assert_eq!(answer.status, StatusCode::OK, "{}", answer.text);
    let body: Value = serde_json::from_str(&answer.text).expect("JSON");
    assert_eq!(body["verdict"]["ok"], true, "{}", answer.text);
}

async fn validate(state: &AppState, who: &str, manifest: &Value, records: Value) -> Value {
    let answer = send(
        state,
        person(who),
        "POST",
        &format!("/api/v1/projects/{PROJECT}/ops/jc_pipeline_validate"),
        Some(json!({ "pipeline": manifest, "records": records })),
    )
    .await;
    assert_eq!(answer.status, StatusCode::OK, "{}", answer.text);
    serde_json::from_str(&answer.text).expect("JSON")
}

/// The proposal's status and the gate's reason, when it refused.
async fn propose(state: &AppState, manifest: &Value) -> (StatusCode, Option<String>) {
    let answer = send(
        state,
        person("dev"),
        "POST",
        &format!("/api/v1/projects/{PROJECT}/pipelines"),
        Some(manifest.clone()),
    )
    .await;
    let reason = serde_json::from_str::<Value>(&answer.text)
        .ok()
        .and_then(|body| body["reason"].as_str().map(str::to_owned));
    (answer.status, reason)
}

#[tokio::test]
async fn a_pipeline_proposes_only_on_a_green_record_check_of_its_spec() {
    let state = state();
    let manifest = pipeline("resident");

    // A dry run alone checks the manifest, never a record of it.
    dry_run(&state, &manifest).await;
    assert_eq!(
        propose(&state, &manifest).await,
        (StatusCode::CONFLICT, Some("records_unchecked".into()))
    );

    // A sample record the model refuses: the check is red, and so is the proposal.
    let red = validate(&state, "dev", &manifest, json!([station(json!("many"))])).await;
    let finding = &red["verdicts"][0]["findings"][0];
    assert_eq!(
        (finding["source"].as_str(), finding["field"].as_str()),
        (Some("model"), Some("capacity"))
    );
    dry_run(&state, &manifest).await;
    assert_eq!(
        propose(&state, &manifest).await,
        (StatusCode::CONFLICT, Some("records_failed".into()))
    );

    // A green check, and the dry run after it, open the gate: the proposal reaches the forge,
    // which this Portal has none of.
    let green = validate(&state, "dev", &manifest, json!([station(json!(12))])).await;
    assert_eq!(green["verdicts"][0]["endpoint"], "bikes-write");
    dry_run(&state, &manifest).await;
    assert_eq!(
        propose(&state, &manifest).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );

    // The spec changed since its records were checked: stale, though its dry run is green.
    let changed = pipeline("auto");
    dry_run(&state, &changed).await;
    assert_eq!(
        propose(&state, &changed).await,
        (StatusCode::CONFLICT, Some("records_stale".into()))
    );
}

#[tokio::test]
async fn a_readers_check_opens_no_gate_and_the_route_wants_a_person() {
    let state = state();
    let manifest = pipeline("resident");
    let checked = validate(&state, "jana", &manifest, json!([station(json!(12))])).await;
    assert_eq!(checked["verdicts"][0]["ok"], true);
    dry_run(&state, &manifest).await;
    assert_eq!(
        propose(&state, &manifest).await,
        (StatusCode::CONFLICT, Some("records_unchecked".into())),
        "a reader's check is no verdict for the proposer"
    );

    let anonymous = joinedcontext_portal::server::app(state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/api/v1/projects/{PROJECT}/ops/jc_pipeline_validate"
                ))
                .header("content-type", "application/json")
                .header(CSRF_HEADER, common::CSRF)
                .header("cookie", format!("{CSRF_COOKIE}={}", common::CSRF))
                .body(Body::from(
                    json!({ "pipeline": manifest, "records": [station(json!(12))] }).to_string(),
                ))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);
    let stranger = send(
        &state,
        person("mikko"),
        "POST",
        &format!("/api/v1/projects/{PROJECT}/ops/jc_pipeline_validate"),
        Some(json!({ "pipeline": manifest, "records": [station(json!(12))] })),
    )
    .await;
    assert_eq!(stranger.status, StatusCode::FORBIDDEN, "{}", stranger.text);
}
