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

/// What a pipeline's spec alone says against the models of the spaces it writes (T-3223): every
/// output whose entity type is not a class of the model its Endpoint's space pins, named at that
/// output, before any sample is run. An output that names no type, an Endpoint not in the mirror
/// and a space with no compiled model say nothing here; the runner's stage and the gateway still
/// hold those (PL-59, DM-61).
pub fn output_type_problems(
    schemas: &ModelSchemas,
    mirror: &crate::store::Mirror,
    project: &str,
    spec: &jc_core::kinds::PipelineSpec,
) -> Vec<Problem> {
    let second_shape = !spec.outputs.is_empty();
    spec.outputs()
        .into_iter()
        .enumerate()
        .filter_map(|(index, output)| {
            let entity_type = output.entity_type?;
            let endpoint = mirror.get(project, "Endpoint", output.target_endpoint.local_id())?;
            let space = crate::api::assistant::ref_name(endpoint.spec.get("contextSpaceRef")?)?;
            let model = schemas.get(project, &space)?;
            if model.classes.contains_key(&entity_type) {
                return None;
            }
            let classes: Vec<&str> = model.classes.keys().map(String::as_str).collect();
            Some(Problem {
                rule: "type".to_owned(),
                path: if second_shape {
                    format!("spec.outputs[{index}].type")
                } else {
                    "spec.output.type".to_owned()
                },
                message: format!(
                    "{entity_type} is not a class of the data model {} of space {space}; its classes are {} (DM-61)",
                    model.model,
                    classes.join(", ")
                ),
            })
        })
        .collect()
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
    /// The stored relationship ends of each class, by class and attribute (DM-64).
    ends: BTreeMap<String, BTreeMap<String, End>>,
    /// The model's JSON Schema definitions as Model Tools wrote them (key-value form), which the
    /// attribute list reads its descriptions, units and enums from (T-3223).
    definitions: Map<String, Value>,
}

/// One attribute of a class as the space's model states it (T-3223): what an editor needs to map
/// a field onto it.
#[derive(Debug, Clone, PartialEq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Attribute {
    /// The attribute's name.
    pub name: String,
    /// `Property`, `Relationship`, `GeoProperty`, `LanguageProperty` or `VocabProperty`.
    pub kind: String,
    /// The JSON type of its value (`string`, `number`, `integer`, `boolean`, `object`, `array`),
    /// absent when the model leaves it open.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value_type: Option<String>,
    /// The value's format, such as `date-time`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    /// Whether every entity of the class must carry it.
    pub required: bool,
    /// What it means, in the model's words.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The unit a quantity is in.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit: Option<Unit>,
    /// The values a coded attribute may take.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub values: Option<Vec<String>>,
    /// The entity type a relationship points at, and whether it holds several.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relationship: Option<RelationshipTarget>,
    /// The smallest and the largest value a number may have.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minimum: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub maximum: Option<f64>,
}

/// A quantity's unit: the UN/CEFACT code NGSI-LD's `unitCode` carries, and its UCUM spelling.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Unit {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ucum: Option<String>,
}

/// The type a relationship points at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RelationshipTarget {
    pub target: String,
    pub many: bool,
}

/// A class of the space's model and its attributes (T-3223).
#[derive(Debug, Clone, PartialEq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ClassAttributes {
    /// The model's manifest name and the version the space pins.
    pub model: String,
    pub version: String,
    /// The class, which is the entity type.
    #[serde(rename = "type")]
    pub class: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Required attributes first, then by name; `id` and `type` are the entity's own and not
    /// listed.
    pub attributes: Vec<Attribute>,
}

/// One stored end of a relationship, as the model's JSON Schema states it (T-2739) and the
/// gateway holds a write to it (DM-70, `context-gateway/src/relationships.rs`).
#[derive(Debug, Clone, PartialEq, Eq)]
struct End {
    target: String,
    many: bool,
    required: bool,
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
        let ends = classes
            .iter()
            .filter_map(|class| {
                let ends = ends_of(definitions.get(class)?);
                (!ends.is_empty()).then(|| (class.clone(), ends))
            })
            .collect();
        Self {
            model: model.to_owned(),
            version: version.to_owned(),
            classes: compiled,
            ends,
            definitions,
        }
    }

    /// The attributes of `class` as the model states them, or `None` for a type the model does not
    /// declare (T-3223). A declared class the artifact has no definition for (a draft model) has
    /// no attributes beyond its identity.
    pub fn attributes(&self, class: &str) -> Option<ClassAttributes> {
        if !self.classes.contains_key(class) {
            return None;
        }
        let definition = self.definitions.get(class);
        let required: Vec<&str> = definition
            .and_then(|d| d.get("required"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        let mut attributes: Vec<Attribute> = definition
            .and_then(|d| d.get("properties"))
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
            .filter(|(name, _)| name.as_str() != "id" && name.as_str() != "type")
            .map(|(name, property)| {
                self.attribute(name, property, required.contains(&name.as_str()))
            })
            .collect();
        attributes.sort_by(|a, b| {
            b.required
                .cmp(&a.required)
                .then_with(|| a.name.cmp(&b.name))
        });
        Some(ClassAttributes {
            model: self.model.clone(),
            version: self.version.clone(),
            class: class.to_owned(),
            description: definition
                .and_then(|d| d.get("description"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            attributes,
        })
    }

    /// A record in key-value form as the normalized NGSI-LD entity a write of `class` carries:
    /// each attribute wrapped as the kind its slot declares, a quantity with its model's unit code
    /// (T-3223, T-3224). A member already normalized, and `id`, `type` and `@context`, pass
    /// unchanged; a `null` is left out, since NGSI-LD has no null attribute.
    pub fn normalize(&self, class: &str, record: &Value) -> Value {
        let Some(object) = record.as_object() else {
            return record.clone();
        };
        let attributes = self
            .attributes(class)
            .map(|a| a.attributes)
            .unwrap_or_default();
        let mut normalized = Map::new();
        for (name, value) in object {
            if matches!(name.as_str(), "id" | "type" | "@context") {
                normalized.insert(name.clone(), value.clone());
                continue;
            }
            if value.is_null() {
                continue;
            }
            let already = value
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|kind| KINDS.iter().any(|(k, _)| *k == kind));
            if already {
                normalized.insert(name.clone(), value.clone());
                continue;
            }
            let attribute = attributes.iter().find(|a| a.name == *name);
            let kind = attribute.map_or("Property", |a| a.kind.as_str());
            let member = KINDS
                .iter()
                .find(|(k, _)| *k == kind)
                .map_or("value", |(_, member)| *member);
            let mut wrapped = Map::from_iter([
                ("type".to_owned(), json!(kind)),
                (member.to_owned(), value.clone()),
            ]);
            if let Some(code) = attribute
                .filter(|_| kind == "Property" && value.is_number())
                .and_then(|a| a.unit.as_ref())
                .and_then(|u| u.code.clone())
            {
                wrapped.insert("unitCode".to_owned(), json!(code));
            }
            normalized.insert(name.clone(), Value::Object(wrapped));
        }
        Value::Object(normalized)
    }

    fn attribute(&self, name: &str, property: &Value, required: bool) -> Attribute {
        // A coded slot is a `$ref` to an enum definition; follow it once for its values and type.
        let referenced = property
            .get("$ref")
            .and_then(Value::as_str)
            .and_then(|r| r.rsplit('/').next())
            .and_then(|target| self.definitions.get(target));
        let typed = referenced.unwrap_or(property);
        let value_type = match typed.get("type") {
            Some(Value::String(one)) => Some(one.clone()),
            Some(Value::Array(many)) => many
                .iter()
                .filter_map(Value::as_str)
                .find(|t| *t != "null")
                .map(str::to_owned),
            _ => None,
        };
        let values = typed.get("enum").and_then(Value::as_array).map(|values| {
            values
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        });
        let unit = property.get("x-unit").map(|unit| Unit {
            code: unit
                .get("exactMappings")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .find_map(|m| m.strip_prefix("ucefact:"))
                .map(str::to_owned),
            ucum: unit
                .get("ucumCode")
                .and_then(Value::as_str)
                .map(str::to_owned),
        });
        let relationship = property
            .pointer("/x-ngsi-ld-relationship/target")
            .and_then(Value::as_str)
            .filter(|target| !target.is_empty())
            .map(|target| RelationshipTarget {
                target: target.to_owned(),
                many: value_type.as_deref() == Some("array"),
            });
        Attribute {
            name: name.to_owned(),
            kind: property
                .get("x-ngsi-ld-kind")
                .and_then(Value::as_str)
                .unwrap_or(if relationship.is_some() {
                    "Relationship"
                } else {
                    "Property"
                })
                .to_owned(),
            value_type,
            format: typed
                .get("format")
                .and_then(Value::as_str)
                .map(str::to_owned),
            required,
            description: property
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_owned),
            unit,
            values,
            relationship,
            minimum: property.get("minimum").and_then(Value::as_f64),
            maximum: property.get("maximum").and_then(Value::as_f64),
        }
    }

    /// Every problem of one record (PL-59). An empty list is a valid record.
    pub fn check(&self, record: &Value) -> Vec<Problem> {
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
        let mut problems = id_problems(object, class);
        match jsonschema::draft7::new(schema) {
            Ok(validator) => problems.extend(validator.iter_errors(record).flat_map(|error| {
                let mut path = attribute_of(&error.instance_path().to_string());
                // An attribute the class does not declare is named on its own, one problem each,
                // so the editor marks that attribute and not the whole entity (T-3223).
                if let (
                    true,
                    jsonschema::error::ValidationErrorKind::AdditionalProperties { unexpected },
                ) = (path.is_empty(), error.kind())
                {
                    return unexpected
                        .iter()
                        .map(|name| Problem {
                            rule: "sh:closed".to_owned(),
                            path: name.clone(),
                            message: format!("{name} is not an attribute the class declares"),
                        })
                        .collect::<Vec<_>>();
                }
                let (rule, message) = named(&error, &path);
                // A missing attribute is about that attribute, so the workbench points at it.
                if let (true, jsonschema::error::ValidationErrorKind::Required { property }) =
                    (path.is_empty(), error.kind())
                {
                    path = property.as_str().unwrap_or_default().to_owned();
                }
                vec![Problem {
                    rule: rule.to_owned(),
                    path,
                    message,
                }]
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
        if let Some(ends) = self.ends.get(class) {
            let broken = relationship_problems(object, class, ends);
            // The relationship rule is the one the gateway answers with (DM-70): the schema's
            // own word on the same attribute (a list on a single end, a missing required one)
            // says less, so it gives way.
            problems.retain(|one| !broken.iter().any(|rule| rule.path == one.path));
            problems.extend(broken);
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
                "let prefix = \"urn:ngsi-ld:\" + this.type.string() + \":\"\n",
                "if !this.id.or(\"\").string().has_prefix($prefix) || this.id.or(\"\").string().length() <= $prefix.length() {\n",
                "  root = throw(\"the id is not an NGSI-LD URN of its type, urn:ngsi-ld:{type}:{id} (PF-43)\")\n",
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

/// Every stored end a class definition states: a property with `x-ngsi-ld-relationship` and a
/// `target`. An external reference (no target, DM-69) is not a relationship.
fn ends_of(definition: &Value) -> BTreeMap<String, End> {
    let required: Vec<&str> = definition
        .get("required")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    definition
        .get("properties")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(name, property)| {
            let target = property
                .pointer("/x-ngsi-ld-relationship/target")?
                .as_str()
                .filter(|target| !target.is_empty())?;
            Some((
                name.clone(),
                End {
                    target: target.to_owned(),
                    many: property.get("type").and_then(Value::as_str) == Some("array"),
                    required: required.contains(&name.as_str()),
                },
            ))
        })
        .collect()
}

/// The targets one attribute value names, in each form a write may use (normalized, concise, an
/// instance per `datasetId`, an `object` list); `None` for a null, which removes the attribute.
fn objects(value: &Value) -> Option<Vec<&str>> {
    match value {
        Value::Null => None,
        Value::String(text) if text == NGSI_LD_NULL => None,
        Value::Array(instances) => Some(
            instances
                .iter()
                .flat_map(|one| objects(one).unwrap_or_default())
                .collect(),
        ),
        Value::Object(member) => match member.get("object") {
            Some(Value::String(one)) if one == NGSI_LD_NULL => None,
            Some(Value::String(one)) => Some(vec![one.as_str()]),
            Some(Value::Array(many)) => Some(
                many.iter()
                    .filter_map(|one| match one {
                        Value::Object(inner) => inner
                            .get("object")
                            .or_else(|| inner.get("@id"))
                            .and_then(Value::as_str),
                        other => other.as_str(),
                    })
                    .collect(),
            ),
            _ => Some(Vec::new()),
        },
        _ => Some(Vec::new()),
    }
}

/// NGSI-LD's null, which deletes an attribute in a merge.
const NGSI_LD_NULL: &str = "urn:ngsi-ld:null";

/// The local name of a type written as an IRI, a CURIE or a plain name.
fn local(name: &str) -> &str {
    name.rsplit(['/', '#', ':']).next().unwrap_or(name)
}

/// The relationship rules a record breaks, as the gateway would refuse its write (DM-70): a
/// required end absent, a second target on a single end, a target of another class, read from
/// the id scheme (PF-10). `target-missing` needs a read as the writer, so the gateway alone
/// decides it. A record is a whole entity, so a required end must be there.
fn relationship_problems(
    object: &Map<String, Value>,
    class: &str,
    ends: &BTreeMap<String, End>,
) -> Vec<Problem> {
    let mut problems = Vec::new();
    for (slot, end) in ends {
        let target = &end.target;
        let named = object.get(slot).and_then(objects).unwrap_or_default();
        if named.is_empty() {
            if end.required {
                problems.push(problem(
                    "required-end-missing",
                    slot,
                    &format!("{slot} is required: every {class} points at a {target} (DM-70)"),
                ));
            }
            continue;
        }
        if !end.many && named.len() > 1 {
            problems.push(problem(
                "single-end-many-targets",
                slot,
                &format!(
                    "{slot} holds one {target}, and the record gives it {} (DM-70)",
                    named.len()
                ),
            ));
            continue;
        }
        let wrong = named.iter().position(|urn| {
            let mut parts = urn.splitn(4, ':');
            let kind = match (parts.next(), parts.next(), parts.next(), parts.next()) {
                (Some(urn), Some(ngsi), Some(kind), Some(_))
                    if urn.eq_ignore_ascii_case("urn") && ngsi.eq_ignore_ascii_case("ngsi-ld") =>
                {
                    Some(kind)
                }
                _ => None,
            };
            kind.map(local) != Some(local(target))
        });
        if let Some(index) = wrong {
            // The message names the target's place, never the URN: a record may carry anything.
            problems.push(problem(
                "target-wrong-type",
                slot,
                &format!(
                    "{slot} points at a {target}, and target {} of the record is not one (DM-70)",
                    index + 1
                ),
            ));
        }
    }
    problems
}

/// The id rule (PF-43, ADR-N-041): an NGSI-LD URN of the record's type. The rest of the id is the
/// mapping's to choose; the space is the output Endpoint's whatever the id says, and the gateway
/// checks its characters.
fn id_problems(object: &Map<String, Value>, class: &str) -> Vec<Problem> {
    let prefix = format!("urn:ngsi-ld:{class}:");
    match object.get("id").and_then(Value::as_str) {
        None => vec![problem("sh:minCount", "id", "the record has no id")],
        Some(id) if id.len() > prefix.len() && id.starts_with(&prefix) => Vec::new(),
        Some(_) => vec![problem(
            "id",
            "id",
            &format!("the id is not an NGSI-LD URN of its type, {prefix}{{id}} (PF-43)"),
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
            .check(record)
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
        assert!(fill.check(&valid()).is_empty());

        let mut record = valid();
        record["pm10"]["unitCode"] = json!("GP");
        let problems = fill.check(&record);
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
        assert!(fill.check(&missing).is_empty(), "the gateway fills it");
        let strict = with_unit(MissingUnitCode::Refuse).check(&missing);
        assert_eq!(strict.len(), 1, "{strict:?}");
        assert_eq!(strict[0].rule, "ngsi-ld:unitCode");
        assert!(
            strict[0].message.contains("has no unitCode"),
            "{}",
            strict[0].message
        );

        // A Relationship has no unit, whatever its slot says.
        assert!(with_unit(MissingUnitCode::Refuse)
            .check(&valid())
            .is_empty());
    }

    /// A model with every shape an attribute can take: a required quantity with its unit, a coded
    /// slot by `$ref`, a relationship with its target, a language map and a geometry.
    fn attributed() -> ModelSchema {
        ModelSchema::compile(
            "stations",
            "2.1.0",
            &json!({ "definitions": {
                "Status": { "enum": ["working", "closed"], "type": "string" },
                "Station": {
                    "description": "One docking station.",
                    "required": ["id", "type", "bikes"],
                    "properties": {
                        "id": { "type": "string" },
                        "type": { "type": "string" },
                        "bikes": { "type": ["integer", "null"], "minimum": 0, "description": "Free bikes.",
                                   "x-ngsi-ld-kind": "Property",
                                   "x-unit": { "exactMappings": ["ucefact:C62"], "ucumCode": "1" } },
                        "status": { "$ref": "#/definitions/Status", "x-ngsi-ld-kind": "Property" },
                        "refArea": { "type": ["string", "null"], "x-ngsi-ld-kind": "Relationship",
                                     "x-ngsi-ld-relationship": { "target": "AdministrativeArea" } },
                        "name": { "type": ["object", "null"], "x-ngsi-ld-kind": "LanguageProperty" },
                        "location": { "type": ["object", "null"], "x-ngsi-ld-kind": "GeoProperty" },
                        "seen": { "type": ["string", "null"], "format": "date-time", "x-ngsi-ld-kind": "Property" }
                    }
                }
            }}),
            &["Station".into(), "Draft".into()],
            false,
        )
    }

    /// T-3223: a type's attributes as an editor maps onto them, required first, identity left out.
    #[test]
    fn a_types_attributes_carry_kind_type_unit_values_and_target_required_first() {
        let listed = attributed()
            .attributes("Station")
            .expect("a class of the model");
        assert_eq!(
            (listed.model.as_str(), listed.version.as_str()),
            ("stations", "2.1.0")
        );
        assert_eq!(listed.description.as_deref(), Some("One docking station."));
        let names: Vec<&str> = listed.attributes.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(
            names,
            ["bikes", "location", "name", "refArea", "seen", "status"]
        );
        let bikes = &listed.attributes[0];
        assert!(bikes.required);
        assert_eq!(bikes.value_type.as_deref(), Some("integer"));
        assert_eq!(
            bikes.unit.as_ref().and_then(|u| u.code.as_deref()),
            Some("C62")
        );
        assert_eq!(bikes.minimum, Some(0.0));
        let by = |n: &str| listed.attributes.iter().find(|a| a.name == n).expect(n);
        assert_eq!(
            by("status").values.as_deref(),
            Some(&["working".to_owned(), "closed".to_owned()][..])
        );
        assert_eq!(by("status").value_type.as_deref(), Some("string"));
        assert_eq!(
            by("refArea")
                .relationship
                .as_ref()
                .map(|r| (r.target.as_str(), r.many)),
            Some(("AdministrativeArea", false))
        );
        assert_eq!(by("refArea").kind, "Relationship");
        assert_eq!(by("seen").format.as_deref(), Some("date-time"));
        // A type the model does not declare has no attributes; a draft class has its identity only.
        assert!(attributed().attributes("Bus").is_none());
        assert!(attributed()
            .attributes("Draft")
            .expect("declared")
            .attributes
            .is_empty());
    }

    /// T-3223, T-3224: a record in key-value form becomes the entity a write carries, and that
    /// entity passes the check the runner makes.
    #[test]
    fn a_key_value_record_normalizes_into_an_entity_the_check_accepts() {
        let model = attributed();
        let record = json!({
            "id": "urn:ngsi-ld:Station:hel.fi:bikes:1",
            "type": "Station",
            "bikes": 7,
            "status": "working",
            "refArea": "urn:ngsi-ld:AdministrativeArea:hel.fi:areas:1",
            "name": { "fi": "Kaivopuisto" },
            "location": { "type": "Point", "coordinates": [24.95, 60.16] },
            "seen": null
        });
        let entity = model.normalize("Station", &record);
        assert_eq!(
            entity["bikes"],
            json!({ "type": "Property", "value": 7, "unitCode": "C62" })
        );
        assert_eq!(entity["refArea"]["type"], "Relationship");
        assert_eq!(
            entity["refArea"]["object"],
            "urn:ngsi-ld:AdministrativeArea:hel.fi:areas:1"
        );
        assert_eq!(
            entity["name"],
            json!({ "type": "LanguageProperty", "languageMap": { "fi": "Kaivopuisto" } })
        );
        assert_eq!(entity["location"]["type"], "GeoProperty");
        assert!(
            entity.get("seen").is_none(),
            "NGSI-LD has no null attribute"
        );
        assert!(
            model.check(&entity).is_empty(),
            "{:?}",
            model.check(&entity)
        );
        // An entity already normalized passes through as it is.
        assert_eq!(model.normalize("Station", &entity), entity);
        // A record missing the required count is named at the attribute.
        let mut short = record.clone();
        short.as_object_mut().map(|r| r.remove("bikes"));
        let problems = model.check(&model.normalize("Station", &short));
        assert!(
            problems
                .iter()
                .any(|p| p.rule == "sh:minCount" && p.path == "bikes"),
            "{problems:?}"
        );
    }

    /// T-3223: an output whose type the target space's model lacks is named before any sample
    /// runs, at that output, with the classes the model does have.
    #[test]
    fn an_output_type_the_target_spaces_model_lacks_is_named_at_that_output() {
        use crate::resource::{ObjectMeta, ResourceEnvelope, API_VERSION};
        let mirror = crate::store::Mirror::new();
        for (name, space) in [("bikes-in", "bikes"), ("plain-in", "plain")] {
            mirror.upsert(ResourceEnvelope {
                api_version: API_VERSION.to_owned(),
                kind: "Endpoint".to_owned(),
                metadata: ObjectMeta {
                    name: name.to_owned(),
                    namespace: Some("helsinki".to_owned()),
                    ..Default::default()
                },
                spec: json!({ "contextSpaceRef": space, "slug": format!("{name}slug") }),
                status: None,
            });
        }
        let schemas = ModelSchemas::default();
        schemas.replace(HashMap::from([(
            ("helsinki".to_owned(), "bikes".to_owned()),
            Arc::new(attributed()),
        )]));
        let spec = |value: Value| -> jc_core::kinds::PipelineSpec {
            serde_json::from_value(value).expect("a pipeline spec")
        };
        let first = |entity_type: &str, endpoint: &str| {
            spec(json!({
                "class": "resident",
                "source": { "dataSourceRef": { "kind": "DataSource", "name": "feed" } },
                "compute": { "kind": "bloblang", "bloblang": "root = this" },
                "targetEndpoint": format!("urn:ngsi-ld:Endpoint:hel.fi:helsinki:{endpoint}"),
                "output": { "type": entity_type, "mode": "upsert" }
            }))
        };
        let problems =
            output_type_problems(&schemas, &mirror, "helsinki", &first("Bus", "bikes-in"));
        assert_eq!(problems.len(), 1, "{problems:?}");
        assert_eq!(
            (problems[0].rule.as_str(), problems[0].path.as_str()),
            ("type", "spec.output.type")
        );
        assert!(
            problems[0]
                .message
                .contains("Bus is not a class of the data model stations of space bikes"),
            "{}",
            problems[0].message
        );
        assert!(
            problems[0].message.contains("Draft, Station"),
            "{}",
            problems[0].message
        );
        // A class of the model, a space with no compiled model and an Endpoint nobody holds say
        // nothing; the runner's stage and the gateway still hold those.
        assert!(
            output_type_problems(&schemas, &mirror, "helsinki", &first("Station", "bikes-in"))
                .is_empty()
        );
        assert!(
            output_type_problems(&schemas, &mirror, "helsinki", &first("Bus", "plain-in"))
                .is_empty()
        );
        assert!(
            output_type_problems(&schemas, &mirror, "helsinki", &first("Bus", "gone")).is_empty()
        );
        // In the second shape the problem names the output it is about.
        let second = spec(json!({
            "class": "resident",
            "sources": [{ "dataSourceRef": { "kind": "DataSource", "name": "feed" } }],
            "steps": [{ "kind": "bloblang", "bloblang": "root = this" }],
            "outputs": [
                { "targetEndpoint": "urn:ngsi-ld:Endpoint:hel.fi:helsinki:bikes-in", "type": "Station" },
                { "targetEndpoint": "urn:ngsi-ld:Endpoint:hel.fi:helsinki:bikes-in", "type": "Tram" }
            ]
        }));
        let problems = output_type_problems(&schemas, &mirror, "helsinki", &second);
        assert_eq!(
            problems.iter().map(|p| p.path.as_str()).collect::<Vec<_>>(),
            ["spec.outputs[1].type"]
        );
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
        assert_eq!(
            rules(&record),
            [("sh:minCount".into(), "dateObserved".into())]
        );

        let mut record = valid();
        record["colour"] = json!({ "type": "Property", "value": "blue" });
        assert_eq!(rules(&record), [("sh:closed".into(), "colour".into())]);
        // Two of them are two problems, each naming its attribute (T-3223).
        record["shade"] = json!({ "type": "Property", "value": "dark" });
        assert_eq!(
            rules(&record),
            [
                ("sh:closed".into(), "colour".into()),
                ("sh:closed".into(), "shade".into())
            ]
        );

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
        // PF-43: an NGSI-LD URN of the record's type. Since ADR-N-041 its rest is the mapping's:
        // another organization's prefix, or none, is an id of this space like any other.
        for kept in [
            "urn:ngsi-ld:AirQualityObserved:hel.fi:helsinki:station-1",
            "urn:ngsi-ld:AirQualityObserved:Helsinki-001",
        ] {
            let mut record = valid();
            record["id"] = json!(kept);
            assert_eq!(rules(&record), Vec::<(String, String)>::new(), "{kept}");
        }
        for wrong in [
            "urn:ngsi-ld:WeatherObserved:banskabystrica.sk:ovzdusie:s1",
            "urn:ngsi-ld:AirQualityObserved:",
            "station-1",
        ] {
            let mut record = valid();
            record["id"] = json!(wrong);
            assert_eq!(rules(&record), [("id".into(), "id".into())], "{wrong}");
        }

        let mut record = valid();
        record["type"] = json!("Device");
        let problems = model(false).check(&record);
        assert_eq!(problems.len(), 1);
        assert_eq!(problems[0].rule, "type");
        assert!(problems[0].message.contains("bb-air-quality"));

        assert_eq!(rules(&json!([1])), [("sh:node".into(), String::new())]);
        assert_eq!(
            rules(&json!({ "id": "x" })),
            [("sh:minCount".into(), "type".into())]
        );
    }

    /// T-2861, DM-70: the workbench names each relationship rule a record breaks, the rule the
    /// gateway would refuse its write with, one row at a time, and never the URN it carried.
    #[test]
    fn a_broken_relationship_is_named_by_the_gateways_rule() {
        let schema = json!({ "definitions": { "User": {
            "properties": {
                "id": { "type": "string" },
                "school": { "type": "string", "x-ngsi-ld-kind": "Relationship", "x-ngsi-ld-relationship": { "target": "School" } },
                "courses": { "type": "array", "items": { "type": "string" }, "x-ngsi-ld-kind": "Relationship", "x-ngsi-ld-relationship": { "target": "Course" } },
                "homepage": { "type": "string", "x-ngsi-ld-kind": "Relationship" }
            },
            "required": ["id", "school"]
        } } });
        let model = ModelSchema::compile("learning", "1.0.0", &schema, &["User".to_owned()], false);
        let id = format!("urn:ngsi-ld:User:{DOMAIN}:{SPACE}:ana");
        let school = |local: &str| format!("urn:ngsi-ld:School:{DOMAIN}:{SPACE}:{local}");
        let rules = |record: Value| -> Vec<(String, String)> {
            model
                .check(&record)
                .into_iter()
                .map(|p| (p.rule, p.path))
                .collect()
        };
        let valid = json!({
            "id": id, "type": "User",
            "school": { "type": "Relationship", "object": school("north") },
            "courses": { "type": "Relationship", "object": [format!("urn:ngsi-ld:Course:{DOMAIN}:{SPACE}:math"), format!("urn:ngsi-ld:Course:{DOMAIN}:{SPACE}:art")] },
            "homepage": { "type": "Relationship", "object": "https://example.org/ana" }
        });
        assert_eq!(rules(valid.clone()), Vec::<(String, String)>::new());

        let mut missing = valid.clone();
        missing.as_object_mut().expect("an object").remove("school");
        assert_eq!(
            rules(missing),
            [("required-end-missing".into(), "school".into())]
        );

        let mut two = valid.clone();
        two["school"]["object"] = json!([school("north"), school("south")]);
        assert_eq!(
            rules(two),
            [("single-end-many-targets".into(), "school".into())]
        );

        let mut wrong = valid.clone();
        wrong["courses"]["object"][1] = json!(school("north"));
        let problems = model.check(&wrong);
        assert_eq!(problems.len(), 1, "{problems:?}");
        assert_eq!(
            (problems[0].rule.as_str(), problems[0].path.as_str()),
            ("target-wrong-type", "courses")
        );
        assert_eq!(
            problems[0].message,
            "courses points at a Course, and target 2 of the record is not one (DM-70)"
        );
        assert!(
            !problems[0].message.contains("urn:"),
            "{}",
            problems[0].message
        );

        // NGSI-LD's null empties the end: a required one is then missing.
        let mut cleared = valid;
        cleared["school"] = json!({ "type": "Relationship", "object": NGSI_LD_NULL });
        assert_eq!(
            rules(cleared),
            [("required-end-missing".into(), "school".into())]
        );
    }

    #[test]
    fn a_message_never_quotes_the_value() {
        let mut record = valid();
        record["pm10"]["value"] = json!("s3cr3t-looking-value");
        for problem in model(false).check(&record) {
            assert!(!problem.message.contains("s3cr3t"), "{problem:?}");
        }
    }

    #[test]
    fn an_open_model_takes_an_attribute_it_does_not_declare() {
        let mut record = valid();
        record["colour"] = json!({ "type": "Property", "value": "blue" });
        assert!(model(true).check(&record).is_empty());
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
        // The id rule asks for an NGSI-LD URN of the record's type and reads no space or
        // organization from it (ADR-N-041, PF-42).
        assert!(
            id_rule.contains("\"urn:ngsi-ld:\" + this.type.string() + \":\""),
            "{id_rule}"
        );
        assert!(
            !id_rule.contains("JC_ORG_DOMAIN") && !id_rule.contains("JC_SPACE"),
            "{id_rule}"
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
            air.check(&record)[0].rule,
            "sh:datatype",
            "the artifact was read"
        );

        let drafted = &compiled[&("ovzdusie".to_owned(), "draft".to_owned())];
        let loose = json!({ "id": "urn:ngsi-ld:AirQualityObserved:banskabystrica.sk:draft:1", "type": "AirQualityObserved", "anything": { "type": "Property", "value": 1 } });
        assert!(
            drafted.check(&loose).is_empty(),
            "a draft holds its types and ids only"
        );
        let mut wrong = loose.clone();
        wrong["type"] = json!("Device");
        assert_eq!(drafted.check(&wrong)[0].rule, "type");
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
