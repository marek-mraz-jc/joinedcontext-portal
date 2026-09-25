//! The operations that compute an answer and write nothing: the catalogue search, a KPI, a pipeline
//! test and a model inferred from a sample (AG-58, AG-62, PL-38, DM-10).

use super::bounds;
use super::drafts::DraftRef;
use super::proposals::own_draft;
use super::proposals::record_verdict;
use super::serde_error_path_and_message;
use super::OpError;
use super::Operation;
use super::OperationAnnotations;
use super::{draft_store, Finding, Level, Verdict};
use crate::agents::kpi;
use crate::api::assistant;
use crate::api::pipeline_test;
use crate::change::Lane;
use crate::error::ApiError;
use crate::tools::model_tools;
use base64::Engine as _;
use jc_core::kinds::Verb;
use jcctl::pipeline_test::Sample;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CatalogSearchInput {
    #[serde(default)]
    pub q: Option<String>,
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KpiComputeInput {
    pub name: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(rename = "type")]
    pub entity_type: String,
    #[serde(default)]
    pub attribute: String,
    pub agg: kpi::Agg,
    #[serde(default)]
    pub unit: Option<String>,
    #[serde(default)]
    pub q: Option<String>,
    #[serde(default)]
    pub rows: Option<Vec<Value>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PipelineTestInput {
    #[serde(default)]
    pub pipeline: Option<Value>,
    pub sample: Sample,
    #[serde(default)]
    pub draft: Option<DraftRef>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ModelInferInput {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub sample: Option<String>,
    #[serde(default)]
    pub format: Option<String>,
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

fn catalog_search_input_schema() -> Value {
    use bounds::*;
    json!({
        "type": "object",
        "properties": {
            "q": text("Search keywords, matched against names, titles and descriptions", QUERY),
            "query": text("The same as q, for clients that name it query; q wins when both are set", QUERY),
            "scope": text("Narrow to one kind: ContextSpace, Endpoint or DataModel", TERM)
        },
        "additionalProperties": false
    })
}

fn catalog_output_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "q": { "type": "string" },
            "items": { "type": "array", "items": { "type": "object" } }
        }
    })
}

fn kpi_input_schema() -> Value {
    use bounds::*;
    json!({
        "type": "object",
        "properties": {
            "name": text("The indicator's name, the {localId} of its URN", NAME),
            "title": text("The indicator's title as people read it", TITLE),
            "type": text("The entity type the value is computed over", TERM),
            "attribute": text("The attribute folded; ignored by count", TERM),
            "agg": {
                "type": "string",
                "description": "How the attribute's values are folded into one",
                "enum": ["avg", "sum", "count", "min", "max"]
            },
            "unit": text("A UN/CEFACT common code for the value", TERM),
            "q": text("An NGSI-LD q narrowing the entities read", QUERY),
            "rows": {
                "type": "array",
                "description": "The entities to compute over, when the caller already holds them",
                "items": { "type": "object", "maxProperties": RECORD_MEMBERS }
            }
        },
        "required": ["name", "type", "agg"],
        "additionalProperties": false
    })
}

fn pipeline_test_input_schema() -> Value {
    use bounds::*;
    json!({
        "type": "object",
        "properties": {
            "pipeline": manifest("The Pipeline manifest to run; give this or draft"),
            "sample": {
                "type": "object",
                "description": "What the pipeline is run on: the sample inline or a URL to fetch it from",
                "properties": {
                    "text": text(
                        "The sample inline",
                        jcctl::pipeline_test::MAX_SAMPLE_BYTES as u64
                    ),
                    "url": text("An http(s) URL the runner fetches the sample from instead", URL),
                    "format": {
                        "type": "string",
                        "description": "How the sample is split into messages",
                        "enum": ["csv", "json", "text"]
                    }
                },
                "additionalProperties": false
            },
            "draft": draft_ref()
        },
        "required": ["sample"],
        "additionalProperties": false
    })
}

fn model_infer_input_schema() -> Value {
    use bounds::*;
    let sample_bytes = crate::tools::model_tools::MAX_SAMPLE_BYTES as u64;
    json!({
        "type": "object",
        "properties": {
            "name": text("The name to give the inferred model", NAME),
            "content": text("The sample file, base64 encoded", sample_bytes.div_ceil(3) * 4),
            "sample": text("The sample as plain text, instead of content", sample_bytes),
            "format": {
                "type": "string",
                "description": "The sample's format",
                "enum": ["csv", "xlsx", "json", "pdf"]
            }
        },
        "additionalProperties": false
    })
}

fn pipeline_test_output_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "input": { "type": "object" },
            "mapping": { "type": "array" },
            "validation": { "type": "array" },
            "errors": { "type": "array" },
            "verdict": { "type": "object" }
        }
    })
}

/// The candidate pipeline of a call: the inline manifest, or the saved draft it names, and the
/// draft a verdict is recorded on. The pipeline test and the workbench's steps read it the same
/// way (ADR-N-034).
pub(super) async fn candidate(
    state: &crate::state::AppState,
    project: &str,
    pipeline: Option<Value>,
    draft: Option<&DraftRef>,
) -> Result<(Value, Option<DraftRef>), OpError> {
    match (pipeline, draft) {
        (Some(p), Some(d)) => Ok((p, Some(d.clone()))),
        (None, Some(d)) => {
            let saved = draft_store(state)
                .get(project, &d.kind, &d.name)
                .await
                .map_err(|e| OpError::Api(ApiError::Internal(e.to_string())))?
                .ok_or_else(|| {
                    ApiError::NotFound(format!(
                        "draft '{}/{}' not found in project '{project}'",
                        d.kind, d.name
                    ))
                })?;
            Ok((saved.manifest, Some(d.clone())))
        }
        (Some(p), None) => {
            let own = own_draft(&p);
            Ok((p, own))
        }
        (None, None) => Err(OpError::InvalidInput {
            path: "/pipeline".into(),
            message: "either pipeline or draft is required".into(),
        }),
    }
}

/// This module's operations in the registry (`super::init_registry`).
pub fn operations() -> Vec<Operation> {
    vec![        Operation {
            name: "jc_catalog_search",
            title: "Search Catalog",
            description: "Find spaces, endpoints, and data models matching search keywords",
            input: catalog_search_input_schema,
            output: catalog_output_schema,
            annotations: OperationAnnotations {
                read_only_hint: true,
                destructive_hint: false,
                idempotent_hint: true,
            },
            kind: "*",
            verb: None,
            lane: Lane::Green,
            validate: |val| {
                serde_json::from_value::<CatalogSearchInput>(val.clone())
                    .map(|_| ())
                    .map_err(|e| {
                        let (path, message) = serde_error_path_and_message(&e);
                        OpError::InvalidInput { path, message }
                    })
            },
            run: |_, state, project, val| {
                Box::pin(async move {
                    let input: CatalogSearchInput = serde_json::from_value(val).map_err(|e| {
                        let (path, message) = serde_error_path_and_message(&e);
                        OpError::InvalidInput { path, message }
                    })?;
                    let q = input.q.or(input.query).unwrap_or_default();
                    let q = q.trim();
                    if q.is_empty() {
                        return Err(OpError::Api(ApiError::BadRequest(
                            "q must not be empty".into(),
                        )));
                    }
                    let scope = input
                        .scope
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty());
                    let res = assistant::search(state, project, q, scope).await;
                    Ok(serde_json::to_value(res)?)
                })
            },
        },        Operation {
            name: "jc_kpi_compute",
            title: "Compute KPI",
            description: "Folds an attribute over context entities and renders a KeyPerformanceIndicator entity",
            input: kpi_input_schema,
            output: || json!({ "type": "object" }),
            annotations: OperationAnnotations {
                read_only_hint: true,
                destructive_hint: false,
                idempotent_hint: true,
            },
            kind: "Endpoint",
            verb: None,
            lane: Lane::Green,
            validate: |val| {
                serde_json::from_value::<KpiComputeInput>(val.clone())
                    .map(|_| ())
                    .map_err(|e| {
                        let (path, message) = serde_error_path_and_message(&e);
                        OpError::InvalidInput { path, message }
                    })
            },
            run: |_, state, project, val| {
                Box::pin(async move {
                    let input: KpiComputeInput = serde_json::from_value(val).map_err(|e| {
                        let (path, message) = serde_error_path_and_message(&e);
                        OpError::InvalidInput { path, message }
                    })?;
                    let params = kpi::ComputeKpi {
                        name: input.name,
                        title: input.title,
                        entity_type: input.entity_type,
                        attribute: input.attribute,
                        agg: input.agg,
                        unit: input.unit,
                        q: input.q,
                        endpoint: None,
                    };
                    let rows = input.rows.unwrap_or_default();
                    let (computed_val, _) = kpi::compute(&rows, &params.attribute, params.agg);
                    let org_domain = assistant::org_domain(state, project);
                    let (ep_slug, ep_name) = kpi::kpi_endpoint(state, project)
                        .unwrap_or_else(|| (format!("{project}-kpi"), format!("{project}-kpi")));
                    let now = chrono::Utc::now().to_rfc3339();
                    let prov = kpi::Provenance {
                        org_domain: &org_domain,
                        project,
                        endpoint_space: &ep_slug,
                        endpoint_name: &ep_name,
                        run_id: "ops",
                        now: &now,
                    };
                    let entity = kpi::entity(&params, computed_val.unwrap_or(0.0), &prov)
                        .map_err(ApiError::BadRequest)?;
                    Ok(entity.to_json())
                })
            },
        },        Operation {
            name: "jc_pipeline_test",
            title: "Pipeline Test",
            description: "Tests candidate pipeline mapping and validation on runner without writing",
            input: pipeline_test_input_schema,
            output: pipeline_test_output_schema,
            annotations: OperationAnnotations {
                read_only_hint: true,
                destructive_hint: false,
                idempotent_hint: true,
            },
            kind: "Pipeline",
            verb: Some(Verb::Propose),
            lane: Lane::Green,
            validate: |val| {
                let input: PipelineTestInput = serde_json::from_value(val.clone()).map_err(|e| {
                    let (path, message) = serde_error_path_and_message(&e);
                    OpError::InvalidInput { path, message }
                })?;
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
                    let input: PipelineTestInput =
                        serde_json::from_value(val).map_err(|e| {
                            let (path, message) = serde_error_path_and_message(&e);
                            OpError::InvalidInput { path, message }
                        })?;
                    let (pipeline, draft_ref) =
                        candidate(state, project, input.pipeline, input.draft.as_ref()).await?;

                    let req = pipeline_test::TestRequest {
                        pipeline: pipeline.clone(),
                        sample: input.sample,
                    };
                    let trace = pipeline_test::execute_test_pipeline(
                        &caller.identity,
                        state,
                        project,
                        req,
                    )
                    .await?;

                    let ok = trace.errors.is_empty()
                        && !trace.validation.is_empty()
                        && trace.validation.iter().all(|v| v.ok);
                    let mut findings = Vec::new();
                    for err in &trace.errors {
                        findings.push(Finding {
                            level: Level::Error,
                            path: err.stage.clone(),
                            message: err.message.clone(),
                        });
                    }
                    for val in &trace.validation {
                        if !val.ok {
                            for problem in &val.problems {
                                findings.push(Finding {
                                    level: Level::Error,
                                    path: format!("validation[{}]", val.index),
                                    message: problem.clone(),
                                });
                            }
                        }
                    }
                    let verdict = Verdict::new(
                        ok,
                        findings,
                        Some(serde_json::to_value(&trace).unwrap_or_default()),
                        &pipeline,
                    );
                    if let Some(d) = &draft_ref {
                        record_verdict(caller, state, project, d, &pipeline, &verdict).await;
                    }
                    let mut out = serde_json::to_value(&trace)?;
                    out["verdict"] = serde_json::to_value(&verdict)?;
                    Ok(out)
                })
            },
        },        Operation {
            name: "jc_model_infer",
            title: "Infer Schema",
            description: "Infers a draft LinkML data model from sample data bytes or text",
            input: model_infer_input_schema,
            output: || json!({ "type": "object" }),
            annotations: OperationAnnotations {
                read_only_hint: true,
                destructive_hint: false,
                idempotent_hint: true,
            },
            kind: "DataModel",
            verb: None,
            lane: Lane::Green,
            validate: |val| {
                serde_json::from_value::<ModelInferInput>(val.clone())
                    .map(|_| ())
                    .map_err(|e| {
                        let (path, message) = serde_error_path_and_message(&e);
                        OpError::InvalidInput { path, message }
                    })
            },
            run: |_, state, _, val| {
                Box::pin(async move {
                    let input: ModelInferInput = serde_json::from_value(val).map_err(|e| {
                        let (path, message) = serde_error_path_and_message(&e);
                        OpError::InvalidInput { path, message }
                    })?;
                    let bytes = if let Some(b64) = input.content {
                        base64::engine::general_purpose::STANDARD
                            .decode(b64)
                            .map_err(|e| OpError::InvalidInput {
                                path: "/content".into(),
                                message: format!("invalid base64 content: {e}"),
                            })?
                    } else if let Some(text) = input.sample {
                        text.into_bytes()
                    } else {
                        return Err(OpError::InvalidInput {
                            path: "/content".into(),
                            message: "either content (base64) or sample (text) is required".into(),
                        });
                    };
                    let res = model_tools::infer_schema_from_bytes(
                        state,
                        input.name.as_deref(),
                        &bytes,
                        input.format.as_deref(),
                    )
                    .await?;
                    Ok(res)
                })
            },
        },
    ]
}
