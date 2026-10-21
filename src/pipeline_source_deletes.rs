//! A snapshot pipeline follows what its source removed (PL-97, PL-100, T-4891).
//!
//! The runner's outcome sink tells the Portal every id a run wrote; for a pipeline whose
//! `spec.sourceDeletes.mode` is `snapshot` each id goes into the pipeline's source ledger with the
//! run that read it. When the run queue sees a run end, [`run_ended`] judges it: a run that did not
//! finish, failed on a record or read nothing deletes nothing and counts as no miss; a complete run
//! adds a miss to every ledger id it did not read and clears the misses of the ones it did. The ids
//! missing from `misses` complete runs in a row are deleted, unless they are more than `maxShare`
//! of the ledger: then nothing goes, the run is held and the pipeline's subscribers are alerted
//! until a person with `approve` on Pipeline releases or keeps them.
//!
//! The Portal never deletes itself. It hands the runner a one-shot stream that deletes the ids
//! through the pipeline's output Endpoint as the pipeline's own account, with the reason in
//! `JC-Reason`, so the gateway judges, audits and tombstones every delete like a write (DM-115);
//! the stream reports what went back here and only those rows leave the ledger.

use std::collections::{BTreeMap, HashMap};
use std::sync::RwLock;
use std::time::Duration;

use jc_core::kinds::{SourceDeleteMode, SourceDeletes};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::state::AppState;

/// The most ids one delete stream carries; the rest stay doomed and go after the next complete
/// run. ponytail: 5000 per run; page the stream when a source drops more at once.
pub const MAX_PER_STREAM: usize = 5000;
/// Ids per delete request: the gateway's batch limit.
const CHUNK: usize = 100;
/// How long a delete stream is left on the runner before it is removed.
const STREAM_WINDOW: Duration = Duration::from_secs(120);
/// The longest entity id the ledger keeps.
const MAX_ID: usize = 256;

/// Why a run deleted nothing and alerts the pipeline's subscribers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "kebab-case")]
pub enum HoldReason {
    /// It would delete more than `maxShare` of the ledger.
    ShareExceeded,
    /// It finished having read nothing: an outage that answers an empty list.
    Empty,
    /// It failed on a record or its source refused a request.
    Incomplete,
}

impl HoldReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::ShareExceeded => "share-exceeded",
            Self::Empty => "empty",
            Self::Incomplete => "incomplete",
        }
    }

    fn parse(text: &str) -> Self {
        match text {
            "share-exceeded" => Self::ShareExceeded,
            "empty" => Self::Empty,
            _ => Self::Incomplete,
        }
    }
}

/// A run that deleted nothing, as the pipeline's page and its alert say it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(as = PipelineSourceHold)]
pub struct Hold {
    pub run: String,
    pub reason: HoldReason,
    /// The ids the run would have deleted.
    pub would: usize,
    /// The ids in the ledger.
    pub ledger: usize,
}

impl Hold {
    /// The alert's words.
    pub fn detail(&self) -> String {
        match self.reason {
            HoldReason::ShareExceeded => format!(
                "source deletes held: run {} would delete {} of {} entities, more than the \
                 share the pipeline allows; release or keep them on the pipeline's page",
                self.run, self.would, self.ledger
            ),
            HoldReason::Empty => format!(
                "source deletes held: run {} read no record, so nothing was deleted",
                self.run
            ),
            HoldReason::Incomplete => format!(
                "source deletes held: run {} did not read its source completely, so nothing was \
                 deleted",
                self.run
            ),
        }
    }
}

/// One ledger row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub last_run: String,
    pub misses: u8,
}

/// A snapshot rule the runtime may act on: `None` for any other mode and for numbers outside
/// PL-96's bounds, which the reconciler would otherwise read unchecked (a `misses` of 0 deletes
/// what the run just read).
pub fn snapshot_rule(spec: &Value) -> Option<SourceDeletes> {
    let rule: SourceDeletes = serde_json::from_value(spec.get("sourceDeletes")?.clone()).ok()?;
    (rule.mode == SourceDeleteMode::Snapshot
        && (1..=jc_core::kinds::pipeline_source_deletes::MISSES_MAX).contains(&rule.misses())
        && (1..=100).contains(&rule.max_share()))
    .then_some(rule)
}

/// What a complete run decides.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Delete(Vec<String>),
    Held(Hold),
}

/// Judges a complete run against the ledger: every row's new misses, and the ids to delete or
/// the hold. A run that read none of the ledger is held as empty with the misses unchanged.
pub fn judge(
    rows: &BTreeMap<String, Row>,
    run: &str,
    rule: &SourceDeletes,
) -> (Vec<(String, u8)>, Verdict) {
    let hold = |reason, would| {
        Verdict::Held(Hold {
            run: run.to_owned(),
            reason,
            would,
            ledger: rows.len(),
        })
    };
    if !rows.is_empty() && rows.values().all(|row| row.last_run != run) {
        return (Vec::new(), hold(HoldReason::Empty, 0));
    }
    let misses: Vec<(String, u8)> = rows
        .iter()
        .map(|(id, row)| {
            let missed = if row.last_run == run {
                0
            } else {
                row.misses.saturating_add(1)
            };
            (id.clone(), missed)
        })
        .collect();
    let doomed: Vec<String> = misses
        .iter()
        .filter(|(_, missed)| *missed >= rule.misses())
        .map(|(id, _)| id.clone())
        .collect();
    if doomed.len() * 100 > usize::from(rule.max_share()) * rows.len() {
        return (misses, hold(HoldReason::ShareExceeded, doomed.len()));
    }
    (misses, Verdict::Delete(doomed))
}

/// Whether an id may be put in a delete: a URI the gateway can name, nothing a stream could read
/// as anything else.
pub fn deletable(id: &str) -> bool {
    id.len() <= MAX_ID
        && id.contains(':')
        && id
            .bytes()
            .all(|b| b.is_ascii_graphic() && !matches!(b, b'"' | b'\\' | b'$' | b'{' | b'}'))
}

type Key = (String, String);

#[derive(Default)]
struct Book {
    rows: BTreeMap<String, Row>,
    hold: Option<Hold>,
    /// The last complete run and when it was judged.
    complete: Option<(String, String)>,
    /// What the pipeline deleted, oldest first, at most `REMOVALS_KEPT`.
    removed: Vec<(String, Removal)>,
}

enum Inner {
    Postgres(sqlx::PgPool),
    Memory(RwLock<HashMap<Key, Book>>),
}

/// The ledgers and holds of every snapshot pipeline: durable with a database, in memory without.
pub struct Ledger {
    inner: Inner,
}

impl Ledger {
    pub fn new(db: Option<sqlx::PgPool>) -> Self {
        Self {
            inner: match db {
                Some(pool) => Inner::Postgres(pool),
                None => Inner::Memory(RwLock::new(HashMap::new())),
            },
        }
    }

    fn memory(&self) -> Option<std::sync::RwLockWriteGuard<'_, HashMap<Key, Book>>> {
        match &self.inner {
            Inner::Memory(map) => Some(map.write().unwrap_or_else(|e| e.into_inner())),
            Inner::Postgres(_) => None,
        }
    }

    /// Notes that `run` read these ids: known ones keep their misses until the run is judged, and
    /// new ones join the ledger when the pipeline `wrote` them; a record the model refused only
    /// keeps a known row alive, since an id the pipeline never wrote is never its to delete.
    pub async fn seen(
        &self,
        project: &str,
        pipeline: &str,
        run: &str,
        ids: &[String],
        wrote: bool,
    ) -> Result<(), sqlx::Error> {
        let ids: Vec<&str> = ids
            .iter()
            .map(String::as_str)
            .filter(|id| deletable(id))
            .collect();
        if ids.is_empty() {
            return Ok(());
        }
        if let Inner::Postgres(pool) = &self.inner {
            let sql = if wrote {
                "INSERT INTO pipeline_source_ledger (project, pipeline, entity_id, last_run) \
                 SELECT $1, $2, i, $3 FROM UNNEST($4::text[]) AS t(i) \
                 ON CONFLICT (project, pipeline, entity_id) DO UPDATE SET last_run = $3, \
                 last_seen = now()"
            } else {
                "UPDATE pipeline_source_ledger SET last_run = $3, last_seen = now() \
                 WHERE project = $1 AND pipeline = $2 AND entity_id = ANY($4::text[])"
            };
            sqlx::query(sql)
                .bind(project)
                .bind(pipeline)
                .bind(run)
                .bind(&ids)
                .execute(pool)
                .await?;
            return Ok(());
        }
        if let Some(mut map) = self.memory() {
            let book = map
                .entry((project.to_owned(), pipeline.to_owned()))
                .or_default();
            for id in ids {
                if wrote {
                    book.rows.entry(id.to_owned()).or_insert(Row {
                        last_run: String::new(),
                        misses: 0,
                    });
                }
                if let Some(row) = book.rows.get_mut(id) {
                    row.last_run = run.to_owned();
                }
            }
        }
        Ok(())
    }

    /// The pipeline's ledger and its hold.
    pub async fn book(
        &self,
        project: &str,
        pipeline: &str,
    ) -> Result<(BTreeMap<String, Row>, Option<Hold>), sqlx::Error> {
        if let Inner::Postgres(pool) = &self.inner {
            let rows: Vec<(String, String, i16)> = sqlx::query_as(
                "SELECT entity_id, last_run, misses FROM pipeline_source_ledger \
                 WHERE project = $1 AND pipeline = $2",
            )
            .bind(project)
            .bind(pipeline)
            .fetch_all(pool)
            .await?;
            let hold: Option<(String, String, i32, i32)> = sqlx::query_as(
                "SELECT run, reason, would, ledger FROM pipeline_source_holds \
                 WHERE project = $1 AND pipeline = $2",
            )
            .bind(project)
            .bind(pipeline)
            .fetch_optional(pool)
            .await?;
            let rows = rows
                .into_iter()
                .map(|(id, last_run, misses)| {
                    let misses = u8::try_from(misses.max(0)).unwrap_or(u8::MAX);
                    (id, Row { last_run, misses })
                })
                .collect();
            let hold = hold.map(|(run, reason, would, ledger)| Hold {
                run,
                reason: HoldReason::parse(&reason),
                would: usize::try_from(would).unwrap_or_default(),
                ledger: usize::try_from(ledger).unwrap_or_default(),
            });
            return Ok((rows, hold));
        }
        let map = self.memory();
        let book = map
            .as_ref()
            .and_then(|map| map.get(&(project.to_owned(), pipeline.to_owned())));
        Ok(book.map_or_else(Default::default, |book| {
            (book.rows.clone(), book.hold.clone())
        }))
    }

    /// Writes a judged run: the new misses, and the hold set or cleared.
    pub async fn settle(
        &self,
        project: &str,
        pipeline: &str,
        misses: &[(String, u8)],
        hold: Option<&Hold>,
    ) -> Result<(), sqlx::Error> {
        if let Inner::Postgres(pool) = &self.inner {
            let mut tx = pool.begin().await?;
            let (ids, counts): (Vec<&str>, Vec<i16>) = misses
                .iter()
                .map(|(id, missed)| (id.as_str(), i16::from(*missed)))
                .unzip();
            sqlx::query(
                "UPDATE pipeline_source_ledger AS l SET misses = t.m \
                 FROM UNNEST($3::text[], $4::smallint[]) AS t(i, m) \
                 WHERE l.project = $1 AND l.pipeline = $2 AND l.entity_id = t.i",
            )
            .bind(project)
            .bind(pipeline)
            .bind(&ids)
            .bind(&counts)
            .execute(&mut *tx)
            .await?;
            set_hold(&mut tx, project, pipeline, hold).await?;
            return tx.commit().await;
        }
        if let Some(mut map) = self.memory() {
            let book = map
                .entry((project.to_owned(), pipeline.to_owned()))
                .or_default();
            for (id, missed) in misses {
                if let Some(row) = book.rows.get_mut(id) {
                    row.misses = *missed;
                }
            }
            book.hold = hold.cloned();
        }
        Ok(())
    }

    /// Takes deleted ids out of the ledger.
    pub async fn forget(
        &self,
        project: &str,
        pipeline: &str,
        ids: &[String],
    ) -> Result<(), sqlx::Error> {
        if let Inner::Postgres(pool) = &self.inner {
            sqlx::query(
                "DELETE FROM pipeline_source_ledger WHERE project = $1 AND pipeline = $2 \
                 AND entity_id = ANY($3::text[])",
            )
            .bind(project)
            .bind(pipeline)
            .bind(ids)
            .execute(pool)
            .await?;
            return Ok(());
        }
        if let Some(mut map) = self.memory() {
            if let Some(book) = map.get_mut(&(project.to_owned(), pipeline.to_owned())) {
                ids.iter().for_each(|id| {
                    book.rows.remove(id);
                });
            }
        }
        Ok(())
    }

    /// "Keep": every id counts as read again and the hold is cleared.
    pub async fn keep(&self, project: &str, pipeline: &str) -> Result<(), sqlx::Error> {
        if let Inner::Postgres(pool) = &self.inner {
            let mut tx = pool.begin().await?;
            sqlx::query(
                "UPDATE pipeline_source_ledger SET misses = 0 WHERE project = $1 AND pipeline = $2",
            )
            .bind(project)
            .bind(pipeline)
            .execute(&mut *tx)
            .await?;
            set_hold(&mut tx, project, pipeline, None).await?;
            return tx.commit().await;
        }
        if let Some(mut map) = self.memory() {
            if let Some(book) = map.get_mut(&(project.to_owned(), pipeline.to_owned())) {
                book.rows.values_mut().for_each(|row| row.misses = 0);
                book.hold = None;
            }
        }
        Ok(())
    }

    /// Every hold, for the alerts.
    pub async fn holds(&self) -> Result<Vec<(String, String, Hold)>, sqlx::Error> {
        if let Inner::Postgres(pool) = &self.inner {
            let rows: Vec<(String, String, String, String, i32, i32)> = sqlx::query_as(
                "SELECT project, pipeline, run, reason, would, ledger FROM pipeline_source_holds",
            )
            .fetch_all(pool)
            .await?;
            return Ok(rows
                .into_iter()
                .map(|(project, pipeline, run, reason, would, ledger)| {
                    let hold = Hold {
                        run,
                        reason: HoldReason::parse(&reason),
                        would: usize::try_from(would).unwrap_or_default(),
                        ledger: usize::try_from(ledger).unwrap_or_default(),
                    };
                    (project, pipeline, hold)
                })
                .collect());
        }
        let map = self.memory();
        Ok(map
            .iter()
            .flat_map(|map| map.iter())
            .filter_map(|((project, pipeline), book)| {
                let hold = book.hold.clone()?;
                Some((project.clone(), pipeline.clone(), hold))
            })
            .collect())
    }
}

/// One entity a snapshot pipeline deleted because its source no longer listed it (T-4892): the
/// tombstone's "removed at the source" as the pipeline's panel and the space say it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(as = PipelineSourceRemoval)]
pub struct Removal {
    pub id: String,
    pub pipeline: String,
    pub run: String,
    /// When the gateway confirmed the delete, RFC 3339.
    pub at: String,
    /// The `JC-Reason` the delete carried.
    pub reason: String,
}

/// The removals the memory ledger keeps per pipeline; the database keeps `REMOVED_DAYS`.
const REMOVALS_KEPT: usize = 1000;
/// How long a removal is remembered.
const REMOVED_DAYS: i32 = 400;

impl Ledger {
    /// Notes the last run that read the source completely (T-4892).
    pub async fn completed(
        &self,
        project: &str,
        pipeline: &str,
        run: &str,
    ) -> Result<(), sqlx::Error> {
        if let Inner::Postgres(pool) = &self.inner {
            sqlx::query(
                "INSERT INTO pipeline_source_complete (project, pipeline, run) VALUES ($1, $2, $3) \
                 ON CONFLICT (project, pipeline) DO UPDATE SET run = $3, at = now()",
            )
            .bind(project)
            .bind(pipeline)
            .bind(run)
            .execute(pool)
            .await?;
            return Ok(());
        }
        if let Some(mut map) = self.memory() {
            map.entry((project.to_owned(), pipeline.to_owned()))
                .or_default()
                .complete = Some((run.to_owned(), chrono::Utc::now().to_rfc3339()));
        }
        Ok(())
    }

    /// The last complete run and when it was judged.
    pub async fn last_complete(
        &self,
        project: &str,
        pipeline: &str,
    ) -> Result<Option<(String, String)>, sqlx::Error> {
        if let Inner::Postgres(pool) = &self.inner {
            let row: Option<(String, time::OffsetDateTime)> = sqlx::query_as(
                "SELECT run, at FROM pipeline_source_complete WHERE project = $1 AND pipeline = $2",
            )
            .bind(project)
            .bind(pipeline)
            .fetch_optional(pool)
            .await?;
            return Ok(row.map(|(run, at)| (run, crate::pipeline_log::rfc3339(at))));
        }
        let map = self.memory();
        Ok(map
            .as_ref()
            .and_then(|map| map.get(&(project.to_owned(), pipeline.to_owned())))
            .and_then(|book| book.complete.clone()))
    }

    /// Remembers the ids a delete stream removed from `space`, with the run that decided it.
    pub async fn removed(
        &self,
        project: &str,
        space: &str,
        pipeline: &str,
        run: &str,
        ids: &[String],
    ) -> Result<(), sqlx::Error> {
        if ids.is_empty() {
            return Ok(());
        }
        if let Inner::Postgres(pool) = &self.inner {
            let mut tx = pool.begin().await?;
            sqlx::query(
                "INSERT INTO pipeline_source_removed (project, space, entity_id, pipeline, run) \
                 SELECT $1, $2, i, $3, $4 FROM UNNEST($5::text[]) AS t(i) \
                 ON CONFLICT (project, space, entity_id) DO UPDATE SET pipeline = $3, run = $4, \
                 at = now()",
            )
            .bind(project)
            .bind(space)
            .bind(pipeline)
            .bind(run)
            .bind(ids)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "DELETE FROM pipeline_source_removed WHERE project = $1 \
                 AND at < now() - make_interval(days => $2)",
            )
            .bind(project)
            .bind(REMOVED_DAYS)
            .execute(&mut *tx)
            .await?;
            return tx.commit().await;
        }
        if let Some(mut map) = self.memory() {
            let book = map
                .entry((project.to_owned(), pipeline.to_owned()))
                .or_default();
            let at = chrono::Utc::now().to_rfc3339();
            for id in ids {
                book.removed.retain(|(_, removal)| &removal.id != id);
                let removal = Removal {
                    id: id.clone(),
                    pipeline: pipeline.to_owned(),
                    run: run.to_owned(),
                    at: at.clone(),
                    reason: reason(pipeline, run),
                };
                book.removed.push((space.to_owned(), removal));
            }
            let over = book.removed.len().saturating_sub(REMOVALS_KEPT);
            book.removed.drain(..over);
        }
        Ok(())
    }

    /// The newest removals, at most `limit`: of one pipeline, or of every pipeline in one space.
    pub async fn removals(
        &self,
        project: &str,
        of: RemovalsOf<'_>,
        limit: usize,
    ) -> Result<Vec<Removal>, sqlx::Error> {
        let (pipeline, space) = match of {
            RemovalsOf::Pipeline(name) => (Some(name), None),
            RemovalsOf::Space(name) => (None, Some(name)),
        };
        if let Inner::Postgres(pool) = &self.inner {
            let rows: Vec<(String, String, String, time::OffsetDateTime)> = sqlx::query_as(
                "SELECT entity_id, pipeline, run, at FROM pipeline_source_removed \
                 WHERE project = $1 AND ($2::text IS NULL OR pipeline = $2) \
                 AND ($3::text IS NULL OR space = $3) ORDER BY at DESC, entity_id LIMIT $4",
            )
            .bind(project)
            .bind(pipeline)
            .bind(space)
            .bind(i64::try_from(limit).unwrap_or(i64::MAX))
            .fetch_all(pool)
            .await?;
            return Ok(rows
                .into_iter()
                .map(|(id, pipeline, run, at)| Removal {
                    reason: reason(&pipeline, &run),
                    id,
                    pipeline,
                    run,
                    at: crate::pipeline_log::rfc3339(at),
                })
                .collect());
        }
        let map = self.memory();
        let mut found: Vec<Removal> = map
            .iter()
            .flat_map(|map| map.iter())
            .filter(|((p, name), _)| p == project && pipeline.is_none_or(|want| want == name))
            .flat_map(|(_, book)| book.removed.iter())
            .filter(|(at_space, _)| space.is_none_or(|want| want == at_space))
            .map(|(_, removal)| removal.clone())
            .collect();
        found.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| a.id.cmp(&b.id)));
        found.truncate(limit);
        Ok(found)
    }
}

/// Whose removals [`Ledger::removals`] lists.
#[derive(Debug, Clone, Copy)]
pub enum RemovalsOf<'a> {
    Pipeline(&'a str),
    Space(&'a str),
}

async fn set_hold(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    project: &str,
    pipeline: &str,
    hold: Option<&Hold>,
) -> Result<(), sqlx::Error> {
    let Some(hold) = hold else {
        sqlx::query("DELETE FROM pipeline_source_holds WHERE project = $1 AND pipeline = $2")
            .bind(project)
            .bind(pipeline)
            .execute(&mut **tx)
            .await?;
        return Ok(());
    };
    sqlx::query(
        "INSERT INTO pipeline_source_holds (project, pipeline, run, reason, would, ledger) \
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (project, pipeline) DO UPDATE SET \
         run = $3, reason = $4, would = $5, ledger = $6, at = now()",
    )
    .bind(project)
    .bind(pipeline)
    .bind(&hold.run)
    .bind(hold.reason.as_str())
    .bind(i32::try_from(hold.would).unwrap_or(i32::MAX))
    .bind(i32::try_from(hold.ledger).unwrap_or(i32::MAX))
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// A run the queue saw end (PL-78).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunEnd {
    pub project: String,
    pub pipeline: String,
    pub run: String,
    /// The runner finished it; a timeout, a lost run or a refused start is `false`.
    pub finished: bool,
}

/// Feeds the ledger from one outcome report of a snapshot pipeline: what was written and what the
/// model refused both exist at the source.
pub async fn note_seen(
    state: &AppState,
    project: &str,
    pipeline: &str,
    run: &str,
    ids: &[String],
    wrote: bool,
) {
    let snapshot = state
        .mirror
        .get(project, "Pipeline", pipeline)
        .is_some_and(|p| snapshot_rule(&p.spec).is_some());
    if !snapshot || ids.is_empty() {
        return;
    }
    if let Err(error) = state
        .source_ledger
        .seen(project, pipeline, run, ids, wrote)
        .await
    {
        tracing::warn!(project, pipeline, %error, "the source ledger missed a report's ids");
    }
}

/// Judges one ended run of a snapshot pipeline and starts its deletes (PL-97).
pub async fn run_ended(state: &AppState, end: RunEnd) {
    let RunEnd {
        project,
        pipeline,
        run,
        finished,
    } = end;
    let Some(spec) = state
        .mirror
        .get(&project, "Pipeline", &pipeline)
        .map(|p| p.spec)
    else {
        return;
    };
    let Some(rule) = snapshot_rule(&spec) else {
        return;
    };
    if let Err(error) = judge_and_delete(state, &project, &pipeline, &run, finished, &rule).await {
        tracing::warn!(%project, %pipeline, %run, %error, "the run's source deletes were not judged");
    }
}

async fn judge_and_delete(
    state: &AppState,
    project: &str,
    pipeline: &str,
    run: &str,
    finished: bool,
    rule: &SourceDeletes,
) -> Result<(), sqlx::Error> {
    let ledger = &state.source_ledger;
    let (rows, _) = ledger.book(project, pipeline).await?;
    let logged = state
        .pipeline_log
        .runs(project, pipeline, crate::pipeline_log::RUNS_KEPT)
        .await?
        .into_iter()
        .find(|logged| logged.run == run);
    // A run that did not finish or failed on a record read part of its source at best.
    if !finished || logged.as_ref().is_some_and(|logged| logged.failed > 0) {
        let hold = Hold {
            run: run.to_owned(),
            reason: HoldReason::Incomplete,
            would: 0,
            ledger: rows.len(),
        };
        return ledger.settle(project, pipeline, &[], Some(&hold)).await;
    }
    let rejected = logged.map_or(0, |logged| logged.rejected);
    crate::telemetry::pipeline_missing(
        project,
        pipeline,
        usize::try_from(rejected).unwrap_or(usize::MAX),
    );
    if rows.is_empty() {
        return ledger.completed(project, pipeline, run).await;
    }
    let (misses, verdict) = judge(&rows, run, rule);
    if !matches!(&verdict, Verdict::Held(hold) if hold.reason == HoldReason::Empty) {
        ledger.completed(project, pipeline, run).await?;
    }
    let orphans = misses.iter().filter(|(_, missed)| *missed > 0).count();
    crate::telemetry::pipeline_orphans(project, pipeline, orphans);
    match verdict {
        Verdict::Held(hold) => ledger.settle(project, pipeline, &misses, Some(&hold)).await,
        Verdict::Delete(doomed) => {
            ledger.settle(project, pipeline, &misses, None).await?;
            if !doomed.is_empty() {
                if let Err(reason) = launch(state, project, pipeline, run, &doomed).await {
                    tracing::warn!(project, pipeline, run, %reason, "the source deletes were not started; they go after the next complete run");
                }
            }
            Ok(())
        }
    }
}

/// The ids whose misses reached the rule: what the next delete takes, and what a release deletes.
pub fn doomed(rows: &BTreeMap<String, Row>, rule: &SourceDeletes) -> Vec<String> {
    rows.iter()
        .filter(|(_, row)| row.misses >= rule.misses())
        .map(|(id, _)| id.clone())
        .collect()
}

/// The spec of the Endpoint the pipeline's first output writes through.
fn output_endpoint(state: &AppState, project: &str, spec: &Value) -> Option<Value> {
    let spec: jc_core::kinds::PipelineSpec = serde_json::from_value(spec.clone()).ok()?;
    let output = spec.outputs().into_iter().next()?;
    let endpoint = state
        .mirror
        .get(project, "Endpoint", output.target_endpoint.local_id())?;
    Some(endpoint.spec)
}

/// The Endpoint slug of the pipeline's first output.
fn target(state: &AppState, project: &str, spec: &Value) -> Option<String> {
    Some(
        output_endpoint(state, project, spec)?
            .get("slug")?
            .as_str()?
            .to_owned(),
    )
}

/// The space the pipeline's first output writes into.
pub fn space_of(state: &AppState, project: &str, spec: &Value) -> Option<String> {
    let endpoint = output_endpoint(state, project, spec)?;
    crate::api::assistant::ref_name(endpoint.get("contextSpaceRef")?)
}

/// Hands the runner the stream that deletes `ids` (PL-97): through the output Endpoint, as the
/// pipeline's account, its answers reported to the Portal's internal listener.
pub async fn launch(
    state: &AppState,
    project: &str,
    pipeline: &str,
    run: &str,
    ids: &[String],
) -> Result<usize, String> {
    let spec = state
        .mirror
        .get(project, "Pipeline", pipeline)
        .map(|p| p.spec)
        .ok_or("the pipeline is gone")?;
    let slug = target(state, project, &spec).ok_or("the pipeline writes through no Endpoint")?;
    let runner = state
        .config
        .pipeline_runner_url
        .as_deref()
        .ok_or("no pipeline runner is configured")?
        .replace("{project}", project)
        .trim_end_matches('/')
        .to_owned();
    let internal = state
        .config
        .pipeline_test_capture_url
        .as_deref()
        .ok_or("no internal listener is configured for the runner")?
        .trim_end_matches('/')
        .to_owned();
    let ids: Vec<String> = ids
        .iter()
        .filter(|id| deletable(id))
        .take(MAX_PER_STREAM)
        .cloned()
        .collect();
    let report = format!("{internal}/internal/pipelines/{project}/{pipeline}/source-deletes");
    let mut config = render(project, pipeline, &slug, run, &ids, &report);
    if state.config.pipeline_identity {
        crate::reconciler::streams::with_pipeline_identity(&mut config, project, pipeline);
    }
    let stream = format!(
        "{runner}/streams/{}.source-deletes",
        crate::reconciler::streams::stream_id(project, pipeline)
    );
    let http = crate::api::pipelines::http();
    // A stream of an earlier run that is still listed is replaced, never run twice.
    let _ = http.delete(&stream).send().await;
    match http.post(&stream).json(&config).send().await {
        Ok(answer) if answer.status().is_success() => {}
        Ok(answer) => return Err(format!("the runner answered {}", answer.status())),
        Err(error) => return Err(error.to_string()),
    }
    tokio::spawn(async move {
        tokio::time::sleep(STREAM_WINDOW).await;
        if let Err(error) = crate::api::pipelines::http().delete(&stream).send().await {
            tracing::warn!(%error, "a source-delete stream was not removed");
        }
    });
    Ok(ids.len())
}

/// The reason a snapshot delete names (PL-100): the pipeline and the run that decided it.
fn reason(pipeline: &str, run: &str) -> String {
    format!("source-snapshot: pipeline {pipeline} run {run}")
}

/// `JC-Reason` as the gateway reads it: percent-encoded UTF-8.
fn reason_header(pipeline: &str, run: &str) -> String {
    reason(pipeline, run)
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                char::from(b).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// The delete stream: one message per `CHUNK` ids, each a batch delete on the Endpoint, its
/// answer reduced to what went, what was gone already and what the gateway refused, and posted
/// to `report`. The ids ride base64-encoded, so no id is ever read as config.
pub fn render(
    project: &str,
    pipeline: &str,
    slug: &str,
    run: &str,
    ids: &[String],
    report: &str,
) -> Value {
    use base64::Engine;
    let chunks: Vec<Value> = ids
        .chunks(CHUNK)
        .map(|chunk| json!({ "run": run, "ids": chunk }))
        .collect();
    let encoded = base64::engine::general_purpose::STANDARD.encode(Value::from(chunks).to_string());
    let oauth2 = crate::reconciler::streams::pipeline_oauth2(project);
    let not_found = r#"e.error.status.or(0) == 404 || e.error.type.or("").string().has_suffix("ResourceNotFound")"#;
    json!({
        "input": { "generate": {
            "count": 1,
            "interval": "",
            "mapping": format!("root = \"{encoded}\".decode(\"base64\").parse_json()"),
        }},
        "pipeline": { "processors": [
            { "unarchive": { "format": "json_array" } },
            { "try": [
                { "branch": {
                    "request_map": "root = this.ids",
                    "processors": [{ "http": {
                        "url": format!("${{JC_GATEWAY_URL}}/api/endpoint/{slug}/ngsi-ld/v1/entityOperations/delete"),
                        "verb": "POST",
                        "headers": {
                            "Content-Type": "application/json",
                            "Accept": "application/json",
                            "JC-Reason": reason_header(pipeline, run),
                        },
                        "oauth2": oauth2,
                        "timeout": "30s",
                        "retries": 1,
                    }}],
                    "result_map": "root.answer = if content().length() == 0 { null } else { this }",
                }},
                { "mapping": format!(
                    "let errors = this.answer.errors.or([])\n\
                     root.run = this.run\n\
                     root.deleted = if this.answer == null {{ this.ids }} else {{ this.answer.success.or([]) }}\n\
                     root.gone = $errors.filter(e -> {not_found}).map_each(e -> e.entityId)\n\
                     root.failed = $errors.filter(e -> !({not_found})).map_each(e -> {{\"id\": e.entityId, \"message\": e.error.title.or(e.error.detail).or(\"refused\").string()}})"
                ) },
            ]},
            { "catch": [{ "mapping":
                "root = {\"run\": this.run, \"deleted\": [], \"gone\": [], \"failed\": this.ids.map_each(id -> {\"id\": id, \"message\": error().or(\"the gateway did not answer\")})}"
            }]},
        ]},
        "output": { "http_client": {
            "url": report,
            "verb": "POST",
            "headers": { "Content-Type": "application/json" },
            "timeout": "10s",
            "oauth2": crate::reconciler::streams::pipeline_oauth2(project),
        }},
    })
}

/// What a delete stream reports per chunk.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Report {
    pub run: String,
    pub deleted: Vec<String>,
    pub gone: Vec<String>,
    pub failed: Vec<Failed>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Failed {
    pub id: String,
    pub message: String,
}

/// Takes one report: what went and what was gone leave the ledger, and the activity feed says
/// which entities the pipeline deleted and why. Ids outside the ledger are ignored.
pub async fn reported(
    state: &AppState,
    project: &str,
    pipeline: &str,
    report: Report,
) -> Result<(), sqlx::Error> {
    let (rows, _) = state.source_ledger.book(project, pipeline).await?;
    let left: Vec<String> = report
        .deleted
        .iter()
        .chain(&report.gone)
        .filter(|id| rows.contains_key(*id))
        .cloned()
        .collect();
    state.source_ledger.forget(project, pipeline, &left).await?;
    let deleted: Vec<String> = report
        .deleted
        .iter()
        .filter(|id| rows.contains_key(*id))
        .cloned()
        .collect();
    let space = state
        .mirror
        .get(project, "Pipeline", pipeline)
        .and_then(|p| space_of(state, project, &p.spec));
    if let Some(space) = space {
        state
            .source_ledger
            .removed(project, &space, pipeline, &report.run, &deleted)
            .await?;
    }
    let failed: Vec<String> = report
        .failed
        .iter()
        .take(20)
        .map(|f| {
            format!(
                "{}: {}",
                f.id,
                crate::pipeline_outcomes::mask_text(&f.message)
            )
        })
        .collect();
    if deleted.is_empty() && failed.is_empty() {
        return Ok(());
    }
    let event = crate::activity::ActivityEvent {
        time: chrono::Utc::now(),
        project: project.to_owned(),
        space: None,
        kind: "pipeline.source-delete".to_owned(),
        source: "portal".to_owned(),
        summary: format!(
            "pipeline {pipeline} deleted {} entities its source no longer lists (run {}){}",
            deleted.len(),
            report.run,
            if failed.is_empty() {
                String::new()
            } else {
                format!("; the gateway refused {}", report.failed.len())
            }
        ),
        severity: if failed.is_empty() { "info" } else { "warning" }.to_owned(),
        correlation_id: None,
        details: json!({
            "object": format!("pipelines/{pipeline}"),
            "run": report.run,
            "reason": reason(pipeline, &report.run),
            "deleted": deleted.iter().take(20).collect::<Vec<_>>(),
            "refused": failed,
        }),
    };
    if let Err(error) = state.activity.append(&[event]).await {
        tracing::warn!(project, pipeline, %error, "the source deletes are not on the activity feed");
    }
    Ok(())
}

/// The ledger as the pipeline's page shows it, with the dry run: what the next complete run that
/// misses them again would delete (PL-97).
#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(as = PipelineSourceDeletes)]
pub struct Overview {
    pub misses: u8,
    pub max_share: u8,
    /// The ids in the ledger.
    pub ledger: usize,
    /// The ids at their last miss: one more complete run without them deletes them.
    pub next: Vec<String>,
    /// The ids whose misses already reached the rule and wait for a delete or a release.
    pub due: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hold: Option<Hold>,
    /// The space the pipeline writes into.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub space: Option<String>,
    /// The last run that read the source completely: the source side of the report (T-4892).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_complete: Option<CompleteRun>,
    /// In the space, gone at the source: ids at least one complete run in a row did not read.
    pub orphans: usize,
    pub orphan_ids: Vec<String>,
    /// At the source, not in the space: records the last complete run read and the model refused.
    pub missing: usize,
    pub missing_ids: Vec<String>,
    /// The newest entities the pipeline deleted because its source dropped them.
    pub removed: Vec<Removal>,
}

/// The last run that read the source completely.
#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(as = PipelineSourceCompleteRun)]
pub struct CompleteRun {
    pub run: String,
    /// When the run was judged, RFC 3339.
    pub at: String,
    /// The records the run read: written and refused.
    pub read: u64,
}

/// The most ids each list of the overview names.
const LISTED: usize = 200;

/// The pipeline's report: the ledger and its dry run beside what the last complete run read,
/// what it could not write and what the pipeline deleted (T-4892). Ids only.
pub async fn report(
    state: &AppState,
    project: &str,
    pipeline: &str,
    spec: &Value,
    rule: &SourceDeletes,
) -> Result<Overview, sqlx::Error> {
    let ledger = &state.source_ledger;
    let (rows, hold) = ledger.book(project, pipeline).await?;
    let mut report = overview(&rows, hold, rule);
    report.space = space_of(state, project, spec);
    report.removed = ledger
        .removals(project, RemovalsOf::Pipeline(pipeline), LISTED)
        .await?;
    let Some((run, at)) = ledger.last_complete(project, pipeline).await? else {
        return Ok(report);
    };
    let log = &state.pipeline_log;
    let read = log
        .runs(project, pipeline, crate::pipeline_log::RUNS_KEPT)
        .await?
        .into_iter()
        .find(|logged| logged.run == run)
        .map_or(0, |logged| logged.sent + logged.rejected);
    let lines = log
        .lines(
            project,
            pipeline,
            &run,
            crate::pipeline_log::LINES_KEPT,
            None,
        )
        .await?;
    let missing: std::collections::BTreeSet<String> = lines
        .into_iter()
        .filter(|line| line.outcome == crate::pipeline_log::Outcome::Rejected)
        .map(|line| line.record_id)
        .collect();
    report.missing = missing.len();
    report.missing_ids = missing.into_iter().take(LISTED).collect();
    report.last_complete = Some(CompleteRun { run, at, read });
    Ok(report)
}

pub fn overview(
    rows: &BTreeMap<String, Row>,
    hold: Option<Hold>,
    rule: &SourceDeletes,
) -> Overview {
    let at = |misses: u8| -> Vec<String> {
        rows.iter()
            .filter(|(_, row)| {
                row.misses == misses || (misses == rule.misses() && row.misses > misses)
            })
            .map(|(id, _)| id.clone())
            .take(LISTED)
            .collect()
    };
    Overview {
        misses: rule.misses(),
        max_share: rule.max_share(),
        ledger: rows.len(),
        next: at(rule.misses() - 1),
        due: at(rule.misses()),
        hold,
        space: None,
        last_complete: None,
        orphans: rows.values().filter(|row| row.misses > 0).count(),
        orphan_ids: rows
            .iter()
            .filter(|(_, row)| row.misses > 0)
            .map(|(id, _)| id.clone())
            .take(LISTED)
            .collect(),
        missing: 0,
        missing_ids: Vec::new(),
        removed: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(misses: u8, max_share: u8) -> SourceDeletes {
        serde_json::from_value(
            json!({ "mode": "snapshot", "misses": misses, "maxShare": max_share }),
        )
        .expect("rule")
    }

    fn ledger(rows: &[(&str, &str, u8)]) -> BTreeMap<String, Row> {
        rows.iter()
            .map(|(id, run, misses)| {
                let row = Row {
                    last_run: (*run).to_owned(),
                    misses: *misses,
                };
                ((*id).to_owned(), row)
            })
            .collect()
    }

    fn fifty(dropped: &[usize], run: &str, before: u8) -> BTreeMap<String, Row> {
        (0..50)
            .map(|n| {
                let row = Row {
                    last_run: if dropped.contains(&n) { "r0" } else { run }.to_owned(),
                    misses: if dropped.contains(&n) { before } else { 0 },
                };
                (format!("urn:ngsi-ld:Dataset:{n}"), row)
            })
            .collect()
    }

    #[test]
    fn three_of_fifty_dropped_go_after_two_complete_runs_and_not_after_one() {
        let rule = rule(2, 10);
        let (misses, verdict) = judge(&fifty(&[3, 7, 9], "r1", 0), "r1", &rule);
        assert_eq!(verdict, Verdict::Delete(Vec::new()));
        assert_eq!(misses.iter().filter(|(_, m)| *m == 1).count(), 3);
        let (_, verdict) = judge(&fifty(&[3, 7, 9], "r2", 1), "r2", &rule);
        assert_eq!(
            verdict,
            Verdict::Delete(
                [
                    "urn:ngsi-ld:Dataset:3",
                    "urn:ngsi-ld:Dataset:7",
                    "urn:ngsi-ld:Dataset:9"
                ]
                .map(str::to_owned)
                .to_vec()
            )
        );
    }

    #[test]
    fn a_record_back_at_the_source_has_its_misses_cleared() {
        let rows = ledger(&[("urn:a", "r2", 1), ("urn:b", "r2", 0)]);
        let (misses, verdict) = judge(&rows, "r2", &rule(2, 100));
        assert_eq!(
            misses,
            vec![("urn:a".to_owned(), 0), ("urn:b".to_owned(), 0)]
        );
        assert_eq!(verdict, Verdict::Delete(Vec::new()));
    }

    #[test]
    fn more_than_the_share_is_held_and_deletes_nothing() {
        let rows = fifty(&[1, 2, 3, 4, 5, 6], "r2", 1);
        let (misses, verdict) = judge(&rows, "r2", &rule(2, 10));
        let Verdict::Held(hold) = verdict else {
            panic!("not held: {verdict:?}")
        };
        assert_eq!(hold.reason, HoldReason::ShareExceeded);
        assert_eq!((hold.would, hold.ledger), (6, 50));
        assert!(hold.detail().contains("would delete 6 of 50"));
        // The misses still count, so the next complete run is judged the same way.
        assert_eq!(misses.iter().filter(|(_, m)| *m == 2).count(), 6);
        // Five of fifty is the share exactly and goes.
        let (_, verdict) = judge(&fifty(&[1, 2, 3, 4, 5], "r2", 1), "r2", &rule(2, 10));
        assert!(matches!(verdict, Verdict::Delete(ids) if ids.len() == 5));
    }

    #[test]
    fn a_run_that_read_none_of_the_ledger_is_held_empty_and_counts_no_miss() {
        let rows = fifty(&[], "r1", 0);
        let (misses, verdict) = judge(&rows, "r9", &rule(1, 100));
        assert!(misses.is_empty());
        assert!(matches!(
            verdict,
            Verdict::Held(Hold {
                reason: HoldReason::Empty,
                would: 0,
                ..
            })
        ));
    }

    #[test]
    fn only_a_snapshot_rule_within_bounds_acts() {
        let spec = |rule: Value| json!({ "sourceDeletes": rule });
        assert!(snapshot_rule(&spec(json!({ "mode": "snapshot" })))
            .is_some_and(|r| r.misses() == 2 && r.max_share() == 10));
        for refused in [
            json!({ "mode": "snapshot", "misses": 0 }),
            json!({ "mode": "snapshot", "misses": 11 }),
            json!({ "mode": "snapshot", "maxShare": 0 }),
            json!({ "mode": "snapshot", "maxShare": 101 }),
            json!({ "mode": "events", "deletedWhen": "this.gone" }),
            json!({ "mode": "never" }),
            json!({ "mode": "lease" }),
            json!({ "mode": "snapshot", "what": 1 }),
        ] {
            assert!(snapshot_rule(&spec(refused.clone())).is_none(), "{refused}");
        }
        assert!(snapshot_rule(&json!({})).is_none());
    }

    #[test]
    fn only_a_plain_uri_may_be_deleted() {
        assert!(deletable("urn:ngsi-ld:Dataset:sk.bbsk:open:ab-1"));
        assert!(deletable("https://data.example/ds/1"));
        for bad in [
            "",
            "no-colon",
            "urn:a b",
            "urn:${JC_CLIENT_SECRET_X}",
            "urn:\"x",
            "urn:a\\b",
            "urn:ž",
        ] {
            assert!(!deletable(bad), "{bad:?}");
        }
        assert!(!deletable(&format!("urn:{}", "a".repeat(MAX_ID))));
    }

    #[test]
    fn the_delete_stream_goes_through_the_endpoint_with_the_reason_and_reports_back() {
        let ids: Vec<String> = (0..250).map(|n| format!("urn:x:{n}")).collect();
        let stream = render(
            "helsinki",
            "registry",
            "ep-slug",
            "2026-10-20T05:00:00Z",
            &ids,
            "http://portal-internal:8081/internal/pipelines/helsinki/registry/source-deletes",
        );
        let text = stream.to_string();
        // No id is in the config as text: Bento would read `${...}` in it.
        assert!(!text.contains("urn:x:1"));
        let mapping = stream["input"]["generate"]["mapping"]
            .as_str()
            .expect("mapping");
        let encoded = mapping
            .strip_prefix("root = \"")
            .and_then(|m| m.split('"').next())
            .expect("encoded");
        use base64::Engine;
        let chunks: Value = serde_json::from_slice(
            &base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .expect("base64"),
        )
        .expect("json");
        let chunks = chunks.as_array().expect("chunks");
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[2]["ids"].as_array().map(Vec::len), Some(50));
        assert_eq!(chunks[0]["run"], "2026-10-20T05:00:00Z");
        let http =
            &stream["pipeline"]["processors"][1]["try"][0]["branch"]["processors"][0]["http"];
        assert_eq!(
            http["url"],
            "${JC_GATEWAY_URL}/api/endpoint/ep-slug/ngsi-ld/v1/entityOperations/delete"
        );
        assert_eq!(
            http["headers"]["JC-Reason"],
            "source-snapshot%3A%20pipeline%20registry%20run%202026-10-20T05%3A00%3A00Z"
        );
        assert_eq!(http["oauth2"]["client_key"], "helsinki-pipelines");
        assert_eq!(
            stream["output"]["http_client"]["url"],
            "http://portal-internal:8081/internal/pipelines/helsinki/registry/source-deletes"
        );
    }

    /// The stream as the runner gets it, for a Bento run against a gateway and a Portal stand-in:
    /// regenerate with `JC_UPDATE_GOLDEN=1`.
    #[test]
    fn the_delete_stream_matches_its_golden() {
        let ids: Vec<String> = (0..160).map(|n| format!("urn:x:{n}")).collect();
        let stream = render(
            "helsinki",
            "registry",
            "ep-slug",
            "2026-10-20T05:00:00Z",
            &ids,
            "http://127.0.0.1:18089/report",
        );
        let golden = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/source-deletes/stream.json"
        );
        let text = serde_json::to_string_pretty(&stream).expect("json") + "\n";
        if std::env::var_os("JC_UPDATE_GOLDEN").is_some() {
            std::fs::write(golden, &text).expect("golden written");
        }
        assert_eq!(std::fs::read_to_string(golden).expect("golden"), text);
    }

    #[test]
    fn the_overview_lists_the_next_and_the_due_ids() {
        let rows = ledger(&[
            ("urn:a", "r", 0),
            ("urn:b", "r", 1),
            ("urn:c", "r", 2),
            ("urn:d", "r", 3),
        ]);
        let seen = overview(&rows, None, &rule(2, 10));
        assert_eq!(seen.ledger, 4);
        assert_eq!(seen.next, vec!["urn:b"]);
        assert_eq!(seen.due, vec!["urn:c", "urn:d"]);
        assert_eq!(doomed(&rows, &rule(2, 10)), vec!["urn:c", "urn:d"]);
    }

    #[tokio::test]
    async fn the_memory_ledger_keeps_ids_misses_and_the_hold() {
        let ledger = Ledger::new(None);
        let ids = ["urn:a", "urn:b", "bad id"].map(str::to_owned);
        ledger.seen("p", "x", "r1", &ids, true).await.expect("seen");
        // A refused record keeps a known row alive and adds no new one.
        let refused = ["urn:a", "urn:never-written"].map(str::to_owned);
        ledger
            .seen("p", "x", "r2", &refused, false)
            .await
            .expect("seen");
        let (rows, hold) = ledger.book("p", "x").await.expect("book");
        assert_eq!(rows.keys().collect::<Vec<_>>(), ["urn:a", "urn:b"]);
        assert_eq!(
            (
                rows["urn:a"].last_run.as_str(),
                rows["urn:b"].last_run.as_str()
            ),
            ("r2", "r1")
        );
        assert!(hold.is_none());
        let held = Hold {
            run: "r2".into(),
            reason: HoldReason::ShareExceeded,
            would: 1,
            ledger: 2,
        };
        ledger
            .settle("p", "x", &[("urn:a".into(), 2)], Some(&held))
            .await
            .expect("settle");
        assert_eq!(ledger.holds().await.expect("holds").len(), 1);
        ledger.keep("p", "x").await.expect("keep");
        let (rows, hold) = ledger.book("p", "x").await.expect("book");
        assert_eq!(rows["urn:a"].misses, 0);
        assert!(hold.is_none());
        ledger
            .forget("p", "x", &["urn:a".into()])
            .await
            .expect("forget");
        assert_eq!(ledger.book("p", "x").await.expect("book").0.len(), 1);
        // Another pipeline's ledger is its own.
        assert!(ledger.book("p", "y").await.expect("book").0.is_empty());
    }
}
