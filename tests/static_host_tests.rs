//! The static apps host: what it serves, what it refuses, and the headers every app carries
//! (AP-12, AP-14, AP-17).

mod common;

use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use http_body_util::BodyExt;
use joinedcontext_portal::apps::static_host::sri_sha384;
use joinedcontext_portal::config::Config;
use joinedcontext_portal::resource::{ObjectMeta, ResourceEnvelope, API_VERSION};
use joinedcontext_portal::server;
use joinedcontext_portal::state::AppState;
use joinedcontext_portal::store::Mirror;
use tower::ServiceExt;

const INDEX: &[u8] = b"<!doctype html><title>air quality</title>";
const BUNDLE_JS: &[u8] = b"console.log('air quality');";

/// One app directory with its bundle and the integrity manifest CI writes beside it.
fn app_root(case: &str, files: &[(&str, &[u8])]) -> tempdir::Dir {
    let dir = tempdir::Dir::new(case);
    let app = dir.path().join("air-quality");
    std::fs::create_dir_all(&app).expect("app dir");
    let mut digests = serde_json::Map::new();
    for (name, bytes) in files {
        std::fs::write(app.join(name), bytes).expect("bundle file");
        digests.insert((*name).into(), sri_sha384(bytes).into());
    }
    std::fs::write(
        app.join("integrity.json"),
        serde_json::to_vec(&digests).expect("manifest"),
    )
    .expect("write manifest");
    dir
}

/// The tiniest temp directory that cleans up after itself; the suite needs nothing more.
mod tempdir {
    use std::path::{Path, PathBuf};

    pub struct Dir(PathBuf);

    impl Dir {
        pub fn new(case: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "jc-apps-{case}-{}-{:?}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or_default()
            ));
            std::fs::create_dir_all(&path).expect("temp dir");
            Self(path)
        }

        pub fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Dir {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).ok();
        }
    }
}

/// The same mirror with the build the lane wrote back (AP-13a).
fn mirror_with_build(spec: serde_json::Value, commit: &str) -> Arc<Mirror> {
    let mirror = mirror_with_app(spec);
    let mut envelope = mirror
        .get("ovzdusie", "App", "air-quality")
        .expect("the app");
    envelope.status = Some(joinedcontext_portal::resource::Status {
        phase: joinedcontext_portal::resource::Phase::Live,
        observed_revision: None,
        source_url: None,
        conditions: Vec::new(),
        build: Some(jc_core::Build {
            digest: format!("sha256:{}", "a1b2c3d4".repeat(8)),
            commit: commit.to_owned(),
            sdk_version: "0.4.1".to_owned(),
            built_at: chrono::Utc::now(),
        }),
        domain_verification: None,
    });
    mirror.upsert(envelope);
    mirror
}

fn mirror_with_app(spec: serde_json::Value) -> Arc<Mirror> {
    let mirror = Arc::new(Mirror::new());
    mirror.upsert(ResourceEnvelope {
        api_version: API_VERSION.into(),
        kind: "App".into(),
        metadata: ObjectMeta {
            name: "air-quality".into(),
            namespace: Some("ovzdusie".into()),
            ..Default::default()
        },
        spec,
        status: None,
    });
    mirror
}

fn app_spec(lifecycle: &str) -> serde_json::Value {
    serde_json::json!({
        "kind": "static",
        "source": { "path": "." },
        "build": { "node": "22" },
        "visibility": "public",
        "lifecycle": lifecycle,
        "dataNeeds": []
    })
}

async fn get_from(
    root: &std::path::Path,
    spec: serde_json::Value,
    uri: &str,
) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let config = Config {
        apps_dir: Some(root.to_string_lossy().into_owned()),
        ..Config::for_tests()
    };
    let app = server::app(AppState::new(config, None).with_mirror(mirror_with_app(spec)));
    let response = app
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (status, headers, body.to_vec())
}

#[tokio::test]
async fn a_published_app_serves_its_bundle_under_the_platform_host() {
    let dir = app_root("serves", &[("index.html", INDEX), ("bundle.js", BUNDLE_JS)]);

    let (status, headers, body) =
        get_from(dir.path(), app_spec("published"), "/apps/air-quality/").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, INDEX, "the app's own index, not the Portal SPA");
    assert!(headers[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .starts_with("text/html"));

    let (status, headers, body) = get_from(
        dir.path(),
        app_spec("published"),
        "/apps/air-quality/bundle.js",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, BUNDLE_JS);
    assert!(headers[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
}

#[tokio::test]
async fn every_app_response_carries_its_own_policy_and_not_the_portals() {
    let dir = app_root("csp", &[("index.html", INDEX)]);

    let (_, headers, _) = get_from(dir.path(), app_spec("published"), "/apps/air-quality/").await;

    let csp = headers[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
    assert!(csp.contains("frame-ancestors 'none'"), "{csp}");
    assert!(csp.contains("connect-src 'self';"), "{csp}");
    assert!(
        !csp.contains("worker-src"),
        "the Portal's policy is not the app's: {csp}"
    );
    assert_eq!(headers[header::X_FRAME_OPTIONS], "DENY");
    assert_eq!(headers["x-content-type-options"], "nosniff");
}

#[tokio::test]
async fn an_embeddable_app_may_be_framed_by_the_named_origin() {
    let dir = app_root("embed", &[("index.html", INDEX)]);
    let mut spec = app_spec("published");
    spec["embeddable"] = serde_json::json!(true);
    spec["csp"] = serde_json::json!({ "frameAncestors": ["https://portal.example.sk"] });

    let (_, headers, _) = get_from(dir.path(), spec, "/apps/air-quality/").await;

    let csp = headers[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
    assert!(
        csp.contains("frame-ancestors https://portal.example.sk"),
        "{csp}"
    );
    assert_eq!(headers[header::X_FRAME_OPTIONS], "SAMEORIGIN");
}

#[tokio::test]
async fn an_unpublished_app_is_not_found_rather_than_forbidden() {
    // A draft, a preview and a retired app answer exactly what a name that never existed
    // answers, so the host discloses nothing about what is being worked on (AP-18).
    let dir = app_root("draft", &[("index.html", INDEX)]);

    for lifecycle in ["draft", "preview", "retired"] {
        let (status, _, _) = get_from(dir.path(), app_spec(lifecycle), "/apps/air-quality/").await;
        assert_eq!(
            status,
            StatusCode::NOT_FOUND,
            "{lifecycle} must not be reachable"
        );
    }

    let (status, _, _) = get_from(dir.path(), app_spec("published"), "/apps/nothing-here/").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_non_public_app_needs_a_session() {
    let dir = app_root("private", &[("index.html", INDEX)]);
    let mut spec = app_spec("published");
    spec["visibility"] = serde_json::json!("project");

    let (status, _, _) = get_from(dir.path(), spec, "/apps/air-quality/").await;

    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_modified_asset_is_refused_rather_than_served() {
    let dir = app_root(
        "tampered",
        &[("index.html", INDEX), ("bundle.js", BUNDLE_JS)],
    );
    // The digest manifest is what CI recorded; the file on disk changed afterwards.
    std::fs::write(
        dir.path().join("air-quality/bundle.js"),
        b"console.log('exfiltrate');",
    )
    .expect("tamper");

    let (status, _, body) = get_from(
        dir.path(),
        app_spec("published"),
        "/apps/air-quality/bundle.js",
    )
    .await;

    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(
        !String::from_utf8_lossy(&body).contains("exfiltrate"),
        "the modified bytes must never reach the caller"
    );
}

#[tokio::test]
async fn a_file_without_a_recorded_digest_is_not_part_of_the_bundle() {
    let dir = app_root("stray", &[("index.html", INDEX)]);
    std::fs::write(dir.path().join("air-quality/notes.txt"), b"internal").expect("stray file");

    let (status, _, _) = get_from(
        dir.path(),
        app_spec("published"),
        "/apps/air-quality/notes.txt",
    )
    .await;

    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_bundle_without_an_integrity_manifest_serves_nothing() {
    let dir = tempdir::Dir::new("no-manifest");
    let app = dir.path().join("air-quality");
    std::fs::create_dir_all(&app).expect("app dir");
    std::fs::write(app.join("index.html"), INDEX).expect("index");

    let (status, _, _) = get_from(dir.path(), app_spec("published"), "/apps/air-quality/").await;

    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_traversal_never_reads_outside_the_app_directory() {
    let dir = app_root("traversal", &[("index.html", INDEX)]);
    std::fs::write(dir.path().join("secret.txt"), b"another app's file").expect("neighbour");

    for uri in [
        "/apps/air-quality/../secret.txt",
        "/apps/air-quality/..%2fsecret.txt",
        "/apps/air-quality/%2e%2e/secret.txt",
    ] {
        let (status, _, body) = get_from(dir.path(), app_spec("published"), uri).await;
        assert_ne!(status, StatusCode::OK, "{uri} was served");
        assert!(
            !String::from_utf8_lossy(&body).contains("another app's file"),
            "{uri} read outside the root"
        );
    }
}

#[tokio::test]
async fn an_unknown_path_inside_a_published_app_is_not_the_index() {
    // No SPA fallback: a missing asset stays visible as missing (AP-14).
    let dir = app_root("no-fallback", &[("index.html", INDEX)]);

    let (status, _, body) = get_from(
        dir.path(),
        app_spec("published"),
        "/apps/air-quality/dashboard",
    )
    .await;

    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_ne!(body, INDEX);
}

#[tokio::test]
async fn without_an_apps_directory_the_host_answers_not_found() {
    let app = server::app(
        AppState::new(Config::for_tests(), None)
            .with_mirror(mirror_with_app(app_spec("published"))),
    );
    let response = app
        .oneshot(
            Request::builder()
                .uri("/apps/air-quality/")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

/// The digest `mirror_with_build` names, as the directory the host fetches it into.
const BUILD_HEX: &str = "a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4";

/// The cache a replica fetches builds into (AP-102), beside the bundles the image ships.
fn cache_of(dir: &tempdir::Dir) -> std::path::PathBuf {
    dir.path().join("cache")
}

/// One fetched build of an app: `{apps_cache_dir}/{name}/{hex}/` with its own integrity manifest
/// (AP-102), beside the bundle the image ships at `{apps_dir}/{name}/`.
fn build_dir(dir: &tempdir::Dir, files: &[(&str, &[u8])]) {
    let app = cache_of(dir).join("air-quality").join(BUILD_HEX);
    std::fs::create_dir_all(&app).expect("build dir");
    let mut digests = serde_json::Map::new();
    for (name, bytes) in files {
        std::fs::write(app.join(name), bytes).expect("bundle file");
        digests.insert((*name).into(), sri_sha384(bytes).into());
    }
    std::fs::write(
        app.join("integrity.json"),
        serde_json::to_vec(&digests).expect("manifest"),
    )
    .expect("write manifest");
}

async fn get_with(root: &std::path::Path, mirror: Arc<Mirror>, uri: &str) -> (StatusCode, Vec<u8>) {
    let config = Config {
        apps_dir: Some(root.to_string_lossy().into_owned()),
        apps_cache_dir: Some(root.join("cache").to_string_lossy().into_owned()),
        ..Config::for_tests()
    };
    let app = server::app(AppState::new(config, None).with_mirror(mirror));
    let response = app
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (status, body.to_vec())
}

const NEXT_INDEX: &[u8] = b"<!doctype html><title>air quality, next build</title>";

/// AP-72, AP-102: the host serves the build the manifest names, fetched under its digest, not
/// the bundle the image ships.
#[tokio::test]
async fn the_host_serves_the_build_the_manifest_names() {
    let dir = app_root("named-build", &[("index.html", INDEX)]);
    build_dir(&dir, &[("index.html", NEXT_INDEX)]);

    let (status, body) = get_with(
        dir.path(),
        mirror_with_build(app_spec("published"), "8c56954a1f0e"),
        "/apps/air-quality/",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, NEXT_INDEX, "the named build, not the previous one");
}

/// AP-72: a build this host does not hold keeps the previous one serving, and the app is named
/// as missing its build rather than quietly serving something older as if it were current.
#[tokio::test]
async fn a_build_the_host_does_not_hold_keeps_the_previous_one_serving_and_is_reported() {
    let dir = app_root("missing-build", &[("index.html", INDEX)]);
    let mirror = mirror_with_build(app_spec("published"), "0000000feed");

    let (status, body) = get_with(dir.path(), mirror.clone(), "/apps/air-quality/").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, INDEX, "the previous publish keeps serving");

    let apps_dir = cache_of(&dir).to_string_lossy().into_owned();
    assert_eq!(
        joinedcontext_portal::apps::static_host::build_missing(Some(&apps_dir), &mirror),
        vec!["air-quality".to_owned()],
        "the app says its build never arrived"
    );

    // The build arrives: nothing else changes and the host follows it.
    build_dir(&dir, &[("index.html", NEXT_INDEX)]);
    let (status, body) = get_with(dir.path(), mirror.clone(), "/apps/air-quality/").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, NEXT_INDEX);
    assert!(
        joinedcontext_portal::apps::static_host::build_missing(Some(&apps_dir), &mirror).is_empty(),
        "nothing is missing once the build is there"
    );
}

fn envelope(kind: &str, project: &str, name: &str, spec: serde_json::Value) -> ResourceEnvelope {
    ResourceEnvelope {
        api_version: API_VERSION.into(),
        kind: kind.into(),
        metadata: ObjectMeta {
            name: name.into(),
            namespace: Some(project.into()),
            ..Default::default()
        },
        spec,
        status: None,
    }
}

/// The `#jc-config` element of a served index, parsed.
fn served_config(body: &[u8]) -> serde_json::Value {
    let html = String::from_utf8(body.to_vec()).expect("an html index");
    let open = "<script id=\"jc-config\" type=\"application/json\">";
    let start = html.find(open).expect("the index carries #jc-config") + open.len();
    let end = start + html[start..].find("</script>").expect("the element closes");
    assert_eq!(
        html.matches("id=\"jc-config\"").count(),
        1,
        "exactly one configuration: {html}"
    );
    serde_json::from_str(&html[start..end]).expect("the configuration is JSON")
}

/// T-2667, AP-04: once the App's grants are committed it reads through its own endpoint alone.
/// Offering every endpoint of the space made the SDK refuse a type several of them serve
/// ("served by more than one endpoint"), and the bikes sample showed no station on dev.
#[tokio::test]
async fn an_app_with_its_own_endpoint_is_served_that_endpoint_alone() {
    let index: &[u8] = b"<!doctype html><html><head><title>kpi</title></head><body></body></html>";
    let dir = app_root("config", &[("index.html", index)]);
    let mut spec = app_spec("published");
    spec["dataNeeds"] = serde_json::json!([{
        "contextSpaceRef": { "kind": "ContextSpace", "name": "bbsk-kpi" },
        "types": ["KeyPerformanceIndicator"],
        "operations": ["queryEntity"]
    }]);
    let mirror = mirror_with_app(spec);
    let endpoint =
        |space: &str, slug: &str| serde_json::json!({ "contextSpaceRef": space, "slug": slug });
    for (name, slug) in [
        ("bbsk-kpi", "regionslug"),
        ("bbsk-kpi-public", "publicslug"),
    ] {
        mirror.upsert(envelope(
            "Endpoint",
            "ovzdusie",
            name,
            endpoint("bbsk-kpi", slug),
        ));
    }
    // A hand-written endpoint with the app's endpoint name is not the app's (T-2632).
    let (_, body) = get_with(dir.path(), mirror.clone(), "/apps/air-quality/").await;
    assert_eq!(
        served_config(&body)["endpoints"].as_array().map(Vec::len),
        Some(2)
    );

    let mut own = envelope(
        "Endpoint",
        "ovzdusie",
        "app-air-quality",
        endpoint("bbsk-kpi", "ownslug"),
    );
    own.metadata.annotations.insert(
        "joinedcontext.com/generated-by".into(),
        joinedcontext_portal::apps::reconciler::GENERATOR.into(),
    );
    mirror.upsert(own);
    let (status, body) = get_with(dir.path(), mirror, "/apps/air-quality/").await;
    assert_eq!(status, StatusCode::OK);
    let config = served_config(&body);
    assert_eq!(config["slug"], "ownslug");
    assert_eq!(config["endpointName"], "app-air-quality");
    let slugs: Vec<&str> = config["endpoints"]
        .as_array()
        .expect("endpoints")
        .iter()
        .filter_map(|e| e["slug"].as_str())
        .collect();
    assert_eq!(slugs, ["ownslug"]);
}

/// T-2457: the region's application reads its own indicators and the city's through the shared
/// reference, so the index it is served names both endpoints, by space, and never a token.
#[tokio::test]
async fn the_served_index_names_the_apps_endpoint_and_the_shared_one() {
    let index: &[u8] = b"<!doctype html><html><head><title>kpi</title></head><body></body></html>";
    let dir = app_root("config", &[("index.html", index)]);
    let mut spec = app_spec("published");
    spec["dataNeeds"] = serde_json::json!([{
        "contextSpaceRef": { "kind": "ContextSpace", "name": "bbsk-kpi" },
        "types": ["KeyPerformanceIndicator"],
        "operations": ["queryEntity"]
    }]);

    let mirror = mirror_with_app(spec);
    let endpoint =
        |space: &str, slug: &str| serde_json::json!({ "contextSpaceRef": space, "slug": slug });
    mirror.upsert(envelope(
        "Endpoint",
        "ovzdusie",
        "bbsk-kpi",
        endpoint("bbsk-kpi", "regionslug"),
    ));
    // Another space of the same project: not a need of the app, so not in its configuration.
    mirror.upsert(envelope(
        "Endpoint",
        "ovzdusie",
        "bbsk-kraj",
        endpoint("bbsk-kraj", "rawslug"),
    ));
    mirror.upsert(envelope(
        "Endpoint",
        "banskabystrica",
        "banskabystrica-kpi",
        endpoint("banskabystrica-kpi", "cityslug"),
    ));
    mirror.upsert(envelope(
        "SharedSpaceReference",
        "ovzdusie",
        "mesto-kpi",
        serde_json::json!({
            "alias": "mesto-kpi",
            "endpointRef": { "project": "banskabystrica", "name": "banskabystrica-kpi" }
        }),
    ));
    // A reference to an endpoint that is not there adds nothing and breaks nothing.
    mirror.upsert(envelope(
        "SharedSpaceReference",
        "ovzdusie",
        "gone",
        serde_json::json!({ "alias": "gone", "endpointRef": { "project": "nowhere", "name": "x" } }),
    ));

    let (status, body) = get_with(dir.path(), mirror, "/apps/air-quality/").await;
    assert_eq!(status, StatusCode::OK);
    let config = served_config(&body);
    assert_eq!(config["transport"], "origin");
    assert_eq!(config["appName"], "air-quality");
    assert_eq!(
        config["slug"], "regionslug",
        "the app's own endpoint is the primary"
    );
    assert_eq!(config["space"], "bbsk-kpi");
    assert_eq!(config["endpointName"], "bbsk-kpi");
    let endpoints: Vec<(String, String)> = config["endpoints"]
        .as_array()
        .expect("endpoints")
        .iter()
        .map(|e| {
            (
                e["slug"].as_str().unwrap().into(),
                e["space"].as_str().unwrap().into(),
            )
        })
        .collect();
    assert_eq!(
        endpoints,
        vec![
            ("regionslug".to_owned(), "bbsk-kpi".to_owned()),
            ("cityslug".to_owned(), "banskabystrica-kpi".to_owned()),
        ]
    );
    assert_eq!(
        config["endpoints"][0]["types"],
        serde_json::json!(["KeyPerformanceIndicator"])
    );
    let text = config.to_string().to_lowercase();
    assert!(
        !text.contains("token") && !text.contains("bearer"),
        "{config}"
    );
}

/// An index that reads nothing is served byte for byte as it was built and signed.
#[tokio::test]
async fn an_app_without_data_needs_is_served_as_built() {
    let dir = app_root("asbuilt", &[("index.html", INDEX)]);
    let (status, _, body) = get_from(dir.path(), app_spec("published"), "/apps/air-quality/").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, INDEX);
}

/// One request for an app with the `Host` a browser sends, on a Portal whose apps live on
/// `https://example.org` and whose own UI lives on `https://portal.example.org`.
async fn get_on_host(root: &std::path::Path, host: &str, uri: &str) -> axum::response::Response {
    let config = Config {
        apps_dir: Some(root.to_string_lossy().into_owned()),
        public_base_url: "https://portal.example.org".parse().unwrap(),
        apps_url: Some("https://example.org".parse().unwrap()),
        ..Config::for_tests()
    };
    let app = server::app(
        AppState::new(config, None).with_mirror(mirror_with_app(app_spec("published"))),
    );
    app.oneshot(
        Request::builder()
            .uri(uri)
            .header(header::HOST, host)
            .body(Body::empty())
            .unwrap(),
    )
    .await
    .unwrap()
}

/// T-2476: an app served on the Portal's own origin would reach the Portal API with the
/// viewer's session cookie and read the CSRF cookie. The Portal host never serves one; it
/// sends the browser to the same path on the apps origin.
#[tokio::test]
async fn an_app_asked_for_on_the_portal_host_is_sent_to_the_apps_origin() {
    let dir = app_root(
        "portal-host",
        &[("index.html", INDEX), ("bundle.js", BUNDLE_JS)],
    );

    for (uri, location) in [
        (
            "/apps/air-quality/",
            "https://example.org/apps/air-quality/",
        ),
        (
            "/apps/air-quality/bundle.js?v=2",
            "https://example.org/apps/air-quality/bundle.js?v=2",
        ),
    ] {
        let response = get_on_host(dir.path(), "portal.example.org", uri).await;
        assert_eq!(response.status(), StatusCode::PERMANENT_REDIRECT, "{uri}");
        assert_eq!(response.headers()[header::LOCATION], location, "{uri}");
        assert!(response
            .headers()
            .get(header::CONTENT_SECURITY_POLICY)
            .is_none());
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert!(
            body.is_empty(),
            "no byte of the bundle on the Portal origin"
        );
    }

    // Any host but the apps origin is the same refusal: a Host header is the caller's to set.
    let response = get_on_host(dir.path(), "evil.example.net", "/apps/air-quality/").await;
    assert_eq!(response.status(), StatusCode::PERMANENT_REDIRECT);
    assert_eq!(
        response.headers()[header::LOCATION],
        "https://example.org/apps/air-quality/"
    );
}

#[tokio::test]
async fn an_app_is_served_on_the_apps_origin() {
    let dir = app_root("apps-host", &[("index.html", INDEX)]);

    for host in ["example.org", "EXAMPLE.org:443"] {
        let response = get_on_host(dir.path(), host, "/apps/air-quality/").await;
        assert_eq!(response.status(), StatusCode::OK, "{host}");
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(body, INDEX);
    }
    let response = get_on_host(dir.path(), "example.org:8443", "/apps/air-quality/").await;
    assert_eq!(
        response.status(),
        StatusCode::PERMANENT_REDIRECT,
        "another port is another origin"
    );
}

/// AP-84: a signed-in person's first index on the apps origin brings the double-submit CSRF
/// cookie a function call needs there; the Portal's own is host-only on the Portal host. An
/// anonymous visitor gets none, and one who already holds it keeps the one they have.
#[tokio::test]
async fn a_signed_in_index_brings_the_apps_origins_csrf_cookie() {
    let dir = app_root("csrf-cookie", &[("index.html", INDEX)]);
    let config = edge_config(dir.path());
    let token = common::REALM.person_token("air-quality", "jana", &[]);
    let app = server::app(
        AppState::new(config, None).with_mirror(mirror_with_app(app_spec("published"))),
    );
    let csrf_cookie = |signed_in: bool, cookie: Option<&str>| {
        let app = app.clone();
        let cookie = cookie.map(str::to_owned);
        let token = signed_in.then(|| token.clone());
        async move {
            let mut request = Request::builder().uri("/apps/air-quality/");
            if let Some(token) = token {
                request = request.header("x-access-token", token);
            }
            if let Some(cookie) = cookie {
                request = request.header(header::COOKIE, cookie);
            }
            let response = app
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            response
                .headers()
                .get_all(header::SET_COOKIE)
                .iter()
                .filter_map(|value| value.to_str().ok())
                .find(|value| value.starts_with("jc_csrf="))
                .map(str::to_owned)
        }
    };

    let issued = csrf_cookie(true, None)
        .await
        .expect("a CSRF cookie for the signed-in person");
    assert!(
        issued.contains("Secure") && issued.contains("SameSite=Lax"),
        "{issued}"
    );
    assert_eq!(
        csrf_cookie(false, None).await,
        None,
        "nothing for an anonymous visitor"
    );
    assert_eq!(
        csrf_cookie(true, Some("jc_csrf=already-held")).await,
        None,
        "a held token is kept"
    );
}

/// A Portal behind the edge, trusting the process's realm, serving the apps under `root`.
fn edge_config(root: &std::path::Path) -> Config {
    let realm = Config::from_vars(|key| {
        match key {
            "JC_OIDC_ISSUER" => Some(common::REALM.issuer.as_str()),
            "JC_OIDC_CLIENT_ID" => Some("portal-api"),
            "JC_OIDC_CLIENT_SECRET" => Some("secret"),
            _ => None,
        }
        .map(str::to_owned)
    })
    .expect("a realm");
    Config {
        apps_dir: Some(root.to_string_lossy().into_owned()),
        trust_edge_token: true,
        ..realm
    }
}

/// One request for the app with the edge's `token`, or anonymously.
async fn get_as(
    root: &std::path::Path,
    mirror: Arc<Mirror>,
    token: Option<String>,
    uri: &str,
) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let config = edge_config(root);
    let mut request = Request::builder()
        .uri(uri)
        .header(header::ACCEPT_LANGUAGE, "en");
    if let Some(token) = token {
        request = request.header("x-access-token", token);
    }
    let app = server::app(AppState::new(config, None).with_mirror(mirror));
    let response = app
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (status, headers, body.to_vec())
}

/// A `visibility: roles` app reading one space, with a viewer group and one steward.
fn roles_app() -> Arc<Mirror> {
    let mut spec = app_spec("published");
    spec["visibility"] = serde_json::json!("roles");
    spec["roles"] = serde_json::json!([
        { "name": "viewer", "title": { "en": "Viewer" } },
        { "name": "steward", "title": { "en": "Steward" } }
    ]);
    spec["access"] = serde_json::json!([
        { "role": "viewer", "subjects": [{ "group": "ovzdusie-operations" }] },
        { "role": "steward", "subjects": [{ "user": "jana" }] }
    ]);
    spec["dataNeeds"] = serde_json::json!([{
        "contextSpaceRef": { "kind": "ContextSpace", "name": "ovzdusie" },
        "types": ["AirQualityObserved"],
        "operations": ["queryEntity"]
    }]);
    let mirror = mirror_with_app(spec);
    mirror.upsert(envelope(
        "Endpoint",
        "ovzdusie",
        "app-air-quality",
        serde_json::json!({ "contextSpaceRef": "ovzdusie", "slug": "appslug" }),
    ));
    mirror
}

/// AP-93: a signed-in person holding no role of a `visibility: roles` app gets the 403 page that
/// names the roles and no member; an anonymous visitor gets it too, and neither sees a byte of
/// the bundle, the index or an asset.
#[tokio::test]
async fn a_person_without_a_role_is_refused_with_the_roles_and_no_member() {
    let dir = app_root(
        "roles-refused",
        &[("index.html", INDEX), ("app.js", BUNDLE_JS)],
    );
    // Petra holds no role of this App; the Portal's own login and another App's token are not
    // this App's, whatever roles they carry (AP-92).
    let petra = common::REALM.person_token("air-quality", "petra", &[]);
    let portal = common::REALM.person_token_of("portal-api", "portal-api", "jana", &["steward"]);
    let other = common::REALM.person_token("other", "jana", &["steward"]);
    for (who, uri) in [
        (Some(petra.clone()), "/apps/air-quality/"),
        (Some(petra), "/apps/air-quality/app.js"),
        (Some(portal), "/apps/air-quality/"),
        (Some(other), "/apps/air-quality/"),
        (None, "/apps/air-quality/"),
    ] {
        let (status, headers, body) = get_as(dir.path(), roles_app(), who, uri).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{uri}");
        assert_eq!(headers[header::CACHE_CONTROL], "private, no-store");
        let page = String::from_utf8(body).expect("html");
        assert!(
            page.contains("<li>Viewer</li>") && page.contains("<li>Steward</li>"),
            "{page}"
        );
        assert!(page.contains("project ovzdusie"), "{page}");
        assert!(
            !page.contains("jana") && !page.contains("ovzdusie-operations"),
            "{page}"
        );
        assert!(
            !page.contains("air quality</title>") && !page.contains("console.log"),
            "{page}"
        );
    }
}

/// AP-95, SDK-35: a member is served the index with their roles in this app, the platform's never,
/// and an index that carries a person is kept by no cache.
#[tokio::test]
async fn a_member_is_served_the_index_with_their_roles_and_no_store() {
    let dir = app_root("roles-served", &[("index.html", INDEX)]);
    // The token's realm roles and other clients' roles are left out; its roles of this App's
    // client come in the order the manifest declares them.
    let jana = common::REALM.person_token("air-quality", "jana", &["steward", "viewer"]);
    let (status, headers, body) =
        get_as(dir.path(), roles_app(), Some(jana), "/apps/air-quality/").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CACHE_CONTROL], "private, no-store");
    assert_eq!(
        served_config(&body)["user"],
        serde_json::json!({
            "id": "sub-jana",
            "name": "jana@hel.fi",
            "email": "jana@hel.fi",
            "roles": ["viewer", "steward"]
        })
    );
}

/// AP-95: an anonymous visitor of a public app is served `user: null`, and the index stays
/// revalidated rather than private, since it carries nobody.
#[tokio::test]
async fn an_anonymous_visitor_is_served_no_user() {
    let dir = app_root("roles-anonymous", &[("index.html", INDEX)]);
    let mirror = roles_app();
    let mut envelope = mirror
        .get("ovzdusie", "App", "air-quality")
        .expect("the app");
    envelope.spec["visibility"] = serde_json::json!("public");
    mirror.upsert(envelope);
    let (status, headers, body) = get_as(dir.path(), mirror, None, "/apps/air-quality/").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CACHE_CONTROL], "no-cache");
    assert_eq!(served_config(&body)["user"], serde_json::Value::Null);
}

/// AP-67, AP-12, T-2833: a published App's map reads the platform's basemap. The index names the
/// style URL in `#jc-config`, and the policy admits that project's basemap route in `connect-src`
/// and `img-src` and nothing more; without a configured basemap neither appears.
#[tokio::test]
async fn a_configured_basemap_is_in_the_config_and_the_policy_admits_only_its_route() {
    use joinedcontext_portal::config::BasemapConfig;

    let index: &[u8] = b"<!doctype html><html><head><title>map</title></head><body></body></html>";
    let dir = app_root("basemap", &[("index.html", index)]);
    let mut spec = app_spec("published");
    spec["dataNeeds"] = serde_json::json!([{
        "contextSpaceRef": { "kind": "ContextSpace", "name": "air" },
        "types": ["AirQualityObserved"],
        "operations": ["queryEntity"]
    }]);
    let mirror = mirror_with_app(spec);
    mirror.upsert(envelope(
        "Endpoint",
        "ovzdusie",
        "air-public",
        serde_json::json!({ "contextSpaceRef": "air", "slug": "airslug" }),
    ));

    let get = |basemap: Option<BasemapConfig>| {
        let mut config = Config {
            apps_dir: Some(dir.path().to_string_lossy().into_owned()),
            ..Config::for_tests()
        };
        config.basemap = basemap;
        let state = AppState::new(config, None).with_mirror(mirror.clone());
        async move {
            let response = server::app(state)
                .oneshot(
                    Request::builder()
                        .uri("/apps/air-quality/")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            let csp = response.headers()[header::CONTENT_SECURITY_POLICY]
                .to_str()
                .unwrap()
                .to_owned();
            let body = response.into_body().collect().await.unwrap().to_bytes();
            (csp, served_config(&body))
        }
    };

    let (csp, config) = get(None).await;
    assert!(config.get("basemap").is_none(), "{config}");
    assert!(!csp.contains("/basemap/"), "{csp}");

    let basemap = BasemapConfig::for_tests(
        "https://tile.openstreetmap.org/{z}/{x}/{y}.png".to_owned(),
        "© OpenStreetMap contributors".to_owned(),
        dir.path().join("tiles"),
    );
    let (csp, config) = get(Some(basemap)).await;
    let base = Config::for_tests().public_base_url.to_string();
    let prefix = format!(
        "{}/api/v1/projects/ovzdusie/basemap/",
        base.trim_end_matches('/')
    );
    assert_eq!(config["basemap"], format!("{prefix}default/style.json"));
    assert!(
        csp.contains(&format!("connect-src 'self' {prefix};")),
        "{csp}"
    );
    assert!(
        csp.contains(&format!("img-src 'self' data: blob: {prefix};")),
        "{csp}"
    );
    assert!(
        !csp.contains("openstreetmap"),
        "the tile host stays behind the Portal: {csp}"
    );
}
