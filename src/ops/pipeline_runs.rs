//! Running a Pipeline and reading its runs through the registry (T-6028, PL-62, PL-78).
//!
//! The run list, a run's log and run-now had routes and no operations, so an MCP connector could
//! test a mapping but never start the pipeline or ask why last night's run wrote nothing. Each
//! operation calls the route's own function; the grants and the refusals are the route's. A run
//! answers its id at once and never waits for the run; the log comes back a page at a time, cut
//! at [`LOG_BYTES`] with the cursor of the next page.

use axum::extract::{Path, Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::bounds::{text, NAME};
use super::runs::as_user;
use super::{parse_input, Annotations, OpError, Operation};
use crate::api::pipelines::{LogQuery, RunsQuery};
use crate::change::Lane;
use crate::pipeline_log::LogLine;

/// The most a log page carries, in bytes of its lines' JSON: well under a connector's answer
/// (`connectors::DEFAULT_LIMITS.result_bytes`), so a page always reaches the client whole.
pub const LOG_BYTES: usize = 32 * 1024;
/// The run list and log operation's name.
pub const LOGS: &str = "jc_pipeline_logs";
/// Lines read from the store per page, before the byte cut.
const LOG_LINES: usize = 200;
/// Runs listed when the call names no limit, and the most it may name.
const RUNS: usize = 10;
const MAX_RUNS: usize = 50;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunInput {
    pub name: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunsInput {
    pub name: String,
    /// The run whose log to read; the newest when absent.
    #[serde(default)]
    pub run: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
    /// The `next` of the previous page.
    #[serde(default)]
    pub cursor: Option<i64>,
}

fn run_input_schema() -> Value {
    json!({
        "type": "object",
        "properties": { "name": text("The Pipeline's name, e.g. counters-hourly", NAME) },
        "required": ["name"],
        "additionalProperties": false
    })
}

fn run_output_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "run": { "type": "string", "description": "The run's id, as jc_pipeline_logs names it once it wrote" },
            "state": { "type": "string", "enum": ["queued"], "description": "The run waits its turn in the project's lane" }
        },
        "required": ["run"]
    })
}

fn runs_input_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "name": text("The Pipeline's name, e.g. counters-hourly", NAME),
            "run": text("The run whose log to read, as runs[].run names it, e.g. 2026-10-29T03:00:00Z; the newest run when absent", 64),
            "limit": { "type": "integer", "minimum": 1, "maximum": MAX_RUNS, "description": "Runs listed, newest first (default 10)" },
            "cursor": { "type": "integer", "description": "The next of the previous answer: the log's following page" }
        },
        "required": ["name"],
        "additionalProperties": false
    })
}

fn runs_output_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "runs": { "type": "array", "description": "The newest runs, each with the records it sent, the model rejected and a step failed" },
            "run": { "type": ["string", "null"], "description": "The run whose log lines follow; null when the pipeline never ran" },
            "lines": { "type": "array", "description": "The run's log, newest first: each record's id, the step it failed at, its outcome and what happened" },
            "next": { "type": "integer", "description": "Present when the log goes on: send it as cursor" }
        },
        "required": ["runs", "run", "lines"]
    })
}

/// `lines` (one store page of `asked` lines) cut to [`LOG_BYTES`], and the cursor of what follows:
/// the id of the last line kept, when lines were cut or the store may hold more.
fn page(mut lines: Vec<LogLine>, asked: usize) -> (Vec<LogLine>, Option<i64>) {
    let fetched = lines.len();
    let mut bytes = 0;
    let kept = lines
        .iter()
        .take_while(|line| {
            bytes += serde_json::to_vec(line).map_or(LOG_BYTES, |b| b.len());
            bytes <= LOG_BYTES
        })
        .count()
        .max(1)
        .min(fetched);
    lines.truncate(kept);
    let more = kept < fetched || fetched == asked;
    let next = more.then(|| lines.last().map(|line| line.id)).flatten();
    (lines, next)
}

async fn runs(
    caller: &super::Caller,
    state: &crate::state::AppState,
    project: &str,
    input: RunsInput,
) -> Result<Value, OpError> {
    let path = (project.to_owned(), input.name.clone());
    let Json(list) = crate::api::pipelines::get_runs(
        as_user(caller),
        State(state.clone()),
        Path(path.clone()),
        Query(RunsQuery {
            limit: Some(input.limit.unwrap_or(RUNS).clamp(1, MAX_RUNS)),
        }),
    )
    .await?;
    let run = input
        .run
        .or_else(|| list.items.first().map(|r| r.run.clone()));
    let (lines, next) = match &run {
        Some(run) => {
            let Json(log) = crate::api::pipelines::get_run_log(
                as_user(caller),
                State(state.clone()),
                Path((path.0, path.1, run.clone())),
                Query(LogQuery {
                    limit: Some(LOG_LINES),
                    before: input.cursor,
                }),
            )
            .await?;
            page(log.items, LOG_LINES)
        }
        None => (Vec::new(), None),
    };
    let mut answer = json!({ "runs": list.items, "run": run, "lines": lines });
    if let Some(next) = next {
        answer["next"] = json!(next);
    }
    Ok(answer)
}

/// This module's operations in the registry (`super::init_registry`).
pub fn operations() -> Vec<Operation> {
    vec![
        Operation {
            name: "jc_pipeline_run",
            title: "Run a Pipeline Now",
            description: "Queues one run of a pipeline that runs from the queue (PL-78), now and outside its schedule, and answers its id: the run the run list shows once it wrote. The run waits its turn in its lane, so runs started for many pipelines go one after another. A pipeline whose run is in the runner, and one that waits for pushes and so always runs, answer 409. Needs propose and approve on Pipeline (a steward), and each run is an activity event `pipeline.run`",
            input: run_input_schema,
            output: run_output_schema,
            annotations: Annotations {
                read_only_hint: false,
                destructive_hint: false,
                idempotent_hint: false,
            },
            kind: "Pipeline",
            verb: Some(jc_core::kinds::Verb::Propose),
            lane: Lane::Yellow,
            validate: |val| parse_input::<RunInput>(val.clone()).map(|_| ()),
            run: |caller, state, project, val| {
                Box::pin(async move {
                    let input: RunInput = parse_input(val)?;
                    let (_, Json(started)) = crate::api::pipelines::post_run(
                        as_user(caller),
                        State(state.clone()),
                        Path((project.to_owned(), input.name)),
                    )
                    .await?;
                    // Queued, never awaited: jc_pipeline_logs reads it once it wrote.
                    Ok(json!({ "run": started.run, "state": "queued" }))
                })
            },
        },
        Operation {
            name: LOGS,
            title: "Read Pipeline Runs and Logs",
            description: "A pipeline's newest runs with what each sent, rejected and failed, and one run's log (the newest unless run names one): each record's outcome and the message saying why, e.g. the source read that failed or the write the gateway refused. The log comes a page at a time; send next as cursor for the following page",
            input: runs_input_schema,
            output: runs_output_schema,
            annotations: Annotations {
                read_only_hint: true,
                destructive_hint: false,
                idempotent_hint: true,
            },
            kind: "Pipeline",
            verb: None,
            lane: Lane::Green,
            validate: |val| parse_input::<RunsInput>(val.clone()).map(|_| ()),
            run: |caller, state, project, val| {
                Box::pin(async move { runs(caller, state, project, parse_input(val)?).await })
            },
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline_log::Outcome;

    fn line(id: i64, message: &str) -> LogLine {
        LogLine {
            id,
            at: "2026-10-29T03:00:00Z".into(),
            run: "2026-10-29T03:00:00Z".into(),
            record_id: format!("c{id}"),
            step: None,
            outcome: Outcome::Failed,
            message: message.into(),
        }
    }

    #[test]
    fn a_log_over_the_byte_cap_is_cut_with_the_cursor_of_the_rest() {
        let long = "x".repeat(400);
        let lines: Vec<LogLine> = (0..120).rev().map(|id| line(id, &long)).collect();
        let (kept, next) = page(lines, LOG_LINES);
        let bytes: usize = kept
            .iter()
            .map(|l| serde_json::to_vec(l).map_or(0, |b| b.len()))
            .sum();
        assert!(bytes <= LOG_BYTES, "{bytes}");
        assert!(kept.len() < 120, "{}", kept.len());
        assert_eq!(next, kept.last().map(|l| l.id));
    }

    #[test]
    fn a_short_last_page_has_no_cursor_and_a_full_one_has() {
        let (kept, next) = page(vec![line(2, "a"), line(1, "b")], LOG_LINES);
        assert_eq!((kept.len(), next), (2, None));
        let (_, next) = page(vec![line(2, "a"), line(1, "b")], 2);
        assert_eq!(next, Some(1));
        assert_eq!(page(Vec::new(), LOG_LINES), (Vec::new(), None));
    }
}
