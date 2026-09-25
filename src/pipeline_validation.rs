//! What a pipeline may write: a record checked against its target space's one model (PL-59,
//! PL-60, ADR-N-034).
//!
//! Model Tools renders one LinkML source into a JSON Schema of each class in key-value form and
//! into SHACL shapes (DM-43). A pipeline writes normalized NGSI-LD, so this module compiles the
//! key-value schema of each class into a schema of the normalized entity: `id` and `type`
//! required, `type` the class name, each attribute an object of the NGSI-LD kind the slot
//! declares with its value checked against the slot's schema, and no other attribute unless the
//! model is open. Those are the constraints the model's SHACL shapes carry, so a refusal names
//! the SHACL component it broke and the path it broke it at.
//!
//! The same compiled schema is checked here (the workbench's validation step, the rejected
//! list's reason) and rendered into the runner's stream (the stage before the write), so a
//! person and the runner reach the same verdict on the same record.

use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::{Arc, RwLock};

/// The labels the stage's processors carry: their error counter is the pipeline's rejected
/// count, not its errors (PL-61).
pub const STAGE_LABELS: [&str; 3] = ["validation", "validation_id", "rejected"];

/// The compiled model of every space that names one, by `(project, space)`: what the reconciler
/// renders the stage from and what the rejected route names a record's rule by. Replaced whole on
/// every sync, so both read the version the repository pins now (PL-60).
#[derive(Debug, Default)]
pub struct ModelSchemas {
    by_space: RwLock<HashMap<(String, String), Arc<ModelSchema>>>,
}

impl ModelSchemas {
    /// The compiled model of one space, when the space names one.
    pub fn get(&self, project: &str, space: &str) -> Option<Arc<ModelSchema>> {
        self.by_space
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(&(project.to_owned(), space.to_owned()))
            .cloned()
    }

    /// Every `(project, space)` that names a model, in order: what the data-quality run reads
    /// (DM-74).
    pub fn spaces(&self) -> Vec<(String, String)> {
        let mut spaces: Vec<_> = self
            .by_space
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .cloned()
            .collect();
        spaces.sort();
        spaces
    }

    /// Swaps in what one sync compiled.
    pub fn replace(&self, compiled: HashMap<(String, String), Arc<ModelSchema>>) {
        *self.by_space.write().unwrap_or_else(|e| e.into_inner()) = compiled;
    }
}

/// Compiles the model every space names (`spec.dataModelRef`, DM-61) from a staged repository:
/// the model's manifest in the same project and space, and its JSON Schema artifact read from
/// beside it. A draft model has no artifact yet; its classes are then held to their id and type.
/// A space that names no model, or a model that is not there, compiles to nothing and its
/// pipelines are not narrowed (`jcctl validate` refuses the second before a commit).
pub fn load(
    repo: &jcctl::loader::Repository,
    root: &Path,
) -> HashMap<(String, String), Arc<ModelSchema>> {
    use jc_core::kinds::{ContextSpaceSpec, DataModelSpec};
    let mut compiled = HashMap::new();
    for (id, resource) in repo.iter() {
        if id.kind != "ContextSpace" {
            continue;
        }
        let Some(space) =
            serde_json::from_value::<ContextSpaceSpec>(resource.manifest.spec.clone()).ok()
        else {
            continue;
        };
        let Some(named) = space.data_model_ref else {
            continue;
        };
        let project = id.namespace.clone().unwrap_or_default();
        let model = repo.iter().find_map(|(model, found)| {
            let spec = serde_json::from_value::<DataModelSpec>(found.manifest.spec.clone()).ok()?;
            (model.kind == "DataModel"
                && model.namespace.as_deref() == Some(project.as_str())
                && model.name == named.name()
                && spec.context_space_ref.as_deref() == Some(id.name.as_str()))
            .then_some((found.path.clone(), spec))
        });
        let Some((manifest, spec)) = model else {
            tracing::warn!(project = %project, space = %id.name, model = %named.name(), "the space names a model it does not hold; its pipelines are not validated");
            continue;
        };
        let json_schema = spec
            .artifacts
            .json_schema
            .as_deref()
            .and_then(|relative| beside(root, &manifest, relative))
            .unwrap_or(Value::Null);
        compiled.insert(
            (project, id.name.clone()),
            Arc::new(ModelSchema::compile_for_space(
                named.name(),
                spec.version.as_str(),
                &json_schema,
                &spec.classes,
                spec.open_world,
                space.missing_unit_code,
            )),
        );
    }
    compiled
}

/// One JSON artifact beside its manifest, never outside the staged tree.
fn beside(root: &Path, manifest: &Path, relative: &str) -> Option<Value> {
    if relative.starts_with('/') || relative.split('/').any(|part| part == "..") {
        return None;
    }
    let path = root.join(manifest).parent()?.join(relative);
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Puts the stage and the rejected sink into a rendered stream, right before the split into
/// gateway batches, so each record is checked alone and a refused one never reaches a batch
/// (PL-60, PL-61). Answers whether the stream had the place to put them.
pub fn insert_stage(stream: &mut Value, schema: &ModelSchema, sink_url: &str) -> bool {
    let Some(processors) = stream
        .pointer_mut("/pipeline/processors")
        .and_then(Value::as_array_mut)
    else {
        return false;
    };
    let Some(split) = processors.iter().rposition(|p| p.get("split").is_some()) else {
        return false;
    };
    let mut stage = schema.stage();
    stage.push(rejected_sink(sink_url));
    for (processor, label) in stage.iter_mut().zip(STAGE_LABELS) {
        if let Some(fields) = processor.as_object_mut() {
            fields.insert("label".into(), json!(label));
        }
    }
    processors.splice(split..split, stage);
    true
}

/// One model, compiled for checking normalized entities (PL-59).
#[derive(Debug, Clone)]
pub struct ModelSchema {
    /// The model's manifest name, which a refusal of an undeclared type names.
    pub model: String,
    /// The version the space pins; a change re-renders the stage (PL-60).
    pub version: String,
    /// The normalized-entity schema of each class, by class name.
    pub classes: BTreeMap<String, Value>,
}

/// Why one record would not be written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, utoipa::ToSchema)]
pub struct Problem {
    /// The constraint: a SHACL component (`sh:minCount`, `sh:datatype`, …), `type` for a class
    /// the model does not declare (DM-61) or `id` for the id rule (PF-42).
    pub rule: String,
    /// The attribute the constraint is about, empty for the entity itself.
    pub path: String,
    /// What is wrong, in words; never the value the record carried, which may be anything.
    pub message: String,
}

/// The NGSI-LD attribute kinds and the member that carries each one's value.
const KINDS: [(&str, &str); 5] = [
    ("Property", "value"),
    ("Relationship", "object"),
    ("GeoProperty", "value"),
    ("LanguageProperty", "languageMap"),
    ("VocabProperty", "vocab"),
];

impl ModelSchema {
    /// Compiles a model's JSON Schema (key-value form, as Model Tools renders it) into one
    /// normalized-entity schema per class. `classes` names the classes the manifest declares;
    /// a class the schema has no definition for is compiled open, so a record of it is still
    /// held to its id and type.
    pub fn compile(
        model: &str,
        version: &str,
        json_schema: &Value,
        classes: &[String],
        open_world: bool,
    ) -> Self {
        Self::compile_for_space(
            model,
            version,
            json_schema,
            classes,
            open_world,
            jc_core::kinds::MissingUnitCode::Fill,
        )
    }

    /// [`Self::compile`] for a space that says what a quantity without its `unitCode` gets
    /// (DM-06): a quantity Property of a slot with a unit must carry the model's code, and in a
    /// space that refuses a missing one it must carry one at all. Where the space fills it, the
    /// gateway writes the model's code, so a record without one is still valid.
    pub fn compile_for_space(
        model: &str,
        version: &str,
        json_schema: &Value,
        classes: &[String],
        open_world: bool,
        missing_unit_code: jc_core::kinds::MissingUnitCode,
    ) -> Self {
        let require_units = missing_unit_code == jc_core::kinds::MissingUnitCode::Refuse;
        let definitions = json_schema
            .get("$defs")
            .or_else(|| json_schema.get("definitions"))
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let compiled = classes
            .iter()
            .map(|class| {
                let normalized = normalized(
                    class,
                    definitions.get(class),
                    &definitions,
                    open_world,
                    require_units,
                );
                (class.clone(), normalized)
            })
            .collect();
        Self {
            model: model.to_owned(),
            version: version.to_owned(),
            classes: compiled,
        }
    }

    /// Every problem of one record, for the space whose rendered segment is `space` in the
    /// organization `org_domain` (PL-59). An empty list is a valid record.
    pub fn check(&self, record: &Value, org_domain: &str, space: &str) -> Vec<Problem> {
        let Some(object) = record.as_object() else {
            return vec![problem("sh:node", "", "the record is not a JSON object")];
        };
        let Some(class) = object.get("type").and_then(Value::as_str) else {
            return vec![problem("sh:minCount", "type", "the record has no type")];
        };
        let Some(schema) = self.classes.get(class) else {
            return vec![problem(
                "type",
                "type",
                &format!(
                    "{class} is not a class of the space's data model {} (DM-61)",
                    self.model
                ),
            )];
        };
        let mut problems = id_problems(object, class, org_domain, space);
        match jsonschema::draft7::new(schema) {
            Ok(validator) => problems.extend(validator.iter_errors(record).map(|error| {
                let path = attribute_of(&error.instance_path().to_string());
                let (rule, message) = named(&error, &path);
                Problem {
                    rule: rule.to_owned(),
                    path,
                    message,
                }
            })),
            Err(error) => {
                tracing::warn!(model = %self.model, class, %error, "a compiled class schema does not compile");
                problems.push(problem(
                    "sh:node",
                    "",
                    &format!(
                        "the schema of {class} in model {} does not compile",
                        self.model
                    ),
                ));
            }
        }
        problems
    }

    /// The runner's stage for this model (PL-60): Bento processors that fail a record whose type
    /// is not a class, whose id breaks PF-42, or that breaks its class's schema. A failed record
    /// is caught by the processors [`rejected_sink`] renders and is never written.
    pub fn stage(&self) -> Vec<Value> {
        let mut cases: Vec<Value> = self
            .classes
            .iter()
            .map(|(class, schema)| {
                json!({
                    "check": format!("this.type == {}", bloblang_string(class)),
                    "processors": [{ "json_schema": { "schema": schema.to_string() } }]
                })
            })
            .collect();
        cases.push(json!({
            "processors": [{ "mapping": format!(
                "root = throw(\"the type is not a class of the space's data model {} (DM-61)\")",
                self.model
            )}]
        }));
        vec![
            json!({ "switch": cases }),
            json!({ "mapping": concat!(
                "root = this\n",
                "let prefix = \"urn:ngsi-ld:\" + this.type.string() + \":\" + env(\"JC_ORG_DOMAIN\") + \":\" + env(\"JC_SPACE\") + \":\"\n",
                "if !this.id.or(\"\").string().has_prefix($prefix) || this.id.or(\"\").string().length() <= $prefix.length() {\n",
                "  root = throw(\"the id is not urn:ngsi-ld:{type}:{orgDomain}:{space}:{localId} of this space (PF-42)\")\n",
                "}"
            )}),
        ]
    }
}

/// What catches a record the stage refused (PL-61): it is posted once, with the reason, to the
/// Portal's internal rejected route for this pipeline and then dropped, so it is never written.
/// A Portal that does not answer loses the rejection and never holds back the stream.
pub fn rejected_sink(url: &str) -> Value {
    json!({ "catch": [
        { "mapping": format!(
            "root = {{ \"record\": this, \"error\": error(), \"step\": meta(\"jc_step\").or(null), \"run\": {} }}",
            crate::pipeline_log::RUN
        ) },
        { "http": {
            "url": url,
            "verb": "POST",
            "headers": { "Content-Type": "application/json" },
            "timeout": "5s",
            "retries": 0,
            "oauth2": {
                "enabled": true,
                "client_key": "${JC_CLIENT_ID}",
                "client_secret": "${JC_CLIENT_SECRET}",
                "token_url": "${JC_TOKEN_URL}",
            },
        }},
        { "mapping": "root = deleted()" }
    ]})
}

fn bloblang_string(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_owned())
}

fn problem(rule: &str, path: &str, message: &str) -> Problem {
    Problem {
        rule: rule.to_owned(),
        path: path.to_owned(),
        message: message.to_owned(),
    }
}

/// The id rule, checked here rather than by the schema so it names the space it wants (PF-42).
fn id_problems(
    object: &Map<String, Value>,
    class: &str,
    org_domain: &str,
    space: &str,
) -> Vec<Problem> {
    let prefix = format!("urn:ngsi-ld:{class}:{org_domain}:{space}:");
    match object.get("id").and_then(Value::as_str) {
        None => vec![problem("sh:minCount", "id", "the record has no id")],
        Some(id) if id.len() > prefix.len() && id.starts_with(&prefix) => Vec::new(),
        Some(_) => vec![problem(
            "id",
            "id",
            &format!("the id is not {prefix}{{localId}} (PF-42)"),
        )],
    }
}

/// The attribute a JSON pointer is about: its first segment.
fn attribute_of(pointer: &str) -> String {
    pointer
        .trim_start_matches('/')
        .split('/')
        .next()
        .unwrap_or_default()
        .replace("~1", "/")
        .replace("~0", "~")
}

/// The SHACL component a schema error is, and a message that does not quote the value.
fn named(error: &jsonschema::ValidationError<'_>, path: &str) -> (&'static str, String) {
    use jsonschema::error::ValidationErrorKind as Kind;
    let at = if path.is_empty() {
        "the record".to_owned()
    } else {
        path.to_owned()
    };
    let pointer = error.instance_path().to_string();
    let depth = pointer
        .trim_start_matches('/')
        .split('/')
        .filter(|s| !s.is_empty())
        .count();
    match error.kind() {
        Kind::Required { property } => {
            let property = property.as_str().unwrap_or_default();
            if property == "unitCode" {
                (
                    "ngsi-ld:unitCode",
                    format!(
                        "{at} has no unitCode, which this space requires of every quantity (DM-06)"
                    ),
                )
            } else if depth == 0 {
                ("sh:minCount", format!("{property} is required"))
            } else {
                ("sh:minCount", format!("{at} has no {property}"))
            }
        }
        Kind::AdditionalProperties { unexpected } => (
            "sh:closed",
            format!(
                "{} is not an attribute the class declares",
                unexpected.join(", ")
            ),
        ),
        Kind::Constant { .. } if pointer.ends_with("/type") && depth == 2 => (
            "ngsi-ld:attributeKind",
            format!("{at} is not of the NGSI-LD kind its slot declares"),
        ),
        Kind::Constant { expected_value } if pointer.ends_with("/unitCode") && depth == 2 => {
            let code = expected_value.as_str().unwrap_or_default();
            let unit = jc_core::units::lookup(code)
                .map(|unit| {
                    format!(
                        " ({})",
                        if unit.symbol.is_empty() {
                            unit.name
                        } else {
                            unit.symbol
                        }
                    )
                })
                .unwrap_or_default();
            (
                "ngsi-ld:unitCode",
                format!("{at} is measured in {code}{unit} by the model; convert the value and write unitCode {code} (DM-06)"),
            )
        }
        Kind::Constant { .. } => ("sh:hasValue", format!("{at} is not the value it must be")),
        Kind::Type { .. } | Kind::Format { .. } => {
            ("sh:datatype", format!("{at} is not of the slot's datatype"))
        }
        Kind::Enum { .. } => (
            "sh:in",
            format!("{at} is not one of the slot's permitted values"),
        ),
        Kind::Minimum { .. } | Kind::ExclusiveMinimum { .. } => (
            "sh:minInclusive",
            format!("{at} is below the slot's minimum"),
        ),
        Kind::Maximum { .. } | Kind::ExclusiveMaximum { .. } => (
            "sh:maxInclusive",
            format!("{at} is above the slot's maximum"),
        ),
        Kind::MinItems { .. } => ("sh:minCount", format!("{at} has too few values")),
        Kind::MaxItems { .. } => ("sh:maxCount", format!("{at} has too many values")),
        Kind::Pattern { .. } => (
            "sh:pattern",
            format!("{at} does not match the slot's pattern"),
        ),
        Kind::MinLength { .. } => (
            "sh:minLength",
            format!("{at} is shorter than the slot allows"),
        ),
        Kind::MaxLength { .. } => (
            "sh:maxLength",
            format!("{at} is longer than the slot allows"),
        ),
        _ => ("sh:node", format!("{at} breaks its class's shape")),
    }
}

/// One class's normalized-entity schema, from its key-value definition.
fn normalized(
    class: &str,
    definition: Option<&Value>,
    definitions: &Map<String, Value>,
    open_world: bool,
    require_units: bool,
) -> Value {
    let mut properties = Map::new();
    properties.insert("id".into(), json!({ "type": "string" }));
    properties.insert("type".into(), json!({ "const": class }));
    properties.insert("@context".into(), json!({}));
    let mut required = vec![json!("id"), json!("type")];

    let declared = definition
        .and_then(|d| d.get("properties"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for (name, slot) in &declared {
        if name == "id" || name == "type" {
            continue;
        }
        properties.insert(name.clone(), attribute(slot, require_units));
    }
    for name in definition
        .and_then(|d| d.get("required"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        if name != "id" && name != "type" && declared.contains_key(name) {
            required.push(json!(name));
        }
    }
    // A class with no definition is held to its id and type and nothing more: closing it would
    // refuse every attribute of a class the schema cannot describe.
    let closed = definition.is_some()
        && !open_world
        && definition.and_then(|d| d.get("additionalProperties")) != Some(&Value::Bool(true));
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "required": required,
        "properties": properties,
        "additionalProperties": !closed,
        "definitions": definitions,
    })
}

/// One attribute of the normalized form: an object of the slot's NGSI-LD kind whose value
/// member holds what the key-value schema says the value is.
///
/// A Property whose slot declares a UN/CEFACT unit (`x-unit.exactMappings`, `ucefact:GQ`) holds
/// its `unitCode` to that code, and requires one when `require_units` (DM-06).
fn attribute(slot: &Value, require_units: bool) -> Value {
    let kind = slot
        .get("x-ngsi-ld-kind")
        .and_then(Value::as_str)
        .unwrap_or("Property");
    let member = KINDS
        .iter()
        .find(|(name, _)| *name == kind)
        .map(|(_, member)| *member)
        .unwrap_or("value");
    let value = if kind == "LanguageProperty" {
        json!({ "type": "object", "additionalProperties": { "type": "string" } })
    } else {
        without_null(slot)
    };
    let mut shape = json!({
        "type": "object",
        "required": ["type", member],
        "properties": {
            "type": { "const": kind },
            member: value,
        },
    });
    if let Some(code) = unit_code(slot).filter(|_| kind == "Property") {
        shape["properties"]["unitCode"] = json!({ "const": code });
        if require_units {
            if let Some(required) = shape["required"].as_array_mut() {
                required.push(json!("unitCode"));
            }
        }
    }
    shape
}

/// The UN/CEFACT code a key-value slot's `x-unit` names, and the `unece:` spelling older models
/// used (DM-06).
fn unit_code(slot: &Value) -> Option<&str> {
    slot.pointer("/x-unit/exactMappings")?
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .find_map(|mapping| {
            mapping
                .strip_prefix("ucefact:")
                .or_else(|| mapping.strip_prefix("unece:"))
        })
        .filter(|code| !code.is_empty())
}

/// The slot's schema without `null`: key-value form writes an absent value as null, and the
/// normalized form leaves the attribute out instead.
fn without_null(slot: &Value) -> Value {
    let mut slot = slot.clone();
    if let Some(object) = slot.as_object_mut() {
        object.retain(|key, _| !key.starts_with("x-") && key != "description");
        if let Some(Value::Array(types)) = object.get_mut("type") {
            types.retain(|t| t != "null");
            if types.len() == 1 {
                let only = types[0].clone();
                object.insert("type".into(), only);
            }
        }
    }
    slot
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOMAIN: &str = "banskabystrica.sk";
    const SPACE: &str = "ovzdusie";

    fn schema() -> Value {
        json!({
            "$schema": "http://json-schema.org/draft-07/schema#",
            "definitions": {
                "Window": { "enum": ["day", "month"], "type": "string" },
                "AirQualityObserved": {
                    "additionalProperties": false,
                    "properties": {
                        "id": { "type": "string" },
                        "dateObserved": { "type": "string", "format": "date-time", "x-ngsi-ld-kind": "Property" },
                        "pm10": { "type": ["number", "null"], "minimum": 0, "x-ngsi-ld-kind": "Property" },
                        "window": { "$ref": "#/definitions/Window", "x-ngsi-ld-kind": "Property" },
                        "name": { "x-ngsi-ld-kind": "LanguageProperty" },
                        "refDevice": { "type": "string", "x-ngsi-ld-kind": "Relationship" },
                        "location": { "type": ["object", "null"], "required": ["type", "coordinates"], "x-ngsi-ld-kind": "GeoProperty" }
                    },
                    "required": ["id", "dateObserved"]
                }
            }
        })
    }

    fn model(open: bool) -> ModelSchema {
        ModelSchema::compile(
            "bb-air-quality",
            "1.0.0",
            &schema(),
            &["AirQualityObserved".into()],
            open,
        )
    }

    fn valid() -> Value {
        json!({
            "id": "urn:ngsi-ld:AirQualityObserved:banskabystrica.sk:ovzdusie:station-1",
            "type": "AirQualityObserved",
            "dateObserved": { "type": "Property", "value": "2026-09-01T06:00:00Z" },
            "pm10": { "type": "Property", "value": 18.4, "unitCode": "GQ" },
            "window": { "type": "Property", "value": "day" },
            "name": { "type": "LanguageProperty", "languageMap": { "sk": "Stanica 1" } },
            "refDevice": { "type": "Relationship", "object": "urn:ngsi-ld:Device:banskabystrica.sk:ovzdusie:d-1" },
            "location": { "type": "GeoProperty", "value": { "type": "Point", "coordinates": [19.1, 48.7] } }
        })
    }

    fn rules(record: &Value) -> Vec<(String, String)> {
        model(false)
            .check(record, DOMAIN, SPACE)
            .into_iter()
            .map(|p| (p.rule, p.path))
            .collect()
    }

    fn with_unit(missing: jc_core::kinds::MissingUnitCode) -> ModelSchema {
        let mut schema = schema();
        schema["definitions"]["AirQualityObserved"]["properties"]["pm10"]["x-unit"] =
            json!({ "exactMappings": ["ucefact:GQ", "qudt-unit:MicroGM-PER-M3"] });
        schema["definitions"]["AirQualityObserved"]["properties"]["refDevice"]["x-unit"] =
            json!({ "exactMappings": ["ucefact:C62"] });
        ModelSchema::compile_for_space(
            "bb-air-quality",
            "1.0.0",
            &schema,
            &["AirQualityObserved".into()],
            false,
            missing,
        )
    }

    /// DM-06, T-2811: a quantity carries its model's unit code; where the space fills a missing
    /// one the record may leave it out, where it refuses one it may not.
    #[test]
    fn a_quantity_in_another_unit_is_a_problem_naming_the_code() {
        use jc_core::kinds::MissingUnitCode;
        let fill = with_unit(MissingUnitCode::Fill);
        assert!(fill.check(&valid(), DOMAIN, SPACE).is_empty());

        let mut record = valid();
        record["pm10"]["unitCode"] = json!("GP");
        let problems = fill.check(&record, DOMAIN, SPACE);
        assert_eq!(problems.len(), 1, "{problems:?}");
        assert_eq!(
            (problems[0].rule.as_str(), problems[0].path.as_str()),
            ("ngsi-ld:unitCode", "pm10")
        );
        assert!(
            problems[0].message.contains("measured in GQ (µg/m³)"),
            "{}",
            problems[0].message
        );
        assert!(
            !problems[0].message.contains("GP"),
            "the value the record carried is not quoted"
        );

        let mut missing = valid();
        missing["pm10"]
            .as_object_mut()
            .map(|pm10| pm10.remove("unitCode"));
        assert!(
            fill.check(&missing, DOMAIN, SPACE).is_empty(),
            "the gateway fills it"
        );
        let strict = with_unit(MissingUnitCode::Refuse).check(&missing, DOMAIN, SPACE);
        assert_eq!(strict.len(), 1, "{strict:?}");
        assert_eq!(strict[0].rule, "ngsi-ld:unitCode");
        assert!(
            strict[0].message.contains("has no unitCode"),
            "{}",
            strict[0].message
        );

        // A Relationship has no unit, whatever its slot says.
        assert!(with_unit(MissingUnitCode::Refuse)
            .check(&valid(), DOMAIN, SPACE)
            .is_empty());
    }

    #[test]
    fn a_valid_record_has_no_problem() {
        assert_eq!(rules(&valid()), Vec::<(String, String)>::new());
    }

    #[test]
    fn each_broken_constraint_is_named_by_its_shacl_component_and_path() {
        let mut record = valid();
        record["pm10"]["value"] = json!("n/a");
        assert_eq!(rules(&record), [("sh:datatype".into(), "pm10".into())]);

        let mut record = valid();
        record["window"]["value"] = json!("year");
        assert_eq!(rules(&record), [("sh:in".into(), "window".into())]);

        let mut record = valid();
        record.as_object_mut().map(|o| o.remove("dateObserved"));
        assert_eq!(rules(&record), [("sh:minCount".into(), String::new())]);

        let mut record = valid();
        record["colour"] = json!({ "type": "Property", "value": "blue" });
        assert_eq!(rules(&record), [("sh:closed".into(), String::new())]);

        let mut record = valid();
        record["refDevice"] = json!({ "type": "Property", "value": "urn:x" });
        let broken = rules(&record);
        assert!(
            broken.contains(&("ngsi-ld:attributeKind".into(), "refDevice".into())),
            "{broken:?}"
        );

        let mut record = valid();
        record["pm10"]["value"] = json!(-1);
        assert_eq!(rules(&record), [("sh:minInclusive".into(), "pm10".into())]);
    }

    #[test]
    fn a_wrong_id_and_an_undeclared_type_are_named() {
        let mut record = valid();
        record["id"] = json!("urn:ngsi-ld:AirQualityObserved:hel.fi:helsinki:station-1");
        assert_eq!(rules(&record), [("id".into(), "id".into())]);

        let mut record = valid();
        record["id"] = json!("urn:ngsi-ld:AirQualityObserved:banskabystrica.sk:ovzdusie:");
        assert_eq!(
            rules(&record),
            [("id".into(), "id".into())],
            "an empty local id"
        );

        let mut record = valid();
        record["type"] = json!("Device");
        let problems = model(false).check(&record, DOMAIN, SPACE);
        assert_eq!(problems.len(), 1);
        assert_eq!(problems[0].rule, "type");
        assert!(problems[0].message.contains("bb-air-quality"));

        assert_eq!(rules(&json!([1])), [("sh:node".into(), String::new())]);
        assert_eq!(
            rules(&json!({ "id": "x" })),
            [("sh:minCount".into(), "type".into())]
        );
    }

    #[test]
    fn a_message_never_quotes_the_value() {
        let mut record = valid();
        record["pm10"]["value"] = json!("s3cr3t-looking-value");
        for problem in model(false).check(&record, DOMAIN, SPACE) {
            assert!(!problem.message.contains("s3cr3t"), "{problem:?}");
        }
    }

    #[test]
    fn an_open_model_takes_an_attribute_it_does_not_declare() {
        let mut record = valid();
        record["colour"] = json!({ "type": "Property", "value": "blue" });
        assert!(model(true).check(&record, DOMAIN, SPACE).is_empty());
    }

    #[test]
    fn the_stage_switches_on_each_class_and_refuses_the_rest() {
        let stage = model(false).stage();
        let cases = stage[0]["switch"].as_array().expect("a switch");
        assert_eq!(cases.len(), 2);
        assert_eq!(cases[0]["check"], "this.type == \"AirQualityObserved\"");
        let rendered: Value = serde_json::from_str(
            cases[0]["processors"][0]["json_schema"]["schema"]
                .as_str()
                .expect("the schema as text"),
        )
        .expect("the rendered schema is JSON");
        assert_eq!(rendered, model(false).classes["AirQualityObserved"]);
        assert!(cases[1]["processors"][0]["mapping"]
            .as_str()
            .is_some_and(|m| m.contains("throw") && m.contains("bb-air-quality")));
        let id_rule = stage[1]["mapping"].as_str().expect("the id rule");
        assert!(
            id_rule.contains("env(\"JC_ORG_DOMAIN\")") && id_rule.contains("env(\"JC_SPACE\")")
        );
    }

    fn write(dir: &Path, rel: &str, body: &str) {
        let path = dir.join(rel);
        std::fs::create_dir_all(path.parent().expect("a parent")).expect("mkdir");
        std::fs::write(path, body).expect("write");
    }

    /// PL-60: the model a space names, with its JSON Schema read from beside the manifest; a
    /// space that names none compiles to nothing, and a draft without an artifact to its types.
    #[test]
    fn load_compiles_the_model_each_space_names() {
        let dir = std::env::temp_dir().join(format!(
            "portal-validation-load-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
        ));
        let space = |name: &str, model: Option<&str>| {
            let named = model
                .map(|m| format!("\n  dataModelRef: {{ kind: DataModel, name: {m} }}"))
                .unwrap_or_default();
            format!("apiVersion: joinedcontext.com/v1alpha1\nkind: ContextSpace\nmetadata:\n  name: {name}\n  namespace: ovzdusie\nspec:\n  isSandbox: false{named}\n")
        };
        write(
            &dir,
            "projects/ovzdusie/spaces/ovzdusie/space.yaml",
            &space("ovzdusie", Some("air")),
        );
        write(
            &dir,
            "projects/ovzdusie/spaces/raw/space.yaml",
            &space("raw", None),
        );
        write(
            &dir,
            "projects/ovzdusie/spaces/draft/space.yaml",
            &space("draft", Some("drafted")),
        );
        let model = |name: &str, space: &str, artifact: bool| {
            format!(
                "apiVersion: joinedcontext.com/v1alpha1\nkind: DataModel\nmetadata:\n  name: {name}\n  namespace: ovzdusie\nspec:\n  contextSpaceRef: {space}\n  linkml: ./{name}.linkml.yaml\n  version: 1.0.0\n  lifecycle: draft\n  classes: [AirQualityObserved]\n{}",
                if artifact { format!("  artifacts:\n    jsonSchema: ./{name}.v1.schema.json\n") } else { String::new() }
            )
        };
        write(
            &dir,
            "projects/ovzdusie/spaces/ovzdusie/datamodels/air.yaml",
            &model("air", "ovzdusie", true),
        );
        write(
            &dir,
            "projects/ovzdusie/spaces/ovzdusie/datamodels/air.v1.schema.json",
            &schema().to_string(),
        );
        write(
            &dir,
            "projects/ovzdusie/spaces/draft/datamodels/drafted.yaml",
            &model("drafted", "draft", false),
        );
        let repo = jcctl::loader::Repository::load(&dir).expect("the repository loads");

        let compiled = load(&repo, &dir);
        assert_eq!(compiled.len(), 2, "{:?}", compiled.keys());
        let air = &compiled[&("ovzdusie".to_owned(), "ovzdusie".to_owned())];
        assert_eq!(air.model, "air");
        let mut record = valid();
        record["pm10"]["value"] = json!("n/a");
        assert_eq!(
            air.check(&record, DOMAIN, SPACE)[0].rule,
            "sh:datatype",
            "the artifact was read"
        );

        let drafted = &compiled[&("ovzdusie".to_owned(), "draft".to_owned())];
        let loose = json!({ "id": "urn:ngsi-ld:AirQualityObserved:banskabystrica.sk:draft:1", "type": "AirQualityObserved", "anything": { "type": "Property", "value": 1 } });
        assert!(
            drafted.check(&loose, DOMAIN, "draft").is_empty(),
            "a draft holds its types and ids only"
        );
        let mut wrong = loose.clone();
        wrong["type"] = json!("Device");
        assert_eq!(drafted.check(&wrong, DOMAIN, "draft")[0].rule, "type");
    }

    #[test]
    fn the_stage_goes_right_before_the_split_and_a_stream_without_one_is_left_alone() {
        let mut stream = json!({ "pipeline": { "processors": [
            { "mapping": "root = this" }, { "unarchive": {} }, { "split": { "size": 1000 } }, { "archive": {} }
        ]}});
        assert!(insert_stage(
            &mut stream,
            &model(false),
            "http://p/internal/pipelines/a/b/rejected"
        ));
        let labels: Vec<Value> = stream["pipeline"]["processors"]
            .as_array()
            .expect("processors")
            .iter()
            .map(|p| p.get("label").cloned().unwrap_or(Value::Null))
            .collect();
        assert_eq!(
            labels[2..5],
            [
                json!("validation"),
                json!("validation_id"),
                json!("rejected")
            ]
        );
        assert!(stream["pipeline"]["processors"][5].get("split").is_some());

        let mut no_split = json!({ "pipeline": { "processors": [{ "mapping": "root = this" }] } });
        assert!(!insert_stage(&mut no_split, &model(false), "http://p/x"));
        assert_eq!(
            no_split["pipeline"]["processors"].as_array().map(Vec::len),
            Some(1)
        );
    }

    #[test]
    fn the_sink_posts_with_the_runners_own_credential_then_drops() {
        let sink = rejected_sink("http://portal-internal:8081/internal/pipelines/p/n/rejected");
        let steps = sink["catch"].as_array().expect("a catch");
        assert_eq!(steps[1]["http"]["oauth2"]["client_key"], "${JC_CLIENT_ID}");
        assert_eq!(steps[1]["http"]["retries"], 0);
        assert_eq!(steps[2]["mapping"], "root = deleted()");
    }
}
