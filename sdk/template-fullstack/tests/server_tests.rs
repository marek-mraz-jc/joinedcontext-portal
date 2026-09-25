//! The backend against a stand-in endpoint and Portal: what the page is given, what the endpoint
//! is asked with, and what a person sees when something refuses.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use jc_app::{router, script_json, with_config, App, Config};
use serde_json::{json, Value};
use tower::ServiceExt;
use wiremock::matchers::{header, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

const TOKEN: &str = "a-person-token";
const APP_CONFIG: &str = r#"{"slug":"s1","orgDomain":"example.org","space":"air","transport":"origin","appName":"air-app","endpointName":"app-air-app","user":{"id":"stale"}}"#;

fn config(server: &MockServer, anonymous: bool) -> Config {
    let vars = [
        (
            "JC_ENDPOINT_URL",
            format!("{}/api/endpoint/s1", server.uri()),
        ),
        ("JC_ME_URL", format!("{}/me", server.uri())),
        ("JC_BASE_PATH", "/apps/air-app/".to_owned()),
        ("JC_APP_CONFIG", APP_CONFIG.to_owned()),
        ("JC_ANONYMOUS", anonymous.to_string()),
    ];
    Config::from_vars(|name| {
        vars.iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| value.clone())
    })
    .expect("the configuration reads")
}

async fn get(
    config: Config,
    uri: &str,
    token: Option<&str>,
) -> (StatusCode, Vec<(String, String)>, String) {
    let mut request = Request::get(uri);
    if let Some(token) = token {
        request = request.header("x-access-token", token);
    }
    let response = router(Arc::new(App::new(config)))
        .oneshot(request.body(Body::empty()).expect("a request"))
        .await
        .expect("an answer");
    let status = response.status();
    let headers = response
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.to_string(),
                value.to_str().unwrap_or_default().to_owned(),
            )
        })
        .collect();
    let body = response
        .into_body()
        .collect()
        .await
        .expect("a body")
        .to_bytes();
    (status, headers, String::from_utf8_lossy(&body).into_owned())
}

fn page_config(html: &str) -> Value {
    let start = html
        .find("<script id=\"jc-config\" type=\"application/json\">")
        .expect("#jc-config")
        + 47;
    let end = start + html[start..].find("</script>").expect("its end");
    serde_json::from_str(&html[start..end]).expect("JSON")
}

#[tokio::test]
async fn the_probe_is_answered_at_the_root() {
    let server = MockServer::start().await;
    let (status, _, body) = get(config(&server, false), "/healthz", None).await;
    assert_eq!((status, body.as_str()), (StatusCode::OK, "ok"));
}

#[tokio::test]
async fn the_page_carries_the_app_configuration_and_the_person_from_me() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/me"))
        .and(header("authorization", format!("Bearer {TOKEN}").as_str()))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            json!({ "id": "u1", "name": "Jana", "email": null, "roles": ["steward"] }),
        ))
        .expect(1)
        .mount(&server)
        .await;

    let (status, headers, html) = get(config(&server, false), "/apps/air-app/", Some(TOKEN)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        headers.contains(&("cache-control".to_owned(), "no-store".to_owned())),
        "{headers:?}"
    );
    let page = page_config(&html);
    assert_eq!(page["slug"], "s1");
    assert_eq!(page["transport"], "origin");
    assert_eq!(
        page["user"],
        json!({ "id": "u1", "name": "Jana", "email": null, "roles": ["steward"] })
    );
    assert_eq!(html.matches("id=\"jc-config\"").count(), 1, "{html}");
    assert!(!html.contains(TOKEN), "the page never carries the token");
}

#[tokio::test]
async fn without_a_token_or_a_clear_answer_the_page_has_no_person_and_never_the_environments() {
    let server = MockServer::start().await;
    let (_, _, html) = get(config(&server, false), "/apps/air-app", None).await;
    assert_eq!(
        page_config(&html)["user"],
        Value::Null,
        "JC_APP_CONFIG's own user is dropped"
    );

    Mock::given(path("/me"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "roles": "all" })))
        .mount(&server)
        .await;
    let (_, _, html) = get(
        config(&server, false),
        "/apps/air-app/index.html",
        Some(TOKEN),
    )
    .await;
    assert_eq!(
        page_config(&html)["user"],
        Value::Null,
        "an answer without id and roles is no person"
    );
}

#[tokio::test]
async fn nothing_in_the_configuration_closes_its_element() {
    let config =
        json!({ "appName": "</script><script>alert(1)</script>", "note": "a & b \u{2028}" });
    let html = with_config("<html><head><title>x</title><script id=\"jc-config\" type=\"application/json\"></script></head></html>", &config);
    assert_eq!(html.matches("<script").count(), 1, "{html}");
    assert!(!script_json(&config).contains('<'));
    assert_eq!(page_config(&html), config);
}

const SUMMARY: &str = "/apps/air-app/api/functions/summary";
const ENTITIES: &str = "/api/endpoint/s1/ngsi-ld/v1/entities";

async fn post(config: Config, uri: &str, body: &str, token: Option<&str>) -> (StatusCode, String) {
    let mut request = Request::post(uri).header("content-type", "application/json");
    if let Some(token) = token {
        request = request.header("x-access-token", token);
    }
    let response = router(Arc::new(App::new(config)))
        .oneshot(
            request
                .body(Body::from(body.to_owned()))
                .expect("a request"),
        )
        .await
        .expect("an answer");
    let status = response.status();
    let body = response
        .into_body()
        .collect()
        .await
        .expect("a body")
        .to_bytes();
    (status, String::from_utf8_lossy(&body).into_owned())
}

#[tokio::test]
async fn the_summary_counts_and_averages_each_type_read_with_the_persons_token_page_by_page() {
    let server = MockServer::start().await;
    let first: Vec<Value> = (0..1000).map(|i| json!({ "id": format!("urn:ngsi-ld:Station:o:s:{i}"), "type": "Station", "bikes": 2, "name": "x" })).collect();
    Mock::given(method("GET"))
        .and(path(ENTITIES))
        .and(query_param("type", "Station"))
        .and(query_param("offset", "0"))
        .and(query_param("limit", "1000"))
        .and(query_param("options", "keyValues"))
        .and(header("authorization", format!("Bearer {TOKEN}").as_str()))
        .respond_with(ResponseTemplate::new(200).set_body_json(first))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(path(ENTITIES))
        .and(query_param("type", "Station"))
        .and(query_param("offset", "1000"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([{ "id": "urn:ngsi-ld:Station:o:s:x", "type": "Station", "bikes": 5, "free": null }])))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(path(ENTITIES))
        .and(query_param("type", "Note"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([])))
        .mount(&server)
        .await;

    let (status, body) = post(
        config(&server, false),
        SUMMARY,
        r#"{"types":["Station","Note"]}"#,
        Some(TOKEN),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        serde_json::from_str::<Value>(&body).expect("JSON"),
        json!({ "types": [
            { "type": "Station", "count": 1001, "averages": { "bikes": 2.0 } },
            { "type": "Note", "count": 0, "averages": {} },
        ]})
    );
}

#[test]
fn only_attributes_that_are_all_numbers_are_averaged() {
    let rows = [
        json!({ "id": "a", "type": "T", "n": 1, "mixed": 1, "text": "x", "none": null }),
        json!({ "id": "b", "type": "T", "n": 2.333, "mixed": "two" }),
        json!("not a row"),
    ];
    assert_eq!(
        jc_app::averages(&rows),
        json!({ "n": 1.67 }).as_object().expect("an object").clone()
    );
    assert!(jc_app::averages(&[]).is_empty());
}

#[tokio::test]
async fn the_gateways_refusal_reaches_the_page_as_it_was_sent() {
    let server = MockServer::start().await;
    let refusal = r#"{"type":"about:blank","title":"Forbidden","status":403,"detail":"the policy grants no queryEntity on Secret"}"#;
    Mock::given(path(ENTITIES))
        .respond_with(ResponseTemplate::new(403).set_body_string(refusal))
        .mount(&server)
        .await;
    let (status, body) = post(
        config(&server, false),
        SUMMARY,
        r#"{"types":["Secret"]}"#,
        Some(TOKEN),
    )
    .await;
    assert_eq!((status, body.as_str()), (StatusCode::FORBIDDEN, refusal));
}

#[tokio::test]
async fn a_bad_request_is_refused_before_the_endpoint_is_asked() {
    let server = MockServer::start().await;
    Mock::given(path(ENTITIES))
        .respond_with(ResponseTemplate::new(200))
        .expect(0)
        .mount(&server)
        .await;
    let many = format!(r#"{{"types":[{}]}}"#, vec!["\"T\""; 21].join(","));
    for body in [
        "",
        "not json",
        "[]",
        r#"{"types":[]}"#,
        r#"{"types":"Station"}"#,
        r#"{"types":["A&q=x"]}"#,
        r#"{"types":["1st"]}"#,
        r#"{"types":["_x"]}"#,
        r#"{"types":["A"],"limit":5}"#,
        r#"{"types":["A"],"endpoint":"another"}"#,
        many.as_str(),
    ] {
        let (status, answer) = post(config(&server, false), SUMMARY, body, Some(TOKEN)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}: {answer}");
        assert_eq!(
            serde_json::from_str::<Value>(&answer).expect("a problem")["status"],
            400,
            "{body}"
        );
    }
}

#[tokio::test]
async fn the_endpoint_the_page_names_is_this_apps_one() {
    let server = MockServer::start().await;
    Mock::given(path(ENTITIES))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([])))
        .mount(&server)
        .await;
    let (status, body) = post(
        config(&server, false),
        SUMMARY,
        r#"{"types":["A"],"endpoint":"app-air-app"}"#,
        Some(TOKEN),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[tokio::test]
async fn without_a_token_only_a_public_app_reads_and_then_anonymously() {
    let server = MockServer::start().await;
    Mock::given(path(ENTITIES))
        .respond_with(|request: &wiremock::Request| {
            assert!(
                !request.headers.contains_key("authorization"),
                "anonymous means no bearer"
            );
            ResponseTemplate::new(200).set_body_json(json!([]))
        })
        .expect(1)
        .mount(&server)
        .await;
    let (status, body) = post(config(&server, false), SUMMARY, r#"{"types":["A"]}"#, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    let (status, _) = post(config(&server, true), SUMMARY, r#"{"types":["A"]}"#, None).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn an_endpoint_that_does_not_answer_is_a_bad_gateway_the_page_can_show() {
    let server = MockServer::start().await;
    let mut unreachable = config(&server, false);
    unreachable.endpoint_url = "http://127.0.0.1:9/api/endpoint/s1/".to_owned();
    let (status, body) = post(unreachable, SUMMARY, r#"{"types":["A"]}"#, Some(TOKEN)).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "{body}");
    assert!(!body.contains(TOKEN));
}

#[tokio::test]
async fn me_names_the_person_and_their_roles_or_none() {
    let server = MockServer::start().await;
    Mock::given(path("/me"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({ "id": "u1", "name": "Jana", "roles": ["viewer"] })),
        )
        .mount(&server)
        .await;
    let (_, _, body) = get(config(&server, false), "/apps/air-app/api/me", Some(TOKEN)).await;
    assert_eq!(
        serde_json::from_str::<Value>(&body).expect("JSON"),
        json!({ "signedIn": true, "name": "Jana", "roles": ["viewer"] })
    );
    let (_, _, body) = get(config(&server, false), "/apps/air-app/api/me", None).await;
    assert_eq!(
        serde_json::from_str::<Value>(&body).expect("JSON"),
        json!({ "signedIn": false, "name": null, "roles": [] })
    );
}

#[test]
fn the_configuration_names_what_is_missing() {
    let only = |pairs: &'static [(&'static str, &'static str)]| {
        move |name: &str| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_owned())
        }
    };
    let err = |pairs| Config::from_vars(only(pairs)).expect_err("refused");
    assert_eq!(err(&[]), "JC_ENDPOINT_URL is not set");
    assert_eq!(
        err(&[("JC_ENDPOINT_URL", "file:///etc")]),
        "JC_ENDPOINT_URL is not an http(s) URL"
    );
    assert!(err(&[("JC_ENDPOINT_URL", "https://h/api/endpoint/s/")])
        .starts_with("JC_APP_CONFIG is not set"));
    assert_eq!(
        err(&[("JC_ENDPOINT_URL", "https://h/"), ("JC_APP_CONFIG", "[1]")]),
        "JC_APP_CONFIG is not a JSON object"
    );
    assert!(
        err(&[("JC_ENDPOINT_URL", "https://h/"), ("JC_APP_CONFIG", "{")])
            .starts_with("JC_APP_CONFIG is not JSON")
    );

    let config = Config::from_vars(only(&[
        ("JC_ENDPOINT_URL", "https://h/api/endpoint/s"),
        ("JC_APP_CONFIG", "{}"),
        ("JC_BASE_PATH", "apps/x"),
    ]))
    .expect("read");
    assert_eq!(
        (config.endpoint_url.as_str(), config.base_path.as_str()),
        ("https://h/api/endpoint/s/", "/apps/x/")
    );
    assert!(!config.anonymous && config.me_url.is_none());
    let root = Config::from_vars(only(&[
        ("JC_ENDPOINT_URL", "https://h/"),
        ("JC_APP_CONFIG", "{}"),
        ("JC_BASE_PATH", "/"),
    ]))
    .expect("read");
    assert_eq!(root.base_path, "/");
}

#[tokio::test]
async fn an_app_served_at_the_root_answers_its_page_and_its_probe() {
    let config = Config::from_vars(|name| match name {
        "JC_ENDPOINT_URL" => Some("https://h/api/endpoint/s/".to_owned()),
        "JC_APP_CONFIG" => Some("{}".to_owned()),
        _ => None,
    })
    .expect("read");
    let (status, _, html) = get(config.clone(), "/", None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains("id=\"jc-config\""), "{html}");
    assert_eq!(get(config.clone(), "/healthz", None).await.2, "ok");
    assert_eq!(
        get(config, "/missing.js", None).await.0,
        StatusCode::NOT_FOUND
    );
}
