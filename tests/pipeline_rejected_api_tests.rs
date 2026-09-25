//! A pipeline's rejected list is read with read on the pipeline and by nobody else (PL-61,
//! ADR-N-034, T-2708): a caller without it is told the pipeline is not there, and a page is the
//! newest records first, with the rule each broke and its secrets masked. A retry needs propose
//! on the pipeline, replays only what carries no mask and hands it to the runner through the
//! space's validation stage and the pipeline's own write. Its runs and each run's log are read
//! the same way as the list (PL-62).

mod common;

use std::collections::HashMap;
use std::sync::Arc;

use axum::http::StatusCode;
use serde_json::{json, Value};
use wiremock::matchers::{method, path_regex};
use wiremock::{Mock, MockServer, ResponseTemplate};

use common::{envelope, forge, person, send};
use joinedcontext_portal::config::Config;
use joinedcontext_portal::permissions::ORG_NAMESPACE;
use joinedcontext_portal::pipeline_outcomes::Reason;
use joinedcontext_portal::pipeline_validation::ModelSchema;
use joinedcontext_portal::state::AppState;

const REJECTED: &str = "/api/v1/projects/helsinki/pipelines/stations/rejected";
const RUNS: &str = "/api/v1/projects/helsinki/pipelines/stations/runs";
const RETRY: &str = "/api/v1/projects/helsinki/pipelines/stations/rejected/retry";

async fn world() -> AppState {
    let gitea = forge().await;
    let state = common::state_on(&gitea);
    seed(&state).await;
    state
}

async fn seed(state: &AppState) {
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
        "Pipeline",
        "stations",
        "helsinki",
        json!({ "class": "resident", "targetEndpoint": "urn:ngsi-ld:Endpoint:hel.fi:helsinki:bikes" }),
    ));
    for n in 0..3 {
        state
            .rejected
            .reject(
                "helsinki",
                "stations",
                &json!({ "n": n, "password": "hunter2hunter2" }),
                &Reason {
                    rule: "sh:datatype".into(),
                    path: "capacity".into(),
                    message: "capacity is not of the slot's datatype".into(),
                    step: None,
                },
            )
            .await
            .expect("kept");
    }
}

#[tokio::test]
async fn a_reader_of_the_pipeline_pages_through_its_rejected_records() {
    let state = world().await;
    let page = send(
        &state,
        person("jana"),
        "GET",
        &format!("{REJECTED}?limit=2"),
        None,
    )
    .await;
    assert_eq!(page.status, StatusCode::OK, "{}", page.text);
    let page: Value = serde_json::from_str(&page.text).expect("json");
    assert_eq!(page["total"], 3);
    assert_eq!(page["items"].as_array().map(Vec::len), Some(2));
    assert_eq!(page["items"][0]["record"]["n"], 2, "newest first");
    assert_eq!(page["items"][0]["rule"], "sh:datatype");
    assert_eq!(page["items"][0]["path"], "capacity");
    assert!(!page.to_string().contains("hunter2"), "masked: {page}");

    let next = page["next"].as_i64().expect("a next page");
    let rest = send(
        &state,
        person("jana"),
        "GET",
        &format!("{REJECTED}?limit=2&before={next}"),
        None,
    )
    .await;
    let rest: Value = serde_json::from_str(&rest.text).expect("json");
    assert_eq!(rest["items"].as_array().map(Vec::len), Some(1));
    assert!(rest.get("next").is_none(), "{rest}");
}

#[tokio::test]
async fn a_caller_without_read_on_the_pipeline_is_told_it_is_not_there() {
    let state = world().await;
    let refused = send(&state, person("mikko"), "GET", REJECTED, None).await;
    assert_eq!(refused.status, StatusCode::NOT_FOUND, "{}", refused.text);
    assert!(!refused.text.contains("sh:datatype"));

    let missing = send(
        &state,
        person("jana"),
        "GET",
        "/api/v1/projects/helsinki/pipelines/nobody/rejected",
        None,
    )
    .await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND);
}

/// A state whose pipeline writes through an Endpoint into a space with a compiled model, and a
/// runner at `runner`; `jana` reads pipelines, `eeva` also proposes them.
async fn retry_world(runner: &MockServer) -> AppState {
    let mut config = Config::for_tests();
    config.pipeline_runner_url = Some(format!("{}/{{project}}", runner.uri()));
    config.pipeline_test_capture_url = Some("http://portal-internal:9090".into());
    let state = AppState::new(config, None);
    seed(&state).await;
    state.mirror.upsert(envelope(
        "Role",
        "pipeline-author",
        ORG_NAMESPACE,
        json!({ "rules": [{ "kinds": ["Pipeline"], "verbs": ["read", "propose"] }] }),
    ));
    state.mirror.upsert(envelope(
        "RoleBinding",
        "eeva-pipeline-author",
        ORG_NAMESPACE,
        json!({
            "subjects": [{ "user": "eeva@hel.fi" }],
            "role": "pipeline-author",
            "scope": { "project": "helsinki" },
        }),
    ));
    state.mirror.upsert(envelope(
        "ContextSpace",
        "helsinki",
        "helsinki",
        json!({ "urnSegment": "helsinki", "dataModelRef": { "kind": "DataModel", "name": "bikes" } }),
    ));
    state.mirror.upsert(envelope(
        "Endpoint",
        "bikes",
        "helsinki",
        json!({ "contextSpaceRef": "helsinki", "slug": "k7r2m4xq9vbn3tdw6hcy5pajfe" }),
    ));
    state.mirror.upsert(envelope(
        "Pipeline",
        "stations",
        "helsinki",
        json!({
            "class": "resident",
            "source": { "dataSourceRef": { "kind": "DataSource", "name": "feed" } },
            "targetEndpoint": "urn:ngsi-ld:Endpoint:hel.fi:helsinki:bikes"
        }),
    ));
    state.model_schemas.replace(HashMap::from([(
        ("helsinki".to_owned(), "helsinki".to_owned()),
        Arc::new(ModelSchema::compile(
            "bikes",
            "1.0.0",
            &json!({ "definitions": { "BikeStation": {
                "properties": { "id": { "type": "string" }, "capacity": { "type": "integer" } }
            }}}),
            &["BikeStation".to_owned()],
            false,
        )),
    )]));
    // One record the author fixed at the source: nothing in it was masked.
    state
        .rejected
        .reject(
            "helsinki",
            "stations",
            &json!({ "id": "urn:ngsi-ld:BikeStation:hel.fi:helsinki:s-9", "type": "BikeStation" }),
            &Reason {
                rule: "type".into(),
                path: String::new(),
                message: "BikeStation was not a class of the model".into(),
                step: None,
            },
        )
        .await
        .expect("kept");
    state
}

async fn ids(state: &AppState) -> Vec<i64> {
    state
        .rejected
        .list("helsinki", "stations", 10, None)
        .await
        .expect("the list")
        .iter()
        .map(|record| record.id)
        .collect()
}

#[tokio::test]
async fn a_retry_replays_the_unmasked_records_through_the_stage_and_keeps_the_masked() {
    let runner = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path_regex(r"^/helsinki/streams/rejected-replay-[a-z0-9]+$"))
        .respond_with(ResponseTemplate::new(200))
        .expect(1)
        .mount(&runner)
        .await;
    let state = retry_world(&runner).await;
    let all = ids(&state).await;
    let (clean, masked) = (all[0], all[1]);

    let answer = send(
        &state,
        person("eeva"),
        "POST",
        RETRY,
        Some(json!({ "ids": [clean, masked] })),
    )
    .await;
    assert_eq!(answer.status, StatusCode::ACCEPTED, "{}", answer.text);
    let answer: Value = serde_json::from_str(&answer.text).expect("json");
    assert_eq!(answer, json!({ "replayed": 1, "masked": [masked] }));

    let left = ids(&state).await;
    assert!(!left.contains(&clean), "the replayed record left the list");
    assert!(left.contains(&masked), "the masked record stays");

    let sent = runner.received_requests().await.expect("recorded");
    let stream: Value = serde_json::from_slice(&sent[0].body).expect("a stream config");
    let text = stream.to_string();
    assert!(text.contains("json_schema"), "the stage is in: {text}");
    assert!(!text.contains("[MASKED]"), "no mask is replayed");
    assert!(
        text.contains("k7r2m4xq9vbn3tdw6hcy5pajfe"),
        "the pipeline's own write"
    );
}

#[tokio::test]
async fn a_reader_may_not_retry_and_a_runner_that_refuses_puts_the_records_back() {
    let runner = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&runner)
        .await;
    let state = retry_world(&runner).await;
    let clean = ids(&state).await[0];

    let reader = send(
        &state,
        person("jana"),
        "POST",
        RETRY,
        Some(json!({ "ids": [clean] })),
    )
    .await;
    assert_eq!(reader.status, StatusCode::FORBIDDEN, "{}", reader.text);
    let stranger = send(
        &state,
        person("mikko"),
        "POST",
        RETRY,
        Some(json!({ "ids": [clean] })),
    )
    .await;
    assert_eq!(stranger.status, StatusCode::NOT_FOUND, "{}", stranger.text);
    for ids in [json!([]), json!((0..101).collect::<Vec<i64>>())] {
        let bad = send(
            &state,
            person("eeva"),
            "POST",
            RETRY,
            Some(json!({ "ids": ids })),
        )
        .await;
        assert_eq!(bad.status, StatusCode::BAD_REQUEST, "{}", bad.text);
    }
    assert!(runner
        .received_requests()
        .await
        .expect("recorded")
        .is_empty());

    let refused = send(
        &state,
        person("eeva"),
        "POST",
        RETRY,
        Some(json!({ "ids": [clean] })),
    )
    .await;
    assert_eq!(
        refused.status,
        StatusCode::SERVICE_UNAVAILABLE,
        "{}",
        refused.text
    );
    let back = state
        .rejected
        .list("helsinki", "stations", 1, None)
        .await
        .expect("the list");
    assert_eq!(
        back[0].record["id"],
        "urn:ngsi-ld:BikeStation:hel.fi:helsinki:s-9"
    );
    assert_eq!(back[0].rule, "runner");
    assert_eq!(
        state
            .rejected
            .count("helsinki", "stations")
            .await
            .expect("count"),
        4
    );
}

#[tokio::test]
async fn a_reader_lists_the_runs_and_reads_one_runs_log_of_this_pipeline_only() {
    use joinedcontext_portal::pipeline_log::{NewLine, Outcome};
    let state = world().await;
    state.mirror.upsert(envelope(
        "Pipeline",
        "other",
        "helsinki",
        json!({ "class": "resident", "targetEndpoint": "urn:ngsi-ld:Endpoint:hel.fi:helsinki:bikes" }),
    ));
    let line = |id: &str, outcome| NewLine {
        record_id: id.into(),
        step: None,
        outcome,
        message: String::new(),
    };
    let run = "2026-09-25T08:00:00Z";
    let lines: Vec<NewLine> = (0..3)
        .map(|n| line(&format!("urn:s-{n}"), Outcome::Sent))
        .chain([line("urn:s-9", Outcome::Rejected)])
        .collect();
    state
        .pipeline_log
        .append("helsinki", "stations", run, &lines)
        .await
        .expect("kept");
    state
        .pipeline_log
        .append(
            "helsinki",
            "other",
            run,
            &[line("urn:other", Outcome::Sent)],
        )
        .await
        .expect("kept");

    let runs = send(&state, person("jana"), "GET", RUNS, None).await;
    assert_eq!(runs.status, StatusCode::OK, "{}", runs.text);
    let runs: Value = serde_json::from_str(&runs.text).expect("json");
    assert_eq!(runs["items"][0]["run"], run);
    assert_eq!(runs["items"][0]["sent"], 3);
    assert_eq!(runs["items"][0]["rejected"], 1);

    let page = send(
        &state,
        person("jana"),
        "GET",
        &format!("{RUNS}/{run}/log?limit=3"),
        None,
    )
    .await;
    assert_eq!(page.status, StatusCode::OK, "{}", page.text);
    let page: Value = serde_json::from_str(&page.text).expect("json");
    assert_eq!(page["items"][0]["recordId"], "urn:s-9", "newest first");
    assert_eq!(page["items"][0]["outcome"], "rejected");
    assert!(!page.to_string().contains("urn:other"), "{page}");
    let next = page["next"].as_i64().expect("a next page");
    let rest = send(
        &state,
        person("jana"),
        "GET",
        &format!("{RUNS}/{run}/log?limit=3&before={next}"),
        None,
    )
    .await;
    let rest: Value = serde_json::from_str(&rest.text).expect("json");
    assert_eq!(rest["items"].as_array().map(Vec::len), Some(1));

    for path in [RUNS.to_owned(), format!("{RUNS}/{run}/log")] {
        let refused = send(&state, person("mikko"), "GET", &path, None).await;
        assert_eq!(
            refused.status,
            StatusCode::NOT_FOUND,
            "{path}: {}",
            refused.text
        );
        assert!(!refused.text.contains("urn:s-"));
    }
}
