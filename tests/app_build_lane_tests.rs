//! `status.build` has one writer: the build lane, the role whose `propose` on `App` is
//! constrained to that field (AP-13a, AP-73). Everything else about `status` is the platform's
//! own computation and no manifest carries it (MF-04). And what the lane writes is checked: the
//! commit is its repository's head, the bundle an artifact of a run of it hashing to the digest,
//! and the Portal publishes the package itself before the build is written (AP-101, AP-104).

mod common;

use axum::http::StatusCode;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use wiremock::matchers::{method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

use common::{checked_send as send, envelope, forge, person};
use joinedcontext_portal::permissions::ORG_NAMESPACE;
use joinedcontext_portal::resource::API_VERSION;
use joinedcontext_portal::state::AppState;

const APPS: &str = "/api/v1/projects/ovzdusie/apps";

/// `builder@hel.fi` is the build lane: propose on App, constrained to `status.build`.
/// `jana@hel.fi` proposes Apps like anybody else.
fn state_with(gitea: &MockServer) -> AppState {
    let state = common::state_on(gitea);
    state.mirror.upsert(envelope(
        "Role",
        "app-builder",
        ORG_NAMESPACE,
        json!({ "rules": [{
            "kinds": ["App"],
            "verbs": ["propose"],
            "constraints": [{ "field": "status.build" }],
        }]}),
    ));
    state.mirror.upsert(envelope(
        "Role",
        "app-editor",
        ORG_NAMESPACE,
        // ContextSpace too, so the refusal of a build on another kind is the content check
        // and not the verb check that runs before the manifest is read (T-2576).
        json!({ "rules": [{ "kinds": ["App", "ContextSpace"], "verbs": ["propose"] }] }),
    ));
    // The space the app's `dataNeeds` names: a manifest naming a resource that is not in the
    // project is refused before the lane is judged at all (MF-13, T-2268), and this project really
    // does hold it.
    state.mirror.upsert(envelope(
        "ContextSpace",
        "ovzdusie",
        "ovzdusie",
        json!({ "dataModelRef": "air" }),
    ));
    for (who, role) in [("builder", "app-builder"), ("jana", "app-editor")] {
        state.mirror.upsert(envelope(
            "RoleBinding",
            &format!("{who}-{role}"),
            ORG_NAMESPACE,
            json!({
                "subjects": [{ "user": format!("{who}@hel.fi") }],
                "role": role,
                "scope": { "project": "ovzdusie" },
            }),
        ));
    }
    state
}

fn app(status: Option<Value>, annotation: Option<&str>) -> Value {
    let mut metadata = json!({ "name": "air-quality", "namespace": "ovzdusie" });
    if let Some(key) = annotation {
        metadata["annotations"] = json!({ key: "sha256:deadbeef" });
    }
    let mut manifest = json!({
        "apiVersion": API_VERSION,
        "kind": "App",
        "metadata": metadata,
        "spec": {
            "kind": "static",
            // A published static App names its repository (AP-87).
            "source": { "git": {
                "url": "https://git.example/joinedcontext/ovzdusie_air-quality.git",
                "ref": COMMIT,
            }},
            "build": { "node": "22" },
            "visibility": "public",
            "lifecycle": "published",
            "dataNeeds": [{
                "contextSpaceRef": { "kind": "ContextSpace", "name": "ovzdusie" },
                "types": ["AirQualityObserved"],
                "operations": ["queryEntity"],
            }],
        },
    });
    if let Some(status) = status {
        manifest["status"] = status;
    }
    manifest
}

/// The App's own repository, `{project}_{app}` (AP-75), and the head of its default branch.
const APP_REPO: &str = "/api/v1/repos/test-owner/ovzdusie_air-quality";
const COMMIT: &str = "8c56954a1f0e3d2c1b0a99887766554433221100";
const PACKAGE: &str = "/api/packages/test-owner/generic/app-air-quality";
const BUNDLE: &[u8] = b"the bundle the workflow built";
const SBOM: &[u8] = b"{\"bomFormat\":\"CycloneDX\"}";

fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

/// The forge after a run of `COMMIT` uploaded `bundle` and the SBOM as run 5's artifacts, and
/// with the default branch at `head`. The artifact download redirects to the forge's public
/// ROOT_URL, which the Portal cannot reach, as Gitea does.
async fn built_on_forge(gitea: &MockServer, head: &str, bundle: &[u8], size: Option<u64>) {
    built_on_forge_as(gitea, head, "bundle", bundle, size).await;
}

/// The forge after a run uploaded `built` as the artifact `{artifact}-{COMMIT}`, as above.
async fn built_on_forge_as(
    gitea: &MockServer,
    head: &str,
    artifact: &str,
    bundle: &[u8],
    size: Option<u64>,
) {
    Mock::given(method("GET"))
        .and(path(APP_REPO))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "default_branch": "main" })))
        .mount(gitea)
        .await;
    Mock::given(method("GET"))
        .and(path(format!("{APP_REPO}/branches/main")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "commit": { "id": head } })))
        .mount(gitea)
        .await;
    // Any other name: none, as the forge answers.
    Mock::given(method("GET"))
        .and(path(format!("{APP_REPO}/actions/artifacts")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "artifacts": [] })))
        .with_priority(10)
        .mount(gitea)
        .await;
    for (id, name, bytes) in [(11, artifact, bundle), (12, "sbom", SBOM)] {
        let artifact = |id: u64, run: u64, sha: &str| {
            json!({
                "id": id, "name": format!("{name}-{COMMIT}"),
                "size_in_bytes": if name == artifact { size.unwrap_or(bytes.len() as u64) } else { bytes.len() as u64 },
                "workflow_run": { "id": run, "head_sha": sha },
            })
        };
        Mock::given(method("GET"))
            .and(path(format!("{APP_REPO}/actions/artifacts")))
            .and(query_param("name", format!("{name}-{COMMIT}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                // An artifact of this name from a run of another commit never counts.
                "artifacts": [artifact(id, 5, COMMIT), artifact(id + 90, 9, "0000000000000000000000000000000000000000")],
            })))
            .mount(gitea)
            .await;
        Mock::given(method("GET"))
            .and(path(format!("{APP_REPO}/actions/artifacts/{id}/zip")))
            .respond_with(ResponseTemplate::new(302).insert_header(
                "Location",
                format!("https://forge.public.example{APP_REPO}/actions/artifacts/{id}/zip/raw?sig=s{id}&expires=9"),
            ))
            .mount(gitea)
            .await;
        Mock::given(method("GET"))
            .and(path(format!("{APP_REPO}/actions/artifacts/{id}/zip/raw")))
            .and(query_param("sig", format!("s{id}")))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(bytes.to_vec()))
            .mount(gitea)
            .await;
    }
}

/// The package files the Portal wrote, in order.
async fn published(gitea: &MockServer) -> Vec<String> {
    gitea
        .received_requests()
        .await
        .unwrap_or_default()
        .iter()
        .filter(|r| r.method.as_str() == "PUT" && r.url.path().starts_with(PACKAGE))
        .map(|r| r.url.path().trim_start_matches(PACKAGE).to_owned())
        .collect()
}

async fn package_takes(gitea: &MockServer, status: u16) {
    Mock::given(method("PUT"))
        .and(wiremock::matchers::path_regex(format!("^{PACKAGE}/.*")))
        .respond_with(ResponseTemplate::new(status))
        .mount(gitea)
        .await;
}

fn build() -> Value {
    json!({ "build": {
        "digest": digest(BUNDLE),
        "commit": COMMIT,
        "sdkVersion": "0.4.1",
        "builtAt": "2026-09-17T06:00:00Z",
    }})
}

fn build_of(commit: &str) -> Value {
    let mut build = build();
    build["build"]["commit"] = json!(commit);
    build
}

/// What the merge request wrote, decoded.
async fn committed(gitea: &MockServer) -> Vec<String> {
    use base64::Engine;
    gitea
        .received_requests()
        .await
        .unwrap_or_default()
        .iter()
        .filter(|r| r.method.as_str() == "PUT" && r.url.path().contains("/contents/"))
        .filter_map(|r| {
            let body: Value = serde_json::from_slice(&r.body).ok()?;
            let encoded = body.get("content")?.as_str()?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .ok()?;
            String::from_utf8(bytes).ok()
        })
        .collect()
}

#[tokio::test]
async fn only_the_build_lane_writes_the_build_and_the_refusal_says_whose_field_it_is() {
    let gitea = forge().await;
    built_on_forge(&gitea, COMMIT, BUNDLE, None).await;
    package_takes(&gitea, 201).await;
    let state = state_with(&gitea);

    let refused = send(
        &state,
        person("jana"),
        "POST",
        APPS,
        Some(app(Some(build()), None)),
    )
    .await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN, "{}", refused.text);
    assert!(refused.text.contains("build lane"), "{}", refused.text);
    assert!(
        committed(&gitea).await.is_empty(),
        "nothing was written for a refused proposal"
    );

    let accepted = send(
        &state,
        person("builder"),
        "POST",
        APPS,
        Some(app(Some(build()), None)),
    )
    .await;
    assert_eq!(accepted.status, StatusCode::ACCEPTED, "{}", accepted.text);
    let written = committed(&gitea).await;
    assert!(
        written.iter().any(|file| file.contains("status:")
            && file.contains("digest:")
            && file.contains(COMMIT)),
        "the build the lane wrote is what lands in the repository: {written:?}"
    );
    assert_eq!(
        published(&gitea).await,
        vec![
            format!("/{COMMIT}/bundle.tar.gz"),
            format!("/{COMMIT}/sbom.cdx.json")
        ],
        "the Portal publishes the package itself (AP-101)"
    );
    let raw: Vec<_> = gitea
        .received_requests()
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|r| r.url.path().ends_with("/zip/raw"))
        .collect();
    assert_eq!(
        raw.len(),
        2,
        "both artifacts are fetched from the forge the Portal dials"
    );
    assert!(
        raw.iter().all(|r| !r.headers.contains_key("authorization")),
        "the signed address is the grant; the Portal's token never follows the redirect"
    );
}

/// AP-104: a build whose commit is not the head, whose bundle no run of it uploaded, or whose
/// bytes hash to another digest is refused, naming the check; nothing is published or written.
#[tokio::test]
async fn a_build_the_workflow_did_not_make_is_refused_and_nothing_is_published() {
    let other = "1111111111111111111111111111111111111111";
    let cases = [
        (
            "an older commit",
            other,
            BUNDLE,
            None,
            build(),
            StatusCode::CONFLICT,
            "the head of main",
        ),
        (
            "a commit no run built",
            other,
            BUNDLE,
            None,
            build_of(other),
            StatusCode::BAD_REQUEST,
            "holds no artifact bundle-1111",
        ),
        (
            "another digest",
            COMMIT,
            b"a bundle somebody else made".as_slice(),
            None,
            build(),
            StatusCode::BAD_REQUEST,
            "hashes to",
        ),
        (
            "a bundle too large",
            COMMIT,
            BUNDLE,
            Some(65 * 1024 * 1024),
            build(),
            StatusCode::BAD_REQUEST,
            "more than",
        ),
    ];
    for (what, head, bundle, size, status, code, says) in cases {
        let gitea = forge().await;
        built_on_forge(&gitea, head, bundle, size).await;
        package_takes(&gitea, 201).await;
        let state = state_with(&gitea);

        let refused = send(
            &state,
            person("builder"),
            "POST",
            APPS,
            Some(app(Some(status), None)),
        )
        .await;
        assert_eq!(refused.status, code, "{what}: {}", refused.text);
        assert!(refused.text.contains(says), "{what}: {}", refused.text);
        assert!(
            published(&gitea).await.is_empty(),
            "{what}: a package was published"
        );
        assert!(
            committed(&gitea).await.is_empty(),
            "{what}: the build was written"
        );
    }
}

/// AP-101: the registry never replaces a file. The same bytes already there are the same build
/// published again; other bytes under the same version are refused.
#[tokio::test]
async fn a_version_already_published_is_the_same_build_or_a_refusal() {
    for (held, accepted) in [(BUNDLE, true), (b"other bytes".as_slice(), false)] {
        let gitea = forge().await;
        built_on_forge(&gitea, COMMIT, BUNDLE, None).await;
        package_takes(&gitea, 409).await;
        Mock::given(method("GET"))
            .and(path(format!("{PACKAGE}/{COMMIT}/bundle.tar.gz")))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(held.to_vec()))
            .mount(&gitea)
            .await;
        Mock::given(method("GET"))
            .and(path(format!("{PACKAGE}/{COMMIT}/sbom.cdx.json")))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(SBOM.to_vec()))
            .mount(&gitea)
            .await;
        let state = state_with(&gitea);

        let answer = send(
            &state,
            person("builder"),
            "POST",
            APPS,
            Some(app(Some(build()), None)),
        )
        .await;
        if accepted {
            assert_eq!(answer.status, StatusCode::ACCEPTED, "{}", answer.text);
        } else {
            assert_eq!(answer.status, StatusCode::CONFLICT, "{}", answer.text);
            assert!(
                answer
                    .text
                    .contains("already holds a different bundle.tar.gz"),
                "{}",
                answer.text
            );
            assert!(committed(&gitea).await.is_empty());
        }
    }
}

#[tokio::test]
async fn every_other_part_of_status_is_refused_even_from_the_build_lane() {
    let gitea = forge().await;
    let state = state_with(&gitea);

    for status in [
        json!({ "phase": "Live" }),
        json!({ "build": null }),
        json!({ "phase": "Live", "build": build()["build"] }),
    ] {
        let refused = send(
            &state,
            person("builder"),
            "POST",
            APPS,
            Some(app(Some(status.clone()), None)),
        )
        .await;
        assert_eq!(
            refused.status,
            StatusCode::BAD_REQUEST,
            "{status}: {}",
            refused.text
        );
        assert!(refused.text.contains("MF-04"), "{}", refused.text);
    }
}

/// AP-13a: a digest in an annotation is a digest somebody typed, whoever they are.
#[tokio::test]
async fn an_image_annotation_is_refused_from_the_build_lane_too() {
    let gitea = forge().await;
    let state = state_with(&gitea);

    for key in ["joinedcontext.com/image", "joinedcontext.com/module"] {
        let refused = send(
            &state,
            person("builder"),
            "POST",
            APPS,
            Some(app(Some(build()), Some(key))),
        )
        .await;
        assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.text);
        assert!(refused.text.contains(key), "{}", refused.text);
    }
}

/// A `status.build` on any other kind is the platform's computation, whoever asks: even a
/// person who may propose that kind is refused on the content.
#[tokio::test]
async fn a_build_on_another_kind_is_refused() {
    let gitea = forge().await;
    let state = state_with(&gitea);

    let refused = send(
        &state,
        person("jana"),
        "POST",
        "/api/v1/projects/ovzdusie/spaces",
        Some(json!({
            "apiVersion": API_VERSION,
            "kind": "ContextSpace",
            "metadata": { "name": "mhd", "namespace": "ovzdusie" },
            "spec": { "isSandbox": false },
            "status": build(),
        })),
    )
    .await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.text);
}

/// The OCI layout `lane.mjs image` writes, as a tar, and its manifest digest.
fn image_layout() -> (Vec<u8>, String, Vec<u8>) {
    let config = br#"{"architecture":"amd64","os":"linux"}"#.to_vec();
    let layer = b"the layer holding /app".to_vec();
    let manifest = serde_json::to_vec(&json!({
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.manifest.v1+json",
        "config": { "mediaType": "application/vnd.oci.image.config.v1+json", "digest": digest(&config), "size": config.len() },
        "layers": [{ "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip", "digest": digest(&layer), "size": layer.len() }],
    }))
    .expect("json");
    let image = digest(&manifest);
    let index = serde_json::to_vec(&json!({
        "schemaVersion": 2,
        "manifests": [{ "mediaType": "application/vnd.oci.image.manifest.v1+json", "digest": image, "size": manifest.len() }],
    }))
    .expect("json");
    let mut tar = tar::Builder::new(Vec::new());
    for (name, bytes) in [
        ("index.json".to_owned(), &index),
        (format!("blobs/sha256/{}", &digest(&config)[7..]), &config),
        (format!("blobs/sha256/{}", &digest(&layer)[7..]), &layer),
        (format!("blobs/sha256/{}", &image[7..]), &manifest),
    ] {
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        tar.append_data(&mut header, name, bytes.as_slice())
            .expect("append");
    }
    (tar.into_inner().expect("tar"), image, manifest)
}

/// The container registry of the forge: a token for the Portal's own token, no blob held yet,
/// and a manifest stored under the digest `stored`.
async fn registry_takes(gitea: &MockServer, stored: &str) {
    Mock::given(method("GET"))
        .and(path("/v2/token"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({ "token": "registry-bearer" })),
        )
        .mount(gitea)
        .await;
    Mock::given(method("HEAD"))
        .and(wiremock::matchers::path_regex(
            "^/v2/test-owner/app-air-quality/blobs/sha256:.*",
        ))
        .respond_with(ResponseTemplate::new(404))
        .mount(gitea)
        .await;
    Mock::given(method("POST"))
        .and(path("/v2/test-owner/app-air-quality/blobs/uploads/"))
        .respond_with(ResponseTemplate::new(201))
        .mount(gitea)
        .await;
    Mock::given(method("PUT"))
        .and(path(format!(
            "/v2/test-owner/app-air-quality/manifests/{COMMIT}"
        )))
        .respond_with(ResponseTemplate::new(201).insert_header("Docker-Content-Digest", stored))
        .mount(gitea)
        .await;
}

fn fullstack(status: Value) -> Value {
    let mut manifest = app(Some(status), None);
    manifest["spec"]["kind"] = json!("fullstack");
    manifest["spec"]["build"] = json!({ "rust": "1.90", "node": "22" });
    manifest["spec"]["visibility"] = json!("project");
    manifest
}

/// AP-105, AP-107: a fullstack App's build is the image in `image-{commit}`: the Portal pushes
/// each blob with its digest and the manifest's bytes unchanged as `app-{name}:{commit}`, with
/// the registry token its own token bought, and writes the build once the registry stored it.
#[tokio::test]
async fn a_fullstack_build_is_pushed_to_the_registry_as_checked_then_written() {
    let (layout, image, manifest) = image_layout();
    let gitea = forge().await;
    built_on_forge_as(&gitea, COMMIT, "image", &layout, None).await;
    registry_takes(&gitea, &image).await;
    package_takes(&gitea, 201).await;
    let state = state_with(&gitea);
    let mut status = build();
    status["build"]["digest"] = json!(image);

    let accepted = send(
        &state,
        person("builder"),
        "POST",
        APPS,
        Some(fullstack(status)),
    )
    .await;
    assert_eq!(accepted.status, StatusCode::ACCEPTED, "{}", accepted.text);

    let requests = gitea.received_requests().await.unwrap_or_default();
    let uploads: Vec<String> = requests
        .iter()
        .filter(|r| r.method.as_str() == "POST" && r.url.path().ends_with("/blobs/uploads/"))
        .map(|r| r.url.query().unwrap_or_default().to_owned())
        .collect();
    assert_eq!(
        uploads.len(),
        2,
        "the config and the layer, each with its digest: {uploads:?}"
    );
    assert!(uploads.iter().all(|q| q.starts_with("digest=sha256%3A")));
    let pushed = requests
        .iter()
        .find(|r| r.method.as_str() == "PUT" && r.url.path().contains("/manifests/"))
        .expect("the manifest was pushed");
    assert_eq!(
        pushed.body, manifest,
        "the manifest's bytes, as they were hashed"
    );
    assert_eq!(
        pushed.headers["content-type"],
        "application/vnd.oci.image.manifest.v1+json"
    );
    assert_eq!(pushed.headers["authorization"], "Bearer registry-bearer");
    assert_eq!(
        published(&gitea).await,
        vec![format!("/{COMMIT}/sbom.cdx.json")],
        "the SBOM beside it; an image is no bundle"
    );
    assert!(committed(&gitea)
        .await
        .iter()
        .any(|file| file.contains(&image)));
}

/// AP-107: a registry that stores another digest than the one proposed is a refusal, and the
/// build is not written; so is a layout whose manifest is not the proposed digest.
#[tokio::test]
async fn a_fullstack_build_the_registry_stores_otherwise_is_refused() {
    let (layout, image, _) = image_layout();
    let other = format!("sha256:{}", "e".repeat(64));
    for (proposed, stored, says) in [
        (image.clone(), other.clone(), "the registry stored"),
        (other.clone(), image.clone(), "names no manifest"),
    ] {
        let gitea = forge().await;
        built_on_forge_as(&gitea, COMMIT, "image", &layout, None).await;
        registry_takes(&gitea, &stored).await;
        package_takes(&gitea, 201).await;
        let state = state_with(&gitea);
        let mut status = build();
        status["build"]["digest"] = json!(proposed);

        let refused = send(
            &state,
            person("builder"),
            "POST",
            APPS,
            Some(fullstack(status)),
        )
        .await;
        assert!(refused.status.is_client_error(), "{}", refused.text);
        assert!(refused.text.contains(says), "{}", refused.text);
        assert!(
            committed(&gitea).await.is_empty(),
            "the build was written: {says}"
        );
    }
}
