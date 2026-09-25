//! Static apps served under the platform host at `/apps/{name}/` (AP-14).
//!
//! A `static` app is a built bundle in the app artifact root, one directory per app. Three
//! things decide what leaves this module: the app's manifest must say `lifecycle: published`
//! (AP-18), every file must match the Subresource Integrity digest its build lane recorded in
//! `integrity.json` (AP-12), and every response carries the app's own Content Security Policy
//! instead of the Portal's (AP-12).

use std::path::{Path as FsPath, PathBuf};

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use base64::Engine;
use jc_core::kinds::{AppLifecycle, AppSpec, AppVisibility};
use sha2::{Digest, Sha384};

use crate::error::ApiError;
use crate::state::AppState;

/// Digest map written by the build lane beside the bundle: bundle-relative path →
/// `sha384-<base64>`. An app directory without it serves nothing; the manifest is what makes a
/// bundle publishable, not an optional extra (AP-12).
pub const INTEGRITY_MANIFEST: &str = "integrity.json";

/// Serves `/apps/{name}/` — the app's own index.
///
/// A signed-in person's first index also brings the double-submit CSRF cookie of the apps origin:
/// the Portal's own is host-only on the Portal host, and a function call that carries the edge's
/// token is refused without one (AP-84, [`super::functions`]).
async fn serve_index(
    state: State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    name: Path<String>,
) -> Response {
    let needs_csrf = super::roles::presented(&state, &headers).is_some()
        && axum_extra::extract::cookie::CookieJar::from_headers(&headers)
            .get(crate::auth::csrf::CSRF_COOKIE)
            .is_none();
    let mut response = serve(
        state,
        headers,
        uri,
        Path((name.0, "index.html".to_string())),
    )
    .await;
    if needs_csrf && response.status().is_success() {
        let cookie = crate::auth::csrf::cookie(&crate::auth::csrf::Token::mint());
        if let Ok(value) = HeaderValue::from_str(&cookie.to_string()) {
            response.headers_mut().append(header::SET_COOKIE, value);
        }
    }
    response
}

/// Serves `/apps/{name}/{path}`.
async fn serve(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path((name, path)): Path<(String, String)>,
) -> Response {
    if let Some(apps_url) = state.config.apps_url.as_ref() {
        if !is_origin(&headers, apps_url) {
            return to_apps_origin(apps_url, &uri);
        }
    }

    // Every refusal below is the same 404. A draft app, a retired app, a name that was never
    // created and a caller who may not see it are indistinguishable from outside, so the host
    // never discloses what is being worked on (AP-18).
    let not_found = || ApiError::NotFound(format!("app '{name}' not found")).into_response();

    let Some((project, spec, build)) = published_app(&state, &name) else {
        return not_found();
    };
    // The person as this App's own client knows them (ADR-N-030, AP-92).
    let person = super::roles::person(&state, &headers, &spec, &name).await;
    if !super::roles::may_open(&spec, person.as_ref()) {
        if spec.visibility != AppVisibility::Roles {
            return not_found();
        }
        // A published app with roles says who grants them instead of pretending it is not there,
        // and names none of its members (AP-93).
        let title = state
            .mirror
            .get(&project, "App", &name)
            .and_then(|env| env.metadata.title);
        return super::roles::refusal(
            &spec,
            &name,
            title.as_ref(),
            &project,
            &headers,
            portal_origin(&state).as_deref(),
        );
    }
    let Some(app_root) = app_root(
        state.config.apps_dir.as_deref().map(FsPath::new),
        state.config.apps_cache_dir.as_deref().map(FsPath::new),
        &name,
        build.as_ref(),
    ) else {
        return not_found();
    };
    let Some(file) = resolve(&app_root, &path) else {
        return not_found();
    };
    let Ok(bytes) = std::fs::read(&file) else {
        return not_found();
    };

    let Some(expected) = integrity_of(&app_root, &path) else {
        // No recorded digest means the file is not part of the published bundle, even if it
        // sits in the directory.
        return not_found();
    };
    if expected != sri_sha384(&bytes) {
        // A bundle that no longer matches what CI signed is never served under a published
        // app's name; the operator gets the log line, the caller gets a plain refusal.
        tracing::error!(app = %name, path = %path, "app asset fails its recorded integrity digest");
        return ApiError::Unavailable("the app bundle failed its integrity check".into())
            .into_response();
    }

    // The index is the one file that is not served as built: the SDK starts from the
    // `#jc-config` the host writes into it (SDK-02), after the digest was checked on the bytes
    // CI recorded (AP-12). An app that reads nothing is served as it was built.
    // It carries the person and their roles in this app, computed now, so no shared cache keeps
    // it and nobody else is served it (AP-95).
    let personal = path == "index.html" && person.is_some();
    let bytes = if path == "index.html" {
        let domain = crate::api::assistant::org_domain(&state, &project);
        match served_config(&state.mirror, &project, &name, &spec, &domain) {
            Some(mut config) => match String::from_utf8(bytes) {
                Ok(html) => {
                    config["user"] = super::roles::app_user(person.as_ref());
                    with_config(&html, &config).into_bytes()
                }
                Err(raw) => raw.into_bytes(),
            },
            None => bytes,
        }
    } else {
        bytes
    };

    let mime = mime_guess::from_path(&path).first_or_octet_stream();
    let mut response = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime.as_ref())
        // The bundle is immutable per publish, but a republish reuses the path, so assets are
        // revalidated rather than pinned for a year.
        .header(
            header::CACHE_CONTROL,
            if personal {
                "private, no-store"
            } else {
                "no-cache"
            },
        )
        .body(Body::from(bytes))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());

    // No `X-Frame-Options`: its `SAMEORIGIN` would refuse the Portal, whose host is not the apps
    // origin, and `frame-ancestors` says who may frame the App (AP-122).
    if let Ok(csp) = HeaderValue::from_str(&content_security_policy(
        &spec,
        portal_origin(&state).as_deref(),
    )) {
        response
            .headers_mut()
            .insert(header::CONTENT_SECURITY_POLICY, csp);
    }
    response
}

/// The Portal's own origin, the one host that frames every App under its header (AP-122), when
/// Apps live on an origin of their own. Without one an App is served on the Portal's origin, and
/// a framed App would reach into the Portal's page with the viewer's session (T-2476): `None`.
pub(super) fn portal_origin(state: &AppState) -> Option<String> {
    let portal = state.config.public_base_url.origin();
    state
        .config
        .apps_url
        .as_ref()
        .filter(|apps| apps.origin() != portal)
        .map(|_| portal.ascii_serialization())
}

/// Whether the request's `Host` names the apps origin: same host, ignoring case, and the same
/// port, the scheme's default when none is written. A request without a `Host` is not on it.
pub(super) fn is_origin(headers: &HeaderMap, origin: &url::Url) -> bool {
    let Some(authority) = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<axum::http::uri::Authority>().ok())
    else {
        return false;
    };
    origin
        .host_str()
        .is_some_and(|host| authority.host().eq_ignore_ascii_case(host))
        && authority.port_u16().or(origin.port_or_known_default()) == origin.port_or_known_default()
}

/// An app asked for anywhere but its own origin, above all on the Portal's (T-2476): a `308`
/// to the same path and query there, so every link keeps working and no byte of the bundle is
/// ever served where it could reach the Portal API with the viewer's session. The target is
/// the configured origin, never the request's `Host`, so this is no open redirect.
pub(super) fn to_apps_origin(origin: &url::Url, uri: &Uri) -> Response {
    let target = uri
        .path_and_query()
        .map_or("/", axum::http::uri::PathAndQuery::as_str);
    let location = format!("{}{target}", origin.as_str().trim_end_matches('/'));
    match HeaderValue::from_str(&location) {
        Ok(location) => (
            StatusCode::PERMANENT_REDIRECT,
            [(header::LOCATION, location)],
        )
            .into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

/// The published App manifest of this name, whatever project owns it. App names are
/// DNS-1123 labels and the app URL has no project segment (AP-14), so the name is what
/// identifies it here.
pub(super) fn published_app(
    state: &AppState,
    name: &str,
) -> Option<(String, AppSpec, Option<jc_core::Build>)> {
    if !crate::resource::is_dns1123(name) {
        return None;
    }
    let envelope = state
        .mirror
        .find(|env| env.kind == "App" && env.metadata.name == name)?;
    let build = envelope.status.as_ref().and_then(|s| s.build.clone());
    let project = envelope.metadata.namespace.clone()?;
    let spec: AppSpec = serde_json::from_value(envelope.spec).ok()?;
    (spec.lifecycle == AppLifecycle::Published).then_some((project, spec, build))
}

/// The configuration a static app starts from (SDK-02), `None` when it reads no endpoint.
///
/// A static app has no pod (AP-14). Its endpoints are, for each context space its `dataNeeds`
/// name, the App's own generated `app-{name}` when its grants are committed, or else every
/// Endpoint of the project on that space; then every Endpoint the project's
/// `SharedSpaceReference`s point at (EP-15). The first is the
/// primary. Slugs and spaces only, never a token: the reader's own session is what reaches each
/// endpoint, and the gateway's Policy decides what it may read (AP-07).
pub(super) fn served_config(
    mirror: &crate::store::Mirror,
    project: &str,
    name: &str,
    spec: &AppSpec,
    org_domain: &str,
) -> Option<serde_json::Value> {
    let unique = served_endpoints(mirror, project, name, spec);
    let Some(primary) = unique.first().cloned() else {
        if !spec.data_needs.is_empty() {
            // The page renders the SDK's configuration error; this is the line that says why.
            tracing::warn!(app = %name, project = %project, "static app reads no endpoint the platform holds");
        }
        return None;
    };
    let needs = serde_json::to_value(&spec.data_needs).unwrap_or_default();
    Some(serde_json::json!({
        "slug": primary.slug,
        "orgDomain": org_domain,
        "space": primary.space,
        "transport": "origin",
        "appName": name,
        "endpointName": primary.name,
        "endpoints": crate::agents::endpoints::config(&unique, &needs),
    }))
}

/// The endpoints an App reads, in the order [`served_config`] offers them, the primary first:
/// also the audiences its Keycloak client puts in a token, so the gateway admits that token on
/// each of them and nowhere else (AP-113).
pub(crate) fn served_endpoints(
    mirror: &crate::store::Mirror,
    project: &str,
    name: &str,
    spec: &AppSpec,
) -> Vec<crate::agents::endpoints::RunEndpoint> {
    use crate::agents::endpoints::{RunEndpoint, MAX_ENDPOINTS};
    use crate::api::assistant::ref_name;

    let of = |env: &crate::resource::ResourceEnvelope| {
        let slug = env.spec.get("slug").and_then(serde_json::Value::as_str)?;
        (!slug.is_empty()).then(|| RunEndpoint {
            name: env.metadata.name.clone(),
            slug: slug.to_owned(),
            space: ref_name(&env.spec["contextSpaceRef"]).unwrap_or_default(),
        })
    };
    let sorted = |mut envs: Vec<crate::resource::ResourceEnvelope>| {
        envs.sort_by(|a, b| a.metadata.name.cmp(&b.metadata.name));
        envs
    };
    let in_project = |env: &crate::resource::ResourceEnvelope, kind: &str| {
        env.kind == kind && env.metadata.namespace.as_deref() == Some(project)
    };

    // The App's own endpoint, once its grants are committed (T-2632): the one it reads through
    // (AP-04). Every other endpoint of that space is left out; offering them made the SDK refuse a
    // type several of them serve, so the app read nothing (T-2667).
    let own = mirror
        .get(project, "Endpoint", &format!("app-{name}"))
        .filter(|env| {
            env.metadata
                .annotations
                .get(jc_core::annotations::GENERATED_BY)
                .map(String::as_str)
                == Some(crate::apps::reconciler::GENERATOR)
        });
    let mut found: Vec<RunEndpoint> = Vec::new();
    for need in &spec.data_needs {
        let space = need.context_space_ref.name();
        if let Some(endpoint) = own
            .as_ref()
            .filter(|env| ref_name(&env.spec["contextSpaceRef"]).as_deref() == Some(space))
            .and_then(of)
        {
            found.push(endpoint);
            continue;
        }
        let serving = mirror.matching(|env| {
            in_project(env, "Endpoint")
                && ref_name(&env.spec["contextSpaceRef"]).as_deref() == Some(space)
        });
        found.extend(sorted(serving).iter().filter_map(of));
    }
    for reference in sorted(mirror.matching(|env| in_project(env, "SharedSpaceReference"))) {
        let target = &reference.spec["endpointRef"];
        let (Some(source), Some(endpoint)) = (target["project"].as_str(), target["name"].as_str())
        else {
            continue;
        };
        found.extend(
            mirror
                .get(source, "Endpoint", endpoint)
                .as_ref()
                .and_then(of),
        );
    }

    let mut unique: Vec<RunEndpoint> = Vec::new();
    for endpoint in found {
        if !unique.iter().any(|seen| seen.slug == endpoint.slug) {
            unique.push(endpoint);
        }
    }
    if unique.len() > MAX_ENDPOINTS {
        // ponytail: the first five by space order; an app that needs more is a manifest to split.
        tracing::warn!(app = %name, count = unique.len(), "static app resolves more endpoints than one app may read");
        unique.truncate(MAX_ENDPOINTS);
    }
    unique
}

/// The index with its `#jc-config` element, first thing in the head so it is the one
/// `getElementById` finds even if a bundle ships a stale one of its own.
fn with_config(html: &str, config: &serde_json::Value) -> String {
    let element = format!(
        "<script id=\"jc-config\" type=\"application/json\">{}</script>",
        crate::agents::preview::script_json(config)
    );
    // The template's index carries the empty element for the Portal to fill (SDK-06); the filled
    // one goes first in the head and the empty one goes, so the page holds one `#jc-config`.
    let html = html.replacen(
        "<script id=\"jc-config\" type=\"application/json\"></script>",
        "",
        1,
    );
    let lower = html.to_ascii_lowercase();
    let at = lower
        .find("<head>")
        .map(|at| at + "<head>".len())
        .or_else(|| lower.find("</head>"))
        .unwrap_or(0);
    format!("{}{element}{}", &html[..at], &html[at..])
}

/// The directory one app is served from (AP-72, AP-102).
///
/// `status.build` names the build the manifest deploys, fetched into
/// `{apps_cache_dir}/{name}/{hex}/` ([`crate::apps::fetch`]). An app that names no build, or
/// names one this host does not hold yet, keeps serving `{apps_dir}/{name}/`, the bundle the
/// image ships, and [`build_missing`] is what says so on the App itself.
pub(super) fn app_root(
    shipped: Option<&FsPath>,
    cache: Option<&FsPath>,
    name: &str,
    build: Option<&jc_core::Build>,
) -> Option<PathBuf> {
    let held = cache
        .zip(build)
        .and_then(|(cache, build)| crate::apps::fetch::build_dir(cache, name, &build.digest))
        .and_then(|dir| dir.canonicalize().ok())
        .filter(|dir| dir.is_dir());
    held.or_else(|| shipped?.join(name).canonicalize().ok())
}

/// Whether this Portal's image ships the bundle of the app `name`: `{apps_dir}/{name}/index.html`
/// (AP-87). Only a DNS-1123 name is looked up, so a name never walks out of the directory.
pub fn ships_bundle(apps_dir: Option<&str>, name: &str) -> bool {
    crate::resource::is_dns1123(name)
        && apps_dir.is_some_and(|root| FsPath::new(root).join(name).join("index.html").is_file())
}

/// The refusal of an `App` that says the Portal ships its bundle when this Portal holds none
/// (AP-87): the annotation is what lets a published static App name no repository, so it is
/// believed only where the bundle is. Names the App being written and nothing else (PF-59).
pub fn unshipped_claim(
    apps_dir: Option<&str>,
    envelope: &crate::resource::ResourceEnvelope,
) -> Option<String> {
    use jc_core::kinds::app::SHIPPED_WITH_ANNOTATION;
    let name = &envelope.metadata.name;
    (envelope.kind == "App"
        && envelope
            .metadata
            .annotations
            .contains_key(SHIPPED_WITH_ANNOTATION)
        && !ships_bundle(apps_dir, name))
    .then(|| {
        format!(
            "annotation '{SHIPPED_WITH_ANNOTATION}' marks an application whose bundle the Portal \
             image ships, and this Portal ships none for '{name}': remove the annotation and \
             publish the App from its own repository with spec.source.git (AP-87)"
        )
    })
}

/// Every published app whose `status.build` names a build this host does not hold (AP-72).
///
/// The host keeps serving what it has; this is the list the reconciler turns into a red `Ready`
/// condition, so an operator sees a build that never arrived instead of a stale app that looks
/// healthy.
pub fn build_missing(apps_cache_dir: Option<&str>, mirror: &crate::store::Mirror) -> Vec<String> {
    let Some(cache) = apps_cache_dir.map(FsPath::new) else {
        return Vec::new();
    };
    let mut missing: Vec<String> = mirror
        .matching(|env| env.kind == "App")
        .into_iter()
        .filter(|env| {
            let Some(build) = env.status.as_ref().and_then(|s| s.build.as_ref()) else {
                return false;
            };
            !crate::apps::fetch::build_dir(cache, &env.metadata.name, &build.digest)
                .is_some_and(|dir| dir.is_dir())
        })
        .map(|env| env.metadata.name)
        .collect();
    missing.sort();
    missing
}

/// The app's Content Security Policy (AP-12). `default-src` and `connect-src` stay on `'self'`
/// plus whatever the manifest adds; `frame-ancestors` is the Portal's origin, which opens every
/// App under its header (AP-122), plus the declared origins of an embeddable app. With no Portal
/// origin to name (see `portal_origin`) it is `'none'`, or `'self'` for an embeddable app.
pub fn content_security_policy(spec: &AppSpec, portal_origin: Option<&str>) -> String {
    let csp = spec.csp.as_ref();
    let mut connect = vec!["'self'".to_string()];
    if let Some(csp) = csp {
        connect.extend(csp.connect_src.iter().filter(|s| *s != "self").map(quoted));
    }

    let mut frame_ancestors: Vec<String> = portal_origin.map(str::to_owned).into_iter().collect();
    if spec.embeddable {
        if let Some(csp) = csp {
            frame_ancestors.extend(
                csp.frame_ancestors
                    .iter()
                    // `'none'` beside an origin would still admit the origin; the Portal's
                    // frame stays, whatever the manifest says.
                    .filter(|s| *s != "none" && Some(s.as_str()) != portal_origin)
                    .map(quoted),
            );
        }
    }
    let frame_ancestors = match (frame_ancestors.is_empty(), spec.embeddable) {
        (false, _) => frame_ancestors.join(" "),
        (true, true) => "'self'".to_owned(),
        (true, false) => "'none'".to_owned(),
    };

    format!(
        "default-src 'self'; base-uri 'self'; object-src 'none'; script-src 'self'; \
         style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; \
         form-action 'self'; connect-src {}; frame-ancestors {frame_ancestors}",
        connect.join(" ")
    )
}

/// CSP keywords are quoted, origins are not.
fn quoted(source: &String) -> String {
    match source.as_str() {
        "self" | "none" => format!("'{source}'"),
        other => other.to_string(),
    }
}

/// Resolves a bundle-relative path inside one app's directory, or `None` if it would leave it.
/// `canonicalize` is what decides: it resolves `..` and every symlink, so a link pointing out of
/// the root is caught as surely as a literal traversal.
pub(super) fn resolve(app_root: &FsPath, path: &str) -> Option<PathBuf> {
    if path.is_empty() || path.ends_with('/') {
        return None;
    }
    let file = app_root.join(path).canonicalize().ok()?;
    (file.starts_with(app_root) && file.is_file()).then_some(file)
}

/// The digest the build lane recorded for this file, if any.
pub(super) fn integrity_of(app_root: &FsPath, path: &str) -> Option<String> {
    let manifest = resolve(app_root, INTEGRITY_MANIFEST)?;
    let digests: std::collections::BTreeMap<String, String> =
        serde_json::from_slice(&std::fs::read(manifest).ok()?).ok()?;
    digests.get(path).cloned()
}

/// The Subresource Integrity form of a file's digest, `sha384-<base64>` (AP-12).
pub fn sri_sha384(bytes: &[u8]) -> String {
    format!(
        "sha384-{}",
        base64::engine::general_purpose::STANDARD.encode(Sha384::digest(bytes))
    )
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/apps/{name}/", get(serve_index))
        .route(
            "/apps/{name}/api/functions/{fn}",
            axum::routing::post(super::functions::call).layer(
                axum::extract::DefaultBodyLimit::max(super::functions::MAX_BODY_BYTES),
            ),
        )
        .route("/apps/{name}/{*path}", get(serve))
}

#[cfg(test)]
mod tests {
    use super::*;
    use jc_core::kinds::ContentSecurityPolicy;

    fn spec() -> AppSpec {
        serde_json::from_value(serde_json::json!({
            "kind": "static",
            "source": { "path": "." },
            "build": { "node": "22" },
            "visibility": "public",
            "lifecycle": "published",
            "dataNeeds": []
        }))
        .expect("a minimal static app")
    }

    const PORTAL: &str = "https://portal.example.sk";

    #[test]
    fn a_plain_app_is_framed_by_the_portal_alone_and_talks_only_to_the_platform() {
        let csp = content_security_policy(&spec(), Some(PORTAL));
        assert!(
            csp.ends_with("frame-ancestors https://portal.example.sk"),
            "{csp}"
        );
        assert!(csp.contains("connect-src 'self';"), "{csp}");
        assert!(
            !csp.contains('*'),
            "a wildcard never reaches the header: {csp}"
        );
    }

    #[test]
    fn an_embeddable_app_adds_only_its_declared_frame_ancestors() {
        let mut spec = spec();
        spec.embeddable = true;
        spec.csp = Some(ContentSecurityPolicy {
            connect_src: vec!["self".into()],
            frame_ancestors: vec![
                "https://city.example.sk".into(),
                "none".into(),
                PORTAL.into(),
            ],
        });
        let csp = content_security_policy(&spec, Some(PORTAL));
        assert!(
            csp.ends_with("frame-ancestors https://portal.example.sk https://city.example.sk"),
            "{csp}"
        );
        assert!(csp.contains("connect-src 'self';"), "{csp}");
    }

    #[test]
    fn a_declared_frame_ancestor_is_ignored_while_the_app_is_not_embeddable() {
        // spec.embeddable is the switch (AP-12); a frameAncestors list alone must not open it.
        let mut spec = spec();
        spec.csp = Some(ContentSecurityPolicy {
            connect_src: Vec::new(),
            frame_ancestors: vec!["https://elsewhere.example".into()],
        });
        assert!(content_security_policy(&spec, Some(PORTAL))
            .ends_with("frame-ancestors https://portal.example.sk"));
    }

    #[test]
    fn without_an_apps_origin_of_its_own_nothing_but_an_embedder_frames_an_app() {
        // The App would share the Portal's origin, so the Portal never frames it (T-2476).
        assert!(content_security_policy(&spec(), None).ends_with("frame-ancestors 'none'"));
        let mut spec = spec();
        spec.embeddable = true;
        assert!(content_security_policy(&spec, None).ends_with("frame-ancestors 'self'"));
        spec.csp = Some(ContentSecurityPolicy {
            connect_src: Vec::new(),
            frame_ancestors: vec!["https://city.example.sk".into()],
        });
        assert!(content_security_policy(&spec, None)
            .ends_with("frame-ancestors https://city.example.sk"));
    }

    #[test]
    fn the_digest_is_the_subresource_integrity_form() {
        // sha384 of the empty input, the value a browser would compute for an empty asset.
        assert_eq!(
            sri_sha384(b""),
            "sha384-OLBgp1GsljhM2TJ+sbHjaiH9txEUvgdDTAzHv2P24donTt6/529l+9Ua0vFImLlb"
        );
    }

    #[test]
    fn the_configuration_opens_the_head_and_cannot_close_its_element() {
        let config = serde_json::json!({ "appName": "</script><script>alert(1)</script>" });
        let html = with_config(
            "<!doctype html><HTML><Head><title>x</title></head></html>",
            &config,
        );
        assert!(
            html.starts_with("<!doctype html><HTML><Head><script id=\"jc-config\""),
            "{html}"
        );
        assert_eq!(html.matches("</script>").count(), 1, "{html}");

        // A document with no head at all still gets it, before anything else.
        let bare = with_config("<p>x</p>", &config);
        assert!(bare.starts_with("<script id=\"jc-config\""), "{bare}");
    }

    /// SDK-06: the template's index carries the empty element the Portal fills; the served page
    /// holds one `#jc-config`, the filled one, and never a second the app might read instead.
    #[test]
    fn the_templates_empty_configuration_is_replaced_not_doubled() {
        let config = serde_json::json!({ "appName": "alerts" });
        let html = with_config(
            "<html><head><title>x</title>\n    <script id=\"jc-config\" type=\"application/json\"></script>\n</head><body></body></html>",
            &config,
        );
        assert_eq!(html.matches("id=\"jc-config\"").count(), 1, "{html}");
        assert!(html.contains("{\"appName\":\"alerts\"}</script>"), "{html}");
    }

    #[test]
    fn a_path_leaving_the_app_root_does_not_resolve() {
        let dir = std::env::temp_dir().join(format!("jc-apps-{}", std::process::id()));
        let app = dir.join("demo");
        std::fs::create_dir_all(&app).expect("app dir");
        std::fs::write(dir.join("secret.txt"), b"not yours").expect("neighbour file");
        std::fs::write(app.join("index.html"), b"<!doctype html>").expect("index");

        let root = app_root(Some(&dir), None, "demo", None).expect("the app directory");
        assert!(resolve(&root, "index.html").is_some());
        assert!(resolve(&root, "../secret.txt").is_none());
        assert!(resolve(&root, "/etc/passwd").is_none());
        assert!(resolve(&root, "").is_none(), "a directory is not a file");
        std::fs::remove_dir_all(&dir).ok();
    }
}
