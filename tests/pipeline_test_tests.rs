//! A candidate pipeline tested on the project's runner (T-0591, PL-43, MF-38): the harness
//! goes to the runner's streams API, what it posts back is the trace, the stream is deleted
//! whatever happened, and nothing else is touched.
mod common;

use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use axum::response::IntoResponse;
use axum_extra::extract::cookie::PrivateCookieJar;
use http_body_util::BodyExt;
use joinedcontext_portal::auth::csrf::{CSRF_COOKIE, CSRF_HEADER};
use joinedcontext_portal::auth::session::{self, Identity, Session};
use joinedcontext_portal::config::Config;
use joinedcontext_portal::permissions::ORG_NAMESPACE;
use joinedcontext_portal::resource::{ObjectMeta, ResourceEnvelope, API_VERSION};
use joinedcontext_portal::server;
use joinedcontext_portal::state::AppState;
use joinedcontext_portal::store::Mirror;
use serde_json::{json, Value};
use tower::ServiceExt;
use wiremock::matchers::{method, path_regex};
use wiremock::{Mock, MockServer, ResponseTemplate};

const CSRF: &str = "test-csrf-token-12345";

fn identity(email: &str) -> Identity {
    Identity {
        subject: format!("f:1:{email}"),
        username: email.split('@').next().unwrap_or(email).to_owned(),
        email: Some(email.to_owned()),
        name: None,
        roles: Vec::new(),
        groups: Vec::new(),
    }
}

fn cookies(config: &Config, identity: Identity) -> String {
    let now = session::now_unix();
    let s = Session {
        identity,
        expires_at: now + 3600,
        issued_at: now,
        id_token: "id".into(),
        access_expires_at: now + 3600,
        refresh_token: None,
    };
    let jar = session::store(PrivateCookieJar::new(config.cookie_key.clone()), &s).expect("store");
    let response = (jar, StatusCode::OK).into_response();
    let mut parts: Vec<String> = response
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .map(|v| {
            v.to_str()
                .expect("cookie")
                .split(';')
                .next()
                .unwrap_or_default()
                .to_owned()
        })
        .collect();
    parts.push(format!("{CSRF_COOKIE}={CSRF}"));
    parts.join("; ")
}

fn org(kind: &str, name: &str, spec: Value) -> ResourceEnvelope {
    ResourceEnvelope {
        api_version: API_VERSION.to_owned(),
        kind: kind.to_owned(),
        metadata: ObjectMeta::new(name, ORG_NAMESPACE),
        spec,
        status: None,
    }
}

/// A role that proposes pipelines in `project`, bound to the developer.
///
/// Every test that reaches the runner takes a project of its own: one pipeline test runs per
/// project at a time, process-wide (`pipeline_test::RUNNING`), and the tests of this file run in
/// parallel in one process, so two sharing a project refuse each other whenever they overlap —
/// which a slower CI runner makes them do (T-1458).
fn mirror(project: &str) -> Arc<Mirror> {
    let mirror = Arc::new(Mirror::new());
    mirror.upsert(org(
        "Role",
        "pipeline-author",
        json!({ "rules": [{ "kinds": ["Pipeline", "DataSource"], "verbs": ["propose"] }] }),
    ));
    mirror.upsert(org(
        "RoleBinding",
        "dev-authors",
        json!({
            "subjects": [{ "user": "dev@hel.fi" }],
            "role": "pipeline-author",
            "scope": { "project": project }
        }),
    ));
    mirror
}

fn request(bloblang: &str) -> Value {
    json!({
        "pipeline": {
            "apiVersion": "joinedcontext.com/v1alpha1",
            "kind": "Pipeline",
            "metadata": { "name": "shmu-air-quality" },
            "spec": {
                "class": "resident",
                "source": { "dataSourceRef": { "kind": "DataSource", "name": "shmu-csv" } },
                "compute": { "kind": "bloblang", "bloblang": bloblang },
                "targetEndpoint": "urn:ngsi-ld:Endpoint:hel.fi:helsinki:helsinki-all"
            }
        },
        "sample": { "text": "station_id,pm10\n01,18.2\n02,x\n", "format": "csv" }
    })
}

fn config(runner: Option<&MockServer>) -> Config {
    let mut config = Config::for_tests();
    config.pipeline_runner_url = runner.map(|r| format!("{}/{{project}}", r.uri()));
    config.pipeline_test_capture_url = Some("http://portal-internal:9090".into());
    // The capture route takes the runner's own ServiceAccount token (T-2271); without the realm and
    // the client, this Portal refuses every message, which is the point of the route's own test.
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

/// The header the project's pipeline runner posts a capture with.
fn runner_bearer() -> String {
    format!(
        "Bearer {}",
        common::REALM.workload(common::PIPELINE_RUNNER_CLIENT)
    )
}

async fn post(state: &AppState, who: &str, project: &str, body: &Value) -> (StatusCode, Value) {
    send(
        state,
        who,
        &format!("/api/v1/projects/{project}/pipelines/test"),
        body,
    )
    .await
}

async fn send(state: &AppState, who: &str, uri: &str, body: &Value) -> (StatusCode, Value) {
    let response = server::app(state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(uri)
                .header(header::COOKIE, cookies(&state.config, identity(who)))
                .header(CSRF_HEADER, CSRF)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(serde_json::to_vec(body).expect("json")))
                .expect("request"),
        )
        .await
        .expect("response");
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// The runner's side: waits for the harness to arrive, answers for it on the capture route.
async fn play_runner(runner: &MockServer, state: &AppState, messages: &[Value]) -> Value {
    for _ in 0..100 {
        let received = runner.received_requests().await.unwrap_or_default();
        if let Some(create) = received.iter().find(|r| r.method == "POST") {
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
                            .header(axum::http::header::AUTHORIZATION, runner_bearer())
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
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    panic!("the runner never received the harness");
}

fn runner_mocks(create: ResponseTemplate) -> (Mock, Mock) {
    (
        Mock::given(method("POST"))
            .and(path_regex(r"^/[a-z-]+/streams/pipeline-test-[a-z2-7]{26}$"))
            .respond_with(create)
            .expect(1),
        Mock::given(method("DELETE"))
            .and(path_regex(r"^/[a-z-]+/streams/pipeline-test-[a-z2-7]{26}$"))
            .respond_with(ResponseTemplate::new(200))
            .expect(1),
    )
}

#[tokio::test]
async fn the_trace_is_what_the_harness_posted_back_and_the_stream_is_deleted() {
    let runner = MockServer::start().await;
    let (create, delete) = runner_mocks(ResponseTemplate::new(200));
    create.mount(&runner).await;
    delete.mount(&runner).await;
    let state = AppState::new(config(Some(&runner)), None).with_mirror(mirror("helsinki"));

    let mapping = "root.id = \"urn:ngsi-ld:AirQualityObserved:hel.fi:aq:\" + this.station_id\nroot.type = \"AirQualityObserved\"\nroot.pm10 = this.pm10.number()";
    let messages = [
        json!({ "input": "{\"station_id\":\"01\",\"pm10\":\"18.2\"}", "output": { "id": "urn:ngsi-ld:AirQualityObserved:hel.fi:aq:01", "type": "AirQualityObserved", "pm10": 18.2 }, "error": null }),
        json!({ "input": "{\"station_id\":\"02\",\"pm10\":\"x\"}", "output": null, "error": "failed assignment (line 3): strconv.ParseFloat: parsing \"x\": invalid syntax" }),
    ];
    let body = request(mapping);
    let (answer, harness) = tokio::join!(
        post(&state, "dev@hel.fi", "helsinki", &body),
        play_runner(&runner, &state, &messages),
    );
    let (status, body) = answer;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["input"]["events"], 2);
    assert_eq!(body["input"]["sample"]["station_id"], "01");
    assert_eq!(
        body["mapping"][0]["id"],
        "urn:ngsi-ld:AirQualityObserved:hel.fi:aq:01"
    );
    assert_eq!(body["validation"][0]["ok"], true);
    assert_eq!(body["errors"][0]["stage"], "mapping");
    assert_eq!(body["errors"][0]["line"], 3);

    // The harness: the sample generated once, the author's mapping as its own processor, the
    // output pointed at the capture route; no secret, no target endpoint (MF-38).
    assert_eq!(harness["input"]["generate"]["count"], 1);
    let processors = harness["pipeline"]["processors"]
        .as_array()
        .expect("processors");
    assert!(processors.iter().any(|p| p["mapping"] == mapping));
    let text = harness.to_string();
    assert!(
        !text.contains("helsinki-all"),
        "the target endpoint is never in the harness"
    );
    assert!(!text.contains("secretRef") && !text.contains("resources"));
    runner.verify().await;
}

/// A DataSource Check fetches the feed once on the runner (MF-39); a fetch that fails reaches
/// the capture route like any message, and the Check names what the feed answered.
#[tokio::test]
async fn a_data_source_check_names_what_the_feed_answered() {
    let runner = MockServer::start().await;
    let (create, delete) = runner_mocks(ResponseTemplate::new(200));
    create.mount(&runner).await;
    delete.mount(&runner).await;
    let state = AppState::new(config(Some(&runner)), None).with_mirror(mirror("porvoo"));
    let source = json!({
        "apiVersion": "joinedcontext.com/v1alpha1",
        "kind": "DataSource",
        "metadata": { "name": "bikes" },
        "spec": { "type": "http", "http": { "url": "https://feeds.example/bikes.json" } }
    });
    let failed = [json!({
        "input": null,
        "output": null,
        "error": "fetch: https://feeds.example/bikes.json: HTTP request returned unexpected response code (404): 404 Not Found, Error: gone"
    })];
    let (answer, harness) = tokio::join!(
        send(
            &state,
            "dev@hel.fi",
            "/api/v1/projects/porvoo/datasources?dryRun=All",
            &source
        ),
        play_runner(&runner, &state, &failed),
    );
    let (status, body) = answer;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["probe"]["skipped"], "the feed answered 404 Not Found",
        "{body}"
    );
    assert!(body["probe"].get("records").is_none());

    // One fetch by a processor whose failure is kept for the envelope, never a polling input.
    let processors = harness["pipeline"]["processors"]
        .as_array()
        .expect("processors");
    assert_eq!(
        processors[0]["http"]["url"],
        "https://feeds.example/bikes.json"
    );
    assert!(processors[2]["catch"].is_array());
    assert!(harness["input"].get("http_client").is_none());
    runner.verify().await;
}

#[tokio::test]
async fn a_harness_the_runner_refuses_is_a_lint_error_with_its_line() {
    let runner = MockServer::start().await;
    let (create, delete) = runner_mocks(
        ResponseTemplate::new(400).set_body_string(
            "stream 'pipeline-test-x' failed to create: failed to parse mapping: line 2 char 9: expected whitespace",
        ),
    );
    create.mount(&runner).await;
    delete.mount(&runner).await;
    let state = AppState::new(config(Some(&runner)), None).with_mirror(mirror("espoo"));

    let (status, body) = post(&state, "dev@hel.fi", "espoo", &request("root.id = = 1")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["input"]["events"], 0);
    assert_eq!(body["errors"][0]["stage"], "lint");
    assert_eq!(body["errors"][0]["line"], 2);
    runner.verify().await;
}

/// T-1139, PL-43: a runner that answers with its own failure is the platform's problem, not the
/// caller's. It is `503` and no trace, because a trace of nothing would read as a pipeline that
/// produced nothing.
#[tokio::test]
async fn a_runner_that_fails_the_create_is_503_and_no_trace() {
    let runner = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path_regex(r"^/[a-z-]+/streams/pipeline-test-[a-z2-7]{26}$"))
        .respond_with(ResponseTemplate::new(503).set_body_string("no capacity"))
        .expect(1)
        .mount(&runner)
        .await;
    let state = AppState::new(config(Some(&runner)), None).with_mirror(mirror("kuopio"));

    let (status, body) = post(&state, "dev@hel.fi", "kuopio", &request("root = this")).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert!(body.get("errors").is_none(), "{body}");
    // The runner's own words stay inside the cluster: the caller learns the platform is at
    // fault and nothing about its capacity.
    assert!(!body.to_string().contains("no capacity"), "{body}");
    runner.verify().await;
}

#[tokio::test]
async fn what_the_kind_refuses_is_400_before_the_runner_is_asked() {
    let runner = MockServer::start().await;
    let state = AppState::new(config(Some(&runner)), None).with_mirror(mirror("vantaa"));
    let mut body = request("root = this");
    body["pipeline"]["spec"]["class"] = json!("scheduled");
    let (status, answer) = post(&state, "dev@hel.fi", "vantaa", &body).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{answer}");
    assert!(answer["detail"]
        .as_str()
        .is_some_and(|d| d.contains("Pipeline")));

    let mut body = request("root = this");
    body["sample"] = json!({ "format": "csv" });
    let (status, answer) = post(&state, "dev@hel.fi", "vantaa", &body).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{answer}");
    assert!(runner
        .received_requests()
        .await
        .unwrap_or_default()
        .is_empty());
}

#[tokio::test]
async fn a_caller_without_the_propose_verb_is_403_and_without_a_runner_it_is_503() {
    let runner = MockServer::start().await;
    let state = AppState::new(config(Some(&runner)), None).with_mirror(mirror("turku"));
    let (status, _) = post(&state, "viewer@hel.fi", "turku", &request("root = this")).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let state = AppState::new(config(None), None).with_mirror(mirror("oulu"));
    let (status, body) = post(&state, "dev@hel.fi", "oulu", &request("root = this")).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
}

#[tokio::test]
async fn endpoint_sourced_candidate_with_sample_json_array_returns_trace() {
    let runner = MockServer::start().await;
    let (create, delete) = runner_mocks(ResponseTemplate::new(200));
    create.mount(&runner).await;
    delete.mount(&runner).await;
    let state = AppState::new(config(Some(&runner)), None).with_mirror(mirror("helsinki-kpi-test"));

    let mapping = "root = this";
    let body = json!({
        "pipeline": {
            "apiVersion": "joinedcontext.com/v1alpha1",
            "kind": "Pipeline",
            "metadata": { "name": "kpi-pipeline" },
            "spec": {
                "class": "scheduled",
                "schedule": "*/15 * * * *",
                "source": {
                    "endpointRef": { "kind": "Endpoint", "name": "helsinki-all" },
                    "query": { "type": "BikeHireDockingStation", "attrs": ["availableBikeNumber"] }
                },
                "compute": { "kind": "bloblang", "bloblang": mapping },
                "targetEndpoint": "urn:ngsi-ld:Endpoint:hel.fi:helsinki-kpi:kpi-writer"
            }
        },
        "sample": {
            "text": "[{\"id\":\"urn:ngsi-ld:BikeHireDockingStation:hel.fi:h:1\",\"type\":\"BikeHireDockingStation\",\"availableBikeNumber\":5}]",
            "format": "json"
        }
    });

    let messages = [json!({
        "input": "{\"id\":\"urn:ngsi-ld:BikeHireDockingStation:hel.fi:h:1\",\"type\":\"BikeHireDockingStation\",\"availableBikeNumber\":5}",
        "output": {
            "id": "urn:ngsi-ld:BikeHireDockingStation:hel.fi:h:1",
            "type": "BikeHireDockingStation",
            "availableBikeNumber": 5
        },
        "error": null
    })];

    let (answer, harness) = tokio::join!(
        post(&state, "dev@hel.fi", "helsinki-kpi-test", &body),
        play_runner(&runner, &state, &messages),
    );
    let (status, resp) = answer;
    assert_eq!(status, StatusCode::OK, "{resp}");
    assert_eq!(resp["input"]["events"], 1);
    assert_eq!(resp["mapping"].as_array().unwrap().len(), 1);
    assert_eq!(
        resp["mapping"][0]["id"],
        "urn:ngsi-ld:BikeHireDockingStation:hel.fi:h:1"
    );

    assert_eq!(harness["input"]["generate"]["count"], 1);
    let processors = harness["pipeline"]["processors"]
        .as_array()
        .expect("processors");
    assert!(processors.iter().any(|p| p["mapping"] == mapping));
    runner.verify().await;
}

#[tokio::test]
async fn candidate_with_neither_source_is_400() {
    let runner = MockServer::start().await;
    let state = AppState::new(config(Some(&runner)), None).with_mirror(mirror("helsinki"));
    let body = json!({
        "pipeline": {
            "apiVersion": "joinedcontext.com/v1alpha1",
            "kind": "Pipeline",
            "metadata": { "name": "no-source-pipeline" },
            "spec": {
                "class": "resident",
                "compute": { "kind": "bloblang", "bloblang": "root = this" },
                "targetEndpoint": "urn:ngsi-ld:Endpoint:hel.fi:helsinki:helsinki-all"
            }
        },
        "sample": { "text": "foo", "format": "text" }
    });
    let (status, answer) = post(&state, "dev@hel.fi", "helsinki", &body).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{answer}");
}

#[tokio::test]
async fn anonymous_is_401_and_a_capture_for_no_test_is_404() {
    let state = AppState::new(config(None), None).with_mirror(mirror("lahti"));
    let response = server::app(state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/projects/lahti/pipelines/test")
                .header(header::CONTENT_TYPE, "application/json")
                // The CSRF pair without a session: CSRF is checked first.
                .header(header::COOKIE, format!("{CSRF_COOKIE}={CSRF}"))
                .header(CSRF_HEADER, CSRF)
                .body(Body::from(request("root = this").to_string()))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    let response = server::internal_app(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/internal/pipeline-tests/nosuchtestnosuchtestnosuch")
                .header(axum::http::header::AUTHORIZATION, runner_bearer())
                .body(Body::from(r#"{"input":"x","output":null,"error":null}"#))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    // A feed-sized message (three mebibytes, over axum's default limit) is read, not 413.
    let big = format!(
        r#"{{"input":"{}","output":null,"error":null}}"#,
        "x".repeat(3 * 1024 * 1024)
    );
    let response = server::internal_app(AppState::new(config(None), None))
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/internal/pipeline-tests/nosuchtestnosuchtestnosuch")
                .header(axum::http::header::AUTHORIZATION, runner_bearer())
                .body(Body::from(big))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

/// T-1027: a data source's Check says what it could not do. When no runner answers, the probe
/// is reported as skipped with a reason a person can read, never left out — a Check with no
/// probe section says nothing at all, and the recording stops on it.
#[tokio::test]
async fn a_data_source_check_with_no_runner_still_names_a_probe() {
    // No runner configured at all, the state the recording hits while the pod restarts.
    let state = AppState::new(config(None), None).with_mirror(mirror("loviisa"));
    let source = json!({
        "apiVersion": "joinedcontext.com/v1alpha1",
        "kind": "DataSource",
        "metadata": { "name": "bikes" },
        "spec": { "type": "http", "http": { "url": "https://feeds.example/bikes.json" } }
    });
    let (status, body) = send(
        &state,
        "dev@hel.fi",
        "/api/v1/projects/loviisa/datasources?dryRun=All",
        &source,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let skipped = body["probe"]["skipped"].as_str().unwrap_or_default();
    assert!(
        !skipped.is_empty(),
        "the Check names why the probe did not run: {body}"
    );
    assert!(
        body["probe"].get("records").is_none(),
        "a probe that did not run reports no records: {body}"
    );
    // The runner's absence is not the feed's fault, so the reason does not start like one.
    assert!(
        !skipped.starts_with("the feed "),
        "a runner that did not answer is not blamed on the feed: {skipped}"
    );

    // A runner that is there but refuses (starting up, or out of room) reads the same way.
    let refusing = MockServer::start().await;
    // Only the create call happens: the stream the delete would remove was never made.
    Mock::given(method("POST"))
        .and(path_regex(r"^/[a-z-]+/streams/pipeline-test-[a-z2-7]{26}$"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&refusing)
        .await;
    let state = AppState::new(config(Some(&refusing)), None).with_mirror(mirror("hamina"));
    let (status, body) = send(
        &state,
        "dev@hel.fi",
        "/api/v1/projects/hamina/datasources?dryRun=All",
        &source,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let skipped = body["probe"]["skipped"].as_str().unwrap_or_default();
    assert!(!skipped.is_empty(), "the Check names a reason: {body}");
    assert!(
        !skipped.starts_with("the feed "),
        "a refusing runner is not blamed on the feed: {skipped}"
    );
}

// ---- T-2520: `run_harness`, one test stream per project, always removed (PL-43) -------------
// The running tests are one table per process, so every case below has a project of its own.

const STREAM: &str = r"^/[a-z0-9-]+/streams/pipeline-test-[a-z2-7]{26}$";

/// A runner answering the create with `create` and the delete with `delete`, and a Portal on it.
async fn world_of(
    project: &str,
    create: ResponseTemplate,
    delete: ResponseTemplate,
) -> (MockServer, AppState) {
    let runner = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path_regex(STREAM))
        .respond_with(create)
        .mount(&runner)
        .await;
    Mock::given(method("DELETE"))
        .and(path_regex(STREAM))
        .respond_with(delete)
        .mount(&runner)
        .await;
    let state = AppState::new(config(Some(&runner)), None).with_mirror(mirror(project));
    (runner, state)
}

/// The runner's requests of `verb`, as paths.
async fn asked(runner: &MockServer, verb: &str) -> Vec<String> {
    runner
        .received_requests()
        .await
        .unwrap_or_default()
        .iter()
        .filter(|r| r.method.as_str() == verb)
        .map(|r| r.url.path().to_owned())
        .collect()
}

/// T-2520, PL-43: one test at a time per project; the second is refused before it reaches the
/// runner, and the first finishes and removes its stream.
#[tokio::test]
async fn a_second_test_of_the_same_project_while_one_is_running_is_409() {
    let (runner, state) = world_of(
        "t2520-one",
        ResponseTemplate::new(200),
        ResponseTemplate::new(200),
    )
    .await;
    let body = request("root = this");
    let first = {
        let (state, body) = (state.clone(), body.clone());
        tokio::spawn(async move { post(&state, "dev@hel.fi", "t2520-one", &body).await })
    };
    for _ in 0..100 {
        if !asked(&runner, "POST").await.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let (status, answer) = post(&state, "dev@hel.fi", "t2520-one", &body).await;
    assert_eq!(status, StatusCode::CONFLICT, "{answer}");
    assert_eq!(
        asked(&runner, "POST").await.len(),
        1,
        "the second reached the runner"
    );

    let (status, answer) = first.await.expect("the first test");
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert_eq!(asked(&runner, "DELETE").await, asked(&runner, "POST").await);
}

/// T-2520, PL-43: another project's test runs beside it.
#[tokio::test]
async fn two_different_projects_test_concurrently_without_conflicting() {
    let (runner_a, state_a) = world_of(
        "t2520-a",
        ResponseTemplate::new(200),
        ResponseTemplate::new(200),
    )
    .await;
    let (runner_b, state_b) = world_of(
        "t2520-b",
        ResponseTemplate::new(200),
        ResponseTemplate::new(200),
    )
    .await;
    let body = request("root = this");
    let ((a, _), (b, _)) = tokio::join!(post(&state_a, "dev@hel.fi", "t2520-a", &body), async {
        // B starts once A's stream exists, so the two overlap.
        for _ in 0..100 {
            if !asked(&runner_a, "POST").await.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        post(&state_b, "dev@hel.fi", "t2520-b", &body).await
    },);
    assert_eq!((a, b), (StatusCode::OK, StatusCode::OK));
    assert_eq!(asked(&runner_a, "DELETE").await.len(), 1);
    assert_eq!(asked(&runner_b, "DELETE").await.len(), 1);
}

/// T-2520, PL-43: a failed test gives its project's slot back, so the next one runs.
#[tokio::test]
async fn the_slot_is_released_after_a_failed_run_so_a_later_test_of_the_same_project_succeeds() {
    let (runner, state) = world_of(
        "t2520-again",
        ResponseTemplate::new(400).set_body_string("line 3: expected something"),
        ResponseTemplate::new(200),
    )
    .await;
    let body = request("root = this");
    for _ in 0..2 {
        let (status, answer) = post(&state, "dev@hel.fi", "t2520-again", &body).await;
        assert_eq!(
            status,
            StatusCode::OK,
            "a refused harness is a lint trace: {answer}"
        );
    }
    runner.reset().await;
    Mock::given(method("POST"))
        .and(path_regex(STREAM))
        .respond_with(ResponseTemplate::new(503))
        .mount(&runner)
        .await;
    let (status, _) = post(&state, "dev@hel.fi", "t2520-again", &body).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    runner.reset().await;
    Mock::given(method("POST"))
        .and(path_regex(STREAM))
        .respond_with(ResponseTemplate::new(200))
        .mount(&runner)
        .await;
    Mock::given(method("DELETE"))
        .and(path_regex(STREAM))
        .respond_with(ResponseTemplate::new(200))
        .mount(&runner)
        .await;
    let (status, answer) = post(&state, "dev@hel.fi", "t2520-again", &body).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
}

/// T-2520, PL-43: a runner that creates the stream and never posts a message still gets the
/// delete, once the test's deadline has passed.
#[tokio::test]
async fn a_runner_that_times_out_mid_test_still_gets_the_delete() {
    let (runner, state) = world_of(
        "t2520-silent",
        ResponseTemplate::new(200),
        ResponseTemplate::new(200),
    )
    .await;
    let started = std::time::Instant::now();
    let (status, answer) = post(
        &state,
        "dev@hel.fi",
        "t2520-silent",
        &request("root = this"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert_eq!(answer["input"]["events"], 0, "{answer}");
    assert!(started.elapsed() < Duration::from_secs(10));
    let created = asked(&runner, "POST").await;
    assert_eq!(asked(&runner, "DELETE").await, created);
}

/// T-2520, PL-43: a project name reaches the runner's URL template only as a DNS label: one
/// with reserved characters is not a project, and no stream is created for it.
#[tokio::test]
async fn the_project_name_is_url_templated_safely_even_with_reserved_characters() {
    let (runner, state) = world_of(
        "t2520-safe",
        ResponseTemplate::new(200),
        ResponseTemplate::new(200),
    )
    .await;
    for project in ["a%2Fb", "a..b", "UPPER", "a%40evil.example", "a%3Fx%3D1"] {
        let (status, answer) = post(&state, "dev@hel.fi", project, &request("root = this")).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{project}: {answer}");
    }
    assert!(runner
        .received_requests()
        .await
        .unwrap_or_default()
        .is_empty());
}

/// T-2520: every test names a fresh stream: 26 characters of base32 from the OS's randomness,
/// and the delete names the stream the create made.
#[tokio::test]
async fn the_stream_id_is_unique_per_call_never_reused() {
    let (runner, state) = world_of(
        "t2520-ids",
        ResponseTemplate::new(400).set_body_string("line 1: no"),
        ResponseTemplate::new(200),
    )
    .await;
    for _ in 0..5 {
        post(&state, "dev@hel.fi", "t2520-ids", &request("root = this")).await;
    }
    let mut created = asked(&runner, "POST").await;
    assert_eq!(created.len(), 5);
    assert_eq!(asked(&runner, "DELETE").await, created);
    created.sort();
    created.dedup();
    assert_eq!(created.len(), 5, "a stream id was used twice");
}

/// T-2520, PL-43: without a capture route there is nowhere for the harness to post, so the
/// test is `503` before any stream exists.
#[tokio::test]
async fn a_capture_route_not_configured_is_503_before_a_stream_is_created() {
    let (runner, _) = world_of(
        "t2520-nocap",
        ResponseTemplate::new(200),
        ResponseTemplate::new(200),
    )
    .await;
    let mut config = config(Some(&runner));
    config.pipeline_test_capture_url = None;
    let state = AppState::new(config, None).with_mirror(mirror("t2520-nocap"));
    let (status, answer) = post(&state, "dev@hel.fi", "t2520-nocap", &request("root = this")).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{answer}");
    assert!(runner
        .received_requests()
        .await
        .unwrap_or_default()
        .is_empty());
}

/// T-2520: what the person reads about a runner that failed names no runner address and no
/// credential, whichever way it failed.
#[tokio::test]
async fn the_runner_error_shown_to_the_person_carries_no_runner_url_or_credential() {
    for (project, create) in [
        (
            "t2520-quiet-a",
            ResponseTemplate::new(500)
                .set_body_string("panic at http://runner.internal:4195 token=abc"),
        ),
        (
            "t2520-quiet-b",
            ResponseTemplate::new(200).set_delay(Duration::from_secs(5)),
        ),
    ] {
        let (runner, state) = world_of(project, create, ResponseTemplate::new(200)).await;
        let (status, answer) = post(&state, "dev@hel.fi", project, &request("root = this")).await;
        assert_eq!(
            status,
            StatusCode::SERVICE_UNAVAILABLE,
            "{project}: {answer}"
        );
        let text = answer.to_string();
        for leak in [
            runner.uri().as_str(),
            "127.0.0.1",
            "runner.internal",
            "token=",
            "streams/",
        ] {
            assert!(!text.contains(leak), "{project}: {leak} in {text}");
        }
    }
}
