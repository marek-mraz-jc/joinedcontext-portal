//! The workbench's steps as operations of the registry (ADR-N-034 §3.5, PL-63, AG-89): the
//! source's sample, the mapping tried on it and the records checked against the target space's
//! model. The workbench calls them through `POST /api/v1/projects/{project}/ops/{name}`, MCP and
//! the assistant through the registry, so a person, an agent and the assistant see the same
//! output for the same input. The fourth step, the save, is `jc_pipeline_propose`.
//!
//! Nothing here writes: the sample and the mapping run as the throwaway harness stream of a
//! pipeline test (PL-43, MF-38) and resolve no `secretRef`; the check is the one the runner's
//! validation stage renders (PL-60).

use super::bounds;
use super::compute::candidate;
use super::drafts::DraftRef;
use super::parse_input;
use super::{OpError, Operation, OperationAnnotations};
use crate::api::pipeline_test;
use crate::change::Lane;
use crate::error::ApiError;
use crate::pipeline_validation::Problem;
use crate::state::AppState;
use jc_core::kinds::{PipelineSpec, Verb};
use jcctl::pipeline_test::{Sample, MAX_MESSAGES};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

/// The most records one validation takes: a page of the workbench's mapped output.
pub const MAX_RECORDS: usize = 100;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SampleSourceInput {
    #[serde(default)]
    data_source: Option<String>,
    #[serde(default)]
    sample: Option<Sample>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TryMappingInput {
    #[serde(default)]
    pipeline: Option<Value>,
    sample: Sample,
    #[serde(default)]
    draft: Option<DraftRef>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ValidateInput {
    #[serde(default)]
    pipeline: Option<Value>,
    #[serde(default)]
    draft: Option<DraftRef>,
    #[serde(default)]
    space: Option<String>,
    /// A type of the space's model: the answer lists which of its attributes the pipeline may
    /// write through its Endpoint (T-4842).
    #[serde(default, rename = "type")]
    entity_type: Option<String>,
    records: Vec<Value>,
}

/// One record's verdict against the model.
#[derive(Debug, Serialize)]
struct RecordVerdict {
    index: usize,
    ok: bool,
    problems: Vec<Problem>,
    /// Where its write is judged (T-4840): the Endpoint, each finding from the model, the
    /// Endpoint and the lifetime, and the ends the record would be written with.
    #[serde(skip_serializing_if = "Option::is_none")]
    endpoint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    findings: Option<Vec<crate::record_check::Finding>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires: Option<crate::record_check::Expires>,
}

fn sample_schema() -> Value {
    use bounds::*;
    json!({
        "type": "object",
        "description": "The sample inline or a URL the runner fetches it from, and how it is split",
        "properties": {
            "text": text("The sample inline", jcctl::pipeline_test::MAX_SAMPLE_BYTES as u64),
            "url": text("An http(s) URL the runner fetches the sample from instead", URL),
            "format": {
                "type": "string",
                "description": "How the sample is split into records",
                "enum": ["csv", "json", "text"]
            }
        },
        "additionalProperties": false
    })
}

fn sample_source_input_schema() -> Value {
    use bounds::*;
    json!({
        "type": "object",
        "properties": {
            "dataSource": text("The DataSource of this project to read the first records of; give this or sample", NAME),
            "sample": sample_schema()
        },
        "additionalProperties": false
    })
}

fn sample_source_output_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "records": { "type": "array", "description": "The first records the source answered, at most 20" },
            "fields": { "type": "array", "items": { "type": "string" }, "description": "Every field of those records, once each, in name order" },
            "count": { "type": "integer" },
            "truncated": { "type": "boolean", "description": "Whether the source answered more than the records shown" },
            "errors": { "type": "array", "description": "What the fetch or the parse said, when it failed" }
        }
    })
}

fn try_mapping_input_schema() -> Value {
    use bounds::*;
    json!({
        "type": "object",
        "properties": {
            "pipeline": manifest("The Pipeline manifest whose steps are tried; give this or draft"),
            "sample": sample_schema(),
            "draft": draft_ref()
        },
        "required": ["sample"],
        "additionalProperties": false
    })
}

fn try_mapping_output_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "input": { "type": "object", "description": "What the runner read: events, bytes and the first record" },
            "records": { "type": "array", "description": "Each record as the pipeline would write it" },
            "errors": { "type": "array", "description": "Each failure with its stage, the step and the line of the mapping" }
        }
    })
}

fn validate_input_schema() -> Value {
    use bounds::*;
    json!({
        "type": "object",
        "properties": {
            "pipeline": manifest("The Pipeline whose target space's model checks the records; give this, draft or space"),
            "draft": draft_ref(),
            "space": text("The ContextSpace whose model checks the records, instead of a pipeline's", NAME),
            "type": text("With a pipeline or draft: an entity type of the space's model; the answer's writable lists each of its attributes and whether the pipeline may write it through its Endpoint", NAME),
            "records": {
                "type": "array",
                "description": "The records as the pipeline would write them (the records of jc_pipeline_try_mapping)",
                "maxItems": MAX_RECORDS,
                "items": { "type": "object", "maxProperties": RECORD_MEMBERS }
            }
        },
        "required": ["records"],
        "additionalProperties": false
    })
}

fn validate_output_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "space": { "type": "string" },
            "model": { "type": "string" },
            "version": { "type": "string" },
            "valid": { "type": "integer" },
            "rejected": { "type": "integer" },
            "writable": {
                "type": "array",
                "description": "With type: each attribute of the type, whether the pipeline may write it through its Endpoint and, when not, why (T-4842)",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": { "type": "string" },
                        "writable": { "type": "boolean" },
                        "reason": { "type": "string" }
                    }
                }
            },
            "verdicts": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "index": { "type": "integer" },
                        "ok": { "type": "boolean" },
                        "problems": { "type": "array", "description": "Each rule broken: its SHACL component, the attribute and why" },
                        "endpoint": { "type": "string", "description": "The Endpoint the record is written through" },
                        "findings": { "type": "array", "description": "Each reason the record would not be written: its source (model, endpoint, lifetime), rule, field and reason (T-4840)" },
                        "expires": { "type": "object", "description": "The expiresAt of the entity and of each attribute the record would be written with" }
                    }
                }
            }
        }
    })
}

/// A spec with no steps: the harness then answers the source's records as it read them.
fn no_steps() -> Result<PipelineSpec, OpError> {
    serde_json::from_value(json!({
        "class": "auto",
        "targetEndpoint": "urn:ngsi-ld:Endpoint:probe.local:probe:probe"
    }))
    .map_err(|e| OpError::Api(ApiError::Internal(format!("the sampling spec: {e}"))))
}

/// The sample a DataSource of this project gives: its feed fetched once, as a DataSource Check
/// fetches it (MF-39). A source with a credential or one that streams has no sample a dry run
/// may read, and the answer says what to give instead.
fn sample_of_data_source(
    state: &AppState,
    project: &str,
    name: &str,
) -> Result<(Sample, PipelineSpec), OpError> {
    let source = state
        .mirror
        .get(project, "DataSource", name)
        .ok_or_else(|| {
            ApiError::NotFound(format!(
                "DataSource '{name}' not found in project '{project}'"
            ))
        })?;
    let instead = "give the sample as text (a file of the feed) or as a URL instead";
    match pipeline_test::probe_plan(&source.spec) {
        Some(Ok(url)) => pipeline_test::sampling(&source.spec, url)
            .map_err(|e| OpError::Api(ApiError::Internal(format!("the sampling spec: {e}")))),
        Some(Err(skipped)) => Err(OpError::Api(ApiError::BadRequest(format!(
            "DataSource '{name}' cannot be sampled: {}; {instead}",
            skipped.skipped.unwrap_or_default()
        )))),
        None => Err(OpError::Api(ApiError::BadRequest(format!(
            "DataSource '{name}' is of type {}, which streams rather than answers a request; {instead}",
            source.spec["type"].as_str().unwrap_or("unknown")
        )))),
    }
}

/// Every field of the records, once each, in name order.
fn fields_of(records: &[Value]) -> Vec<String> {
    records
        .iter()
        .filter_map(Value::as_object)
        .flat_map(Map::keys)
        .cloned()
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect()
}

/// The model of the space the records land in, with the space's segment for the id rule.
fn target(
    state: &AppState,
    project: &str,
    space: Option<String>,
    pipeline: Option<&Value>,
) -> Result<
    (
        String,
        std::sync::Arc<crate::pipeline_validation::ModelSchema>,
    ),
    OpError,
> {
    let space = match (space, pipeline) {
        (Some(space), _) => space,
        (None, Some(pipeline)) => {
            crate::api::internal::pipeline_rejected::target_space(state, project, &pipeline["spec"])
                .ok_or_else(|| {
                    ApiError::BadRequest(
                "the pipeline writes through no Endpoint of this project, so it has no target \
                 space; name its targetEndpoint or give space"
                    .into(),
            )
                })?
        }
        (None, None) => {
            return Err(OpError::InvalidInput {
                path: "/space".into(),
                message: "give pipeline, draft or space: the records are checked against the \
                          model of the space they land in"
                    .into(),
            })
        }
    };
    state
        .mirror
        .get(project, "ContextSpace", &space)
        .ok_or_else(|| {
            ApiError::NotFound(format!(
                "ContextSpace '{space}' not found in project '{project}'"
            ))
        })?;
    let schema = state.model_schemas.get(project, &space).ok_or_else(|| {
        OpError::Conflict(json!({
            "error": "no_model",
            "space": space,
            "detail": format!(
                "space '{space}' names no data model, so nothing checks what lands in it; name \
                 its model in spec.dataModelRef (DM-61)"
            ),
        }))
    })?;
    Ok((space, schema))
}

/// This module's operations in the registry (`super::init_registry`).
pub fn operations() -> Vec<Operation> {
    vec![
        Operation {
            name: "jc_pipeline_sample_source",
            title: "Sample a Pipeline Source",
            description: "Reads the first records of a DataSource, or of a sample file or URL, on the project's runner: the records, their fields and the count (the workbench's sample step, ADR-N-034)",
            input: sample_source_input_schema,
            output: sample_source_output_schema,
            annotations: OperationAnnotations {
                read_only_hint: true,
                destructive_hint: false,
                idempotent_hint: true,
            },
            kind: "Pipeline",
            verb: Some(Verb::Propose),
            lane: Lane::Green,
            validate: |val| {
                let input: SampleSourceInput = parse_input(val.clone())?;
                match (&input.data_source, &input.sample) {
                    (Some(_), None) | (None, Some(_)) => Ok(()),
                    _ => Err(OpError::InvalidInput {
                        path: "/dataSource".into(),
                        message: "give exactly one of dataSource and sample".into(),
                    }),
                }
            },
            run: |_caller, state, project, val| {
                Box::pin(async move {
                    let input: SampleSourceInput = parse_input(val)?;
                    let (sample, plan) = match (input.data_source, input.sample) {
                        (Some(name), None) => sample_of_data_source(state, project, &name)?,
                        (None, Some(sample)) => (sample, no_steps()?),
                        _ => {
                            return Err(OpError::InvalidInput {
                                path: "/dataSource".into(),
                                message: "give exactly one of dataSource and sample".into(),
                            })
                        }
                    };
                    let trace =
                        pipeline_test::run_harness(state, project, &plan, &sample).await?;
                    let fields = fields_of(&trace.mapping);
                    Ok(json!({
                        "count": trace.mapping.len(),
                        "truncated": trace.mapping.len() >= MAX_MESSAGES,
                        "fields": fields,
                        "records": trace.mapping,
                        "errors": trace.errors,
                    }))
                })
            },
        },
        Operation {
            name: "jc_pipeline_try_mapping",
            title: "Try a Pipeline Mapping",
            description: "Runs a candidate pipeline's steps over a sample on the project's runner without writing: each record as it would be written and every failure at its step and line (the workbench's mapped output, ADR-N-034); the record check of what it made is kept on the draft for its proposal (T-4840)",
            input: try_mapping_input_schema,
            output: try_mapping_output_schema,
            annotations: OperationAnnotations {
                read_only_hint: true,
                destructive_hint: false,
                idempotent_hint: true,
            },
            kind: "Pipeline",
            verb: Some(Verb::Propose),
            lane: Lane::Green,
            validate: |val| {
                let input: TryMappingInput = parse_input(val.clone())?;
                if input.pipeline.is_none() && input.draft.is_none() {
                    return Err(OpError::InvalidInput {
                        path: "/pipeline".into(),
                        message: "either pipeline or draft is required".into(),
                    });
                }
                Ok(())
            },
            run: |caller, state, project, val| {
                Box::pin(async move {
                    let input: TryMappingInput = parse_input(val)?;
                    let (pipeline, draft) =
                        candidate(state, project, input.pipeline, input.draft.as_ref()).await?;
                    let trace = pipeline_test::execute_test_pipeline(
                        &caller.identity,
                        state,
                        project,
                        pipeline_test::TestRequest {
                            pipeline: pipeline.clone(),
                            sample: input.sample,
                        },
                    )
                    .await?;
                    // The records the mapping made, judged where their write is: the record
                    // check a proposal needs (T-4840), kept beside the draft's own verdict.
                    if let Some(draft) = draft {
                        let checked = crate::record_check::check_trace(
                            state,
                            project,
                            &pipeline,
                            &trace.mapping,
                        )?;
                        let shown = &trace.mapping
                            [..trace.mapping.len().min(crate::record_check::MAX_RECORDS)];
                        let mut records = checked.verdict(&pipeline, shown);
                        records.ok &= trace.errors.is_empty();
                        crate::ops::proposals::record_records(
                            caller, state, project, &draft, &pipeline, records,
                        )
                        .await;
                    }
                    Ok(json!({
                        "input": trace.input,
                        "records": trace.mapping,
                        "errors": trace.errors,
                    }))
                })
            },
        },
        Operation {
            name: "jc_pipeline_validate",
            title: "Validate Pipeline Records",
            description: "Checks records where a pipeline's write is judged: the data model of the space it writes into (the runner's validation stage), the target Endpoint's Policies and view, and the lifetime: a verdict per record with each finding and the expiresAt it would get (the workbench's validation step, PL-59, ADR-N-034, T-4840)",
            input: validate_input_schema,
            output: validate_output_schema,
            annotations: OperationAnnotations {
                read_only_hint: true,
                destructive_hint: false,
                idempotent_hint: true,
            },
            kind: "Pipeline",
            verb: Some(Verb::Read),
            lane: Lane::Green,
            validate: |val| {
                let input: ValidateInput = parse_input(val.clone())?;
                if input.records.len() > MAX_RECORDS {
                    return Err(OpError::InvalidInput {
                        path: "/records".into(),
                        message: format!("at most {MAX_RECORDS} records at a time"),
                    });
                }
                Ok(())
            },
            run: |_caller, state, project, val| {
                Box::pin(async move {
                    let input: ValidateInput = parse_input(val)?;
                    let pipeline = match (input.pipeline, input.draft.as_ref()) {
                        (None, None) => None,
                        (pipeline, draft) => Some(candidate(state, project, pipeline, draft).await?),
                    };
                    let (space, schema) =
                        target(state, project, input.space, pipeline.as_ref().map(|p| &p.0))?;
                    // With a pipeline, each record is judged where its write is (T-4840); with a
                    // space alone, by the model only. Records a caller types prove nothing about
                    // the mapping, so no verdict is kept here: only the harness run
                    // (jc_pipeline_test) sets the record check a proposal needs.
                    let checked = match &pipeline {
                        Some((manifest, _)) => Some(crate::record_check::check_records(
                            state,
                            project,
                            manifest,
                            &input.records,
                            chrono::Utc::now(),
                        )?),
                        None => None,
                    };
                    let verdicts: Vec<RecordVerdict> = input
                        .records
                        .iter()
                        .enumerate()
                        .map(|(index, record)| {
                            let problems = schema.check(record);
                            let check = checked.as_ref().map(|c| c.records[index].clone());
                            RecordVerdict {
                                index,
                                ok: check.as_ref().map_or(problems.is_empty(), |c| c.ok),
                                problems,
                                endpoint: check.as_ref().and_then(|c| c.endpoint.clone()),
                                expires: check.as_ref().and_then(|c| c.expires.clone()),
                                findings: check.map(|c| c.findings),
                            }
                        })
                        .collect();
                    let valid = verdicts.iter().filter(|v| v.ok).count();
                    let mut answer = json!({
                        "space": space,
                        "model": schema.model,
                        "version": schema.version,
                        "valid": valid,
                        "rejected": verdicts.len() - valid,
                        "verdicts": verdicts,
                    });
                    if let (Some(entity_type), Some((manifest, _))) = (&input.entity_type, &pipeline) {
                        answer["writable"] = json!(writable_of(state, project, manifest, &schema, entity_type)?);
                    }
                    Ok(answer)
                })
            },
        },
    ]
}

/// Each attribute of `entity_type` in the space's model, as the pipeline may write it (T-4842).
fn writable_of(
    state: &AppState,
    project: &str,
    pipeline: &Value,
    schema: &crate::pipeline_validation::ModelSchema,
    entity_type: &str,
) -> Result<Vec<crate::record_check::Writable>, OpError> {
    let class = schema
        .attributes(entity_type)
        .ok_or_else(|| OpError::InvalidInput {
            path: "/type".into(),
            message: format!(
                "{entity_type} is not a class of the space's data model {}",
                schema.model
            ),
        })?;
    let names: Vec<String> = class.attributes.into_iter().map(|a| a.name).collect();
    Ok(crate::record_check::writable(
        state,
        project,
        pipeline,
        entity_type,
        &names,
        chrono::Utc::now(),
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fields_are_every_key_once_in_name_order() {
        let records = [
            json!({ "station": "01", "pm10": 18.2 }),
            json!("not an object"),
            json!({ "pm10": 3, "no2": 4 }),
        ];
        assert_eq!(fields_of(&records), ["no2", "pm10", "station"]);
        assert!(fields_of(&[]).is_empty());
    }
}
