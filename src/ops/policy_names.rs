//! A Policy's attribute lists against its space's data model (T-6283).
//!
//! `information[].propertyNames` and `relationshipNames` narrow a grant to the Attributes they
//! name. A name the model does not define narrows the grant to nothing a broker ever stores, so a
//! steward's typo grants less than meant and still plans green. The dry run reads the space's
//! LinkML source and names each such entry as an error on its field. A class the model's own
//! source does not hold whole (an imported class, or one whose `is_a` or mixin is imported) is
//! not judged here: Model Tools resolves imports, and a guess would refuse a valid Policy.

use std::collections::BTreeSet;

use serde_json::Value;

use super::verdict::{Finding, Level};
use crate::state::AppState;

/// The NGSI-LD core GeoProperties every Entity may carry, whatever its class lists.
const CORE: [&str; 3] = ["location", "observationSpace", "operationSpace"];

/// One error finding per attribute name of `manifest` (a Policy of `project`) that its space's
/// model does not define for any type of the same `information` entry. Empty for another kind, or
/// when the space, its model or the model's source cannot be read.
pub async fn findings(state: &AppState, project: &str, manifest: &Value) -> Vec<Finding> {
    if manifest["kind"].as_str() != Some("Policy") || !has_names(&manifest["spec"]) {
        return Vec::new();
    }
    match space_model(state, project, &manifest["spec"]).await {
        Some((model, linkml)) => unknown_names(&manifest["spec"], &linkml, &model),
        None => Vec::new(),
    }
}

/// The name and parsed LinkML source of the DataModel the spec's space names.
async fn space_model(
    state: &AppState,
    project: &str,
    spec: &Value,
) -> Option<(String, serde_norway::Value)> {
    let space = crate::resource::reference_name(&spec["contextSpaceRef"])?;
    let space = state.mirror.get(project, "ContextSpace", space)?;
    let reference = &space.spec["dataModelRef"];
    let namespace = reference["namespace"].as_str().unwrap_or(project);
    let model = crate::resource::reference_name(reference)?;
    let linkml = crate::api::datamodels::read_source(state, namespace, model)
        .await
        .ok()?;
    Some((model.to_owned(), serde_norway::from_str(&linkml).ok()?))
}

/// Whether the spec or one of its rules lists an attribute name.
fn has_names(spec: &Value) -> bool {
    entries(spec).any(|(_, info)| {
        ["propertyNames", "relationshipNames"].iter().any(|list| {
            info[*list]
                .as_array()
                .is_some_and(|names| !names.is_empty())
        })
    })
}

/// Every `information` entry with its field path: the spec's own, then each rule's.
fn entries(spec: &Value) -> impl Iterator<Item = (String, &Value)> {
    let own = std::iter::once(("spec".to_owned(), spec));
    let rules = spec["rules"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(n, rule)| (format!("spec.rules.{n}"), rule));
    own.chain(rules).flat_map(|(at, holder)| {
        holder["information"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
            .map(move |(n, info)| (format!("{at}.information.{n}"), info))
    })
}

/// The findings for `spec` against the parsed LinkML `linkml` of the DataModel `model`.
fn unknown_names(spec: &Value, linkml: &serde_norway::Value, model: &str) -> Vec<Finding> {
    let mut out = Vec::new();
    for (at, info) in entries(spec) {
        let types: Vec<&str> = info["entities"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|selector| selector["type"].as_str())
            .collect();
        let mut known: BTreeSet<String> = CORE.iter().map(|name| (*name).to_owned()).collect();
        let mut judged = !types.is_empty();
        for entity_type in &types {
            match class_slots(linkml, entity_type) {
                Some(slots) => known.extend(slots),
                None => judged = false,
            }
        }
        if !judged {
            continue;
        }
        for list in ["propertyNames", "relationshipNames"] {
            for (n, name) in info[list].as_array().into_iter().flatten().enumerate() {
                let Some(name) = name.as_str() else { continue };
                // An expanded or compact IRI is no slot name to look up.
                if name.contains(':') || known.contains(name) {
                    continue;
                }
                out.push(Finding {
                    level: Level::Error,
                    path: format!("{at}.{list}.{n}"),
                    message: format!(
                        "'{name}' is no Attribute of {} in the DataModel {model}; name one of: {}",
                        types.join(", "),
                        known.iter().cloned().collect::<Vec<_>>().join(", ")
                    ),
                });
            }
        }
    }
    out
}

/// The slots and inline attributes of `class` and of every class it reaches by `is_a` and
/// `mixins`, all in this source; `None` when one of them is not defined here (imported).
fn class_slots(linkml: &serde_norway::Value, class: &str) -> Option<BTreeSet<String>> {
    let names = |value: Option<&serde_norway::Value>| -> Vec<String> {
        match value {
            Some(serde_norway::Value::Sequence(items)) => items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect(),
            Some(serde_norway::Value::Mapping(entries)) => entries
                .keys()
                .filter_map(|key| key.as_str().map(str::to_owned))
                .collect(),
            Some(serde_norway::Value::String(one)) => vec![one.clone()],
            _ => Vec::new(),
        }
    };
    let mut slots = BTreeSet::new();
    let mut seen = BTreeSet::new();
    let mut todo = vec![class.to_owned()];
    while let Some(name) = todo.pop() {
        if !seen.insert(name.clone()) {
            continue;
        }
        // `Entity` is the NGSI-LD core class every model imports; its Attributes are CORE.
        if name == "Entity" {
            continue;
        }
        let definition = linkml
            .get("classes")
            .and_then(|classes| classes.get(&name))?;
        slots.extend(names(definition.get("slots")));
        slots.extend(names(definition.get("attributes")));
        todo.extend(names(definition.get("is_a")));
        todo.extend(names(definition.get("mixins")));
    }
    Some(slots)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const MODEL: &str = r#"
classes:
  Located: { slots: [address] }
  OnStreetParking:
    is_a: Entity
    mixins: [Located]
    slots: [availableSpotNumber, refParkingGroup]
    attributes: { stewardNote: { range: string } }
  Imported:
    is_a: SomeImportedClass
    slots: [x]
"#;

    fn model() -> serde_norway::Value {
        serde_norway::from_str(MODEL).expect("the test model parses")
    }

    #[test]
    fn a_name_the_class_lacks_is_an_error_on_its_field() {
        let spec = json!({
            "information": [{
                "entities": [{"type": "OnStreetParking"}],
                "propertyNames": ["availableSpotNumber", "noSuchAttribute", "address", "location", "stewardNote"],
                "relationshipNames": ["refParkingGroup", "refNowhere"],
            }],
        });
        let found = unknown_names(&spec, &model(), "parking");
        let paths: Vec<&str> = found.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(
            paths,
            [
                "spec.information.0.propertyNames.1",
                "spec.information.0.relationshipNames.1"
            ]
        );
        assert!(found.iter().all(|f| f.level == Level::Error));
        assert!(
            found[0].message.contains("'noSuchAttribute'"),
            "{}",
            found[0].message
        );
        assert!(
            found[0].message.contains("availableSpotNumber"),
            "{}",
            found[0].message
        );
    }

    #[test]
    fn each_rule_is_checked_under_its_own_path() {
        let spec = json!({
            "rules": [
                {"information": [{"entities": [{"type": "OnStreetParking"}], "propertyNames": ["address"]}]},
                {"information": [{"entities": [{"type": "OnStreetParking"}], "propertyNames": ["typo"]}]},
            ],
        });
        assert!(has_names(&spec));
        let found = unknown_names(&spec, &model(), "parking");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].path, "spec.rules.1.information.0.propertyNames.0");
    }

    #[test]
    fn what_the_source_cannot_judge_passes() {
        let spec = json!({
            "information": [
                // a class another model defines
                {"entities": [{"type": "AirQualityObserved"}], "propertyNames": ["pm10"]},
                // a class whose parent another model defines
                {"entities": [{"type": "Imported"}], "propertyNames": ["inherited"]},
                // an IRI, and an entry of two types where one is judged
                {"entities": [{"type": "OnStreetParking"}, {"type": "Elsewhere"}], "propertyNames": ["other"]},
                {"entities": [{"type": "OnStreetParking"}], "propertyNames": ["https://smartdatamodels.org/name"]},
            ],
        });
        assert_eq!(unknown_names(&spec, &model(), "parking"), Vec::new());
        assert!(!has_names(
            &json!({"information": [{"entities": [{"type": "OnStreetParking"}]}]})
        ));
    }
}
