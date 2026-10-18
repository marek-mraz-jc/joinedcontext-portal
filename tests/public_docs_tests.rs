//! T-4063: the API and User Guide pages answer anyone, with no session, through the running
//! router; no other chapter does.

use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use joinedcontext_portal::config::Config;
use joinedcontext_portal::server;
use joinedcontext_portal::state::AppState;
use tower::ServiceExt;

async fn get(path: &str) -> (StatusCode, Option<String>, String) {
    let response = server::app(AppState::new(Config::for_tests(), None))
        .oneshot(
            Request::builder()
                .uri(path)
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    let status = response.status();
    let policy = response
        .headers()
        .get(header::CONTENT_SECURITY_POLICY)
        .map(|value| value.to_str().expect("ascii").to_owned());
    let body = to_bytes(response.into_body(), 4 << 20).await.expect("body");
    (status, policy, String::from_utf8_lossy(&body).into_owned())
}

#[tokio::test]
async fn the_websocket_guide_answers_without_a_session() {
    let (status, policy, body) = get("/docs/API/07-websocket").await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        body.contains("<title>Live Updates over WebSocket</title>"),
        "{body:.300}"
    );
    assert!(
        policy.is_some_and(|policy| policy.contains("default-src 'self'")),
        "the page keeps the Portal's Content-Security-Policy"
    );
    // the footer names the docs commit the deployment pins and the release it belongs to
    let docs = joinedcontext_portal::public_docs::docs_commit();
    assert_eq!(docs.len(), 40, "public-docs/COMMIT is one commit");
    let footer = format!(
        "docs {}, Portal {}</p></footer>",
        &docs[..12],
        joinedcontext_portal::public_docs::release()
    );
    assert!(body.contains(&footer), "{footer} in {body:.300}");
    assert!(
        joinedcontext_portal::public_docs::release().starts_with(joinedcontext_portal::APP_VERSION)
    );
    let (status, _, _) = get("/docs/User-Guide/01-getting-started.md").await;
    assert_eq!(
        status,
        StatusCode::OK,
        "a link written with .md opens the page too"
    );
}

#[tokio::test]
async fn no_other_chapter_and_no_path_outside_the_bundle_is_served() {
    for path in [
        "/docs/Operations/00-intro",
        "/docs/Deployment/00-intro",
        "/docs/API/..%2F..%2FCargo.toml",
        "/docs/API/no-such-page",
    ] {
        let (status, _, body) = get(path).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
        assert!(
            !body.contains("<html"),
            "{path} is not the SPA shell either"
        );
    }
}

/// The representations page as served while the platform broker reports `health` on
/// `GET /q/health` (`None`: no broker answers at all).
async fn representations(health: Option<serde_json::Value>) -> String {
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};
    let broker = MockServer::start().await;
    let mut config = Config::for_tests();
    match health {
        Some(body) => {
            Mock::given(method("GET"))
                .and(path("/q/health"))
                .respond_with(ResponseTemplate::new(200).set_body_json(body))
                .mount(&broker)
                .await;
            config.broker_url = Some(broker.uri());
        }
        None => config.broker_url = Some("http://127.0.0.1:9".to_owned()),
    }
    let response = server::app(AppState::new(config, None))
        .oneshot(
            Request::builder()
                .uri("/docs/API/02-endpoint-representations")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 4 << 20).await.expect("body");
    String::from_utf8_lossy(&body).into_owned()
}

const STA: &str = "id=\"7-ogc-sensorthings-api-sta-v11\"";
const OGC: &str = "id=\"6-ogc-api---features-part-1\"";
const NGSI_LD: &str = "id=\"2-etsi-ngsi-ld-representations\"";

/// T-4484, TS-19: a broker built without `sta` documents no SensorThings: the section is gone,
/// and so is every link to it; the surfaces it mounts keep theirs.
#[tokio::test]
async fn a_surface_the_broker_does_not_mount_has_no_section_and_no_link() {
    let page = representations(Some(serde_json::json!({
        "status": "UP",
        "surfaces": {"ogc": {"prefix": "/x/views"}, "mcp": {"prefix": "/x/views"}}
    })))
    .await;
    assert!(!page.contains(STA), "the STA section is left out");
    assert!(
        !page.contains("#7-ogc-sensorthings-api-sta-v11"),
        "no link to it"
    );
    assert!(
        !page.contains("Entity Mapping Matrix"),
        "nor its subsections"
    );
    assert!(
        page.contains(OGC) && page.contains(NGSI_LD),
        "the others stay"
    );

    let built = representations(Some(serde_json::json!({
        "status": "UP",
        "surfaces": {"ogc": {}, "mcp": {}, "sta": {"endpoint": "/x/views/{view}/sta/v1.1"}}
    })))
    .await;
    assert!(built.contains(STA) && built.contains("Entity Mapping Matrix"));
}

/// A broker that does not answer confirms no surface: the page documents only what is no
/// surface of it, and is still served.
#[tokio::test]
async fn an_unreadable_broker_documents_no_gated_surface() {
    let page = representations(None).await;
    assert!(
        !page.contains(STA) && !page.contains(OGC),
        "nothing unconfirmed"
    );
    assert!(
        page.contains(NGSI_LD),
        "the NGSI-LD API is no surface of a feature"
    );
}
