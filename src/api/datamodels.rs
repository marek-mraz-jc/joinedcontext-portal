//! Reading and saving DataModel LinkML source and compiled schema artifacts (DM-01, DM-02, DM-22, DM-24, DM-56, DM-57).

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use jc_core::kinds::{DataModelSpec, GeneratedArtifacts, SemVer};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use utoipa::ToSchema;

use crate::api::mutate::{author_credentials, branch_name, create_or_reuse_branch};
use crate::auth::CurrentUser;
use crate::change::{Change, ChangePhase, ChangeStatus, Lane, Operation, PlanSummary};
use crate::error::{ApiError, ProblemDetails};
use crate::git::{Author, FileWrite};
use crate::state::AppState;
use crate::tools::model_tools::{Artifacts, GenerateRequest, MAX_REQUEST_BYTES};

/// Single detected difference between the published model and the candidate LinkML source.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelChange {
    pub severity: String,
    pub subject: String,
    pub reason: String,
}

/// Result returned for `PUT /source?dryRun=All`.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceDryRunResult {
    pub severity: String,
    pub changes: Vec<ModelChange>,
    pub version: String,
    pub artifacts: Artifacts,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourcePutQuery {
    pub version: Option<String>,
    #[serde(default, rename = "dryRun")]
    pub dry_run: Option<String>,
    /// The space a model the project does not hold yet is created in (DM-57).
    pub space: Option<String>,
}

/// The manifest a `PUT` creates for a name the project does not hold yet (DM-57). The space
/// decides the folder, so without one there is nowhere to write the file and nothing is created.
fn new_model_envelope(
    state: &AppState,
    project: &str,
    name: &str,
    space: Option<&str>,
) -> Result<crate::resource::ResourceEnvelope, ApiError> {
    let space = space.map(str::trim).filter(|s| !s.is_empty()).ok_or_else(|| {
        ApiError::BadRequest(format!(
            "DataModel '{name}' not found in project '{project}'; to create it, name the space it belongs to with ?space="
        ))
    })?;
    if !crate::resource::is_dns1123(name) {
        return Err(ApiError::BadRequest(format!(
            "'{name}' is not a manifest name: lower-case letters, digits and '-', starting and ending with a letter or a digit"
        )));
    }
    if state.mirror.get(project, "ContextSpace", space).is_none() {
        return Err(ApiError::NotFound(format!(
            "ContextSpace '{space}' not found in project '{project}'"
        )));
    }
    serde_json::from_value(json!({
        "apiVersion": crate::resource::API_VERSION,
        "kind": "DataModel",
        "metadata": { "name": name, "namespace": project },
        "spec": {
            "contextSpaceRef": space,
            "linkml": format!("./{name}.linkml.yaml"),
            "version": "0.1.0",
            "lifecycle": "draft",
            "classes": [],
        }
    }))
    .map_err(|e| ApiError::Internal(format!("build DataModel manifest: {e}")))
}

/// Confines `spec.linkml`: rejects absolute paths, `..` segments, and paths outside `datamodels/`.
pub fn confine_linkml_path(linkml: &str) -> Result<String, ApiError> {
    if linkml.starts_with('/') || linkml.contains('\\') {
        return Err(ApiError::BadRequest(
            "linkml path must be relative, not absolute".into(),
        ));
    }
    let trimmed = linkml.strip_prefix("./").unwrap_or(linkml);
    if trimmed.is_empty()
        || trimmed.starts_with('/')
        || trimmed.split('/').any(|seg| seg == ".." || seg == ".")
    {
        return Err(ApiError::BadRequest(
            "linkml path must not contain '..' segments or be empty".into(),
        ));
    }
    // The path becomes part of a forge URL, where `%2e%2e` is read as `..` and `?` or `#` end the
    // path: none of them names a file of a model (T-1484).
    if trimmed
        .chars()
        .any(|c| matches!(c, '%' | '?' | '#') || c.is_control())
    {
        return Err(ApiError::BadRequest(
            "linkml path must not contain '%', '?', '#' or a control character".into(),
        ));
    }
    if !trimmed.ends_with(".linkml.yaml") {
        return Err(ApiError::BadRequest(
            "linkml path must end with .linkml.yaml".into(),
        ));
    }
    Ok(trimmed.to_string())
}

/// Decodes base64 Gitea content if base64 encoded, or returns string verbatim.
fn decode_content(raw: &str) -> String {
    let trimmed = raw.trim();
    if let Ok(bytes) = STANDARD.decode(trimmed.replace(['\n', '\r', ' '], "")) {
        if let Ok(s) = String::from_utf8(bytes) {
            if !s.is_empty()
                && s.chars()
                    .all(|c| !c.is_control() || c == '\n' || c == '\r' || c == '\t')
            {
                return s;
            }
        }
    }
    raw.to_string()
}

/// Reads the LinkML source from the forge for a DataModel in a project.
pub async fn read_source(state: &AppState, project: &str, name: &str) -> Result<String, ApiError> {
    let envelope = state
        .mirror
        .get(project, "DataModel", name)
        .ok_or_else(|| {
            ApiError::NotFound(format!(
                "DataModel '{name}' not found in project '{project}'"
            ))
        })?;

    let space = envelope
        .spec
        .get("contextSpaceRef")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::BadRequest("DataModel spec missing contextSpaceRef".into()))?;

    let linkml = envelope
        .spec
        .get("linkml")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::BadRequest("DataModel spec missing linkml".into()))?;

    let confined = confine_linkml_path(linkml)?;

    let gitea = state
        .forge_for(project)
        .ok_or_else(|| ApiError::Unavailable("git forge is not configured".into()))?;
    let gitea: &crate::git::GiteaClient = &gitea;

    let default_branch = gitea.default_branch().await?;
    let repo_path = format!("projects/{project}/spaces/{space}/datamodels/{confined}");

    let file = gitea
        .get_file(&repo_path, &default_branch)
        .await?
        .ok_or_else(|| {
            ApiError::NotFound(format!("source file '{repo_path}' not found in repository"))
        })?;

    Ok(decode_content(&file.content))
}

/// Classifies changes between previous and next LinkML YAML documents.
pub fn classify_linkml_changes(prev_val: &Value, next_val: &Value) -> Vec<ModelChange> {
    let mut changes = Vec::new();
    let empty_map = serde_json::Map::new();

    let prev_classes = prev_val
        .get("classes")
        .and_then(Value::as_object)
        .unwrap_or(&empty_map);
    let next_classes = next_val
        .get("classes")
        .and_then(Value::as_object)
        .unwrap_or(&empty_map);

    for (name, prev_class) in prev_classes {
        if let Some(next_class) = next_classes.get(name) {
            let prev_class_slots: Vec<&str> = prev_class
                .get("slots")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            let next_class_slots: Vec<&str> = next_class
                .get("slots")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            for slot in prev_class_slots {
                if !next_class_slots.contains(&slot) {
                    changes.push(ModelChange {
                        severity: "breaking".into(),
                        subject: format!("{name}.{slot}"),
                        reason: format!("slot '{slot}' was removed from class '{name}'"),
                    });
                }
            }
        } else {
            changes.push(ModelChange {
                severity: "breaking".into(),
                subject: name.clone(),
                reason: format!("class '{name}' was removed"),
            });
        }
    }

    for (name, _) in next_classes {
        if !prev_classes.contains_key(name) {
            changes.push(ModelChange {
                severity: "additive".into(),
                subject: name.clone(),
                reason: format!("class '{name}' was added"),
            });
        }
    }

    let prev_slots = prev_val
        .get("slots")
        .and_then(Value::as_object)
        .unwrap_or(&empty_map);
    let next_slots = next_val
        .get("slots")
        .and_then(Value::as_object)
        .unwrap_or(&empty_map);

    for (name, prev_slot) in prev_slots {
        if let Some(next_slot) = next_slots.get(name) {
            let prev_req = prev_slot
                .get("required")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let next_req = next_slot
                .get("required")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if !prev_req && next_req {
                changes.push(ModelChange {
                    severity: "breaking".into(),
                    subject: name.clone(),
                    reason: format!("slot '{name}' became required"),
                });
            } else if prev_req && !next_req {
                changes.push(ModelChange {
                    severity: "additive".into(),
                    subject: name.clone(),
                    reason: format!("slot '{name}' is no longer required"),
                });
            }

            let prev_multi = prev_slot
                .get("multivalued")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let next_multi = next_slot
                .get("multivalued")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if prev_multi != next_multi {
                changes.push(ModelChange {
                    severity: "breaking".into(),
                    subject: name.clone(),
                    reason: format!("slot '{name}' multivalued changed"),
                });
            }

            let prev_range = prev_slot.get("range").and_then(Value::as_str);
            let next_range = next_slot.get("range").and_then(Value::as_str);
            if prev_range != next_range {
                let numeric = ["integer", "float", "double", "decimal"];
                let p = prev_range.unwrap_or("string");
                let n = next_range.unwrap_or("string");
                let widens = (p == "integer" && numeric.contains(&n) && n != "integer")
                    || (n == "string" && p != "string");
                if widens {
                    changes.push(ModelChange {
                        severity: "additive".into(),
                        subject: name.clone(),
                        reason: format!("range of slot '{name}' widened from {p} to {n}"),
                    });
                } else {
                    changes.push(ModelChange {
                        severity: "breaking".into(),
                        subject: name.clone(),
                        reason: format!("range of slot '{name}' changed from {p} to {n}"),
                    });
                }
            }
        } else {
            changes.push(ModelChange {
                severity: "breaking".into(),
                subject: name.clone(),
                reason: format!("slot '{name}' was removed"),
            });
        }
    }

    for (name, next_slot) in next_slots {
        if !prev_slots.contains_key(name) {
            let next_req = next_slot
                .get("required")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if next_req {
                changes.push(ModelChange {
                    severity: "breaking".into(),
                    subject: name.clone(),
                    reason: format!("new required slot '{name}' was added"),
                });
            } else {
                changes.push(ModelChange {
                    severity: "additive".into(),
                    subject: name.clone(),
                    reason: format!("new optional slot '{name}' was added"),
                });
            }
        }
    }

    changes
}

pub fn overall_severity(changes: &[ModelChange]) -> &'static str {
    if changes.iter().any(|c| c.severity == "breaking") {
        "breaking"
    } else if changes.iter().any(|c| c.severity == "additive") {
        "additive"
    } else {
        "none"
    }
}

pub fn bump_version(current: &SemVer, severity: &str) -> Result<SemVer, ApiError> {
    let (major, minor, patch) = (current.major(), current.minor(), current.patch());
    let exhausted =
        || ApiError::BadRequest(format!("version {current} has no next {severity} version"));
    let bumped = match severity {
        "breaking" => format!("{}.0.0", major.checked_add(1).ok_or_else(exhausted)?),
        "additive" => format!(
            "{}.{}.0",
            major,
            minor.checked_add(1).ok_or_else(exhausted)?
        ),
        _ => format!(
            "{}.{}.{}",
            major,
            minor,
            patch.checked_add(1).ok_or_else(exhausted)?
        ),
    };
    SemVer::new(&bumped).map_err(|e| ApiError::BadRequest(e.to_string()))
}

/// The artifacts Model Tools renders from one LinkML source (DM-02); the export reuses it for a
/// model whose repository holds no JSON Schema (MF-41).
pub(crate) async fn compile_artifacts(
    state: &AppState,
    source: &str,
) -> Result<Artifacts, ApiError> {
    let base = state
        .config
        .model_tools_url
        .as_deref()
        .ok_or_else(|| ApiError::Unavailable("no model tools service is configured".into()))?;
    let url = format!("{}/generate", base.trim_end_matches('/'));

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    let response = client
        .post(&url)
        .json(&GenerateRequest {
            source: source.to_string(),
        })
        .send()
        .await
        .map_err(|err| {
            tracing::warn!(route = "generate", error = %err, "model tools unreachable");
            ApiError::Unavailable("the model tools service did not answer".into())
        })?;

    if !response.status().is_success() {
        return Err(ApiError::Unavailable(
            "the model tools service did not answer".into(),
        ));
    }

    response.json::<Artifacts>().await.map_err(|err| {
        tracing::warn!(route = "generate", error = %err, "model tools answered unreadably");
        ApiError::Unavailable("the model tools service did not answer".into())
    })
}

/// What saving `source` as the model `name` would do (DM-22, DM-24): the changes against the
/// published source, the version it takes (`version`, or the published one bumped by the
/// severity) and what Model Tools compiles, with the source parsed. A breaking change under the
/// published major and a source Model Tools refuses are errors. The route and the assistant's
/// `change_resource` check a source the same way (AG-77).
pub(crate) async fn check_source(
    state: &AppState,
    project: &str,
    name: &str,
    spec: &Value,
    source: &str,
    version: Option<&str>,
) -> Result<(SourceDryRunResult, Value), ApiError> {
    let next_val: Value = serde_yaml_ng::from_str(source)
        .map_err(|e| ApiError::BadRequest(format!("invalid yaml body: {e}")))?;
    // The source is committed as typed, so a pasted credential would land in Git (MF-24).
    if let Some(key) = crate::api::mutate::find_literal_secret(&next_val) {
        return Err(ApiError::BadRequest(format!(
            "literal secret in field '{key}' is forbidden; use secretRef instead (MF-24)"
        )));
    }

    let published_source = read_source(state, project, name).await.ok();
    let prev_val: Value = published_source
        .as_deref()
        .and_then(|s| serde_yaml_ng::from_str(s).ok())
        .unwrap_or(Value::Null);

    let changes = classify_linkml_changes(&prev_val, &next_val);
    let severity = overall_severity(&changes);

    let current_version_str = spec
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("0.1.0");
    let published_version = SemVer::new(current_version_str)
        .map_err(|e| ApiError::BadRequest(format!("invalid current version: {e}")))?;

    let target_version = match version {
        Some(v) => {
            SemVer::new(v).map_err(|e| ApiError::BadRequest(format!("invalid version: {e}")))?
        }
        None => bump_version(&published_version, severity)?,
    };

    if severity == "breaking" && target_version.major() <= published_version.major() {
        let breaking_reasons: Vec<String> = changes
            .iter()
            .filter(|c| c.severity == "breaking")
            .map(|c| c.reason.clone())
            .collect();
        let suggested = bump_version(&published_version, "breaking")?;
        return Err(ApiError::Invalid {
            detail: format!(
                "a breaking change cannot be saved under version {target_version}; publish it as {suggested}"
            ),
            errors: breaking_reasons,
        });
    }

    let artifacts = compile_artifacts(state, source).await?;
    if !artifacts.errors.is_empty() {
        return Err(ApiError::Invalid {
            detail: artifacts.errors.join("; "),
            errors: artifacts.errors.clone(),
        });
    }

    Ok((
        SourceDryRunResult {
            severity: severity.to_string(),
            changes,
            version: target_version.to_string(),
            artifacts,
        },
        next_val,
    ))
}

#[utoipa::path(
    get,
    path = "/api/v1/projects/{project}/datamodels/{name}/source",
    summary = "Read Model Source",
    description = "One DataModel's LinkML, as the repository holds it.",
    tag = "datamodels",
    params(
        ("project" = String, Path, description = "Project name"),
        ("name" = String, Path, description = "DataModel name"),
    ),
    responses(
        (status = 200, description = "LinkML source in YAML format", content_type = "text/yaml", body = String),
        (status = 400, description = "Bad request", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 404, description = "Not found", body = ProblemDetails),
        (status = 503, description = "Service unavailable", body = ProblemDetails),
    )
)]
pub async fn get_source(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((project, name)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    // PF-59, R20 (T-1367): the source is a read of the model, so a caller who may not read the
    // project's models gets the answer of a model that is not there, and the forge is not asked.
    // The operations registry and the MCP resource ask the same question before `read_source`.
    if !crate::permissions::for_request(&state, &user.0.identity, &project).may_read("DataModel") {
        return Err(ApiError::NotFound(format!(
            "DataModel '{name}' not found in project '{project}'"
        )));
    }
    let content = read_source(&state, &project, &name).await?;
    Ok((
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/yaml; charset=utf-8")],
        content,
    )
        .into_response())
}

#[utoipa::path(
    put,
    path = "/api/v1/projects/{project}/datamodels/{name}/source",
    summary = "Write Model Source",
    description = "Writes one DataModel's LinkML and its generated artifacts as a change a person approves.",
    tag = "datamodels",
    params(
        ("project" = String, Path, description = "Project name"),
        ("name" = String, Path, description = "DataModel name"),
        ("version" = Option<String>, Query, description = "Target semver"),
        ("dryRun" = Option<String>, Query, description = "Set to 'All' for dry run"),
        ("space" = Option<String>, Query, description = "The space a model the project does not hold yet is created in (DM-57)"),
    ),
    request_body(
        content = String,
        description = "LinkML source in YAML format",
        content_type = "text/yaml",
        example = json!("id: https://hel.fi/models/air\nname: air\nprefixes:\n  linkml: https://w3id.org/linkml/\nimports: [linkml:types]\nclasses:\n  AirQualityObserved:\n    attributes:\n      pm10: { range: float }\n"),
    ),
    responses(
        (status = 202, description = "Change proposal accepted", body = Change),
        (status = 200, description = "Dry run result", body = SourceDryRunResult),
        (status = 400, description = "Bad request", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden", body = ProblemDetails),
        (status = 404, description = "Not found", body = ProblemDetails),
        (status = 503, description = "Service unavailable", body = ProblemDetails),
    )
)]
pub async fn put_source(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((project, name)): Path<(String, String)>,
    Query(query): Query<SourcePutQuery>,
    body: Bytes,
) -> Result<Response, ApiError> {
    if body.len() > MAX_REQUEST_BYTES {
        return Err(ApiError::BadRequest(format!(
            "the source is larger than the {MAX_REQUEST_BYTES} byte limit"
        )));
    }

    let is_dry = query
        .dry_run
        .as_deref()
        .map(|s| s.eq_ignore_ascii_case("all") || s.eq_ignore_ascii_case("true"))
        .unwrap_or(false);

    let existing = state.mirror.get(&project, "DataModel", &name);
    let creating = existing.is_none();
    let envelope = match existing {
        Some(envelope) => envelope,
        None => new_model_envelope(&state, &project, &name, query.space.as_deref())?,
    };

    crate::permissions::for_request(&state, &user.0.identity, &project).check(
        "DataModel",
        jc_core::kinds::Verb::Propose,
        Some(&envelope.spec),
    )?;

    let space = envelope
        .spec
        .get("contextSpaceRef")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::BadRequest("DataModel spec missing contextSpaceRef".into()))?;

    let linkml = envelope
        .spec
        .get("linkml")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::BadRequest("DataModel spec missing linkml".into()))?;

    let confined_linkml = confine_linkml_path(linkml)?;

    let source_str = std::str::from_utf8(&body)
        .map_err(|e| ApiError::BadRequest(format!("invalid utf-8 body: {e}")))?
        .to_string();

    // A model that is being created starts where DM-22 starts, not one additive bump above it.
    let requested_version =
        query
            .version
            .as_deref()
            .or(if creating { Some("0.1.0") } else { None });

    let (checked, next_val) = check_source(
        &state,
        &project,
        &name,
        &envelope.spec,
        &source_str,
        requested_version,
    )
    .await?;

    if is_dry {
        return Ok((StatusCode::OK, Json(checked)).into_response());
    }
    let SourceDryRunResult {
        severity,
        version,
        artifacts,
        ..
    } = checked;
    let severity = severity.as_str();
    let target_version =
        SemVer::new(&version).map_err(|e| ApiError::BadRequest(format!("invalid version: {e}")))?;

    let major = target_version.major();
    let empty_map = serde_json::Map::new();
    let next_classes = next_val
        .get("classes")
        .and_then(Value::as_object)
        .unwrap_or(&empty_map);
    let mut classes: Vec<String> = next_classes.keys().cloned().collect();
    classes.sort();

    let artifacts_spec = GeneratedArtifacts {
        json_schema: Some(format!("./json-schema/{name}.v{major}.json")),
        context: Some(format!("./context/{name}.v{major}.jsonld")),
        docs: Some(format!("./docs/{name}.md")),
        example: Some(format!("./examples/{name}.example.jsonld")),
    };

    let mut new_spec = envelope.spec.clone();
    new_spec["version"] = Value::String(target_version.to_string());
    new_spec["classes"] = serde_json::to_value(&classes).unwrap_or(Value::Array(Vec::new()));
    new_spec["artifacts"] = serde_json::to_value(&artifacts_spec).unwrap_or(Value::Null);

    let typed_spec: DataModelSpec = serde_json::from_value(new_spec.clone())
        .map_err(|e| ApiError::BadRequest(format!("invalid DataModel spec: {e}")))?;
    typed_spec
        .validate()
        .map_err(|e| ApiError::BadRequest(format!("DataModel validation error: {e}")))?;

    let mut updated_envelope = envelope.clone();
    updated_envelope.spec = new_spec;
    updated_envelope.strip_status();

    let manifest_yaml = serde_yaml_ng::to_string(&updated_envelope)
        .map_err(|e| ApiError::Internal(format!("serialize manifest to yaml: {e}")))?;

    let json_schema_content =
        serde_json::to_string_pretty(&artifacts.json_schema.clone().unwrap_or_else(|| json!({})))
            .map_err(|e| ApiError::Internal(format!("serialize json schema: {e}")))?;

    let context_content =
        serde_json::to_string_pretty(&artifacts.context.clone().unwrap_or_else(|| json!({})))
            .map_err(|e| ApiError::Internal(format!("serialize context: {e}")))?;

    let docs_content = artifacts.docs.clone().unwrap_or_default();

    let example_content =
        serde_json::to_string_pretty(&artifacts.example.clone().unwrap_or_else(|| json!({})))
            .map_err(|e| ApiError::Internal(format!("serialize example: {e}")))?;

    let gitea = state
        .forge_for(&project)
        .ok_or_else(|| ApiError::Unavailable("git forge is not configured".into()))?;
    let gitea: &crate::git::GiteaClient = &gitea;

    let default_branch = gitea.default_branch().await?;
    let operation = if creating {
        Operation::Create
    } else {
        Operation::Update
    };
    let branch = branch_name(&project, "datamodel", &name, operation);
    let branch = create_or_reuse_branch(gitea, &branch, &default_branch).await?;

    let (author_name, author_email) = author_credentials(&user.0.identity, &project);
    let commit_msg = if creating {
        format!("create DataModel {name} with its source and artifacts")
    } else {
        format!("update DataModel {name} source and artifacts")
    };

    let manifest_path = format!("projects/{project}/spaces/{space}/datamodels/{name}.yaml");
    let source_path = format!("projects/{project}/spaces/{space}/datamodels/{confined_linkml}");
    let schema_path =
        format!("projects/{project}/spaces/{space}/datamodels/json-schema/{name}.v{major}.json");
    let context_path =
        format!("projects/{project}/spaces/{space}/datamodels/context/{name}.v{major}.jsonld");
    let docs_path = format!("projects/{project}/spaces/{space}/datamodels/docs/{name}.md");
    let example_path =
        format!("projects/{project}/spaces/{space}/datamodels/examples/{name}.example.jsonld");

    let writes = [
        (&manifest_path, manifest_yaml.as_str()),
        (&source_path, source_str.as_str()),
        (&schema_path, json_schema_content.as_str()),
        (&context_path, context_content.as_str()),
        (&docs_path, docs_content.as_str()),
        (&example_path, example_content.as_str()),
    ];

    for (file_p, content) in writes {
        let existing_sha = gitea
            .get_file(file_p, &branch)
            .await
            .ok()
            .flatten()
            .map(|f| f.sha);

        let file_write = FileWrite {
            path: file_p,
            branch: &branch,
            message: &commit_msg,
            content,
            sha: existing_sha.as_deref(),
            author: Author {
                name: &author_name,
                email: &author_email,
            },
        };
        gitea.put_file(&file_write).await?;
    }

    // A model that did not exist has nothing to break, so it lands in the lane a draft gets.
    let lane = match severity {
        _ if creating => Lane::Green,
        "breaking" => Lane::Red,
        "additive" => Lane::Yellow,
        _ => Lane::Green,
    };

    crate::telemetry::proposed(lane, "DataModel");

    let pr_title = if creating {
        format!("create DataModel {name}")
    } else {
        format!("update DataModel {name}")
    };
    let pr_body = format!(
        "Proposed {} of DataModel `{name}` source, manifest and generated artifacts in project `{project}` via joinedcontext Portal.",
        if creating { "creation" } else { "update" }
    );

    let pr = gitea
        .create_pull_request(&branch, &default_branch, &pr_title, &pr_body)
        .await?;

    let change_meta = crate::api::changes::change_meta(&state, gitea, pr.number, &project);
    let change_status = ChangeStatus::new(
        lane,
        ChangePhase::PendingApproval,
        if creating {
            PlanSummary {
                create: 6,
                update: 0,
                delete: 0,
            }
        } else {
            PlanSummary {
                create: 0,
                update: 6,
                delete: 0,
            }
        },
    )
    .in_repository(&pr.repository)
    .with_merge_request(pr.url);
    let change = Change::new(change_meta, change_status);

    Ok((StatusCode::ACCEPTED, Json(change)).into_response())
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/projects/{project}/datamodels/{name}/source",
            get(get_source).put(put_source),
        )
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BYTES))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// DM-56, T-1484: a model's source stays inside its space's `datamodels/` folder.
    #[test]
    fn confine_linkml_path_keeps_a_source_inside_its_folder() {
        assert_eq!(
            confine_linkml_path("./air-quality.linkml.yaml").expect("relative"),
            "air-quality.linkml.yaml"
        );
        assert_eq!(
            confine_linkml_path("v2/meranie-ovzdušia.linkml.yaml").expect("a folder, Unicode"),
            "v2/meranie-ovzdušia.linkml.yaml"
        );
        let long = format!("{}.linkml.yaml", "a".repeat(4096));
        assert_eq!(confine_linkml_path(&long).expect("long"), long);
        for refused in [
            "",
            "./",
            "/etc/air.linkml.yaml",
            ".//air.linkml.yaml",
            "../air.linkml.yaml",
            "./a/../b.linkml.yaml",
            "a/./b.linkml.yaml",
            "a\\..\\b.linkml.yaml",
            "%2e%2e/%2e%2e/other/secret.linkml.yaml",
            "air.linkml.yaml?ref=other",
            "x#.linkml.yaml",
            "air\n.linkml.yaml",
            "air.yaml",
            "air.linkml.yaml.bak",
        ] {
            assert!(
                confine_linkml_path(refused).is_err(),
                "{refused:?} was accepted"
            );
        }
    }

    fn classes(value: Value) -> Value {
        json!({ "classes": value })
    }

    fn severities(prev: &Value, next: &Value) -> Vec<(String, String)> {
        classify_linkml_changes(prev, next)
            .into_iter()
            .map(|change| (change.severity, change.subject))
            .collect()
    }

    /// DM-23, T-1484: removing is breaking, adding is additive, nothing changed is nothing.
    #[test]
    fn classify_linkml_changes_names_each_class_and_slot_change() {
        let before = json!({
            "classes": { "Station": { "slots": ["name", "bikes"] } },
            "slots": { "name": { "range": "string", "required": true }, "bikes": { "range": "integer" } }
        });
        assert!(severities(&before, &before).is_empty(), "nothing changed");
        assert!(
            severities(&json!({}), &json!({})).is_empty(),
            "two empty schemas"
        );

        let added = json!({ "classes": { "Station": { "slots": ["name", "bikes"] }, "Dock": {} },
                            "slots": before["slots"] });
        assert_eq!(
            severities(&before, &added),
            [("additive".into(), "Dock".into())]
        );
        assert_eq!(
            severities(&added, &before),
            [("breaking".into(), "Dock".into())],
            "a class removed"
        );
        assert_eq!(
            severities(&classes(json!({})), &classes(json!({ "Dock": {} }))),
            [("additive".into(), "Dock".into())]
        );
        assert_eq!(
            severities(&json!({}), &before)
                .iter()
                .filter(|(severity, _)| severity == "breaking")
                .count(),
            1,
            "from an empty schema, only the new required slot breaks"
        );

        let slot = |range: &str| {
            json!({ "classes": before["classes"],
                    "slots": { "name": before["slots"]["name"], "bikes": { "range": range } } })
        };
        assert_eq!(
            severities(&before, &slot("float")),
            [("additive".into(), "bikes".into())],
            "integer widened to float"
        );
        assert_eq!(
            severities(&slot("float"), &slot("integer")),
            [("breaking".into(), "bikes".into())],
            "float narrowed to integer"
        );
        assert_eq!(
            severities(&slot("datetime"), &slot("boolean")),
            [("breaking".into(), "bikes".into())],
            "a slot's type changed"
        );
        let unslotted =
            json!({ "classes": { "Station": { "slots": ["name"] } }, "slots": before["slots"] });
        assert_eq!(
            severities(&before, &unslotted),
            [("breaking".into(), "Station.bikes".into())]
        );
    }

    fn version(raw: &str) -> SemVer {
        SemVer::new(raw).expect("a version")
    }

    /// DM-22, DM-23, T-1484: breaking bumps the major, additive the minor, anything else the patch; a
    /// part already at its largest has no next version and says so.
    #[test]
    fn bump_version_moves_the_part_the_severity_names() {
        let current = version("1.4.2");
        let bumped = |severity: &str| {
            bump_version(&current, severity)
                .expect(severity)
                .to_string()
        };
        assert_eq!(bumped("breaking"), "2.0.0");
        assert_eq!(bumped("additive"), "1.5.0");
        assert_eq!(bumped("none"), "1.4.3");
        assert_eq!(bumped("an unknown severity"), "1.4.3");
        assert_eq!(bumped(""), "1.4.3");

        let max = u32::MAX;
        for (raw, severity) in [
            (format!("{max}.0.0"), "breaking"),
            (format!("0.{max}.0"), "additive"),
            (format!("0.0.{max}"), "none"),
        ] {
            let error = bump_version(&version(&raw), severity).expect_err(&raw);
            assert!(error.to_string().contains(&raw), "{error}");
        }
    }
}
