//! The interface, built into `ui/dist` and embedded, so the image is one binary (AP-105).

use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;

use crate::{with_config, App, Caller};

#[derive(RustEmbed)]
#[folder = "ui/dist"]
pub struct Assets;

/// Served when the binary was built without the interface, so the reason is on the page.
pub const PLACEHOLDER_HTML: &str = "<!doctype html>\n<html lang=\"en\">\n<head><meta charset=\"utf-8\" /><title>Application</title></head>\n<body><p>The interface is not built: run <code>pnpm build</code> in <code>ui/</code>, then build this binary again.</p></body>\n</html>\n";

/// The page with the `#jc-config` the App SDK starts from: the App's configuration and the
/// person from `/me` (AP-95, AP-126). It is about one person, so no cache keeps it.
pub async fn index(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    let html = Assets::get("index.html")
        .map(|file| String::from_utf8_lossy(&file.data).into_owned())
        .unwrap_or_else(|| PLACEHOLDER_HTML.to_owned());
    let mut config = serde_json::Value::Object(app.config.app_config.clone());
    config["user"] = app
        .user(&Caller::of(&headers))
        .await
        .unwrap_or(serde_json::Value::Null);
    (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        with_config(&html, &config),
    )
        .into_response()
}

/// A built file; a path without an extension is the page, where the interface routes itself.
pub async fn file(State(app): State<Arc<App>>, headers: HeaderMap, uri: Uri) -> Response {
    let base = app.config.base_path.trim_end_matches('/');
    let path = uri
        .path()
        .strip_prefix(base)
        .unwrap_or(uri.path())
        .trim_start_matches('/');
    if path.is_empty() || path == "index.html" {
        return index(State(app), headers).await;
    }
    match Assets::get(path) {
        Some(file) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            // Vite names every asset by its content, so a path never changes what it holds.
            let cache = if path.starts_with("assets/") {
                "public, max-age=31536000, immutable"
            } else {
                "no-cache"
            };
            (
                [
                    (header::CONTENT_TYPE, mime.as_ref().to_owned()),
                    (header::CACHE_CONTROL, cache.to_owned()),
                ],
                Body::from(file.data.into_owned()),
            )
                .into_response()
        }
        None if !path.rsplit('/').next().unwrap_or(path).contains('.') => {
            index(State(app), headers).await
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}
