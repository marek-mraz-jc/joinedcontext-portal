use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use http_body_util::BodyExt;
use joinedcontext_portal::config::Config;
use joinedcontext_portal::server;
use joinedcontext_portal::state::AppState;
use tower::ServiceExt;

#[tokio::test]
async fn openapi_spec_served_correctly() {
    let app = server::app(AppState::new(Config::for_tests(), None));
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/openapi.json")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .unwrap()
        .to_str()
        .unwrap();
    assert!(content_type.starts_with("application/json"));

    let body_bytes = response.into_body().collect().await.unwrap().to_bytes();
    let doc: serde_json::Value = serde_json::from_slice(&body_bytes).unwrap();

    let openapi_ver = doc["openapi"].as_str().expect("openapi version string");
    assert!(
        openapi_ver.starts_with("3.1"),
        "expected openapi 3.1, got {openapi_ver}"
    );

    assert!(
        doc["paths"]["/api/v1/health"].is_object(),
        "expected /api/v1/health in paths, got: {:?}",
        doc["paths"]
    );

    assert_eq!(doc["info"]["title"], "joinedcontext Portal API");

    let schemas = &doc["components"]["schemas"];
    assert!(schemas["Health"].is_object(), "missing Health schema");
    assert!(
        schemas["ProblemDetails"].is_object(),
        "missing ProblemDetails schema"
    );
}

use std::path::PathBuf;

use joinedcontext_portal::openapi::ApiDoc;
use utoipa::OpenApi;

fn spec_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("ui/openapi.json")
}

fn rendered() -> String {
    let mut json = serde_json::to_string_pretty(&ApiDoc::openapi()).expect("serialise the spec");
    json.push('\n');
    json
}

/// The UI generates its types from the committed spec, so CI never needs a running server.
/// Regenerate with `cargo test --test openapi_tests -- --ignored write_openapi_json`,
/// then `pnpm generate:api` in `ui/`.
#[test]
fn committed_openapi_spec_is_current() {
    let committed = std::fs::read_to_string(spec_path()).expect("ui/openapi.json is committed");
    assert_eq!(
        committed,
        rendered(),
        "ui/openapi.json is stale — rerun the writer test and `pnpm generate:api`"
    );
}

#[test]
#[ignore = "writes ui/openapi.json; run explicitly after changing the API surface"]
fn write_openapi_json() {
    std::fs::write(spec_path(), rendered()).expect("write ui/openapi.json");
}

#[test]
fn every_documented_path_is_versioned_and_not_a_kubernetes_apis_path() {
    let spec = ApiDoc::openapi();
    for path in spec.paths.paths.keys() {
        assert!(
            path.starts_with("/api/v1/"),
            "path {path} is not under /api/v1/"
        );
        assert!(
            !path.starts_with("/apis/"),
            "path {path} uses the k8s shape"
        );
    }
}

/// MF-11, EP-01 (T-2361): a route the Portal mounts under `/api/v1` is a route it publishes.
///
/// Four routes were served and not published (T-2402 annotated them): the MCP endpoint, the
/// pipeline test run, the assistant's propose-endpoint and the schema inference. A client
/// generated from `ui/openapi.json` has no method for a path that is not in it, and no checker —
/// not the docs lane, not `verify-openapi-snippets.py` — can verify a page that documents one.
/// The next route cannot arrive undeclared: this reads the routers the way the server assembles
/// them and holds every path, and every method on it, against the generated document.
///
/// It reads the source rather than the built `Router` because axum publishes no list of what a
/// router carries; what keeps the reading honest is that a module the server merges and this walk
/// cannot find is a failure, not a silent skip.
mod mounted_routes {
    use super::*;
    use std::collections::{BTreeMap, BTreeSet};

    fn src(relative: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative)
    }

    /// The text between `open` and the parenthesis that closes it.
    fn call_body(text: &str, open: usize) -> &str {
        let mut depth = 0usize;
        for (offset, character) in text[open..].char_indices() {
            match character {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        return &text[open + 1..open + offset];
                    }
                }
                _ => {}
            }
        }
        &text[open..]
    }

    /// Where a module named in a `.merge(…::router())` call lives, under `src/`.
    fn file_of(module_path: &str) -> Option<PathBuf> {
        let segments: Vec<&str> = module_path.split("::").collect();
        // `crate::tools::model_tools::router()` is an absolute path. A bare `health::router()` is
        // a sibling of `src/api/mod.rs`, and a bare `auth::oidc::router()` is `use`d from the
        // crate root — both spellings are tried, in that order.
        let (roots, rest) = match segments.first() {
            Some(&"crate") => (vec!["src"], &segments[1..segments.len() - 1]),
            _ => (vec!["src/api", "src"], &segments[..segments.len() - 1]),
        };
        roots
            .into_iter()
            .flat_map(|root| {
                let joined = format!("{root}/{}", rest.join("/"));
                [format!("{joined}.rs"), format!("{joined}/mod.rs")]
            })
            .map(|candidate| src(&candidate))
            .find(|path| path.exists())
    }

    /// The routers `api::router()` merges: everything under `/api/v1`, as the file and the
    /// function that builds it. The function matters — `agent_runs.rs` also holds
    /// `internal_router()`, which `server.rs` serves on the internal listener and not here.
    fn api_modules() -> Vec<(String, PathBuf, String)> {
        let text = std::fs::read_to_string(src("src/api/mod.rs")).expect("src/api/mod.rs");
        let mut found = Vec::new();
        for (offset, _) in text.match_indices(".merge(") {
            let inside = call_body(&text, offset + ".merge".len()).trim().to_string();
            // `.merge(protected)` names a router built above, whose own merges are read here too.
            if !inside.contains("::") || !inside.ends_with("()") {
                continue;
            }
            let path = file_of(&inside).unwrap_or_else(|| {
                panic!(
                    "src/api/mod.rs merges {inside}, and this walk cannot find the file it lives \
                     in: the routes it mounts would go unchecked"
                )
            });
            let builder = inside
                .trim_end_matches("()")
                .rsplit("::")
                .next()
                .expect("a function name")
                .to_string();
            found.push((inside, path, builder));
        }
        found
    }

    /// Every other file under `src/` — the routers `server.rs` mounts at the root, of which only
    /// the MCP endpoint speaks `/api/v1`.
    fn all_sources() -> Vec<PathBuf> {
        fn walk(dir: &std::path::Path, into: &mut Vec<PathBuf>) {
            for entry in std::fs::read_dir(dir).expect("read src/").flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, into);
                } else if path.extension().is_some_and(|ext| ext == "rs") {
                    into.push(path);
                }
            }
        }
        let mut files = Vec::new();
        walk(&src("src"), &mut files);
        files
    }

    /// The body of `pub fn name(`, from its opening brace to the brace that closes it.
    fn function_body<'a>(text: &'a str, name: &str) -> &'a str {
        let signature = format!("pub fn {name}(");
        let at = text
            .find(&signature)
            .unwrap_or_else(|| panic!("no `{signature}` in the file that is said to hold it"));
        let open = text[at..].find('{').expect("a function body") + at;
        let mut depth = 0usize;
        for (offset, character) in text[open..].char_indices() {
            match character {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return &text[open..open + offset];
                    }
                }
                _ => {}
            }
        }
        &text[open..]
    }

    /// `METHOD /path` for every `.route("…", …)` in `text`, with `prefix` in front of the path.
    fn routes_in(text: &str, prefix: &str, only_versioned: bool) -> BTreeSet<String> {
        let mut found = BTreeSet::new();
        for (offset, _) in text.match_indices(".route(") {
            // The literal often sits on the line below `.route(`, where rustfmt puts it.
            let inside = call_body(text, offset + ".route".len()).trim_start();
            let Some(rest) = inside.strip_prefix('"') else {
                continue;
            };
            let Some(end) = rest.find('"') else { continue };
            let (literal, handlers) = rest.split_at(end);
            if only_versioned && !literal.starts_with("/api/v1") {
                continue;
            }
            // A router mounted at the root spells the prefix itself (the MCP endpoint does).
            let path = if literal.starts_with("/api/v1") {
                literal.to_string()
            } else {
                format!("{prefix}{literal}")
            };
            for method in ["get", "post", "put", "patch", "delete"] {
                let Some(at) = handlers.find(&format!("{method}(")) else {
                    continue;
                };
                // `post(handle).get(|| async { METHOD_NOT_ALLOWED })`: a closure is a refusal,
                // not an operation, and there is nothing for a client to be given.
                if handlers[at..].starts_with(&format!("{method}(|")) {
                    continue;
                }
                found.insert(format!("{} {path}", method.to_uppercase()));
            }
        }
        found
    }

    /// Every `METHOD /path` the server mounts under `/api/v1`, and where it is mounted.
    fn mounted() -> BTreeMap<String, String> {
        let mut all = BTreeMap::new();
        for (module, file, builder) in api_modules() {
            let text = std::fs::read_to_string(&file).expect("an api module");
            for route in routes_in(function_body(&text, &builder), "/api/v1", false) {
                all.insert(route, module.clone());
            }
        }
        for file in all_sources() {
            let text = std::fs::read_to_string(&file).expect("a source file");
            for route in routes_in(&text, "", true) {
                all.insert(route, file.display().to_string());
            }
        }
        all
    }

    /// The reading itself, on a router with every shape the Portal's own have: a literal below
    /// the call, two methods on one path, a path that carries the prefix already, a closure that
    /// only refuses, and a second builder in the same file that is served somewhere else.
    #[test]
    fn the_walk_reads_a_router_the_way_the_server_mounts_it() {
        const SAMPLE: &str = r#"
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/projects/{project}/things", get(list).post(create))
        .route(
            "/api/v1/mcp",
            post(handle).get(|| async { StatusCode::METHOD_NOT_ALLOWED }),
        )
        .route("/things/{name}", axum::routing::delete(remove))
}

pub fn internal_router() -> Router<AppState> {
    Router::new().route("/internal/things", get(internal_list))
}
"#;
        let mounted = routes_in(function_body(SAMPLE, "router"), "/api/v1", false);
        assert_eq!(
            mounted.iter().map(String::as_str).collect::<Vec<_>>(),
            [
                // `/api/v1/mcp` keeps the prefix it spells itself, and its `get` is a closure
                // that answers 405 — a refusal is not an operation a client can be given.
                "DELETE /api/v1/things/{name}",
                "GET /api/v1/projects/{project}/things",
                "POST /api/v1/mcp",
                "POST /api/v1/projects/{project}/things",
            ]
        );

        // The internal listener's own builder is in the same file and is not this surface.
        let internal = routes_in(function_body(SAMPLE, "internal_router"), "/api/v1", false);
        assert_eq!(
            internal.iter().map(String::as_str).collect::<Vec<_>>(),
            ["GET /api/v1/internal/things"]
        );

        // `only_versioned` is how a root-mounted router is read: only what it spells itself.
        let root = routes_in(function_body(SAMPLE, "router"), "", true);
        assert_eq!(
            root.iter().map(String::as_str).collect::<Vec<_>>(),
            ["POST /api/v1/mcp"]
        );
    }

    /// A module `api::router()` merges and this walk cannot find is a failure, not a skip.
    #[test]
    fn a_router_the_walk_cannot_place_is_a_failure() {
        assert!(file_of("health::router()").is_some());
        assert!(file_of("crate::tools::model_tools::router()").is_some());
        assert!(file_of("auth::oidc::backchannel_router()").is_some());
        assert!(file_of("nowhere::at::all::router()").is_none());
    }

    #[test]
    fn every_route_mounted_under_api_v1_is_published_in_the_openapi_document() {
        let spec = ApiDoc::openapi();
        let mounted = mounted();
        // The walk has to have found the surface; an empty one would pass every case below.
        assert!(
            mounted.len() > 60,
            "only {} mounted routes found: the walk is reading the wrong files",
            mounted.len()
        );

        let mut undeclared = Vec::new();
        for (route, where_from) in &mounted {
            let (method, path) = route.split_once(' ').expect("METHOD path");
            let Some(item) = spec.paths.paths.get(path) else {
                undeclared.push(format!(
                    "{route} ({where_from}): the path is not in the document"
                ));
                continue;
            };
            let published: BTreeSet<&str> = [
                ("GET", item.get.is_some()),
                ("POST", item.post.is_some()),
                ("PUT", item.put.is_some()),
                ("PATCH", item.patch.is_some()),
                ("DELETE", item.delete.is_some()),
            ]
            .into_iter()
            .filter_map(|(name, served)| served.then_some(name))
            .collect();
            if !published.contains(method) {
                undeclared.push(format!(
                    "{route} ({where_from}): the path is published with {published:?} and not \
                     {method}, so a generated client cannot call it"
                ));
            }
        }
        assert!(
            undeclared.is_empty(),
            "a route the Portal serves and does not publish (MF-11):\n{}",
            undeclared.join("\n")
        );
    }
}
