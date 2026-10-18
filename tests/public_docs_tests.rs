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
