//! Runtime numbers of one Bento stream, read from the project's pipeline runner.
//!
//! The runner serves Prometheus text on its own port (PL-24). The Portal scrapes it for the
//! browser so the UI never talks to a workload directly and the runner needs no ingress; the
//! response carries counters only, never logs, configuration or secret values (PL-17).

use std::sync::OnceLock;
use std::time::Duration;

use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;
use serde_json::Value;
use utoipa::ToSchema;

use crate::auth::CurrentUser;
use crate::error::{ApiError, ProblemDetails};
use crate::resource::is_dns1123;
use crate::state::AppState;

/// How long the runner has to answer. A metrics port that is slow is a runner that is busy
/// ingesting; the view would rather show the pipeline without numbers than hang on it.
const SCRAPE_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Default, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PipelineMetrics {
    pub pipeline: String,
    /// When the Portal read the runner, RFC 3339. The counters are as old as this instant.
    pub scraped_at: String,
    /// Cumulative since the runner started, exactly as it reports them: a rate is the view's
    /// job, history is Prometheus' job (OPS-16). An absent field is not zero, it is a counter
    /// this runner does not export.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub received: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sent: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub errors: Option<u64>,
    /// Records the validation stage refused since the runner started (PL-61): counted apart
    /// from `errors`, because a refused record is the stage working, not the stream failing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rejected: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub buffer_depth: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_p99_ms: Option<f64>,
    /// The same counters per component of the stream, by the Bento `label` the reconciler
    /// wrote (T-1125): the studio paints a node with the numbers of its own label. Empty for a
    /// stream deployed before the labels, whose samples carry none.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub nodes: std::collections::BTreeMap<String, NodeCounters>,
}

/// One sample line of the Prometheus text exposition format.
struct Sample<'a> {
    name: &'a str,
    labels: &'a str,
    value: f64,
}

fn parse_line(line: &str) -> Option<Sample<'_>> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let (name, labels, rest) = match line.split_once('{') {
        Some((name, tail)) => {
            let (labels, rest) = tail.split_once('}')?;
            (name, labels, rest)
        }
        None => {
            let (name, rest) = line.split_once(' ')?;
            (name, "", rest)
        }
    };
    let value = rest.split_whitespace().next()?.parse().ok()?;
    Some(Sample {
        name: name.trim(),
        labels,
        value,
    })
}

/// Reads one label. Bento's label values are stream names, metric paths and quantiles, so the
/// escaping rules of the exposition format never come up; a value with an escaped quote in it
/// would simply not match.
fn label<'a>(labels: &'a str, key: &str) -> Option<&'a str> {
    labels.split(',').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k.trim() == key).then(|| v.trim().trim_matches('"'))
    })
}

/// The counter a metric name stands for. Bento is a Benthos fork: the names keep the
/// `input_received` / `output_sent` shape and a deployment may prefix them (`bento_`) or
/// suffix a counter with `_total`, so a family is matched by suffix, never by equality.
fn family(name: &str) -> Option<Family> {
    let name = name.strip_suffix("_total").unwrap_or(name);
    if name.ends_with("input_received") {
        Some(Family::Received)
    } else if name.ends_with("output_sent") {
        Some(Family::Sent)
    } else if name.ends_with("output_error") || name.ends_with("processor_error") {
        Some(Family::Errors)
    } else if name.ends_with("buffer_backlog") {
        Some(Family::BufferDepth)
    } else if name.ends_with("output_latency_ns") {
        Some(Family::LatencyNs)
    } else {
        None
    }
}

enum Family {
    Received,
    Sent,
    Errors,
    BufferDepth,
    LatencyNs,
}

/// Folds every series of one stream into the counters the view shows. Series of the same family
/// are summed (a stream may have several inputs or outputs); the latency takes the slowest
/// output rather than a sum, which would mean nothing.
/// The runner registers each stream under the pipeline's own name, so the pipeline name is
/// also the `stream` label to select on.
/// What one component of a stream counted, as its own label reports it (T-1125).
#[derive(Debug, Default, Clone, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NodeCounters {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub received: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sent: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub errors: Option<u64>,
}

pub(crate) fn scrape(body: &str, pipeline: &str, scraped_at: String) -> PipelineMetrics {
    let mut metrics = PipelineMetrics {
        pipeline: pipeline.to_string(),
        scraped_at,
        ..PipelineMetrics::default()
    };

    for sample in body.lines().filter_map(parse_line) {
        if label(sample.labels, "stream") != Some(pipeline) {
            continue;
        }
        let Some(family) = family(sample.name) else {
            continue;
        };
        // The outcome sink and the pass report say what the stream did; their own sends and
        // errors are not the stream's (PL-62, T-3001).
        if label(sample.labels, "label").is_some_and(|node| {
            node == crate::pipeline_log::SINK_LABEL
                || crate::pipeline_log::PASS_LABELS.contains(&node)
        }) {
            continue;
        }
        let add = |slot: &mut Option<u64>| *slot = Some(slot.unwrap_or(0) + sample.value as u64);
        // The component's own counters, kept beside the stream's total so the studio can paint
        // the node where a message stopped rather than only the pipeline that stopped.
        if let Some(node) = label(sample.labels, "label").filter(|one| !one.is_empty()) {
            let counters = metrics.nodes.entry(node.to_owned()).or_default();
            let slot = match family {
                Family::Received => Some(&mut counters.received),
                Family::Sent => Some(&mut counters.sent),
                Family::Errors => Some(&mut counters.errors),
                _ => None,
            };
            if let Some(slot) = slot {
                *slot = Some(slot.unwrap_or(0) + sample.value as u64);
            }
        }
        let staged = label(sample.labels, "label")
            .is_some_and(|node| crate::pipeline_validation::STAGE_LABELS.contains(&node));
        match family {
            Family::Received => add(&mut metrics.received),
            Family::Sent => add(&mut metrics.sent),
            Family::Errors if staged => add(&mut metrics.rejected),
            Family::Errors => add(&mut metrics.errors),
            Family::BufferDepth => add(&mut metrics.buffer_depth),
            Family::LatencyNs => {
                if label(sample.labels, "quantile") == Some("0.99") {
                    let ms = sample.value / 1_000_000.0;
                    metrics.latency_p99_ms =
                        Some(metrics.latency_p99_ms.map_or(ms, |seen| seen.max(ms)));
                }
            }
        }
    }

    metrics
}

pub(crate) fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(SCRAPE_TIMEOUT)
            .build()
            .unwrap_or_default()
    })
}

#[utoipa::path(
    get,
    path = "/api/v1/projects/{project}/pipelines/{name}/metrics",
    summary = "Read Pipeline Counters",
    description = "What the runner has counted for one pipeline: state, messages, errors and latency.",
    tag = "resources",
    params(
        ("project" = String, Path, description = "Project name"),
        ("name" = String, Path, description = "Pipeline name"),
    ),
    responses(
        (status = 200, description = "Runtime counters of the stream", body = PipelineMetrics),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 404, description = "Pipeline not found", body = ProblemDetails),
        (status = 503, description = "No runner configured, or it did not answer", body = ProblemDetails)
    )
)]
pub async fn get_metrics(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((project, name)): Path<(String, String)>,
) -> Result<Json<PipelineMetrics>, ApiError> {
    // PF-59, T-0983: counters say a pipeline of this name runs here and how it is doing, so a
    // caller who may not read the project's pipelines is answered as if it were not there
    // rather than handed its throughput. `metrics_for` itself stays open: the catalog search
    // calls it behind its own access filter (AG-58).
    let effective = crate::permissions::for_request(&state, &user.0.identity, &project);
    if !effective.may_read_project() || !effective.may_read("Pipeline") {
        return Err(ApiError::NotFound(format!(
            "pipeline '{name}' not found in project '{project}'"
        )));
    }
    Ok(Json(metrics_for(&state, &project, &name).await?))
}

/// The runner's counters for one pipeline; the read behind the metrics route and the
/// assistant's diagnostics door (AG-57).
pub async fn metrics_for(
    state: &AppState,
    project: &str,
    name: &str,
) -> Result<PipelineMetrics, ApiError> {
    let not_found = || ApiError::NotFound(format!("pipeline '{name}' not found in '{project}'"));
    // The names go into the runner URL, so they are checked before anything is built from them,
    // and a pipeline that is not mirrored is not disclosed as existing elsewhere (R20).
    if !is_dns1123(project) || !is_dns1123(name) {
        return Err(not_found());
    }
    state
        .mirror
        .get(project, "Pipeline", name)
        .ok_or_else(not_found)?;

    let template = state
        .config
        .pipeline_runner_url
        .as_deref()
        .ok_or_else(|| ApiError::Unavailable("no pipeline runner is configured".into()))?;
    let url = format!(
        "{}/metrics",
        template.replace("{project}", project).trim_end_matches('/')
    );

    let response = http().get(&url).send().await.map_err(|err| {
        // The URL names an internal service; the reason is logged, the caller learns only that
        // the runner is unreachable.
        tracing::warn!(project = %project, error = %err, "pipeline runner metrics unreachable");
        ApiError::Unavailable("the pipeline runner did not answer".into())
    })?;
    if !response.status().is_success() {
        tracing::warn!(project = %project, status = %response.status(), "pipeline runner metrics refused");
        return Err(ApiError::Unavailable(
            "the pipeline runner did not answer".into(),
        ));
    }
    let body = response.text().await.map_err(|err| {
        tracing::warn!(project = %project, error = %err, "pipeline runner metrics unreadable");
        ApiError::Unavailable("the pipeline runner did not answer".into())
    })?;

    Ok(scrape(&body, name, now_rfc3339()))
}

fn now_rfc3339() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

/// One page of a pipeline's rejected records.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RejectedPage {
    pub items: Vec<crate::pipeline_outcomes::Rejected>,
    /// How many the pipeline holds, at most 1000 (PL-61).
    pub total: u64,
    /// The `before` of the next page, when there is one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<i64>,
}

#[derive(Debug, Default, serde::Deserialize, utoipa::IntoParams)]
pub struct RejectedQuery {
    /// Records per page, 1…100 (default 50).
    pub limit: Option<usize>,
    /// Only records older than this id: the `next` of the previous page.
    pub before: Option<i64>,
}

#[utoipa::path(
    get,
    path = "/api/v1/projects/{project}/pipelines/{name}/rejected",
    summary = "List Rejected Records",
    description = "The records the pipeline's validation stage refused and did not write, newest first, each with the rule it broke; secrets masked (PL-61).",
    tag = "pipelines",
    params(
        ("project" = String, Path, description = "Project name"),
        ("name" = String, Path, description = "Pipeline name"),
        RejectedQuery,
    ),
    responses(
        (status = 200, description = "One page of rejected records", body = RejectedPage),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 404, description = "Pipeline not found", body = ProblemDetails),
        (status = 503, description = "The list could not be read", body = ProblemDetails)
    )
)]
pub async fn get_rejected(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((project, name)): Path<(String, String)>,
    axum::extract::Query(query): axum::extract::Query<RejectedQuery>,
) -> Result<Json<RejectedPage>, ApiError> {
    readable_pipeline(&state, &user, &project, &name)?;
    let limit = query.limit.unwrap_or(50).clamp(1, 100);
    let unreadable = |error: sqlx::Error| {
        tracing::warn!(%project, pipeline = %name, %error, "the rejected list could not be read");
        ApiError::Unavailable("the rejected list could not be read; try again".into())
    };
    let items = state
        .rejected
        .list(&project, &name, limit, query.before)
        .await
        .map_err(unreadable)?;
    let total = state
        .rejected
        .count(&project, &name)
        .await
        .map_err(unreadable)?;
    let next = (items.len() == limit)
        .then(|| items.last().map(|r| r.id))
        .flatten();
    Ok(Json(RejectedPage { items, total, next }))
}

/// Read on the pipeline, and a caller without it is told the pipeline is not there (PF-59).
fn readable_pipeline(
    state: &AppState,
    user: &CurrentUser,
    project: &str,
    name: &str,
) -> Result<(), ApiError> {
    let not_found = || {
        ApiError::NotFound(format!(
            "pipeline '{name}' not found in project '{project}'"
        ))
    };
    let effective = crate::permissions::for_request(state, &user.0.identity, project);
    if !effective.may_read_project() || !effective.may_read("Pipeline") {
        return Err(not_found());
    }
    if !is_dns1123(project) || !is_dns1123(name) {
        return Err(not_found());
    }
    state
        .mirror
        .get(project, "Pipeline", name)
        .map(|_| ())
        .ok_or_else(not_found)
}

/// A pipeline's latest runs with their counts (PL-62).
#[derive(Debug, Serialize, ToSchema)]
#[schema(as = PipelineRunList)]
pub struct RunList {
    /// The run with the latest line first, at most 200.
    pub items: Vec<crate::pipeline_log::Run>,
}

#[derive(Debug, Default, serde::Deserialize, utoipa::IntoParams)]
pub struct LogQuery {
    /// Lines per page, 1…500 (default 100).
    pub limit: Option<usize>,
    /// Only lines older than this id: the `next` of the previous page.
    pub before: Option<i64>,
}

/// One page of a run's log.
#[derive(Debug, Serialize, ToSchema)]
#[schema(as = PipelineLogPage)]
pub struct LogPage {
    pub items: Vec<crate::pipeline_log::LogLine>,
    /// The `before` of the next page, when there is one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<i64>,
}

#[utoipa::path(
    get,
    path = "/api/v1/projects/{project}/pipelines/{name}/runs",
    summary = "List Pipeline Runs",
    description = "The pipeline's latest runs, each with how many records it sent, how many the model rejected and how many failed in a step (PL-62). A run is one tick of the pipeline's clock, or one UTC hour for a source that never ends.",
    tag = "pipelines",
    params(
        ("project" = String, Path, description = "Project name"),
        ("name" = String, Path, description = "Pipeline name"),
    ),
    responses(
        (status = 200, description = "The runs, latest first", body = RunList),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 404, description = "Pipeline not found", body = ProblemDetails),
        (status = 503, description = "The runs could not be read", body = ProblemDetails)
    )
)]
pub async fn get_runs(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((project, name)): Path<(String, String)>,
) -> Result<Json<RunList>, ApiError> {
    readable_pipeline(&state, &user, &project, &name)?;
    let items = state
        .pipeline_log
        .runs(&project, &name, crate::pipeline_log::RUNS_KEPT)
        .await
        .map_err(|error| {
            tracing::warn!(%project, pipeline = %name, %error, "the runs could not be read");
            ApiError::Unavailable("the pipeline's runs could not be read; try again".into())
        })?;
    Ok(Json(RunList { items }))
}

#[utoipa::path(
    get,
    path = "/api/v1/projects/{project}/pipelines/{name}/runs/{run}/log",
    summary = "Read a Run's Log",
    description = "One line per record of the run, newest first: the record's id, the step it failed at, its outcome (sent, rejected, failed) and what happened (PL-62). Record ids and messages are masked where they look like a credential.",
    tag = "pipelines",
    params(
        ("project" = String, Path, description = "Project name"),
        ("name" = String, Path, description = "Pipeline name"),
        ("run" = String, Path, description = "The run, as the run list names it"),
        LogQuery,
    ),
    responses(
        (status = 200, description = "One page of the run's log", body = LogPage),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 404, description = "Pipeline not found", body = ProblemDetails),
        (status = 503, description = "The log could not be read", body = ProblemDetails)
    )
)]
pub async fn get_run_log(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((project, name, run)): Path<(String, String, String)>,
    axum::extract::Query(query): axum::extract::Query<LogQuery>,
) -> Result<Json<LogPage>, ApiError> {
    readable_pipeline(&state, &user, &project, &name)?;
    let limit = query.limit.unwrap_or(100).clamp(1, 500);
    let items = state
        .pipeline_log
        .lines(&project, &name, &run, limit, query.before)
        .await
        .map_err(|error| {
            tracing::warn!(%project, pipeline = %name, %error, "a run's log could not be read");
            ApiError::Unavailable("the run's log could not be read; try again".into())
        })?;
    let next = (items.len() == limit)
        .then(|| items.last().map(|line| line.id))
        .flatten();
    Ok(Json(LogPage { items, next }))
}

/// Which rejected records to replay.
#[derive(Debug, serde::Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RetryRequest {
    /// The `id`s of the records, 1…100.
    pub ids: Vec<i64>,
}

/// What a replay sent to the runner, and what it could not send.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RetryAnswer {
    /// Records replayed through the pipeline's current stage and write; one that still breaks
    /// the model comes back to the list with its rule.
    pub replayed: usize,
    /// Records left on the list because a value of theirs was masked when they were kept:
    /// replaying the mask would write it. The pipeline's next read of its source brings them.
    pub masked: Vec<i64>,
}

/// The longest a replay stream is left on the runner before it is deleted.
const REPLAY_WINDOW: Duration = Duration::from_secs(15);

#[utoipa::path(
    post,
    path = "/api/v1/projects/{project}/pipelines/{name}/rejected/retry",
    summary = "Retry Rejected Records",
    description = "Replays the named rejected records once through the pipeline's current validation stage and its own write (PL-61): a record that passes now is written, one that still fails comes back with its rule. Needs propose on Pipeline.",
    tag = "pipelines",
    params(
        ("project" = String, Path, description = "Project name"),
        ("name" = String, Path, description = "Pipeline name"),
    ),
    request_body(content = RetryRequest, example = json!({ "ids": [412, 409] })),
    responses(
        (status = 202, description = "The replay was handed to the runner", body = RetryAnswer),
        (status = 400, description = "No ids, or more than 100", body = ProblemDetails),
        (status = 403, description = "The caller may read the pipeline but not propose it", body = ProblemDetails),
        (status = 404, description = "Pipeline not found", body = ProblemDetails),
        (status = 409, description = "The pipeline's space names no model, so there is no stage to replay through", body = ProblemDetails),
        (status = 503, description = "No runner, or it did not answer", body = ProblemDetails)
    )
)]
pub async fn retry_rejected(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((project, name)): Path<(String, String)>,
    Json(request): Json<RetryRequest>,
) -> Result<(axum::http::StatusCode, Json<RetryAnswer>), ApiError> {
    let not_found = || {
        ApiError::NotFound(format!(
            "pipeline '{name}' not found in project '{project}'"
        ))
    };
    let effective = crate::permissions::for_request(&state, &user.0.identity, &project);
    if !effective.may_read_project() || !effective.may_read("Pipeline") {
        return Err(not_found());
    }
    if !is_dns1123(&project) || !is_dns1123(&name) {
        return Err(not_found());
    }
    let pipeline = state
        .mirror
        .get(&project, "Pipeline", &name)
        .ok_or_else(not_found)?;
    if !effective.may("Pipeline", jc_core::kinds::Verb::Propose) {
        return Err(ApiError::Denied(format!(
            "replaying a rejected record writes through the pipeline, which needs propose on \
             Pipeline in project {project}"
        )));
    }
    if request.ids.is_empty() || request.ids.len() > 100 {
        return Err(ApiError::BadRequest(
            "name between 1 and 100 rejected records by their id".into(),
        ));
    }
    let (space, slug) = replay_target(&state, &project, &pipeline.spec).ok_or_else(|| {
        ApiError::Conflict(format!(
            "pipeline '{name}' writes through no Endpoint this project holds"
        ))
    })?;
    let schema = state.model_schemas.get(&project, &space).ok_or_else(|| {
        ApiError::Conflict(format!(
            "space '{space}' names no data model, so there is no stage to replay through; name \
             its model in spec.dataModelRef (DM-61)"
        ))
    })?;
    let runner = state
        .config
        .pipeline_runner_url
        .as_deref()
        .ok_or_else(|| ApiError::Unavailable("no pipeline runner is configured".into()))?
        .replace("{project}", &project)
        .trim_end_matches('/')
        .to_owned();
    let internal = state
        .config
        .pipeline_test_capture_url
        .as_deref()
        .ok_or_else(|| {
            ApiError::Unavailable("no internal listener is configured for the runner".into())
        })?;

    let unreadable = |error: sqlx::Error| {
        tracing::warn!(%project, pipeline = %name, %error, "the rejected list could not be read");
        ApiError::Unavailable("the rejected list could not be read; try again".into())
    };
    // Only what carries no mask leaves the list: the rest stays, named in the answer.
    let listed = state
        .rejected
        .list(&project, &name, crate::pipeline_outcomes::KEPT, None)
        .await
        .map_err(unreadable)?;
    let (masked, clean): (Vec<_>, Vec<_>) = listed
        .into_iter()
        .filter(|record| request.ids.contains(&record.id))
        .partition(|record| {
            record
                .record
                .to_string()
                .contains(crate::pipeline_outcomes::MASK)
        });
    let clean_ids: Vec<i64> = clean.iter().map(|record| record.id).collect();
    let records: Vec<Value> = state
        .rejected
        .take(&project, &name, &clean_ids)
        .await
        .map_err(unreadable)?
        .into_iter()
        .map(|record| record.record)
        .collect();
    let answer = RetryAnswer {
        replayed: records.len(),
        masked: masked.iter().map(|record| record.id).collect(),
    };
    if records.is_empty() {
        return Ok((axum::http::StatusCode::ACCEPTED, Json(answer)));
    }

    let sink = format!(
        "{}/internal/pipelines/{project}/{name}/rejected",
        internal.trim_end_matches('/')
    );
    let mut config = replay_stream(&records, &project, &slug);
    crate::pipeline_validation::insert_stage(&mut config, &schema, &sink);
    // What the replay writes is a line of the pipeline's log like any run's (PL-62).
    if let Some(output) = config.get_mut("output") {
        let outcomes = format!(
            "{}/internal/pipelines/{project}/{name}/outcomes",
            internal.trim_end_matches('/')
        );
        *output = crate::pipeline_log::with_outcomes(output.take(), &outcomes);
    }
    jcctl::bento::inject_space(
        &mut config,
        &[crate::spaces::segment(&state.mirror, &project, &space)],
    );
    let stream = format!(
        "{runner}/streams/rejected-replay-{}",
        crate::agents::share::slug()
    );
    let created = http().post(&stream).json(&config).send().await;
    let accepted = matches!(&created, Ok(answer) if answer.status().is_success());
    if !accepted {
        // Nothing was replayed: the records go back on the list as they were.
        for record in records {
            let _ = state
                .rejected
                .reject(
                    &project,
                    &name,
                    &record,
                    &crate::pipeline_outcomes::Reason {
                        rule: "runner".into(),
                        path: String::new(),
                        message: "the replay did not reach the runner; retry it".into(),
                        step: None,
                    },
                )
                .await;
        }
        tracing::warn!(%project, pipeline = %name, "the runner refused a replay stream");
        return Err(ApiError::Unavailable(
            "the pipeline runner did not answer".into(),
        ));
    }
    // The stream ends after its one message; it is deleted once it has had its window.
    tokio::spawn(async move {
        tokio::time::sleep(REPLAY_WINDOW).await;
        if let Err(error) = http().delete(&stream).send().await {
            tracing::warn!(%error, "a replay stream was not deleted");
        }
    });
    Ok((axum::http::StatusCode::ACCEPTED, Json(answer)))
}

/// The space and the Endpoint slug the pipeline's first output writes through.
fn replay_target(state: &AppState, project: &str, spec: &Value) -> Option<(String, String)> {
    let spec: jc_core::kinds::pipeline::PipelineSpec = serde_json::from_value(spec.clone()).ok()?;
    let output = spec.outputs().into_iter().next()?;
    let endpoint = state
        .mirror
        .get(project, "Endpoint", output.target_endpoint.local_id())?;
    let space = crate::api::assistant::ref_name(&endpoint.spec["contextSpaceRef"])?;
    let slug = endpoint.spec.get("slug")?.as_str()?.to_owned();
    Some((space, slug))
}

/// One message holding the records, split into one per record, and the pipeline's own write
/// in gateway-sized batches: the stage is put in before the split by the caller.
fn replay_stream(records: &[Value], project: &str, slug: &str) -> Value {
    use base64::Engine;
    let encoded =
        base64::engine::general_purpose::STANDARD.encode(Value::from(records.to_vec()).to_string());
    serde_json::json!({
        "input": { "generate": {
            "count": 1,
            "interval": "",
            "mapping": format!("root = \"{encoded}\".decode(\"base64\")"),
        }},
        "pipeline": { "processors": [
            { "unarchive": { "format": "json_array" } },
            { "split": { "size": 1000 } },
            { "archive": { "format": "json_array" } },
        ]},
        "output": crate::reconciler::streams::gateway_output(project, slug),
    })
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/projects/{project}/pipelines/{name}/rejected/retry",
            axum::routing::post(retry_rejected),
        )
        .route("/projects/{project}/pipelines/{name}/runs", get(get_runs))
        .route(
            "/projects/{project}/pipelines/{name}/runs/{run}/log",
            get(get_run_log),
        )
        .route(
            "/projects/{project}/pipelines/{name}/metrics",
            get(get_metrics),
        )
        .route(
            "/projects/{project}/pipelines/{name}/rejected",
            get(get_rejected),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    const BODY: &str = r#"
# HELP input_received Benthos Counter metric
# TYPE input_received counter
input_received{label="mqtt",path="root.input",stream="aq-mqtt-ingest"} 128401
input_received{label="mqtt",path="root.input",stream="other-stream"} 77
output_sent{label="gateway",path="root.output",stream="aq-mqtt-ingest"} 128390
output_error{label="gateway",path="root.output",stream="aq-mqtt-ingest"} 2
processor_error{label="map",path="root.pipeline.processors.0",stream="aq-mqtt-ingest"} 1
buffer_backlog{stream="aq-mqtt-ingest"} 11
output_latency_ns{stream="aq-mqtt-ingest",quantile="0.5"} 1000000
output_latency_ns{stream="aq-mqtt-ingest",quantile="0.99"} 42500000
output_latency_ns_count{stream="aq-mqtt-ingest"} 128390
uptime_seconds 900
"#;

    fn scraped(stream: &str) -> PipelineMetrics {
        scrape(BODY, stream, "2026-09-06T16:20:11Z".into())
    }

    #[test]
    fn folds_the_series_of_one_stream() {
        let metrics = scraped("aq-mqtt-ingest");
        assert_eq!(
            metrics.received,
            Some(128401),
            "the neighbour's 77 is not ours"
        );
        assert_eq!(metrics.sent, Some(128390));
        assert_eq!(
            metrics.errors,
            Some(3),
            "output and processor errors are one number"
        );
        assert_eq!(metrics.buffer_depth, Some(11));
        assert_eq!(
            metrics.latency_p99_ms,
            Some(42.5),
            "nanoseconds are shown as milliseconds"
        );
    }

    /// PL-61: what the validation stage refused is counted as rejected, not as an error.
    #[test]
    fn the_stages_refusals_are_rejected_and_not_errors() {
        let body = concat!(
            "output_sent{label=\"output\",stream=\"aq\"} 90\n",
            "processor_error{label=\"validation\",stream=\"aq\"} 7\n",
            "processor_error{label=\"validation_id\",stream=\"aq\"} 2\n",
            "processor_error{label=\"processor_0\",stream=\"aq\"} 1\n",
            "output_error{label=\"output\",stream=\"aq\"} 3\n",
            // PL-62: the outcome sink's own sends and failures are not the stream's.
            "output_sent{label=\"outcome\",stream=\"aq\"} 90\n",
            "output_error{label=\"outcome\",stream=\"aq\"} 5\n",
        );
        let metrics = scrape(body, "aq", "2026-09-25T10:00:00Z".into());
        assert_eq!(metrics.sent, Some(90), "written");
        assert!(!metrics.nodes.contains_key("outcome"));
        assert_eq!(metrics.rejected, Some(9));
        assert_eq!(metrics.errors, Some(4), "a step's error and a failed write");
        assert_eq!(
            scraped("aq-mqtt-ingest").rejected,
            None,
            "no stage, no count"
        );
    }

    /// T-3001: a pass report the Portal did not take is neither an error of the stream nor a
    /// node of it.
    #[test]
    fn the_pass_reports_own_failures_are_not_the_streams() {
        let body = concat!(
            "input_received{label=\"input\",stream=\"reaper\"} 5\n",
            "processor_error{label=\"pass\",stream=\"reaper\"} 5\n",
            "processor_error{label=\"pass_report\",stream=\"reaper\"} 5\n",
            "processor_error{label=\"processor_0\",stream=\"reaper\"} 1\n",
        );
        let metrics = scrape(body, "reaper", "2026-09-26T01:00:00Z".into());
        assert_eq!(metrics.errors, Some(1), "only the stream's own step");
        assert!(!metrics.nodes.contains_key("pass"));
        assert!(!metrics.nodes.contains_key("pass_report"));
    }

    #[test]
    fn a_stream_without_series_reports_no_numbers() {
        let metrics = scraped("not-running");
        assert_eq!(metrics.received, None, "absent is not zero");
        assert_eq!(metrics.errors, None);
        assert_eq!(metrics.latency_p99_ms, None);
    }

    #[test]
    fn prefixed_and_total_suffixed_names_are_the_same_families() {
        let body = concat!(
            "bento_input_received_total{stream=\"aq\"} 5\n",
            "bento_output_sent_total{stream=\"aq\"} 4\n"
        );
        let metrics = scrape(body, "aq", String::new());
        assert_eq!(metrics.received, Some(5));
        assert_eq!(metrics.sent, Some(4));
    }

    #[test]
    fn several_inputs_of_one_stream_are_summed() {
        let body = concat!(
            "input_received{label=\"a\",stream=\"aq\"} 5\n",
            "input_received{label=\"b\",stream=\"aq\"} 7\n",
            "output_latency_ns{label=\"a\",stream=\"aq\",quantile=\"0.99\"} 2000000\n",
            "output_latency_ns{label=\"b\",stream=\"aq\",quantile=\"0.99\"} 9000000\n"
        );
        let metrics = scrape(body, "aq", String::new());
        assert_eq!(metrics.received, Some(12));
        assert_eq!(
            metrics.latency_p99_ms,
            Some(9.0),
            "the slowest output, not their sum"
        );
    }

    #[test]
    fn comments_blank_lines_and_unlabelled_samples_are_ignored() {
        assert!(parse_line("# HELP x a counter").is_none());
        assert!(parse_line("   ").is_none());
        let sample = parse_line("uptime_seconds 900").expect("a sample without labels parses");
        assert_eq!(sample.name, "uptime_seconds");
        assert_eq!(sample.labels, "");
        assert_eq!(sample.value, 900.0);
    }

    /// T-1125, PL-24: Bento reports a component's counters under its `label`, so the studio can
    /// say which node a message reached instead of only what the stream totalled. The samples
    /// of another stream never reach either number.
    #[test]
    fn the_counters_of_each_component_are_kept_beside_the_stream_total() {
        let metrics = scraped("aq-mqtt-ingest");

        assert_eq!(metrics.received, Some(128_401), "the stream's own total");
        let input = metrics.nodes.get("mqtt").expect("the input's counters");
        assert_eq!(input.received, Some(128_401));
        assert_eq!(input.sent, None, "an input sends nothing of its own");

        let output = metrics.nodes.get("gateway").expect("the output's counters");
        assert_eq!(output.sent, Some(128_390));
        assert_eq!(output.errors, Some(2));

        // The other stream's samples carry the same label and are not folded in.
        assert_eq!(
            scraped("other-stream").nodes.get("mqtt").unwrap().received,
            Some(77)
        );
    }

    /// A stream deployed before the labels reports none, and the total still answers.
    #[test]
    fn a_stream_without_labels_reports_no_nodes_and_still_totals() {
        let body = "input_received{path=\"root.input\",stream=\"plain\"} 5\n";
        let metrics = scrape(body, "plain", "2026-09-06T16:20:11Z".into());
        assert_eq!(metrics.received, Some(5));
        assert!(metrics.nodes.is_empty());
    }
}
