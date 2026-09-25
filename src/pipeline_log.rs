//! A pipeline's runs and the log of each (PL-62, ADR-N-034).
//!
//! The runner sends one outcome line per record through a sink that drops rather than retries:
//! `sent` once the gateway took the record's batch, `rejected` when the validation stage refused
//! it, `failed` when one of the author's steps threw. A run is one tick of the pipeline's clock,
//! or one UTC hour for a source that never ends; the runner names it.
//!
//! Bounded per pipeline: the newest [`LINES_KEPT`] lines and the newest [`RUNS_KEPT`] runs. A
//! run's counts are kept apart from its lines, so a run of 4000 records still says 4000 after
//! most of its lines have aged out. Record ids and messages are masked before they are stored:
//! an id is whatever the mapping produced, and a message can quote the source.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::RwLock;

/// The label of the outcome sink in a rendered stream, which the metrics leave out.
pub const SINK_LABEL: &str = "outcome";

/// How many log lines one pipeline keeps.
pub const LINES_KEPT: usize = 5000;
/// How many runs one pipeline keeps the counts of.
pub const RUNS_KEPT: usize = 200;
/// The longest record id and message a line carries.
const TEXT_CHARS: usize = 500;

/// What became of one record.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "lowercase")]
#[schema(as = PipelineOutcome)]
pub enum Outcome {
    /// The gateway took the batch it was in.
    Sent,
    /// The validation stage refused it; it is on the rejected list.
    Rejected,
    /// One of the author's steps threw on it.
    Failed,
}

impl Outcome {
    fn as_str(self) -> &'static str {
        match self {
            Outcome::Sent => "sent",
            Outcome::Rejected => "rejected",
            Outcome::Failed => "failed",
        }
    }

    fn parse(text: &str) -> Self {
        match text {
            "sent" => Outcome::Sent,
            "rejected" => Outcome::Rejected,
            _ => Outcome::Failed,
        }
    }
}

/// One line as the runner or the rejected route reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewLine {
    pub record_id: String,
    pub step: Option<i32>,
    pub outcome: Outcome,
    pub message: String,
}

/// One line of a run's log.
#[derive(Debug, Clone, PartialEq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(as = PipelineLogLine)]
pub struct LogLine {
    /// Its place in the log; the `before` of the next page.
    pub id: i64,
    /// When the Portal took the line, RFC 3339.
    pub at: String,
    /// The run it belongs to.
    pub run: String,
    /// The record's `id`, as the mapping produced it; empty when it had none.
    pub record_id: String,
    /// The step of `spec.steps` it failed at, when it failed in a step.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<i32>,
    pub outcome: Outcome,
    /// What happened, in words; empty for a record that was sent.
    pub message: String,
}

/// One run with its counts.
#[derive(Debug, Clone, PartialEq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(as = PipelineRun)]
pub struct Run {
    /// Its name: the tick's time, or the UTC hour of a source that never ends.
    pub run: String,
    /// The first and the last line the Portal took for it, RFC 3339.
    pub first_at: String,
    pub last_at: String,
    pub sent: u64,
    pub rejected: u64,
    pub failed: u64,
}

type Key = (String, String);

#[derive(Default)]
struct Memory {
    next: i64,
    lines: Vec<LogLine>,
    runs: Vec<Run>,
}

enum Inner {
    Postgres(sqlx::PgPool),
    Memory(RwLock<HashMap<Key, Memory>>),
}

/// The runs and logs of every pipeline.
pub struct LogStore {
    inner: Inner,
}

/// A run name the runner sent, or the current UTC hour when it sent none a person could read:
/// the name is shown and filtered on, so it is short and plain.
pub fn run_name(sent: Option<&str>) -> String {
    match sent.map(str::trim) {
        Some(name)
            if !name.is_empty()
                && name.len() <= 40
                && name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | ':' | '.')) =>
        {
            name.to_owned()
        }
        _ => {
            let now = time::OffsetDateTime::now_utc();
            format!(
                "{:04}-{:02}-{:02}T{:02}:00Z",
                now.year(),
                u8::from(now.month()),
                now.day(),
                now.hour()
            )
        }
    }
}

/// The Bloblang that names a message's run in the runner: the tick its clock stamped, or the
/// UTC hour for a source without a clock.
pub const RUN: &str = r#"meta("jc_run").or(now().ts_format("2006-01-02T15:00Z", "UTC"))"#;

/// The Bloblang a clocked input stamps its tick with, so every record read on it is one run.
pub const TICK: &str = r#"meta jc_run = now().ts_format("2006-01-02T15:04:05Z", "UTC")"#;

/// The output a stream writes through, followed by the outcome sink once it has taken a batch
/// (PL-62): the sink only runs after the write succeeded, and a sink that fails is dropped, so the
/// log never holds back or repeats a write.
pub fn with_outcomes(output: serde_json::Value, url: &str) -> serde_json::Value {
    let sink = serde_json::json!({
        "label": SINK_LABEL,
        "drop_on": {
            "error": true,
            "output": { "http_client": {
                "url": url,
                "verb": "POST",
                "headers": { "Content-Type": "application/json" },
                "timeout": "5s",
                "retries": 0,
                "oauth2": {
                    "enabled": true,
                    "client_key": "${JC_CLIENT_ID}",
                    "client_secret": "${JC_CLIENT_SECRET}",
                    "token_url": "${JC_TOKEN_URL}",
                },
            }},
        },
        "processors": [{ "mapping": format!(
            "let records = if this.type() == \"array\" {{ this }} else {{ [this] }}\n\
             root = {{ \"run\": {RUN}, \"sent\": $records.map_each(record -> record.id.or(\"\")) }}"
        ) }],
    });
    serde_json::json!({ "broker": {
        "pattern": "fan_out_sequential",
        "outputs": [output, sink],
    }})
}

fn clean(text: &str) -> String {
    let short: String = text.chars().take(TEXT_CHARS).collect();
    crate::pipeline_outcomes::mask_text(&short)
}

fn rfc3339(at: time::OffsetDateTime) -> String {
    at.format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

type LineRow = (
    i64,
    time::OffsetDateTime,
    String,
    String,
    Option<i32>,
    String,
    String,
);
type RunRow = (
    String,
    time::OffsetDateTime,
    time::OffsetDateTime,
    i64,
    i64,
    i64,
);

impl LogStore {
    /// Durable with a database, in memory without one.
    pub fn new(db: Option<sqlx::PgPool>) -> Self {
        Self {
            inner: match db {
                Some(pool) => Inner::Postgres(pool),
                None => Inner::Memory(RwLock::new(HashMap::new())),
            },
        }
    }

    /// Adds the lines of one report to the run's log and its counts, then drops what is beyond
    /// the bounds.
    pub async fn append(
        &self,
        project: &str,
        pipeline: &str,
        run: &str,
        lines: &[NewLine],
    ) -> Result<(), sqlx::Error> {
        if lines.is_empty() {
            return Ok(());
        }
        let count = |outcome: Outcome| lines.iter().filter(|l| l.outcome == outcome).count() as i64;
        let (sent, rejected, failed) = (
            count(Outcome::Sent),
            count(Outcome::Rejected),
            count(Outcome::Failed),
        );
        let ids: Vec<String> = lines.iter().map(|l| clean(&l.record_id)).collect();
        let messages: Vec<String> = lines.iter().map(|l| clean(&l.message)).collect();
        match &self.inner {
            Inner::Postgres(pool) => {
                let steps: Vec<Option<i32>> = lines.iter().map(|l| l.step).collect();
                let outcomes: Vec<&str> = lines.iter().map(|l| l.outcome.as_str()).collect();
                let mut tx = pool.begin().await?;
                sqlx::query(
                    "INSERT INTO pipeline_log (project, pipeline, run, record_id, step, outcome, message) \
                     SELECT $1, $2, $3, r, s, o, m FROM UNNEST($4::text[], $5::int[], $6::text[], $7::text[]) \
                     AS t(r, s, o, m)",
                )
                .bind(project)
                .bind(pipeline)
                .bind(run)
                .bind(&ids)
                .bind(&steps)
                .bind(&outcomes)
                .bind(&messages)
                .execute(&mut *tx)
                .await?;
                sqlx::query(
                    "INSERT INTO pipeline_runs (project, pipeline, run, sent, rejected, failed) \
                     VALUES ($1, $2, $3, $4, $5, $6) \
                     ON CONFLICT (project, pipeline, run) DO UPDATE SET last_at = now(), \
                     sent = pipeline_runs.sent + $4, rejected = pipeline_runs.rejected + $5, \
                     failed = pipeline_runs.failed + $6",
                )
                .bind(project)
                .bind(pipeline)
                .bind(run)
                .bind(sent)
                .bind(rejected)
                .bind(failed)
                .execute(&mut *tx)
                .await?;
                sqlx::query(
                    "DELETE FROM pipeline_log WHERE project = $1 AND pipeline = $2 AND id < \
                     (SELECT coalesce(min(id), 0) FROM (SELECT id FROM pipeline_log \
                      WHERE project = $1 AND pipeline = $2 ORDER BY id DESC LIMIT $3) AS kept)",
                )
                .bind(project)
                .bind(pipeline)
                .bind(LINES_KEPT as i64)
                .execute(&mut *tx)
                .await?;
                sqlx::query(
                    "DELETE FROM pipeline_runs WHERE project = $1 AND pipeline = $2 AND run NOT IN \
                     (SELECT run FROM pipeline_runs WHERE project = $1 AND pipeline = $2 \
                      ORDER BY last_at DESC LIMIT $3)",
                )
                .bind(project)
                .bind(pipeline)
                .bind(RUNS_KEPT as i64)
                .execute(&mut *tx)
                .await?;
                tx.commit().await
            }
            Inner::Memory(map) => {
                let mut map = map.write().unwrap_or_else(|e| e.into_inner());
                let memory = map
                    .entry((project.to_owned(), pipeline.to_owned()))
                    .or_default();
                let at = rfc3339(time::OffsetDateTime::now_utc());
                for ((line, record_id), message) in lines.iter().zip(ids).zip(messages) {
                    memory.next += 1;
                    memory.lines.push(LogLine {
                        id: memory.next,
                        at: at.clone(),
                        run: run.to_owned(),
                        record_id,
                        step: line.step,
                        outcome: line.outcome,
                        message,
                    });
                }
                let over = memory.lines.len().saturating_sub(LINES_KEPT);
                memory.lines.drain(..over);
                match memory.runs.iter().position(|r| r.run == run) {
                    Some(at_) => {
                        let mut kept = memory.runs.remove(at_);
                        kept.last_at = at;
                        kept.sent += sent as u64;
                        kept.rejected += rejected as u64;
                        kept.failed += failed as u64;
                        memory.runs.push(kept);
                    }
                    None => memory.runs.push(Run {
                        run: run.to_owned(),
                        first_at: at.clone(),
                        last_at: at,
                        sent: sent as u64,
                        rejected: rejected as u64,
                        failed: failed as u64,
                    }),
                }
                let over = memory.runs.len().saturating_sub(RUNS_KEPT);
                memory.runs.drain(..over);
                Ok(())
            }
        }
    }

    /// The pipeline's runs, the one with the latest line first, at most `limit`.
    pub async fn runs(
        &self,
        project: &str,
        pipeline: &str,
        limit: usize,
    ) -> Result<Vec<Run>, sqlx::Error> {
        let limit = limit.clamp(1, RUNS_KEPT);
        match &self.inner {
            Inner::Postgres(pool) => {
                let rows: Vec<RunRow> = sqlx::query_as(
                    "SELECT run, first_at, last_at, sent, rejected, failed FROM pipeline_runs \
                     WHERE project = $1 AND pipeline = $2 ORDER BY last_at DESC LIMIT $3",
                )
                .bind(project)
                .bind(pipeline)
                .bind(limit as i64)
                .fetch_all(pool)
                .await?;
                Ok(rows
                    .into_iter()
                    .map(|(run, first, last, sent, rejected, failed)| Run {
                        run,
                        first_at: rfc3339(first),
                        last_at: rfc3339(last),
                        sent: u64::try_from(sent).unwrap_or_default(),
                        rejected: u64::try_from(rejected).unwrap_or_default(),
                        failed: u64::try_from(failed).unwrap_or_default(),
                    })
                    .collect())
            }
            Inner::Memory(map) => Ok(map
                .read()
                .unwrap_or_else(|e| e.into_inner())
                .get(&(project.to_owned(), pipeline.to_owned()))
                .map(|memory| memory.runs.iter().rev().take(limit).cloned().collect())
                .unwrap_or_default()),
        }
    }

    /// One run's log lines, newest first, at most `limit`, older than `before` when given.
    pub async fn lines(
        &self,
        project: &str,
        pipeline: &str,
        run: &str,
        limit: usize,
        before: Option<i64>,
    ) -> Result<Vec<LogLine>, sqlx::Error> {
        let limit = limit.clamp(1, LINES_KEPT);
        match &self.inner {
            Inner::Postgres(pool) => {
                let rows: Vec<LineRow> = sqlx::query_as(
                    "SELECT id, at, run, record_id, step, outcome, message FROM pipeline_log \
                     WHERE project = $1 AND pipeline = $2 AND run = $3 \
                     AND ($4::bigint IS NULL OR id < $4) ORDER BY id DESC LIMIT $5",
                )
                .bind(project)
                .bind(pipeline)
                .bind(run)
                .bind(before)
                .bind(limit as i64)
                .fetch_all(pool)
                .await?;
                Ok(rows
                    .into_iter()
                    .map(|(id, at, run, record_id, step, outcome, message)| LogLine {
                        id,
                        at: rfc3339(at),
                        run,
                        record_id,
                        step,
                        outcome: Outcome::parse(&outcome),
                        message,
                    })
                    .collect())
            }
            Inner::Memory(map) => Ok(map
                .read()
                .unwrap_or_else(|e| e.into_inner())
                .get(&(project.to_owned(), pipeline.to_owned()))
                .map(|memory| {
                    memory
                        .lines
                        .iter()
                        .rev()
                        .filter(|l| l.run == run && before.is_none_or(|b| l.id < b))
                        .take(limit)
                        .cloned()
                        .collect()
                })
                .unwrap_or_default()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(id: &str, outcome: Outcome, message: &str) -> NewLine {
        NewLine {
            record_id: id.to_owned(),
            step: None,
            outcome,
            message: message.to_owned(),
        }
    }

    #[tokio::test]
    async fn a_run_counts_its_outcomes_and_its_log_is_its_own_pipelines_only() {
        let store = LogStore::new(None);
        store
            .append(
                "helsinki",
                "stations",
                "2026-09-25T08:00Z",
                &[
                    line("urn:a", Outcome::Sent, ""),
                    line("urn:b", Outcome::Sent, ""),
                    line("urn:c", Outcome::Rejected, "capacity is not an integer"),
                ],
            )
            .await
            .expect("kept");
        store
            .append(
                "helsinki",
                "stations",
                "2026-09-25T08:00Z",
                &[line("urn:d", Outcome::Failed, "step 2 threw")],
            )
            .await
            .expect("kept");
        store
            .append(
                "helsinki",
                "other",
                "2026-09-25T08:00Z",
                &[line("urn:other", Outcome::Sent, "")],
            )
            .await
            .expect("kept");

        let runs = store.runs("helsinki", "stations", 10).await.expect("runs");
        assert_eq!(runs.len(), 1);
        assert_eq!((runs[0].sent, runs[0].rejected, runs[0].failed), (2, 1, 1));
        let lines = store
            .lines("helsinki", "stations", "2026-09-25T08:00Z", 10, None)
            .await
            .expect("lines");
        let ids: Vec<&str> = lines.iter().map(|l| l.record_id.as_str()).collect();
        assert_eq!(ids, ["urn:d", "urn:c", "urn:b", "urn:a"], "newest first");
        assert!(store
            .lines("other", "stations", "2026-09-25T08:00Z", 10, None)
            .await
            .expect("lines")
            .is_empty());
    }

    #[tokio::test]
    async fn lines_are_paged_bounded_and_the_counts_outlive_them() {
        let store = LogStore::new(None);
        let many: Vec<NewLine> = (0..LINES_KEPT + 10)
            .map(|n| line(&format!("urn:{n}"), Outcome::Sent, ""))
            .collect();
        store.append("p", "x", "r1", &many).await.expect("kept");
        let first = store.lines("p", "x", "r1", 3, None).await.expect("page");
        assert_eq!(first.len(), 3);
        let next = store
            .lines("p", "x", "r1", 3, Some(first[2].id))
            .await
            .expect("page");
        assert!(next[0].id < first[2].id);
        let all = store
            .lines("p", "x", "r1", LINES_KEPT, None)
            .await
            .expect("all");
        assert_eq!(all.len(), LINES_KEPT);
        assert_eq!(
            store.runs("p", "x", 1).await.expect("runs")[0].sent,
            (LINES_KEPT + 10) as u64,
            "the count is the run's, not the kept lines'"
        );

        for n in 0..RUNS_KEPT + 5 {
            store
                .append(
                    "p",
                    "x",
                    &format!("r{n}"),
                    &[line("urn", Outcome::Sent, "")],
                )
                .await
                .expect("kept");
        }
        assert_eq!(
            store.runs("p", "x", RUNS_KEPT).await.expect("runs").len(),
            RUNS_KEPT
        );
    }

    #[tokio::test]
    async fn a_credential_in_an_id_or_a_message_is_masked() {
        let jwt = [
            "eyJhbGciOiJIUzI1NiJ9",
            "eyJzdWIiOiJ4In0",
            "c2lnbmF0dXJlLXBhcnQ",
        ]
        .join(".");
        let store = LogStore::new(None);
        store
            .append(
                "p",
                "x",
                "r",
                &[line(
                    &jwt,
                    Outcome::Failed,
                    &format!("the source answered 401 to Bearer {}", "abc123def456"),
                )],
            )
            .await
            .expect("kept");
        let kept = &store.lines("p", "x", "r", 1, None).await.expect("line")[0];
        assert_eq!(kept.record_id, crate::pipeline_outcomes::MASK);
        assert!(!kept.message.contains("abc123def456"), "{}", kept.message);
    }

    #[test]
    fn a_run_name_is_short_and_plain_or_the_current_hour() {
        assert_eq!(
            run_name(Some("2026-09-25T08:15:00Z")),
            "2026-09-25T08:15:00Z"
        );
        for bad in [None, Some(""), Some("<script>"), Some(&"9".repeat(41)[..])] {
            let hour = run_name(bad);
            assert!(hour.ends_with(":00Z") && hour.len() == 17, "{hour}");
        }
    }
}
