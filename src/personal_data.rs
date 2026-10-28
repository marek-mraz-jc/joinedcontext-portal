//! Personal data in a connector's answers (T-5976, AG-158, DM-122): an AI client copies what a
//! connector answers into a third-party model, so the attributes a project's models mark
//! `personalData` leave every answer unless the connector's scope ticks them.
//!
//! The marks are the ones the publish form and the erasure read (Architecture/11 §9): a slot, a
//! class's `slot_usage` or `attributes` entry annotated `personalData: true`, or a whole class.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use crate::api::catalogue_draft::{attributes, Withheld};
use crate::state::AppState;

/// Entity type -> the attributes its model marks personal.
pub type Marks = BTreeMap<String, BTreeSet<String>>;

/// The personal attributes of every class of one LinkML model.
pub fn marks(linkml: &str) -> Marks {
    let model = serde_norway::from_str::<serde_norway::Value>(linkml).unwrap_or_default();
    let classes: Vec<String> = model["classes"]
        .as_mapping()
        .into_iter()
        .flatten()
        .filter_map(|(name, _)| name.as_str().map(str::to_owned))
        .collect();
    let mut out = Marks::new();
    for attr in attributes(linkml, &classes, &[]) {
        if attr.withheld == Some(Withheld::Personal) {
            out.entry(attr.type_name).or_default().insert(attr.name);
        }
    }
    out
}

/// The marks of every DataModel of `project`. A model the Portal cannot read is an `Err`
/// naming it: without its marks nothing personal could be withheld, so the caller refuses.
// ponytail: reads each model from the forge per answer that carries entities; cache by etag
// when query_data makes such answers frequent (T-5978 measures).
pub async fn of_project(state: &AppState, project: &str) -> Result<Marks, String> {
    let mut names: Vec<String> = state
        .mirror
        .matching(|env| {
            env.kind == "DataModel" && env.metadata.namespace.as_deref() == Some(project)
        })
        .into_iter()
        .map(|env| env.metadata.name)
        .collect();
    names.sort();
    let mut out = Marks::new();
    for name in names {
        let linkml = crate::api::datamodels::read_source(state, project, &name)
            .await
            .map_err(|_| format!("the data model {name} of project {project} could not be read, so its personal attributes cannot be withheld; try again in a minute"))?;
        for (class, attrs) in marks(&linkml) {
            out.entry(class).or_default().extend(attrs);
        }
    }
    Ok(out)
}

/// `Type`, `ex:Type` or `https://…/Type` as the model's class name.
fn short(term: &str) -> &str {
    let tail = term.rsplit(['/', '#']).next().unwrap_or(term);
    tail.rsplit(':').next().unwrap_or(tail)
}

fn types_of(entity: &serde_json::Map<String, Value>) -> Vec<&str> {
    match entity.get("type") {
        Some(Value::String(t)) => vec![short(t)],
        Some(Value::Array(ts)) => ts.iter().filter_map(Value::as_str).map(short).collect(),
        _ => Vec::new(),
    }
}

/// An NGSI-LD entity in any format: a string `id` and a `type`.
fn is_entity(node: &serde_json::Map<String, Value>) -> bool {
    node.get("id").is_some_and(Value::is_string) && !types_of(node).is_empty()
}

/// Whether `value` holds an entity anywhere: only such an answer needs the models read.
pub fn carries_entities(value: &Value) -> bool {
    match value {
        Value::Object(node) => is_entity(node) || node.values().any(carries_entities),
        Value::Array(items) => items.iter().any(carries_entities),
        _ => false,
    }
}

/// Removes from every entity in `value` the attributes `marks` names for its types, and
/// returns each one removed as `Type.attribute`, sorted, once each. Values are never returned.
pub fn withhold(value: &mut Value, marks: &Marks) -> Vec<String> {
    let mut removed = BTreeSet::new();
    walk(value, marks, &mut removed);
    removed.into_iter().collect()
}

fn walk(value: &mut Value, marks: &Marks, removed: &mut BTreeSet<String>) {
    match value {
        Value::Object(node) => {
            if is_entity(node) {
                let personal: Vec<(String, String)> = types_of(node)
                    .into_iter()
                    .filter_map(|t| marks.get(t).map(|attrs| (t, attrs)))
                    .flat_map(|(t, attrs)| {
                        node.keys()
                            .filter(|key| attrs.contains(short(key)))
                            .map(move |key| (t.to_owned(), key.clone()))
                    })
                    .collect();
                for (t, key) in personal {
                    if node.remove(&key).is_some() {
                        removed.insert(format!("{t}.{}", short(&key)));
                    }
                }
            }
            node.values_mut().for_each(|v| walk(v, marks, removed));
        }
        Value::Array(items) => items.iter_mut().for_each(|v| walk(v, marks, removed)),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const MODEL: &str = r#"
classes:
  PotholeReport:
    slots: [id, type, description, contactEmail, reporterName]
    slot_usage:
      reporterName:
        annotations: { personalData: { tag: personalData, value: "true" } }
  Citizen:
    annotations: { personalData: true }
    attributes:
      phone: {}
slots:
  contactEmail:
    annotations: { personalData: true }
"#;

    #[test]
    fn marks_name_the_slot_the_usage_and_the_whole_class() {
        let marks = marks(MODEL);
        assert_eq!(
            marks["PotholeReport"],
            BTreeSet::from(["contactEmail".to_owned(), "reporterName".to_owned()])
        );
        assert_eq!(marks["Citizen"], BTreeSet::from(["phone".to_owned()]));
        assert!(super::marks("not: [yaml").is_empty());
    }

    #[test]
    fn personal_attributes_leave_every_entity_in_any_format_and_the_rest_stays() {
        let marks = marks(MODEL);
        let mut answer = json!({
            "entities": [
                {
                    "id": "urn:ngsi-ld:PotholeReport:1",
                    "type": "PotholeReport",
                    "description": { "type": "Property", "value": "Hlboká jama" },
                    "contactEmail": { "type": "Property", "value": "jana@example.org" },
                    "https://smartdatamodels.org/reporterName": "Jana"
                },
                { "id": "urn:ngsi-ld:Citizen:2", "type": ["ex:Citizen"], "phone": "+421900000000" },
                { "id": "urn:ngsi-ld:Other:3", "type": "Other", "contactEmail": "kept@example.org" }
            ],
            "contactEmail": "not an entity, kept"
        });
        let removed = withhold(&mut answer, &marks);
        assert_eq!(
            removed,
            vec![
                "Citizen.phone",
                "PotholeReport.contactEmail",
                "PotholeReport.reporterName"
            ]
        );
        let text = answer.to_string();
        assert!(!text.contains("jana@example.org"), "{text}");
        assert!(!text.contains("+421900000000"), "{text}");
        assert!(!text.contains("\"Jana\""), "{text}");
        assert!(text.contains("Hlboká jama"), "{text}");
        assert!(text.contains("kept@example.org"), "{text}");
        assert!(text.contains("not an entity, kept"), "{text}");
    }

    #[test]
    fn only_an_answer_with_an_entity_needs_the_models() {
        assert!(carries_entities(
            &json!({"entity": {"id": "urn:x", "type": "T"}})
        ));
        assert!(!carries_entities(
            &json!({"items": [{"kind": "Endpoint", "name": "x"}]})
        ));
        assert!(!carries_entities(&json!({"id": "urn:x", "type": 3})));
    }
}
