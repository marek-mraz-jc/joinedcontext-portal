//! A copy of `jc_core::ngsi_catalog` (platform, T-4503) until the Portal's platform pin
//! reaches it (T-4527): the one function both catalogues are built by. Edit it there, not here;
//! T-4527 deletes this file. Its tests are the platform's.

use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use unicode_normalization::UnicodeNormalization;

/// What a record does not say about its Endpoint, from whoever holds the Endpoint table.
#[derive(Debug, Clone, PartialEq)]
pub struct Place {
    /// The `{space}` segment of the Endpoint's context space: its `Dataset` is
    /// `urn:ngsi-ld:Dataset:{space}`.
    pub space: String,
    /// The space's `area` quality rule, `[minLon, minLat, maxLon, maxLat]` (DM-87).
    pub bbox: Option<[f64; 4]>,
    /// The Endpoint's audience: `public`, `organization` or `project-list`.
    pub access_level: String,
    /// Why the caller sees it: `public`, `organization`, `project` or `grant`.
    pub visible_because: String,
}

impl Place {
    /// A public Endpoint as the anonymous caller sees it.
    pub fn public(space: impl Into<String>, bbox: Option<[f64; 4]>) -> Self {
        Self {
            space: space.into(),
            bbox,
            access_level: "public".to_owned(),
            visible_because: "public".to_owned(),
        }
    }
}

/// The catalogue's entities by id, from the JSON-LD nodes of a catalogue (a feed's
/// `@included`): every `dcat:Dataset` record whose `dct:identifier` is a slug in `places`, with
/// the `dcat:DataService` beside it.
pub fn entities(nodes: &[Value], places: &BTreeMap<String, Place>) -> BTreeMap<String, Value> {
    let services: BTreeMap<&str, &Value> = nodes
        .iter()
        .filter(|node| node.get("@type").and_then(Value::as_str) == Some("dcat:DataService"))
        .filter_map(|node| Some((node.get("@id")?.as_str()?, node)))
        .collect();

    // The records by space, in slug order: the first one names the space's Dataset.
    let mut spaces: BTreeMap<&str, Vec<(&str, &Value)>> = BTreeMap::new();
    for record in nodes {
        if record.get("@type").and_then(Value::as_str) != Some("dcat:Dataset") {
            continue;
        }
        let Some(slug) = record.get("dct:identifier").and_then(Value::as_str) else {
            continue;
        };
        if let Some(place) = places.get(slug) {
            spaces
                .entry(place.space.as_str())
                .or_default()
                .push((slug, record));
        }
    }

    let mut out = BTreeMap::new();
    for (space, mut records) in spaces {
        records.sort_by_key(|(slug, _)| *slug);
        let dataset_id = format!("urn:ngsi-ld:Dataset:{space}");
        let mut links = Vec::new();
        let mut bbox = None;
        for (slug, record) in &records {
            let place = &places[*slug];
            bbox = bbox.or(place.bbox);
            let service = record
                .get("@id")
                .and_then(Value::as_str)
                .and_then(|id| services.get(format!("{id}#service").as_str()).copied());
            let (id, entity) = data_service(slug, record, service, place, &dataset_id);
            links.push(json!({
                "id": id,
                "identifier": slug,
                "endpointURL": entity.get("endpointURL").map(|url| url["value"].clone()),
            }));
            out.insert(id, entity);
        }
        let first = records[0].1;
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
        if let Some([w, s, e, n]) = bbox {
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

/// One Endpoint as a `DataService`, and its id.
fn data_service(
    slug: &str,
    record: &Value,
    service: Option<&Value>,
    place: &Place,
    dataset: &str,
) -> (String, Value) {
    let id = format!("urn:ngsi-ld:DataService:{slug}");
    let mut entity = Map::new();
    entity.insert("id".into(), json!(id));
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
    // The access paths, not the schema artifacts: those are the Endpoint's own to list, and
    // reading them costs a broker hop the hub does not make per caller.
    let distributions: Vec<Value> = record
        .get("dcat:distribution")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|distribution| {
            let url = iri(distribution.get("dcat:accessURL")?)?;
            if url.contains("/schema/") {
                return None;
            }
            let mut access = Map::new();
            access.insert("accessURL".into(), json!(url));
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
    entity.insert("accessLevel".into(), property(json!(place.access_level)));
    entity.insert(
        "visibleBecause".into(),
        property(json!(place.visible_because)),
    );
    entity.insert(
        "servesDataset".into(),
        json!({ "type": "Relationship", "object": dataset }),
    );
    (id, Value::Object(entity))
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

/// Lowercase with the diacritics removed, so `q=searchText~=(?i).*bystrica.*` finds
/// `Bystrici` and `zilina` finds `Žilina` whatever the caller typed.
pub fn fold(text: &str) -> String {
    text.nfd()
        .filter(|c| !unicode_normalization::char::is_combining_mark(*c))
        .collect::<String>()
        .to_lowercase()
}
