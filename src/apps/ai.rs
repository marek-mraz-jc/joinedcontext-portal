//! `POST /apps/{name}/api/services/ai/complete`: a completion for an App from the model the
//! platform chooses, through `jc-agent-proxy`, within the App's `aiTokensPerDay` (AP-169, AP-165,
//! API/06 §3, T-3584).
//!
//! The App holds no key and names no model (AP-147): the Portal sends the call as its own service
//! account with `X-JC-App`, the proxy adds the organization's key. The model is the `app-builder`
//! profile's, or the first of the organization's `policies.agents.models` when that list leaves
//! the profile's out. Neither a prompt nor an answer is logged: an App's people write into them.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Json;
use jc_core::kinds::AppService;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

use super::services::{self, Quota};
use crate::agents::profile::Profile;
use crate::error::ApiError;
use crate::permissions::ORG_NAMESPACE;
use crate::state::AppState;
use crate::store::ListOptions;

pub const MAX_BODY_BYTES: usize = 256 * 1024;
const MAX_MESSAGES: usize = 50;
const MAX_CONTENT_BYTES: usize = 100 * 1024;
const MAX_SCHEMA_BYTES: usize = 16 * 1024;
/// The answer's ceiling unless the App asks for less, and the most it may ask for.
const DEFAULT_MAX_TOKENS: u32 = 1024;
const MAX_TOKENS: u32 = 4096;
/// The profile whose model an App's completion uses.
const PROFILE: &str = "app-builder";
const PROXY_TIMEOUT: Duration = Duration::from_secs(60);
const SERVICE: &str = "ai";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Message {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Complete {
    messages: Vec<Message>,
    #[serde(default)]
    max_tokens: Option<u32>,
    #[serde(default)]
    schema: Option<Value>,
}

fn bad(detail: impl Into<String>) -> Response {
    ApiError::BadRequest(detail.into()).into_response()
}

/// What is wrong with a request before anything is asked, `None` when nothing is.
fn refusal(request: &Complete) -> Option<String> {
    if request.messages.is_empty() || request.messages.len() > MAX_MESSAGES {
        return Some(format!("messages holds 1 to {MAX_MESSAGES} messages"));
    }
    if let Some(message) = request
        .messages
        .iter()
        .find(|message| !matches!(message.role.as_str(), "system" | "user" | "assistant"))
    {
        return Some(format!(
            "role '{}' is none of system, user and assistant",
            message.role
        ));
    }
    if !request
        .messages
        .iter()
        .any(|message| message.role == "user")
    {
        return Some("messages holds at least one user message".into());
    }
    let content: usize = request.messages.iter().map(|m| m.content.len()).sum();
    if content > MAX_CONTENT_BYTES {
        return Some(format!(
            "the messages hold at most {MAX_CONTENT_BYTES} bytes"
        ));
    }
    if request.max_tokens.is_some_and(|n| n == 0 || n > MAX_TOKENS) {
        return Some(format!("maxTokens is 1 to {MAX_TOKENS}"));
    }
    match &request.schema {
        Some(schema) if !schema.is_object() => Some("schema is a JSON Schema object".into()),
        Some(schema) if schema.to_string().len() > MAX_SCHEMA_BYTES => {
            Some(format!("schema is at most {MAX_SCHEMA_BYTES} bytes"))
        }
        Some(schema) if jsonschema::validator_for(schema).is_err() => {
            Some("schema is no JSON Schema".into())
        }
        _ => None,
    }
}

/// The model and the body shape: the profile's, held to the organization's list (AG-53).
fn model(state: &AppState) -> Option<(String, String)> {
    let profile = Profile::load(&state.mirror, PROFILE).ok()?;
    let allowed: Option<Vec<String>> = state
        .mirror
        .list(ORG_NAMESPACE, "Organization", &ListOptions::default())
        .items
        .into_iter()
        .next()
        .and_then(|org| org.spec.pointer("/policies/agents/models").cloned())
        .and_then(|models| serde_json::from_value(models).ok());
    let name = match allowed {
        Some(list) if !list.contains(&profile.model_name) => list.into_iter().next()?,
        _ => profile.model_name,
    };
    Some((name, profile.model_provider))
}

/// The provider's body: Anthropic's messages with the system part apart, else chat completions.
fn upstream(
    (model, provider): (&str, &str),
    request: &Complete,
    max_tokens: u32,
) -> (&'static str, Value) {
    let mut system: Vec<&str> = request
        .messages
        .iter()
        .filter(|m| m.role == "system")
        .map(|m| m.content.as_str())
        .collect();
    let instruction = request.schema.as_ref().map(|schema| {
        format!(
            "Answer with exactly one JSON value and nothing else, no prose and no code fence, \
             that conforms to this JSON Schema: {schema}"
        )
    });
    if let Some(instruction) = &instruction {
        system.push(instruction);
    }
    let turns = request.messages.iter().filter(|m| m.role != "system");
    if provider == "anthropic" {
        let messages: Vec<Value> = turns
            .map(|m| json!({ "role": m.role, "content": m.content }))
            .collect();
        let mut body = json!({ "model": model, "max_tokens": max_tokens, "messages": messages });
        if !system.is_empty() {
            body["system"] = json!(system.join("\n\n"));
        }
        ("/v1/llm/v1/messages", body)
    } else {
        let mut messages: Vec<Value> = Vec::new();
        if !system.is_empty() {
            messages.push(json!({ "role": "system", "content": system.join("\n\n") }));
        }
        messages.extend(turns.map(|m| json!({ "role": m.role, "content": m.content })));
        (
            "/v1/llm/chat/completions",
            json!({ "model": model, "max_tokens": max_tokens, "messages": messages }),
        )
    }
}

/// The answer's text and its tokens in and out, from either provider's shape.
fn answer(body: &Value) -> Option<(String, u32, u32)> {
    let count = |pointer: &str| {
        body.pointer(pointer)
            .and_then(Value::as_u64)
            .map(|n| u32::try_from(n).unwrap_or(u32::MAX))
    };
    if let Some(text) = body
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
    {
        return Some((
            text.to_owned(),
            count("/usage/prompt_tokens").unwrap_or(0),
            count("/usage/completion_tokens").unwrap_or(0),
        ));
    }
    let parts = body.get("content")?.as_array()?;
    let text: String = parts
        .iter()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect();
    Some((
        text,
        count("/usage/input_tokens").unwrap_or(0),
        count("/usage/output_tokens").unwrap_or(0),
    ))
}

fn no_model_key() -> Response {
    services::problem(
        StatusCode::SERVICE_UNAVAILABLE,
        "no-model-key",
        "No Model Key",
        "the organization's model key is missing, refused or out of credit".into(),
        json!({ "service": SERVICE }),
    )
}

fn unavailable(detail: &str) -> Response {
    ApiError::Unavailable(detail.to_owned()).into_response()
}

pub(super) async fn complete(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path(name): Path<String>,
    body: Bytes,
) -> Response {
    let (project, spec, _) = match services::gate(
        &state,
        &headers,
        &uri,
        &name,
        (AppService::Ai, &Method::POST),
    )
    .await
    {
        Ok(gated) => gated,
        Err(refused) => return *refused,
    };
    let json = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.trim_start().starts_with("application/json"));
    if !json {
        return ApiError::UnsupportedMediaType("send the request as application/json".into())
            .into_response();
    }
    let request: Complete = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(err) => return bad(format!("the body is not a completion request: {err}")),
    };
    if let Some(why) = refusal(&request) {
        return bad(why);
    }
    let (Some(settings), Some(oidc), Some(db)) = (
        state.config.agent_settings.as_ref(),
        state.oidc.as_deref(),
        state.db.as_ref(),
    ) else {
        return unavailable("this installation answers no App's ai calls");
    };
    let Some((model, provider)) = model(&state) else {
        return unavailable("this installation has no app-builder profile to take the model from");
    };

    let limit = services::quota(&state.mirror, &project, &spec, Quota::AiTokensPerDay);
    let used = match services::used_today(db, (&project, &name), SERVICE, "").await {
        Ok(used) => used,
        Err(err) => return ApiError::Internal(err.to_string()).into_response(),
    };
    if used >= limit {
        return services::quota_used(
            AppService::Ai,
            "aiTokensPerDay",
            Some(time::OffsetDateTime::now_utc()),
        );
    }
    // ponytail: the answer is held to what is left of the day, the prompt is not, so one call
    // may pass the quota by its prompt; reserve the prompt's tokens first if that matters.
    let max_tokens = request
        .max_tokens
        .unwrap_or(DEFAULT_MAX_TOKENS)
        .min(limit - used);

    let (path, upstream_body) = upstream((&model, &provider), &request, max_tokens);
    let token = match oidc.service_token().await {
        Ok(token) => token,
        Err(_) => return unavailable("the Portal has no token to ask the model service with"),
    };
    let http = match reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(PROXY_TIMEOUT)
        .build()
    {
        Ok(http) => http,
        Err(_) => return unavailable("the model service cannot be reached"),
    };
    let sent = http
        .post(format!(
            "{}{path}",
            settings.proxy_base.trim_end_matches('/')
        ))
        .bearer_auth(token)
        .header("x-jc-app", format!("{project}/{name}"))
        .json(&upstream_body)
        .send()
        .await;
    let response = match sent {
        Ok(response) => response,
        Err(err) => {
            tracing::warn!(app = %name, %project, timeout = err.is_timeout(), "an App's ai call did not reach the model service");
            return unavailable("the model service did not answer; try again in a moment");
        }
    };
    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    if matches!(status, 401..=403) {
        // The provider's refusal of the key reaches the App as the installation's problem.
        tracing::warn!(app = %name, %project, status, "the model service refused an App's ai call");
        return no_model_key();
    }
    if !(200..300).contains(&status) {
        tracing::warn!(app = %name, %project, status, "the model service failed an App's ai call");
        return unavailable("the model service failed; try again in a moment");
    }
    let Some((answer_text, tokens_in, tokens_out)) = serde_json::from_str::<Value>(&text)
        .ok()
        .as_ref()
        .and_then(answer)
    else {
        return unavailable("the model service's answer could not be read");
    };
    if let Err(err) = services::take(
        db,
        (&project, &name),
        SERVICE,
        "",
        tokens_in.saturating_add(tokens_out),
        u32::MAX,
    )
    .await
    {
        tracing::error!(app = %name, %project, error = %err, "an App's ai tokens were not counted");
    }
    tracing::info!(app = %name, %project, tokens_in, tokens_out, "app ai completion");

    let mut out = json!({ "text": answer_text, "tokens": { "in": tokens_in, "out": tokens_out } });
    if let Some(schema) = &request.schema {
        let parsed = serde_json::from_str::<Value>(answer_text.trim())
            .ok()
            .filter(|value| {
                jsonschema::validator_for(schema).is_ok_and(|validator| validator.is_valid(value))
            });
        let Some(parsed) = parsed else {
            return services::problem(
                StatusCode::BAD_GATEWAY,
                "no-json",
                "No JSON",
                "the model's answer is no JSON of the schema; ask again".into(),
                json!({ "service": SERVICE }),
            );
        };
        out["json"] = parsed;
    }
    Json(out).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(value: Value) -> Complete {
        serde_json::from_value(value).expect("a request")
    }

    #[test]
    fn a_request_is_refused_before_anything_is_asked() {
        let user = json!([{ "role": "user", "content": "Classify." }]);
        assert_eq!(refusal(&request(json!({ "messages": user }))), None);
        for (body, why) in [
            (json!({ "messages": [] }), "1 to 50"),
            (
                json!({ "messages": [{ "role": "tool", "content": "x" }] }),
                "role 'tool'",
            ),
            (
                json!({ "messages": [{ "role": "system", "content": "x" }] }),
                "one user",
            ),
            (json!({ "messages": user, "maxTokens": 0 }), "maxTokens"),
            (json!({ "messages": user, "maxTokens": 5000 }), "maxTokens"),
            (
                json!({ "messages": user, "schema": [1] }),
                "JSON Schema object",
            ),
            (
                json!({ "messages": user, "schema": { "type": 7 } }),
                "no JSON Schema",
            ),
            (
                json!({ "messages": [{ "role": "user", "content": "x".repeat(MAX_CONTENT_BYTES + 1) }] }),
                "at most",
            ),
        ] {
            let refused = refusal(&request(body.clone())).unwrap_or_default();
            assert!(refused.contains(why), "{body}: {refused}");
        }
    }

    #[test]
    fn each_provider_gets_its_own_shape_with_the_schema_as_an_instruction() {
        let ask = request(json!({
            "messages": [{ "role": "system", "content": "You sort defects." },
                         { "role": "user", "content": "A pothole." }],
            "schema": { "type": "object" },
        }));
        let (path, body) = upstream(("claude-sonnet-5", "anthropic"), &ask, 100);
        assert_eq!(path, "/v1/llm/v1/messages");
        assert_eq!(
            body["messages"],
            json!([{ "role": "user", "content": "A pothole." }])
        );
        assert!(body["system"]
            .as_str()
            .is_some_and(|s| s.starts_with("You sort defects.") && s.contains("JSON Schema")));
        let (path, body) = upstream(("m", "openai-compatible"), &ask, 100);
        assert_eq!(path, "/v1/llm/chat/completions");
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["max_tokens"], 100);

        assert_eq!(
            answer(
                &json!({ "content": [{ "type": "text", "text": "ok" }], "usage": { "input_tokens": 3, "output_tokens": 1 } })
            ),
            Some(("ok".to_owned(), 3, 1))
        );
        assert_eq!(
            answer(
                &json!({ "choices": [{ "message": { "content": "ok" } }], "usage": { "prompt_tokens": 5, "completion_tokens": 2 } })
            ),
            Some(("ok".to_owned(), 5, 2))
        );
        assert_eq!(answer(&json!({ "error": "x" })), None);
    }
}
