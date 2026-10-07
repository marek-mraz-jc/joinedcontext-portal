//! The App page's build: the repository, the newest run and the package, and Rebuild as a
//! dispatch of the application's own workflow (AP-103, ADR-N-028, T-2609).

mod common;

use axum::http::StatusCode;
use serde_json::{json, Value};
use wiremock::matchers::{body_json, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use common::{checked_send as send, envelope, person};
use joinedcontext_portal::permissions::ORG_NAMESPACE;
use joinedcontext_portal::resource::{ResourceEnvelope, API_VERSION};
use joinedcontext_portal::state::AppState;

/// `common::state_on` names the organization `test-owner`; the App's repository is `{project}_{app}`.
const REPO: &str = "/api/v1/repos/test-owner/helsinki_bikes";
const COMMIT: &str = "3f1c0e2d7a6b5c4f1b9c0e2d7a6b5c4f1b9c0e2d";

fn app(git: bool) -> ResourceEnvelope {
    let source = if git {
        // A manifest naming another repository changes nothing: the path names the repository.
        json!({ "git": { "url": "https://forge.example/test-owner/other_repo.git", "ref": COMMIT } })
    } else {
        json!({ "path": "./src" })
    };
    serde_json::from_value(json!({
        "apiVersion": API_VERSION,
        "kind": "App",
        "metadata": { "name": "bikes", "namespace": "helsinki" },
        "spec": {
            "kind": "static",
            "source": source,
            "build": { "node": "22" },
            "visibility": "project",
            "lifecycle": "published",
            "dataNeeds": [],
        },
        "status": { "build": {
            "digest": format!("sha256:{}", "ab".repeat(32)),
            "commit": COMMIT,
            "sdkVersion": "0.4.1",
            "builtAt": "2026-09-22T06:00:00Z",
        }},
    }))
    .expect("an App")
}

/// `jana` proposes Apps in helsinki, `vera` only reads them, anyone else has no grant here.
fn state_with(gitea: &MockServer, git: bool) -> AppState {
    let state = common::state_on(gitea);
    for (role, verbs) in [
        ("app-editor", json!(["propose"])),
        ("app-reader", json!(["read"])),
    ] {
        state.mirror.upsert(envelope(
            "Role",
            role,
            ORG_NAMESPACE,
            json!({ "rules": [{ "kinds": ["App"], "verbs": verbs }] }),
        ));
    }
    for (who, role) in [("jana", "app-editor"), ("vera", "app-reader")] {
        state.mirror.upsert(envelope(
            "RoleBinding",
            &format!("{who}-{role}"),
            ORG_NAMESPACE,
            json!({
                "subjects": [{ "user": format!("{who}@hel.fi") }],
                "role": role,
                "scope": { "project": "helsinki" },
            }),
        ));
    }
    state.mirror.upsert(app(git));
    state
}

async fn forge_with_a_run() -> MockServer {
    let gitea = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(format!("{REPO}/actions/runs")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "total_count": 1,
            "workflow_runs": [{
                "id": 91, "run_number": 7, "status": "completed", "conclusion": "success",
                "head_sha": COMMIT, "html_url": "http://gitea-http:3000/test-owner/helsinki_bikes/actions/runs/7",
            }],
        })))
        .mount(&gitea)
        .await;
    Mock::given(method("GET"))
        .and(path(REPO))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "default_branch": "main" })))
        .mount(&gitea)
        .await;
    gitea
}

fn body(text: &str) -> Value {
    serde_json::from_str(text).expect("a JSON answer")
}

async fn dispatches(gitea: &MockServer) -> Vec<String> {
    gitea
        .received_requests()
        .await
        .unwrap_or_default()
        .iter()
        .filter(|r| r.method.as_str() == "POST")
        .map(|r| r.url.path().to_owned())
        .collect()
}

/// AP-103, PF-81: the page links the repository, the newest run and the package of the build,
/// each behind the forge's sign-in, and offers Rebuild only to a person who may propose an App.
#[tokio::test]
async fn the_build_links_the_repository_the_run_and_the_package_behind_the_forge_sign_in() {
    let gitea = forge_with_a_run().await;
    let state = state_with(&gitea, true);
    const URI: &str = "/api/v1/projects/helsinki/apps/bikes/build";

    let answer = send(&state, person("jana"), "GET", URI, None).await;
    assert_eq!(answer.status, StatusCode::OK, "{}", answer.text);
    let build = body(&answer.text);
    let login = |target: &str| {
        format!(
            "{}/user/oauth2/keycloak?redirect_to={}",
            gitea.uri(),
            target
        )
    };
    assert_eq!(
        build["repositoryUrl"],
        login("%2Ftest-owner%2Fhelsinki_bikes")
    );
    assert_eq!(
        build["run"],
        json!({
            "status": "completed",
            "conclusion": "success",
            "commit": COMMIT,
            "url": login("%2Ftest-owner%2Fhelsinki_bikes%2Factions%2Fruns%2F7"),
            "number": 7,
        })
    );
    assert_eq!(
        build["packageUrl"],
        login(&format!(
            "%2Ftest-owner%2F-%2Fpackages%2Fgeneric%2Fapp-bikes%2F{COMMIT}-abababababab"
        ))
    );
    assert_eq!(build["rebuild"], json!({ "allowed": true }));

    let reader = body(&send(&state, person("vera"), "GET", URI, None).await.text);
    assert_eq!(reader["rebuild"]["allowed"], false);
    assert!(
        reader["rebuild"]["reason"]
            .as_str()
            .unwrap_or_default()
            .contains("propose on App"),
        "{reader}"
    );

    let stranger = send(&state, person("otto"), "GET", URI, None).await;
    assert_eq!(stranger.status, StatusCode::NOT_FOUND, "{}", stranger.text);
    let missing = send(
        &state,
        person("jana"),
        "GET",
        "/api/v1/projects/helsinki/apps/gone/build",
        None,
    )
    .await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND);
    assert_eq!(
        stranger.text.replace("bikes", "gone"),
        missing.text,
        "one answer for both"
    );
}

/// AP-103: Rebuild dispatches `build.yml` of the App's own repository on its default branch,
/// whatever repository the manifest names; a reader is refused and nothing is dispatched.
#[tokio::test]
async fn rebuild_dispatches_the_apps_own_workflow_on_its_default_branch() {
    let gitea = forge_with_a_run().await;
    Mock::given(method("POST"))
        .and(path(format!(
            "{REPO}/actions/workflows/build.yml/dispatches"
        )))
        .and(body_json(json!({ "ref": "main" })))
        .respond_with(ResponseTemplate::new(204))
        .expect(1)
        .mount(&gitea)
        .await;
    let state = state_with(&gitea, true);
    const URI: &str = "/api/v1/projects/helsinki/apps/bikes/rebuild";

    let refused = send(&state, person("vera"), "POST", URI, None).await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN, "{}", refused.text);
    assert!(
        dispatches(&gitea).await.is_empty(),
        "a reader dispatched a build"
    );

    let accepted = send(&state, person("jana"), "POST", URI, None).await;
    assert_eq!(accepted.status, StatusCode::ACCEPTED, "{}", accepted.text);
    assert_eq!(
        dispatches(&gitea).await,
        vec![format!("{REPO}/actions/workflows/build.yml/dispatches")]
    );
}

/// AP-100, AP-103: an App that names no repository of its own has no build on the forge; the
/// page says so and Rebuild is refused `409` with the reason, and nothing reaches the forge.
#[tokio::test]
async fn an_app_not_built_on_the_forge_has_no_links_and_no_rebuild() {
    let gitea = MockServer::start().await;
    let state = state_with(&gitea, false);

    let answer = send(
        &state,
        person("jana"),
        "GET",
        "/api/v1/projects/helsinki/apps/bikes/build",
        None,
    )
    .await;
    assert_eq!(answer.status, StatusCode::OK, "{}", answer.text);
    let build = body(&answer.text);
    assert_eq!(build["repositoryUrl"], Value::Null);
    assert_eq!(build["run"], Value::Null);
    assert_eq!(build["packageUrl"], Value::Null);
    // jana is bound to the project only, so layout 1's organization repository is not hers.
    assert_eq!(build["configurationUrl"], Value::Null);
    assert_eq!(build["rebuild"]["allowed"], false);
    assert!(build["rebuild"]["reason"]
        .as_str()
        .unwrap_or_default()
        .contains("AP-100"));

    let refused = send(
        &state,
        person("jana"),
        "POST",
        "/api/v1/projects/helsinki/apps/bikes/rebuild",
        None,
    )
    .await;
    assert_eq!(refused.status, StatusCode::CONFLICT, "{}", refused.text);
    assert!(gitea
        .received_requests()
        .await
        .unwrap_or_default()
        .is_empty());
}

/// AP-103: a dispatch the forge refuses is a `503` with the forge's own words, and a repository
/// without a run yet is a page with no run rather than an error.
#[tokio::test]
async fn a_refused_dispatch_says_the_forges_reason_and_no_run_is_no_error() {
    let gitea = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(format!("{REPO}/actions/runs")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "workflow_runs": [] })))
        .mount(&gitea)
        .await;
    Mock::given(method("GET"))
        .and(path(REPO))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "default_branch": "main" })))
        .mount(&gitea)
        .await;
    Mock::given(method("POST"))
        .and(path(format!(
            "{REPO}/actions/workflows/build.yml/dispatches"
        )))
        .respond_with(
            ResponseTemplate::new(422).set_body_string("Actions are disabled for this repository"),
        )
        .mount(&gitea)
        .await;
    let state = state_with(&gitea, true);

    let page = body(
        &send(
            &state,
            person("jana"),
            "GET",
            "/api/v1/projects/helsinki/apps/bikes/build",
            None,
        )
        .await
        .text,
    );
    assert_eq!(page["run"], Value::Null);

    let refused = send(
        &state,
        person("jana"),
        "POST",
        "/api/v1/projects/helsinki/apps/bikes/rebuild",
        None,
    )
    .await;
    assert_eq!(
        refused.status,
        StatusCode::SERVICE_UNAVAILABLE,
        "{}",
        refused.text
    );
    assert!(
        refused.text.contains("Actions are disabled"),
        "{}",
        refused.text
    );
}

const BUILD: &str = "/api/v1/projects/helsinki/apps/bikes/build";

fn login(gitea: &MockServer, target: &str) -> Value {
    json!(format!(
        "{}/user/oauth2/keycloak?redirect_to={target}",
        gitea.uri()
    ))
}

/// T-3039, PF-87: in layout 1 the configuration repository is the organization's, which the
/// forge reads to a person bound at the organization and to nobody bound only to the project;
/// the App's own repository is read by every signed-in person who may read the App (T-3030).
#[tokio::test]
async fn in_layout_1_the_configuration_link_is_for_a_person_bound_at_the_organization() {
    let gitea = forge_with_a_run().await;
    let state = state_with(&gitea, true);
    state.mirror.upsert(envelope(
        "RoleBinding",
        "olga-app-reader",
        ORG_NAMESPACE,
        json!({
            "subjects": [{ "user": "olga@hel.fi" }],
            "role": "app-reader",
            "scope": { "organization": "hel" },
        }),
    ));

    let jana = body(&send(&state, person("jana"), "GET", BUILD, None).await.text);
    assert_eq!(jana["configurationUrl"], Value::Null);
    assert_eq!(
        jana["repositoryUrl"],
        login(&gitea, "%2Ftest-owner%2Fhelsinki_bikes")
    );

    let olga = body(&send(&state, person("olga"), "GET", BUILD, None).await.text);
    assert_eq!(
        olga["configurationUrl"],
        login(&gitea, "%2Ftest-owner%2Ftest-repo")
    );
    assert_eq!(
        olga["repositoryUrl"],
        login(&gitea, "%2Ftest-owner%2Fhelsinki_bikes")
    );
}

/// T-3039, PF-87, CC-87: in layout 2 the configuration link is the project's own repository,
/// for every person the project's bindings place in its readers, a read-only one included; the
/// address follows the platform's record of the repository, so a renamed one moves with it.
#[tokio::test]
async fn in_layout_2_the_configuration_link_is_the_projects_own_repository_for_its_readers() {
    let gitea = forge_with_a_run().await;
    let state = state_with(&gitea, true);
    state.mirror.set_layout(2);
    state
        .mirror
        .set_repositories([("helsinki".to_owned(), "helsinki".to_owned())].into());

    for who in ["jana", "vera"] {
        let build = body(&send(&state, person(who), "GET", BUILD, None).await.text);
        assert_eq!(
            build["configurationUrl"],
            login(&gitea, "%2Ftest-owner%2Fhelsinki"),
            "{who}"
        );
    }

    state
        .mirror
        .set_repositories([("helsinki".to_owned(), "helsinki-city".to_owned())].into());
    let renamed = body(&send(&state, person("vera"), "GET", BUILD, None).await.text);
    assert_eq!(
        renamed["configurationUrl"],
        login(&gitea, "%2Ftest-owner%2Fhelsinki-city")
    );
}

/// T-3245: a running build is shown against the newest finished successful run, and the run
/// carries its number and times, so a client tells the run it started from the one before.
#[tokio::test]
async fn a_build_carries_its_runs_number_and_times_and_the_estimate_of_the_last_success() {
    let gitea = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(format!("{REPO}/actions/runs")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "workflow_runs": [
                { "run_number": 9, "status": "in_progress", "head_sha": COMMIT, "started_at": "2026-10-07T10:00:00Z" },
                { "run_number": 8, "status": "completed", "conclusion": "failure", "head_sha": COMMIT,
                  "started_at": "2026-10-07T09:00:00Z", "completed_at": "2026-10-07T09:00:20Z" },
                { "run_number": 7, "status": "completed", "conclusion": "success", "head_sha": COMMIT,
                  "started_at": "2026-10-07T08:00:00Z", "completed_at": "2026-10-07T08:03:05Z" }
            ],
        })))
        .mount(&gitea)
        .await;
    let state = state_with(&gitea, true);
    let answer = send(
        &state,
        person("jana"),
        "GET",
        "/api/v1/projects/helsinki/apps/bikes/build",
        None,
    )
    .await;
    assert_eq!(answer.status, StatusCode::OK, "{}", answer.text);
    let build = body(&answer.text);
    assert_eq!(build["run"]["number"], json!(9));
    assert_eq!(build["run"]["status"], json!("in_progress"));
    assert_eq!(build["run"]["startedAt"], json!("2026-10-07T10:00:00Z"));
    assert!(build["run"].get("completedAt").is_none(), "{build}");
    // The failed run is no estimate; the last success took 3 min 5 s.
    assert_eq!(build["typicalSeconds"], json!(185), "{build}");
}

/// No successful run yet is no estimate rather than a guess.
#[tokio::test]
async fn without_a_finished_success_there_is_no_estimate() {
    let gitea = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(format!("{REPO}/actions/runs")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "workflow_runs": [{ "run_number": 1, "status": "queued", "head_sha": COMMIT }],
        })))
        .mount(&gitea)
        .await;
    let state = state_with(&gitea, true);
    let answer = send(
        &state,
        person("jana"),
        "GET",
        "/api/v1/projects/helsinki/apps/bikes/build",
        None,
    )
    .await;
    let build = body(&answer.text);
    assert!(build.get("typicalSeconds").is_none(), "{build}");
    assert_eq!(build["run"]["number"], json!(1));
}
