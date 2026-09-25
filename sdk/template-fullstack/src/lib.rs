//! The backend of a `ui-rust` application (AP-105, AP-126, ADR-N-036).
//!
//! It serves the interface in `ui/`, built and embedded, with the `#jc-config` the App SDK starts
//! from written into its page; answers who the person is at `/api/me`; computes the `summary` the
//! interface's overview asks for, reading the endpoint with the person's own token, the example
//! to copy for the app's own routes; and answers the pod's readiness probe at `/healthz`.
//!
//! It holds no credential and has no login. The platform edge (APISIX `openid-connect`) in front
//! of it does the login and hands over the person's access token as `X-Access-Token` and their
//! userinfo as `X-Userinfo`; the backend carries that token to the endpoint, whose gateway
//! decides what it may read or write, and shows the gateway's refusal as it came (AP-28, AP-40).

use std::sync::Arc;

use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine as _;
use serde::Deserialize;
use serde_json::{json, Map, Value};

pub mod assets;

/// What the reconciler hands the container (Architecture/16 §5 and §13).
#[derive(Clone, Debug)]
pub struct Config {
    /// `/apps/{name}/`, the path the app is served under.
    pub base_path: String,
    /// `https://{host}/api/endpoint/{slug}/`, the one endpoint it reads and writes through (AP-04).
    pub endpoint_url: String,
    /// The Portal route that answers the person's roles in this App (AP-109).
    pub me_url: Option<String>,
    /// `true` on a `public` App, where a request without `X-Access-Token` is normal (AP-28).
    pub anonymous: bool,
    /// `JC_APP_CONFIG`: the `#jc-config` of the page without `user` (AP-95, AP-126).
    pub app_config: Map<String, Value>,
}

impl Config {
    /// Reads the process environment; see [`Config::from_vars`].
    pub fn from_env() -> Result<Self, String> {
        Self::from_vars(|name| std::env::var(name).ok())
    }

    /// Reads the variables through `var`. The endpoint and the page's configuration are
    /// required: an app with nowhere to read from, or a page the SDK cannot start, has nothing
    /// to serve, and a default would be a guess at which data a person gets.
    pub fn from_vars(var: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        let set = |name: &str| var(name).filter(|value| !value.trim().is_empty());
        let endpoint_url = set("JC_ENDPOINT_URL").ok_or("JC_ENDPOINT_URL is not set")?;
        if !endpoint_url.starts_with("https://") && !endpoint_url.starts_with("http://") {
            return Err("JC_ENDPOINT_URL is not an http(s) URL".to_owned());
        }
        let raw = set("JC_APP_CONFIG")
            .ok_or("JC_APP_CONFIG is not set: the page's App SDK starts from it")?;
        let app_config = match serde_json::from_str::<Value>(&raw) {
            Ok(Value::Object(mut object)) => {
                // The person is added per request, from `/me`; never one the environment names.
                object.remove("user");
                object
            }
            Ok(_) => return Err("JC_APP_CONFIG is not a JSON object".to_owned()),
            Err(err) => return Err(format!("JC_APP_CONFIG is not JSON: {err}")),
        };
        let base = set("JC_BASE_PATH").unwrap_or_else(|| "/".to_owned());
        Ok(Self {
            base_path: format!("/{}/", base.trim_matches('/')).replace("//", "/"),
            endpoint_url: format!("{}/", endpoint_url.trim_end_matches('/')),
            me_url: set("JC_ME_URL"),
            anonymous: set("JC_ANONYMOUS").is_some_and(|value| value == "true"),
            app_config,
        })
    }
}

/// The application state: its configuration and the one HTTP client it calls out with.
pub struct App {
    pub config: Config,
    http: reqwest::Client,
}

impl App {
    pub fn new(config: Config) -> Self {
        Self {
            config,
            http: reqwest::Client::new(),
        }
    }
}

/// The routes under the app's base path, the embedded interface behind them. Add the app's own
/// routes beside `/api/functions/summary`.
///
/// The prefix is spelled into every route rather than nested: `Router::nest` does not match the
/// prefix with a trailing slash, which is exactly the address the Portal links to.
pub fn router(app: Arc<App>) -> Router {
    let base = app.config.base_path.trim_end_matches('/').to_owned();
    let at = |tail: &str| format!("{base}{tail}");
    let mut router = Router::new()
        // The pod's readiness probe, at the root: the kubelet asks it, not a browser.
        .route("/healthz", get(healthz))
        .route(&at("/api/me"), get(me))
        .route(&at("/api/functions/summary"), post(summary))
        .route(&at("/"), get(assets::index))
        .route(&at("/index.html"), get(assets::index))
        .route(&at("/{*path}"), get(assets::file));
    // The prefix without its slash is the same page: a person who types it is not someone else.
    if !base.is_empty() {
        router = router.route(&base, get(assets::index));
    }
    router.with_state(app)
}

/// What the edge says about the caller (AP-28). Nothing of it decides anything here: the token
/// is carried to the gateway, which decides; the userinfo is shown and nowhere else used.
#[derive(Debug, Default)]
pub struct Caller {
    token: Option<String>,
    name: Option<String>,
}

impl Caller {
    pub fn of(headers: &HeaderMap) -> Self {
        let header = |name: &str| {
            headers
                .get(name)
                .and_then(|value| value.to_str().ok())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        };
        let userinfo = header("x-userinfo")
            .and_then(|encoded| decode_userinfo(&encoded))
            .unwrap_or_default();
        let field = |name: &str| userinfo.get(name)?.as_str().map(str::to_owned);
        Self {
            token: header("x-access-token"),
            name: field("name").or_else(|| field("preferred_username")),
        }
    }
}

/// `X-Userinfo` is the userinfo document in base64, as lua-resty-openidc sends it; a header that
/// decodes to no JSON object is no userinfo.
fn decode_userinfo(encoded: &str) -> Option<Value> {
    use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};
    [STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD]
        .iter()
        .find_map(|engine| engine.decode(encoded).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .filter(Value::is_object)
}

async fn healthz() -> &'static str {
    "ok"
}

/// A failure the caller may see, as a problem document (RFC 9457).
#[derive(Debug)]
pub enum AppError {
    /// The app's own refusal, with what to change.
    Refused(StatusCode, String),
    /// The endpoint answered with a refusal, and its answer is the answer (AP-40, GW6).
    Upstream(StatusCode, String),
    /// The endpoint or the Portal did not answer.
    Unreachable,
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let problem = |status: StatusCode, detail: &str| {
            json!({
                "type": "about:blank",
                "title": status.canonical_reason().unwrap_or("Error"),
                "status": status.as_u16(),
                "detail": detail,
            })
            .to_string()
        };
        let (status, body) = match self {
            Self::Refused(status, detail) => (status, problem(status, &detail)),
            Self::Upstream(status, body) => (status, body),
            Self::Unreachable => (
                StatusCode::BAD_GATEWAY,
                problem(
                    StatusCode::BAD_GATEWAY,
                    "the endpoint did not answer; try again in a moment",
                ),
            ),
        };
        (
            status,
            [(header::CONTENT_TYPE, "application/problem+json")],
            body,
        )
            .into_response()
    }
}

impl App {
    /// One GET against the endpoint with the person's token, or anonymous on a `public` App
    /// (AP-28). Never retried without the token: a fallback would lend the app's reach to anyone.
    pub async fn read(
        &self,
        tail: &str,
        query: &[(&str, String)],
        caller: &Caller,
    ) -> Result<Value, AppError> {
        let Some(token) = caller.token.as_deref() else {
            if !self.config.anonymous {
                return Err(AppError::Refused(
                    StatusCode::UNAUTHORIZED,
                    "no access token reached the app: open it through the platform's address"
                        .to_owned(),
                ));
            }
            return self
                .send(
                    self.http
                        .get(format!("{}{tail}", self.config.endpoint_url))
                        .query(query),
                )
                .await;
        };
        self.send(
            self.http
                .get(format!("{}{tail}", self.config.endpoint_url))
                .query(query)
                .bearer_auth(token),
        )
        .await
    }

    async fn send(&self, request: reqwest::RequestBuilder) -> Result<Value, AppError> {
        let response = request.send().await.map_err(|err| {
            tracing::warn!(error = %err.without_url(), "the endpoint did not answer");
            AppError::Unreachable
        })?;
        let status =
            StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        let body = response.text().await.map_err(|_| AppError::Unreachable)?;
        if !status.is_success() {
            tracing::info!(status = status.as_u16(), "the endpoint refused");
            return Err(AppError::Upstream(status, body));
        }
        serde_json::from_str(&body).map_err(|_| AppError::Unreachable)
    }

    /// The person in this App, from the Portal's `/me` with their token (AP-109): id, name,
    /// e-mail and roles. None when there is no token, no `JC_ME_URL`, or no clear answer; the
    /// page then offers what a person without a role gets (fail closed).
    pub async fn user(&self, caller: &Caller) -> Option<Value> {
        let (Some(url), Some(token)) = (&self.config.me_url, &caller.token) else {
            return None;
        };
        let response = match self.http.get(url).bearer_auth(token).send().await {
            Ok(response) if response.status().is_success() => response,
            Ok(response) => {
                tracing::info!(
                    status = response.status().as_u16(),
                    "the Portal did not answer /me"
                );
                return None;
            }
            Err(err) => {
                tracing::warn!(error = %err.without_url(), "the Portal did not answer /me");
                return None;
            }
        };
        response.json::<Value>().await.ok().filter(|me| {
            me.get("id").is_some_and(Value::is_string)
                && me.get("roles").is_some_and(Value::is_array)
        })
    }
}

/// The person as the page sees them: signed in or not, their name, and their roles in the App.
async fn me(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    let caller = Caller::of(&headers);
    let user = app.user(&caller).await;
    let roles = user
        .as_ref()
        .and_then(|user| user.get("roles").cloned())
        .unwrap_or_else(|| json!([]));
    (
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({
            "signedIn": caller.token.is_some(),
            "name": user.as_ref().and_then(|user| user.get("name").cloned()).or(caller.name.map(Value::String)),
            "roles": roles,
        })),
    )
        .into_response()
}

/// At most this many types in one summary, and rows read per type, as the `summary` function of
/// the `ui` template allows.
const MAX_TYPES: usize = 20;
const MAX_ROWS: usize = 5000;
/// The page size the endpoint is read with; NGSI-LD brokers cap `limit` at 1000.
const PAGE: usize = 1000;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SummaryRequest {
    types: Vec<String>,
    /// The endpoint the page names for a type several serve (SDK-02); this app reads one.
    endpoint: Option<String>,
}

/// An NGSI-LD short type name, the only thing a caller puts into the upstream query.
fn valid_type(kind: &str) -> bool {
    let mut chars = kind.chars();
    kind.len() <= 128
        && chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// The mean of every attribute whose values are all finite numbers, to two decimals.
pub fn averages(rows: &[Value]) -> Map<String, Value> {
    let mut sums: std::collections::BTreeMap<&str, (f64, u32, bool)> = Default::default();
    for row in rows.iter().filter_map(Value::as_object) {
        for (attr, value) in row {
            if attr == "id" || attr == "type" || value.is_null() {
                continue;
            }
            let entry = sums.entry(attr).or_insert((0.0, 0, true));
            match value.as_f64().filter(|number| number.is_finite()) {
                Some(number) => {
                    entry.0 += number;
                    entry.1 += 1;
                }
                None => entry.2 = false,
            }
        }
    }
    sums.into_iter()
        .filter(|(_, (_, count, numeric))| *numeric && *count > 0)
        .map(|(attr, (total, count, _))| {
            let mean = (total / f64::from(count) * 100.0).round() / 100.0;
            (attr.to_owned(), json!(mean))
        })
        .collect()
}

/// The `summary` the interface's overview asks for (`useFunction("summary")`, SDK-21), done by
/// this backend instead of the function runtime: counts and averages per type, read through the
/// endpoint with the person's token, page by page. The example to copy for the app's own work.
/// The gateway's refusal (401, 403, 404, 429) comes back as it was sent.
async fn summary(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    body: Result<Json<SummaryRequest>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Value>, AppError> {
    let refused = |detail: &str| AppError::Refused(StatusCode::BAD_REQUEST, detail.to_owned());
    let Json(request) =
        body.map_err(|_| refused("send {\"types\": [\"<EntityType>\", …]} as JSON"))?;
    if request.types.is_empty()
        || request.types.len() > MAX_TYPES
        || !request.types.iter().all(|kind| valid_type(kind))
    {
        return Err(refused(&format!(
            "types must be 1 to {MAX_TYPES} entity type names"
        )));
    }
    if let Some(endpoint) = &request.endpoint {
        if app
            .config
            .app_config
            .get("endpointName")
            .and_then(Value::as_str)
            != Some(endpoint.as_str())
        {
            return Err(refused("this app reads one endpoint; name it or none"));
        }
    }
    let caller = Caller::of(&headers);
    let mut types = Vec::with_capacity(request.types.len());
    for kind in request.types {
        let mut rows: Vec<Value> = Vec::new();
        while rows.len() < MAX_ROWS {
            let page = app
                .read(
                    "ngsi-ld/v1/entities",
                    &[
                        ("type", kind.clone()),
                        ("limit", PAGE.min(MAX_ROWS - rows.len()).to_string()),
                        ("offset", rows.len().to_string()),
                        ("options", "keyValues".to_owned()),
                    ],
                    &caller,
                )
                .await?;
            let page = match page {
                Value::Array(page) => page,
                _ => return Err(AppError::Unreachable),
            };
            let full = page.len() == PAGE;
            rows.extend(page);
            if !full {
                break;
            }
        }
        types.push(json!({ "type": kind, "count": rows.len(), "averages": averages(&rows) }));
    }
    tracing::info!(types = types.len(), "summary");
    Ok(Json(json!({ "types": types })))
}

/// `value` as the text of a `<script type="application/json">`: nothing in it can close the
/// element or start markup, whatever a name or a title holds.
pub fn script_json(value: &Value) -> String {
    value
        .to_string()
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('&', "\\u0026")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

/// The page with its `#jc-config` first in the head, so it is the one `getElementById` finds; the
/// empty element the template's `index.html` carries goes (SDK-06).
pub fn with_config(html: &str, config: &Value) -> String {
    let element = format!(
        "<script id=\"jc-config\" type=\"application/json\">{}</script>",
        script_json(config)
    );
    let html = html.replacen(
        "<script id=\"jc-config\" type=\"application/json\"></script>",
        "",
        1,
    );
    let lower = html.to_ascii_lowercase();
    let at = lower
        .find("<head>")
        .map(|at| at + "<head>".len())
        .or_else(|| lower.find("</head>"))
        .unwrap_or(0);
    format!("{}{element}{}", &html[..at], &html[at..])
}
