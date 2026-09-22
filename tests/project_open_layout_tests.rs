//! Opening a project in layout 2: its own repository, seeded, and the registry entry as the
//! organization's Change; both or neither (T-2643, CC-85, PF-86, PF-87).

mod common;

use axum::http::StatusCode;
use common::{envelope, forge, person, send, state_on, REPO};
use joinedcontext_portal::state::AppState;
use serde_json::{json, Value};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const NEW: &str = "/api/v1/repos/test-owner/doprava";

/// The forge of a layout 2 organization that lets anyone open a project. The repository
/// `doprava` is not there until the Portal creates it; `exists` says it already is.
async fn world(exists: bool) -> (MockServer, AppState) {
    let server = forge().await;
    Mock::given(method("GET"))
        .and(path(format!("{REPO}/pulls")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([])))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path(NEW))
        .respond_with(if exists {
            ResponseTemplate::new(200).set_body_json(json!({ "default_branch": "main" }))
        } else {
            ResponseTemplate::new(404).set_body_json(json!({ "message": "not found" }))
        })
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/orgs/test-owner/repos"))
        .respond_with(ResponseTemplate::new(201).set_body_json(json!({ "name": "doprava" })))
        .mount(&server)
        .await;
    for (verb, route) in [
        ("POST", format!("{NEW}/contents")),
        ("POST", format!("{NEW}/branch_protections")),
        ("DELETE", NEW.to_owned()),
    ] {
        Mock::given(method(verb))
            .and(path(route))
            .respond_with(
                ResponseTemplate::new(201).set_body_json(json!({ "commit": { "sha": "seed" } })),
            )
            .mount(&server)
            .await;
    }
    let state = state_on(&server);
    state.mirror.upsert(envelope(
        "Organization",
        "bb",
        joinedcontext_portal::permissions::ORG_NAMESPACE,
        json!({ "domain": "banskabystrica.sk", "projects": { "creation": "anyone" } }),
    ));
    state.mirror.set_layout(2);
    (server, state)
}

async fn received(server: &MockServer, verb: &str, route: &str) -> Vec<Value> {
    server
        .received_requests()
        .await
        .expect("requests")
        .into_iter()
        .filter(|r| r.method.as_str() == verb && r.url.path() == route)
        .map(|r| serde_json::from_slice(&r.body).unwrap_or_default())
        .collect()
}

/// The files the organization's Change wrote, path and decoded content.
async fn organization_files(server: &MockServer) -> Vec<(String, String)> {
    server
        .received_requests()
        .await
        .expect("requests")
        .into_iter()
        .filter(|r| {
            r.method.as_str() == "PUT" && r.url.path().starts_with(&format!("{REPO}/contents/"))
        })
        .map(|r| {
            let body: Value = serde_json::from_slice(&r.body).unwrap_or_default();
            let content = body["content"].as_str().unwrap_or_default();
            let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, content)
                .unwrap_or_default();
            (
                r.url
                    .path()
                    .trim_start_matches(&format!("{REPO}/contents/"))
                    .to_owned(),
                String::from_utf8(bytes).unwrap_or_default(),
            )
        })
        .collect()
}

async fn open(state: &AppState) -> (StatusCode, String) {
    let answer = send(
        state,
        person("nobody"),
        "POST",
        "/api/v1/projects",
        Some(json!({ "name": "doprava", "displayName": "Doprava" })),
    )
    .await;
    (answer.status, answer.text)
}

/// PF-86, PF-87: the project's repository is created private, seeded on `main` with its layout,
/// its own file at 0.1.0 and CODEOWNERS, and `main` protected; the organization's Change carries
/// the registry entry and the creator's binding, and not the project's own file.
#[tokio::test]
async fn a_project_opens_into_a_repository_of_its_own() {
    let (server, state) = world(false).await;
    let (status, text) = open(&state).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{text}");

    let created = received(&server, "POST", "/api/v1/orgs/test-owner/repos").await;
    assert_eq!(created.len(), 1);
    assert_eq!(
        (created[0]["name"].as_str(), created[0]["private"].as_bool()),
        (Some("doprava"), Some(true))
    );

    let seed = received(&server, "POST", &format!("{NEW}/contents")).await;
    assert_eq!(seed.len(), 1, "one commit");
    assert_eq!(seed[0]["branch"], "main");
    let mut seeded: Vec<&str> = seed[0]["files"]
        .as_array()
        .expect("files")
        .iter()
        .filter_map(|file| file["path"].as_str())
        .collect();
    seeded.sort_unstable();
    assert_eq!(seeded, [".jc/layout", "CODEOWNERS", "project.yaml"]);
    assert_eq!(
        received(&server, "POST", &format!("{NEW}/branch_protections")).await[0]["rule_name"],
        "main"
    );

    let files = organization_files(&server).await;
    let paths: Vec<&str> = files.iter().map(|(path, _)| path.as_str()).collect();
    assert!(paths.contains(&"projects/doprava.yaml"), "{paths:?}");
    assert!(
        paths.contains(&"users/assignments/doprava-creator.yaml"),
        "{paths:?}"
    );
    assert!(
        !paths.contains(&"projects/doprava/project.yaml"),
        "{paths:?}"
    );
    let entry = &files
        .iter()
        .find(|(path, _)| path == "projects/doprava.yaml")
        .expect("entry")
        .1;
    let entry: jc_core::kinds::Project =
        jc_core::kinds::Project::from_yaml(entry).unwrap_or_else(|e| panic!("{e}: {entry}"));
    entry.validate().expect("a valid registry entry");
    assert!(entry.spec.is_registry_entry());
    assert_eq!(entry.spec.git_ref.as_deref(), Some("main"));
}

/// PF-86: a repository of that name already in the forge is refused, never adopted, and
/// nothing is written anywhere.
#[tokio::test]
async fn a_repository_that_is_already_there_is_not_adopted() {
    let (server, state) = world(true).await;
    let (status, text) = open(&state).await;
    assert_eq!(status, StatusCode::CONFLICT, "{text}");
    assert!(text.contains("doprava"), "{text}");
    assert!(received(&server, "POST", &format!("{NEW}/contents"))
        .await
        .is_empty());
    assert!(organization_files(&server).await.is_empty());
    assert!(
        received(&server, "DELETE", NEW).await.is_empty(),
        "somebody's repository stays"
    );
}

/// CC-85: when the organization's Change cannot be opened, the repository the Portal just
/// created is removed again, so no repository is left that no registry entry names.
#[tokio::test]
async fn a_failed_registration_removes_the_new_repository() {
    let (server, state) = world(false).await;
    Mock::given(method("POST"))
        .and(path(format!("{REPO}/pulls")))
        .respond_with(ResponseTemplate::new(500).set_body_json(json!({ "message": "down" })))
        .with_priority(1)
        .mount(&server)
        .await;
    let (status, text) = open(&state).await;
    assert!(status.is_server_error(), "{status}: {text}");
    assert_eq!(
        received(&server, "DELETE", NEW).await.len(),
        1,
        "the new repository is removed"
    );
}
