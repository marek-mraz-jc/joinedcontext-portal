//! Testing a saved DataSource's connection (T-4819, MF-39): the source's own input, rendered as
//! the reconciler renders it for a pipeline, runs as an ephemeral stream on the project's runner
//! until its first records or three seconds, and the answer is those records or why there were
//! none. The connection is the stored manifest's, never one the caller sends, so the runner fills
//! no `${VAR}` a live pipeline of this source would not fill too; the answer carries the records
//! and the error's last clause, never the rendered configuration.

use axum::extract::{Path, State};
use axum::routing::post;
use axum::{Json, Router};
use jc_core::kinds::data_source::{refused_target, DataSourceSpec, DataSourceType};
use jc_core::kinds::{PipelineSpec, Verb};
use jcctl::bento::{input_of, prepended_processors, InputContext};
use jcctl::pipeline_test::{harness, Sample, SampleFormat, FETCH_FAILED};
use serde_json::{json, Value};

use crate::api::dry_run::Probe;
use crate::api::pipeline_test::{answer_of, run_stream};
use crate::auth::CurrentUser;
use crate::error::{ApiError, ProblemDetails};
use crate::resource::is_dns1123;
use crate::state::AppState;

/// The bytes of one record the answer keeps; a larger message is cut, and shows as text.
const RECORD_BYTES: usize = 64 * 1024;

/// The runner configuration that reads `source` once and posts each record to `capture`.
///
/// An `http` source is one fetch by the `http` processor, as the reconciler polls it: Bento's
/// `http_client` input polls without pause (T-1192). Every other input runs as it would live;
/// the stream is deleted once the wait ends.
pub(crate) fn connection_test(
    name: &str,
    project: &str,
    source: &DataSourceSpec,
    capture: &str,
) -> Result<Value, ApiError> {
    let context = InputContext::new(name, project, "connection-test");
    let input = serde_json::to_value(input_of(source, &context))
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    // The allow-list a pipeline step is held to (PL-07), over every address the input names.
    if let Some(reason) = refused_target(&input.to_string()) {
        return Err(ApiError::BadRequest(format!(
            "the source's address: {reason}"
        )));
    }
    let (input, mut processors) = match (&source.source_type, input) {
        (DataSourceType::Http | DataSourceType::GtfsRt, Value::Object(mut map)) => {
            let mut fetch = map.remove("http_client").unwrap_or_else(|| json!({}));
            fetch["timeout"] = json!("3s");
            fetch["retries"] = json!(0);
            (
                json!({ "generate": { "count": 1, "interval": "", "mapping": "root = \"\"" } }),
                vec![json!({ "http": fetch })],
            )
        }
        (_, input) => (input, Vec::new()),
    };
    for processor in prepended_processors(source, &context) {
        processors
            .push(serde_json::to_value(processor).map_err(|e| ApiError::Internal(e.to_string()))?);
    }
    // The envelope the capture route reads: the record as text, or the read's error, worded as
    // the probe words a failed fetch.
    processors.push(json!({ "mapping": format!(concat!(
        "root = {{}}\n",
        "root.input = if errored() {{ \"\" }} else {{ content().string().slice(0, {}) }}\n",
        "root.error = if errored() {{ \"{}\" + error() }} else {{ null }}"
    ), RECORD_BYTES, FETCH_FAILED) }));
    processors.push(json!({ "catch": [] }));

    // The output, with the runner's own credential for the capture route, is the harness's.
    let probe: PipelineSpec = serde_json::from_value(json!({
        "class": "auto",
        "targetEndpoint": "urn:ngsi-ld:Endpoint:probe.local:probe:probe"
    }))
    .map_err(|e| ApiError::Internal(e.to_string()))?;
    let sample = Sample {
        text: Some(String::new()),
        url: None,
        format: SampleFormat::Text,
    };
    let mut config =
        harness(&probe, &sample, capture).map_err(|e| ApiError::Internal(e.to_string()))?;
    config["input"] = input;
    config["pipeline"] = json!({ "processors": processors });
    Ok(config)
}

/// `POST /api/v1/projects/{project}/datasources/{name}/test` (T-4819, MF-39).
#[utoipa::path(
    post,
    path = "/api/v1/projects/{project}/datasources/{name}/test",
    summary = "Data Source Connection Test",
    description = "Reads a saved data source once on the project's runner and answers its first \
                   record, or why there was none. Nothing is written.",
    tag = "datasources",
    params(
        ("project" = String, Path, description = "Project slug"),
        ("name" = String, Path, description = "DataSource name"),
    ),
    responses(
        (status = 200, description = "The records read in three seconds and the first of them, \
                                      or `skipped` with the reason in plain words", body = Probe),
        (status = 400, description = "The saved source's URL is one the runner may not reach", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "No grant proposes a DataSource in this project", body = ProblemDetails),
        (status = 404, description = "No such DataSource in this project", body = ProblemDetails),
        (status = 409, description = "A test of this project is already running", body = ProblemDetails),
        (status = 503, description = "No pipeline runner is configured, or it did not answer", body = ProblemDetails)
    )
)]
pub async fn test_datasource(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((project, name)): Path<(String, String)>,
) -> Result<Json<Probe>, ApiError> {
    let unknown = || ApiError::NotFound(format!("no DataSource {name} in project {project}"));
    if !(is_dns1123(&project) && is_dns1123(&name)) {
        return Err(unknown());
    }
    let effective = crate::permissions::for_request(&state, &user.0.identity, &project);
    if !effective.may_read_project() {
        return Err(unknown());
    }
    let envelope = state
        .mirror
        .get(&project, "DataSource", &name)
        .ok_or_else(unknown)?;
    let manifest =
        serde_json::to_value(&envelope).map_err(|e| ApiError::Internal(e.to_string()))?;
    // Running a source on the runner is what proposing one is for: a reader sees it, an author tests it.
    effective.check("DataSource", Verb::Propose, Some(&manifest))?;
    let source: DataSourceSpec = serde_json::from_value(envelope.spec.clone())
        .map_err(|e| ApiError::BadRequest(format!("the saved source does not parse: {e}")))?;
    let trace = run_stream(&state, &project, |capture| {
        connection_test(&name, &project, &source, capture)
    })
    .await?;
    Ok(Json(answer_of(trace)))
}

pub fn router() -> Router<AppState> {
    Router::new().route(
        "/projects/{project}/datasources/{name}/test",
        post(test_datasource),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(value: Value) -> DataSourceSpec {
        serde_json::from_value(value).expect("a DataSource spec")
    }

    #[test]
    fn an_http_source_is_one_fetch_with_a_short_timeout() {
        let source =
            spec(json!({ "type": "http", "http": { "url": "https://feeds.example/aq.json" } }));
        let config = connection_test("aq", "helsinki", &source, "http://portal/x").expect("config");
        assert_eq!(config["input"]["generate"]["count"], 1);
        let fetch = &config["pipeline"]["processors"][0]["http"];
        assert_eq!(fetch["url"], "https://feeds.example/aq.json");
        assert_eq!(fetch["timeout"], "3s");
        assert_eq!(fetch["retries"], 0);
        assert_eq!(config["output"]["http_client"]["url"], "http://portal/x");
    }

    #[test]
    fn a_runner_input_runs_as_written_and_each_record_is_cut() {
        let source = spec(json!({
            "type": "nats",
            "input": { "urls": ["nats://demo-nats:4222"], "subject": "helsinki.demo.counters" }
        }));
        let config = connection_test("demo-counters", "helsinki", &source, "http://portal/x")
            .expect("config");
        assert_eq!(config["input"]["nats"]["subject"], "helsinki.demo.counters");
        let text = config["pipeline"].to_string();
        assert!(
            text.contains(&format!("slice(0, {RECORD_BYTES})")),
            "{text}"
        );
    }

    #[test]
    fn an_address_the_runner_may_not_reach_is_refused_before_anything_runs() {
        for source in [
            json!({ "type": "http", "http": { "url": "http://169.254.169.254/latest" } }),
            json!({ "type": "nats", "input": { "urls": ["nats://127.0.0.1:4222"], "subject": "x" } }),
        ] {
            assert!(
                matches!(
                    connection_test("meta", "helsinki", &spec(source.clone()), "http://portal/x"),
                    Err(ApiError::BadRequest(_))
                ),
                "{source}"
            );
        }
    }
}
