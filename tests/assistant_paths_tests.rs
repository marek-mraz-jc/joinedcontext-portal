//! The assistant's paths (T-2693, AG-87…AG-91, API/04 §8 "Paths"): a picked path answers its first
//! step without the model, a path narrows the tools, free text is routed by `choose_path`, and a
//! hand-over is announced. The model is a stub proxy whose answers the tests script.

use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use axum::response::IntoResponse;
use axum_extra::extract::cookie::PrivateCookieJar;
use http_body_util::BodyExt;
use joinedcontext_portal::agents::run::AgentRunEvent;
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
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const CSRF: &str = "test-csrf-token-paths";
const READER: &str = "reader@hel.fi";
const BLIND: &str = "blind@hel.fi";

fn config(proxy_base: &str) -> Config {
    Config::from_vars(|key| {
        match key {
            "JC_AGENTS_NAMESPACE" => Some("agents"),
            "JC_AGENT_PROXY_BASE" => Some(proxy_base),
            "JC_AGENT_PROXY_TOKEN" => Some("the-token-only-jc-agent-proxy-has"),
            "JC_PORTAL_BOOTSTRAP_ADMINS" => Some("portal-approver"),
            "JC_PORTAL_PUBLIC_URL" => Some("https://portal.example.com"),
            _ => None,
        }
        .map(str::to_owned)
    })
    .expect("the agent runner block is complete")
}

fn cookie(config: &Config, email: &str) -> String {
    let now = session::now_unix();
    let s = Session {
        identity: Identity {
            subject: format!("f:1:{email}"),
            username: email.split('@').next().unwrap_or(email).to_owned(),
            email: Some(email.to_owned()),
            name: None,
            roles: Vec::new(),
            groups: Vec::new(),
        },
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
        .filter_map(|v| v.to_str().ok())
        .map(|raw| raw.split(';').next().unwrap_or_default().to_owned())
        .collect();
    parts.push(format!("{CSRF_COOKIE}={CSRF}"));
    parts.join("; ")
}

fn envelope(kind: &str, name: &str, namespace: &str, spec: Value) -> ResourceEnvelope {
    ResourceEnvelope {
        api_version: API_VERSION.to_owned(),
        kind: kind.to_owned(),
        metadata: ObjectMeta::new(name, namespace),
        spec,
        status: None,
    }
}

fn endpoint(name: &str, project: &str, representations: &[&str]) -> ResourceEnvelope {
    envelope(
        "Endpoint",
        name,
        project,
        json!({
            "contextSpaceRef": { "name": project },
            "slug": name,
            "audience": "organization",
            "enabledRepresentations": representations,
        }),
    )
}

/// The organization, the builder profile, two endpoints of helsinki and one of espoo; the reader
/// may start a conversation and read endpoints in helsinki, the blind person only start one.
fn mirror() -> Arc<Mirror> {
    let mirror = Arc::new(Mirror::new());
    mirror.upsert(envelope(
        "Organization",
        "hel",
        ORG_NAMESPACE,
        json!({ "domain": "hel.fi", "locales": ["en"], "defaultLocale": "en" }),
    ));
    mirror.upsert(envelope(
        "AgentProfile",
        "app-builder",
        ORG_NAMESPACE,
        json!({
            "role": "builder",
            "runtime": {
                "image": "ghcr.io/all-hands-ai/agent-server:v1.4.0",
                "digest": "sha256:1111111111111111111111111111111111111111111111111111111111111111"
            },
            "model": { "provider": "openai-compatible", "name": "deepseek/deepseek-v4.1-flash", "maxTokensPerRun": 400000 },
            "limits": { "stepsPerRun": 120, "wallClock": "PT20M", "concurrentRunsPerOrganization": 2, "requestsPerMinute": 60, "maxResponseBytes": 2097152 },
            "egress": { "allowedHosts": ["registry.npmjs.org"] },
            "tools": ["shell"],
            "workspace": { "cpu": "1", "memory": "2Gi", "ephemeralStorage": "4Gi" }
        }),
    ));
    for (role, rules) in [
        (
            "endpoint-reader",
            json!([{ "kinds": ["App"], "verbs": ["propose"] }, { "kinds": ["Endpoint"], "verbs": ["read"] }]),
        ),
        (
            "app-starter",
            json!([{ "kinds": ["App"], "verbs": ["propose"] }]),
        ),
    ] {
        mirror.upsert(envelope(
            "Role",
            role,
            ORG_NAMESPACE,
            json!({ "rules": rules }),
        ));
    }
    for (binding, who, role) in [
        ("reader", READER, "endpoint-reader"),
        ("blind", BLIND, "app-starter"),
    ] {
        mirror.upsert(envelope(
            "RoleBinding",
            binding,
            ORG_NAMESPACE,
            json!({ "subjects": [{ "user": who }], "role": role, "scope": { "project": "helsinki" } }),
        ));
    }
    mirror.upsert(endpoint("bikes", "helsinki", &["ngsi-ld", "geojson"]));
    mirror.upsert(endpoint("air", "helsinki", &["csv"]));
    mirror.upsert(endpoint("espoo-bikes", "espoo", &["ngsi-ld"]));
    mirror
}

async fn send(
    state: &AppState,
    config: &Config,
    who: &str,
    uri: &str,
    body: Value,
) -> (StatusCode, Value) {
    let response = server::app(state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(uri)
                .header(header::COOKIE, cookie(config, who))
                .header(CSRF_HEADER, CSRF)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
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

/// A stub model: each answer in `answers` once, in order, then the last one for ever.
async fn model(answers: &[&str]) -> MockServer {
    let proxy = MockServer::start().await;
    let reply = |text: &str| {
        ResponseTemplate::new(200).set_body_json(json!({
            "id": "chatcmpl-1", "object": "chat.completion",
            "choices": [{ "index": 0, "message": { "role": "assistant", "content": text }, "finish_reason": "stop" }],
            "usage": { "total_tokens": 100 }
        }))
    };
    let (last, first) = answers.split_last().expect("one answer at least");
    for text in first {
        Mock::given(method("POST"))
            .and(path("/v1/llm/chat/completions"))
            .respond_with(reply(text))
            .up_to_n_times(1)
            .mount(&proxy)
            .await;
    }
    Mock::given(method("POST"))
        .and(path("/v1/llm/chat/completions"))
        .respond_with(reply(last))
        .mount(&proxy)
        .await;
    proxy
}

struct Started {
    state: AppState,
    status: StatusCode,
    body: Value,
    proxy: MockServer,
}

async fn start(who: &str, request: Value, answers: &[&str]) -> Started {
    let proxy = model(answers).await;
    let config = config(&proxy.uri());
    let state = AppState::new(config.clone(), None).with_mirror(mirror());
    let (status, body) = send(
        &state,
        &config,
        who,
        "/api/v1/projects/helsinki/assistant/conversations",
        request,
    )
    .await;
    Started {
        state,
        status,
        body,
        proxy,
    }
}

/// The run's events once one of `kind` satisfying `until` is among them.
async fn events_until(
    started: &Started,
    until: impl Fn(&AgentRunEvent) -> bool,
) -> Vec<AgentRunEvent> {
    let run = started.body["id"].as_str().expect("run id");
    for _ in 0..200 {
        let events = started
            .state
            .agents
            .events_since(run, 0)
            .await
            .expect("events");
        if events.iter().any(&until) {
            return events;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("the run never reached what the test waits for");
}

fn of_kind<'a>(events: &'a [AgentRunEvent], kind: &str) -> Vec<&'a Value> {
    events
        .iter()
        .filter(|e| e.kind == kind)
        .map(|e| &e.payload)
        .collect()
}

#[tokio::test]
async fn a_picked_path_answers_its_first_step_without_the_model() {
    let started = start(READER, json!({ "path": "build-app" }), &["never asked"]).await;
    assert_eq!(started.status, StatusCode::ACCEPTED, "{}", started.body);
    let events = events_until(&started, |e| e.kind == "question").await;
    let path = of_kind(&events, "path");
    assert_eq!(path.len(), 1, "{path:?}");
    assert_eq!(path[0]["path"], "build-app");
    assert_eq!(path[0]["by"], "person");
    let question = of_kind(&events, "question")[0];
    assert_eq!(question["pick"], "endpoints");
    assert_eq!(question["multiple"], true);
    let mut offered: Vec<&str> = question["options"]
        .as_array()
        .expect("options")
        .iter()
        .filter_map(|o| o["value"].as_str())
        .collect();
    offered.sort_unstable();
    assert_eq!(
        offered,
        ["air", "bikes"],
        "helsinki's endpoints, never espoo's"
    );
    for payload in [path[0], question] {
        let elapsed = payload["elapsedMs"].as_u64().expect("elapsedMs");
        assert!(
            elapsed < 300,
            "the first step answers under 300 ms (AG-91): {elapsed}"
        );
    }
    assert!(
        of_kind(&events, "message").is_empty(),
        "a path picked without words writes no empty line of chat"
    );
    tokio::time::sleep(Duration::from_millis(150)).await;
    let calls = started.proxy.received_requests().await.unwrap_or_default();
    assert!(
        calls.is_empty(),
        "the first step made {} model calls",
        calls.len()
    );
}

#[tokio::test]
async fn a_path_without_a_pick_asks_in_free_text() {
    let started = start(READER, json!({ "path": "find-data" }), &["never asked"]).await;
    assert_eq!(started.status, StatusCode::ACCEPTED, "{}", started.body);
    let events = events_until(&started, |e| e.kind == "question").await;
    let question = of_kind(&events, "question")[0];
    assert_eq!(question["schema"]["title"], "What are you looking for?");
    assert!(question["options"].as_array().is_some_and(Vec::is_empty));
    assert!(question["schema"]["properties"]["answer"]
        .get("oneOf")
        .is_none());
}

#[tokio::test]
async fn an_unknown_path_and_a_path_the_person_may_not_take_are_refused() {
    let unknown = start(READER, json!({ "path": "delete-everything" }), &["-"]).await;
    // A body the route cannot read is a 422, like every other one (API/04 §8).
    assert_eq!(
        unknown.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{}",
        unknown.body
    );
    // The reader may propose an App and read endpoints, and propose no Pipeline.
    let refused = start(READER, json!({ "path": "integrate-pipeline" }), &["-"]).await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN, "{}", refused.body);
    assert!(
        refused.body.to_string().contains("Pipeline"),
        "{}",
        refused.body
    );
    let empty = start(READER, json!({ "message": "  " }), &["-"]).await;
    assert_eq!(empty.status, StatusCode::BAD_REQUEST, "{}", empty.body);
}

#[tokio::test]
async fn a_tool_outside_the_path_goes_back_to_the_model_with_the_paths_tools() {
    let off_path = "```json\n{ \"tool\": \"change_resource\", \"arguments\": { \"kind\": \"Endpoint\", \"name\": \"bikes\", \"delete\": true } }\n```";
    let started = start(
        READER,
        json!({ "path": "find-data", "message": "remove the bikes endpoint" }),
        &[
            off_path,
            "Finding data changes nothing; the bikes endpoint stays.",
        ],
    )
    .await;
    assert_eq!(started.status, StatusCode::ACCEPTED, "{}", started.body);
    let events = events_until(&started, |e| {
        e.kind == "thought"
            && e.payload["text"]
                .as_str()
                .is_some_and(|t| t.contains("changes nothing"))
    })
    .await;
    let refused: Vec<&Value> = of_kind(&events, "tool")
        .into_iter()
        .filter(|t| t["tool"] == "change_resource")
        .collect();
    assert_eq!(refused.len(), 1, "{refused:?}");
    assert_eq!(refused[0]["status"], "failed");
    let error = refused[0]["error"].as_str().expect("error");
    assert!(
        error.contains("find-data") && error.contains("jc_switch_path"),
        "{error}"
    );
    let prompts: Vec<String> = started
        .proxy
        .received_requests()
        .await
        .unwrap_or_default()
        .iter()
        .map(|r| String::from_utf8_lossy(&r.body).into_owned())
        .collect();
    assert!(prompts[0].contains("THE PATH"), "the pack names the path");
    assert!(
        prompts[1].contains("does not use change_resource"),
        "the refusal reaches the model"
    );
}

#[tokio::test]
async fn free_text_takes_the_path_choose_path_names() {
    let started = start(
        READER,
        json!({ "message": "which endpoints have bike data?" }),
        &[
            "{\"path\": \"find-data\", \"reason\": \"asks which data exists\"}",
            "bikes has the city bike stations.",
        ],
    )
    .await;
    assert_eq!(started.status, StatusCode::ACCEPTED, "{}", started.body);
    let events = events_until(&started, |e| e.kind == "thought").await;
    let path = of_kind(&events, "path");
    assert_eq!(path.len(), 1, "{path:?}");
    assert_eq!(path[0]["path"], "find-data");
    assert_eq!(path[0]["by"], "router");
    assert_eq!(path[0]["reason"], "asks which data exists");
}

#[tokio::test]
async fn choose_path_never_takes_a_path_the_person_may_not_take() {
    // share-data proposes an Endpoint, which the reader may not.
    let started = start(
        READER,
        json!({ "message": "publish the bikes to everyone" }),
        &[
            "{\"path\": \"share-data\", \"reason\": \"publishing\"}",
            "You may not publish endpoints here; ask a steward.",
        ],
    )
    .await;
    let events = events_until(&started, |e| e.kind == "thought").await;
    assert!(of_kind(&events, "path").is_empty(), "no path was taken");
}

#[tokio::test]
async fn a_hand_over_is_announced_and_moves_the_turn() {
    let switch = "```json\n{ \"tool\": \"jc_switch_path\", \"arguments\": { \"path\": \"build-app\", \"reason\": \"they want an app of it\" } }\n```";
    let started = start(
        READER,
        json!({ "path": "find-data", "message": "make an app of the bikes" }),
        &[
            switch,
            "Let's build it: which endpoints should the app read?",
        ],
    )
    .await;
    let events = events_until(&started, |e| e.kind == "thought").await;
    let paths: Vec<(&str, &str)> = of_kind(&events, "path")
        .iter()
        .map(|p| {
            (
                p["path"].as_str().unwrap_or(""),
                p["by"].as_str().unwrap_or(""),
            )
        })
        .collect();
    assert_eq!(
        paths,
        [("build-app", "handover")],
        "a path given with words has no first step"
    );
    let prompts: Vec<String> = started
        .proxy
        .received_requests()
        .await
        .unwrap_or_default()
        .iter()
        .map(|r| String::from_utf8_lossy(&r.body).into_owned())
        .collect();
    assert!(
        prompts[1].contains("on the path `build-app`"),
        "the rest of the turn is on the new path"
    );
}
