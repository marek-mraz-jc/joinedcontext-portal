//! Importing the git export of a project as a new project of layout 2 (T-2644, MF-45, MF-46,
//! MF-47, MF-42, CC-85, CC-88): the archive checked before anything is created, each
//! repository created empty and filled by a push, each head read back, the project remounted
//! onto its new slug, and the registry entry with this deployment's values proposed.

mod common;

use std::io::Write;

use axum::http::StatusCode;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use common::{envelope, forge, person, state_on, REPO};
use joinedcontext_portal::auth::session::Identity;
use joinedcontext_portal::permissions::ORG_NAMESPACE;
use joinedcontext_portal::state::AppState;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const HEAD: &str = "2c245c6bb1efa7a20938c5b11b70379be6838eec";
const APP_HEAD: &str = "b47f8079d2df9e7986d2babf4539cec802f4e68e";
const TAGGED: &str = "3a386a2d5ff9fc1e18d3032677ae5bbf2ea5d4e7";
const NEW: &str = "/api/v1/repos/test-owner/doprava";
const NEW_APP: &str = "/api/v1/repos/test-owner/doprava_air-map";

const PROJECT: &str = "apiVersion: joinedcontext.com/v1alpha1\nkind: Project\nmetadata:\n  \
                       name: ovzdusie\n  namespace: org\nspec:\n  organizationRef: bb\n  \
                       parameters:\n    audience: { type: string, default: public }\n";
const SPACE: &str = "apiVersion: joinedcontext.com/v1alpha1\nkind: ContextSpace\nmetadata:\n  \
                     name: ovzdusie\n  namespace: ovzdusie\nspec:\n  isSandbox: false\n";
const APP: &str =
    "apiVersion: joinedcontext.com/v1alpha1\nkind: App\nmetadata:\n  name: air-map\n  \
                   namespace: ovzdusie\nspec:\n  source:\n    git:\n      url: \
                   https://old.example/bb/ovzdusie_air-map.git\n      ref: main\n";

fn bundle(head: &str) -> Vec<u8> {
    let mut bytes =
        format!("# v2 git bundle\n{head} refs/heads/bundle\n{head} HEAD\n\n").into_bytes();
    bytes.extend_from_slice(b"PACK\0\0\0\x02\0\0\0\0");
    bytes
}

/// The archive `GET …/export?format=git` writes for `ovzdusie` and its App `air-map`, with
/// `edit` applied to the files before the index is written.
fn archive(project_yaml: &str, edit: impl Fn(&mut Vec<(String, Vec<u8>)>)) -> Vec<u8> {
    archive_padded(project_yaml, 0, edit)
}

/// The same archive with `pad` bytes of pack data in the project's bundle, which deflate cannot
/// shrink: a project with some history.
fn archive_padded(
    project_yaml: &str,
    pad: usize,
    edit: impl Fn(&mut Vec<(String, Vec<u8>)>),
) -> Vec<u8> {
    let mut project = bundle(HEAD);
    let mut seed: u32 = 0x2644;
    project.extend((0..pad).map(|_| {
        seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
        (seed >> 16) as u8
    }));
    let mut files: Vec<(String, Vec<u8>)> = vec![
        ("ovzdusie.bundle".into(), project),
        (
            "ovzdusie.tags".into(),
            format!("{TAGGED} refs/tags/v1.0.0\n").into_bytes(),
        ),
        ("project.yaml".into(), project_yaml.as_bytes().to_vec()),
        ("air-map.bundle".into(), bundle(APP_HEAD)),
        (
            "projects/ovzdusie.yaml".into(),
            b"kind: Project\nmetadata: { name: ovzdusie }\n".to_vec(),
        ),
    ];
    let index = json!({
        "apiVersion": "joinedcontext.com/v1alpha1",
        "kind": "Bundle",
        "metadata": { "name": "ovzdusie", "namespace": "org" },
        "spec": {
            "exportedAt": "2026-09-22T12:00:00Z",
            "exportedBy": "jana",
            "sourceRevision": HEAD,
            "items": [],
            "files": files.iter().map(|(path, bytes)| json!({
                "path": path, "sha256": format!("{:x}", Sha256::digest(bytes))
            })).collect::<Vec<_>>(),
            "omitted": 0,
            "repositories": [
                { "name": "ovzdusie", "role": "project", "file": "ovzdusie.bundle", "head": HEAD },
                { "name": "air-map", "role": "application", "file": "air-map.bundle", "head": APP_HEAD },
            ],
        },
    });
    edit(&mut files);
    files.push((
        "bundle.yaml".into(),
        serde_yaml_ng::to_string(&index).expect("yaml").into_bytes(),
    ));
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (path, bytes) in &files {
        writer
            .start_file(path, zip::write::SimpleFileOptions::default())
            .expect("entry");
        writer.write_all(bytes).expect("write");
    }
    writer.finish().expect("zip").into_inner()
}

/// A new repository the import creates: absent until created, then `main` at `head`, the
/// push taken, and writes and protection taken.
async fn new_repository(server: &MockServer, base: &str, head: &str, files: &[(&str, &str)]) {
    let git = base.replace("/api/v1/repos/", "/") + ".git/git-receive-pack";
    Mock::given(method("GET"))
        .and(path(base))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({ "message": "not found" })))
        .mount(server)
        .await;
    Mock::given(method("POST"))
        .and(path(git))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_bytes(b"000eunpack ok\n0017ok refs/heads/main\n0000".to_vec()),
        )
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path(format!("{base}/branches/main")))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({ "name": "main", "commit": { "id": head } })),
        )
        .mount(server)
        .await;
    let tree: Vec<_> = files
        .iter()
        .map(|(file, _)| json!({ "path": file, "type": "blob", "sha": format!("blob-{file}") }))
        .collect();
    Mock::given(method("GET"))
        .and(path(format!("{base}/git/trees/main")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "sha": "tree", "truncated": false, "tree": tree
        })))
        .mount(server)
        .await;
    for (file, body) in files {
        Mock::given(method("GET"))
            .and(path(format!("{base}/contents/{file}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "sha": format!("blob-{file}"), "content": STANDARD.encode(body)
            })))
            .mount(server)
            .await;
    }
    for (verb, route) in [
        ("POST", format!("{base}/contents")),
        ("POST", format!("{base}/branch_protections")),
        ("DELETE", base.to_owned()),
    ] {
        Mock::given(method(verb))
            .and(path(route))
            .respond_with(
                ResponseTemplate::new(201).set_body_json(json!({ "commit": { "sha": "remount" } })),
            )
            .mount(server)
            .await;
    }
}

/// A layout 2 organization that lets anyone open a project and makes Jana its administrator,
/// into which `ovzdusie`'s export is imported as `doprava`.
async fn world() -> (MockServer, AppState) {
    let server = forge().await;
    Mock::given(method("GET"))
        .and(path(format!("{REPO}/pulls")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([])))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/orgs/test-owner/repos"))
        .respond_with(ResponseTemplate::new(201).set_body_json(json!({ "name": "created" })))
        .mount(&server)
        .await;
    new_repository(
        &server,
        NEW,
        HEAD,
        &[
            ("project.yaml", PROJECT),
            ("CODEOWNERS", "* @bb/ovzdusie-writers\n"),
            ("spaces/ovzdusie/space.yaml", SPACE),
            ("apps/air-map/app.yaml", APP),
        ],
    )
    .await;
    new_repository(&server, NEW_APP, APP_HEAD, &[]).await;
    let state = state_on(&server);
    state.mirror.upsert(envelope(
        "Organization",
        "bb",
        ORG_NAMESPACE,
        json!({ "domain": "banskabystrica.sk", "projects": { "creation": "anyone" } }),
    ));
    // Jana administers the organization, which importing a project needs (UI-87).
    state.mirror.upsert(envelope(
        "Role",
        "org-admin",
        ORG_NAMESPACE,
        json!({ "rules": [{ "kinds": ["Organization"], "verbs": ["read", "propose", "approve", "delete"] }] }),
    ));
    state.mirror.upsert(envelope(
        "RoleBinding",
        "org-admins",
        ORG_NAMESPACE,
        json!({ "subjects": [{ "user": "jana@hel.fi" }], "role": "org-admin", "scope": { "organization": "bb" } }),
    ));
    state.mirror.set_layout(2);
    (server, state)
}

struct Answer {
    status: StatusCode,
    text: String,
}

async fn import(
    state: &AppState,
    who: Identity,
    query: &str,
    file: &[u8],
    fields: &[(&str, &str)],
) -> Answer {
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    let boundary = "jcgitimport";
    let mut body = Vec::new();
    for (name, value) in fields {
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
            )
            .as_bytes(),
        );
    }
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; \
             filename=\"ovzdusie-git.zip\"\r\nContent-Type: application/zip\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(file);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let response = joinedcontext_portal::server::app(state.clone())
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri(format!("/api/v1/projects/doprava/import{query}"))
                .header(
                    axum::http::header::COOKIE,
                    common::cookie(&state.config, who),
                )
                .header(joinedcontext_portal::auth::csrf::CSRF_HEADER, common::CSRF)
                .header(
                    axum::http::header::CONTENT_TYPE,
                    format!("multipart/form-data; boundary={boundary}"),
                )
                .body(axum::body::Body::from(body))
                .expect("request"),
        )
        .await
        .expect("response");
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    Answer {
        status,
        text: String::from_utf8_lossy(&bytes).into_owned(),
    }
}

/// The import as the Portal's form runs it: the dry run (the check PF-57 holds it to), then the
/// same archive and fields for real.
async fn checked_import(state: &AppState, file: &[u8], fields: &[(&str, &str)]) -> Answer {
    let check = import(
        state,
        person("jana"),
        "?format=git&dryRun=All",
        file,
        fields,
    )
    .await;
    assert_eq!(check.status, StatusCode::OK, "{}", check.text);
    import(state, person("jana"), "?format=git", file, fields).await
}

/// Every request of `verb` to `route`, its body as bytes.
async fn sent(server: &MockServer, verb: &str, route: &str) -> Vec<Vec<u8>> {
    server
        .received_requests()
        .await
        .expect("requests")
        .into_iter()
        .filter(|r| r.method.as_str() == verb && r.url.path() == route)
        .map(|r| r.body)
        .collect()
}

/// Nothing was created in the forge.
async fn nothing_created(server: &MockServer) {
    assert!(sent(server, "POST", "/api/v1/orgs/test-owner/repos")
        .await
        .is_empty());
}

/// MF-45, MF-46, CC-88: each repository is created empty, filled by pushing its bundle as
/// `main` with its tags, read back at the index's head; the project is remounted onto the new
/// slug with its App building from its new repository; `main` is protected; and the
/// organization's Change carries the registry entry with the given values.
#[tokio::test]
async fn an_export_imports_as_a_new_project() {
    let (server, state) = world().await;
    let answer = checked_import(
        &state,
        &archive(PROJECT, |_| {}),
        &[("parameters", r#"{"audience":"organization"}"#)],
    )
    .await;
    assert_eq!(answer.status, StatusCode::ACCEPTED, "{}", answer.text);

    let created: Vec<Value> = sent(&server, "POST", "/api/v1/orgs/test-owner/repos")
        .await
        .iter()
        .map(|body| serde_json::from_slice(body).expect("json"))
        .collect();
    let names: Vec<(&str, bool, bool)> = created
        .iter()
        .map(|body| {
            (
                body["name"].as_str().unwrap_or_default(),
                body["private"].as_bool().unwrap_or_default(),
                body["auto_init"].as_bool().unwrap_or(true),
            )
        })
        .collect();
    assert_eq!(
        names,
        [("doprava", true, false), ("doprava_air-map", true, false)]
    );

    let pushed = sent(&server, "POST", "/test-owner/doprava.git/git-receive-pack").await;
    assert_eq!(pushed.len(), 1);
    let push = String::from_utf8_lossy(&pushed[0]);
    assert!(
        push.contains(&format!("{HEAD} refs/heads/main\0 report-status")),
        "{push}"
    );
    assert!(
        push.contains(&format!("{TAGGED} refs/tags/v1.0.0")),
        "{push}"
    );
    assert!(
        pushed[0].ends_with(b"0000PACK\0\0\0\x02\0\0\0\0"),
        "the bundle's pack after the commands"
    );

    let remount = sent(&server, "POST", &format!("{NEW}/contents")).await;
    assert_eq!(remount.len(), 1, "one remount commit");
    let remount: Value = serde_json::from_slice(&remount[0]).expect("json");
    let written: std::collections::BTreeMap<String, String> = remount["files"]
        .as_array()
        .expect("files")
        .iter()
        .map(|file| {
            let bytes = STANDARD
                .decode(file["content"].as_str().unwrap_or_default())
                .unwrap_or_default();
            (
                file["path"].as_str().unwrap_or_default().to_owned(),
                String::from_utf8(bytes).unwrap_or_default(),
            )
        })
        .collect();
    let app: Value = serde_yaml_ng::from_str(&written["apps/air-map/app.yaml"]).expect("yaml");
    assert_eq!(app["metadata"]["namespace"], "doprava");
    assert!(
        app["spec"]["source"]["git"]["url"]
            .as_str()
            .unwrap_or_default()
            .ends_with("/test-owner/doprava_air-map.git"),
        "{app}"
    );
    assert_eq!(written["CODEOWNERS"], "* @test-owner/doprava-writers\n");
    for repository in [NEW, NEW_APP] {
        assert_eq!(
            sent(&server, "POST", &format!("{repository}/branch_protections"))
                .await
                .len(),
            1,
            "{repository}"
        );
    }

    let entry = server
        .received_requests()
        .await
        .expect("requests")
        .into_iter()
        .find(|r| {
            r.method.as_str() == "PUT"
                && r.url.path() == format!("{REPO}/contents/projects/doprava.yaml")
        })
        .expect("the registry entry");
    let body: Value = serde_json::from_slice(&entry.body).expect("json");
    let yaml = String::from_utf8(
        STANDARD
            .decode(body["content"].as_str().unwrap_or_default())
            .unwrap_or_default(),
    )
    .unwrap_or_default();
    let entry: Value = serde_yaml_ng::from_str(&yaml).expect("yaml");
    assert_eq!(entry["spec"]["repository"]["name"], "doprava");
    assert_eq!(entry["spec"]["parameters"]["audience"], "organization");
    assert!(sent(&server, "DELETE", NEW).await.is_empty());
}

/// CC-88: the dry run answers the repositories it would create and the parameters the project
/// declares, the form's source; nothing is created.
#[tokio::test]
async fn the_dry_run_answers_the_plan_and_the_declarations() {
    let (server, state) = world().await;
    let answer = import(
        &state,
        person("jana"),
        "?format=git&dryRun=All",
        &archive(PROJECT, |_| {}),
        &[],
    )
    .await;
    assert_eq!(answer.status, StatusCode::OK, "{}", answer.text);
    let plan: Value = serde_json::from_str(&answer.text).expect("json");
    assert_eq!(plan["parameters"]["audience"]["type"], "string");
    let repositories: Vec<&str> = plan["repositories"]
        .as_array()
        .expect("repositories")
        .iter()
        .filter_map(|r| r["repository"].as_str())
        .collect();
    assert_eq!(repositories, ["doprava", "doprava_air-map"]);
    nothing_created(&server).await;
}

/// MF-42, MF-47, CC-88: a file that is not the exported one, a project of another apiVersion,
/// and a value for an undeclared parameter are refused before anything is created.
#[tokio::test]
async fn an_archive_that_does_not_check_creates_nothing() {
    let (server, state) = world().await;
    let tampered = archive(PROJECT, |files| {
        files[0].1.extend_from_slice(b"more");
    });
    let newer = archive(&PROJECT.replace("v1alpha1", "v1beta1"), |_| {});
    for (file, fields, needle) in [
        (tampered, vec![], "SHA-256"),
        (newer, vec![], "v1beta1"),
        (
            archive(PROJECT, |_| {}),
            vec![("parameters", r#"{"colour":"red"}"#)],
            "colour",
        ),
    ] {
        let answer = import(&state, person("jana"), "?format=git", &file, &fields).await;
        assert_eq!(answer.status, StatusCode::BAD_REQUEST, "{}", answer.text);
        assert!(answer.text.contains(needle), "{needle}: {}", answer.text);
    }
    nothing_created(&server).await;
}

/// PF-86: a repository of one of the names already in the forge is refused before anything is
/// created, and nobody's repository is removed.
#[tokio::test]
async fn a_repository_that_is_there_is_not_adopted() {
    let (server, state) = world().await;
    Mock::given(method("GET"))
        .and(path(NEW_APP))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "default_branch": "main" })))
        .with_priority(1)
        .mount(&server)
        .await;
    let answer = checked_import(&state, &archive(PROJECT, |_| {}), &[]).await;
    assert_eq!(answer.status, StatusCode::CONFLICT, "{}", answer.text);
    assert!(answer.text.contains("doprava_air-map"), "{}", answer.text);
    nothing_created(&server).await;
    assert!(sent(&server, "DELETE", NEW_APP).await.is_empty());
}

/// MF-46, CC-85: a head that is not the index's after the push removes every repository the
/// import created.
#[tokio::test]
async fn a_head_that_is_not_the_bundles_removes_what_was_created() {
    let (server, state) = world().await;
    Mock::given(method("GET"))
        .and(path(format!("{NEW_APP}/branches/main")))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({ "name": "main", "commit": { "id": TAGGED } })),
        )
        .with_priority(1)
        .mount(&server)
        .await;
    let answer = checked_import(&state, &archive(PROJECT, |_| {}), &[]).await;
    assert_eq!(answer.status, StatusCode::CONFLICT, "{}", answer.text);
    assert!(answer.text.contains("MF-46"), "{}", answer.text);
    assert_eq!(sent(&server, "DELETE", NEW).await.len(), 1);
    assert_eq!(sent(&server, "DELETE", NEW_APP).await.len(), 1);
}

/// MF-45: an organization of layout 1 has no project repositories to land in.
#[tokio::test]
async fn layout_one_answers_with_the_zip_import() {
    let (server, state) = world().await;
    state.mirror.set_layout(1);
    let answer = import(
        &state,
        person("jana"),
        "?format=git",
        &archive(PROJECT, |_| {}),
        &[],
    )
    .await;
    assert_eq!(answer.status, StatusCode::CONFLICT, "{}", answer.text);
    nothing_created(&server).await;
}

/// An archive over axum's 2 MiB default body limit and under the import's own limit is read,
/// not cut off (MF-45).
#[tokio::test]
async fn an_archive_over_two_mebibytes_is_read() {
    let (server, state) = world().await;
    let file = archive_padded(PROJECT, 3 * 1024 * 1024, |_| {});
    assert!(file.len() > 3 * 1024 * 1024, "{}", file.len());
    let answer = import(&state, person("jana"), "?format=git&dryRun=All", &file, &[]).await;
    assert_eq!(answer.status, StatusCode::OK, "{}", answer.text);
    nothing_created(&server).await;
}

/// PF-65: who may not open a project is refused before the upload is read, so an unreadable
/// or oversized body tells them nothing but that.
#[tokio::test]
async fn who_may_not_open_a_project_is_refused_before_the_body_is_read() {
    let (server, state) = world().await;
    state.mirror.upsert(envelope(
        "Organization",
        "bb",
        ORG_NAMESPACE,
        json!({ "domain": "banskabystrica.sk", "projects": { "creation": "org-admin" } }),
    ));
    let answer = import(
        &state,
        person("jana"),
        "?format=git",
        b"not a zip",
        &[("stray", "x")],
    )
    .await;
    assert_eq!(answer.status, StatusCode::FORBIDDEN, "{}", answer.text);
    nothing_created(&server).await;
}

/// UI-87 (T-2879): opening a project is not importing one. A person the organization lets open
/// projects but who does not administer it is refused before the upload is read.
#[tokio::test]
async fn who_does_not_administer_the_organization_imports_no_project() {
    let (server, state) = world().await;
    let answer = import(
        &state,
        person("peter"),
        "?format=git",
        b"not a zip",
        &[("stray", "x")],
    )
    .await;
    assert_eq!(answer.status, StatusCode::FORBIDDEN, "{}", answer.text);
    assert!(
        answer.text.contains("organization administrators"),
        "{}",
        answer.text
    );
    nothing_created(&server).await;
}
