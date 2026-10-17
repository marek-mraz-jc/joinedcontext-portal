//! The open-data catalogue as an NGSI-LD Endpoint (T-4500, ADR-N-025, EP-78).
//!
//! An agent's first call goes to the Endpoint named `catalog` on the space named `catalog`, where
//! it finds the dataset it needs with the ordinary NGSI-LD queries; its second call goes to that
//! dataset's own Endpoint. This wave writes that catalogue: one SDM DCAT-AP `Dataset` per context
//! space with a public Endpoint, one `DataService` per public Endpoint.
//!
//! Three rules, each from what goes wrong without it:
//!
//! - **One source.** Every attribute is read from the gateway's DCAT-AP feed (EP-84), which holds
//!   the record of every public Endpoint as the anonymous caller reads it, built by the same
//!   function as each Endpoint's own record. CKAN, a harvester and this catalogue cannot drift,
//!   and no private title, contact or count can reach it: the feed never held one.
//! - **Every write goes through an Endpoint and its Policy**, as the Portal's own client, the way
//!   the drift wave puts a seed entity back. The `catalog` Endpoint's Policy is what admits it.
//! - **Only a change is written.** A run compares with what the last run wrote and sends only the
//!   difference; after a restart, and once an hour, it lists what the catalogue holds instead of
//!   trusting its memory, so an entity a half-finished run left behind is still removed.

use super::drift::Watch;
use crate::resource::reference_name;
use jcctl::loader::Repository;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use unicode_normalization::UnicodeNormalization;

/// The name of the catalogue's Endpoint and of its space.
pub const CATALOG: &str = "catalog";
/// Entities per batch request.
const BATCH: usize = 100;
/// How long the memory of the last write is trusted before the catalogue is listed again.
const RELIST: Duration = Duration::from_secs(3600);

/// Where a public Endpoint's data lives, from the repository: what the feed does not say.
#[derive(Debug, Clone, PartialEq)]
pub struct Place {
    /// The Endpoint's project.
    pub project: String,
    /// The context space it serves.
    pub space: String,
    /// The space's `area` quality rule, `[minLon, minLat, maxLon, maxLat]` (DM-87).
    pub bbox: Option<[f64; 4]>,
}

/// What one run wrote.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Run {
    /// Entities created or replaced.
    pub upserted: usize,
    /// Entities removed.
    pub deleted: usize,
}

/// The catalogue wave of one Portal.
pub struct CatalogSync {
    watch: Arc<Watch>,
    /// What the last run left in the catalogue, by id, and when it was last listed.
    written: Mutex<Option<(Instant, BTreeMap<String, Value>)>>,
}

impl CatalogSync {
    /// A wave writing through the Portal's own client on the gateway `watch` speaks to.
    pub fn new(watch: Arc<Watch>) -> Self {
        Self {
            watch,
            written: Mutex::new(None),
        }
    }

    /// Brings the catalogue to the public Endpoints of `repo`. `Ok(None)` when the repository
    /// declares no catalogue Endpoint, which leaves this wave off.
    pub async fn converge(&self, repo: &Repository) -> Result<Option<Run>, String> {
        let Some(slug) = catalog_slug(repo)? else {
            return Ok(None);
        };
        let (http, base) = self.watch.surface();
        let feed: Value = http
            .get(format!("{base}/catalog.jsonld"))
            .header("Accept", "application/ld+json")
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|err| format!("the DCAT-AP feed did not read: {err}"))?
            .json()
            .await
            .map_err(|err| format!("the DCAT-AP feed is not JSON: {err}"))?;
        let wanted = entities(&feed, &places(repo));

        let token = self.watch.scan_token().await?;
        let surface = format!("{base}/api/endpoint/{slug}/ngsi-ld/v1");
        let remembered = self
            .written
            .lock()
            .map_err(|_| "the catalogue's memory is poisoned".to_owned())?
            .take()
            .filter(|(listed, _)| listed.elapsed() < RELIST);
        let (listed, known) = match remembered {
            Some(memory) => memory,
            None => (Instant::now(), listing(http, &surface, &token).await?),
        };

        let changed: Vec<&Value> = wanted
            .iter()
            .filter(|(id, entity)| known.get(*id) != Some(entity))
            .map(|(_, entity)| entity)
            .collect();
        let gone: Vec<&String> = known
            .keys()
            .filter(|id| !wanted.contains_key(*id))
            .collect();
        for batch in changed.chunks(BATCH) {
            post(http, &surface, "upsert", &token, &json!(batch)).await?;
        }
        for batch in gone.chunks(BATCH) {
            post(http, &surface, "delete", &token, &json!(batch)).await?;
        }
        let run = Run {
            upserted: changed.len(),
            deleted: gone.len(),
        };
        // Remembered only once every write landed: a failed run lists the catalogue again.
        if let Ok(mut written) = self.written.lock() {
            *written = Some((listed, wanted));
        }
        Ok(Some(run))
    }
}

/// The slug of the repository's catalogue Endpoint: the Endpoint named `catalog` on the space
/// named `catalog`. More than one is a repository that does not say where to write.
pub fn catalog_slug(repo: &Repository) -> Result<Option<String>, String> {
    let slugs: Vec<String> = repo
        .iter()
        .filter(|(id, _)| id.kind == "Endpoint" && id.name == CATALOG)
        .filter(|(_, resource)| {
            resource
                .manifest
                .spec
                .get("contextSpaceRef")
                .and_then(reference_name)
                == Some(CATALOG)
        })
        .filter_map(|(_, resource)| {
            resource
                .manifest
                .spec
                .get("slug")?
                .as_str()
                .map(str::to_owned)
        })
        .collect();
    match slugs.as_slice() {
        [] => Ok(None),
        [one] => Ok(Some(one.clone())),
        _ => Err(format!(
            "{} Endpoints are named `{CATALOG}` on a space `{CATALOG}`; the catalogue is written to none",
            slugs.len()
        )),
    }
}

/// Every public Endpoint's place by slug. The catalogue's own Endpoint is not a dataset.
pub fn places(repo: &Repository) -> BTreeMap<String, Place> {
    let mut areas: BTreeMap<(String, String), [f64; 4]> = BTreeMap::new();
    for (id, resource) in repo.iter() {
        if id.kind != "ContextSpace" {
            continue;
        }
        let rules = resource
            .manifest
            .spec
            .get("quality")
            .and_then(Value::as_array);
        let bbox = rules.into_iter().flatten().find_map(|rule| {
            if rule.get("kind").and_then(Value::as_str) != Some("area") {
                return None;
            }
            let corners: Vec<f64> = rule
                .get("bbox")?
                .as_array()?
                .iter()
                .filter_map(Value::as_f64)
                .collect();
            <[f64; 4]>::try_from(corners).ok()
        });
        if let Some(bbox) = bbox {
            let project = id.namespace.clone().unwrap_or_default();
            areas.insert((project, id.name.clone()), bbox);
        }
    }
    let mut places = BTreeMap::new();
    for (id, resource) in repo.iter() {
        let spec = &resource.manifest.spec;
        if id.kind != "Endpoint" || spec.get("audience").and_then(Value::as_str) != Some("public") {
            continue;
        }
        let (Some(slug), Some(space)) = (
            spec.get("slug").and_then(Value::as_str),
            spec.get("contextSpaceRef").and_then(reference_name),
        ) else {
            continue;
        };
        if id.name == CATALOG && space == CATALOG {
            continue;
        }
        let project = id.namespace.clone().unwrap_or_default();
        let bbox = areas.get(&(project.clone(), space.to_owned())).copied();
        places.insert(
            slug.to_owned(),
            Place {
                project,
                space: space.to_owned(),
                bbox,
            },
        );
    }
    places
}

/// The catalogue's entities by id, from the feed's records of the Endpoints in `places`.
pub fn entities(feed: &Value, places: &BTreeMap<String, Place>) -> BTreeMap<String, Value> {
    let included = feed.get("@included").and_then(Value::as_array);
    let included: Vec<&Value> = included.into_iter().flatten().collect();
    let services: BTreeMap<&str, &Value> = included
        .iter()
        .filter(|item| item.get("@type").and_then(Value::as_str) == Some("dcat:DataService"))
        .filter_map(|item| Some((item.get("@id")?.as_str()?, *item)))
        .collect();

    // The records by space, in slug order: the first one names the space's Dataset.
    let mut spaces: BTreeMap<(&str, &str), Vec<(&str, &Value)>> = BTreeMap::new();
    for record in &included {
        if record.get("@type").and_then(Value::as_str) != Some("dcat:Dataset") {
            continue;
        }
        let Some(slug) = record.get("dct:identifier").and_then(Value::as_str) else {
            continue;
        };
        if let Some(place) = places.get(slug) {
            spaces
                .entry((place.project.as_str(), place.space.as_str()))
                .or_default()
                .push((slug, *record));
        }
    }

    let mut out = BTreeMap::new();
    for ((project, space), mut records) in spaces {
        records.sort_by_key(|(slug, _)| *slug);
        let dataset_id = format!("urn:ngsi-ld:Dataset:{project}:{space}");
        let mut links = Vec::new();
        for (slug, record) in &records {
            let service = record
                .get("@id")
                .and_then(Value::as_str)
                .and_then(|id| services.get(format!("{id}#service").as_str()).copied());
            let entity = data_service(slug, record, service, &dataset_id);
            links.push(json!({
                "id": entity["id"],
                "identifier": slug,
                "endpointURL": entity.get("endpointURL").map(|url| url["value"].clone()),
            }));
            out.insert(entity["id"].as_str().unwrap_or_default().to_owned(), entity);
        }
        let first = records[0].1;
        let place = &places[records[0].0];
        let mut dataset = Map::new();
        dataset.insert("id".into(), json!(dataset_id));
        dataset.insert("type".into(), json!("Dataset"));
        languages(&mut dataset, "title", first.get("dct:title"));
        languages(&mut dataset, "description", first.get("dct:description"));
        let keywords = union(records.iter().map(|(_, r)| r.get("dcat:keyword")), text);
        let themes = union(records.iter().map(|(_, r)| r.get("dcat:theme")), iri);
        let spatial = union(records.iter().map(|(_, r)| r.get("dct:spatial")), iri);
        list(&mut dataset, "keyword", &keywords);
        list(&mut dataset, "theme", &themes);
        list(&mut dataset, "spatial", &spatial);
        if let Some([w, s, e, n]) = place.bbox {
            dataset.insert(
                "location".into(),
                json!({ "type": "GeoProperty", "value": {
                    "type": "Polygon",
                    "coordinates": [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
                }}),
            );
        }
        if let Some(temporal) = first.get("dct:temporal") {
            let period: Map<String, Value> =
                [("startDate", "dcat:startDate"), ("endDate", "dcat:endDate")]
                    .into_iter()
                    .filter_map(|(key, term)| {
                        Some((key.to_owned(), json!(text(temporal.get(term)?)?)))
                    })
                    .collect();
            if !period.is_empty() {
                dataset.insert("temporal".into(), property(Value::Object(period)));
            }
        }
        if let Some(frequency) = first.get("dct:accrualPeriodicity").and_then(iri) {
            dataset.insert("frequency".into(), property(json!(frequency)));
        }
        if let Some(publisher) = first.get("dct:publisher") {
            let mut value = Map::new();
            if let Some(id) = publisher.get("@id").and_then(Value::as_str) {
                value.insert("id".into(), json!(id));
            }
            if let Some(name) = language_map(publisher.get("foaf:name")) {
                value.insert("name".into(), Value::Object(name));
            }
            if !value.is_empty() {
                dataset.insert("publisher".into(), property(Value::Object(value)));
            }
        }
        dataset.insert("dataService".into(), property(Value::Array(links)));
        let mut words: Vec<String> = Vec::new();
        for (_, record) in &records {
            for term in ["dct:title", "dct:description"] {
                if let Some(map) = language_map(record.get(term)) {
                    words.extend(map.values().filter_map(Value::as_str).map(str::to_owned));
                }
            }
        }
        words.extend(keywords);
        words.push(space.to_owned());
        dataset.insert("searchText".into(), property(json!(fold(&words.join(" ")))));
        out.insert(dataset_id, Value::Object(dataset));
    }
    out
}

/// One public Endpoint as a `DataService`.
fn data_service(slug: &str, record: &Value, service: Option<&Value>, dataset: &str) -> Value {
    let mut entity = Map::new();
    entity.insert(
        "id".into(),
        json!(format!("urn:ngsi-ld:DataService:{slug}")),
    );
    entity.insert("type".into(), json!("DataService"));
    languages(&mut entity, "title", record.get("dct:title"));
    languages(&mut entity, "description", record.get("dct:description"));
    entity.insert("identifier".into(), property(json!(slug)));
    if let Some(url) = service
        .and_then(|s| s.get("dcat:endpointURL"))
        .and_then(iri)
    {
        entity.insert("endpointURL".into(), property(json!(url)));
    }
    let distributions: Vec<Value> = record
        .get("dcat:distribution")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|distribution| {
            let mut access = Map::new();
            access.insert(
                "accessURL".into(),
                json!(iri(distribution.get("dcat:accessURL")?)?),
            );
            for (key, term) in [
                ("conformsTo", "dct:conformsTo"),
                ("mediaType", "dcat:mediaType"),
            ] {
                if let Some(value) = distribution.get(term).and_then(iri) {
                    access.insert(key.into(), json!(value));
                }
            }
            Some(Value::Object(access))
        })
        .collect();
    if !distributions.is_empty() {
        entity.insert("accessURL".into(), property(Value::Array(distributions)));
    }
    for (key, term) in [
        ("accessRights", "dct:accessRights"),
        ("license", "dct:license"),
    ] {
        if let Some(value) = record.get(term).and_then(iri) {
            entity.insert(key.into(), property(json!(value)));
        }
    }
    entity.insert(
        "servesDataset".into(),
        json!({ "type": "Relationship", "object": dataset }),
    );
    Value::Object(entity)
}

fn property(value: Value) -> Value {
    json!({ "type": "Property", "value": value })
}

/// A JSON-LD language-tagged value or list of them as a language map; a plain string is English.
fn language_map(value: Option<&Value>) -> Option<Map<String, Value>> {
    let mut map = Map::new();
    let values: Vec<&Value> = match value? {
        Value::Array(items) => items.iter().collect(),
        other => vec![other],
    };
    for item in values {
        match item {
            Value::String(text) => {
                map.entry("en").or_insert_with(|| json!(text));
            }
            Value::Object(tagged) => {
                if let (Some(language), Some(text)) = (
                    tagged.get("@language").and_then(Value::as_str),
                    tagged.get("@value").and_then(Value::as_str),
                ) {
                    map.entry(language).or_insert_with(|| json!(text));
                }
            }
            _ => {}
        }
    }
    (!map.is_empty()).then_some(map)
}

fn languages(entity: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(map) = language_map(value) {
        entity.insert(
            key.into(),
            json!({ "type": "LanguageProperty", "languageMap": map }),
        );
    }
}

fn list(entity: &mut Map<String, Value>, key: &str, values: &[String]) {
    if !values.is_empty() {
        entity.insert(key.into(), property(json!(values)));
    }
}

/// The text of a literal: a string or a JSON-LD `@value`.
fn text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Object(literal) => literal.get("@value")?.as_str().map(str::to_owned),
        _ => None,
    }
}

/// An IRI: a string or a node with an `@id`.
fn iri(value: &Value) -> Option<String> {
    match value {
        Value::String(iri) => Some(iri.clone()),
        Value::Object(node) => node.get("@id")?.as_str().map(str::to_owned),
        _ => None,
    }
}

/// Every value of every term, once each, in the order first seen.
fn union<'a>(
    terms: impl Iterator<Item = Option<&'a Value>>,
    read: fn(&Value) -> Option<String>,
) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for term in terms.flatten() {
        let items: Vec<&Value> = match term {
            Value::Array(items) => items.iter().collect(),
            other => vec![other],
        };
        for value in items.into_iter().filter_map(read) {
            if seen.insert(value.clone()) {
                out.push(value);
            }
        }
    }
    out
}

/// Lowercase with the diacritics removed, so `q=searchText~=(?i).*bystrica.*` finds `Bystrici`
/// and `bystrica` finds `Bystrica` whatever the caller typed.
pub fn fold(text: &str) -> String {
    text.nfd()
        .filter(|c| !unicode_normalization::char::is_combining_mark(*c))
        .collect::<String>()
        .to_lowercase()
}

/// What the catalogue holds now, by id; the values are unknown, so every entity is written once.
async fn listing(
    http: &reqwest::Client,
    surface: &str,
    token: &str,
) -> Result<BTreeMap<String, Value>, String> {
    let mut held = BTreeMap::new();
    let mut offset = 0usize;
    loop {
        let page: Vec<Value> = http
            .get(format!("{surface}/entities"))
            .query(&[
                ("type", "Dataset,DataService"),
                ("options", "keyValues"),
                ("limit", "1000"),
                ("offset", &offset.to_string()),
            ])
            .bearer_auth(token)
            .header("Accept", "application/json")
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|err| format!("the catalogue did not list: {err}"))?
            .json()
            .await
            .map_err(|err| format!("the catalogue's listing is not JSON: {err}"))?;
        if page.is_empty() {
            return Ok(held);
        }
        offset += page.len();
        for entity in page {
            if let Some(id) = entity.get("id").and_then(Value::as_str) {
                held.insert(id.to_owned(), Value::Null);
            }
        }
    }
}

/// One batch operation; a multi-status answer is a failure, with the count of what failed.
async fn post(
    http: &reqwest::Client,
    surface: &str,
    operation: &str,
    token: &str,
    body: &Value,
) -> Result<(), String> {
    let response = http
        .post(format!("{surface}/entityOperations/{operation}"))
        .bearer_auth(token)
        .json(body)
        .send()
        .await
        .map_err(|err| format!("the catalogue {operation} did not reach the gateway: {err}"))?;
    let status = response.status();
    if status == reqwest::StatusCode::MULTI_STATUS {
        let answer: Value = response.json().await.unwrap_or_default();
        let failed = answer
            .get("errors")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        return Err(format!(
            "the catalogue {operation} failed for {failed} entities"
        ));
    }
    if !status.is_success() {
        return Err(format!("the catalogue refused the {operation}: {status}"));
    }
    Ok(())
}
