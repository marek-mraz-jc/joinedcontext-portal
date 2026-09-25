//! `POST /apps/{name}/api/functions/{fn}`: a published application's function, run in
//! `jc-functions` with the person's own token (AP-84, SDK-23, Architecture/20 §3).
//!
//! The code that runs is the `functions.js` of the build the host serves, integrity-checked like
//! every file it serves (AP-12), never a body-supplied source. The caller's `X-Access-Token`, set
//! by the edge, is the one credential the function's data calls carry (AP-26); a public app's
//! anonymous caller has none. A request that carries a token carries the double-submit CSRF
//! token too, because the edge attaches the token from a cookie a cross-site form would also send.

use std::collections::BTreeMap;
use std::path::Path as FsPath;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Json;

use super::static_host::{
    app_root, integrity_of, off_its_origin, published_app, served_config, sri_sha384,
};
use crate::api::agent_runs::{invoke, is_function_name, InvokeError, RefusedStatus};
use crate::auth::session::EDGE_TOKEN_HEADER;
use crate::error::ApiError;
use crate::state::AppState;

/// The largest body a function takes, the runtime's own limit (Architecture/20 §3).
pub const MAX_BODY_BYTES: usize = 256 * 1024;

/// The bundle the build lane writes beside the interface (AP-84).
const BUNDLE: &str = "functions.js";

pub(super) async fn call(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path((name, function)): Path<(String, String)>,
    Query(query): Query<BTreeMap<String, String>>,
    body: Bytes,
) -> Response {
    if let Some(refused) = off_its_origin(&state, &headers, &name, &uri) {
        return refused;
    }
    let not_found =
        || ApiError::NotFound(format!("app '{name}' has no function '{function}'")).into_response();
    // A name no function file could have never reaches the runtime.
    if !is_function_name(&function) {
        return not_found();
    }
    let Some((project, spec, build)) = published_app(&state, &name) else {
        return not_found();
    };
    let person = super::roles::person(&state, &headers, &spec, &name).await;
    if !super::roles::may_open(&spec, person.as_ref()) {
        return not_found();
    }
    let token = edge_token(&state, &headers);
    if token.is_some() && !crate::auth::csrf::is_allowed(&Method::POST, &headers) {
        return ApiError::Forbidden.into_response();
    }
    let Some(root) = app_root(
        state.config.apps_dir.as_deref().map(FsPath::new),
        state.config.apps_cache_dir.as_deref().map(FsPath::new),
        &name,
        build.as_ref(),
    ) else {
        return not_found();
    };
    let Ok(bundle) = std::fs::read(root.join(BUNDLE)) else {
        return not_found();
    };
    if integrity_of(&root, BUNDLE).as_deref() != Some(sri_sha384(&bundle).as_str()) {
        // Only the bytes the lane built run; anything else in the directory is not the build.
        tracing::error!(app = %name, "functions.js fails its recorded integrity digest");
        return ApiError::Unavailable("the app bundle failed its integrity check".into())
            .into_response();
    }
    let Ok(bundle) = String::from_utf8(bundle) else {
        return not_found();
    };
    let input: serde_json::Value = if body.is_empty() {
        serde_json::Value::Null
    } else {
        match serde_json::from_slice(&body) {
            Ok(input) => input,
            Err(err) => {
                return ApiError::BadRequest(format!("the body is not JSON: {err}")).into_response()
            }
        }
    };

    let domain = crate::api::assistant::org_domain(&state, &project);
    let config = served_config(&state.mirror, &project, &name, &spec, &domain)
        .unwrap_or_else(|| serde_json::json!({ "orgDomain": domain, "appName": name }));
    // The person the page was served, with their roles in this app and never the platform's:
    // set here, never from the caller's body or headers (SDK-37, AP-95).
    let request = serde_json::json!({
        "method": "POST",
        "query": query,
        "body": input,
        "user": super::roles::app_user(person.as_ref()),
    });
    let modules = BTreeMap::from([
        ("@app/functions.js".to_owned(), bundle),
        ("@app/entry.js".to_owned(), entry(&function)),
    ]);
    match invoke(
        &state,
        modules,
        "@app/entry.js".to_owned(),
        request,
        config,
        token,
    )
    .await
    {
        Ok(invocation) => answer(&name, &function, invocation.outcome),
        Err(err) => refusal(err),
    }
}

/// The module the runtime calls: the bundle's export named `function`, or a `404` answered from
/// inside the runtime when the build holds no such function.
fn entry(function: &str) -> String {
    let name = serde_json::to_string(function).unwrap_or_default();
    format!(
        "import * as all from \"@app/functions.js\";\n\
         const found = all[{name}];\n\
         export default typeof found === \"function\"\n\
         \x20 ? found\n\
         \x20 : () => ({{ status: 404, body: {{ title: \"Not Found\", status: 404, detail: {detail} }} }});\n",
        detail = serde_json::to_string(&format!("this build has no function '{function}'"))
            .unwrap_or_default(),
    )
}

/// The token the edge set for this request, and only when this Portal trusts the edge.
fn edge_token(state: &AppState, headers: &HeaderMap) -> Option<String> {
    if !state.config.trust_edge_token {
        return None;
    }
    headers
        .get(&EDGE_TOKEN_HEADER)
        .and_then(|value| value.to_str().ok())
        .filter(|token| !token.is_empty())
        .map(str::to_owned)
}

/// The runtime's `{status, body, logs}` as the response: the function's own status and body, or
/// `500` with where it failed. The logs go to the Portal's log, never to the caller.
fn answer(name: &str, function: &str, outcome: serde_json::Value) -> Response {
    if let Some(logs) = outcome.get("logs").filter(|logs| !logs.is_null()) {
        tracing::debug!(app = %name, function = %function, %logs, "function logs");
    }
    if let Some(error) = outcome.get("error").filter(|error| !error.is_null()) {
        tracing::warn!(app = %name, function = %function, %error, "function failed");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": error })),
        )
            .into_response();
    }
    let status = outcome["status"]
        .as_u64()
        .and_then(|status| u16::try_from(status).ok())
        .and_then(|status| StatusCode::from_u16(status).ok())
        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let body = outcome
        .get("body")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    (status, Json(body)).into_response()
}

fn refusal(err: InvokeError) -> Response {
    match err {
        InvokeError::Unavailable(reason) => ApiError::Unavailable(reason).into_response(),
        InvokeError::Refused {
            status: RefusedStatus::Full,
            ..
        } => {
            let mut response = ApiError::TooManyRequests(
                "jc-functions is running all the calls it takes; try again".into(),
            )
            .into_response();
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from_static("1"));
            response
        }
        InvokeError::Refused {
            status: RefusedStatus::TooLarge,
            ..
        } => (
            StatusCode::PAYLOAD_TOO_LARGE,
            "the body is larger than a function takes",
        )
            .into_response(),
        InvokeError::Refused { reason, .. } => ApiError::Unavailable(reason).into_response(),
        // Neither is reached from here: the bundle is already built, and a missing function is
        // the runtime's own 404 (see `entry`).
        InvokeError::NoFunction | InvokeError::DoesNotBuild(_) => {
            ApiError::Unavailable("the function could not be prepared".into()).into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::entry;

    /// AP-84: the entry names the function as a JSON string, so no name reaches the module as
    /// code, and a function the bundle lacks answers 404 from inside the runtime.
    #[test]
    fn the_entry_quotes_the_function_name_and_answers_404_for_a_missing_one() {
        let module = entry("near-me");
        assert!(module.contains("all[\"near-me\"]"), "{module}");
        assert!(module.contains("status: 404"), "{module}");
        assert!(module.starts_with("import * as all from \"@app/functions.js\";"));
    }
}
