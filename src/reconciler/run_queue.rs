//! The run queue of the pipelines that do not wait for pushes (PL-78, T-4348).
//!
//! A pipeline whose sources wait for pushes (MQTT, a WebSocket, a server or a broker subscriber)
//! stays a resident stream. Every other one is created in the runner only for its run and
//! deleted when the run finishes, fails or reaches [`RUN_TIMEOUT`]: one queue ordered by due
//! time, then project and name, in two lanes, so a long harvest never holds a live poller. Before
//! this every scheduled poll was a resident stream with its cron as the clock; 92 of them fired
//! together and the runner ran out of memory (2026-10-16 09:50Z).
//!
//! [`RunQueue`] is the state alone, read with a clock the caller passes in; `tick` drives it
//! against a `Runner`.

use std::collections::{BTreeMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;

use chrono::{DateTime, Duration as Span, SecondsFormat, Timelike, Utc};
use jc_core::kinds::data_source::DataSourceType;
use serde_json::Value;

use super::streams::StreamOutcome;

/// A pipeline by (project, name).
pub type Key = (String, String);

/// The longest a run may take before it is deleted as failed.
pub const RUN_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// A clock at least this long runs in the batch lane, a shorter one in the short lane.
const SHORT_BELOW: Duration = Duration::from_secs(5 * 60);
/// A queue that no reconciler pass has planned for this long belongs to a Portal that lost its
/// leadership: it finishes what runs and starts nothing.
const STALE_PLAN: Duration = Duration::from_secs(10 * 60);

/// The runner inputs that wait for pushes and so stay loaded: servers and broker subscribers.
const RESIDENT_INPUTS: &[&str] = &[
    "http_server",
    "socket_server",
    "kafka",
    "kafka_franz",
    "nats",
    "nats_jetstream",
    "nats_stream",
    "amqp_0_9",
    "amqp_1",
    "redis_streams",
    "redis_pubsub",
    "gcp_pubsub",
    "mqtt",
    "websocket",
];

/// Whether a source of this type waits for pushes and so stays loaded in the runner (PL-78);
/// a poll, a feed and a read that ends are run and deleted.
pub fn is_resident(source: &DataSourceType) -> bool {
    match source {
        DataSourceType::Mqtt | DataSourceType::WebSocket => true,
        DataSourceType::Http | DataSourceType::GtfsRt => false,
        DataSourceType::Runner(name) => RESIDENT_INPUTS.contains(&name.as_str()),
    }
}

/// The two lanes of the queue, each with its own concurrency.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Lane {
    /// A clock of 5 minutes or longer, and a pipeline that runs once.
    Batch,
    /// A clock shorter than 5 minutes.
    Short,
}

impl Lane {
    fn label(self) -> &'static str {
        match self {
            Lane::Batch => "batch",
            Lane::Short => "short",
        }
    }
}

/// When a pipeline runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Clock {
    /// Neither `period` nor `schedule`: once after apply.
    Once,
    /// A `period`, counted from 1970-01-01T00:00Z so a Portal restart does not move it.
    Every(Duration),
    /// A `schedule` of five cron fields, read in UTC.
    Cron(Cron),
}

impl Clock {
    /// The clock of a pipeline: its `period` when it has one, else its `schedule`.
    pub fn of(period: Option<&str>, schedule: Option<&str>) -> Result<Clock, String> {
        fn given(v: Option<&str>) -> Option<&str> {
            v.map(str::trim).filter(|v| !v.is_empty())
        }
        if let Some(period) = given(period) {
            return match super::streams::duration_of(period) {
                Some(every) if every >= Duration::from_secs(1) => Ok(Clock::Every(every)),
                _ => Err(format!(
                    "period `{period}` is not a duration of at least 1s (`30s`, `5m`, `24h`)"
                )),
            };
        }
        match given(schedule) {
            Some(schedule) => Cron::parse(schedule).map(Clock::Cron).ok_or_else(|| {
                format!("schedule `{schedule}` is not five cron fields (`0 5 * * *`)")
            }),
            None => Ok(Clock::Once),
        }
    }

    /// The first run strictly after `t`; none for [`Clock::Once`].
    pub fn next_after(&self, t: DateTime<Utc>) -> Option<DateTime<Utc>> {
        match self {
            Clock::Once => None,
            Clock::Every(every) => {
                let every = every.as_millis() as i64;
                let at = (t.timestamp_millis().div_euclid(every) + 1) * every;
                DateTime::from_timestamp_millis(at)
            }
            Clock::Cron(cron) => cron.next_after(t),
        }
    }

    /// The lane of a pipeline on this clock, read from the gap between its next two runs.
    pub fn lane(&self, now: DateTime<Utc>) -> Lane {
        let gap = self
            .next_after(now)
            .and_then(|first| Some((first, self.next_after(first)?)))
            .map(|(first, second)| (second - first).to_std().unwrap_or_default());
        match gap {
            Some(gap) if gap < SHORT_BELOW => Lane::Short,
            _ => Lane::Batch,
        }
    }
}

/// Five cron fields as bit sets: minute, hour, day of month, month, day of week (0 and 7 are
/// Sunday). Numbers, `*`, `a-b`, `a,b` and `/n` steps; no names and no `@daily`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cron {
    minutes: u64,
    hours: u64,
    days: u64,
    months: u64,
    weekdays: u64,
    any_day: bool,
    any_weekday: bool,
}

impl Cron {
    pub fn parse(text: &str) -> Option<Cron> {
        let fields: Vec<&str> = text.split_whitespace().collect();
        let [minute, hour, day, month, weekday] = fields.as_slice() else {
            return None;
        };
        let mut weekdays = field(weekday, 0, 7)?;
        if weekdays & (1 << 7) != 0 {
            weekdays |= 1;
        }
        Some(Cron {
            minutes: field(minute, 0, 59)?,
            hours: field(hour, 0, 23)?,
            days: field(day, 1, 31)?,
            months: field(month, 1, 12)?,
            weekdays,
            any_day: day.starts_with('*'),
            any_weekday: weekday.starts_with('*'),
        })
    }

    fn matches(&self, t: DateTime<Utc>) -> bool {
        use chrono::Datelike;
        let has = |set: u64, v: u32| set & (1 << v) != 0;
        let day = has(self.days, t.day());
        let weekday = has(self.weekdays, t.weekday().num_days_from_sunday());
        // Both restricted means either one, as cron reads it.
        let day_ok = match (self.any_day, self.any_weekday) {
            (true, true) => true,
            (true, false) => weekday,
            (false, true) => day,
            (false, false) => day || weekday,
        };
        has(self.minutes, t.minute())
            && has(self.hours, t.hour())
            && has(self.months, t.month())
            && day_ok
    }

    /// ponytail: a minute-by-minute scan over at most a year (half a million cheap checks for a
    /// date that never comes, such as 30 February); a field-skipping search if it ever shows.
    fn next_after(&self, t: DateTime<Utc>) -> Option<DateTime<Utc>> {
        let mut at = t.with_second(0)?.with_nanosecond(0)? + Span::minutes(1);
        for _ in 0..366 * 24 * 60 {
            if self.matches(at) {
                return Some(at);
            }
            at += Span::minutes(1);
        }
        None
    }
}

/// One cron field as a bit set of the values from `lo` to `hi` it names.
fn field(text: &str, lo: u32, hi: u32) -> Option<u64> {
    let mut set = 0u64;
    for part in text.split(',') {
        let (range, step) = match part.split_once('/') {
            Some((range, step)) => (range, Some(step.parse::<u32>().ok().filter(|s| *s > 0)?)),
            None => (part, None),
        };
        let (from, to) = if range == "*" {
            (lo, hi)
        } else if let Some((from, to)) = range.split_once('-') {
            (from.parse().ok()?, to.parse().ok()?)
        } else {
            let from: u32 = range.parse().ok()?;
            (from, if step.is_some() { hi } else { from })
        };
        if from < lo || to > hi || from > to {
            return None;
        }
        for v in (from..=to).step_by(step.unwrap_or(1) as usize) {
            set |= 1 << v;
        }
    }
    Some(set)
}

/// One run-and-delete pipeline as the reconciler hands it over: its stream as one run, and its
/// clock.
#[derive(Debug, Clone)]
pub struct Planned {
    pub stream: Value,
    pub clock: Clock,
}

#[derive(Debug, Clone)]
enum Last {
    Finished { at: DateTime<Utc>, seconds: i64 },
    Failed { at: DateTime<Utc>, reason: String },
}

#[derive(Debug)]
struct Entry {
    stream: Value,
    clock: Clock,
    lane: Lane,
    /// When it is due next.
    next: Option<DateTime<Utc>>,
    /// In the queue since this due time.
    queued: Option<DateTime<Utc>>,
    /// In the runner since then.
    running: Option<DateTime<Utc>>,
    /// The id of the run in the runner: its due time, as the pipeline's log names runs (PL-62).
    run: Option<String>,
    /// Its stream is removed from the runner once before its first run: one an older Portal
    /// loaded as resident, or a run a restarted Portal no longer knows.
    sweep: bool,
    last: Option<Last>,
}

/// What the runner says of one run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunState {
    /// It still runs, or the runner did not answer.
    Running,
    /// It ended: its input is exhausted.
    Finished,
    /// The runner does not hold it.
    Gone,
}

/// The runner, as the queue uses it.
pub(crate) trait Runner {
    /// Creates the run's stream.
    async fn start(&self, key: &Key, stream: &Value) -> Result<(), String>;
    /// How the run stands.
    async fn state(&self, key: &Key) -> RunState;
    /// Removes the stream; a stream that is not there is fine.
    async fn delete(&self, key: &Key);
    /// Hears that the run `run` of `key` ended, `finished` or not (T-4891).
    async fn ended(&self, _key: &Key, _run: &str, _finished: bool) {}
}

/// The queue and its two lanes' concurrency.
#[derive(Debug)]
pub struct RunQueue {
    batch: usize,
    short: usize,
    timeout: Duration,
    entries: BTreeMap<Key, Entry>,
    /// Runs whose pipeline went away while they ran: deleted on the next tick.
    gone: Vec<Key>,
    /// The runs that ended since the last tick, by run id, and whether the runner finished them
    /// (T-4891): a snapshot pipeline judges its deletes on them.
    ends: Vec<(Key, String, bool)>,
    planned_at: Option<DateTime<Utc>>,
    /// The pipelines with a run in the durable log (T-4421): a scheduled one new to this queue
    /// and not among them never ran, so it runs at once instead of waiting a day for its clock.
    /// `None` until the log has been read: a restart then never runs every pipeline at once.
    ran: Option<HashSet<Key>>,
    /// The workload accounts (`project/name`) whose Keycloak client the last reconcile could not
    /// converge (T-4426): a pipeline of one is not started, since every write it made would be
    /// refused 401 and replayed until [`RUN_TIMEOUT`], holding its lane.
    unbound: HashSet<String>,
}

impl RunQueue {
    pub fn new(batch: usize, short: usize) -> Self {
        Self {
            batch: batch.max(1),
            short: short.max(1),
            timeout: RUN_TIMEOUT,
            entries: BTreeMap::new(),
            gone: Vec::new(),
            ends: Vec::new(),
            planned_at: None,
            ran: None,
            unbound: HashSet::new(),
        }
    }

    /// The workload accounts the last reconcile left without a client, as `project/name`
    /// (T-4426); an empty set once they all converged.
    pub fn unbound(&mut self, accounts: HashSet<String>) {
        self.unbound = accounts;
    }

    /// Whether `key`'s own pipeline account is one the realm has no client for.
    fn is_unbound(&self, key: &Key) -> bool {
        !self.unbound.is_empty()
            && self.unbound.contains(&format!(
                "{}/{}",
                key.0,
                jc_core::kinds::pipeline_identity::account_name(&key.1)
            ))
    }

    /// The pipelines the run log holds a run of, read before each [`RunQueue::plan`].
    pub fn ran(&mut self, ran: HashSet<Key>) {
        self.ran = Some(ran);
    }

    /// Takes the reconciler's whole set of run-and-delete pipelines: a new one or one whose
    /// stream or clock changed is due by its clock (a run-once one at once, and a scheduled one
    /// that never ran at once too), one no longer in the set leaves the queue and its run is
    /// deleted.
    pub fn plan(&mut self, wanted: BTreeMap<Key, Planned>, now: DateTime<Utc>) {
        self.planned_at = Some(now);
        let dropped: Vec<Key> = self
            .entries
            .keys()
            .filter(|key| !wanted.contains_key(*key))
            .cloned()
            .collect();
        for key in dropped {
            if self
                .entries
                .remove(&key)
                .is_some_and(|e| e.running.is_some())
            {
                self.gone.push(key);
            }
        }
        for (key, planned) in wanted {
            let first = match planned.clock {
                Clock::Once => Some(now),
                ref clock => clock.next_after(now),
            };
            let lane = planned.clock.lane(now);
            match self.entries.get_mut(&key) {
                Some(entry) if entry.stream == planned.stream && entry.clock == planned.clock => {}
                Some(entry) => {
                    entry.stream = planned.stream;
                    entry.clock = planned.clock;
                    entry.lane = lane;
                    entry.next = first;
                }
                None => {
                    let never_ran = self.ran.as_ref().is_some_and(|ran| !ran.contains(&key));
                    let first = if never_ran { Some(now) } else { first };
                    self.entries.insert(
                        key,
                        Entry {
                            stream: planned.stream,
                            clock: planned.clock,
                            lane,
                            next: first,
                            queued: None,
                            running: None,
                            run: None,
                            sweep: true,
                            last: None,
                        },
                    );
                }
            }
        }
    }

    /// The streams to remove before anything starts: runs whose pipeline went away, and each
    /// new pipeline's leftover.
    fn sweeps(&mut self) -> Vec<Key> {
        let mut keys = std::mem::take(&mut self.gone);
        for (key, entry) in &mut self.entries {
            if entry.sweep && entry.running.is_none() {
                entry.sweep = false;
                keys.push(key.clone());
            }
        }
        keys
    }

    fn running(&self) -> Vec<Key> {
        self.entries
            .iter()
            .filter(|(_, e)| e.running.is_some())
            .map(|(k, _)| k.clone())
            .collect()
    }

    /// Ends the runs the runner finished, lost or held too long; queues what came due; starts
    /// what each lane has room for. Returns the runs to delete and the runs to start.
    fn settle(
        &mut self,
        states: Vec<(Key, RunState)>,
        now: DateTime<Utc>,
    ) -> (Vec<Key>, Vec<(Key, Value)>) {
        let mut ended = Vec::new();
        for (key, state) in states {
            let Some(entry) = self.entries.get_mut(&key) else {
                continue;
            };
            let Some(started) = entry.running else {
                continue;
            };
            let seconds = (now - started).num_seconds().max(0);
            let outcome = match state {
                RunState::Finished => Some(("finished", None)),
                RunState::Gone => Some((
                    "failed",
                    Some("the runner no longer holds the run".to_owned()),
                )),
                RunState::Running
                    if (now - started).to_std().unwrap_or_default() >= self.timeout =>
                {
                    Some((
                        "timeout",
                        Some(format!(
                            "it ran past {} min and was stopped",
                            self.timeout.as_secs() / 60
                        )),
                    ))
                }
                RunState::Running => None,
            };
            let Some((label, failure)) = outcome else {
                continue;
            };
            crate::telemetry::pipeline_run(label, seconds as f64);
            let finished = failure.is_none();
            self.ends
                .extend(entry.run.clone().map(|run| (key.clone(), run, finished)));
            entry.running = None;
            entry.last = Some(match failure {
                None => Last::Finished { at: now, seconds },
                Some(reason) => Last::Failed { at: now, reason },
            });
            ended.push(key);
        }

        // What came due joins the queue; a pipeline already queued or running stays one entry.
        for entry in self.entries.values_mut() {
            let Some(due) = entry.next.filter(|due| *due <= now) else {
                continue;
            };
            if entry.queued.is_none() && entry.running.is_none() {
                entry.queued = Some(due);
            }
            entry.next = entry.clock.next_after(now);
        }

        let mut starts = Vec::new();
        let fresh = self
            .planned_at
            .is_some_and(|at| (now - at).to_std().unwrap_or_default() < STALE_PLAN);
        for (lane, limit) in [(Lane::Batch, self.batch), (Lane::Short, self.short)] {
            let in_lane = |e: &Entry| e.lane == lane;
            let busy = self
                .entries
                .values()
                .filter(|e| in_lane(e) && e.running.is_some())
                .count();
            let mut waiting: Vec<(DateTime<Utc>, Key)> = self
                .entries
                .iter()
                .filter(|(_, e)| in_lane(e) && e.running.is_none() && !e.sweep)
                .filter_map(|(k, e)| Some((e.queued?, k.clone())))
                .collect();
            waiting.sort();
            // A run whose account has no client would only be refused: it ends failed here, with
            // its reason, and leaves its slot to the next (T-4426).
            if fresh {
                let (refused, rest): (Vec<_>, Vec<_>) = waiting
                    .into_iter()
                    .partition(|(_, key)| self.is_unbound(key));
                waiting = rest;
                for (_, key) in refused {
                    if let Some(entry) = self.entries.get_mut(&key) {
                        crate::telemetry::pipeline_run("failed", 0.0);
                        entry.queued = None;
                        entry.last = Some(Last::Failed {
                            at: now,
                            reason: "not started: the realm holds no client for its account \
                                     yet, so the gateway would refuse its writes (401); it runs \
                                     at its next due time once the client is there"
                                .to_owned(),
                        });
                    }
                }
            }
            let room = if fresh { limit.saturating_sub(busy) } else { 0 };
            for (due, key) in waiting.iter().take(room) {
                if let Some(entry) = self.entries.get_mut(key) {
                    let run = stamp(*due);
                    entry.queued = None;
                    entry.running = Some(now);
                    starts.push((key.clone(), with_run(&entry.stream, &run)));
                    entry.run = Some(run);
                }
            }
            crate::telemetry::pipeline_queue_depth(
                lane.label(),
                waiting.len().saturating_sub(room),
            );
        }
        (ended, starts)
    }

    /// Queues one run of `key` now, outside its clock (T-4349), and names it: an entry already
    /// queued keeps its place and its run.
    pub fn run_now(&mut self, key: &Key, now: DateTime<Utc>) -> Result<String, RunNow> {
        let entry = self.entries.get_mut(key).ok_or(RunNow::NotQueued)?;
        if entry.running.is_some() {
            return Err(RunNow::Running(entry.run.clone().unwrap_or_default()));
        }
        Ok(stamp(*entry.queued.get_or_insert(now)))
    }

    fn failed_to_start(&mut self, key: &Key, reason: String, now: DateTime<Utc>) {
        if let Some(entry) = self.entries.get_mut(key) {
            entry.running = None;
            entry.last = Some(Last::Failed {
                at: now,
                reason: format!("the runner refused the run: {reason}"),
            });
        }
    }

    /// What the Pipeline's status says: `Error` while its last run failed, else where it stands.
    pub fn outcome(&self, key: &Key) -> Option<StreamOutcome> {
        let entry = self.entries.get(key)?;
        let next = match entry.next {
            Some(next) => format!("next run {}", stamp(next)),
            None => "no further run until it changes".to_owned(),
        };
        if let Some(Last::Failed { at, reason }) = &entry.last {
            return Some(StreamOutcome::Error(format!(
                "the last run, ended {}, failed: {reason}; {next}",
                stamp(*at)
            )));
        }
        let (reason, now) = match (entry.running, entry.queued) {
            (Some(since), _) => ("Running", format!("running since {}", stamp(since))),
            (None, Some(due)) => ("Queued", format!("queued, due {}", stamp(due))),
            (None, None) => ("Waiting", next),
        };
        let last = match &entry.last {
            Some(Last::Finished { at, seconds }) => {
                format!("; the last run ended {} after {seconds} s", stamp(*at))
            }
            _ => String::new(),
        };
        Some(StreamOutcome::Scheduled(reason, format!("{now}{last}")))
    }
}

/// Why a run cannot be queued now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunNow {
    /// The queue does not hold the pipeline: it waits for pushes and always runs, or it is not
    /// deployed.
    NotQueued,
    /// Its run with this id is in the runner.
    Running(String),
}

/// The stream of one run with its run id written in, in place of the clock's time, so the
/// pipeline's log files the run under the id this Portal hands out (PL-62, T-4349).
fn with_run(stream: &Value, run: &str) -> Value {
    let named = format!("meta jc_run = {}", Value::from(run));
    let mut stream = stream.clone();
    fn walk(value: &mut Value, named: &str) {
        match value {
            Value::String(text) if text.contains(crate::pipeline_log::TICK) => {
                *text = text.replace(crate::pipeline_log::TICK, named);
            }
            Value::Array(items) => items.iter_mut().for_each(|item| walk(item, named)),
            Value::Object(fields) => fields.values_mut().for_each(|field| walk(field, named)),
            _ => {}
        }
    }
    walk(&mut stream, &named);
    stream
}

fn stamp(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// One step of the queue against the runner: sweeps, then the running runs' state, then ends
/// and starts. The lock is never held across a runner call.
pub(crate) async fn tick<R: Runner>(queue: &Mutex<RunQueue>, runner: &R, now: DateTime<Utc>) {
    let lock = || {
        queue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    };
    let (sweeps, running) = {
        let mut q = lock();
        (q.sweeps(), q.running())
    };
    for key in &sweeps {
        runner.delete(key).await;
    }
    let mut states = Vec::with_capacity(running.len());
    for key in running {
        let state = runner.state(&key).await;
        states.push((key, state));
    }
    let (ended, starts) = lock().settle(states, now);
    for key in &ended {
        runner.delete(key).await;
    }
    let ends = std::mem::take(&mut lock().ends);
    for (key, run, finished) in ends {
        runner.ended(&key, &run, finished).await;
    }
    for (key, stream) in starts {
        if let Err(reason) = runner.start(&key, &stream).await {
            lock().failed_to_start(&key, reason, now);
            runner.delete(&key).await;
        }
    }
}

/// The stream of one run: every clock fires once, at once. An `http_client` input (a GTFS-RT
/// feed) polls without end, so it becomes the one tick and the `http` processor an `http`
/// DataSource is rendered with (PL-47).
///
/// A write that still fails after its own retries ends the run as a `failed` line with the
/// target's words. A resident stream nacks it back to its input to replay it, but a run has no
/// later message to wait for: the replay looped until [`RUN_TIMEOUT`] and logged nothing
/// (T-4952). The next run writes the record again, each write an idempotent upsert.
pub fn one_run(stream: &Value) -> Value {
    let report = outcome_url(stream);
    let mut stream = stream.clone();
    if let Some(input) = stream.get_mut("input") {
        once(input, report.as_deref());
    }
    if report.is_some() {
        if let Some(processors) = stream
            .pointer_mut("/pipeline/processors")
            .and_then(Value::as_array_mut)
        {
            processors.push(serde_json::json!({ "catch": [{ "mutation": format!(
                "meta {} = \"the write failed: \" + error().re_replace_all(\"[a-z]+://[^\\\\s'\\\"]+\", \"the target\")",
                crate::pipeline_log::FAILED_KEY
            ) }] }));
        }
    }
    stream
}

/// Where the stream's outcome sink posts its reports, if it has one.
fn outcome_url(value: &Value) -> Option<String> {
    match value {
        Value::Object(fields) => {
            if fields.get("label").and_then(Value::as_str)
                == Some(crate::pipeline_log::SINK_LABELS[1])
            {
                if let Some(url) = fields
                    .get("http_client")
                    .and_then(|client| client.get("url"))
                    .and_then(Value::as_str)
                {
                    return Some(url.to_owned());
                }
            }
            fields.values().find_map(outcome_url)
        }
        Value::Array(items) => items.iter().find_map(outcome_url),
        _ => None,
    }
}

fn once(input: &mut Value, report: Option<&str>) {
    if let Some(inputs) = input
        .get_mut("broker")
        .and_then(|b| b.get_mut("inputs"))
        .and_then(Value::as_array_mut)
    {
        inputs.iter_mut().for_each(|input| once(input, report));
        return;
    }
    let Some(fields) = input.as_object_mut() else {
        return;
    };
    if let Some(generate) = fields.get_mut("generate").and_then(Value::as_object_mut) {
        generate.insert("count".to_owned(), Value::from(1));
        generate.insert("interval".to_owned(), Value::from(""));
        return;
    }
    let Some(Value::Object(mut client)) = fields.remove("http_client") else {
        return;
    };
    let meta: String = match client.remove("metadata") {
        Some(Value::Object(meta)) => meta
            .iter()
            .map(|(name, value)| format!("meta {name} = {value}\n"))
            .collect(),
        _ => String::new(),
    };
    let mut processors = vec![serde_json::json!({ "try": [{ "http": Value::Object(client) }] })];
    // A refused request is a failed run with the source's words, not an empty one (T-4428).
    if let Some(url) = report {
        processors.push(crate::pipeline_log::source_failure(url));
    }
    processors.push(serde_json::json!({ "mutation": "root = if errored() { deleted() }" }));
    if let Some(Value::Array(own)) = fields.remove("processors") {
        processors.extend(own);
    }
    fields.insert(
        "generate".to_owned(),
        serde_json::json!({
            "count": 1,
            "interval": "",
            "mapping": format!("root = \"\"\n{meta}{}", crate::pipeline_log::TICK),
        }),
    );
    fields.insert("processors".to_owned(), Value::Array(processors));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeSet, HashMap};

    fn at(text: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(text)
            .expect("a time")
            .with_timezone(&Utc)
    }

    fn key(name: &str) -> Key {
        ("p".to_owned(), name.to_owned())
    }

    fn planned(clock: Clock) -> Planned {
        Planned {
            stream: serde_json::json!({"input": {"generate": {"count": 1}}}),
            clock,
        }
    }

    /// The runner as the queue sees it: each run started is held until the test ends it.
    #[derive(Default)]
    struct Fake {
        held: Mutex<HashMap<Key, RunState>>,
        log: Mutex<Vec<String>>,
        refuse: Mutex<BTreeSet<String>>,
        sent: Mutex<HashMap<String, Value>>,
        ends: Mutex<Vec<(String, String, bool)>>,
    }

    impl Fake {
        fn end(&self, name: &str, state: RunState) {
            self.held.lock().unwrap().insert(key(name), state);
        }
        fn held(&self) -> Vec<String> {
            let mut names: Vec<String> = self
                .held
                .lock()
                .unwrap()
                .keys()
                .map(|k| k.1.clone())
                .collect();
            names.sort();
            names
        }
        fn log(&self) -> Vec<String> {
            std::mem::take(&mut *self.log.lock().unwrap())
        }
    }

    impl Runner for Fake {
        async fn start(&self, key: &Key, stream: &Value) -> Result<(), String> {
            self.log.lock().unwrap().push(format!("start {}", key.1));
            self.sent
                .lock()
                .unwrap()
                .insert(key.1.clone(), stream.clone());
            if self.refuse.lock().unwrap().contains(&key.1) {
                return Err("400 bad config".to_owned());
            }
            self.held
                .lock()
                .unwrap()
                .insert(key.clone(), RunState::Running);
            Ok(())
        }
        async fn state(&self, key: &Key) -> RunState {
            self.held
                .lock()
                .unwrap()
                .get(key)
                .copied()
                .unwrap_or(RunState::Gone)
        }
        async fn delete(&self, key: &Key) {
            self.log.lock().unwrap().push(format!("delete {}", key.1));
            self.held.lock().unwrap().remove(key);
        }
        async fn ended(&self, key: &Key, run: &str, finished: bool) {
            let end = (key.1.clone(), run.to_owned(), finished);
            self.ends.lock().unwrap().push(end);
        }
    }

    /// A snapshot pipeline judges its deletes on the run that ended, by the id its log names it
    /// under, and only a run the runner finished counts as complete (T-4891).
    #[tokio::test]
    async fn each_ended_run_is_told_by_its_id_and_whether_it_finished() {
        let queue = Mutex::new(RunQueue::new(2, 1));
        let fake = Fake::default();
        let now = at("2026-10-17T05:00:00Z");
        let wanted = ["a", "b"]
            .map(|n| (key(n), planned(Clock::Once)))
            .into_iter()
            .collect();
        queue.lock().unwrap().plan(wanted, now);
        step(&queue, &fake, now).await;
        assert!(fake.ends.lock().unwrap().is_empty(), "nothing ended yet");
        fake.end("a", RunState::Finished);
        step(&queue, &fake, now + Span::minutes(1)).await;
        step(&queue, &fake, now + Span::minutes(15)).await;
        assert_eq!(
            *fake.ends.lock().unwrap(),
            [
                ("a".to_owned(), "2026-10-17T05:00:00Z".to_owned(), true),
                ("b".to_owned(), "2026-10-17T05:00:00Z".to_owned(), false),
            ]
        );
    }

    /// One tick, the reconciler having planned just before it as it does on every pass.
    async fn step(queue: &Mutex<RunQueue>, fake: &Fake, now: DateTime<Utc>) {
        queue.lock().unwrap().planned_at = Some(now);
        tick(queue, fake, now).await;
    }

    fn daily_at_5() -> Clock {
        Clock::of(None, Some("0 5 * * *")).expect("a schedule")
    }

    #[test]
    fn only_sources_that_wait_for_pushes_are_resident() {
        let runner = |name: &str| DataSourceType::Runner(name.to_owned());
        for resident in [
            DataSourceType::Mqtt,
            DataSourceType::WebSocket,
            runner("http_server"),
            runner("socket_server"),
            runner("kafka"),
            runner("nats"),
            runner("nats_jetstream"),
            runner("amqp_0_9"),
            runner("amqp_1"),
            runner("redis_streams"),
        ] {
            assert!(is_resident(&resident), "{resident}");
        }
        for queued in [
            DataSourceType::Http,
            DataSourceType::GtfsRt,
            runner("file"),
            runner("sql_select"),
            runner("aws_s3"),
            runner("csv"),
            runner("http_client"),
        ] {
            assert!(!is_resident(&queued), "{queued}");
        }
    }

    #[test]
    fn a_clock_is_the_period_else_the_schedule_else_once() {
        assert_eq!(Clock::of(None, None), Ok(Clock::Once));
        assert_eq!(Clock::of(Some(" "), Some("")), Ok(Clock::Once));
        assert_eq!(
            Clock::of(Some("5m"), Some("0 5 * * *")),
            Ok(Clock::Every(Duration::from_secs(300)))
        );
        assert!(Clock::of(Some("0s"), None).is_err());
        assert!(Clock::of(Some("daily"), None).is_err());
        for bad in [
            "@daily",
            "0 5 * *",
            "61 * * * *",
            "0 5 * * MON",
            "*/0 * * * *",
            "5-1 * * * *",
        ] {
            assert!(Clock::of(None, Some(bad)).is_err(), "{bad}");
        }
        let now = at("2026-10-16T13:47:30Z");
        assert_eq!(
            daily_at_5().next_after(now),
            Some(at("2026-10-17T05:00:00Z"))
        );
        assert_eq!(
            Clock::Every(Duration::from_secs(86_400)).next_after(now),
            Some(at("2026-10-17T00:00:00Z"))
        );
        let cron = |s: &str| Clock::of(None, Some(s)).unwrap().next_after(now);
        assert_eq!(cron("*/10 * * * *"), Some(at("2026-10-16T13:50:00Z")));
        assert_eq!(
            cron("41 3 * * 1"),
            Some(at("2026-10-19T03:41:00Z")),
            "Monday"
        );
        assert_eq!(
            cron("42 1 * * 7"),
            Some(at("2026-10-18T01:42:00Z")),
            "7 is Sunday"
        );
        assert_eq!(
            cron("0 0 1,15 * 5"),
            Some(at("2026-10-23T00:00:00Z")),
            "day or weekday"
        );
        assert_eq!(cron("0 0 30 2 *"), None, "30 February never comes");
        assert_eq!(Clock::Every(Duration::from_secs(30)).lane(now), Lane::Short);
        assert_eq!(
            Clock::of(None, Some("* * * * *")).unwrap().lane(now),
            Lane::Short
        );
        assert_eq!(Clock::Every(SHORT_BELOW).lane(now), Lane::Batch);
        assert_eq!(daily_at_5().lane(now), Lane::Batch);
        assert_eq!(Clock::Once.lane(now), Lane::Batch);
    }

    #[tokio::test]
    async fn a_pipeline_whose_account_has_no_client_fails_unstarted_and_frees_its_lane() {
        let queue = Mutex::new(RunQueue::new(1, 1));
        let fake = Fake::default();
        let now = at("2026-10-17T04:59:00Z");
        let wanted = ["a", "b"]
            .map(|n| (key(n), planned(daily_at_5())))
            .into_iter()
            .collect();
        queue.lock().unwrap().plan(wanted, now);
        step(&queue, &fake, now).await;
        fake.log();
        // a's account is `p/pl-a`; the reconcile could not make its client (T-4426). `*` (a
        // whole wave that failed) and another project's account hold nobody back.
        queue.lock().unwrap().unbound(
            ["p/pl-a", "*", "q/pl-b"]
                .map(str::to_owned)
                .into_iter()
                .collect(),
        );

        let five = at("2026-10-17T05:00:00Z");
        step(&queue, &fake, five).await;
        assert_eq!(fake.log(), ["start b"], "a never takes the one batch slot");
        match queue.lock().unwrap().outcome(&key("a")) {
            Some(StreamOutcome::Error(said)) => {
                assert!(said.contains("no client for its account"), "{said}");
                assert!(said.contains("401"), "{said}");
            }
            other => panic!("a failed run, not {other:?}"),
        }

        // Once the client is there, a run of a starts like any other.
        queue.lock().unwrap().unbound(HashSet::new());
        fake.end("b", RunState::Finished);
        queue
            .lock()
            .unwrap()
            .run_now(&key("a"), five)
            .expect("queued");
        step(&queue, &fake, five + Span::seconds(60)).await;
        assert_eq!(fake.log(), ["delete b", "start a"]);
    }

    #[tokio::test]
    async fn three_pipelines_due_at_five_run_one_after_another_in_name_order_and_leave() {
        let queue = Mutex::new(RunQueue::new(1, 1));
        let fake = Fake::default();
        let now = at("2026-10-17T04:59:00Z");
        let wanted = ["c", "a", "b"]
            .map(|n| (key(n), planned(daily_at_5())))
            .into_iter()
            .collect();
        queue.lock().unwrap().plan(wanted, now);
        step(&queue, &fake, now).await;
        assert_eq!(
            fake.log(),
            ["delete a", "delete b", "delete c"],
            "each leftover is removed once"
        );

        let five = at("2026-10-17T05:00:00Z");
        step(&queue, &fake, five).await;
        assert_eq!(fake.log(), ["start a"]);
        step(&queue, &fake, five + Span::seconds(5)).await;
        assert_eq!(fake.held(), ["a"], "b waits while a runs");
        assert_eq!(
            queue.lock().unwrap().outcome(&key("b")),
            Some(StreamOutcome::Scheduled(
                "Queued",
                "queued, due 2026-10-17T05:00:00Z".to_owned()
            ))
        );
        for (name, next) in [("a", "b"), ("b", "c")] {
            fake.end(name, RunState::Finished);
            step(&queue, &fake, five + Span::seconds(60)).await;
            assert_eq!(
                fake.log(),
                [format!("delete {name}"), format!("start {next}")]
            );
            assert_eq!(fake.held(), [next]);
        }
        fake.end("c", RunState::Finished);
        step(&queue, &fake, five + Span::seconds(120)).await;
        assert_eq!(fake.log(), ["delete c"]);
        assert!(
            fake.held().is_empty(),
            "the runner holds nothing once the queue drained"
        );
        assert_eq!(
            queue.lock().unwrap().outcome(&key("a")),
            Some(StreamOutcome::Scheduled(
                "Waiting",
                "next run 2026-10-18T05:00:00Z; the last run ended 2026-10-17T05:01:00Z after 60 s"
                    .to_owned()
            ))
        );
    }

    #[tokio::test]
    async fn a_failed_or_timed_out_run_is_deleted_and_the_next_starts() {
        let queue = Mutex::new(RunQueue::new(1, 1));
        let fake = Fake::default();
        let now = at("2026-10-17T05:00:00Z");
        let wanted = ["a", "b", "c", "d"]
            .map(|n| (key(n), planned(Clock::Once)))
            .into_iter()
            .collect();
        queue.lock().unwrap().plan(wanted, now);
        fake.refuse.lock().unwrap().insert("a".to_owned());
        step(&queue, &fake, now).await;
        fake.log();
        assert!(fake.held().is_empty(), "a refused run is not held");
        assert!(
            matches!(queue.lock().unwrap().outcome(&key("a")), Some(StreamOutcome::Error(e)) if e.contains("400 bad config"))
        );

        step(&queue, &fake, now).await;
        assert_eq!(fake.log(), ["start b"]);
        step(&queue, &fake, now + Span::minutes(14)).await;
        assert_eq!(fake.held(), ["b"]);
        step(&queue, &fake, now + Span::minutes(15)).await;
        assert_eq!(
            fake.log(),
            ["delete b", "start c"],
            "a run past the timeout is deleted"
        );
        assert!(
            matches!(queue.lock().unwrap().outcome(&key("b")), Some(StreamOutcome::Error(e)) if e.contains("15 min"))
        );

        fake.held.lock().unwrap().remove(&key("c"));
        step(&queue, &fake, now + Span::minutes(16)).await;
        assert_eq!(
            fake.log(),
            ["delete c", "start d"],
            "a run the runner lost is failed and the next starts"
        );
        assert!(
            matches!(queue.lock().unwrap().outcome(&key("c")), Some(StreamOutcome::Error(e)) if e.contains("no longer holds"))
        );
    }

    #[tokio::test]
    async fn a_pipeline_due_again_while_queued_or_running_stays_one_entry() {
        let queue = Mutex::new(RunQueue::new(1, 1));
        let fake = Fake::default();
        let now = at("2026-10-17T04:59:00Z");
        let every_five = Clock::of(None, Some("*/5 * * * *")).unwrap();
        let wanted = [
            (key("long"), planned(daily_at_5())),
            (key("often"), planned(every_five)),
        ];
        queue
            .lock()
            .unwrap()
            .plan(wanted.into_iter().collect(), now);
        // Both in the batch lane: `often` waits behind `long` across three of its due times.
        step(&queue, &fake, now).await;
        fake.log();
        for minute in ["05:00", "05:05", "05:10"] {
            step(&queue, &fake, at(&format!("2026-10-17T{minute}:00Z"))).await;
        }
        assert_eq!(fake.log(), ["start long"]);
        fake.end("long", RunState::Finished);
        step(&queue, &fake, at("2026-10-17T05:11:00Z")).await;
        assert_eq!(fake.log(), ["delete long", "start often"]);
        fake.end("often", RunState::Finished);
        step(&queue, &fake, at("2026-10-17T05:12:00Z")).await;
        assert_eq!(fake.log(), ["delete often"], "three due times ran once");
        // Due twice while running: still one run.
        step(&queue, &fake, at("2026-10-17T05:15:00Z")).await;
        step(&queue, &fake, at("2026-10-17T05:20:00Z")).await;
        step(&queue, &fake, at("2026-10-17T05:25:00Z")).await;
        assert_eq!(fake.log(), ["start often"]);
        fake.end("often", RunState::Finished);
        step(&queue, &fake, at("2026-10-17T05:26:00Z")).await;
        assert_eq!(fake.log(), ["delete often"]);
    }

    #[tokio::test]
    async fn a_short_poll_runs_while_a_batch_run_is_in_progress_and_two_slots_run_two() {
        let queue = Mutex::new(RunQueue::new(2, 1));
        let fake = Fake::default();
        let now = at("2026-10-17T04:59:00Z");
        let wanted = [
            (key("harvest-a"), planned(daily_at_5())),
            (key("harvest-b"), planned(daily_at_5())),
            (key("harvest-c"), planned(daily_at_5())),
            (
                key("vehicles"),
                planned(Clock::Every(Duration::from_secs(30))),
            ),
        ];
        queue
            .lock()
            .unwrap()
            .plan(wanted.into_iter().collect(), now);
        step(&queue, &fake, now).await;
        step(&queue, &fake, at("2026-10-17T05:00:00Z")).await;
        assert_eq!(fake.held(), ["harvest-a", "harvest-b", "vehicles"]);
        fake.end("vehicles", RunState::Finished);
        step(&queue, &fake, at("2026-10-17T05:00:20Z")).await;
        step(&queue, &fake, at("2026-10-17T05:00:30Z")).await;
        assert_eq!(
            fake.held(),
            ["harvest-a", "harvest-b", "vehicles"],
            "the poll runs again beside the harvests"
        );
    }

    #[tokio::test]
    async fn a_pipeline_that_leaves_the_plan_has_its_run_deleted_and_a_stale_queue_starts_nothing()
    {
        let queue = Mutex::new(RunQueue::new(1, 1));
        let fake = Fake::default();
        let now = at("2026-10-17T05:00:00Z");
        queue.lock().unwrap().plan(
            [
                (key("a"), planned(Clock::Once)),
                (key("b"), planned(Clock::Once)),
            ]
            .into_iter()
            .collect(),
            now,
        );
        step(&queue, &fake, now).await;
        step(&queue, &fake, now).await;
        assert_eq!(fake.held(), ["a"]);
        fake.log();
        queue.lock().unwrap().plan(
            [(key("b"), planned(Clock::Once))].into_iter().collect(),
            now,
        );
        step(&queue, &fake, now).await;
        assert_eq!(fake.log(), ["delete a", "start b"]);
        assert_eq!(queue.lock().unwrap().outcome(&key("a")), None);

        fake.end("b", RunState::Finished);
        let later = now + Span::minutes(11);
        queue.lock().unwrap().plan(
            [
                (key("b"), planned(Clock::Once)),
                (key("c"), planned(Clock::Once)),
            ]
            .into_iter()
            .collect(),
            now,
        );
        tick(&queue, &fake, later).await;
        assert_eq!(
            fake.log(),
            ["delete c", "delete b"],
            "the run ends; nothing starts without a fresh plan"
        );
    }

    #[tokio::test]
    async fn a_run_now_joins_the_queue_once_and_is_named_by_its_due_time() {
        let queue = Mutex::new(RunQueue::new(1, 1));
        let fake = Fake::default();
        let now = at("2026-10-16T14:00:00Z");
        let tick_stream = serde_json::json!({"input": {"generate": {"count": 1, "mapping": format!("root = \"\"\n{}", crate::pipeline_log::TICK)}}});
        let wanted = [(
            key("a"),
            Planned {
                stream: tick_stream,
                clock: daily_at_5(),
            },
        )];
        queue
            .lock()
            .unwrap()
            .plan(wanted.into_iter().collect(), now);
        assert_eq!(
            queue.lock().unwrap().run_now(&key("zz"), now),
            Err(RunNow::NotQueued)
        );
        let run = queue
            .lock()
            .unwrap()
            .run_now(&key("a"), now)
            .expect("queued");
        assert_eq!(run, "2026-10-16T14:00:00Z");
        let later = now + Span::seconds(30);
        assert_eq!(
            queue.lock().unwrap().run_now(&key("a"), later),
            Ok(run.clone()),
            "one entry"
        );

        step(&queue, &fake, later).await;
        step(&queue, &fake, later).await;
        assert_eq!(
            fake.held(),
            ["a"],
            "the run went to the runner tonight's clock aside"
        );
        assert_eq!(
            queue.lock().unwrap().run_now(&key("a"), later),
            Err(RunNow::Running(run.clone()))
        );
        let started = fake.sent.lock().unwrap()["a"].clone();
        let mapping = started["input"]["generate"]["mapping"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(
            mapping.ends_with("meta jc_run = \"2026-10-16T14:00:00Z\""),
            "{mapping}"
        );
        assert!(!mapping.contains("now()"), "{mapping}");
    }

    #[tokio::test]
    async fn a_scheduled_pipeline_that_never_ran_runs_once_on_create_and_then_by_its_clock() {
        let queue = Mutex::new(RunQueue::new(2, 1));
        let fake = Fake::default();
        let now = at("2026-10-17T17:00:00Z");
        let wanted = || {
            [
                (key("fresh"), planned(daily_at_5())),
                (key("old"), planned(daily_at_5())),
            ]
            .into_iter()
            .collect::<BTreeMap<_, _>>()
        };
        {
            let mut q = queue.lock().unwrap();
            q.ran([key("old")].into_iter().collect());
            q.plan(wanted(), now);
        }
        step(&queue, &fake, now).await;
        assert_eq!(
            fake.held(),
            ["fresh"],
            "the one that ran before waits for 05:00"
        );
        fake.end("fresh", RunState::Finished);
        // Reconciler passes go on while the log has not caught up: still one run, not one each.
        for minutes in 1..4 {
            let later = now + Span::minutes(minutes);
            queue.lock().unwrap().plan(wanted(), later);
            step(&queue, &fake, later).await;
        }
        let starts: Vec<String> = fake
            .log()
            .into_iter()
            .filter(|l| l.starts_with("start"))
            .collect();
        assert_eq!(starts, ["start fresh"], "one run on create");
        assert!(fake.held().is_empty(), "{:?}", fake.held());
        let five = at("2026-10-18T05:00:00Z");
        queue.lock().unwrap().plan(wanted(), five);
        step(&queue, &fake, five).await;
        assert_eq!(
            fake.held(),
            ["fresh", "old"],
            "both by their clock from then on"
        );
    }

    #[tokio::test]
    async fn without_the_run_log_a_new_scheduled_pipeline_waits_for_its_clock() {
        let queue = Mutex::new(RunQueue::new(1, 1));
        let fake = Fake::default();
        let now = at("2026-10-17T17:00:00Z");
        queue.lock().unwrap().plan(
            [(key("a"), planned(daily_at_5()))].into_iter().collect(),
            now,
        );
        step(&queue, &fake, now).await;
        assert!(
            fake.held().is_empty(),
            "a restart without the log runs nothing early"
        );
    }

    #[test]
    fn one_run_fires_every_clock_once_and_a_feed_poll_becomes_one_tick() {
        let merged = serde_json::json!({"input": {"broker": {"inputs": [
            {"generate": {"interval": "0 5 * * *", "mapping": "root = \"\""}, "processors": [{"http": {}}]},
            {"file": {"paths": ["/x"]}},
        ]}}, "output": {"drop": {}}});
        let run = one_run(&merged);
        assert_eq!(run["input"]["broker"]["inputs"][0]["generate"]["count"], 1);
        assert_eq!(
            run["input"]["broker"]["inputs"][0]["generate"]["interval"],
            ""
        );
        assert_eq!(
            run["input"]["broker"]["inputs"][1],
            merged["input"]["broker"]["inputs"][1]
        );
        assert_eq!(run["output"], merged["output"]);

        let feed = serde_json::json!({"input": {
            "http_client": {"url": "https://feed/vp", "verb": "GET", "metadata": {"gtfs_feed": "vehicle_positions"}},
            "processors": [{"protobuf": {"operator": "to_json"}}],
        }});
        let run = one_run(&feed);
        let input = &run["input"];
        assert!(input.get("http_client").is_none());
        assert_eq!(input["generate"]["count"], 1);
        let mapping = input["generate"]["mapping"].as_str().unwrap();
        assert!(
            mapping.contains("meta gtfs_feed = \"vehicle_positions\"\n"),
            "{mapping}"
        );
        assert_eq!(
            input["processors"][0]["try"][0]["http"],
            serde_json::json!({"url": "https://feed/vp", "verb": "GET"})
        );
        assert_eq!(
            input["processors"][2]["protobuf"]["operator"], "to_json",
            "the feed's own decoding follows the read"
        );
    }
}
