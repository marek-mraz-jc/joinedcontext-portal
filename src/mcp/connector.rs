//! One connector's MCP server at `/c/{id}` (AG-143..AG-147, ADR-N-064 §3.3, API/14 §3).
//!
//! The same JSON-RPC as `/api/v1/mcp`, answered as the connector's owner narrowed by the
//! connector. Each call is judged in the order API/14 §3 lists: the token (signature, issuer,
//! expiry, audience = this connector's address), the owner, the state, the client, then the tool
//! and its target. Nothing is cached across calls: the record is read and the owner's bindings
//! decide again every time, so a revoke, an expiry or a role the owner lost holds from the next
//! call. Every call past the token writes one audit row (connector, person, client, tool, target,
//! verdict, duration) and never a token, a header or an input value.

use std::time::Instant;

use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use super::{
    call_result, dispatch, error, failure_result, json_response, result, too_large,
    tool_definition, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES,
};
use crate::connectors::{self, Call, Connector};
use crate::error::ApiError;
use crate::personal_data::{self, Marks};
use crate::state::AppState;

/// The methods a connector serves. Resources, prompts and tasks read the platform past the
/// connector's scope check, so they stay the Portal MCP's (deny by default); the one resource a
/// connector reads is the plan view, a static page that holds no data (T-5960).
const METHODS: &[&str] = &["initialize", "ping", "tools/list", "tools/call"];

/// The `_meta` key naming the attributes an answer left out as personal (`Type.attribute`).
const WITHHELD_META: &str = "joinedcontext.com/withheld";

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/c/{id}",
            post(handle_connector).get(|| async { StatusCode::METHOD_NOT_ALLOWED }),
        )
        .route(
            "/c/{id}/.well-known/oauth-protected-resource",
            get(connector_metadata),
        )
        .layer(super::browser_clients())
}

fn base(state: &AppState) -> String {
    state
        .config
        .public_base_url
        .as_str()
        .trim_end_matches('/')
        .to_owned()
}

/// One answer for an id that does not exist and for another person's connector (AG-143).
fn unknown() -> Response {
    ApiError::NotFound("no such connector".into()).into_response()
}

fn unauthorized(address: &str) -> Response {
    let mut response = ApiError::Unauthorized.into_response();
    if let Ok(value) =
        format!("Bearer resource_metadata=\"{address}/.well-known/oauth-protected-resource\"")
            .parse()
    {
        response
            .headers_mut()
            .insert(header::WWW_AUTHENTICATE, value);
    }
    response
}

/// RFC 9728 metadata naming the connector as the resource a client asks a token for (RFC 8707).
pub async fn connector_metadata(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    if !connectors::is_id(&id) {
        return unknown();
    }
    let authorization_servers: Vec<String> = state
        .config
        .oidc
        .iter()
        .map(|oidc| oidc.issuer.as_str().trim_end_matches('/').to_owned())
        .collect();
    Json(json!({
        "resource": connectors::address(&base(&state), &id),
        "authorization_servers": authorization_servers,
        "bearer_methods_supported": ["header"],
    }))
    .into_response()
}

/// The MCP door of one connector.
pub async fn handle_connector(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let started = Instant::now();
    let address = connectors::address(&base(&state), &id);
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|t| !t.is_empty());
    let (Some(token), Some(verifier)) = (token, state.bearer.as_ref()) else {
        return unauthorized(&address);
    };
    // The audience is the connector's own address: a Portal token, or one for another
    // connector, is not a token for this one (AG-143).
    let Ok((session, _)) = verifier.verify_for_audience(token, &address).await else {
        return unauthorized(&address);
    };
    if state.is_revoked(&session) {
        return unauthorized(&address);
    }
    if !connectors::is_id(&id) {
        return unknown();
    }
    let connector = match state.connectors.get(&id, &base(&state)).await {
        Ok(Some(c)) => c,
        Ok(None) => return unknown(),
        Err(err) => return err.into_response(),
    };
    let message: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let (tool, target) = audited(&message);
    let identity = session.identity;
    let (response, verdict) = if connector.owner != identity.subject {
        (unknown(), "refused: not the owner".to_owned())
    } else {
        judge(&state, &connector, identity.clone(), token, &message, body).await
    };
    let call = Call {
        at: chrono::Utc::now(),
        subject: identity.subject,
        client: identity.client,
        tool,
        target,
        verdict,
        duration_ms: i32::try_from(started.elapsed().as_millis()).unwrap_or(i32::MAX),
    };
    if let Err(err) = state.connectors.record(&connector.id, call).await {
        tracing::warn!(connector = %connector.id, error = %err, "a connector call is not in its audit");
    }
    response
}

/// The tool (or method) and the `project/kind/name` a call names, identifiers only (AG-147).
fn audited(message: &Value) -> (String, Option<String>) {
    let method = message["method"].as_str().unwrap_or("");
    let params = &message["params"];
    let tool = match method {
        "tools/call" => params["name"].as_str().unwrap_or(""),
        other => other,
    };
    let word = |v: &Value| {
        v.as_str()
            .filter(|s| s.len() <= 63 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
            .map(str::to_owned)
    };
    let args = &params["arguments"];
    let target: Vec<String> = [
        word(&args["project"]).or_else(|| word(&params["project"])),
        word(&args["kind"]),
        word(&args["name"]).or_else(|| word(&args["endpoint"])),
    ]
    .into_iter()
    .flatten()
    .collect();
    let tool = if !tool.is_empty()
        && tool.len() <= 64
        && tool
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_/-".contains(&b))
    {
        tool.to_owned()
    } else {
        "unknown".to_owned()
    };
    (tool, (!target.is_empty()).then(|| target.join("/")))
}

/// A call past one of the connector's or the person's limits: 429 problem+json with
/// `Retry-After` in seconds (T-5968).
fn limited(why: &str, wait: i64) -> Response {
    let mut response = ApiError::TooManyRequests(why.to_owned()).into_response();
    if let Ok(value) = wait.to_string().parse() {
        response.headers_mut().insert(header::RETRY_AFTER, value);
    }
    response
}

fn refused_call(id: Value, why: &str) -> Value {
    tool_problem(id, 403, "forbidden", "Forbidden", why)
}

/// A tool error the model reads and can act on, its problem in `structuredContent`.
fn tool_problem(id: Value, status: u16, slug: &str, title: &str, why: &str) -> Value {
    result(
        id,
        json!({
            "isError": true,
            "content": [{ "type": "text", "text": why }],
            "structuredContent": {
                "type": format!("https://joinedcontext.com/problems/{slug}"),
                "title": title,
                "status": status,
                "detail": why,
            }
        }),
    )
}

/// What the connector answers itself: a read of the plan view, or the refusal of a method it
/// does not serve; `None` for a method the owner's call answers.
fn answered_here(
    state: &AppState,
    method: &str,
    id: &Value,
    message: &Value,
) -> Option<(Response, String)> {
    if method == "resources/read" && message["params"]["uri"] == super::app_view::URI {
        let contents = super::app_view::contents(&state.config.public_base_url);
        let answer = result(id.clone(), json!({ "contents": contents }));
        return Some((json_response(StatusCode::OK, &answer), "allowed".to_owned()));
    }
    if !METHODS.contains(&method) {
        let answer = error(
            id.clone(),
            -32601,
            "a connector serves initialize, ping, tools/list, tools/call and its plan view",
        );
        return Some((
            json_response(StatusCode::OK, &answer),
            "refused: method".to_owned(),
        ));
    }
    None
}

/// The owner's call, narrowed by the connector: the answer and its verdict.
async fn judge(
    state: &AppState,
    connector: &Connector,
    identity: crate::auth::session::Identity,
    token: &str,
    message: &Value,
    body: Bytes,
) -> (Response, String) {
    if !connector.is_active() {
        let why = format!(
            "this connector is {}; create a new one on the My connectors page",
            connector.state
        );
        return (
            ApiError::Denied(why).into_response(),
            format!("refused: {}", connector.state),
        );
    }
    let client = identity.client.as_deref().unwrap_or("");
    if !connector.allowed_clients.is_empty()
        && !connector.allowed_clients.iter().any(|c| c == client)
    {
        let why = format!(
            "this connector answers only {}; the token was obtained by {}",
            connector.allowed_clients.join(", "),
            if client.is_empty() {
                "no named client"
            } else {
                client
            }
        );
        return (
            ApiError::Denied(why).into_response(),
            "refused: client".to_owned(),
        );
    }
    if body.len() > MAX_REQUEST_BYTES {
        let why = format!(
            "the request is {} bytes; this route reads at most {MAX_REQUEST_BYTES}",
            body.len()
        );
        return (too_large(&why), "refused: too large".to_owned());
    }
    // The person's window first: it is the one their other connectors and `/api/v1/mcp` share.
    let (person, own, limits) = (
        identity.subject.clone(),
        format!("\u{0}c/{}", connector.id),
        connector.limits,
    );
    let person_limits = connectors::PERSON_LIMITS;
    if let Err((which, wait)) = state.mcp_admit(
        &[
            (&person, person_limits.calls_per_minute),
            (&own, limits.calls_per_minute),
        ],
        crate::auth::session::now_unix(),
    ) {
        let why = if which == 0 {
            format!(
                "you made {} MCP calls in this minute over all your connectors, your limit; \
                 calls open again in {wait} seconds",
                person_limits.calls_per_minute
            )
        } else {
            format!(
                "this connector made {} calls in this minute, its limit; calls open again in \
                 {wait} seconds",
                limits.calls_per_minute
            )
        };
        return (limited(&why, wait), "refused: rate limit".to_owned());
    }
    let _in_flight = match state.mcp_enter(&[
        (&person, person_limits.parallel_calls),
        (&own, limits.parallel_calls),
    ]) {
        Ok(held) => held,
        Err(which) => {
            let why = if which == 0 {
                format!(
                    "{} of your calls are running now, the most at once over all your \
                     connectors; send this one when one of them has answered",
                    person_limits.parallel_calls
                )
            } else {
                format!(
                    "{} calls of this connector are running now, its most at once; send this \
                     one when one of them has answered",
                    limits.parallel_calls
                )
            };
            return (limited(&why, 1), "refused: parallel calls".to_owned());
        }
    };
    let method = message["method"].as_str().unwrap_or("");
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    if !message.is_object() || method == "notifications/initialized" || message.get("id").is_none()
    {
        return (
            dispatch(state.clone(), caller(connector, identity, token), body).await,
            "allowed".to_owned(),
        );
    }
    if let Some(answered) = answered_here(state, method, &id, message) {
        return answered;
    }
    let params = &message["params"];
    let project = params["arguments"]["project"]
        .as_str()
        .or_else(|| params["project"].as_str())
        .map(str::to_owned);
    let caller = caller(connector, identity, token);
    match method {
        "tools/list" => {
            let project = project.unwrap_or_else(|| {
                connector
                    .projects()
                    .first()
                    .map(|p| (*p).to_owned())
                    .unwrap_or_default()
            });
            let tools: Vec<Value> = crate::ops::listing(&caller, state, &project)
                .iter()
                .filter(|summary| {
                    crate::ops::find(&summary.name).is_some_and(|op| connector.lists(op, &project))
                })
                .map(tool_definition)
                .collect();
            let answer = result(id, json!({ "tools": tools }));
            (json_response(StatusCode::OK, &answer), "allowed".to_owned())
        }
        "tools/call" => {
            let name = params["name"].as_str().unwrap_or("");
            let target = match (crate::ops::find(name), project.as_deref()) {
                (Some(op), Some(project)) => {
                    connector.admits(op, project, &params["arguments"]).err()
                }
                _ => None,
            };
            if let Some(why) = target {
                let answer = refused_call(id, &why);
                return (
                    json_response(StatusCode::OK, &answer),
                    "refused: target".to_owned(),
                );
            }
            let response = dispatch(state.clone(), caller, body).await;
            let shows = project
                .as_deref()
                .is_some_and(|p| connector.shows_personal(p, &params["arguments"]));
            let response = if shows {
                response
            } else {
                without_personal(state, project.as_deref(), response).await
            };
            verdict_of(response, id, limits.result_bytes).await
        }
        _ => (
            dispatch(state.clone(), caller, body).await,
            "allowed".to_owned(),
        ),
    }
}

fn caller(
    connector: &Connector,
    identity: crate::auth::session::Identity,
    token: &str,
) -> crate::ops::Caller {
    crate::ops::Caller {
        bearer: Some(crate::ops::Bearer(token.to_owned())),
        identity,
        via: crate::ops::Via::Mcp,
        access: Some(connector.access()),
    }
}

/// A call's answer without the attributes the project's models mark personal (AG-158). Only an
/// answer that carries an entity reads the models; one whose models cannot be read is refused,
/// since nothing personal could be withheld from it.
async fn without_personal(state: &AppState, project: Option<&str>, response: Response) -> Response {
    let (parts, body) = response.into_parts();
    let Ok(bytes) = axum::body::to_bytes(body, MAX_RESPONSE_BYTES).await else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let mut envelope: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    if !personal_data::carries_entities(&envelope["result"]["structuredContent"]) {
        return Response::from_parts(parts, Body::from(bytes));
    }
    let marks = match project {
        Some(project) => personal_data::of_project(state, project).await,
        None => Err("a call that answers entities names its project".to_owned()),
    };
    envelope["result"] = match marks {
        Ok(marks) => answered_without(envelope["result"]["structuredContent"].take(), &marks),
        Err(why) => failure_result(&why),
    };
    json_response(parts.status, &envelope)
}

/// The `tools/call` result of `output` without what `marks` names, saying which attributes left
/// so the client's model can tell the person why they are missing.
fn answered_without(mut output: Value, marks: &Marks) -> Value {
    let removed = personal_data::withhold(&mut output, marks);
    let mut answer = call_result(&output);
    if !removed.is_empty() {
        answer["_meta"][WITHHELD_META] = json!(removed);
    }
    answer
}

/// The verdict of a dispatched call, read off its envelope; the answer goes back unchanged
/// unless it is larger than the connector's `result_bytes` (T-5968).
async fn verdict_of(response: Response, id: Value, result_bytes: usize) -> (Response, String) {
    let (parts, body) = response.into_parts();
    let Ok(bytes) = axum::body::to_bytes(body, MAX_RESPONSE_BYTES).await else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            "error".to_owned(),
        );
    };
    if bytes.len() > result_bytes {
        let why = format!(
            "the answer is {} bytes; this connector returns at most {result_bytes}. Ask for \
             fewer items (limit), fewer attributes (attrs) or one resource by name",
            bytes.len()
        );
        let answer = tool_problem(id, 413, "payload-too-large", "Payload Too Large", &why);
        return (
            json_response(StatusCode::OK, &answer),
            "refused: result size".to_owned(),
        );
    }
    let envelope: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let verdict = if !parts.status.is_success() || envelope.get("error").is_some() {
        "error"
    } else if envelope["result"]["isError"] == json!(true) {
        "refused: tool"
    } else {
        "allowed"
    };
    (
        Response::from_parts(parts, Body::from(bytes)),
        verdict.to_owned(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn an_answer_past_the_connector_result_size_is_a_413_tool_error() {
        let answer = result(
            json!(7),
            json!({ "content": [{ "type": "text", "text": "x".repeat(100) }] }),
        );
        let response = || json_response(StatusCode::OK, &answer);
        let (kept, verdict) = verdict_of(response(), json!(7), 1_000).await;
        assert_eq!(
            (kept.status(), verdict.as_str()),
            (StatusCode::OK, "allowed")
        );
        let (refused, verdict) = verdict_of(response(), json!(7), 50).await;
        assert_eq!(verdict, "refused: result size");
        let bytes = axum::body::to_bytes(refused.into_body(), 10_000)
            .await
            .expect("body");
        let body: Value = serde_json::from_slice(&bytes).expect("json");
        assert_eq!(body["id"], 7);
        assert_eq!(body["result"]["isError"], true);
        assert_eq!(body["result"]["structuredContent"]["status"], 413);
        let detail = body["result"]["structuredContent"]["detail"]
            .as_str()
            .expect("detail");
        assert!(
            detail.contains("at most 50") && detail.contains("(limit)"),
            "{detail}"
        );
    }

    #[test]
    fn the_audit_keeps_identifiers_and_drops_input_values() {
        let (tool, target) = audited(&json!({
            "method": "tools/call",
            "params": { "name": "jc_resource_get", "arguments": {
                "project": "doprava", "kind": "Endpoint", "name": "counters",
                "q": "secret-looking value" } }
        }));
        assert_eq!(tool, "jc_resource_get");
        assert_eq!(target.as_deref(), Some("doprava/Endpoint/counters"));
        // A name that is not an identifier is not kept: it could be anything the model typed.
        let (_, target) = audited(&json!({
            "method": "tools/call",
            "params": { "name": "jc_resource_get", "arguments": {
                "project": "doprava", "name": "Bearer eyJhbGciOi..." } }
        }));
        assert_eq!(target.as_deref(), Some("doprava"));
        let (tool, target) = audited(&json!({ "method": "tools/list", "params": {} }));
        assert_eq!((tool.as_str(), target), ("tools/list", None));
    }

    #[test]
    fn an_answer_loses_its_personal_attributes_and_says_which_in_text_and_structure() {
        let marks = personal_data::marks(
            "classes:\n  PotholeReport:\n    slots: [description, contactEmail]\nslots:\n  contactEmail:\n    annotations: { personalData: true }\n",
        );
        let output = json!({ "entities": [{
            "id": "urn:ngsi-ld:PotholeReport:1", "type": "PotholeReport",
            "description": "Hlboká jama", "contactEmail": "jana@example.org"
        }] });
        let answer = answered_without(output, &marks);
        let text = answer.to_string();
        assert!(!text.contains("jana@example.org"), "{text}");
        assert!(answer["content"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .contains("Hlboká jama"));
        assert_eq!(
            answer["_meta"][WITHHELD_META],
            json!(["PotholeReport.contactEmail"])
        );
        assert_eq!(answer["_meta"][super::super::UNTRUSTED_META], json!(true));
        let plain = answered_without(json!({ "items": [] }), &marks);
        assert!(plain["_meta"].get(WITHHELD_META).is_none());
    }
}
