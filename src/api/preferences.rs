//! `GET`/`PUT /api/v1/preferences`: how the signed-in person likes the UI (UI-09, UI-10).
//!
//! Scoped by the session's Keycloak `sub` (CC-40) and nothing else: there is no path parameter,
//! so no caller can name another person's row.

use axum::body::Bytes;
use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use utoipa::ToSchema;

use crate::auth::CurrentUser;
use crate::db;
use crate::error::{ApiError, ProblemDetails};
use crate::resource::is_dns1123;
use crate::state::AppState;

/// The browser's saved dashboard state, per dashboard name. Opaque to the Portal, so it is capped
/// rather than understood: a saved layout is small, anything bigger is not a layout.
const MAX_LAYOUTS_BYTES: usize = 64 * 1024;
/// The pages a person opened last, newest first (UI-90).
const MAX_RECENT: usize = 10;
/// The pages a person starred (UI-90).
const MAX_FAVOURITES: usize = 50;
/// A person's own MCP connectors (UI-98, ADR-N-043 §7).
const MAX_CONNECTORS: usize = 10;
/// Values per selector field, and favourite Endpoints per connector (MF-55, UI-98).
const MAX_SELECT_VALUES: usize = 50;
/// The access levels of the per-caller catalogue a selector may name (MF-55, T-4503).
const ACCESS_LEVELS: [&str; 4] = ["public", "organization", "project", "grant"];

/// A page of the Portal a person went to or starred: where it is and what it was called.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct Place {
    /// A path inside the Portal, with its query: `/projects/helsinki/pipelines/air?tab=runs`.
    pub path: String,
    /// The page's title when it was opened, 1 to 200 characters.
    pub title: String,
}

impl Place {
    fn validate(&self) -> Result<(), String> {
        let path = &self.path;
        // Only an address of this Portal: never another origin (`//host`, `https:`), never a
        // script, never a control character a link could smuggle.
        if !path.starts_with('/')
            || path.starts_with("//")
            || path.contains('\\')
            || path.len() > 512
            || path.chars().any(char::is_control)
        {
            return Err(format!("place path '{path}' is not a path of this Portal"));
        }
        let title_len = self.title.chars().count();
        if title_len == 0 || title_len > 200 || self.title.chars().any(char::is_control) {
            return Err("a place's title is 1 to 200 characters of text".into());
        }
        Ok(())
    }
}

/// What a personal connector reaches: the McpServer selector fields (MF-55) and the person's
/// favourite Endpoints. An Endpoint is selected when it matches every field given; the gateway
/// only ever narrows the caller's own reach with it (ADR-N-043 §7.2).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ConnectorSelect {
    /// Project names.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub projects: Vec<String>,
    /// `{project}/{space}`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub spaces: Vec<String>,
    /// Smart Data Models domains of the Endpoint's classification.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub domains: Vec<String>,
    /// EU data-theme codes (`ENVI`, `TRAN`, …).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub themes: Vec<String>,
    /// `public`, `organization`, `project` or `grant`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub access_level: Vec<String>,
    /// Favourite Endpoints by slug, each one the person could read when it was starred.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub endpoints: Vec<String>,
}

/// One personal MCP connector, served at `/api/mcp/me/{name}` to its owner alone (UI-98, EP-123).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct Connector {
    /// A DNS label, unique among the person's connectors.
    pub name: String,
    #[serde(default)]
    pub select: ConnectorSelect,
}

impl Connector {
    fn validate(&self) -> Result<(), String> {
        let name = &self.name;
        if !is_dns1123(name) {
            return Err(format!("connector name '{name}' is not a DNS label"));
        }
        let select = &self.select;
        for (field, values) in [
            ("projects", &select.projects),
            ("spaces", &select.spaces),
            ("domains", &select.domains),
            ("themes", &select.themes),
            ("accessLevel", &select.access_level),
            ("endpoints", &select.endpoints),
        ] {
            if values.len() > MAX_SELECT_VALUES {
                return Err(format!(
                    "connector '{name}': {field} holds {} values, the limit is {MAX_SELECT_VALUES}",
                    values.len()
                ));
            }
        }
        let wrong =
            |field: &str, value: &str| format!("connector '{name}': {field} '{value}' is not one");
        if let Some(p) = select.projects.iter().find(|p| !is_dns1123(p)) {
            return Err(wrong("project", p));
        }
        if let Some(sp) = select.spaces.iter().find(|sp| {
            sp.split_once('/').is_none_or(|(p, space)| {
                !is_dns1123(p) || jc_core::names::validate_space_name(space).is_err()
            })
        }) {
            return Err(wrong("project/space", sp));
        }
        // A code the gateway's catalogue does not know selects nothing; only its shape is checked.
        if let Some(d) = select
            .domains
            .iter()
            .find(|d| d.is_empty() || d.len() > 64 || !d.chars().all(|c| c.is_ascii_alphanumeric()))
        {
            return Err(wrong("domain", d));
        }
        if let Some(t) = select.themes.iter().find(|t| {
            t.is_empty() || t.len() > 16 || !t.chars().all(|c| c.is_ascii_uppercase() || c == '_')
        }) {
            return Err(wrong("theme", t));
        }
        if let Some(a) = select
            .access_level
            .iter()
            .find(|a| !ACCESS_LEVELS.contains(&a.as_str()))
        {
            return Err(wrong("accessLevel", a));
        }
        if let Some(e) = select.endpoints.iter().find(|e| {
            e.is_empty()
                || e.len() > 64
                || !e
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        }) {
            return Err(wrong("endpoint slug", e));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Preferences {
    /// `light`, `dark` or `system`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    /// ISO 639-1 language code.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
    /// The project the shell opens on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_project: Option<String>,
    /// Free JSON per dashboard name, the browser's own saved state.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    #[schema(value_type = Object)]
    pub dashboard_layouts: BTreeMap<String, serde_json::Value>,
    /// Whether manifest forms show the fields a `UiSchema` marks `advanced` (CC-29, UI-02).
    ///
    /// Absent means off, so a person who has never chosen gets the view CC-29 asks for. It is a
    /// display preference: it changes what a form shows, never what a write may do.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub advanced_mode: Option<bool>,
    /// Whether the person put the first-run checklist away (T-3233). Absent shows it; the help
    /// menu clears it. The steps tick themselves from the project, never from this record.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_run_dismissed: Option<bool>,
    /// The last pages the person opened, newest first, at most 10 (UI-90).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub recent: Vec<Place>,
    /// The pages the person starred, at most 50 (UI-90).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub favourites: Vec<Place>,
    /// The person's own MCP connectors, at most 10 (UI-98).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub connectors: Vec<Connector>,
}

impl Preferences {
    /// The few fields the Portal understands are checked; the rest is only bounded.
    pub fn validate(&self) -> Result<(), String> {
        if let Some(theme) = &self.theme {
            if !matches!(theme.as_str(), "light" | "dark" | "system") {
                return Err(format!("theme '{theme}' is not light, dark or system"));
            }
        }
        if let Some(locale) = &self.locale {
            jc_core::names::validate_locale(locale).map_err(|e| e.to_string())?;
        }
        if let Some(project) = &self.default_project {
            if !is_dns1123(project) {
                return Err(format!("defaultProject '{project}' is not a DNS-1123 name"));
            }
        }
        for name in self.dashboard_layouts.keys() {
            if !is_dns1123(name) {
                return Err(format!(
                    "dashboardLayouts key '{name}' is not a dashboard name"
                ));
            }
        }
        if self.recent.len() > MAX_RECENT {
            return Err(format!(
                "recent holds {} places, the limit is {MAX_RECENT}",
                self.recent.len()
            ));
        }
        if self.favourites.len() > MAX_FAVOURITES {
            return Err(format!(
                "favourites holds {} places, the limit is {MAX_FAVOURITES}",
                self.favourites.len()
            ));
        }
        for place in self.recent.iter().chain(&self.favourites) {
            place.validate()?;
        }
        if self.connectors.len() > MAX_CONNECTORS {
            return Err(format!(
                "connectors holds {}, the limit is {MAX_CONNECTORS}",
                self.connectors.len()
            ));
        }
        for (i, connector) in self.connectors.iter().enumerate() {
            connector.validate()?;
            if self.connectors[..i]
                .iter()
                .any(|c| c.name == connector.name)
            {
                return Err(format!("connector name '{}' is used twice", connector.name));
            }
        }
        let layouts_len = serde_json::to_vec(&self.dashboard_layouts)
            .map(|bytes| bytes.len())
            .unwrap_or(usize::MAX);
        if layouts_len > MAX_LAYOUTS_BYTES {
            return Err(format!(
                "dashboardLayouts is {layouts_len} bytes, the limit is {MAX_LAYOUTS_BYTES}"
            ));
        }
        Ok(())
    }
}

fn pool(state: &AppState) -> Result<&sqlx::PgPool, ApiError> {
    state
        .db
        .as_ref()
        .ok_or_else(|| ApiError::Unavailable("no preferences database is configured".into()))
}

fn db_error(err: sqlx::Error) -> ApiError {
    // The DSN, the SQL and the driver's wording stay in the log (TS-09).
    tracing::error!(error = %err, "preferences database call failed");
    ApiError::Internal("the preferences database did not answer".into())
}

#[utoipa::path(
    get,
    path = "/api/v1/preferences",
    summary = "Read Preferences",
    description = "The caller's own Portal preferences, empty before the first save. Nobody reads another person's.",
    tag = "preferences",
    responses(
        (status = 200, description = "The caller's preferences, empty before the first save", body = Preferences),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 503, description = "No preferences database configured", body = ProblemDetails)
    )
)]
pub async fn get_preferences(
    user: CurrentUser,
    State(state): State<AppState>,
) -> Result<Json<Preferences>, ApiError> {
    let stored = db::load_preferences(pool(&state)?, &user.0.identity.subject)
        .await
        .map_err(db_error)?;
    // A row written by an older Portal may hold a field this one no longer knows; it is dropped
    // rather than turned into a 500 on the caller's own settings.
    let preferences = stored
        .and_then(|value| serde_json::from_value::<Preferences>(value).ok())
        .unwrap_or_default();
    Ok(Json(preferences))
}

#[utoipa::path(
    put,
    path = "/api/v1/preferences",
    summary = "Save Preferences",
    description = "Stores the caller's own Portal preferences and answers what is now saved. A field the Portal understands is validated; the rest is kept as sent.",
    tag = "preferences",
    request_body(
        content = Preferences,
        example = json!({ "locale": "sk", "theme": "dark", "advancedMode": false, "defaultProject": "helsinki" })
    ),
    responses(
        (status = 200, description = "Stored; the body is what is now saved", body = Preferences),
        (status = 400, description = "A field the Portal understands is invalid", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Missing or mismatched CSRF token", body = ProblemDetails),
        (status = 503, description = "No preferences database configured", body = ProblemDetails)
    )
)]
pub async fn put_preferences(
    user: CurrentUser,
    State(state): State<AppState>,
    body: Bytes,
) -> Result<Json<Preferences>, ApiError> {
    // Parsed by hand, as every write handler here is: axum's `Json` extractor answers a bad body
    // with a plain-text 422, and the contract says problem+json 400 (API/01 sections 2 and 8).
    let preferences: Preferences = serde_json::from_slice(&body)
        .map_err(|e| ApiError::BadRequest(format!("preferences body is invalid: {e}")))?;
    preferences.validate().map_err(ApiError::BadRequest)?;
    let pool = pool(&state)?;
    let subject = &user.0.identity.subject;
    // A favourite is checked when it is starred: one starred earlier and no longer readable stays
    // stored (the gateway leaves it out of the reach, EP-123), so a later save of a theme still
    // goes through.
    let starred: Vec<&String> = preferences
        .connectors
        .iter()
        .flat_map(|c| &c.select.endpoints)
        .collect();
    if !starred.is_empty() {
        let stored = db::load_preferences(pool, subject)
            .await
            .map_err(db_error)?
            .and_then(|value| serde_json::from_value::<Preferences>(value).ok())
            .unwrap_or_default();
        let kept: Vec<&String> = stored
            .connectors
            .iter()
            .flat_map(|c| &c.select.endpoints)
            .collect();
        if let Some(slug) = starred
            .into_iter()
            .find(|slug| !kept.contains(slug) && !readable_endpoint(&state, &user, slug))
        {
            return Err(ApiError::BadRequest(format!(
                "endpoint '{slug}' is not one you may read"
            )));
        }
    }
    let value = serde_json::to_value(&preferences)
        .map_err(|e| ApiError::Internal(format!("preferences did not serialize: {e}")))?;
    db::save_preferences(pool, subject, &value)
        .await
        .map_err(db_error)?;
    Ok(Json(preferences))
}

/// Whether the caller may read the Endpoint with this slug: a public one, or one whose manifest
/// their grants in its project read (PF-59). An unknown slug reads like an unreadable one, so
/// the answer never says which Endpoints exist.
fn readable_endpoint(state: &AppState, user: &CurrentUser, slug: &str) -> bool {
    let Some(endpoint) = state.mirror.find(|env| {
        env.kind == "Endpoint"
            && env.spec.get("slug").and_then(serde_json::Value::as_str) == Some(slug)
    }) else {
        return false;
    };
    if endpoint
        .spec
        .get("audience")
        .and_then(serde_json::Value::as_str)
        == Some("public")
    {
        return true;
    }
    let Some(project) = endpoint.metadata.namespace.as_deref() else {
        return false;
    };
    let manifest = serde_json::to_value(&endpoint).unwrap_or(serde_json::Value::Null);
    crate::permissions::for_request(state, &user.0.identity, project)
        .may_read_manifest("Endpoint", &manifest)
}

/// The pages a person opened since the last report, newest first (UI-90).
#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RecentPlaces {
    /// 1 to 10 places, newest first.
    pub places: Vec<Place>,
}

/// Puts `opened` (newest first) before `stored`, each path once, the newest ten.
fn merged_recent(opened: Vec<Place>, stored: Vec<Place>) -> Vec<Place> {
    let mut out: Vec<Place> = Vec::with_capacity(MAX_RECENT);
    for place in opened.into_iter().chain(stored) {
        if out.len() == MAX_RECENT {
            break;
        }
        if !out.iter().any(|kept| kept.path == place.path) {
            out.push(place);
        }
    }
    out
}

#[utoipa::path(
    post,
    path = "/api/v1/preferences/recent",
    summary = "Add Recent Pages",
    description = "Puts the pages the caller opened, newest first, at the top of their recent pages, each once, the newest ten kept; every other preference stays as stored. The browser sends them when its tab is hidden, so a visit is not a write.",
    tag = "preferences",
    request_body(
        content = RecentPlaces,
        example = json!({ "places": [{ "path": "/projects/helsinki/pipelines/air-quality/edit", "title": "air-quality · helsinki" }] })
    ),
    responses(
        (status = 200, description = "Stored; the body is what is now saved", body = Preferences),
        (status = 400, description = "No place, more than ten, or a place that is not a page of this Portal", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Missing or mismatched CSRF token", body = ProblemDetails),
        (status = 503, description = "No preferences database configured", body = ProblemDetails)
    )
)]
pub async fn add_recent(
    user: CurrentUser,
    State(state): State<AppState>,
    body: Bytes,
) -> Result<Json<Preferences>, ApiError> {
    let opened: RecentPlaces = serde_json::from_slice(&body)
        .map_err(|e| ApiError::BadRequest(format!("recent pages body is invalid: {e}")))?;
    if opened.places.is_empty() || opened.places.len() > MAX_RECENT {
        return Err(ApiError::BadRequest(format!(
            "send 1 to {MAX_RECENT} places, not {}",
            opened.places.len()
        )));
    }
    for place in &opened.places {
        place.validate().map_err(ApiError::BadRequest)?;
    }
    let pool = pool(&state)?;
    let subject = &user.0.identity.subject;
    let mut preferences = db::load_preferences(pool, subject)
        .await
        .map_err(db_error)?
        .and_then(|value| serde_json::from_value::<Preferences>(value).ok())
        .unwrap_or_default();
    preferences.recent = merged_recent(opened.places, std::mem::take(&mut preferences.recent));
    let value = serde_json::to_value(&preferences)
        .map_err(|e| ApiError::Internal(format!("preferences did not serialize: {e}")))?;
    db::save_preferences(pool, subject, &value)
        .await
        .map_err(db_error)?;
    Ok(Json(preferences))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/preferences", get(get_preferences).put(put_preferences))
        .route("/preferences/recent", axum::routing::post(add_recent))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prefs(json: serde_json::Value) -> Preferences {
        serde_json::from_value(json).expect("valid shape")
    }

    #[test]
    fn accepts_the_documented_example() {
        let p = prefs(serde_json::json!({
            "theme": "system",
            "locale": "sk",
            "defaultProject": "ovzdusie",
            "dashboardLayouts": { "ovzdusie-prehlad": { "collapsedLegend": true } },
            "advancedMode": true,
            "firstRunDismissed": true
        }));
        assert_eq!(p.validate(), Ok(()));
        assert_eq!(p.advanced_mode, Some(true));
        assert_eq!(p.first_run_dismissed, Some(true));
        // Absent is off, and stays absent on the way back out (CC-29).
        let unset = prefs(serde_json::json!({}));
        assert_eq!(unset.advanced_mode, None);
        assert!(serde_json::to_value(&unset)
            .expect("serializes")
            .get("advancedMode")
            .is_none());
        assert!(
            Preferences::default().validate().is_ok(),
            "nothing set is fine"
        );
    }

    #[test]
    fn recent_pages_put_the_new_first_once_each_and_keep_ten() {
        let place = |n: usize| Place {
            path: format!("/p{n}"),
            title: format!("p{n}"),
        };
        let stored: Vec<Place> = (0..10).map(place).collect();
        let merged = merged_recent(vec![place(20), place(3)], stored);
        let paths: Vec<&str> = merged.iter().map(|p| p.path.as_str()).collect();
        assert_eq!(
            paths,
            ["/p20", "/p3", "/p0", "/p1", "/p2", "/p4", "/p5", "/p6", "/p7", "/p8"]
        );
        assert!(merged_recent(Vec::new(), Vec::new()).is_empty());
    }

    #[test]
    fn keeps_recent_and_starred_pages_of_this_portal_only() {
        let place = |path: &str| serde_json::json!({ "path": path, "title": "Air quality" });
        let ok = prefs(serde_json::json!({
            "recent": [place("/projects/helsinki/pipelines/air-quality?tab=runs")],
            "favourites": [place("/catalogue")]
        }));
        assert_eq!(ok.validate(), Ok(()));
        for wrong in [
            "https://evil.example/",
            "//evil.example/x",
            "javascript:alert(1)",
            "/a\\b",
            "/a\nb",
            "",
        ] {
            let p = prefs(serde_json::json!({ "favourites": [place(wrong)] }));
            assert!(p.validate().is_err(), "{wrong:?} is refused");
        }
        let untitled = prefs(serde_json::json!({ "recent": [{ "path": "/x", "title": "" }] }));
        assert!(untitled.validate().is_err());
        let eleven = prefs(serde_json::json!({ "recent": vec![place("/x"); 11] }));
        assert!(eleven.validate().is_err(), "ten recent pages at most");
        let fifty_one = prefs(serde_json::json!({ "favourites": vec![place("/x"); 51] }));
        assert!(fifty_one.validate().is_err(), "fifty starred pages at most");
        assert!(
            prefs(serde_json::json!({ "favourites": vec![place("/x"); 50] }))
                .validate()
                .is_ok()
        );
    }

    #[test]
    fn refuses_what_it_understands_and_is_wrong() {
        assert!(prefs(serde_json::json!({ "theme": "sepia" }))
            .validate()
            .is_err());
        assert!(prefs(serde_json::json!({ "locale": "slovak" }))
            .validate()
            .is_err());
        assert!(prefs(serde_json::json!({ "defaultProject": "Ovzdusie" }))
            .validate()
            .is_err());
        assert!(
            prefs(serde_json::json!({ "dashboardLayouts": { "../x": {} } }))
                .validate()
                .is_err()
        );
    }

    #[test]
    fn unknown_fields_are_rejected_at_the_door() {
        let result = serde_json::from_value::<Preferences>(serde_json::json!({ "colour": "red" }));
        assert!(
            result.is_err(),
            "deny_unknown_fields keeps the contract honest"
        );
    }

    #[test]
    fn connectors_are_bounded_named_once_and_select_known_values() {
        let one = |name: &str| serde_json::json!({ "name": name, "select": { "accessLevel": ["public"] } });
        let ok = prefs(serde_json::json!({ "connectors": [{
            "name": "air",
            "select": { "projects": ["mesto"], "spaces": ["mesto/ovzdusie"], "domains": ["Environment"],
                        "themes": ["ENVI"], "accessLevel": ["public", "grant"], "endpoints": ["air7"] }
        }] }));
        assert_eq!(ok.validate(), Ok(()));
        let ten: Vec<_> = (0..10).map(|i| one(&format!("c{i}"))).collect();
        assert!(prefs(serde_json::json!({ "connectors": ten.clone() }))
            .validate()
            .is_ok());
        let mut eleven = ten;
        eleven.push(one("c10"));
        assert!(
            prefs(serde_json::json!({ "connectors": eleven }))
                .validate()
                .is_err(),
            "ten at most"
        );
        let slugs = |n: usize| (0..n).map(|i| format!("e{i}")).collect::<Vec<_>>();
        let fav = |n: usize| serde_json::json!({ "connectors": [{ "name": "fav", "select": { "endpoints": slugs(n) } }] });
        assert!(prefs(fav(50)).validate().is_ok());
        assert!(
            prefs(fav(51)).validate().is_err(),
            "fifty favourites at most"
        );
        assert!(
            prefs(serde_json::json!({ "connectors": [one("x"), one("x")] }))
                .validate()
                .is_err()
        );
        for wrong in [
            serde_json::json!({ "name": "Air" }),
            serde_json::json!({ "name": "a", "select": { "accessLevel": ["everyone"] } }),
            serde_json::json!({ "name": "a", "select": { "spaces": ["mesto"] } }),
            serde_json::json!({ "name": "a", "select": { "themes": ["envi"] } }),
            serde_json::json!({ "name": "a", "select": { "endpoints": ["../x"] } }),
        ] {
            let p = prefs(serde_json::json!({ "connectors": [wrong.clone()] }));
            assert!(p.validate().is_err(), "{wrong} is refused");
        }
        let unknown =
            serde_json::json!({ "connectors": [{ "name": "a", "select": { "owner": "x" } }] });
        assert!(serde_json::from_value::<Preferences>(unknown).is_err());
    }

    #[test]
    fn layouts_are_bounded() {
        let big = "x".repeat(MAX_LAYOUTS_BYTES);
        let p = prefs(serde_json::json!({ "dashboardLayouts": { "d": big } }));
        assert!(
            p.validate().is_err(),
            "a layout larger than the cap is not a layout"
        );
    }
}
