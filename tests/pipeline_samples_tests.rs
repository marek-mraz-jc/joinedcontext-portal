//! The last messages through each step of a pipeline are read with read on the pipeline and by
//! nobody else (T-3974): a caller without it, or of another project, is told the pipeline is not
//! there, and a sample carries nothing its target Endpoint hides and no secret in the clear.

mod common;

use axum::http::StatusCode;
use serde_json::{json, Value};

use common::{envelope, person, send};
use joinedcontext_portal::permissions::ORG_NAMESPACE;
use joinedcontext_portal::pipeline_samples::KEPT;
use joinedcontext_portal::state::AppState;

const SAMPLES: &str = "/api/v1/projects/helsinki/pipelines/stations/samples";

async fn world() -> AppState {
    let state = common::state_on_forge().await;
    state.mirror.upsert(envelope(
        "Role",
        "pipeline-reader",
        ORG_NAMESPACE,
        json!({ "rules": [{ "kinds": ["Pipeline"], "verbs": ["read"] }] }),
    ));
    state.mirror.upsert(envelope(
        "RoleBinding",
        "jana-pipeline-reader",
        ORG_NAMESPACE,
        json!({
            "subjects": [{ "user": "jana@hel.fi" }],
            "role": "pipeline-reader",
            "scope": { "project": "helsinki" },
        }),
    ));
    state.mirror.upsert(envelope(
        "Endpoint",
        "bikes",
        "helsinki",
        json!({ "projection": { "hiddenAttributes": ["owner"] } }),
    ));
    state.mirror.upsert(envelope(
        "Pipeline",
        "stations",
        "helsinki",
        json!({ "class": "resident", "targetEndpoint": "urn:ngsi-ld:Endpoint:hel.fi:helsinki:bikes" }),
    ));
    for n in 0..(KEPT + 5) {
        state.pipeline_samples.push(
            "helsinki",
            "stations",
            "input",
            json!({ "n": n, "owner": "Jana", "password": "hunter2hunter2" }),
        );
    }
    // The same pipeline name in another project keeps its own samples.
    state
        .pipeline_samples
        .push("praha", "stations", "input", json!({ "n": -1 }));
    state
}

#[tokio::test]
async fn a_reader_sees_the_newest_samples_without_what_the_target_hides() {
    let state = world().await;
    let answer = send(&state, person("jana"), "GET", SAMPLES, None).await;
    assert_eq!(answer.status, StatusCode::OK, "{}", answer.text);
    let body: Value = serde_json::from_str(&answer.text).expect("json");
    let input = body["nodes"]["input"].as_array().expect("input");
    assert_eq!(input.len(), KEPT, "only the newest are kept");
    assert_eq!(input[0]["record"]["n"], KEPT + 4, "newest first");
    for sample in input {
        assert!(sample["record"].get("owner").is_none(), "{sample}");
        assert_ne!(sample["record"]["password"], "hunter2hunter2", "{sample}");
    }
}

#[tokio::test]
async fn a_caller_without_read_on_the_pipeline_is_told_it_is_not_there() {
    let state = world().await;
    let refused = send(&state, person("mikko"), "GET", SAMPLES, None).await;
    assert_eq!(refused.status, StatusCode::NOT_FOUND, "{}", refused.text);
    let other = send(
        &state,
        person("jana"),
        "GET",
        "/api/v1/projects/praha/pipelines/stations/samples",
        None,
    )
    .await;
    assert_eq!(other.status, StatusCode::NOT_FOUND, "{}", other.text);
}
