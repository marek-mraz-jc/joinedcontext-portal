//! A person's roles in one application, and the page that refuses them (ADR-N-027, AP-92,
//! AP-93, AP-95).
//!
//! Roles are computed on every request from the identity the Portal verified on the edge's
//! `X-Access-Token` against `spec.access` of the published manifest. Nothing else is believed: no
//! token claim of the app's own, no cookie, no query, nothing in the bundle (AP-92).

use std::collections::BTreeMap;

use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use jc_core::kinds::{AppSpec, AppVisibility};

use crate::auth::session::Identity;

/// The locales the refusal page speaks, the Portal's own (UI-12); the first is the fallback.
const LOCALES: [&str; 4] = ["en", "sk", "cs", "de"];

/// The roles `identity` holds in the app, in the order `spec.roles` declares them.
///
/// A `user` subject matches the token's `preferred_username` ignoring case, a `group` subject a
/// name of the `groups` claim, exactly as the gateway matches the Endpoint roles the reconciler
/// renders from the same list (AP-97), so the page shows an edit control to the people whose
/// write the gateway admits and to nobody else.
pub fn roles_of(spec: &AppSpec, identity: &Identity) -> Vec<String> {
    spec.roles
        .iter()
        .filter(|role| {
            spec.access
                .iter()
                .filter(|access| access.role == role.name)
                .flat_map(|access| &access.subjects)
                .any(|subject| match (&subject.user, &subject.group) {
                    (Some(user), None) => identity.username.eq_ignore_ascii_case(user),
                    (None, Some(group)) => identity
                        .groups
                        .iter()
                        .any(|held| held.trim_start_matches('/') == group),
                    _ => false,
                })
        })
        .map(|role| role.name.clone())
        .collect()
}

/// `#jc-config.user` and a function's `request.user`: `{id, name, email, roles}` for a person,
/// `null` for an anonymous visitor, never a token (AP-95, SDK-35, SDK-37).
pub fn app_user(spec: &AppSpec, identity: Option<&Identity>) -> serde_json::Value {
    identity.map_or(serde_json::Value::Null, |identity| {
        serde_json::json!({
            "id": identity.subject,
            "name": identity.name.clone().unwrap_or_else(|| identity.username.clone()),
            "email": identity.email,
            "roles": roles_of(spec, identity),
        })
    })
}

/// Whether the person may open the app at all. `visibility: roles` needs a signed-in person
/// holding one of its roles (AP-93); the other visibilities keep their meaning, beyond "is there
/// a session" the endpoint's authorization decides (AP-18).
pub fn may_open(spec: &AppSpec, identity: Option<&Identity>) -> bool {
    match spec.visibility {
        AppVisibility::Public => true,
        AppVisibility::Roles => {
            identity.is_some_and(|identity| !roles_of(spec, identity).is_empty())
        }
        _ => identity.is_some(),
    }
}

/// The `403` a person without a role of a `visibility: roles` app gets (AP-93): the app's title,
/// its roles with their titles, and who grants them, in the person's language. It names no
/// member, so nobody learns who holds a role by being refused.
pub fn refusal(
    spec: &AppSpec,
    name: &str,
    title: Option<&jc_core::i18n::Text>,
    project: &str,
    headers: &HeaderMap,
) -> Response {
    let locale = locale(headers);
    let pick = |map: &BTreeMap<String, String>, fallback: &str| {
        map.get(locale)
            .or_else(|| map.get(LOCALES[0]))
            .or_else(|| map.values().next())
            .cloned()
            .unwrap_or_else(|| fallback.to_owned())
    };
    let app = escape(title.map_or(name, |title| title.resolve(&[locale.to_owned()], name)));
    let roles: String = spec
        .roles
        .iter()
        .map(|role| format!("<li>{}</li>", escape(&pick(&role.title, &role.name))))
        .collect();
    let (heading, ask) = sentences(locale);
    let page = format!(
        "<!doctype html><html lang=\"{locale}\"><head><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
         <title>{app}</title></head><body><main><h1>{app}</h1><p>{heading}</p><ul>{roles}</ul>\
         <p>{}</p></main></body></html>",
        ask.replace("{project}", &escape(project)),
    );
    let mut response = (StatusCode::FORBIDDEN, page).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; frame-ancestors 'none'"),
    );
    response
}

/// The two sentences of the refusal page per locale.
fn sentences(locale: &str) -> (&'static str, &'static str) {
    match locale {
        "sk" => (
            "Túto aplikáciu môže otvoriť iba osoba s jednou z týchto rolí:",
            "Požiadajte správcu projektu {project}, aby vás pridal do jednej z týchto rolí.",
        ),
        "cs" => (
            "Tuto aplikaci může otevřít jen osoba s jednou z těchto rolí:",
            "Požádejte správce projektu {project}, aby vás přidal do jedné z těchto rolí.",
        ),
        "de" => (
            "Diese Anwendung öffnet nur, wer eine dieser Rollen hat:",
            "Bitten Sie eine verantwortliche Person des Projekts {project}, Sie einer dieser Rollen hinzuzufügen.",
        ),
        _ => (
            "Only a person holding one of these roles can open this application:",
            "Ask a steward of the project {project} to add you to one of these roles.",
        ),
    }
}

/// The first locale of `Accept-Language` the page speaks, by primary subtag; English otherwise.
/// Quality values are read in the order written, which is the order every browser sends.
fn locale(headers: &HeaderMap) -> &'static str {
    headers
        .get(header::ACCEPT_LANGUAGE)
        .and_then(|v| v.to_str().ok())
        .into_iter()
        .flat_map(|v| v.split(','))
        .filter_map(|tag| tag.split(';').next()?.trim().split('-').next())
        .find_map(|primary| {
            LOCALES
                .iter()
                .find(|l| l.eq_ignore_ascii_case(primary))
                .copied()
        })
        .unwrap_or(LOCALES[0])
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> AppSpec {
        serde_json::from_value(serde_json::json!({
            "kind": "static",
            "source": { "path": "." },
            "build": { "node": "22" },
            "visibility": "roles",
            "lifecycle": "published",
            "roles": [
                { "name": "viewer", "title": { "en": "Viewer", "sk": "Čitateľ" } },
                { "name": "steward", "title": { "en": "Steward <b>" } }
            ],
            "access": [
                { "role": "viewer", "subjects": [{ "group": "helsinki-operations" }] },
                { "role": "steward", "subjects": [{ "user": "Jana.Kovacova@hel.fi" }] }
            ],
            "dataNeeds": []
        }))
        .expect("an app with roles")
    }

    fn person(username: &str, groups: &[&str]) -> Identity {
        Identity {
            subject: "5f0c".into(),
            username: username.into(),
            email: Some(username.into()),
            name: None,
            roles: vec!["platform-admin".into()],
            groups: groups.iter().map(|g| (*g).to_owned()).collect(),
        }
    }

    /// AP-92: a user subject matches the e-mail whatever its case, a group with or without the
    /// leading slash the mapper may emit, in the order the roles are declared.
    #[test]
    fn a_person_holds_the_roles_their_e_mail_and_groups_match() {
        let spec = spec();
        let both = person("jana.kovacova@hel.fi", &["/helsinki-operations"]);
        assert_eq!(roles_of(&spec, &both), ["viewer", "steward"]);
        assert_eq!(
            roles_of(&spec, &person("x@hel.fi", &["helsinki-operations"])),
            ["viewer"]
        );
        assert!(roles_of(&spec, &person("x@hel.fi", &["helsinki-operations-2"])).is_empty());
        assert!(roles_of(&spec, &person("jana.kovacova@hel.fi.evil", &[])).is_empty());
    }

    /// AP-95, SDK-35: the application learns its own roles, never the platform's, and no token.
    #[test]
    fn the_served_user_carries_the_app_roles_and_null_for_nobody() {
        let spec = spec();
        let user = app_user(&spec, Some(&person("x@hel.fi", &["helsinki-operations"])));
        assert_eq!(
            user,
            serde_json::json!({ "id": "5f0c", "name": "x@hel.fi", "email": "x@hel.fi", "roles": ["viewer"] })
        );
        let none = app_user(&spec, Some(&person("y@hel.fi", &[])));
        assert_eq!(none["roles"], serde_json::json!([]));
        assert_eq!(app_user(&spec, None), serde_json::Value::Null);
    }

    /// AP-93: `roles` needs a role, `public` nobody, every other visibility a session.
    #[test]
    fn who_may_open_follows_the_visibility() {
        let mut spec = spec();
        assert!(!may_open(&spec, None));
        assert!(!may_open(&spec, Some(&person("y@hel.fi", &[]))));
        assert!(may_open(
            &spec,
            Some(&person("y@hel.fi", &["helsinki-operations"]))
        ));
        spec.visibility = AppVisibility::Organization;
        assert!(!may_open(&spec, None));
        assert!(may_open(&spec, Some(&person("y@hel.fi", &[]))));
        spec.visibility = AppVisibility::Public;
        assert!(may_open(&spec, None));
    }

    /// AP-93: the refusal names the app and its roles in the person's language, escapes what the
    /// manifest wrote, is never cached and names no member.
    #[test]
    fn the_refusal_page_names_the_roles_and_no_member() {
        let spec = spec();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ACCEPT_LANGUAGE,
            HeaderValue::from_static("sk-SK,sk;q=0.9,en;q=0.8"),
        );
        let title = jc_core::i18n::Text::from("Alerts");
        let response = refusal(&spec, "alerts", Some(&title), "helsinki", &headers);
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "private, no-store"
        );
        let body = futures_util::FutureExt::now_or_never(axum::body::to_bytes(
            response.into_body(),
            usize::MAX,
        ))
        .expect("a ready body")
        .expect("the page");
        let page = String::from_utf8(body.to_vec()).expect("utf-8");
        assert!(page.contains("<h1>Alerts</h1>"), "{page}");
        assert!(page.contains("<li>Čitateľ</li>"), "{page}");
        assert!(page.contains("<li>Steward &lt;b&gt;</li>"), "{page}");
        assert!(page.contains("správcu projektu helsinki"), "{page}");
        assert!(
            !page.to_lowercase().contains("jana"),
            "no member is named: {page}"
        );
        assert!(
            !page.contains("helsinki-operations"),
            "no group is named: {page}"
        );
    }

    #[test]
    fn the_locale_falls_back_to_english() {
        let mut headers = HeaderMap::new();
        assert_eq!(locale(&headers), "en");
        headers.insert(
            header::ACCEPT_LANGUAGE,
            HeaderValue::from_static("fi-FI, de;q=0.5"),
        );
        assert_eq!(locale(&headers), "de");
    }
}
