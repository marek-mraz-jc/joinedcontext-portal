//! The App templates' live demos at `/templates/{name}/` (T-3306, AP-141).
//!
//! One bundle, `sdk/dist/demos` (`vite.demos.config.ts`), renders each sample over the template
//! with the rows of its `fixtures.ts`: no session, no token, no data of the platform. It carries
//! its own Content Security Policy, outside the Portal's, which forbids every connection, so a
//! demo cannot reach any server even if a sample tried.

use axum::body::Body;
use axum::extract::Path;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use rust_embed::RustEmbed;

use crate::agents::samples;
use crate::state::AppState;

/// Built with the Portal's image from the SDK; empty in a plain `cargo test`, where every
/// demo answers 404.
#[derive(RustEmbed)]
#[folder = "sdk/dist/demos"]
struct Demos;

/// The demos' policy: their own scripts, styles and images, the map's worker, nothing fetched
/// from anywhere, and framed by nobody but the Portal.
pub const DEMO_CSP: &str = "default-src 'self'; base-uri 'self'; object-src 'none'; \
     script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; \
     font-src 'self' data:; worker-src 'self' blob:; connect-src 'none'; form-action 'none'; \
     frame-ancestors 'self'";

fn file(path: &str) -> Response {
    let Some(content) = Demos::get(path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let mut response = Body::from(content.data.into_owned()).into_response();
    let headers = response.headers_mut();
    if let Ok(value) = HeaderValue::from_str(mime.as_ref()) {
        headers.insert(header::CONTENT_TYPE, value);
    }
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(DEMO_CSP),
    );
    headers.insert("x-frame-options", HeaderValue::from_static("SAMEORIGIN"));
    response
}

/// `/templates/{name}/`: the demo page, for a name the gallery holds and nothing else.
async fn demo(Path(name): Path<String>) -> Response {
    if !samples::templates()
        .iter()
        .any(|template| template.name == name)
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    file("index.html")
}

/// `/templates/assets/{file}`: the bundle's scripts, styles and images.
async fn asset(Path(name): Path<String>) -> Response {
    if name.contains('/') || name.contains("..") {
        return StatusCode::NOT_FOUND.into_response();
    }
    file(&format!("assets/{name}"))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/templates/assets/{file}", get(asset))
        .route("/templates/{name}", get(demo))
        .route("/templates/{name}/", get(demo))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_policy_forbids_every_connection_and_foreign_framing() {
        assert!(DEMO_CSP.contains("connect-src 'none'"));
        assert!(DEMO_CSP.contains("frame-ancestors 'self'"));
        assert!(!DEMO_CSP.contains("unsafe-eval"));
    }
}
