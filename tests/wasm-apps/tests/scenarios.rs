//! Every server WASM App that ships a scenario, `apps/<name>/server/host-test.json` (T-3351..T-3355),
//! played on the real host: the App placed twice by [`Harness`], the gateway a mock that answers
//! below the App's own Endpoint alone, so a call anywhere else is never answered.
//!
//! ```json
//! {
//!   "gateway": [{"path": "/ngsi-ld/v1/entities", "query": {"type": "Alert"}, "file": "host-test/alerts.json"}],
//!   "steps": [
//!     {"call": "POST /api/reports", "body": {"title": "t"}, "status": 201, "save": {"report": "/id"}},
//!     {"call": "GET /api/reports/{report}", "status": 200, "expect": {"/title": "t"}, "length": {"/places": 0}},
//!     {"call": "POST /api/reports/{report}/snapshot", "status": 200, "upload": "/url"},
//!     {"call": "GET /api/reports/{report}/snapshot", "status": 200, "download": "/url"},
//!     {"call": "GET /api/reports", "as": "second", "status": 200, "length": {"": 0}}
//!   ]
//! }
//! ```
//!
//! `gateway[].path` is below the Endpoint (`/api/endpoint/<slug>`), a `file` relative to
//! `server/`. A step's `{name}` is what an earlier step's `save` took; `upload` puts bytes to the
//! URL at that pointer and `download` reads them back, or with `downloaded` checks that what the
//! App wrote holds that text; `as: "second"` calls as the second App, which every scenario must
//! do at least once. Needs the variables of src/lib.rs.

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::Value;
use wasm_apps_harness::{fetch, Harness};
use wiremock::matchers::{header, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

const TOKEN: &str = "tok-scenario";
const BYTES: &str = "jc-host-test";

fn apps() -> Vec<String> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps");
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .expect("apps/")
        .filter_map(|e| e.ok())
        .filter(|e| e.path().join("server/host-test.json").is_file())
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    names.sort();
    names
}

fn text(value: &Value, at: &str) -> String {
    value
        .as_str()
        .unwrap_or_else(|| panic!("{at}: not a string: {value}"))
        .to_owned()
}

async fn play(app: &str) {
    let server = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps")
        .join(app)
        .join("server");
    let scenario: Value = serde_json::from_str(
        &std::fs::read_to_string(server.join("host-test.json")).expect("host-test.json"),
    )
    .unwrap_or_else(|err| panic!("{app}/server/host-test.json: {err}"));
    let slug = wasm_apps_harness::slug(app);

    let gateway = MockServer::start().await;
    for answer in scenario["gateway"].as_array().into_iter().flatten() {
        let file = text(&answer["file"], "gateway[].file");
        let body =
            std::fs::read(server.join(&file)).unwrap_or_else(|err| panic!("{app}: {file}: {err}"));
        let mut mock = Mock::given(method("GET"))
            .and(path(format!(
                "/api/endpoint/{slug}{}",
                text(&answer["path"], "gateway[].path")
            )))
            .and(header("authorization", format!("Bearer {TOKEN}").as_str()));
        for (key, value) in answer["query"].as_object().into_iter().flatten() {
            mock = mock.and(query_param(key.as_str(), text(value, key).as_str()));
        }
        let status = answer["status"].as_u64().unwrap_or(200) as u16;
        mock.respond_with(ResponseTemplate::new(status).set_body_raw(body, "application/json"))
            .mount(&gateway)
            .await;
    }

    let harness = Harness::new(app, gateway).await;
    let http = reqwest::Client::new();
    let mut saved: BTreeMap<String, String> = BTreeMap::new();
    let mut second_acted = false;
    for (n, step) in scenario["steps"]
        .as_array()
        .expect("steps")
        .iter()
        .enumerate()
    {
        let call = text(&step["call"], "call");
        let (verb, target) = call
            .split_once(' ')
            .unwrap_or_else(|| panic!("{app} step {n}: call is `VERB /path`"));
        let mut target = target.to_owned();
        for (key, value) in &saved {
            target = target.replace(&format!("{{{key}}}"), value);
        }
        let caller = match step["as"].as_str() {
            None => &harness.first,
            Some("second") => {
                second_acted = true;
                &harness.second
            }
            Some(other) => panic!("{app} step {n}: unknown caller {other}"),
        };
        let body = step.get("body").map(Value::to_string).unwrap_or_default();
        let (status, answer) = harness
            .call(caller, verb, &target, &body, Some(TOKEN))
            .await;
        let at = format!("{app} step {n} ({verb} {target})");
        assert_eq!(
            Some(u64::from(status)),
            step["status"].as_u64(),
            "{at}: {answer}"
        );
        for (pointer, want) in step["expect"].as_object().into_iter().flatten() {
            assert_eq!(
                answer.pointer(pointer),
                Some(want),
                "{at} {pointer}: {answer}"
            );
        }
        for (pointer, want) in step["length"].as_object().into_iter().flatten() {
            let got = answer
                .pointer(pointer)
                .and_then(Value::as_array)
                .map(Vec::len);
            assert_eq!(
                got.map(|n| n as u64),
                want.as_u64(),
                "{at} length of {pointer}: {answer}"
            );
        }
        for (key, pointer) in step["save"].as_object().into_iter().flatten() {
            let value = match answer.pointer(&text(pointer, key)) {
                Some(Value::String(text)) => text.clone(),
                Some(Value::Number(number)) => number.to_string(),
                other => panic!("{at}: nothing to save at {pointer}: {other:?}"),
            };
            saved.insert(key.clone(), value);
        }
        if let Some(pointer) = step["upload"].as_str() {
            let url = answer
                .pointer(pointer)
                .and_then(Value::as_str)
                .expect("an upload URL");
            let put = http.put(url).body(BYTES).send().await.expect("upload");
            assert_eq!(put.status(), 200, "{at}: the upload");
        }
        if let Some(pointer) = step["download"].as_str() {
            let url = answer
                .pointer(pointer)
                .and_then(Value::as_str)
                .expect("a download URL");
            let (status, got) = fetch(url).await;
            assert_eq!(status, 200, "{at}: the download");
            match step["downloaded"].as_str() {
                Some(part) => assert!(got.contains(part), "{at}: the download holds {got}"),
                None => assert_eq!(got, BYTES, "{at}: the download"),
            }
        }
    }
    assert!(
        second_acted,
        "{app}: no step runs `as: \"second\"`, so nothing shows the App's data is its own"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn every_scenario_plays_on_the_host() {
    let apps = apps();
    assert!(!apps.is_empty(), "no apps/*/server/host-test.json");
    for app in apps {
        play(&app).await;
    }
}
