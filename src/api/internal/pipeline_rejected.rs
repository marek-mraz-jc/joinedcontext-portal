//! The internal listener's rejected route (PL-61, ADR-N-034): a record the runner's validation
//! stage refused, posted once by the project's pipeline runner and kept on the pipeline's
//! rejected list.
//!
//! The runner says that a record failed; the Portal says why. The record is checked again against
//! the space's compiled model, the same check the workbench runs, so the rule on the list is the
//! one a person sees in the workbench and not the runner's wording. A record that passes that
//! check failed in one of the author's steps, and is kept with the step it failed at.

use crate::pipeline_validation::Problem;
use crate::state::AppState;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::Router;
use serde::Deserialize;
use serde_json::Value;

/// A refused record is one entity; anything larger is not one the gateway would have taken.
const BODY_LIMIT: usize = 1024 * 1024;

/// How much of the runner's own error a kept record carries.
const ERROR_CHARS: usize = 500;

/// What the stage's catch posts.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Refused {
    pub record: Value,
    #[serde(default)]
    pub error: Option<String>,
    /// The step the harness stamped, as text: Bento metadata is text.
    #[serde(default)]
    pub step: Option<Value>,
}

/// `POST /internal/pipelines/{project}/{name}/rejected`.
pub async fn rejected(
    State(state): State<AppState>,
    Path((project, name)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> StatusCode {
    if crate::auth::internal::authenticate_pipeline_runner(&state, &headers)
        .await
        .is_err()
    {
        return StatusCode::UNAUTHORIZED;
    }
    let Ok(refused) = serde_json::from_slice::<Refused>(&body) else {
        return StatusCode::BAD_REQUEST;
    };
    keep(&state, &project, &name, refused).await
}

/// Names the rule and keeps the record, once the caller is known.
pub(crate) async fn keep(
    state: &AppState,
    project: &str,
    name: &str,
    refused: Refused,
) -> StatusCode {
    let Some(pipeline) = state.mirror.get(project, "Pipeline", name) else {
        return StatusCode::NOT_FOUND;
    };
    let problems = target_space(state, project, &pipeline.spec)
        .and_then(|space| {
            let schema = state.model_schemas.get(project, &space)?;
            let segment = crate::spaces::segment(&state.mirror, project, &space);
            let domain = state.config.org_domain.clone().unwrap_or_default();
            Some(schema.check(&refused.record, &domain, &segment))
        })
        .unwrap_or_default();
    let step = refused.step.as_ref().and_then(|step| match step {
        Value::Number(n) => n.as_i64(),
        Value::String(text) => text.parse().ok(),
        _ => None,
    });
    let (rule, path, message) = match problems.as_slice() {
        [first, ..] => (
            first.rule.clone(),
            first.path.clone(),
            problems
                .iter()
                .map(|Problem { message, .. }| message.as_str())
                .collect::<Vec<_>>()
                .join("; "),
        ),
        [] => (
            if step.is_some() { "step" } else { "runner" }.to_owned(),
            String::new(),
            runner_error(refused.error.as_deref()),
        ),
    };
    let reason = crate::pipeline_outcomes::Reason {
        rule,
        path,
        message,
        step: step.and_then(|s| i32::try_from(s).ok()),
    };
    match state
        .rejected
        .reject(project, name, &refused.record, &reason)
        .await
    {
        Ok(()) => StatusCode::NO_CONTENT,
        Err(error) => {
            tracing::warn!(project, pipeline = name, %error, "a rejected record was not kept");
            StatusCode::SERVICE_UNAVAILABLE
        }
    }
}

/// The local name of the space the pipeline's first output writes into.
fn target_space(state: &AppState, project: &str, spec: &Value) -> Option<String> {
    let spec: jc_core::kinds::pipeline::PipelineSpec = serde_json::from_value(spec.clone()).ok()?;
    let output = spec.outputs().into_iter().next()?;
    let endpoint = state
        .mirror
        .get(project, "Endpoint", output.target_endpoint.local_id())?;
    crate::api::assistant::ref_name(&endpoint.spec["contextSpaceRef"])
}

/// The runner's error, shortened and without anything shaped like a credential: an author's
/// mapping can throw whatever it read.
fn runner_error(error: Option<&str>) -> String {
    let text: String = error
        .unwrap_or("the runner refused the record without a reason")
        .chars()
        .take(ERROR_CHARS)
        .collect();
    text.split(' ')
        .map(|word| {
            if crate::pipeline_outcomes::credential_shaped(word) {
                crate::pipeline_outcomes::MASK
            } else {
                word
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/internal/pipelines/{project}/{name}/rejected",
            post(rejected),
        )
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::resource::{ObjectMeta, ResourceEnvelope, API_VERSION};
    use serde_json::json;
    use std::sync::Arc;

    fn manifest(kind: &str, name: &str, spec: Value) -> ResourceEnvelope {
        ResourceEnvelope {
            api_version: API_VERSION.to_owned(),
            kind: kind.to_owned(),
            metadata: ObjectMeta::new(name, "ovzdusie"),
            spec,
            status: None,
        }
    }

    /// A project with one space that names its model, an Endpoint into it and a pipeline
    /// writing through that Endpoint; the model is compiled the way a sync compiles it.
    fn world() -> AppState {
        let mut config = Config::for_tests();
        config.org_domain = Some("banskabystrica.sk".into());
        let state = AppState::new(config, None);
        state.mirror.upsert(manifest(
            "ContextSpace",
            "ovzdusie",
            json!({ "urnSegment": "ovzdusie", "dataModelRef": { "kind": "DataModel", "name": "air" } }),
        ));
        state.mirror.upsert(manifest(
            "Endpoint",
            "air-write",
            json!({ "contextSpaceRef": "ovzdusie", "slug": "k7r2m4xq9vbn3tdw6hcy5pajfe" }),
        ));
        state.mirror.upsert(manifest(
            "Pipeline",
            "stations",
            json!({
                "class": "resident",
                "source": { "dataSourceRef": { "kind": "DataSource", "name": "feed" } },
                "targetEndpoint": "urn:ngsi-ld:Endpoint:banskabystrica.sk:ovzdusie:air-write"
            }),
        ));
        state.model_schemas.replace(std::collections::HashMap::from([(
            ("ovzdusie".to_owned(), "ovzdusie".to_owned()),
            Arc::new(crate::pipeline_validation::ModelSchema::compile(
                "air",
                "1.0.0",
                &json!({ "definitions": { "AirQualityObserved": {
                    "additionalProperties": false,
                    "properties": { "id": { "type": "string" }, "pm10": { "type": "number", "x-ngsi-ld-kind": "Property" } }
                }}}),
                &["AirQualityObserved".to_owned()],
                false,
            )),
        )]));
        state
    }

    fn refused(record: Value, step: Option<Value>) -> Refused {
        Refused {
            record,
            error: Some("json_schema: pm10: Invalid type".into()),
            step,
        }
    }

    #[tokio::test]
    async fn a_refused_record_is_kept_with_the_rule_the_workbench_names() {
        let state = world();
        let record = json!({
            "id": "urn:ngsi-ld:AirQualityObserved:banskabystrica.sk:ovzdusie:s-1",
            "type": "AirQualityObserved",
            "pm10": { "type": "Property", "value": "n/a" },
            "password": "hunter2hunter2"
        });
        assert_eq!(
            keep(&state, "ovzdusie", "stations", refused(record, None)).await,
            StatusCode::NO_CONTENT
        );
        let kept = state
            .rejected
            .list("ovzdusie", "stations", 10, None)
            .await
            .expect("the list");
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].rule, "sh:datatype", "{kept:?}");
        assert_eq!(kept[0].path, "pm10");
        assert_eq!(
            kept[0].record["password"],
            crate::pipeline_outcomes::MASK,
            "masked before it is kept"
        );
        assert!(
            !kept[0].message.contains("n/a"),
            "the value is not quoted: {}",
            kept[0].message
        );

        let wrong_id = json!({ "id": "urn:ngsi-ld:AirQualityObserved:hel.fi:x:1", "type": "AirQualityObserved" });
        keep(&state, "ovzdusie", "stations", refused(wrong_id, None)).await;
        let undeclared =
            json!({ "id": "urn:ngsi-ld:Device:banskabystrica.sk:ovzdusie:1", "type": "Device" });
        keep(&state, "ovzdusie", "stations", refused(undeclared, None)).await;
        let kept = state
            .rejected
            .list("ovzdusie", "stations", 10, None)
            .await
            .expect("the list");
        let rules: Vec<&str> = kept.iter().map(|r| r.rule.as_str()).collect();
        assert_eq!(rules, ["type", "id", "sh:datatype"], "newest first");
    }

    #[tokio::test]
    async fn a_record_that_failed_in_a_step_is_kept_with_its_step_and_an_unknown_pipeline_is_404() {
        let state = world();
        let valid = json!({ "id": "urn:ngsi-ld:AirQualityObserved:banskabystrica.sk:ovzdusie:s-1", "type": "AirQualityObserved" });
        keep(
            &state,
            "ovzdusie",
            "stations",
            refused(valid, Some(json!("2"))),
        )
        .await;
        let kept = state
            .rejected
            .list("ovzdusie", "stations", 10, None)
            .await
            .expect("the list");
        assert_eq!((kept[0].rule.as_str(), kept[0].step), ("step", Some(2)));

        assert_eq!(
            keep(&state, "ovzdusie", "nobody", refused(json!({}), None)).await,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            state
                .rejected
                .count("ovzdusie", "nobody")
                .await
                .expect("count"),
            0
        );
    }

    #[tokio::test]
    async fn a_call_without_the_runners_token_is_401() {
        use tower::ServiceExt;
        let state = world();
        let response = router()
            .with_state(state.clone())
            .oneshot(
                axum::http::Request::post("/internal/pipelines/ovzdusie/stations/rejected")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(r#"{"record":{}}"#))
                    .expect("a request"),
            )
            .await
            .expect("an answer");
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            state
                .rejected
                .count("ovzdusie", "stations")
                .await
                .expect("count"),
            0
        );
    }

    #[test]
    fn the_runners_error_is_shortened_and_a_credential_in_it_masked() {
        let jwt = [
            "eyJhbGciOiJIUzI1NiJ9",
            "eyJzdWIiOiJ4In0",
            "c2lnbmF0dXJlLXBhcnQ",
        ]
        .join(".");
        let said = runner_error(Some(&format!("failed reading {jwt} from the feed")));
        assert!(!said.contains("eyJ"), "{said}");
        assert!(said.contains(crate::pipeline_outcomes::MASK));
        assert_eq!(runner_error(Some(&"x".repeat(2000))).len(), ERROR_CHARS);
        assert!(runner_error(None).contains("without a reason"));
    }
}
