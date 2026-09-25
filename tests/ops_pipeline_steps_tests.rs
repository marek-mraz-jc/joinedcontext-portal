//! The workbench's steps as operations (T-2711, ADR-N-034 §3.5, PL-63): the sample of a source,
//! the mapping tried on it and the records checked against the target space's model, each through
//! `POST /api/v1/projects/{project}/ops/{name}`, the door the workbench, MCP and the assistant
//! share. The mapping step answers what the pipeline test answers for the same input; sampling and
//! trying need propose on Pipeline, validating needs read, and nobody else is let through.
mod common;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::{envelope, person, send};
use joinedcontext_portal::config::Config;
use joinedcontext_portal::permissions::ORG_NAMESPACE;
use joinedcontext_portal::pipeline_validation::ModelSchema;
use joinedcontext_portal::server;
use joinedcontext_portal::state::AppState;
use joinedcontext_portal::store::Mirror;
use serde_json::{json, Value};
use tower::ServiceExt;
use wiremock::matchers::{method, path_regex};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn op(project: &str, name: &str) -> String {
    format!("/api/v1/projects/{project}/ops/{name}")
}

/// `dev` proposes pipelines, `jana` reads them, `mikko` holds nothing; `project` has one space
/// that names its model, an Endpoint into it and two DataSources.
fn mirror(project: &str) -> Arc<Mirror> {
    let mirror = Arc::new(Mirror::new());
    for (role, verb, who) in [("author", "propose", "dev"), ("reader", "read", "jana")] {
        mirror.upsert(envelope(
            "Role",
            &format!("pipeline-{role}"),
            ORG_NAMESPACE,
            json!({ "rules": [{ "kinds": ["Pipeline", "DataSource"], "verbs": [verb] }] }),
        ));
        mirror.upsert(envelope(
            "RoleBinding",
            &format!("{who}-{role}"),
            ORG_NAMESPACE,
            json!({
                "subjects": [{ "user": format!("{who}@hel.fi") }],
                "role": format!("pipeline-{role}"),
                "scope": { "project": project },
            }),
        ));
    }
    mirror.upsert(envelope(
        "ContextSpace",
        "bikes",
        project,
        json!({ "urnSegment": "bikes", "dataModelRef": { "kind": "DataModel", "name": "bikes" } }),
    ));
    mirror.upsert(envelope(
        "ContextSpace",
        "loose",
        project,
        json!({ "urnSegment": "loose" }),
    ));
    mirror.upsert(envelope(
        "Endpoint",
        "bikes-write",
        project,
        json!({ "contextSpaceRef": "bikes", "slug": "k7r2m4xq9vbn3tdw6hcy5pajfe" }),
    ));
    mirror.upsert(envelope(
        "DataSource",
        "stations-csv",
        project,
        json!({ "type": "http", "http": { "url": "https://feeds.example/stations.csv?day=1" } }),
    ));
    mirror.upsert(envelope(
        "DataSource",
        "locked",
        project,
        json!({ "type": "http", "http": {
            "url": "https://feeds.example/locked.json",
            "authorization": { "headerRef": { "name": "feed-key", "key": "token" } }
        } }),
    ));
    mirror.upsert(envelope(
        "DataSource",
        "broker",
        project,
        json!({ "type": "mqtt", "mqtt": { "urls": ["tcp://broker:1883"], "topics": ["t"] } }),
    ));
    mirror
}

fn config(runner: Option<&MockServer>) -> Config {
    let mut config = Config::for_tests();
    config.org_domain = Some("hel.fi".into());
    config.pipeline_runner_url = runner.map(|r| format!("{}/{{project}}", r.uri()));
    config.pipeline_test_capture_url = Some("http://portal-internal:9090".into());
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
    config.pipeline_runner_client_id = Some(common::PIPELINE_RUNNER_CLIENT.into());
    config
}

/// A Portal of `project`, its runner mocked when given, the `bikes` space's model compiled.
fn state(project: &str, runner: Option<&MockServer>) -> AppState {
    let state = AppState::new(config(runner), None).with_mirror(mirror(project));
    state.model_schemas.replace(HashMap::from([(
        (project.to_owned(), "bikes".to_owned()),
        Arc::new(ModelSchema::compile(
            "bikes",
            "1.2.0",
            &json!({ "definitions": { "BikeStation": {
                "properties": { "id": { "type": "string" }, "capacity": { "type": "integer" } }
            }}}),
            &["BikeStation".to_owned()],
            false,
        )),
    )]));
    state
}

async fn runner() -> MockServer {
    let runner = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path_regex(r"^/[a-z-]+/streams/pipeline-test-[a-z2-7]{26}$"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&runner)
        .await;
    Mock::given(method("DELETE"))
        .and(path_regex(r"^/[a-z-]+/streams/pipeline-test-[a-z2-7]{26}$"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&runner)
        .await;
    runner
}

/// The runner's side of the `nth` harness it receives: answers `messages` on its capture route.
async fn play_runner(
    runner: &MockServer,
    state: &AppState,
    nth: usize,
    messages: &[Value],
) -> Value {
    for _ in 0..200 {
        let received = runner.received_requests().await.unwrap_or_default();
        if let Some(create) = received.iter().filter(|r| r.method == "POST").nth(nth) {
            let harness: Value = serde_json::from_slice(&create.body).expect("a JSON harness");
            let capture = harness["output"]["http_client"]["url"]
                .as_str()
                .expect("the capture url");
            let path = &capture[capture.find("/internal/").expect("internal path")..];
            for message in messages {
                let status = server::internal_app(state.clone())
                    .oneshot(
                        Request::builder()
                            .method("POST")
                            .uri(path)
                            .header(
                                axum::http::header::AUTHORIZATION,
                                format!(
                                    "Bearer {}",
                                    common::REALM.workload(common::PIPELINE_RUNNER_CLIENT)
                                ),
                            )
                            .body(Body::from(message.to_string()))
                            .expect("request"),
                    )
                    .await
                    .expect("response")
                    .status();
                assert_eq!(status, StatusCode::NO_CONTENT);
            }
            return harness;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("the runner never received harness {nth}");
}

fn json_of(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or(Value::Null)
}

#[tokio::test]
async fn a_sample_is_the_sources_first_records_with_their_fields() {
    let runner = runner().await;
    let state = state("sample", Some(&runner));
    let rows = [
        json!({ "input": "page", "output": { "station": "01", "capacity": "12" }, "error": null }),
        json!({ "input": "page", "output": { "station": "02", "free": "3" }, "error": null }),
    ];
    let uri = op("sample", "jc_pipeline_sample_source");
    let (answer, harness) = tokio::join!(
        send(
            &state,
            person("dev"),
            "POST",
            &uri,
            Some(json!({ "dataSource": "stations-csv" })),
        ),
        play_runner(&runner, &state, 0, &rows),
    );
    assert_eq!(answer.status, StatusCode::OK, "{}", answer.text);
    let body = json_of(&answer.text);
    assert_eq!(body["count"], 2);
    assert_eq!(body["truncated"], false);
    assert_eq!(body["fields"], json!(["capacity", "free", "station"]));
    assert_eq!(body["records"][1]["free"], "3");
    // The feed is fetched once, split as CSV because its path says so, with no step of anyone's.
    let text = harness.to_string();
    assert!(
        text.contains("https://feeds.example/stations.csv?day=1"),
        "{text}"
    );
    assert!(text.contains("parse_csv"), "{text}");
    assert!(!text.contains("secretRef"));
}

#[tokio::test]
async fn a_source_with_a_credential_a_stream_or_no_name_says_what_to_give_instead() {
    let state = state("refusals", None);
    for (source, status, words) in [
        ("locked", StatusCode::BAD_REQUEST, "declares a credential"),
        ("broker", StatusCode::BAD_REQUEST, "type mqtt"),
        ("nobody", StatusCode::NOT_FOUND, "'nobody' not found"),
    ] {
        let answer = send(
            &state,
            person("dev"),
            "POST",
            &op("refusals", "jc_pipeline_sample_source"),
            Some(json!({ "dataSource": source })),
        )
        .await;
        assert_eq!(answer.status, status, "{source}: {}", answer.text);
        assert!(answer.text.contains(words), "{source}: {}", answer.text);
        if status == StatusCode::BAD_REQUEST {
            assert!(
                answer.text.contains("give the sample as text"),
                "{}",
                answer.text
            );
        }
    }
    let both = send(
        &state,
        person("dev"),
        "POST",
        &op("refusals", "jc_pipeline_sample_source"),
        Some(json!({ "dataSource": "stations-csv", "sample": { "text": "a,b\n1,2\n", "format": "csv" } })),
    )
    .await;
    assert_eq!(
        both.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{}",
        both.text
    );
}

#[tokio::test]
async fn trying_a_mapping_answers_what_the_pipeline_test_answers() {
    let runner = runner().await;
    let state = state("mapping", Some(&runner));
    let mapping = "root.id = \"urn:ngsi-ld:BikeStation:hel.fi:bikes:\" + this.station\nroot.type = \"BikeStation\"\nroot.capacity = this.capacity.number()";
    let pipeline = json!({
        "apiVersion": "joinedcontext.com/v1alpha1",
        "kind": "Pipeline",
        "metadata": { "name": "stations" },
        "spec": {
            "class": "resident",
            "source": { "dataSourceRef": { "kind": "DataSource", "name": "stations-csv" } },
            "compute": { "kind": "bloblang", "bloblang": mapping },
            "targetEndpoint": "urn:ngsi-ld:Endpoint:hel.fi:bikes:bikes-write"
        }
    });
    let sample = json!({ "text": "station,capacity\n01,12\n02,x\n", "format": "csv" });
    let captured = [
        json!({ "input": "{\"station\":\"01\",\"capacity\":\"12\"}", "output": { "id": "urn:ngsi-ld:BikeStation:hel.fi:bikes:01", "type": "BikeStation", "capacity": 12 }, "error": null }),
        json!({ "input": "{\"station\":\"02\",\"capacity\":\"x\"}", "output": null, "error": "failed assignment (line 3): strconv.ParseFloat: parsing \"x\": invalid syntax", "step": "0" }),
    ];
    let body = json!({ "pipeline": pipeline, "sample": sample });

    let uri = op("mapping", "jc_pipeline_try_mapping");
    let (tried, _) = tokio::join!(
        send(&state, person("dev"), "POST", &uri, Some(body.clone())),
        play_runner(&runner, &state, 0, &captured),
    );
    let (tested, _) = tokio::join!(
        send(
            &state,
            person("dev"),
            "POST",
            "/api/v1/projects/mapping/pipelines/test",
            Some(body)
        ),
        play_runner(&runner, &state, 1, &captured),
    );
    assert_eq!(tried.status, StatusCode::OK, "{}", tried.text);
    assert_eq!(tested.status, StatusCode::OK, "{}", tested.text);
    let (tried, tested) = (json_of(&tried.text), json_of(&tested.text));
    assert_eq!(tried["records"], tested["mapping"]);
    assert_eq!(tried["errors"], tested["errors"]);
    assert_eq!(tried["input"], tested["input"]);
    assert_eq!(tried["errors"][0]["line"], 3);
    assert_eq!(tried["errors"][0]["step"], 0);
}

#[tokio::test]
async fn sampling_and_trying_need_propose_and_a_reader_is_told_so() {
    let state = state("gate", None);
    let sample = json!({ "text": "a\n1\n", "format": "csv" });
    for (name, body) in [
        ("jc_pipeline_sample_source", json!({ "sample": sample })),
        (
            "jc_pipeline_try_mapping",
            json!({ "draft": { "kind": "Pipeline", "name": "x" }, "sample": sample }),
        ),
    ] {
        for who in ["jana", "mikko"] {
            let answer = send(
                &state,
                person(who),
                "POST",
                &op("gate", name),
                Some(body.clone()),
            )
            .await;
            assert_eq!(
                answer.status,
                StatusCode::FORBIDDEN,
                "{name} as {who}: {}",
                answer.text
            );
        }
    }
}

#[tokio::test]
async fn validating_gives_a_verdict_per_record_with_the_rule_each_broke() {
    let state = state("check", None);
    let pipeline = json!({
        "apiVersion": "joinedcontext.com/v1alpha1",
        "kind": "Pipeline",
        "metadata": { "name": "stations" },
        "spec": {
            "class": "resident",
            "source": { "dataSourceRef": { "kind": "DataSource", "name": "stations-csv" } },
            "targetEndpoint": "urn:ngsi-ld:Endpoint:hel.fi:bikes:bikes-write"
        }
    });
    let records = json!([
        { "id": "urn:ngsi-ld:BikeStation:hel.fi:bikes:01", "type": "BikeStation", "capacity": { "type": "Property", "value": 12 } },
        { "id": "urn:ngsi-ld:BikeStation:hel.fi:bikes:02", "type": "BikeStation", "capacity": { "type": "Property", "value": "x" } },
        { "id": "urn:ngsi-ld:BikeStation:elsewhere.org:bikes:03", "type": "BikeStation" },
        { "id": "urn:ngsi-ld:Tram:hel.fi:bikes:04", "type": "Tram" }
    ]);
    // A reader may check: the verdict writes nothing and names only the model's rules.
    let answer = send(
        &state,
        person("jana"),
        "POST",
        &op("check", "jc_pipeline_validate"),
        Some(json!({ "pipeline": pipeline, "records": records })),
    )
    .await;
    assert_eq!(answer.status, StatusCode::OK, "{}", answer.text);
    let body = json_of(&answer.text);
    assert_eq!(body["space"], "bikes");
    assert_eq!(body["model"], "bikes");
    assert_eq!(body["version"], "1.2.0");
    assert_eq!(
        (body["valid"].as_u64(), body["rejected"].as_u64()),
        (Some(1), Some(3))
    );
    let verdicts = body["verdicts"].as_array().expect("verdicts");
    assert_eq!(verdicts[0]["ok"], true);
    assert_eq!(verdicts[1]["problems"][0]["rule"], "sh:datatype");
    assert_eq!(verdicts[1]["problems"][0]["path"], "capacity");
    assert!(verdicts[2]["problems"]
        .as_array()
        .expect("problems")
        .iter()
        .any(|p| p["rule"] == "id"));
    assert_eq!(verdicts[3]["problems"][0]["rule"], "type");
    assert!(
        !answer.text.contains("\"x\""),
        "a problem never quotes the value: {}",
        answer.text
    );

    // The space named directly gives the same verdicts.
    let direct = send(
        &state,
        person("jana"),
        "POST",
        &op("check", "jc_pipeline_validate"),
        Some(json!({ "space": "bikes", "records": records })),
    )
    .await;
    assert_eq!(json_of(&direct.text)["verdicts"], body["verdicts"]);
}

#[tokio::test]
async fn validating_refuses_a_space_without_a_model_too_many_records_and_a_stranger() {
    let state = state("edges", None);
    let one = json!([{ "id": "urn:ngsi-ld:BikeStation:hel.fi:loose:1", "type": "BikeStation" }]);
    let loose = send(
        &state,
        person("jana"),
        "POST",
        &op("edges", "jc_pipeline_validate"),
        Some(json!({ "space": "loose", "records": one })),
    )
    .await;
    assert_eq!(loose.status, StatusCode::CONFLICT, "{}", loose.text);
    assert!(loose.text.contains("spec.dataModelRef"), "{}", loose.text);

    let missing = send(
        &state,
        person("jana"),
        "POST",
        &op("edges", "jc_pipeline_validate"),
        Some(json!({ "space": "nowhere", "records": one })),
    )
    .await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND, "{}", missing.text);

    let nothing = send(
        &state,
        person("jana"),
        "POST",
        &op("edges", "jc_pipeline_validate"),
        Some(json!({ "records": one })),
    )
    .await;
    assert_eq!(
        nothing.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{}",
        nothing.text
    );
    assert!(
        nothing.text.contains("give pipeline, draft or space"),
        "{}",
        nothing.text
    );

    let many: Vec<Value> = (0..101).map(|n| json!({ "id": n })).collect();
    let too_many = send(
        &state,
        person("jana"),
        "POST",
        &op("edges", "jc_pipeline_validate"),
        Some(json!({ "space": "bikes", "records": many })),
    )
    .await;
    assert_eq!(
        too_many.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{}",
        too_many.text
    );

    let stranger = send(
        &state,
        person("mikko"),
        "POST",
        &op("edges", "jc_pipeline_validate"),
        Some(json!({ "space": "bikes", "records": one })),
    )
    .await;
    assert_eq!(stranger.status, StatusCode::FORBIDDEN, "{}", stranger.text);
}
