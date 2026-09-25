//! The forge teams of every project repository (PF-87, T-2655), against a stubbed forge: each
//! registered project gets `{slug}-readers` and `{slug}-writers` reaching its repository alone, a
//! gone project's teams go, and a team this platform did not make is never touched.

use std::collections::BTreeMap;

use joinedcontext_portal::git::GiteaClient;
use joinedcontext_portal::reconciler::project_teams::{converge, MARKER};
use serde_json::{json, Value};
use url::Url;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn forge(server: &MockServer) -> GiteaClient {
    GiteaClient::new(
        Url::parse(&server.uri()).expect("url"),
        "bb",
        "organization",
        "t0ken",
    )
    .expect("client")
}

async fn answer(server: &MockServer, verb: &str, at: &str, status: u16, body: Value) {
    Mock::given(method(verb))
        .and(path(at.to_owned()))
        .respond_with(ResponseTemplate::new(status).set_body_json(body))
        .mount(server)
        .await;
}

/// What the run wrote, as `METHOD path`, with the body of a team it created.
async fn wrote(server: &MockServer) -> Vec<(String, Value)> {
    server
        .received_requests()
        .await
        .unwrap_or_default()
        .iter()
        .filter(|r| r.method.as_str() != "GET")
        .map(|r| {
            (
                format!("{} {}", r.method.as_str(), r.url.path()),
                serde_json::from_slice(&r.body).unwrap_or(Value::Null),
            )
        })
        .collect()
}

#[tokio::test]
async fn a_project_gets_its_two_teams_on_its_repository_alone_and_a_gone_one_loses_them() {
    let server = MockServer::start().await;
    let managed = |slug: &str| format!("{MARKER} {slug}: read on {slug} (PF-87)");
    answer(
        &server,
        "GET",
        "/api/v1/orgs/bb/teams",
        200,
        json!([
            { "id": 1, "name": "readers", "description": "reads the configuration repository" },
            { "id": 7, "name": "gone-readers", "description": managed("gone") },
            { "id": 8, "name": "doprava-writers", "description": managed("doprava") }
        ]),
    )
    .await;
    answer(
        &server,
        "POST",
        "/api/v1/orgs/bb/teams",
        201,
        json!({ "id": 9, "name": "doprava-readers", "description": managed("doprava") }),
    )
    .await;
    answer(&server, "GET", "/api/v1/teams/9/repos", 200, json!([])).await;
    answer(
        &server,
        "GET",
        "/api/v1/teams/8/repos",
        200,
        json!([{ "name": "doprava" }, { "name": "organization" }]),
    )
    .await;
    for at in [
        "/api/v1/teams/9/repos/bb/doprava",
        "/api/v1/teams/8/repos/bb/organization",
        "/api/v1/teams/7",
    ] {
        for verb in ["PUT", "DELETE"] {
            Mock::given(method(verb))
                .and(path(at))
                .respond_with(ResponseTemplate::new(204))
                .mount(&server)
                .await;
        }
    }

    let projects = BTreeMap::from([("doprava".to_owned(), "doprava".to_owned())]);
    let outcomes = converge(&forge(&server), &projects).await;
    assert!(outcomes.iter().all(|o| o.error.is_none()), "{outcomes:?}");

    let wrote = wrote(&server).await;
    let paths: Vec<&str> = wrote.iter().map(|(p, _)| p.as_str()).collect();
    assert_eq!(
        paths,
        [
            "POST /api/v1/orgs/bb/teams",
            "PUT /api/v1/teams/9/repos/bb/doprava",
            "DELETE /api/v1/teams/8/repos/bb/organization",
            "DELETE /api/v1/teams/7",
        ],
        "the seeded readers team (1) is never touched"
    );
    let created = &wrote[0].1;
    assert_eq!(created["name"], "doprava-readers");
    assert_eq!(created["permission"], "read");
    assert_eq!(created["includes_all_repositories"], false);
    assert_eq!(created["units_map"]["repo.code"], "read");
    assert!(
        created["description"]
            .as_str()
            .unwrap_or_default()
            .starts_with(MARKER),
        "{created}"
    );
}

#[tokio::test]
async fn a_team_of_the_same_name_the_platform_did_not_make_is_reported_and_left_alone() {
    let server = MockServer::start().await;
    answer(
        &server,
        "GET",
        "/api/v1/orgs/bb/teams",
        200,
        json!([
            { "id": 3, "name": "doprava-readers", "description": "made by hand" },
            { "id": 4, "name": "doprava-writers", "description": "" }
        ]),
    )
    .await;
    let projects = BTreeMap::from([("doprava".to_owned(), "doprava".to_owned())]);
    let outcomes = converge(&forge(&server), &projects).await;
    assert_eq!(outcomes.len(), 2, "{outcomes:?}");
    for outcome in &outcomes {
        let error = outcome.error.as_deref().unwrap_or_default();
        assert!(error.contains("did not make"), "{outcome:?}");
    }
    assert!(wrote(&server).await.is_empty());
}

#[tokio::test]
async fn a_forge_that_does_not_list_its_teams_changes_nothing() {
    let server = MockServer::start().await;
    answer(&server, "GET", "/api/v1/orgs/bb/teams", 500, json!({})).await;
    let outcomes = converge(&forge(&server), &BTreeMap::new()).await;
    assert_eq!(outcomes.len(), 1);
    assert!(outcomes[0].error.is_some());
    assert!(wrote(&server).await.is_empty());
}
