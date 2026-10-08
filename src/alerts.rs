//! Alerts a person chooses (API/01 §37, PL-71, T-3261).
//!
//! A person subscribes to a pipeline, a space or a type in a space. After every sync the leader
//! reads the pipelines' state: a pipeline in `Error` is a `failure`, a `StreamWriting` condition
//! that is `False` is `zero` output, and the daily quality run's `stale` freshness is `stale`
//! (DM-74). An incident opens when a signal starts and closes when it clears; each unmuted
//! subscriber whose subscription covers the pipeline gets one notice for the opening and one for
//! the recovery, or, on `digest`, one notice a day. Durable with a database, in memory without.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};

use chrono::{DateTime, Duration, Timelike, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

use crate::resource::Phase;
use crate::store::Mirror;

/// The most notices one person keeps; the oldest go first.
pub const KEPT: i64 = 200;
/// The hour (UTC) after which the day's digest is written.
pub const DIGEST_HOUR: u32 = 7;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
#[schema(as = AlertScope)]
pub enum Scope {
    Pipeline,
    Space,
    Type,
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, ToSchema,
)]
#[serde(rename_all = "lowercase")]
#[schema(as = AlertEvent)]
pub enum Event {
    Failure,
    Stale,
    Zero,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
#[schema(as = AlertDelivery)]
pub enum Delivery {
    Portal,
    Digest,
}

impl Scope {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pipeline => "pipeline",
            Self::Space => "space",
            Self::Type => "type",
        }
    }
    fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "pipeline" => Self::Pipeline,
            "space" => Self::Space,
            "type" => Self::Type,
            _ => return None,
        })
    }
}

impl Event {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Failure => "failure",
            Self::Stale => "stale",
            Self::Zero => "zero",
        }
    }
    fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "failure" => Self::Failure,
            "stale" => Self::Stale,
            "zero" => Self::Zero,
            _ => return None,
        })
    }
}

impl Delivery {
    fn as_str(self) -> &'static str {
        match self {
            Self::Portal => "portal",
            Self::Digest => "digest",
        }
    }
}

/// One subscription as the API shows it.
#[derive(Debug, Clone, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(as = AlertSubscription)]
pub struct Subscription {
    pub id: i64,
    pub project: String,
    pub scope: Scope,
    pub target: String,
    pub events: Vec<Event>,
    pub delivery: Delivery,
    /// RFC 3339; none when it is not muted.
    pub muted_until: Option<String>,
}

/// What a person asks to be told about.
#[derive(Debug, Clone, PartialEq, Deserialize, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[schema(as = NewAlertSubscription)]
pub struct NewSubscription {
    pub project: String,
    pub scope: String,
    pub target: String,
    pub events: Vec<String>,
    pub delivery: String,
}

/// One notice left for a subscriber.
#[derive(Debug, Clone, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(as = AlertNotice)]
pub struct Notice {
    pub id: i64,
    /// The subscription it came from, which "Mute" names.
    pub subscription: i64,
    pub project: String,
    pub pipeline: String,
    pub event: Event,
    /// `opened`, `recovered` or `digest`.
    pub change: String,
    pub detail: String,
    /// RFC 3339.
    pub created_at: String,
    pub read: bool,
}

/// A subscription as the evaluator reads it: whose, and when they last got a digest.
#[derive(Debug, Clone)]
pub struct Held {
    pub subject: String,
    pub subscription: Subscription,
    pub muted_until: Option<DateTime<Utc>>,
    pub digest_at: Option<DateTime<Utc>>,
}

/// `(project, pipeline, event)`.
pub type IncidentKey = (String, String, Event);

/// An incident as the digest reads it.
#[derive(Debug, Clone, PartialEq)]
pub struct Incident {
    pub key: IncidentKey,
    pub detail: String,
    pub opened_at: DateTime<Utc>,
}

#[derive(Debug, Default)]
struct Memory {
    next: i64,
    subscriptions: Vec<Held>,
    incidents: Vec<(Incident, Option<DateTime<Utc>>)>,
    notices: Vec<(String, Notice)>,
}

pub struct AlertStore {
    inner: Inner,
}

enum Inner {
    Postgres(sqlx::PgPool),
    Memory(RwLock<Memory>),
}

type Stamp = time::OffsetDateTime;

fn chrono_of(stamp: Stamp) -> DateTime<Utc> {
    DateTime::from_timestamp(stamp.unix_timestamp(), stamp.nanosecond()).unwrap_or_default()
}

fn stamp_of(at: DateTime<Utc>) -> Stamp {
    Stamp::from_unix_timestamp(at.timestamp()).unwrap_or(Stamp::UNIX_EPOCH)
}

fn rfc3339(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// One row of `alert_notices` as Postgres answers it.
type NoticeRow = (
    i64,
    i64,
    String,
    String,
    String,
    String,
    String,
    Stamp,
    Option<Stamp>,
);

type SubscriptionRow = (
    i64,
    String,
    String,
    String,
    String,
    Vec<String>,
    String,
    Option<Stamp>,
    Option<Stamp>,
);

fn held_of(row: SubscriptionRow) -> Option<Held> {
    let (id, subject, project, scope, target, events, delivery, muted_until, digest_at) = row;
    let muted_until = muted_until.map(chrono_of);
    let digest_at = digest_at.map(chrono_of);
    Some(Held {
        subject,
        subscription: Subscription {
            id,
            project,
            scope: Scope::parse(&scope)?,
            target,
            events: events.iter().filter_map(|e| Event::parse(e)).collect(),
            delivery: if delivery == "digest" {
                Delivery::Digest
            } else {
                Delivery::Portal
            },
            muted_until: muted_until.map(rfc3339),
        },
        muted_until,
        digest_at,
    })
}

/// A subscription checked: its scope, events and delivery read, each event once.
pub fn checked(new: &NewSubscription) -> Result<(Scope, Vec<Event>, Delivery), String> {
    let scope = Scope::parse(&new.scope)
        .ok_or_else(|| format!("`{}` is not pipeline, space or type", new.scope))?;
    if new.events.is_empty() {
        return Err("name at least one of failure, stale and zero".into());
    }
    let mut events = BTreeSet::new();
    for event in &new.events {
        events.insert(
            Event::parse(event)
                .ok_or_else(|| format!("`{event}` is not failure, stale or zero"))?,
        );
    }
    let delivery =
        match new.delivery.as_str() {
            "portal" => Delivery::Portal,
            "digest" => Delivery::Digest,
            "email" => return Err(
                "this Portal sends no e-mail yet: it has no mail relay; choose portal or digest"
                    .into(),
            ),
            other => return Err(format!("`{other}` is not portal or digest")),
        };
    if scope == Scope::Type
        && new
            .target
            .split_once('/')
            .is_none_or(|(space, kind)| space.is_empty() || kind.is_empty())
    {
        return Err("a type is named `{space}/{Type}`".into());
    }
    Ok((scope, events.into_iter().collect(), delivery))
}

impl AlertStore {
    pub fn new(db: Option<sqlx::PgPool>) -> Self {
        Self {
            inner: match db {
                Some(pool) => Inner::Postgres(pool),
                None => Inner::Memory(RwLock::new(Memory::default())),
            },
        }
    }

    /// The person's subscriptions, oldest first.
    pub async fn subscriptions_of(&self, subject: &str) -> Result<Vec<Subscription>, sqlx::Error> {
        Ok(self
            .all()
            .await?
            .into_iter()
            .filter(|held| held.subject == subject)
            .map(|held| held.subscription)
            .collect())
    }

    /// Every subscription, for the evaluator.
    pub async fn all(&self) -> Result<Vec<Held>, sqlx::Error> {
        match &self.inner {
            Inner::Postgres(pool) => {
                let rows: Vec<SubscriptionRow> = sqlx::query_as(
                    "SELECT id, subject, project, scope, target, events, delivery, muted_until, digest_at FROM alert_subscriptions ORDER BY id",
                )
                .fetch_all(pool)
                .await?;
                Ok(rows.into_iter().filter_map(held_of).collect())
            }
            Inner::Memory(lock) => Ok(lock
                .read()
                .unwrap_or_else(|e| e.into_inner())
                .subscriptions
                .clone()),
        }
    }

    /// Subscribes, or changes the person's subscription of the same target; a mute is kept.
    pub async fn upsert(
        &self,
        subject: &str,
        project: &str,
        scope: Scope,
        target: &str,
        events: &[Event],
        delivery: Delivery,
    ) -> Result<Subscription, sqlx::Error> {
        let names: Vec<String> = events.iter().map(|e| e.as_str().to_owned()).collect();
        match &self.inner {
            Inner::Postgres(pool) => {
                let row: SubscriptionRow = sqlx::query_as(
                    "INSERT INTO alert_subscriptions (subject, project, scope, target, events, delivery) \
                     VALUES ($1, $2, $3, $4, $5, $6) \
                     ON CONFLICT (subject, project, scope, target) DO UPDATE SET events = EXCLUDED.events, delivery = EXCLUDED.delivery \
                     RETURNING id, subject, project, scope, target, events, delivery, muted_until, digest_at",
                )
                .bind(subject)
                .bind(project)
                .bind(scope.as_str())
                .bind(target)
                .bind(&names)
                .bind(delivery.as_str())
                .fetch_one(pool)
                .await?;
                held_of(row)
                    .map(|held| held.subscription)
                    .ok_or(sqlx::Error::RowNotFound)
            }
            Inner::Memory(lock) => {
                let mut memory = lock.write().unwrap_or_else(|e| e.into_inner());
                if let Some(held) = memory.subscriptions.iter_mut().find(|held| {
                    held.subject == subject
                        && held.subscription.project == project
                        && held.subscription.scope == scope
                        && held.subscription.target == target
                }) {
                    held.subscription.events = events.to_vec();
                    held.subscription.delivery = delivery;
                    return Ok(held.subscription.clone());
                }
                memory.next += 1;
                let subscription = Subscription {
                    id: memory.next,
                    project: project.to_owned(),
                    scope,
                    target: target.to_owned(),
                    events: events.to_vec(),
                    delivery,
                    muted_until: None,
                };
                memory.subscriptions.push(Held {
                    subject: subject.to_owned(),
                    subscription: subscription.clone(),
                    muted_until: None,
                    digest_at: None,
                });
                Ok(subscription)
            }
        }
    }

    /// Removes one of the person's subscriptions, and its notices; `false` when none has that id.
    pub async fn remove(&self, subject: &str, id: i64) -> Result<bool, sqlx::Error> {
        match &self.inner {
            Inner::Postgres(pool) => Ok(sqlx::query(
                "DELETE FROM alert_subscriptions WHERE id = $1 AND subject = $2",
            )
            .bind(id)
            .bind(subject)
            .execute(pool)
            .await?
            .rows_affected()
                > 0),
            Inner::Memory(lock) => {
                let mut memory = lock.write().unwrap_or_else(|e| e.into_inner());
                let before = memory.subscriptions.len();
                memory
                    .subscriptions
                    .retain(|held| !(held.subject == subject && held.subscription.id == id));
                let removed = memory.subscriptions.len() < before;
                if removed {
                    memory
                        .notices
                        .retain(|(_, notice)| notice.subscription != id);
                }
                Ok(removed)
            }
        }
    }

    /// Mutes one of the person's subscriptions until `until`, or unmutes it with `None`.
    pub async fn mute(
        &self,
        subject: &str,
        id: i64,
        until: Option<DateTime<Utc>>,
    ) -> Result<Option<Subscription>, sqlx::Error> {
        match &self.inner {
            Inner::Postgres(pool) => {
                let row: Option<SubscriptionRow> = sqlx::query_as(
                    "UPDATE alert_subscriptions SET muted_until = $3 WHERE id = $1 AND subject = $2 \
                     RETURNING id, subject, project, scope, target, events, delivery, muted_until, digest_at",
                )
                .bind(id)
                .bind(subject)
                .bind(until.map(stamp_of))
                .fetch_optional(pool)
                .await?;
                Ok(row.and_then(held_of).map(|held| held.subscription))
            }
            Inner::Memory(lock) => {
                let mut memory = lock.write().unwrap_or_else(|e| e.into_inner());
                Ok(memory
                    .subscriptions
                    .iter_mut()
                    .find(|held| held.subject == subject && held.subscription.id == id)
                    .map(|held| {
                        held.muted_until = until;
                        held.subscription.muted_until = until.map(rfc3339);
                        held.subscription.clone()
                    }))
            }
        }
    }

    /// Records that the subscription's digest was written at `at`.
    async fn digested(&self, id: i64, at: DateTime<Utc>) -> Result<(), sqlx::Error> {
        match &self.inner {
            Inner::Postgres(pool) => {
                sqlx::query("UPDATE alert_subscriptions SET digest_at = $2 WHERE id = $1")
                    .bind(id)
                    .bind(stamp_of(at))
                    .execute(pool)
                    .await?;
                Ok(())
            }
            Inner::Memory(lock) => {
                let mut memory = lock.write().unwrap_or_else(|e| e.into_inner());
                if let Some(held) = memory
                    .subscriptions
                    .iter_mut()
                    .find(|held| held.subscription.id == id)
                {
                    held.digest_at = Some(at);
                }
                Ok(())
            }
        }
    }

    /// The incidents open now.
    pub async fn open_incidents(&self) -> Result<BTreeMap<IncidentKey, Incident>, sqlx::Error> {
        Ok(self
            .incidents_since(None)
            .await?
            .into_iter()
            .filter(|(_, recovered)| recovered.is_none())
            .map(|(incident, _)| (incident.key.clone(), incident))
            .collect())
    }

    /// Incidents opened after `since` (every open one when `None`), with when they recovered.
    async fn incidents_since(
        &self,
        since: Option<DateTime<Utc>>,
    ) -> Result<Vec<(Incident, Option<DateTime<Utc>>)>, sqlx::Error> {
        match &self.inner {
            Inner::Postgres(pool) => {
                let rows: Vec<(String, String, String, String, Stamp, Option<Stamp>)> = sqlx::query_as(
                    "SELECT project, pipeline, event, detail, opened_at, recovered_at FROM alert_incidents \
                     WHERE ($1::timestamptz IS NULL AND recovered_at IS NULL) OR opened_at > $1 ORDER BY id",
                )
                .bind(since.map(stamp_of))
                .fetch_all(pool)
                .await?;
                Ok(rows
                    .into_iter()
                    .filter_map(
                        |(project, pipeline, event, detail, opened_at, recovered_at)| {
                            Some((
                                Incident {
                                    key: (project, pipeline, Event::parse(&event)?),
                                    detail,
                                    opened_at: chrono_of(opened_at),
                                },
                                recovered_at.map(chrono_of),
                            ))
                        },
                    )
                    .collect())
            }
            Inner::Memory(lock) => {
                let memory = lock.read().unwrap_or_else(|e| e.into_inner());
                Ok(memory
                    .incidents
                    .iter()
                    .filter(|(incident, recovered)| match since {
                        None => recovered.is_none(),
                        Some(since) => incident.opened_at > since,
                    })
                    .cloned()
                    .collect())
            }
        }
    }

    async fn open(&self, signal: &Signal, at: DateTime<Utc>) -> Result<(), sqlx::Error> {
        match &self.inner {
            Inner::Postgres(pool) => {
                sqlx::query(
                    "INSERT INTO alert_incidents (project, pipeline, event, detail, opened_at) VALUES ($1, $2, $3, $4, $5) \
                     ON CONFLICT DO NOTHING",
                )
                .bind(&signal.key.0)
                .bind(&signal.key.1)
                .bind(signal.key.2.as_str())
                .bind(&signal.detail)
                .bind(stamp_of(at))
                .execute(pool)
                .await?;
                Ok(())
            }
            Inner::Memory(lock) => {
                lock.write()
                    .unwrap_or_else(|e| e.into_inner())
                    .incidents
                    .push((
                        Incident {
                            key: signal.key.clone(),
                            detail: signal.detail.clone(),
                            opened_at: at,
                        },
                        None,
                    ));
                Ok(())
            }
        }
    }

    async fn close(&self, key: &IncidentKey, at: DateTime<Utc>) -> Result<(), sqlx::Error> {
        match &self.inner {
            Inner::Postgres(pool) => {
                sqlx::query(
                    "UPDATE alert_incidents SET recovered_at = $4 \
                     WHERE project = $1 AND pipeline = $2 AND event = $3 AND recovered_at IS NULL",
                )
                .bind(&key.0)
                .bind(&key.1)
                .bind(key.2.as_str())
                .bind(stamp_of(at))
                .execute(pool)
                .await?;
                Ok(())
            }
            Inner::Memory(lock) => {
                let mut memory = lock.write().unwrap_or_else(|e| e.into_inner());
                for (incident, recovered) in memory.incidents.iter_mut() {
                    if &incident.key == key && recovered.is_none() {
                        *recovered = Some(at);
                    }
                }
                Ok(())
            }
        }
    }

    /// Leaves a notice for `recipient`, dropping their oldest beyond [`KEPT`].
    async fn notify(
        &self,
        recipient: &str,
        subscription: i64,
        key: &IncidentKey,
        change: &str,
        detail: &str,
    ) -> Result<(), sqlx::Error> {
        match &self.inner {
            Inner::Postgres(pool) => {
                let mut tx = pool.begin().await?;
                sqlx::query(
                    "INSERT INTO alert_notices (recipient, subscription, project, pipeline, event, change, detail) \
                     VALUES ($1, $2, $3, $4, $5, $6, $7)",
                )
                .bind(recipient)
                .bind(subscription)
                .bind(&key.0)
                .bind(&key.1)
                .bind(key.2.as_str())
                .bind(change)
                .bind(detail)
                .execute(&mut *tx)
                .await?;
                sqlx::query(
                    "DELETE FROM alert_notices WHERE recipient = $1 AND id NOT IN \
                     (SELECT id FROM alert_notices WHERE recipient = $1 ORDER BY id DESC LIMIT $2)",
                )
                .bind(recipient)
                .bind(KEPT)
                .execute(&mut *tx)
                .await?;
                tx.commit().await
            }
            Inner::Memory(lock) => {
                let mut memory = lock.write().unwrap_or_else(|e| e.into_inner());
                memory.next += 1;
                let notice = Notice {
                    id: memory.next,
                    subscription,
                    project: key.0.clone(),
                    pipeline: key.1.clone(),
                    event: key.2,
                    change: change.to_owned(),
                    detail: detail.to_owned(),
                    created_at: rfc3339(Utc::now()),
                    read: false,
                };
                memory.notices.push((recipient.to_owned(), notice));
                let theirs = memory
                    .notices
                    .iter()
                    .filter(|(r, _)| r == recipient)
                    .count();
                if theirs > KEPT as usize {
                    let mut drop = theirs - KEPT as usize;
                    memory.notices.retain(|(r, _)| {
                        if r == recipient && drop > 0 {
                            drop -= 1;
                            false
                        } else {
                            true
                        }
                    });
                }
                Ok(())
            }
        }
    }

    /// The person's notices, newest first, and how many are unread.
    pub async fn notices(&self, recipients: &[String]) -> Result<Vec<Notice>, sqlx::Error> {
        match &self.inner {
            Inner::Postgres(pool) => {
                let rows: Vec<NoticeRow> =
                    sqlx::query_as(
                        "SELECT id, subscription, project, pipeline, event, change, detail, created_at, read_at \
                         FROM alert_notices WHERE recipient = ANY($1) ORDER BY id DESC LIMIT $2",
                    )
                    .bind(recipients)
                    .bind(KEPT)
                    .fetch_all(pool)
                    .await?;
                Ok(rows
                    .into_iter()
                    .filter_map(
                        |(
                            id,
                            subscription,
                            project,
                            pipeline,
                            event,
                            change,
                            detail,
                            created_at,
                            read_at,
                        )| {
                            Some(Notice {
                                id,
                                subscription,
                                project,
                                pipeline,
                                event: Event::parse(&event)?,
                                change,
                                detail,
                                created_at: rfc3339(chrono_of(created_at)),
                                read: read_at.is_some(),
                            })
                        },
                    )
                    .collect())
            }
            Inner::Memory(lock) => {
                let memory = lock.read().unwrap_or_else(|e| e.into_inner());
                Ok(memory
                    .notices
                    .iter()
                    .rev()
                    .filter(|(r, _)| recipients.contains(r))
                    .map(|(_, notice)| notice.clone())
                    .collect())
            }
        }
    }

    /// Marks one of the person's notices read; `false` when none of theirs has that id.
    pub async fn mark_read(&self, recipients: &[String], id: i64) -> Result<bool, sqlx::Error> {
        match &self.inner {
            Inner::Postgres(pool) => Ok(sqlx::query(
                "UPDATE alert_notices SET read_at = coalesce(read_at, now()) WHERE id = $1 AND recipient = ANY($2)",
            )
            .bind(id)
            .bind(recipients)
            .execute(pool)
            .await?
            .rows_affected()
                > 0),
            Inner::Memory(lock) => {
                let mut memory = lock.write().unwrap_or_else(|e| e.into_inner());
                let mut found = false;
                for (recipient, notice) in memory.notices.iter_mut() {
                    if notice.id == id && recipients.contains(recipient) {
                        notice.read = true;
                        found = true;
                    }
                }
                Ok(found)
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// What the pipelines say.

/// One pipeline as the evaluator matches subscriptions against it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Watched {
    pub project: String,
    pub name: String,
    /// The spaces its output Endpoints write into, by name.
    pub spaces: BTreeSet<String>,
    /// The types its outputs name.
    pub types: BTreeSet<String>,
}

/// A signal that holds now.
#[derive(Debug, Clone, PartialEq)]
pub struct Signal {
    pub key: IncidentKey,
    pub detail: String,
}

/// The output Endpoints' names and the output types of a pipeline spec, either version.
fn outputs_of(spec: &Value) -> Vec<(Option<String>, Option<String>)> {
    let endpoint = |urn: Option<&Value>| {
        urn.and_then(Value::as_str)
            .and_then(|u| u.rsplit(':').next())
            .map(str::to_owned)
    };
    let kind = |output: Option<&Value>| {
        output
            .and_then(|o| o.get("type"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    match spec.get("outputs").and_then(Value::as_array) {
        Some(outputs) => outputs
            .iter()
            .map(|output| (endpoint(output.get("targetEndpoint")), kind(Some(output))))
            .collect(),
        None => vec![(
            endpoint(spec.get("targetEndpoint")),
            kind(spec.get("output")),
        )],
    }
}

/// Every pipeline of the mirror with what it writes, and the signals that hold for it now.
pub fn read_pipelines(
    mirror: &Mirror,
    quality: &crate::quality::Store,
) -> (Vec<Watched>, Vec<Signal>) {
    let mut watched = Vec::new();
    let mut signals = Vec::new();
    let mut pipelines = mirror.matching(|env| env.kind == "Pipeline");
    pipelines.sort_by(|a, b| {
        (&a.metadata.namespace, &a.metadata.name).cmp(&(&b.metadata.namespace, &b.metadata.name))
    });
    for pipeline in pipelines {
        let project = pipeline.metadata.namespace.clone().unwrap_or_default();
        let name = pipeline.metadata.name.clone();
        let mut spaces = BTreeSet::new();
        let mut types = BTreeSet::new();
        for (endpoint, kind) in outputs_of(&pipeline.spec) {
            if let Some(space) = endpoint
                .and_then(|e| mirror.get(&project, "Endpoint", &e))
                .and_then(|e| {
                    e.spec
                        .get("contextSpaceRef")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
            {
                spaces.insert(space);
            }
            if let Some(kind) = kind {
                types.insert(kind);
            }
        }
        if let Some(status) = &pipeline.status {
            if status.phase == Phase::Error {
                let said = status
                    .conditions
                    .iter()
                    .find_map(|c| c.message.clone())
                    .unwrap_or_default();
                signals.push(Signal {
                    key: (project.clone(), name.clone(), Event::Failure),
                    detail: said,
                });
            }
            if let Some(condition) = status
                .conditions
                .iter()
                .find(|c| c.r#type == "StreamWriting" && c.status == "False")
            {
                signals.push(Signal {
                    key: (project.clone(), name.clone(), Event::Zero),
                    detail: condition
                        .message
                        .clone()
                        .or_else(|| condition.reason.clone())
                        .unwrap_or_default(),
                });
            }
        }
        for space in &spaces {
            if let Some(report) = quality.get(&project, space) {
                if report.freshness.iter().any(|row| {
                    row.pipeline == name && row.state == crate::quality::FreshState::Stale
                }) {
                    signals.push(Signal {
                        key: (project.clone(), name.clone(), Event::Stale),
                        detail: String::new(),
                    });
                    break;
                }
            }
        }
        watched.push(Watched {
            project,
            name,
            spaces,
            types,
        });
    }
    (watched, signals)
}

/// Whether a subscription covers a pipeline.
pub fn covers(subscription: &Subscription, pipeline: &Watched) -> bool {
    if subscription.project != pipeline.project {
        return false;
    }
    match subscription.scope {
        Scope::Pipeline => subscription.target == pipeline.name,
        Scope::Space => pipeline.spaces.contains(&subscription.target),
        Scope::Type => subscription
            .target
            .split_once('/')
            .is_some_and(|(space, kind)| {
                pipeline.spaces.contains(space) && pipeline.types.contains(kind)
            }),
    }
}

/// The incidents to open (signals with none open) and to close (open ones whose signal cleared).
pub fn step(
    open: &BTreeMap<IncidentKey, Incident>,
    signals: &[Signal],
) -> (Vec<Signal>, Vec<IncidentKey>) {
    let now: BTreeSet<&IncidentKey> = signals.iter().map(|signal| &signal.key).collect();
    let opening = signals
        .iter()
        .filter(|signal| !open.contains_key(&signal.key))
        .cloned()
        .collect();
    let closing = open
        .keys()
        .filter(|key| !now.contains(key))
        .cloned()
        .collect();
    (opening, closing)
}

/// Whether the day's digest is due for a subscription at `now`.
pub fn digest_due(last: Option<DateTime<Utc>>, now: DateTime<Utc>) -> bool {
    if now.hour() < DIGEST_HOUR {
        return false;
    }
    let today = now
        .date_naive()
        .and_hms_opt(DIGEST_HOUR, 0, 0)
        .map(|at| at.and_utc());
    match (last, today) {
        (Some(last), Some(today)) => last < today,
        (None, _) => true,
        (_, None) => false,
    }
}

/// Runs after every sync of the leader; one run at a time.
pub struct Evaluator {
    pub mirror: Arc<Mirror>,
    pub quality: Arc<crate::quality::Store>,
    pub store: Arc<AlertStore>,
    running: AtomicBool,
}

impl Evaluator {
    pub fn new(
        mirror: Arc<Mirror>,
        quality: Arc<crate::quality::Store>,
        store: Arc<AlertStore>,
    ) -> Self {
        Self {
            mirror,
            quality,
            store,
            running: AtomicBool::new(false),
        }
    }

    /// Starts a run in the background unless one is under way; the sync never waits.
    pub fn start(self: &Arc<Self>) {
        if self.running.swap(true, Ordering::AcqRel) {
            return;
        }
        let evaluator = Arc::clone(self);
        tokio::spawn(async move {
            if let Err(error) = evaluator.run(Utc::now()).await {
                tracing::warn!(%error, "the alert run did not complete");
            }
            evaluator.running.store(false, Ordering::Release);
        });
    }

    /// One pass: open and close incidents, notify subscribers, write the digests that are due.
    pub async fn run(&self, now: DateTime<Utc>) -> Result<(), sqlx::Error> {
        let (pipelines, signals) = read_pipelines(&self.mirror, &self.quality);
        let open = self.store.open_incidents().await?;
        let (opening, closing) = step(&open, &signals);
        let subscriptions = self.store.all().await?;
        let audience = |key: &IncidentKey| {
            let pipeline = pipelines
                .iter()
                .find(|p| p.project == key.0 && p.name == key.1);
            subscriptions
                .iter()
                .filter(move |held| {
                    held.subscription.delivery == Delivery::Portal
                        && held.subscription.events.contains(&key.2)
                        && held.muted_until.is_none_or(|until| until <= now)
                        && pipeline.is_some_and(|p| covers(&held.subscription, p))
                })
                .collect::<Vec<_>>()
        };
        for signal in &opening {
            self.store.open(signal, now).await?;
            for held in audience(&signal.key) {
                self.store
                    .notify(
                        &held.subject,
                        held.subscription.id,
                        &signal.key,
                        "opened",
                        &signal.detail,
                    )
                    .await?;
            }
        }
        for key in &closing {
            self.store.close(key, now).await?;
            for held in audience(key) {
                self.store
                    .notify(&held.subject, held.subscription.id, key, "recovered", "")
                    .await?;
            }
        }
        // The digests: one notice per incident opened since the last one, sent once a day.
        let digests: Vec<&Held> = subscriptions
            .iter()
            .filter(|held| {
                held.subscription.delivery == Delivery::Digest && digest_due(held.digest_at, now)
            })
            .collect();
        if !digests.is_empty() {
            let day = self
                .store
                .incidents_since(Some(now - Duration::days(1)))
                .await?;
            for held in digests {
                let muted = held.muted_until.is_some_and(|until| until > now);
                if !muted {
                    for (incident, recovered) in &day {
                        let since = held.digest_at.unwrap_or(now - Duration::days(1));
                        let covered = pipelines
                            .iter()
                            .find(|p| p.project == incident.key.0 && p.name == incident.key.1)
                            .is_some_and(|p| covers(&held.subscription, p));
                        if incident.opened_at > since
                            && covered
                            && held.subscription.events.contains(&incident.key.2)
                        {
                            let detail = match recovered {
                                Some(at) => format!("recovered {}", rfc3339(*at)),
                                None => incident.detail.clone(),
                            };
                            self.store
                                .notify(
                                    &held.subject,
                                    held.subscription.id,
                                    &incident.key,
                                    "digest",
                                    &detail,
                                )
                                .await?;
                        }
                    }
                }
                self.store.digested(held.subscription.id, now).await?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn at(text: &str) -> DateTime<Utc> {
        text.parse().unwrap()
    }

    fn watched(name: &str, space: &str, kind: &str) -> Watched {
        Watched {
            project: "helsinki".into(),
            name: name.into(),
            spaces: [space.to_owned()].into(),
            types: [kind.to_owned()].into(),
        }
    }

    fn subscription(scope: Scope, target: &str) -> Subscription {
        Subscription {
            id: 1,
            project: "helsinki".into(),
            scope,
            target: target.into(),
            events: vec![Event::Failure],
            delivery: Delivery::Portal,
            muted_until: None,
        }
    }

    #[test]
    fn a_subscription_covers_its_pipeline_its_space_and_its_type_there() {
        let bikes = watched("bikes", "mobility", "BikeHireDockingStation");
        assert!(covers(&subscription(Scope::Pipeline, "bikes"), &bikes));
        assert!(!covers(&subscription(Scope::Pipeline, "other"), &bikes));
        assert!(covers(&subscription(Scope::Space, "mobility"), &bikes));
        assert!(!covers(&subscription(Scope::Space, "air"), &bikes));
        assert!(covers(
            &subscription(Scope::Type, "mobility/BikeHireDockingStation"),
            &bikes
        ));
        assert!(!covers(
            &subscription(Scope::Type, "air/BikeHireDockingStation"),
            &bikes
        ));
        let mut elsewhere = subscription(Scope::Pipeline, "bikes");
        elsewhere.project = "espoo".into();
        assert!(!covers(&elsewhere, &bikes));
    }

    #[test]
    fn an_incident_opens_once_and_closes_when_its_signal_clears() {
        let key: IncidentKey = ("helsinki".into(), "bikes".into(), Event::Zero);
        let signal = Signal {
            key: key.clone(),
            detail: "stalled".into(),
        };
        let (opening, closing) = step(&BTreeMap::new(), std::slice::from_ref(&signal));
        assert_eq!((opening, closing), (vec![signal.clone()], vec![]));
        let open = BTreeMap::from([(
            key.clone(),
            Incident {
                key: key.clone(),
                detail: "stalled".into(),
                opened_at: at("2026-10-07T08:00:00Z"),
            },
        )]);
        assert_eq!(step(&open, std::slice::from_ref(&signal)), (vec![], vec![]));
        assert_eq!(step(&open, &[]), (vec![], vec![key]));
    }

    #[test]
    fn a_subscription_is_checked_and_e_mail_is_refused_with_its_reason() {
        let new = |scope: &str, target: &str, events: &[&str], delivery: &str| NewSubscription {
            project: "helsinki".into(),
            scope: scope.into(),
            target: target.into(),
            events: events.iter().map(|e| (*e).to_owned()).collect(),
            delivery: delivery.into(),
        };
        assert_eq!(
            checked(&new(
                "space",
                "bikes",
                &["zero", "failure", "zero"],
                "portal"
            )),
            Ok((
                Scope::Space,
                vec![Event::Failure, Event::Zero],
                Delivery::Portal
            ))
        );
        assert!(checked(&new("space", "bikes", &[], "portal")).is_err());
        assert!(checked(&new("planet", "bikes", &["zero"], "portal")).is_err());
        assert!(checked(&new("space", "bikes", &["boom"], "portal")).is_err());
        assert!(checked(&new("type", "Bikes", &["zero"], "portal")).is_err());
        assert!(checked(&new("type", "mobility/Bike", &["zero"], "digest")).is_ok());
        assert!(checked(&new("space", "bikes", &["zero"], "email"))
            .unwrap_err()
            .contains("no mail relay"));
    }

    #[test]
    fn the_digest_is_due_once_a_day_after_seven() {
        assert!(!digest_due(None, at("2026-10-07T06:59:00Z")));
        assert!(digest_due(None, at("2026-10-07T07:00:00Z")));
        assert!(digest_due(
            Some(at("2026-10-06T07:05:00Z")),
            at("2026-10-07T07:01:00Z")
        ));
        assert!(!digest_due(
            Some(at("2026-10-07T07:01:00Z")),
            at("2026-10-07T18:00:00Z")
        ));
    }

    fn pipeline(name: &str, status: Value) -> crate::resource::ResourceEnvelope {
        serde_json::from_value(json!({
            "apiVersion": "joinedcontext.com/v1alpha1",
            "kind": "Pipeline",
            "metadata": { "name": name, "namespace": "helsinki" },
            "spec": { "class": "auto", "targetEndpoint": "urn:ngsi-ld:Endpoint:hel.fi:mobility:bikes-write", "output": { "type": "BikeHireDockingStation" } },
            "status": status,
        }))
        .expect("a pipeline")
    }

    fn mirror() -> Arc<Mirror> {
        let mirror = Arc::new(Mirror::new());
        mirror.upsert(
            serde_json::from_value(json!({
                "apiVersion": "joinedcontext.com/v1alpha1",
                "kind": "Endpoint",
                "metadata": { "name": "bikes-write", "namespace": "helsinki" },
                "spec": { "contextSpaceRef": "mobility" },
            }))
            .expect("an endpoint"),
        );
        mirror
    }

    #[test]
    fn a_pipeline_in_error_or_writing_nothing_is_a_signal_and_names_its_space_and_type() {
        let mirror = mirror();
        mirror.upsert(pipeline("bikes", json!({ "phase": "Live", "conditions": [{ "type": "StreamWriting", "status": "False", "reason": "Stalled", "message": "records in, nothing out" }] })));
        mirror.upsert(pipeline("broken", json!({ "phase": "Error", "conditions": [{ "type": "Ready", "status": "False", "message": "runner refused" }] })));
        mirror.upsert(pipeline("fine", json!({ "phase": "Live" })));
        let (watched, mut signals) = read_pipelines(&mirror, &crate::quality::Store::default());
        signals.sort_by(|a, b| a.key.cmp(&b.key));
        assert_eq!(
            signals,
            vec![
                Signal {
                    key: ("helsinki".into(), "bikes".into(), Event::Zero),
                    detail: "records in, nothing out".into()
                },
                Signal {
                    key: ("helsinki".into(), "broken".into(), Event::Failure),
                    detail: "runner refused".into()
                },
            ]
        );
        let bikes = watched.iter().find(|w| w.name == "bikes").unwrap();
        assert_eq!(bikes.spaces, ["mobility".to_owned()].into());
        assert_eq!(bikes.types, ["BikeHireDockingStation".to_owned()].into());
    }

    #[tokio::test]
    async fn a_subscriber_is_told_once_when_it_starts_once_when_it_recovers_and_not_while_muted() {
        let mirror = mirror();
        let store = Arc::new(AlertStore::new(None));
        let evaluator = Evaluator::new(
            Arc::clone(&mirror),
            Arc::new(crate::quality::Store::default()),
            Arc::clone(&store),
        );
        let jana = store
            .upsert(
                "jana",
                "helsinki",
                Scope::Space,
                "mobility",
                &[Event::Zero],
                Delivery::Portal,
            )
            .await
            .unwrap();
        let muted = store
            .upsert(
                "eeva",
                "helsinki",
                Scope::Pipeline,
                "bikes",
                &[Event::Zero],
                Delivery::Portal,
            )
            .await
            .unwrap();
        store
            .mute("eeva", muted.id, Some(at("2026-10-08T00:00:00Z")))
            .await
            .unwrap();
        store
            .upsert(
                "mikko",
                "helsinki",
                Scope::Pipeline,
                "bikes",
                &[Event::Failure],
                Delivery::Portal,
            )
            .await
            .unwrap();

        let stalled = json!({ "phase": "Live", "conditions": [{ "type": "StreamWriting", "status": "False", "reason": "Stalled" }] });
        mirror.upsert(pipeline("bikes", stalled));
        evaluator.run(at("2026-10-07T08:00:00Z")).await.unwrap();
        evaluator.run(at("2026-10-07T08:01:00Z")).await.unwrap();
        mirror.upsert(pipeline("bikes", json!({ "phase": "Live" })));
        evaluator.run(at("2026-10-07T08:02:00Z")).await.unwrap();

        let told = store.notices(&["jana".into()]).await.unwrap();
        assert_eq!(
            told.iter().map(|n| n.change.as_str()).collect::<Vec<_>>(),
            vec!["recovered", "opened"]
        );
        assert!(told
            .iter()
            .all(|n| n.subscription == jana.id && n.event == Event::Zero && n.pipeline == "bikes"));
        assert!(
            store.notices(&["eeva".into()]).await.unwrap().is_empty(),
            "muted"
        );
        assert!(
            store.notices(&["mikko".into()]).await.unwrap().is_empty(),
            "another event"
        );
        assert!(store.open_incidents().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_digest_names_the_day_s_incidents_once() {
        let mirror = mirror();
        let store = Arc::new(AlertStore::new(None));
        let evaluator = Evaluator::new(
            Arc::clone(&mirror),
            Arc::new(crate::quality::Store::default()),
            Arc::clone(&store),
        );
        store
            .upsert(
                "jana",
                "helsinki",
                Scope::Pipeline,
                "bikes",
                &[Event::Failure],
                Delivery::Digest,
            )
            .await
            .unwrap();
        mirror.upsert(pipeline("bikes", json!({ "phase": "Error" })));
        evaluator.run(at("2026-10-07T03:00:00Z")).await.unwrap();
        assert!(
            store.notices(&["jana".into()]).await.unwrap().is_empty(),
            "nothing before seven, nothing at once"
        );
        evaluator.run(at("2026-10-07T07:30:00Z")).await.unwrap();
        evaluator.run(at("2026-10-07T09:00:00Z")).await.unwrap();
        let told = store.notices(&["jana".into()]).await.unwrap();
        assert_eq!(told.len(), 1);
        assert_eq!(
            (told[0].change.as_str(), told[0].event),
            ("digest", Event::Failure)
        );
    }

    #[tokio::test]
    async fn a_person_keeps_their_newest_notices_and_reads_only_their_own() {
        let store = AlertStore::new(None);
        let sub = store
            .upsert(
                "jana",
                "helsinki",
                Scope::Pipeline,
                "bikes",
                &[Event::Zero],
                Delivery::Portal,
            )
            .await
            .unwrap();
        let key: IncidentKey = ("helsinki".into(), "bikes".into(), Event::Zero);
        for _ in 0..(KEPT + 5) {
            store
                .notify("jana", sub.id, &key, "opened", "")
                .await
                .unwrap();
        }
        let notices = store.notices(&["jana".into()]).await.unwrap();
        assert_eq!(notices.len(), KEPT as usize);
        assert!(!store
            .mark_read(&["eeva".into()], notices[0].id)
            .await
            .unwrap());
        assert!(store
            .mark_read(&["jana".into()], notices[0].id)
            .await
            .unwrap());
        assert!(store.notices(&["jana".into()]).await.unwrap()[0].read);
        assert!(store.remove("jana", sub.id).await.unwrap());
        assert!(
            store.notices(&["jana".into()]).await.unwrap().is_empty(),
            "notices go with their subscription"
        );
    }
}
