//! The daily data-quality run (DM-74, API/01 §27).
//!
//! A write is checked when it happens (PL-59, DM-61); data written before its model changed, or
//! by a pipeline that stopped, is not. Once a day the leading replica reads every entity of every
//! space that names a model through the space surface, as its own client, holds each one to the
//! model the way a pipeline's validation stage does, and compares the age of the newest entity a
//! pipeline writes with the pipeline's freshness target. The result is held in memory per space;
//! a space whose read fails keeps its previous report.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use utoipa::ToSchema;

use crate::pipeline_validation::{ModelSchemas, Problem};
use crate::reconciler::drift::Watch;
use crate::store::{ListOptions, Mirror};

/// Entities one page reads, the gateway's own page size.
pub const PAGE: usize = 1_000;
/// Entities one run reads of one space at most: the run's resource budget.
pub const PER_SPACE: usize = 20_000;
/// How often a run is due.
pub const EVERY: chrono::Duration = chrono::Duration::hours(24);
/// How soon a run that failed is tried again.
const RETRY: chrono::Duration = chrono::Duration::hours(1);
/// Example ids kept per rule.
const EXAMPLES: usize = 5;
/// The least slack a freshness target allows past the interval, in seconds.
const MIN_SLACK: u64 = 600;
/// The pause between two pages, so a run never competes with the people reading a space.
const BETWEEN_PAGES: Duration = Duration::from_millis(100);

/// One failing rule of a space: a SHACL component and the path it is about.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct RuleCount {
    pub rule: String,
    pub path: String,
    pub count: u64,
    /// At most five ids of entities that break it.
    pub examples: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum FreshState {
    Fresh,
    Stale,
    Empty,
    Untargeted,
}

/// How recent the data of one pipeline is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Freshness {
    pub pipeline: String,
    /// The pipeline's output type; empty when it names none and the whole space counts.
    #[serde(rename = "type")]
    pub entity_type: String,
    #[schema(value_type = Option<String>, format = DateTime)]
    pub newest: Option<DateTime<Utc>>,
    pub target_seconds: Option<u64>,
    pub state: FreshState,
    pub paused: bool,
}

/// What one run found in one space.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SpaceQuality {
    #[schema(value_type = String, format = DateTime)]
    pub observed_at: DateTime<Utc>,
    pub checked: u64,
    pub invalid: u64,
    pub truncated: bool,
    pub rules: Vec<RuleCount>,
    pub freshness: Vec<Freshness>,
}

/// The count of one space's entities while a run reads them.
#[derive(Debug, Default)]
pub struct Tally {
    pub checked: u64,
    pub invalid: u64,
    pub truncated: bool,
    rules: BTreeMap<(String, String), (u64, Vec<String>)>,
    /// The newest `modifiedAt` per type.
    newest: BTreeMap<String, DateTime<Utc>>,
}

impl Tally {
    /// Counts one entity with what the model said of it, and its `modifiedAt`.
    pub fn add(&mut self, entity: &Value, modified: Option<DateTime<Utc>>, problems: &[Problem]) {
        self.checked += 1;
        if let (Some(kind), Some(at)) = (entity.get("type").and_then(Value::as_str), modified) {
            let newest = self.newest.entry(kind.to_owned()).or_insert(at);
            *newest = (*newest).max(at);
        }
        if problems.is_empty() {
            return;
        }
        self.invalid += 1;
        let id = entity.get("id").and_then(Value::as_str).unwrap_or_default();
        // One entity counts once per rule and path, however many values break it.
        let mut seen = std::collections::BTreeSet::new();
        for problem in problems {
            let key = (problem.rule.clone(), problem.path.clone());
            if !seen.insert(key.clone()) {
                continue;
            }
            let (count, examples) = self.rules.entry(key).or_default();
            *count += 1;
            if examples.len() < EXAMPLES && !id.is_empty() {
                examples.push(id.to_owned());
            }
        }
    }

    /// The newest entity of `entity_type`, or of the whole space when it is empty.
    pub fn newest(&self, entity_type: &str) -> Option<DateTime<Utc>> {
        match entity_type {
            "" => self.newest.values().max().copied(),
            kind => self.newest.get(kind).copied(),
        }
    }

    pub fn into_quality(
        self,
        observed_at: DateTime<Utc>,
        freshness: Vec<Freshness>,
    ) -> SpaceQuality {
        let mut rules: Vec<RuleCount> = self
            .rules
            .into_iter()
            .map(|((rule, path), (count, examples))| RuleCount {
                rule,
                path,
                count,
                examples,
            })
            .collect();
        // Most frequent first; ties by rule and path, so two runs list them alike.
        rules.sort_by(|a, b| {
            b.count
                .cmp(&a.count)
                .then_with(|| (&a.rule, &a.path).cmp(&(&b.rule, &b.path)))
        });
        SpaceQuality {
            observed_at,
            checked: self.checked,
            invalid: self.invalid,
            truncated: self.truncated,
            rules,
            freshness,
        }
    }
}

/// Takes the system attributes `options=sysAttrs` adds off an entity and its attributes, so the
/// model sees what was written, and answers the entity's `modifiedAt`.
pub fn strip_system(entity: &mut Value) -> Option<DateTime<Utc>> {
    let object = entity.as_object_mut()?;
    let modified = object
        .remove("modifiedAt")
        .and_then(|at| at.as_str().and_then(|at| at.parse().ok()));
    object.remove("createdAt");
    for value in object.values_mut() {
        let attributes: Vec<&mut Value> = match value {
            Value::Array(items) => items.iter_mut().collect(),
            other => vec![other],
        };
        for attribute in attributes {
            if let Some(attribute) = attribute.as_object_mut() {
                attribute.remove("createdAt");
                attribute.remove("modifiedAt");
            }
        }
    }
    modified
}

/// Seconds between two runs of a five-field cron `schedule`, or `None` for one this reading does
/// not understand. Lists and ranges count as their field's unit: `0 6,18 * * *` reads as daily,
/// which only makes the target looser, never a false alarm.
pub fn schedule_seconds(schedule: &str) -> Option<u64> {
    let fields: Vec<&str> = schedule.split_whitespace().collect();
    let [minute, hour, day, month, weekday] = fields.as_slice() else {
        return None;
    };
    let step = |field: &str| {
        field
            .strip_prefix("*/")
            .and_then(|n| n.parse::<u64>().ok())
            .filter(|n| *n > 0)
    };
    if [minute, hour]
        .iter()
        .any(|f| f.starts_with("*/") && step(f).is_none())
    {
        return None;
    }
    let every = if *minute == "*" {
        60
    } else if let Some(n) = step(minute) {
        if *hour != "*" {
            return None;
        }
        n * 60
    } else if *hour == "*" {
        3_600
    } else if let Some(n) = step(hour) {
        n * 3_600
    } else if *weekday != "*" {
        7 * 86_400
    } else if *day != "*" && *month != "*" {
        366 * 86_400
    } else if *day != "*" {
        31 * 86_400
    } else {
        86_400
    };
    Some(every)
}

/// The freshness target of a pipeline: its interval plus the larger of a twelfth of it and ten
/// minutes; `None` for a pipeline its source drives.
pub fn target_seconds(period: Option<u64>, schedule: Option<&str>) -> Option<u64> {
    let every = match (period, schedule) {
        (Some(seconds), _) if seconds > 0 => seconds,
        (_, Some(schedule)) => schedule_seconds(schedule)?,
        _ => return None,
    };
    Some(every + (every / 12).max(MIN_SLACK))
}

pub fn fresh_state(
    newest: Option<DateTime<Utc>>,
    target: Option<u64>,
    now: DateTime<Utc>,
) -> FreshState {
    match (newest, target) {
        (_, None) => FreshState::Untargeted,
        (None, Some(_)) => FreshState::Empty,
        (Some(at), Some(target)) if (now - at).num_seconds() > target as i64 => FreshState::Stale,
        (Some(_), Some(_)) => FreshState::Fresh,
    }
}

/// The last report of every space, and whether a run is under way.
#[derive(Debug, Default)]
pub struct Store {
    by_space: RwLock<BTreeMap<(String, String), SpaceQuality>>,
    running: AtomicBool,
    /// When the last run started; a failed run moves it back so the next try is an hour away.
    last_start: RwLock<Option<DateTime<Utc>>>,
}

impl Store {
    pub fn get(&self, project: &str, space: &str) -> Option<SpaceQuality> {
        self.by_space
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(&(project.to_owned(), space.to_owned()))
            .cloned()
    }

    fn put(&self, project: &str, space: &str, quality: SpaceQuality) {
        self.by_space
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .insert((project.to_owned(), space.to_owned()), quality);
    }

    /// Forgets the spaces that no longer name a model.
    fn keep_only(&self, spaces: &[(String, String)]) {
        self.by_space
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|key, _| spaces.contains(key));
    }

    /// Whether a run is due at `now`; when it is, this call claims it.
    pub fn claim(&self, now: DateTime<Utc>) -> bool {
        let mut last = self.last_start.write().unwrap_or_else(|e| e.into_inner());
        if last.is_some_and(|at| now - at < EVERY) {
            return false;
        }
        if self.running.swap(true, Ordering::AcqRel) {
            return false;
        }
        *last = Some(now);
        true
    }

    fn finish(&self, failed: bool) {
        if failed {
            let mut last = self.last_start.write().unwrap_or_else(|e| e.into_inner());
            *last = last.map(|at| at - EVERY + RETRY);
        }
        self.running.store(false, Ordering::Release);
    }
}

/// What a run reads with and where it leaves its reports.
pub struct Scanner {
    pub watch: Arc<Watch>,
    pub schemas: Arc<ModelSchemas>,
    pub mirror: Arc<Mirror>,
    pub org_domain: String,
    pub store: Arc<Store>,
}

impl Scanner {
    /// Starts a run in the background when one is due; the reconciler calls it on every sync of
    /// the leader and never waits for it.
    pub fn start_if_due(self: &Arc<Self>) {
        if !self.store.claim(Utc::now()) {
            return;
        }
        let scanner = Arc::clone(self);
        tokio::spawn(async move {
            let failed = match scanner.run().await {
                Ok(()) => false,
                Err(err) => {
                    tracing::warn!(error = %err, "the data-quality run did not complete");
                    true
                }
            };
            scanner.store.finish(failed);
        });
    }

    async fn run(&self) -> Result<(), String> {
        let spaces = self.schemas.spaces();
        let token = self.watch.scan_token().await?;
        for (project, space) in &spaces {
            match self.space(&token, project, space).await {
                Ok(quality) => self.store.put(project, space, quality),
                // One space that cannot be read keeps its last report; the others go on.
                Err(err) => tracing::warn!(project, space, error = %err, "a space was not checked"),
            }
        }
        self.store.keep_only(&spaces);
        Ok(())
    }

    async fn space(&self, token: &str, project: &str, space: &str) -> Result<SpaceQuality, String> {
        let schema = self
            .schemas
            .get(project, space)
            .ok_or_else(|| format!("{project}/{space} names no model any more"))?;
        let segment = crate::spaces::segment(&self.mirror, project, space);
        let mut tally = Tally::default();
        'classes: for class in schema.classes.keys() {
            let mut offset = 0;
            loop {
                let page = self.watch.page(token, space, class, offset, PAGE).await?;
                let full = page.len() == PAGE;
                for mut entity in page {
                    if tally.checked as usize >= PER_SPACE {
                        tally.truncated = true;
                        break 'classes;
                    }
                    let modified = strip_system(&mut entity);
                    let problems = schema.check(&entity, &self.org_domain, &segment);
                    tally.add(&entity, modified, &problems);
                }
                if !full {
                    break;
                }
                offset += PAGE;
                tokio::time::sleep(BETWEEN_PAGES).await;
            }
        }
        let now = Utc::now();
        let freshness = pipelines_into(&self.mirror, project, space)
            .into_iter()
            .map(|(pipeline, entity_type, target, paused)| {
                let newest = tally.newest(&entity_type);
                Freshness {
                    pipeline,
                    state: fresh_state(newest, target, now),
                    entity_type,
                    newest,
                    target_seconds: target,
                    paused,
                }
            })
            .collect();
        Ok(tally.into_quality(now, freshness))
    }
}

/// Every pipeline of `project` whose first output Endpoint writes into `space`: its name, output
/// type, freshness target and whether it is paused.
pub fn pipelines_into(
    mirror: &Mirror,
    project: &str,
    space: &str,
) -> Vec<(String, String, Option<u64>, bool)> {
    let mut rows: Vec<_> = mirror
        .list(project, "Pipeline", &ListOptions::default())
        .items
        .into_iter()
        .filter_map(|env| {
            let spec: jc_core::kinds::pipeline::PipelineSpec =
                serde_json::from_value(env.spec).ok()?;
            let output = spec.outputs().into_iter().next()?;
            let endpoint = mirror.get(project, "Endpoint", output.target_endpoint.local_id())?;
            let target_space = crate::api::assistant::ref_name(&endpoint.spec["contextSpaceRef"])?;
            (target_space == space).then(|| {
                (
                    env.metadata.name,
                    output.entity_type.unwrap_or_default(),
                    target_seconds(spec.period_seconds(), spec.schedule.as_deref()),
                    !spec.enabled,
                )
            })
        })
        .collect();
    rows.sort();
    rows
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn at(text: &str) -> DateTime<Utc> {
        text.parse().unwrap()
    }

    fn problem(rule: &str, path: &str) -> Problem {
        Problem {
            rule: rule.into(),
            path: path.into(),
            message: "m".into(),
        }
    }

    #[test]
    fn a_tally_counts_entities_once_per_rule_and_keeps_five_examples() {
        let mut tally = Tally::default();
        for n in 0..7 {
            let entity =
                json!({"id": format!("urn:ngsi-ld:Station:hel.fi:bikes:{n}"), "type": "Station"});
            let problems = [
                problem("sh:minCount", "name"),
                problem("sh:minCount", "name"),
                problem("sh:in", "status"),
            ];
            tally.add(
                &entity,
                Some(at("2026-09-25T01:00:00Z")),
                &problems[..if n < 2 { 3 } else { 1 }],
            );
        }
        tally.add(
            &json!({"id": "urn:ok", "type": "Station"}),
            Some(at("2026-09-25T02:00:00Z")),
            &[],
        );
        let quality = tally.into_quality(at("2026-09-25T03:00:00Z"), Vec::new());
        assert_eq!((quality.checked, quality.invalid), (8, 7));
        assert_eq!(quality.rules[0].rule, "sh:minCount");
        assert_eq!(
            quality.rules[0].count, 7,
            "a record breaking a rule twice counts once"
        );
        assert_eq!(quality.rules[0].examples.len(), 5);
        assert_eq!(
            (quality.rules[1].rule.as_str(), quality.rules[1].count),
            ("sh:in", 2)
        );
    }

    #[test]
    fn the_newest_entity_is_per_type_or_of_the_whole_space() {
        let mut tally = Tally::default();
        tally.add(
            &json!({"id": "a", "type": "A"}),
            Some(at("2026-09-25T01:00:00Z")),
            &[],
        );
        tally.add(
            &json!({"id": "b", "type": "B"}),
            Some(at("2026-09-25T02:00:00Z")),
            &[],
        );
        tally.add(
            &json!({"id": "c", "type": "A"}),
            Some(at("2026-09-24T01:00:00Z")),
            &[],
        );
        assert_eq!(tally.newest("A"), Some(at("2026-09-25T01:00:00Z")));
        assert_eq!(tally.newest(""), Some(at("2026-09-25T02:00:00Z")));
        assert_eq!(tally.newest("C"), None);
    }

    #[test]
    fn system_attributes_come_off_before_the_model_sees_the_entity() {
        let mut entity = json!({
            "id": "urn:x", "type": "A", "createdAt": "2026-09-01T00:00:00Z", "modifiedAt": "2026-09-25T01:00:00Z",
            "name": {"type": "Property", "value": "n", "createdAt": "x", "modifiedAt": "y"},
            "tags": [{"type": "Property", "value": 1, "modifiedAt": "y", "datasetId": "urn:d"}]
        });
        assert_eq!(strip_system(&mut entity), Some(at("2026-09-25T01:00:00Z")));
        assert_eq!(
            entity,
            json!({"id": "urn:x", "type": "A", "name": {"type": "Property", "value": "n"},
                   "tags": [{"type": "Property", "value": 1, "datasetId": "urn:d"}]})
        );
    }

    #[test]
    fn a_cron_schedule_reads_as_its_interval() {
        assert_eq!(schedule_seconds("*/5 * * * *"), Some(300));
        assert_eq!(schedule_seconds("* * * * *"), Some(60));
        assert_eq!(schedule_seconds("15 * * * *"), Some(3_600));
        assert_eq!(schedule_seconds("0 */6 * * *"), Some(21_600));
        assert_eq!(schedule_seconds("0 2 * * *"), Some(86_400));
        assert_eq!(schedule_seconds("0 2 * * 1"), Some(604_800));
        assert_eq!(schedule_seconds("0 2 1 * *"), Some(2_678_400));
        assert_eq!(schedule_seconds("@daily"), None);
        assert_eq!(schedule_seconds("*/5 2 * * *"), None);
        assert_eq!(schedule_seconds("*/0 * * * *"), None);
    }

    #[test]
    fn a_target_is_the_interval_and_its_slack() {
        // The owner's two examples: about ten minutes for a real-time feed, 26 h for a daily run.
        assert_eq!(target_seconds(Some(15), None), Some(615));
        assert_eq!(target_seconds(None, Some("0 2 * * *")), Some(93_600));
        assert_eq!(
            target_seconds(Some(300), Some("0 2 * * *")),
            Some(900),
            "the period wins"
        );
        assert_eq!(
            target_seconds(None, None),
            None,
            "a pipeline its source drives"
        );
        assert_eq!(target_seconds(None, Some("@hourly")), None);
    }

    #[test]
    fn data_is_fresh_stale_empty_or_untargeted() {
        let now = at("2026-09-25T03:00:00Z");
        assert_eq!(
            fresh_state(Some(at("2026-09-25T02:55:00Z")), Some(615), now),
            FreshState::Fresh
        );
        assert_eq!(
            fresh_state(Some(at("2026-09-25T02:40:00Z")), Some(615), now),
            FreshState::Stale
        );
        assert_eq!(fresh_state(None, Some(615), now), FreshState::Empty);
        assert_eq!(
            fresh_state(Some(at("2026-01-01T00:00:00Z")), None, now),
            FreshState::Untargeted
        );
    }

    #[test]
    fn a_run_is_claimed_once_a_day_and_retried_an_hour_after_a_failure() {
        let store = Store::default();
        let start = at("2026-09-25T02:00:00Z");
        assert!(store.claim(start));
        assert!(!store.claim(start), "one run at a time");
        store.finish(false);
        assert!(!store.claim(start + chrono::Duration::hours(23)));
        assert!(store.claim(start + chrono::Duration::hours(24)));
        store.finish(true);
        assert!(!store.claim(start + chrono::Duration::hours(24) + chrono::Duration::minutes(59)));
        assert!(store.claim(start + chrono::Duration::hours(25)));
    }
}
