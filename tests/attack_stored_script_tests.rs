//! Attack vector T-1687 (AG-46, PF-50): stored and reflected script in anything a person types.
//!
//! The Portal's own pages are React, which renders every string as text, and the Portal's CSP has
//! no `unsafe-inline` for scripts. This file is the server's half: the one HTML document the
//! Portal *builds itself* out of strings a person (or a model writing for one) typed — the kit
//! preview of an application — and the API answers that carry those strings back.
//!
//! What the existing suites already play, so this file does not repeat it:
//! `ui/tests/browser_security.test.tsx::a_javascript_url_from_a_manifest_is_text` (a
//! `javascript:` URL in a manifest is rendered without a link, and no page hands a raw value to
//! an anchor), `::a_preview_frame_cannot_reach_the_portal_origin`,
//! `security_headers_tests::the_portal_sends_a_csp_without_unsafe_inline_scripts` and
//! `::every_answer_carries_the_headers_that_do_not_depend_on_the_route` (the policy that would
//! stop an inline script even if one got through), `kit::tests::a_page_gets_the_rows_first_and_a_closing_tag_in_the_data_ends_nothing`
//! (a `</script>` inside the *data*). What was left is the rest of the document: the title, the
//! subtitle and the view labels a person types, and the manifest fields that travel through the
//! API.

mod common;

use axum::http::{header, StatusCode};
use serde_json::{json, Value};
use tower::ServiceExt;

use joinedcontext_portal::agents::kit;
use joinedcontext_portal::auth::session::Identity;

/// Everything a person can type that ends up inside an HTML document, in one string.
const HOSTILE: &str = "</script><script>alert('jc')</script><img src=x onerror=alert(1)>";

fn admin() -> Identity {
    let mut identity = common::person("admin");
    identity.groups = vec!["portal-approver".to_owned()];
    identity
}

/// AG-46: the kit builds a page out of a specification a model wrote from a person's words. A
/// closing tag in the title ends nothing: the document has exactly the script elements its own
/// template has, and the attacker's text is inside the title element as text.
#[test]
fn a_closing_tag_in_a_title_ends_no_element_of_the_document() {
    let spec = kit::parse(
        &serde_json::to_string(&json!({
            "title": HOSTILE,
            "subtitle": HOSTILE,
            "sources": [{ "name": "air", "type": "AirQualityObserved", "attrs": ["airQualityIndex"] }],
            "views": [{ "kind": "table", "title": HOSTILE, "columns": ["airQualityIndex"] }],
        }))
        .expect("json"),
    )
    .expect("the kit accepts this specification");
    let bundle = kit::Bundle {
        js: "/* bundle */".to_owned(),
        css: "/* style */".to_owned(),
        worker: "d29ya2Vy".to_owned(),
    };
    let html = kit::document(&spec.title, "air", &spec, None, None, &bundle, None);
    assert_eq!(
        html.matches("<script").count(),
        3,
        "the document grew a script element: {html}"
    );
    assert!(
        !html.contains("</script><script>alert"),
        "the title broke out of its element: {html}"
    );
    assert!(
        html.contains("&lt;/script&gt;&lt;script&gt;alert"),
        "the title has to be there, as text: {html}"
    );
    // The title element holds text and nothing the parser reads as markup: no `<`, no `>`. The
    // same string inside the JSON payload below is a different matter — that element is
    // `application/json`, nothing in it is executed, and its `<` is escaped so it cannot end.
    let title = html
        .split_once("<title>")
        .and_then(|(_, rest)| rest.split_once("</title>"))
        .map(|(title, _)| title)
        .expect("the title element");
    assert!(
        !title.contains('<') && !title.contains('>'),
        "the title carries raw markup: {title}"
    );
}

/// AG-46: the same for the payload the page reads its specification from. `<` inside a
/// `application/json` script element would end it; it travels as `\\u003c`, which is the same
/// character to a JSON parser and nothing to the HTML one.
#[test]
fn the_payload_of_the_page_carries_no_markup_at_all() {
    let spec = kit::parse(
        &serde_json::to_string(&json!({
            "title": "Air",
            "sources": [{ "name": "air", "type": "AirQualityObserved", "attrs": ["airQualityIndex"] }],
            "views": [{ "kind": "table", "title": HOSTILE, "columns": ["airQualityIndex"] }],
        }))
        .expect("json"),
    )
    .expect("the kit accepts this specification");
    let bundle = kit::Bundle {
        js: "/* bundle */".to_owned(),
        css: "/* style */".to_owned(),
        worker: "d29ya2Vy".to_owned(),
    };
    let rows = json!([{ "id": HOSTILE, "type": "AirQualityObserved" }]);
    let html = kit::document("air", "air", &spec, Some(&rows), None, &bundle, None);
    let payload = html
        .split_once("type=\"application/json\">")
        .and_then(|(_, rest)| rest.split_once("</script>"))
        .map(|(payload, _)| payload)
        .expect("the specification element");
    assert!(
        !payload.contains('<'),
        "the payload carries a raw '<': {payload}"
    );
    assert!(
        payload.contains("\\u003c/script"),
        "the closing tag has to be there, escaped: {payload}"
    );
}

/// PF-50: a name is a DNS-1123 label, so a name shaped like markup is refused before it is
/// stored anywhere — the refusal is the shape of the name and says what a name may be.
#[tokio::test]
async fn a_name_shaped_like_markup_is_refused_before_it_is_stored() {
    let state = common::state_on(&common::forge().await);
    let answer = common::send(
        &state,
        admin(),
        "POST",
        "/api/v1/projects/ovzdusie/spaces?dryRun=All",
        Some(json!({
            "apiVersion": "joinedcontext.com/v1alpha1",
            "kind": "ContextSpace",
            "metadata": { "name": HOSTILE, "namespace": "ovzdusie" },
            "spec": { "isSandbox": true },
        })),
    )
    .await;
    assert_ne!(answer.status, StatusCode::ACCEPTED, "{}", answer.text);
    assert!(
        answer.text.to_lowercase().contains("dns")
            || answer.text.contains("name")
            || answer.text.contains("label"),
        "the refusal has to say what a name may be: {}",
        answer.text
    );
}

/// AG-46: a title and a description are free text, so markup in them is kept — and every answer
/// that carries it is `application/json` with the Portal's policy on it, so nothing renders it as
/// markup and an inline script would not run even if something did.
#[tokio::test]
async fn markup_a_person_typed_travels_as_json_under_the_policy() {
    let state = common::state_on(&common::forge().await);
    let answer = common::send(
        &state,
        admin(),
        "POST",
        "/api/v1/projects/ovzdusie/spaces?dryRun=All",
        Some(json!({
            "apiVersion": "joinedcontext.com/v1alpha1",
            "kind": "ContextSpace",
            "metadata": {
                "name": "mobility",
                "namespace": "ovzdusie",
                "title": HOSTILE,
                "description": HOSTILE,
            },
            "spec": { "isSandbox": true },
        })),
    )
    .await;
    assert_eq!(answer.status, StatusCode::OK, "{}", answer.text);
    let body: Value = serde_json::from_str(&answer.text).expect("json");
    assert_eq!(
        body["valid"],
        json!(true),
        "free text is kept, not refused: {}",
        answer.text
    );
    // The same request through the router again, so the headers of the answer can be read: the
    // policy and the content type are what keep typed markup from ever being a document.
    let response = joinedcontext_portal::server::app(state.clone())
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/api/v1/projects/ovzdusie/spaces?dryRun=All")
                .header(header::COOKIE, common::cookie(&state.config, admin()))
                .header(joinedcontext_portal::auth::csrf::CSRF_HEADER, common::CSRF)
                .header(header::CONTENT_TYPE, "application/json")
                .body(axum::body::Body::from(
                    json!({
                        "apiVersion": "joinedcontext.com/v1alpha1",
                        "kind": "ContextSpace",
                        "metadata": {
                            "name": "mobility",
                            "namespace": "ovzdusie",
                            "title": HOSTILE,
                        },
                        "spec": { "isSandbox": true },
                    })
                    .to_string(),
                ))
                .expect("a request"),
        )
        .await
        .expect("a response");
    let header_of = |name: header::HeaderName| {
        response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_owned()
    };
    assert!(
        header_of(header::CONTENT_TYPE).starts_with("application/json"),
        "an answer carrying typed markup must not be served as a document: {}",
        header_of(header::CONTENT_TYPE)
    );
    let policy = header_of(header::CONTENT_SECURITY_POLICY);
    assert!(
        policy.contains("default-src 'self'") && !policy.contains("script-src"),
        "scripts fall back to default-src 'self', which has no 'unsafe-inline': {policy}"
    );
}
