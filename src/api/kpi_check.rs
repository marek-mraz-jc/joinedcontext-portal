//! Checking a KPI over several sources as it is typed (API/01 §55, PL-102…PL-105, T-4935).
//!
//! The KPI editor sends its `v1alpha2` Pipeline draft on every pause in typing. The answer names
//! each field jc-core refuses and why, with the units the sources' space models give, and says
//! of each source whether the pipeline's account may read it yet (a source it cannot read is
//! asked for with PL-90 once the pipeline exists). `preview: true` reads each source Endpoint's
//! current page as the person, the filter preview's way (EP-85), and computes the indicator with
//! jc-core's reference evaluator. Nothing is stored or written.

use std::collections::BTreeMap;

use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, State};
use axum::routing::post;
use axum::{Json, Router};
use jc_core::kinds::{PipelineSource, PipelineSpec, Step, Verb};
use jc_core::kpi_join::{Expr, Input, KpiStep};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

use crate::access_requests::{already_granted, Operations, TypeGrant};
use crate::auth::{CurrentUser, Identity};
use crate::error::ApiError;
use crate::resource::is_dns1123;
use crate::state::AppState;
use crate::store::ListOptions;

/// The rows one source's preview page holds: the broker's view preview bound.
const PAGE: u32 = 100;

/// The body of `POST …/kpis/check`.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct KpiCheckRequest {
    /// The draft `joinedcontext.com/v1alpha2` Pipeline with one `kpi` step.
    #[schema(value_type = std::collections::HashMap<String, serde_json::Value>)]
    pub pipeline: Value,
    /// Also compute the indicator on the sources' current pages.
    #[serde(default)]
    pub preview: bool,
}

/// One field jc-core refuses, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct KpiProblem {
    /// The manifest path at fault, `spec.steps.kpi.formula`.
    pub field: String,
    /// The rule it breaks, in words.
    pub reason: String,
}

/// What the editor knows of one source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct KpiSource {
    /// The source's `name`, the input's name in the formula.
    pub name: String,
    /// The source Endpoint.
    pub endpoint: String,
    /// Whether the pipeline's account reads the source's type through the Endpoint now: a
    /// Policy grants it, or the Endpoint is public (PL-55, PL-90).
    pub readable: bool,
}

/// One computed indicator.
#[derive(Debug, Clone, PartialEq, Serialize, ToSchema)]
pub struct KpiValue {
    /// The entity or area key; absent for a join by time.
    pub key: Option<String>,
    /// The indicator's `{localId}`.
    pub name: String,
    pub value: f64,
}

impl From<jc_core::kpi_join::Computed> for KpiValue {
    fn from(c: jc_core::kpi_join::Computed) -> Self {
        Self {
            key: c.key,
            name: c.name,
            value: c.value,
        }
    }
}

/// The indicator on the sources' current pages.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct KpiPreview {
    /// One value per key, one for a join by time.
    pub values: Vec<KpiValue>,
    /// The rows each source's page held, at most 100.
    pub rows: BTreeMap<String, usize>,
    /// Why nothing is computed: a division by zero, an average over nothing, a source that did
    /// not answer (PL-104).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
}

/// The check's answer.
#[derive(Debug, Serialize, ToSchema)]
pub struct KpiChecked {
    /// Empty when the draft is a KPI admission takes.
    pub problems: Vec<KpiProblem>,
    pub sources: Vec<KpiSource>,
    /// Present when asked for and the draft has no problem.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<KpiPreview>,
}

#[utoipa::path(
    post,
    path = "/api/v1/projects/{project}/kpis/check",
    summary = "Check A KPI Over Several Sources",
    description = "Checks a v1alpha2 Pipeline draft with one kpi step by jc-core's admission rules (PL-102, PL-103), with each attribute's unit from its space's model, and says of each source whether the pipeline's account may read it. `preview: true` also computes the indicator on each source Endpoint's current page, read as the person (PL-105). Needs propose on Pipeline in the project, from a person's session; a source in a space the caller may not read is named as unknown. Changes no data.",
    tag = "pipelines",
    params(("project" = String, Path, description = "Project name")),
    request_body(
        content = KpiCheckRequest,
        content_type = "application/json",
        example = json!({
            "pipeline": {
                "apiVersion": "joinedcontext.com/v1alpha2", "kind": "Pipeline",
                "metadata": { "name": "parking-per-stop" },
                "spec": {
                    "class": "scheduled", "schedule": "0 * * * *",
                    "sources": [
                        { "name": "parking", "endpointRef": { "kind": "Endpoint", "name": "helsinki-parking" },
                          "query": { "type": "ParkingSite", "attrs": ["occupiedSpotNumber", "district"] } },
                        { "name": "stops", "endpointRef": { "kind": "Endpoint", "name": "helsinki-transit" },
                          "query": { "type": "TransitStop", "attrs": ["district"] } }
                    ],
                    "steps": [{ "kind": "kpi", "kpi": {
                        "name": "parking-per-stop", "formula": "sum(parking.occupiedSpotNumber) / count(stops)",
                        "unitCode": "C62", "join": { "by": "area", "keys": { "parking": "district", "stops": "district" } } } }],
                    "outputs": [{ "targetEndpoint": "urn:ngsi-ld:Endpoint:hel.fi:helsinki-kpi:kpi-writer" }]
                }
            },
            "preview": true
        })
    ),
    responses(
        (status = 200, description = "The problems, the sources and, when asked, the preview", body = KpiChecked),
        (status = 400, description = "The body is not a Pipeline of this project", body = crate::error::ProblemDetails),
        (status = 401, description = "Not signed in", body = crate::error::ProblemDetails),
        (status = 403, description = "No propose on Pipeline here, or a workload token", body = crate::error::ProblemDetails),
        (status = 404, description = "No such project", body = crate::error::ProblemDetails),
    )
)]
pub async fn check_kpi(
    user: CurrentUser,
    State(state): State<AppState>,
    Path(project): Path<String>,
    body: Result<Json<KpiCheckRequest>, JsonRejection>,
) -> Result<Json<KpiChecked>, ApiError> {
    let identity = &user.0.identity;
    let Json(request) = body.map_err(|e| ApiError::BadRequest(e.body_text()))?;
    let pipeline = admitted(&state, identity, &project, request.pipeline)?;
    let (mut checked, compiled) = check(&state, identity, &project, &pipeline);
    if let (true, Some((step, expr, inputs))) = (request.preview, compiled) {
        checked.preview = Some(preview(&state, identity, &project, &step, &expr, &inputs).await);
    }
    Ok(Json(checked))
}

/// The draft as this caller may check it: a person who may propose a Pipeline in the project,
/// and a Pipeline of this project.
fn admitted(
    state: &AppState,
    identity: &Identity,
    project: &str,
    mut pipeline: Value,
) -> Result<Value, ApiError> {
    if !is_dns1123(project) {
        return Err(ApiError::NotFound(format!("project '{project}' not found")));
    }
    crate::permissions::for_request(state, identity, project).check(
        "Pipeline",
        Verb::Propose,
        Some(&pipeline),
    )?;
    // Decided (worker-t4935, owner may override): the preview reads as the person, so a
    // workload's token, whose reading is its ServiceAccount's grants, is refused here.
    if identity.client.is_some() {
        return Err(ApiError::Denied(
            "the KPI check is for a person, not a workload token".into(),
        ));
    }
    if pipeline["kind"] != "Pipeline" {
        return Err(ApiError::BadRequest(
            "pipeline.kind must be 'Pipeline'".into(),
        ));
    }
    match pipeline["metadata"]["namespace"].as_str() {
        Some(namespace) if namespace != project => Err(ApiError::BadRequest(format!(
            "pipeline.metadata.namespace '{namespace}' is not the project '{project}'"
        ))),
        _ => {
            pipeline["metadata"]["namespace"] = Value::from(project);
            Ok(pipeline)
        }
    }
}

type Compiled = (KpiStep, Expr, Vec<Input>);

/// The problems and the sources of `pipeline`, and the step compiled when it has no problem.
fn check(
    state: &AppState,
    identity: &Identity,
    project: &str,
    pipeline: &Value,
) -> (KpiChecked, Option<Compiled>) {
    let mut checked = KpiChecked {
        problems: Vec::new(),
        sources: Vec::new(),
        preview: None,
    };
    let spec = match parsed(pipeline) {
        Ok(spec) => spec,
        Err(problem) => {
            checked.problems.push(problem);
            return (checked, None);
        }
    };
    let effective = crate::permissions::for_request(state, identity, project);
    let account = format!(
        "{project}/pl-{}",
        pipeline["metadata"]["name"].as_str().unwrap_or_default()
    );
    let policies = policies(state, project);
    let mut inputs = match spec.kpi_inputs() {
        Ok(inputs) => inputs,
        Err(err) => {
            checked.problems.push(problem_of(&err));
            return (checked, None);
        }
    };
    for (at, (input, source)) in inputs.iter_mut().zip(&spec.sources).enumerate() {
        match known_endpoint(state, &effective, project, source) {
            Some((name, endpoint)) => {
                input.endpoint.clone_from(&name);
                input.units = units(state, project, &endpoint, &input.entity_type);
                checked.sources.push(KpiSource {
                    name: input.name.clone(),
                    readable: endpoint["spec"]["audience"] == "public"
                        || already_granted(
                            &policies,
                            &account,
                            &[TypeGrant {
                                entity_type: input.entity_type.clone(),
                                attrs: Vec::new(),
                            }],
                            Operations::Read,
                        ),
                    endpoint: name,
                });
            }
            None => checked.problems.push(KpiProblem {
                field: format!("spec.sources[{at}].endpointRef"),
                reason: format!(
                    "no Endpoint '{}' in project '{project}' that you may read",
                    source
                        .endpoint_ref
                        .as_ref()
                        .map(|r| r.name())
                        .unwrap_or_default()
                ),
            }),
        }
    }
    let Some(step) = kpi_step(&spec) else {
        checked.problems.push(KpiProblem {
            field: "spec.steps".into(),
            reason: "a KPI pipeline has one step of kind kpi (PL-102)".into(),
        });
        return (checked, None);
    };
    match step.validate(&inputs) {
        Ok(expr) if checked.problems.is_empty() => (checked, Some((step.clone(), expr, inputs))),
        Ok(_) => (checked, None),
        Err(err) => {
            checked.problems.push(problem_of(&err));
            (checked, None)
        }
    }
}

/// The draft's spec, after the manifest rules every Pipeline is held to.
fn parsed(pipeline: &Value) -> Result<PipelineSpec, KpiProblem> {
    let refused = |reason: String| KpiProblem {
        field: "spec".into(),
        reason,
    };
    let text = serde_json::to_string(pipeline).map_err(|e| refused(e.to_string()))?;
    if let Some(checked) = jc_core::registry::validate_yaml("Pipeline", &text) {
        checked.map_err(|e| problem_of(&e))?;
    }
    serde_json::from_value(pipeline["spec"].clone()).map_err(|e| refused(e.to_string()))
}

/// The field a jc-core refusal names, and its reason.
fn problem_of(err: &jc_core::Error) -> KpiProblem {
    match err {
        jc_core::Error::Invalid { field, reason } => KpiProblem {
            field: field.clone(),
            reason: reason.clone(),
        },
        jc_core::Error::Name { field, reason, .. } => KpiProblem {
            field: (*field).to_owned(),
            reason: (*reason).to_owned(),
        },
        other => KpiProblem {
            field: "spec".into(),
            reason: other.to_string(),
        },
    }
}

fn kpi_step(spec: &PipelineSpec) -> Option<&KpiStep> {
    spec.steps.iter().find_map(|step| match step {
        Step::Compute(compute) => compute.kpi.as_deref(),
        Step::Processor(_) => None,
    })
}

/// The source's Endpoint, by name and manifest, when it is one of this project the caller may
/// read; any other is unknown, so a draft learns nothing of spaces the caller does not see.
fn known_endpoint(
    state: &AppState,
    effective: &crate::permissions::Effective,
    project: &str,
    source: &PipelineSource,
) -> Option<(String, Value)> {
    let reference = source.endpoint_ref.as_ref()?;
    if reference.namespace().is_some_and(|ns| ns != project) || !is_dns1123(reference.name()) {
        return None;
    }
    let endpoint = state.mirror.get(project, "Endpoint", reference.name())?;
    let endpoint = serde_json::to_value(endpoint).ok()?;
    let space = crate::permissions::space_ref(&endpoint)?;
    (effective.may_read_project() && effective.may_read_in("ContextSpace", Some(&space)))
        .then(|| (reference.name().to_owned(), endpoint))
}

/// The UN/CEFACT code of each attribute of `entity_type` the Endpoint's space model gives one.
fn units(
    state: &AppState,
    project: &str,
    endpoint: &Value,
    entity_type: &str,
) -> BTreeMap<String, String> {
    crate::permissions::space_ref(endpoint)
        .and_then(|space| state.model_schemas.get(project, &space))
        .and_then(|schema| schema.attributes(entity_type))
        .map(|class| {
            class
                .attributes
                .into_iter()
                .filter_map(|a| Some((a.name, a.unit?.code?)))
                .collect()
        })
        .unwrap_or_default()
}

fn policies(state: &AppState, project: &str) -> Vec<Value> {
    state
        .mirror
        .list(project, "Policy", &ListOptions::default())
        .items
        .into_iter()
        .filter_map(|policy| serde_json::to_value(policy).ok())
        .collect()
}

/// Each source's current page read as the person, and the indicator computed on them.
async fn preview(
    state: &AppState,
    identity: &Identity,
    project: &str,
    step: &KpiStep,
    expr: &Expr,
    inputs: &[Input],
) -> KpiPreview {
    let mut pages = BTreeMap::new();
    let mut problem = None;
    for input in inputs {
        match page(state, identity, project, input, step).await {
            Ok(rows) => {
                pages.insert(input.name.clone(), rows);
            }
            Err(reason) => {
                problem.get_or_insert(format!("input {}: {reason}", input.name));
            }
        }
    }
    let rows = pages
        .iter()
        .map(|(name, rows)| (name.clone(), rows.len()))
        .collect();
    let values = match problem {
        Some(_) => Vec::new(),
        None => match jc_core::kpi_join::evaluate(step, expr, &pages) {
            Ok(values) => values.into_iter().map(KpiValue::from).collect(),
            Err(reason) => {
                problem = Some(reason);
                Vec::new()
            }
        },
    };
    KpiPreview {
        values,
        rows,
        problem,
    }
}

/// One source's page through its Endpoint's compiled view, as the person (or the anonymous
/// caller on a public Endpoint) reads it.
async fn page(
    state: &AppState,
    identity: &Identity,
    project: &str,
    input: &Input,
    step: &KpiStep,
) -> Result<Vec<Value>, String> {
    let views = state
        .views
        .as_ref()
        .ok_or("this Portal has no broker address or admin token")?;
    let (id, view) = views
        .saved_view(project, &input.endpoint)?
        .ok_or("the Endpoint's view is not compiled yet; try again shortly")?;
    let public = state
        .mirror
        .get(project, "Endpoint", &input.endpoint)
        .is_some_and(|e| e.spec["audience"].as_str() == Some("public"));
    let subject = crate::api::endpoint_preview::subject(identity, public);
    let (status, answer) = views
        .preview(&id, &view, &query_of(input, step), &subject)
        .await?;
    match status {
        200 => Ok(answer["entities"].as_array().cloned().unwrap_or_default()),
        _ => Err(answer["detail"]
            .as_str()
            .map_or_else(|| format!("the broker answered {status}"), str::to_owned)),
    }
}

/// The source's query: its type, `q`, the attributes it reads and its join key, one page.
fn query_of(input: &Input, step: &KpiStep) -> String {
    let mut attrs = input.attrs.clone();
    if let Some(key) = step.join.keys.get(&input.name).filter(|k| *k != "id") {
        if !attrs.contains(key) {
            attrs.push(key.clone());
        }
    }
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    query.append_pair("type", &input.entity_type);
    if !attrs.is_empty() {
        query.append_pair("attrs", &attrs.join(","));
    }
    if let Some(q) = &input.q {
        query.append_pair("q", q);
    }
    query.append_pair("limit", &PAGE.to_string());
    query.append_pair("offset", "0");
    query.finish()
}

pub fn router() -> Router<AppState> {
    Router::new().route("/projects/{project}/kpis/check", post(check_kpi))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_reads_the_attributes_the_join_key_and_the_filter() {
        let input = Input {
            name: "parking".into(),
            entity_type: "ParkingSite".into(),
            attrs: vec!["occupied".into()],
            q: Some("occupied>0".into()),
            ..Default::default()
        };
        let mut step: KpiStep = serde_json::from_value(serde_json::json!({
            "name": "n", "formula": "sum(parking.occupied)", "unitCode": "C62",
            "join": { "by": "area", "keys": { "parking": "district" } }
        }))
        .expect("a step");
        assert_eq!(
            query_of(&input, &step),
            "type=ParkingSite&attrs=occupied%2Cdistrict&q=occupied%3E0&limit=100&offset=0"
        );
        step.join.keys.insert("parking".into(), "id".into());
        assert_eq!(
            query_of(&input, &step),
            "type=ParkingSite&attrs=occupied&q=occupied%3E0&limit=100&offset=0"
        );
    }

    #[test]
    fn a_refusal_keeps_the_field_jc_core_names() {
        let err = jc_core::Error::Invalid {
            field: "spec.steps.kpi.formula".into(),
            reason: "unknown function".into(),
        };
        assert_eq!(
            problem_of(&err),
            KpiProblem {
                field: "spec.steps.kpi.formula".into(),
                reason: "unknown function".into(),
            }
        );
        assert_eq!(
            problem_of(&jc_core::Error::ApiVersion("v9".into())).field,
            "spec"
        );
    }
}
