//! Bringing back what a merged removal took (T-3247, API/01 §5): every file the change deleted,
//! read at the commit it was cut from, proposed again as one change; refused for a change that is
//! not merged, removed nothing, or whose resource is back, and for a caller who may not propose it.

mod common;

use serde_json::{json, Value};
use wiremock::matchers::{method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

use common::{encode, envelope, forge, person, send, state_on, REPO};
use joinedcontext_portal::permissions::ORG_NAMESPACE;
use joinedcontext_portal::state::AppState;

const PROJECT: &str = "ovzdusie";
const MANIFEST: &str = "projects/ovzdusie/spaces/air/pipelines/air-ingest/pipeline.yaml";
const NATIVE: &str = "projects/ovzdusie/spaces/air/pipelines/air-ingest/bento.yaml";
const YAML: &str = "apiVersion: joinedcontext.com/v1alpha1\nkind: Pipeline\nmetadata:\n  name: air-ingest\n  namespace: ovzdusie\nspec:\n  contextSpaceRef:\n    name: air\n";

fn pull(number: u64, branch: &str, merged: bool) -> Value {
    json!({
        "number": number,
        "html_url": format!("https://gitea.example/pulls/{number}"),
        "state": if merged { "closed" } else { "open" },
        "title": branch,
        "head": { "ref": branch, "sha": format!("head-{number}") },
        "base": { "ref": "main" },
        "merged": merged,
        "merge_base": "base-7",
        "user": { "login": "jana" }
    })
}

/// Change 7 removed the pipeline `air-ingest` and its bento file and is merged; change 8 is still
/// open; change 6 changed a file and removed nothing.
async fn world() -> (MockServer, AppState) {
    let gitea = forge().await;
    Mock::given(method("GET"))
        .and(path(REPO))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "default_branch": "main" })))
        .mount(&gitea)
        .await;
    for (number, branch, merged, files) in [
        (
            7,
            "portal/delete-pipeline-air-ingest-0a1b2c3d",
            true,
            json!([
                { "filename": MANIFEST, "status": "deleted" },
                { "filename": NATIVE, "status": "deleted" },
                { "filename": "users/someone.yaml", "status": "deleted" }
            ]),
        ),
        (
            8,
            "portal/delete-pipeline-air-ingest-0a1b2c3d_1a2b3c4d",
            false,
            json!([{ "filename": MANIFEST, "status": "deleted" }]),
        ),
        (
            6,
            "portal/update-pipeline-air-ingest-0a1b2c3d",
            true,
            json!([{ "filename": MANIFEST, "status": "modified" }]),
        ),
    ] {
        Mock::given(method("GET"))
            .and(path(format!("{REPO}/pulls/{number}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(pull(number, branch, merged)))
            .mount(&gitea)
            .await;
        Mock::given(method("GET"))
            .and(path(format!("{REPO}/pulls/{number}/files")))
            .respond_with(ResponseTemplate::new(200).set_body_json(files))
            .mount(&gitea)
            .await;
    }
    for (file, content) in [(MANIFEST, YAML), (NATIVE, "input:\n  generate: {}\n")] {
        Mock::given(method("GET"))
            .and(path(format!("{REPO}/contents/{file}")))
            .and(query_param("ref", "base-7"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({ "sha": "blob", "content": encode(content) })),
            )
            .mount(&gitea)
            .await;
    }
    let state = state_on(&gitea);
    for (role, verbs) in [
        ("restorer", json!(["read", "propose"])),
        ("reader", json!(["read"])),
    ] {
        state.mirror.upsert(envelope(
            "Role",
            role,
            ORG_NAMESPACE,
            json!({ "rules": [{ "kinds": ["Pipeline"], "verbs": verbs }] }),
        ));
        state.mirror.upsert(envelope(
            "RoleBinding",
            &format!("{role}s"),
            ORG_NAMESPACE,
            json!({ "subjects": [{ "user": format!("{role}@hel.fi") }], "role": role, "scope": { "project": PROJECT } }),
        ));
    }
    (gitea, state)
}

async fn restore(state: &AppState, who: &str, id: &str) -> (u16, Value) {
    let answer = send(
        state,
        person(who),
        "POST",
        &format!("/api/v1/projects/{PROJECT}/changes/{id}/restore"),
        None,
    )
    .await;
    (
        answer.status.as_u16(),
        serde_json::from_str(&answer.text).unwrap_or(Value::Null),
    )
}

async fn writes(gitea: &MockServer) -> Vec<(String, String, String)> {
    gitea
        .received_requests()
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|request| request.method.as_str() != "GET")
        .map(|request| {
            (
                request.method.to_string(),
                request.url.path().to_owned(),
                String::from_utf8_lossy(&request.body).into_owned(),
            )
        })
        .collect()
}

#[tokio::test]
async fn a_merged_removal_is_proposed_again_as_one_change_with_every_file_it_removed() {
    let (gitea, state) = world().await;
    let (status, body) = restore(&state, "restorer", "chg-00000007").await;
    assert_eq!(status, 202, "{body}");
    assert_eq!(body["metadata"]["name"], json!("chg-00000009"), "{body}");
    assert_eq!(body["status"]["phase"], json!("PendingApproval"));
    assert_eq!(body["status"]["plan"]["create"], json!(1));

    let sent = writes(&gitea).await;
    let branch = sent
        .iter()
        .find(|(_, path, _)| path.ends_with("/branches"))
        .expect("a branch");
    assert!(branch.2.contains("portal/restore-00000007"), "{branch:?}");
    let commit = sent
        .iter()
        .find(|(_, path, _)| path.ends_with("/contents"))
        .expect("one commit");
    let files: Value = serde_json::from_str(&commit.2).expect("a json commit");
    let paths: Vec<&str> = files["files"]
        .as_array()
        .expect("files")
        .iter()
        .filter_map(|f| f["path"].as_str())
        .collect();
    // The organization's file is no project file: a project's restore brings back its own alone.
    assert_eq!(paths, vec![MANIFEST, NATIVE], "{files}");
    assert!(files["files"]
        .as_array()
        .expect("files")
        .iter()
        .all(|f| f["operation"] == "upload"));
    let opened = sent
        .iter()
        .find(|(_, path, _)| path.ends_with("/pulls"))
        .expect("a merge request");
    assert!(
        opened.2.contains("restore Pipeline air-ingest"),
        "{opened:?}"
    );
}

#[tokio::test]
async fn what_cannot_be_restored_is_refused_in_words_and_nothing_is_written() {
    let (gitea, state) = world().await;
    let (status, body) = restore(&state, "restorer", "chg-00000008").await;
    assert_eq!(status, 409, "{body}");
    assert!(
        body["detail"]
            .as_str()
            .unwrap_or_default()
            .contains("not merged"),
        "{body}"
    );

    let (status, body) = restore(&state, "restorer", "chg-00000006").await;
    assert_eq!(status, 409, "{body}");
    assert!(
        body["detail"]
            .as_str()
            .unwrap_or_default()
            .contains("removed nothing"),
        "{body}"
    );

    // A reader who may not propose a Pipeline is told which verb it needs.
    let (status, body) = restore(&state, "reader", "chg-00000007").await;
    assert_eq!(status, 403, "{body}");
    assert!(
        body["detail"]
            .as_str()
            .unwrap_or_default()
            .contains("propose"),
        "{body}"
    );

    // Nobody's project: the 404 of a change that is not there (R20).
    let (status, _) = restore(&state, "nobody", "chg-00000007").await;
    assert_eq!(status, 404);
    let (status, _) = restore(&state, "restorer", "not-a-change").await;
    assert_eq!(status, 400);

    assert!(
        writes(&gitea).await.is_empty(),
        "a refusal wrote: {:?}",
        writes(&gitea).await
    );
}

#[tokio::test]
async fn a_resource_that_is_back_on_main_is_not_restored_over() {
    let (gitea, state) = world().await;
    Mock::given(method("GET"))
        .and(path(format!("{REPO}/contents/{MANIFEST}")))
        .and(query_param("ref", "main"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({ "sha": "new", "content": encode(YAML) })),
        )
        .mount(&gitea)
        .await;
    let (status, body) = restore(&state, "restorer", "chg-00000007").await;
    assert_eq!(status, 409, "{body}");
    assert!(
        body["detail"]
            .as_str()
            .unwrap_or_default()
            .contains("in the project again"),
        "{body}"
    );
    assert!(writes(&gitea).await.is_empty());
}
