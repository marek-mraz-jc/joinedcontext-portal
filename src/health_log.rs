//! The health log (T-5067): what is broken in a project and what to do about it. After the alert
//! run of the leader, every Pipeline, ContextSpace, Endpoint, DataModel and DataSource of the
//! mirror is judged by its checks; each check keeps one row with its status, since when that
//! status holds, when it was last ok, what it said (masked) and a fix hint naming the manifest
//! field or the page to change. The statuses over time are kept 90 days, one point per change or
//! per hour, for the sparkline. The alerts read the same signals (`alerts::read_pipelines`).
//!
//! Checks: `reconcile` for every resource (its status phase and conditions); for a pipeline also
//! `runs` (its run health and Error phase, T-5048) and `freshness` (the space's quality report).
//! ponytail: the surface probes (NGSI-LD, OData, OGC ... with the space's read account) and the
//! SHACL report of T-5066 add checks here once they exist; the table already takes their rows.

use std::collections::BTreeMap;
use std::sync::RwLock;

use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use utoipa::ToSchema;

use crate::alerts::{chrono_of, rfc3339, stamp_of, Event, Signal};
use crate::resource::{Condition, Phase, ResourceEnvelope};
use crate::store::Mirror;

/// How long the history is kept.
pub const KEEP: Duration = Duration::days(90);
/// A status that holds gets a history point once an hour.
const SAMPLE: Duration = Duration::hours(1);
/// The leader writes the log at most this often; a broken surface turns red within it.
pub const EVERY: Duration = Duration::minutes(2);
/// The history one row carries: the last 7 days.
const SHOWN: Duration = Duration::days(7);
/// The longest detail kept, in characters.
const MAX_DETAIL: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
#[schema(as = HealthCheckKind)]
pub enum Kind {
    Pipeline,
    Space,
    Endpoint,
    Model,
    Datasource,
}

/// The manifest kind of each health kind, in the order the page lists them.
const KINDS: [(&str, Kind); 5] = [
    ("Pipeline", Kind::Pipeline),
    ("ContextSpace", Kind::Space),
    ("Endpoint", Kind::Endpoint),
    ("DataModel", Kind::Model),
    ("DataSource", Kind::Datasource),
];

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pipeline => "pipeline",
            Self::Space => "space",
            Self::Endpoint => "endpoint",
            Self::Model => "model",
            Self::Datasource => "datasource",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        KINDS
            .iter()
            .map(|(_, kind)| *kind)
            .find(|kind| kind.as_str() == text)
    }

    /// The manifest kind the permission check asks about.
    pub fn manifest_kind(self) -> &'static str {
        KINDS
            .iter()
            .find(|(_, kind)| *kind == self)
            .map_or("", |(manifest, _)| manifest)
    }

    /// The Portal page of a resource of this kind.
    fn page(self, project: &str, name: &str) -> String {
        let plural = match self {
            Self::Pipeline => "pipelines",
            Self::Space => "spaces",
            Self::Endpoint => "endpoints",
            Self::Model => "models",
            Self::Datasource => "datasources",
        };
        format!("/projects/{project}/{plural}/{name}")
    }
}

/// Errors first, then warnings, then what is well.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
#[schema(as = HealthCheckStatus)]
pub enum Status {
    Error,
    Warn,
    Ok,
}

impl Status {
    fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }

    fn parse(text: &str) -> Self {
        match text {
            "ok" => Self::Ok,
            "warn" => Self::Warn,
            _ => Self::Error,
        }
    }
}

/// What one check found in one run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    pub project: String,
    pub kind: Kind,
    pub name: String,
    pub check: &'static str,
    pub status: Status,
    pub detail: String,
    pub fix_hint: String,
    pub evidence_url: String,
}

type Key = (String, Kind, String, String);

impl Finding {
    fn key(&self) -> Key {
        (
            self.project.clone(),
            self.kind,
            self.name.clone(),
            self.check.to_owned(),
        )
    }
}

/// One point of a check's history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[schema(as = HealthCheckPoint)]
pub struct Point {
    /// RFC 3339.
    pub at: String,
    pub status: Status,
}

/// One check of one resource as the Health page shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(as = HealthCheck)]
pub struct Check {
    pub project: String,
    pub kind: Kind,
    pub name: String,
    /// `reconcile`, `runs` or `freshness`.
    pub check: String,
    pub status: Status,
    /// Since when this status holds, RFC 3339.
    pub since: String,
    /// When the check was last ok, RFC 3339; absent when it never was.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_ok: Option<String>,
    /// When the leader last judged it, RFC 3339.
    pub checked_at: String,
    /// What the check found, credentials masked.
    pub detail: String,
    /// The manifest field or the page to change.
    pub fix_hint: String,
    /// The Portal page of the resource.
    pub evidence_url: String,
    /// The statuses of the last 7 days, oldest first.
    pub history: Vec<Point>,
}

/// The message a resource's status gives: the first condition that does not hold, else any.
fn said(envelope: &ResourceEnvelope) -> String {
    let Some(status) = &envelope.status else {
        return String::new();
    };
    let text = |c: &Condition| c.message.clone().or_else(|| c.reason.clone());
    status
        .conditions
        .iter()
        .filter(|c| c.status == "False")
        .find_map(text)
        .or_else(|| status.conditions.iter().find_map(text))
        .unwrap_or_default()
}

/// A detail fit to show: credentials masked, one line, at most [`MAX_DETAIL`] characters.
fn shown(detail: &str) -> String {
    let one_line = detail.split_whitespace().collect::<Vec<_>>().join(" ");
    crate::pipeline_outcomes::mask_text(&one_line)
        .chars()
        .take(MAX_DETAIL)
        .collect()
}

/// What a person changes when a check of `kind` failed with `detail`.
pub fn fix_hint(kind: Kind, name: &str, detail: &str) -> String {
    let lower = detail.to_ascii_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|n| lower.contains(n));
    if has(&["403", "forbidden", "no policy grants"]) {
        return match kind {
            Kind::Pipeline => format!(
                "The broker refused the write: the target Endpoint's Policy must grant pl-{name} \
                 create and update, or spec.outputs[].targetEndpoint must name an Endpoint \
                 without policyRef."
            ),
            _ => "A Policy refuses this operation: check the Endpoint's policyRef and the \
                  Policy's rules on the Policies page."
                .into(),
        };
    }
    if has(&["401", "unauthorized", "invalid_client", "invalid token"]) {
        return "The account's token was refused: check the ServiceAccount and its secretRef, \
                then sync again."
            .into();
    }
    if has(&["robots"]) {
        return "The source's robots.txt disallows the reader: point spec.source.url at an \
                allowed address or ask the publisher."
            .into();
    }
    if has(&[
        "timed out",
        "timeout",
        "connection",
        "500",
        "502",
        "503",
        "504",
    ]) {
        return match kind {
            Kind::Pipeline | Kind::Datasource => {
                "The source or the broker did not answer: check that spec.source.url opens, \
                 then use Run now on the pipeline page."
                    .into()
            }
            _ => "A service did not answer: wait for the next sync; if it stays red, read the \
                  broker's status on the Organization page."
                .into(),
        };
    }
    match kind {
        Kind::Pipeline => "Open the run log on the pipeline page and fix the step its newest \
                           failed line names."
            .into(),
        _ => format!(
            "Open the {} manifest, change the field the message names and propose the change.",
            kind.manifest_kind()
        ),
    }
}

/// The `reconcile` check of one resource: its phase and the condition that says why.
fn reconcile(project: &str, kind: Kind, envelope: &ResourceEnvelope) -> Finding {
    let name = &envelope.metadata.name;
    let detail = shown(&said(envelope));
    let approvals = "Approve its change on the Approvals page; the next sync applies it.";
    let (status, detail, fix_hint) = match envelope.status.as_ref().map(|s| s.phase) {
        None => (
            Status::Warn,
            "not applied yet".to_owned(),
            approvals.to_owned(),
        ),
        Some(Phase::Live | Phase::Deploying) => (Status::Ok, detail, String::new()),
        Some(Phase::Draft | Phase::Pending) => (
            Status::Warn,
            "waiting for approval".to_owned(),
            approvals.to_owned(),
        ),
        Some(Phase::Drifted) => (
            Status::Warn,
            detail,
            "The platform holds something else than the repository: open it and keep the \
             platform's state or restore the repository's."
                .to_owned(),
        ),
        Some(Phase::Error) => {
            let hint = fix_hint(kind, name, &detail);
            (Status::Error, detail, hint)
        }
    };
    Finding {
        project: project.to_owned(),
        kind,
        name: name.clone(),
        check: "reconcile",
        status,
        detail,
        fix_hint,
        evidence_url: kind.page(project, name),
    }
}

/// Every check of every resource the mirror holds, judged with the alert signals of this run.
pub fn derive(mirror: &Mirror, signals: &[Signal]) -> Vec<Finding> {
    let signal = |project: &str, name: &str, event: Event| {
        signals
            .iter()
            .find(|s| s.key.0 == project && s.key.1 == name && s.key.2 == event)
    };
    let mut findings = Vec::new();
    for (manifest, kind) in KINDS {
        for envelope in mirror.matching(|env| env.kind == manifest) {
            let Some(project) = envelope.metadata.namespace.clone() else {
                continue;
            };
            findings.push(reconcile(&project, kind, &envelope));
            if kind != Kind::Pipeline {
                continue;
            }
            let name = envelope.metadata.name.clone();
            let page = kind.page(&project, &name);
            let (status, detail) = match (
                signal(&project, &name, Event::Failure),
                signal(&project, &name, Event::Zero),
            ) {
                (Some(failure), _) => (Status::Error, shown(&failure.detail)),
                (None, Some(zero)) => (Status::Warn, shown(&zero.detail)),
                (None, None) => (Status::Ok, String::new()),
            };
            let hint = match status {
                Status::Ok => String::new(),
                Status::Warn => "The newest run sent far less than the week before: compare the \
                                 source with the pipeline's filter and mapping on the pipeline page."
                    .into(),
                Status::Error => fix_hint(kind, &name, &detail),
            };
            findings.push(Finding {
                project: project.clone(),
                kind,
                name: name.clone(),
                check: "runs",
                status,
                detail,
                fix_hint: hint,
                evidence_url: page.clone(),
            });
            let stale = signal(&project, &name, Event::Stale).is_some();
            findings.push(Finding {
                project,
                kind,
                name,
                check: "freshness",
                status: if stale { Status::Warn } else { Status::Ok },
                detail: if stale {
                    "no new observation in the window its schedule promises".into()
                } else {
                    String::new()
                },
                fix_hint: if stale {
                    "Check spec.schedule and the source, then use Run now on the pipeline page."
                        .into()
                } else {
                    String::new()
                },
                evidence_url: page,
            });
        }
    }
    findings
}

#[derive(Debug, Clone)]
struct Latest {
    finding: Finding,
    since: DateTime<Utc>,
    last_ok: Option<DateTime<Utc>>,
    checked_at: DateTime<Utc>,
}

#[derive(Default)]
struct Memory {
    latest: BTreeMap<Key, Latest>,
    history: Vec<(Key, DateTime<Utc>, Status)>,
}

impl Memory {
    /// The same rules the Postgres statements of [`HealthStore::record`] hold.
    fn record(&mut self, now: DateTime<Utc>, findings: Vec<Finding>) {
        let mut latest = BTreeMap::new();
        for finding in findings {
            let key = finding.key();
            let before = self.latest.get(&key);
            let since = before
                .filter(|b| b.finding.status == finding.status)
                .map_or(now, |b| b.since);
            let last_ok = if finding.status == Status::Ok {
                Some(now)
            } else {
                before.and_then(|b| b.last_ok)
            };
            let newest = self
                .history
                .iter()
                .rev()
                .find(|(k, _, _)| *k == key)
                .map(|(_, at, status)| (*at, *status));
            if newest.is_none_or(|(at, status)| status != finding.status || at <= now - SAMPLE) {
                self.history.push((key.clone(), now, finding.status));
            }
            latest.insert(
                key,
                Latest {
                    finding,
                    since,
                    last_ok,
                    checked_at: now,
                },
            );
        }
        self.latest = latest;
        self.history.retain(|(_, at, _)| *at >= now - KEEP);
    }

    fn list(&self, project: Option<&str>, now: DateTime<Utc>) -> Vec<Check> {
        self.latest
            .iter()
            .filter(|(key, _)| project.is_none_or(|p| key.0 == p))
            .map(|(key, held)| Check {
                project: key.0.clone(),
                kind: key.1,
                name: key.2.clone(),
                check: key.3.clone(),
                status: held.finding.status,
                since: rfc3339(held.since),
                last_ok: held.last_ok.map(rfc3339),
                checked_at: rfc3339(held.checked_at),
                detail: held.finding.detail.clone(),
                fix_hint: held.finding.fix_hint.clone(),
                evidence_url: held.finding.evidence_url.clone(),
                history: self
                    .history
                    .iter()
                    .filter(|(k, at, _)| k == key && *at > now - SHOWN)
                    .map(|(_, at, status)| Point {
                        at: rfc3339(*at),
                        status: *status,
                    })
                    .collect(),
            })
            .collect()
    }
}

enum Inner {
    Postgres(sqlx::PgPool),
    Memory(RwLock<Memory>),
}

/// One row of `health_check` with its history as Postgres answers it.
type Row = (
    String,
    String,
    String,
    String,
    String,
    time::OffsetDateTime,
    Option<time::OffsetDateTime>,
    time::OffsetDateTime,
    String,
    String,
    String,
    Vec<time::OffsetDateTime>,
    Vec<String>,
);

/// The health log, durable with a database, in memory without one.
pub struct HealthStore {
    inner: Inner,
    written: tokio::sync::Mutex<Option<DateTime<Utc>>>,
}

impl HealthStore {
    pub fn new(db: Option<sqlx::PgPool>) -> Self {
        Self {
            inner: match db {
                Some(pool) => Inner::Postgres(pool),
                None => Inner::Memory(RwLock::new(Memory::default())),
            },
            written: tokio::sync::Mutex::new(None),
        }
    }

    /// Writes the findings when the last write is [`EVERY`] old or older.
    pub async fn record_due(
        &self,
        now: DateTime<Utc>,
        findings: Vec<Finding>,
    ) -> Result<(), sqlx::Error> {
        let mut written = self.written.lock().await;
        if written.is_some_and(|at| now - at < EVERY) {
            return Ok(());
        }
        self.record(now, findings).await?;
        *written = Some(now);
        Ok(())
    }

    /// Replaces the latest rows with `findings` (a check no longer found is gone with its
    /// resource), adds a history point per changed status or per hour, drops history past
    /// [`KEEP`].
    pub async fn record(
        &self,
        now: DateTime<Utc>,
        findings: Vec<Finding>,
    ) -> Result<(), sqlx::Error> {
        let pool = match &self.inner {
            Inner::Memory(memory) => {
                if let Ok(mut memory) = memory.write() {
                    memory.record(now, findings);
                }
                return Ok(());
            }
            Inner::Postgres(pool) => pool,
        };
        let column = |f: fn(&Finding) -> String| findings.iter().map(f).collect::<Vec<_>>();
        let at = stamp_of(now);
        let mut tx = pool.begin().await?;
        sqlx::query(
            "INSERT INTO health_check AS h (project, kind, name, \"check\", status, since, last_ok, \
             checked_at, detail, fix_hint, evidence_url) \
             SELECT p, k, n, c, s, $1, CASE WHEN s = 'ok' THEN $1 END, $1, d, f, e \
             FROM UNNEST($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], \
             $8::text[], $9::text[]) AS t(p, k, n, c, s, d, f, e) \
             ON CONFLICT (project, kind, name, \"check\") DO UPDATE SET \
             status = EXCLUDED.status, \
             since = CASE WHEN h.status = EXCLUDED.status THEN h.since ELSE EXCLUDED.since END, \
             last_ok = COALESCE(EXCLUDED.last_ok, h.last_ok), checked_at = EXCLUDED.checked_at, \
             detail = EXCLUDED.detail, fix_hint = EXCLUDED.fix_hint, \
             evidence_url = EXCLUDED.evidence_url",
        )
        .bind(at)
        .bind(column(|f| f.project.clone()))
        .bind(column(|f| f.kind.as_str().to_owned()))
        .bind(column(|f| f.name.clone()))
        .bind(column(|f| f.check.to_owned()))
        .bind(column(|f| f.status.as_str().to_owned()))
        .bind(column(|f| f.detail.clone()))
        .bind(column(|f| f.fix_hint.clone()))
        .bind(column(|f| f.evidence_url.clone()))
        .execute(&mut *tx)
        .await?;
        sqlx::query("DELETE FROM health_check WHERE checked_at < $1")
            .bind(at)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "INSERT INTO health_check_history (project, kind, name, \"check\", at, status) \
             SELECT h.project, h.kind, h.name, h.\"check\", h.checked_at, h.status \
             FROM health_check h LEFT JOIN LATERAL ( \
               SELECT x.at, x.status FROM health_check_history x \
               WHERE x.project = h.project AND x.kind = h.kind AND x.name = h.name \
                 AND x.\"check\" = h.\"check\" ORDER BY x.at DESC LIMIT 1) last ON true \
             WHERE h.checked_at = $1 \
               AND (last.at IS NULL OR last.status <> h.status OR last.at <= $1 - interval '1 hour') \
             ON CONFLICT DO NOTHING",
        )
        .bind(at)
        .execute(&mut *tx)
        .await?;
        sqlx::query("DELETE FROM health_check_history WHERE at < $1 - interval '90 days'")
            .bind(at)
            .execute(&mut *tx)
            .await?;
        tx.commit().await
    }

    /// The checks of one project, or of every project for `None`, errors first.
    pub async fn list(
        &self,
        project: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<Vec<Check>, sqlx::Error> {
        let mut checks = match &self.inner {
            Inner::Memory(memory) => memory
                .read()
                .map(|memory| memory.list(project, now))
                .unwrap_or_default(),
            Inner::Postgres(pool) => {
                let rows: Vec<Row> = sqlx::query_as(
                    "SELECT h.project, h.kind, h.name, h.\"check\", h.status, h.since, h.last_ok, \
                     h.checked_at, h.detail, h.fix_hint, h.evidence_url, \
                     COALESCE(p.ats, '{}'), COALESCE(p.statuses, '{}') \
                     FROM health_check h LEFT JOIN LATERAL ( \
                       SELECT array_agg(x.at ORDER BY x.at) AS ats, \
                              array_agg(x.status ORDER BY x.at) AS statuses \
                       FROM health_check_history x \
                       WHERE x.project = h.project AND x.kind = h.kind AND x.name = h.name \
                         AND x.\"check\" = h.\"check\" AND x.at > $2) p ON true \
                     WHERE $1::text IS NULL OR h.project = $1",
                )
                .bind(project)
                .bind(stamp_of(now - SHOWN))
                .fetch_all(pool)
                .await?;
                rows.into_iter()
                    .filter_map(|row| {
                        Some(Check {
                            project: row.0,
                            kind: Kind::parse(&row.1)?,
                            name: row.2,
                            check: row.3,
                            status: Status::parse(&row.4),
                            since: rfc3339(chrono_of(row.5)),
                            last_ok: row.6.map(|at| rfc3339(chrono_of(at))),
                            checked_at: rfc3339(chrono_of(row.7)),
                            detail: row.8,
                            fix_hint: row.9,
                            evidence_url: row.10,
                            history: row
                                .11
                                .into_iter()
                                .zip(row.12)
                                .map(|(at, status)| Point {
                                    at: rfc3339(chrono_of(at)),
                                    status: Status::parse(&status),
                                })
                                .collect(),
                        })
                    })
                    .collect()
            }
        };
        checks.sort_by(|a, b| {
            (a.status, &a.project, a.kind, &a.name, &a.check)
                .cmp(&(b.status, &b.project, b.kind, &b.name, &b.check))
        });
        Ok(checks)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resource::{ObjectMeta, API_VERSION};

    fn at(text: &str) -> DateTime<Utc> {
        text.parse().expect("a time")
    }

    fn envelope(kind: &str, name: &str, phase: Option<Phase>, message: &str) -> ResourceEnvelope {
        ResourceEnvelope {
            api_version: API_VERSION.into(),
            kind: kind.into(),
            metadata: ObjectMeta {
                name: name.into(),
                namespace: Some("bbsk".into()),
                ..Default::default()
            },
            spec: serde_json::json!({}),
            status: phase.map(|phase| {
                let holds = if phase == Phase::Live {
                    "True"
                } else {
                    "False"
                };
                serde_json::from_value(serde_json::json!({
                    "phase": phase,
                    "conditions": [{"type": "Ready", "status": holds, "message": message}],
                }))
                .expect("a status")
            }),
        }
    }

    fn mirror(items: Vec<ResourceEnvelope>) -> Mirror {
        let mirror = Mirror::default();
        for item in items {
            mirror.upsert(item);
        }
        mirror
    }

    fn find<'a>(findings: &'a [Finding], name: &str, check: &str) -> &'a Finding {
        findings
            .iter()
            .find(|f| f.name == name && f.check == check)
            .expect("the finding")
    }

    #[test]
    fn every_kind_reports_ok_warn_and_error_from_its_status() {
        let findings = derive(
            &mirror(vec![
                envelope("ContextSpace", "air", Some(Phase::Live), "ready"),
                envelope(
                    "Endpoint",
                    "air-api",
                    Some(Phase::Error),
                    "policyRef open-air not found",
                ),
                envelope("DataModel", "events", Some(Phase::Pending), ""),
                envelope("DataSource", "rss", None, ""),
            ]),
            &[],
        );
        assert_eq!(find(&findings, "air", "reconcile").status, Status::Ok);
        let endpoint = find(&findings, "air-api", "reconcile");
        assert_eq!(endpoint.status, Status::Error);
        assert_eq!(endpoint.kind, Kind::Endpoint);
        assert_eq!(endpoint.detail, "policyRef open-air not found");
        assert!(
            endpoint.fix_hint.contains("Endpoint manifest"),
            "{}",
            endpoint.fix_hint
        );
        assert_eq!(endpoint.evidence_url, "/projects/bbsk/endpoints/air-api");
        assert_eq!(find(&findings, "events", "reconcile").status, Status::Warn);
        assert_eq!(
            find(&findings, "events", "reconcile").evidence_url,
            "/projects/bbsk/models/events"
        );
        assert_eq!(find(&findings, "rss", "reconcile").status, Status::Warn);
    }

    #[test]
    fn a_refused_pipeline_write_is_an_error_whose_hint_names_the_policy() {
        let signals = [Signal {
            key: ("bbsk".into(), "bbsk-events".into(), Event::Failure),
            detail: "3 runs in a row sent nothing: 403 no policy grants this operation".into(),
        }];
        let findings = derive(
            &mirror(vec![envelope(
                "Pipeline",
                "bbsk-events",
                Some(Phase::Live),
                "",
            )]),
            &signals,
        );
        let runs = find(&findings, "bbsk-events", "runs");
        assert_eq!(runs.status, Status::Error);
        assert!(
            runs.fix_hint.contains("pl-bbsk-events"),
            "{}",
            runs.fix_hint
        );
        assert!(runs.fix_hint.contains("policyRef"), "{}", runs.fix_hint);
        assert_eq!(
            find(&findings, "bbsk-events", "freshness").status,
            Status::Ok
        );
        assert_eq!(
            find(&findings, "bbsk-events", "reconcile").status,
            Status::Ok
        );
    }

    #[test]
    fn a_pipeline_that_dropped_or_went_stale_warns() {
        let key = |event| ("bbsk".to_owned(), "weather".to_owned(), event);
        let signals = [
            Signal {
                key: key(Event::Zero),
                detail: "the last run sent 2 records against a 7-day median of 400".into(),
            },
            Signal {
                key: key(Event::Stale),
                detail: String::new(),
            },
        ];
        let findings = derive(
            &mirror(vec![envelope("Pipeline", "weather", Some(Phase::Live), "")]),
            &signals,
        );
        assert_eq!(find(&findings, "weather", "runs").status, Status::Warn);
        let fresh = find(&findings, "weather", "freshness");
        assert_eq!(fresh.status, Status::Warn);
        assert!(fresh.fix_hint.contains("spec.schedule"));
    }

    #[test]
    fn a_detail_masks_credentials() {
        let findings = derive(
            &mirror(vec![envelope(
                "Endpoint",
                "leaky",
                Some(Phase::Error),
                "upstream said Bearer abcdefghijklmnopqrstuvwxyz0123456789 is 401",
            )]),
            &[],
        );
        let leaky = find(&findings, "leaky", "reconcile");
        assert!(
            !leaky.detail.contains("abcdefghijklmnop"),
            "{}",
            leaky.detail
        );
        assert!(leaky.fix_hint.contains("secretRef"), "{}", leaky.fix_hint);
    }

    fn finding(status: Status) -> Finding {
        Finding {
            project: "bbsk".into(),
            kind: Kind::Pipeline,
            name: "events".into(),
            check: "runs",
            status,
            detail: String::new(),
            fix_hint: String::new(),
            evidence_url: String::new(),
        }
    }

    #[tokio::test]
    async fn a_check_keeps_since_while_it_holds_and_recovers_with_last_ok() {
        let store = HealthStore::new(None);
        let t0 = at("2026-10-21T08:00:00Z");
        store
            .record(t0, vec![finding(Status::Ok)])
            .await
            .expect("record");
        let t1 = t0 + Duration::minutes(2);
        store
            .record(t1, vec![finding(Status::Error)])
            .await
            .expect("record");
        let t2 = t1 + Duration::minutes(2);
        store
            .record(t2, vec![finding(Status::Error)])
            .await
            .expect("record");
        let held = &store.list(Some("bbsk"), t2).await.expect("list")[0];
        assert_eq!(held.status, Status::Error);
        assert_eq!(held.since, rfc3339(t1));
        assert_eq!(held.last_ok.as_deref(), Some(rfc3339(t0).as_str()));
        assert_eq!(held.history.len(), 2, "one point per change, not per run");
        let t3 = t2 + Duration::minutes(2);
        store
            .record(t3, vec![finding(Status::Ok)])
            .await
            .expect("record");
        let recovered = &store.list(None, t3).await.expect("list")[0];
        assert_eq!(
            (recovered.status, recovered.since.clone()),
            (Status::Ok, rfc3339(t3))
        );
        assert_eq!(recovered.history.len(), 3);
        assert!(store
            .list(Some("other"), t3)
            .await
            .expect("list")
            .is_empty());
    }

    #[tokio::test]
    async fn the_history_is_sampled_hourly_and_bounded_to_90_days() {
        let store = HealthStore::new(None);
        let t0 = at("2026-07-01T00:00:00Z");
        for hour in 0..3 {
            for minute in [0, 20, 40] {
                let now = t0 + Duration::hours(hour) + Duration::minutes(minute);
                store
                    .record(now, vec![finding(Status::Ok)])
                    .await
                    .expect("record");
            }
        }
        if let Inner::Memory(memory) = &store.inner {
            assert_eq!(
                memory.read().expect("lock").history.len(),
                3,
                "one point an hour"
            );
        }
        let later = t0 + KEEP + Duration::days(1);
        store
            .record(later, vec![finding(Status::Ok)])
            .await
            .expect("record");
        if let Inner::Memory(memory) = &store.inner {
            let memory = memory.read().expect("lock");
            assert_eq!(memory.history.len(), 1, "older than 90 days is gone");
        }
    }

    #[tokio::test]
    async fn a_removed_resource_leaves_the_log_and_writes_are_throttled() {
        let store = HealthStore::new(None);
        let t0 = at("2026-10-21T08:00:00Z");
        store
            .record_due(t0, vec![finding(Status::Ok)])
            .await
            .expect("record");
        store
            .record_due(t0 + Duration::minutes(1), vec![finding(Status::Error)])
            .await
            .expect("record");
        let list = store.list(None, t0).await.expect("list");
        assert_eq!(list[0].status, Status::Ok, "a write within EVERY waits");
        store
            .record_due(t0 + EVERY, Vec::new())
            .await
            .expect("record");
        assert!(store.list(None, t0 + EVERY).await.expect("list").is_empty());
    }
}
