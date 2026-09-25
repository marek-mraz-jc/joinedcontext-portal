//! The Portal's own Prometheus surface (OPS-16, TS-22), and the one log format it writes
//! (OPS-15, [`log_subscriber`]).
//!
//! `components/monitoring` scrapes `/metrics` on the Portal's `http` port every fifteen
//! seconds. That is the same port APISIX publishes the Portal on, so the edge refuses this
//! one path (`components/portal/apisix-routes.yaml`): the series stay inside the cluster the
//! way `components/monitoring/README.md` says they do.
//!
//! Every series is named here and nowhere else. Labels are bounded by what the Portal
//! declares — a route pattern, a lane, a kind — and never by a project name, a resource name
//! or anything else a caller writes, because an unbounded label is a memory leak with a
//! disclosure attached.

use std::sync::OnceLock;
use std::time::Instant;

use axum::extract::{MatchedPath, Request};
use axum::http::header::CONTENT_TYPE;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use metrics_exporter_prometheus::{Matcher, PrometheusBuilder, PrometheusHandle};
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::EnvFilter;

use crate::change::Lane;
use crate::state::AppState;

/// The Prometheus text format, the version every scraper since 2014 reads.
pub const TEXT_FORMAT: &str = "text/plain; version=0.0.4";

/// OPS-15: one JSON object per line, the event's fields at the top level beside `level`,
/// `target` and `timestamp`, written to `writer` (stdout in the binary) and never to a file.
pub fn log_subscriber<W>(writer: W, filter: EnvFilter) -> impl tracing::Subscriber + Send + Sync
where
    W: for<'w> MakeWriter<'w> + Send + Sync + 'static,
{
    tracing_subscriber::fmt()
        .json()
        .flatten_event(true)
        .with_env_filter(filter)
        .with_writer(writer)
        .finish()
}

/// `RUST_LOG`, or `info` and above when it is unset, empty or unreadable.
pub fn log_filter() -> EnvFilter {
    EnvFilter::builder()
        .with_default_directive(tracing::level_filters::LevelFilter::INFO.into())
        .from_env_lossy()
}

/// Requests the Portal answered, by route and status.
const REQUESTS: &str = "jc_portal_requests_total";
/// How long it took to answer one.
const REQUEST_SECONDS: &str = "jc_portal_request_duration_seconds";
/// Changes proposed, by the lane they were classified into and the kind they touch (CC-63).
const CHANGES: &str = "jc_portal_changes_total";
/// Seconds from agent run creation to first frame preview.
const FIRST_FRAME_SECONDS: &str = "jc_agent_run_first_frame_seconds";
/// Seconds from agent run creation to first generated version.
const FIRST_VERSION_SECONDS: &str = "jc_agent_run_first_version_seconds";

/// Seconds from a person's message to the assistant's answer (AG-72, T-2771).
const ANSWER_SECONDS: &str = "jc_agent_answer_duration_seconds";
/// Seconds one model call took through the proxy, by run kind.
const MODEL_CALL_SECONDS: &str = "jc_agent_model_call_duration_seconds";
/// Tokens of the model calls, by run kind and part (`input`, `output`, `cached`).
const MODEL_TOKENS: &str = "jc_agent_model_tokens_total";
/// Runs that ended, by kind and final status.
const RUNS_FINISHED: &str = "jc_agent_runs_finished_total";
/// Tool steps the assistant took, by tool and outcome.
const TOOL_STEPS: &str = "jc_agent_tool_steps_total";

/// The paths that describe the process rather than the traffic.
const UNCOUNTED: &[&str] = &["/metrics", "/api/v1/health"];

/// The bucket edges every duration here is counted into, in seconds.
///
/// Without them the exporter renders a duration as a *summary*: a quantile computed inside one
/// replica, and quantiles from two replicas cannot be combined into one. Buckets can be summed,
/// so `histogram_quantile` over these stays correct however many Portal pods are running.
const SECONDS: &[f64] = &[
    0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0,
];

/// The bucket edges of a run's timings: a first version is promised inside a minute (AG-66).
const RUN_SECONDS: &[f64] = &[
    1.0, 2.5, 5.0, 10.0, 15.0, 20.0, 30.0, 45.0, 60.0, 90.0, 120.0, 300.0,
];

/// The bucket edges of an answer and of a model call: the answer is promised in 3 s at p50 and
/// 8 s at p95, and alerted on above 10 s (AG-72).
const ANSWER_BUCKETS: &[f64] = &[
    0.25, 0.5, 1.0, 2.0, 3.0, 5.0, 8.0, 10.0, 15.0, 20.0, 30.0, 60.0, 120.0,
];

fn handle() -> &'static PrometheusHandle {
    static HANDLE: OnceLock<PrometheusHandle> = OnceLock::new();
    HANDLE.get_or_init(|| {
        let handle = PrometheusBuilder::new()
            .set_buckets(SECONDS)
            .expect("the bucket list is not empty")
            .set_buckets_for_metric(Matcher::Prefix("jc_agent_run_".to_owned()), RUN_SECONDS)
            .expect("the bucket list is not empty")
            .set_buckets_for_metric(Matcher::Full(ANSWER_SECONDS.to_owned()), ANSWER_BUCKETS)
            .expect("the bucket list is not empty")
            .set_buckets_for_metric(Matcher::Full(MODEL_CALL_SECONDS.to_owned()), ANSWER_BUCKETS)
            .expect("the bucket list is not empty")
            .install_recorder()
            .expect("this process installs the one recorder");
        metrics::describe_counter!(REQUESTS, "requests answered by the Portal");
        metrics::describe_histogram!(REQUEST_SECONDS, "seconds to answer one request");
        metrics::describe_counter!(CHANGES, "changes proposed, by lane and kind");
        metrics::describe_histogram!(
            FIRST_FRAME_SECONDS,
            "seconds from agent run creation to first frame preview"
        );
        metrics::describe_histogram!(
            FIRST_VERSION_SECONDS,
            "seconds from agent run creation to first generated version"
        );
        metrics::describe_histogram!(ANSWER_SECONDS, "seconds from a message to the answer");
        metrics::describe_histogram!(MODEL_CALL_SECONDS, "seconds one model call took");
        metrics::describe_counter!(MODEL_TOKENS, "model tokens, by run kind and part");
        metrics::describe_counter!(RUNS_FINISHED, "agent runs ended, by kind and status");
        metrics::describe_counter!(TOOL_STEPS, "assistant tool steps, by tool and outcome");
        handle
    })
}

/// Installs the recorder. Called when the router is built: the `metrics::` macros no-op until
/// a recorder exists, so a Portal that starts serving before this runs counts nothing.
pub fn install() {
    let _ = handle();
}

async fn metrics() -> Response {
    ([(CONTENT_TYPE, TEXT_FORMAT)], handle().render()).into_response()
}

/// One proposed change, as it was classified (CC-63, MF-21).
///
/// The lane is the number worth watching: a rise in red proposals is a change in what people
/// are asking the platform to do, and no other component can see it.
pub fn proposed(lane: Lane, kind: &'static str) {
    metrics::counter!(
        CHANGES,
        "lane" => match lane {
            Lane::Green => "green",
            Lane::Yellow => "yellow",
            Lane::Red => "red",
        },
        "kind" => kind,
    )
    .increment(1);
}

/// Records agent run timings in seconds (`first_frame` or `first_version`), labelled by profile.
pub fn record_run_timing(kind: &'static str, profile: &str, ms: i64) {
    let seconds = (ms as f64) / 1000.0;
    match kind {
        "first_frame" => {
            metrics::histogram!(FIRST_FRAME_SECONDS, "profile" => profile.to_owned())
                .record(seconds);
        }
        "first_version" => {
            metrics::histogram!(FIRST_VERSION_SECONDS, "profile" => profile.to_owned())
                .record(seconds);
        }
        _ => {
            tracing::warn!(kind, "unknown run timing kind");
        }
    }
}

/// A run kind as a label: one of the kinds a run is started for, anything else `other`, so a
/// label never carries what a caller wrote (T-2771).
fn run_kind(kind: &str) -> &'static str {
    crate::agents::run::RUN_KINDS
        .into_iter()
        .find(|known| *known == kind)
        .unwrap_or("other")
}

/// One answer of the assistant, however it ended.
pub fn answered(seconds: f64) {
    metrics::histogram!(ANSWER_SECONDS).record(seconds);
}

/// One model call as the proxy reported it in a `usage` frame: its latency and tokens. The
/// frame's `model` is left out: a workspace writes the body the proxy read it from.
pub fn model_call(kind: &str, usage: &serde_json::Value) {
    let kind = run_kind(kind);
    let number = |key: &str| usage.get(key).and_then(serde_json::Value::as_u64);
    if let Some(ms) = number("latencyMs") {
        metrics::histogram!(MODEL_CALL_SECONDS, "kind" => kind).record(ms as f64 / 1000.0);
    }
    for (part, key) in [
        ("input", "inputTokens"),
        ("output", "outputTokens"),
        ("cached", "cachedTokens"),
    ] {
        if let Some(tokens) = number(key).filter(|tokens| *tokens > 0) {
            metrics::counter!(MODEL_TOKENS, "kind" => kind, "part" => part).increment(tokens);
        }
    }
}

/// One run that reached a final status.
pub fn run_finished(kind: &str, status: crate::agents::run::AgentRunStatus) {
    metrics::counter!(RUNS_FINISHED, "kind" => run_kind(kind), "status" => status.as_str())
        .increment(1);
}

/// One `tool` step: the tool when it is one of the assistant's or a registered operation,
/// `other` for any other name (a model writes it), and `ok` or `failed`.
pub fn tool_step(step: &serde_json::Value) {
    let named = step.get("tool").and_then(serde_json::Value::as_str);
    let tool = named
        .and_then(|name| crate::ops::find(name).map(|op| op.name))
        .or_else(|| named.and_then(crate::agents::paths::known_tool))
        .unwrap_or("other");
    let status = match step.get("status").and_then(serde_json::Value::as_str) {
        Some("ok") => "ok",
        _ => "failed",
    };
    metrics::counter!(TOOL_STEPS, "tool" => tool, "status" => status).increment(1);
}

/// Counts and times every request the Portal answers.
pub async fn record(request: Request, next: Next) -> Response {
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map(|matched| matched.as_str().to_owned())
        // The static handler serves the single-page application, and every deep link of it
        // is one route as far as the Portal is concerned.
        .unwrap_or_else(|| "ui".to_owned());
    if UNCOUNTED.contains(&route.as_str()) {
        return next.run(request).await;
    }

    let method = request.method().as_str().to_owned();
    let started = Instant::now();
    let response = next.run(request).await;
    let seconds = started.elapsed().as_secs_f64();

    metrics::counter!(
        REQUESTS,
        "route" => route.clone(),
        "method" => method.clone(),
        "status" => response.status().as_u16().to_string(),
    )
    .increment(1);
    metrics::histogram!(REQUEST_SECONDS, "route" => route, "method" => method).record(seconds);
    response
}

/// The scrape, outside `/api/v1` and outside its CSRF and session guards: it carries no
/// request of anyone's and is refused at the edge.
pub fn router() -> Router<AppState> {
    Router::new().route("/metrics", get(metrics))
}

#[cfg(test)]
mod log_tests {
    use std::io::Write;
    use std::sync::{Arc, Mutex};

    use serde_json::Value;

    use tracing_subscriber::EnvFilter;

    use super::log_subscriber;

    #[derive(Clone, Default)]
    struct Buffer(Arc<Mutex<Vec<u8>>>);

    impl Write for Buffer {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().expect("buffer").extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// OPS-15: every line the Portal logs is one JSON object a collector parses without a
    /// pattern, and what is below the level is not written at all.
    #[test]
    fn every_log_line_is_one_json_object_and_debug_stays_out() {
        let buffer = Buffer::default();
        let writer = buffer.clone();
        tracing::subscriber::with_default(
            log_subscriber(move || writer.clone(), EnvFilter::new("info")),
            || {
                tracing::info!(project = "ovzdusie", status = 409, "change refused");
                tracing::debug!("not written at info");
            },
        );
        let written = String::from_utf8(buffer.0.lock().expect("buffer").clone()).expect("utf-8");
        let lines: Vec<Value> = written
            .lines()
            .map(|line| serde_json::from_str(line).unwrap_or_else(|e| panic!("{e}: {line}")))
            .collect();
        assert_eq!(lines.len(), 1, "{written}");
        assert_eq!(lines[0]["level"], "INFO");
        assert_eq!(lines[0]["message"], "change refused");
        assert_eq!(lines[0]["project"], "ovzdusie");
        assert_eq!(lines[0]["status"], 409);
        assert!(lines[0]["timestamp"].is_string(), "{written}");
    }
}

#[cfg(test)]
mod agent_series_tests {
    use serde_json::json;

    use crate::agents::run::AgentRunStatus;

    /// T-2771: the assistant's series exist under the names the dashboard and the alerts read,
    /// and their labels carry only what the Portal declares: a run kind or `other`, a known tool
    /// or `other`, never the model a workspace named or a word a model made up.
    #[test]
    fn the_assistant_series_carry_only_bounded_labels() {
        super::install();
        super::answered(2.4);
        super::model_call(
            "conversation",
            &json!({ "latencyMs": 1830, "inputTokens": 3980, "outputTokens": 140, "cachedTokens": 3200, "model": "secret/model-name" }),
        );
        super::model_call("made-up-kind", &json!({ "latencyMs": 10 }));
        super::run_finished("conversation", AgentRunStatus::Expired);
        super::tool_step(&json!({ "tool": "search_catalog", "status": "ok" }));
        super::tool_step(&json!({ "tool": "rm -rf /", "status": "failed" }));
        super::tool_step(&json!({ "tool": "jc_pipeline_test" }));
        let text = super::handle().render();
        for series in [
            "jc_agent_answer_duration_seconds_bucket",
            "jc_agent_model_call_duration_seconds_bucket{kind=\"conversation\"",
            "jc_agent_model_call_duration_seconds_bucket{kind=\"other\"",
            "jc_agent_model_tokens_total{kind=\"conversation\",part=\"cached\"} 3200",
            "jc_agent_runs_finished_total{kind=\"conversation\",status=\"expired\"} 1",
            "jc_agent_tool_steps_total{tool=\"search_catalog\",status=\"ok\"} 1",
            "jc_agent_tool_steps_total{tool=\"other\",status=\"failed\"} 1",
            "jc_agent_tool_steps_total{tool=\"jc_pipeline_test\",status=\"failed\"} 1",
        ] {
            assert!(text.contains(series), "{series} in\n{text}");
        }
        assert!(!text.contains("secret/model-name") && !text.contains("rm -rf"));
        assert!(!text.contains("made-up-kind"));
    }
}
