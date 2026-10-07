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
#[derive(Debug, Clone, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SpaceQuality {
    #[schema(value_type = String, format = DateTime)]
    pub observed_at: DateTime<Utc>,
    pub checked: u64,
    pub invalid: u64,
    pub truncated: bool,
    pub rules: Vec<RuleCount>,
    pub freshness: Vec<Freshness>,
    /// Per entity type: how complete each attribute is, the newest change, numeric ranges and
    /// outliers (T-3252).
    pub types: Vec<TypeQuality>,
}

/// What one run found of one entity type.
#[derive(Debug, Clone, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TypeQuality {
    #[serde(rename = "type")]
    pub entity_type: String,
    pub count: u64,
    #[schema(value_type = Option<String>, format = DateTime)]
    pub newest: Option<DateTime<Utc>>,
    /// Every attribute an entity of the type carries, the most complete first.
    pub attributes: Vec<AttributeQuality>,
}

/// One attribute of one type: how many entities carry it and, for numbers, their range and the
/// values far outside the rest.
#[derive(Debug, Clone, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AttributeQuality {
    pub name: String,
    /// Entities of the type that carry the attribute.
    pub present: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    /// Values outside the Tukey fences (1.5 interquartile ranges past the quartiles).
    pub outliers: u64,
    /// At most five ids of entities holding such a value.
    pub outlier_examples: Vec<String>,
}

/// What a run keeps of one type while it reads it: ids by position, so a number keeps a `u32`.
#[derive(Debug, Default)]
struct TypeTally {
    ids: Vec<String>,
    present: BTreeMap<String, u64>,
    numbers: BTreeMap<String, Vec<(f64, u32)>>,
}

/// The fewest numbers an attribute needs before a value is called an outlier.
const OUTLIER_FROM: usize = 8;

/// The count of one space's entities while a run reads them.
#[derive(Debug, Default)]
pub struct Tally {
    pub checked: u64,
    pub invalid: u64,
    pub truncated: bool,
    rules: BTreeMap<(String, String), (u64, Vec<String>)>,
    /// The newest `modifiedAt` per type.
    newest: BTreeMap<String, DateTime<Utc>>,
    types: BTreeMap<String, TypeTally>,
}

/// The number an attribute holds: a Property's numeric `value`, the first of several instances.
fn number_of(attribute: &Value) -> Option<f64> {
    let first = match attribute {
        Value::Array(items) => items.first()?,
        other => other,
    };
    first
        .get("value")
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite())
}

impl Tally {
    /// Counts one entity with what the model said of it, and its `modifiedAt`.
    pub fn add(&mut self, entity: &Value, modified: Option<DateTime<Utc>>, problems: &[Problem]) {
        self.checked += 1;
        if let (Some(kind), Some(at)) = (entity.get("type").and_then(Value::as_str), modified) {
            let newest = self.newest.entry(kind.to_owned()).or_insert(at);
            *newest = (*newest).max(at);
        }
        if let (Some(kind), Some(object)) = (
            entity.get("type").and_then(Value::as_str),
            entity.as_object(),
        ) {
            let tally = self.types.entry(kind.to_owned()).or_default();
            let at = u32::try_from(tally.ids.len()).unwrap_or(u32::MAX);
            tally.ids.push(
                entity
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            );
            for (name, attribute) in object {
                if matches!(name.as_str(), "id" | "type" | "@context") || attribute.is_null() {
                    continue;
                }
                *tally.present.entry(name.clone()).or_default() += 1;
                if let Some(number) = number_of(attribute) {
                    tally
                        .numbers
                        .entry(name.clone())
                        .or_default()
                        .push((number, at));
                }
            }
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
        let types = self
            .types
            .into_iter()
            .map(|(entity_type, tally)| {
                let newest = self.newest.get(&entity_type).copied();
                type_quality(entity_type, newest, tally)
            })
            .collect();
        SpaceQuality {
            observed_at,
            checked: self.checked,
            invalid: self.invalid,
            truncated: self.truncated,
            rules,
            freshness,
            types,
        }
    }
}

/// One type's report from what the run kept of it.
fn type_quality(
    entity_type: String,
    newest: Option<DateTime<Utc>>,
    tally: TypeTally,
) -> TypeQuality {
    let TypeTally {
        ids,
        present,
        mut numbers,
    } = tally;
    let mut attributes: Vec<AttributeQuality> = present
        .into_iter()
        .map(|(name, present)| {
            let mut values = numbers.remove(&name).unwrap_or_default();
            values.sort_by(|a, b| a.0.total_cmp(&b.0));
            let (outliers, outlier_examples) = outliers_of(&values, &ids);
            AttributeQuality {
                min: values.first().map(|v| v.0),
                max: values.last().map(|v| v.0),
                name,
                present,
                outliers,
                outlier_examples,
            }
        })
        .collect();
    attributes.sort_by(|a, b| b.present.cmp(&a.present).then_with(|| a.name.cmp(&b.name)));
    TypeQuality {
        entity_type,
        count: ids.len() as u64,
        newest,
        attributes,
    }
}

/// The values of `sorted` outside the Tukey fences, and up to five ids holding them; nothing
/// below [`OUTLIER_FROM`] values, where quartiles say nothing.
fn outliers_of(sorted: &[(f64, u32)], ids: &[String]) -> (u64, Vec<String>) {
    if sorted.len() < OUTLIER_FROM {
        return (0, Vec::new());
    }
    let quartile = |q: f64| {
        let at = q * (sorted.len() - 1) as f64;
        let (low, high) = (at.floor() as usize, at.ceil() as usize);
        sorted[low].0 + (sorted[high].0 - sorted[low].0) * (at - low as f64)
    };
    let (q1, q3) = (quartile(0.25), quartile(0.75));
    let fence = 1.5 * (q3 - q1);
    let outside: Vec<&(f64, u32)> = sorted
        .iter()
        .filter(|(value, _)| *value < q1 - fence || *value > q3 + fence)
        .collect();
    let examples = outside
        .iter()
        .filter_map(|(_, at)| ids.get(*at as usize))
        .filter(|id| !id.is_empty())
        .take(EXAMPLES)
        .cloned()
        .collect();
    (outside.len() as u64, examples)
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
                    let problems = schema.check(&entity);
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

    // T-3252: per type, how many entities carry each attribute, the numeric range, and the one
    // value far outside the rest named by its entity.
    #[test]
    fn a_tally_reports_completeness_ranges_and_outliers_per_type() {
        let mut tally = Tally::default();
        for n in 0..10 {
            let capacity = if n == 7 { 400 } else { 10 + n };
            let mut station = json!({
                "id": format!("urn:ngsi-ld:Station:hel.fi:bikes:{n}"),
                "type": "Station",
                "capacity": { "type": "Property", "value": capacity },
            });
            if n % 2 == 0 {
                station["name"] = json!({ "type": "Property", "value": format!("S{n}") });
            }
            tally.add(&station, Some(at("2026-10-07T08:00:00Z")), &[]);
        }
        tally.add(
            &json!({ "id": "urn:ngsi-ld:Street:hel.fi:bikes:a", "type": "Street" }),
            None,
            &[],
        );
        let quality = tally.into_quality(at("2026-10-07T09:00:00Z"), Vec::new());

        let station = quality
            .types
            .iter()
            .find(|kind| kind.entity_type == "Station")
            .unwrap();
        assert_eq!(station.count, 10);
        assert_eq!(station.newest, Some(at("2026-10-07T08:00:00Z")));
        let names: Vec<(&str, u64)> = station
            .attributes
            .iter()
            .map(|a| (a.name.as_str(), a.present))
            .collect();
        assert_eq!(names, vec![("capacity", 10), ("name", 5)]);
        let capacity = &station.attributes[0];
        assert_eq!((capacity.min, capacity.max), (Some(10.0), Some(400.0)));
        assert_eq!(capacity.outliers, 1);
        assert_eq!(
            capacity.outlier_examples,
            vec!["urn:ngsi-ld:Station:hel.fi:bikes:7".to_owned()]
        );
        let name = &station.attributes[1];
        assert_eq!((name.min, name.outliers), (None, 0));

        let street = quality
            .types
            .iter()
            .find(|kind| kind.entity_type == "Street")
            .unwrap();
        assert_eq!((street.count, street.attributes.len()), (1, 0));
    }

    #[test]
    fn too_few_numbers_call_nothing_an_outlier() {
        let values: Vec<(f64, u32)> = vec![(1.0, 0), (2.0, 1), (1000.0, 2)];
        assert_eq!(
            outliers_of(&values, &["a".into(), "b".into(), "c".into()]),
            (0, Vec::new())
        );
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
