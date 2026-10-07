//! The history of a project's changes (T-3292, API/01 §5): what was merged or rejected, by whom,
//! newest first and paged, under the read rule of the open list (PF-59, R20).

mod common;

use serde_json::{json, Value};
use wiremock::matchers::{method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

use common::{envelope, person, send, state_on, REPO};
use joinedcontext_portal::permissions::ORG_NAMESPACE;
use joinedcontext_portal::state::AppState;

const PROJECT: &str = "ovzdusie";
const APPROVER: &str = "eva.approver@banskabystrica.sk";

fn closed(number: u64, branch: &str, merged: bool, sha: &str) -> Value {
    json!({
        "number": number,
        "html_url": format!("https://gitea.example.sk/pulls/{number}"),
        "state": "closed",
        "title": branch,
        "head": { "ref": branch, "sha": format!("head-{number}") },
        "base": { "ref": "main" },
        "created_at": format!("2026-10-0{number}T09:00:00Z"),
        "closed_at": format!("2026-10-0{number}T10:00:00Z"),
        "user": { "login": "jana", "full_name": "Jana Kováčová", "email": "jana@banskabystrica.sk" },
        "merged": merged,
        "merge_commit_sha": sha,
    })
}

async fn files(forge: &MockServer, number: u64, listed: Value) {
    Mock::given(method("GET"))
        .and(path(format!("{REPO}/pulls/{number}/files")))
        .respond_with(ResponseTemplate::new(200).set_body_json(listed))
        .mount(forge)
        .await;
}

/// A forge whose closed merge requests are: a space created and merged, an endpoint update
/// rejected with a reason, a sync proposal that is no Change, and a space of the project next door.
async fn world() -> (MockServer, AppState) {
    let forge = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(format!("{REPO}/pulls")))
        .and(query_param("state", "closed"))
        .and(query_param("page", "1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([
            closed(
                4,
                "portal/create-contextspace-elsewhere-44444444",
                true,
                "merge-4"
            ),
            closed(3, "mirror/bb-peer", true, "merge-3"),
            closed(2, "portal/update-endpoint-public-air-22222222", false, ""),
            closed(
                1,
                "portal/create-contextspace-mobility-11111111",
                true,
                "merge-1"
            ),
        ])))
        .mount(&forge)
        .await;
    files(&forge, 1, json!([{ "filename": format!("projects/{PROJECT}/spaces/mobility/space.yaml"), "status": "added" }])).await;
    files(&forge, 2, json!([{ "filename": format!("projects/{PROJECT}/spaces/air/endpoints/public-air.yaml"), "status": "modified" }])).await;
    files(
        &forge,
        4,
        json!([{ "filename": "projects/doprava/spaces/elsewhere/space.yaml", "status": "added" }]),
    )
    .await;
    Mock::given(method("GET"))
        .and(path(format!("{REPO}/git/commits/merge-1")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "sha": "merge-1",
            "commit": { "message": format!(
                "Merge change proposal chg-00000001: create ContextSpace mobility\n\nApproved in the Portal by {APPROVER}"
            ) }
        })))
        .mount(&forge)
        .await;
    Mock::given(method("GET"))
        .and(path(format!("{REPO}/pulls/2/reviews")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([
            { "body": "looks fine to me" },
            { "body": format!("Change proposal rejected in the Portal by {APPROVER}: the URL is the old one") }
        ])))
        .mount(&forge)
        .await;

    let state = state_on(&forge);
    for (role, kinds) in [
        ("space-reader", json!(["ContextSpace"])),
        ("all-reader", json!(["ContextSpace", "Endpoint"])),
    ] {
        state.mirror.upsert(envelope(
            "Role",
            role,
            ORG_NAMESPACE,
            json!({ "rules": [{ "kinds": kinds, "verbs": ["read"] }] }),
        ));
    }
    for (binding, user, role) in [
        ("spaces", "peter@hel.fi", "space-reader"),
        ("everything", "anna@hel.fi", "all-reader"),
    ] {
        state.mirror.upsert(envelope(
            "RoleBinding",
            binding,
            ORG_NAMESPACE,
            json!({ "subjects": [{ "user": user }], "role": role, "scope": { "organization": "bb" } }),
        ));
    }
    (forge, state)
}

async fn history(state: &AppState, who: &str, query: &str) -> (u16, Value) {
    let answer = send(
        state,
        person(who),
        "GET",
        &format!("/api/v1/projects/{PROJECT}/changes/history{query}"),
        None,
    )
    .await;
    (
        answer.status.as_u16(),
        serde_json::from_str(&answer.text).unwrap_or(Value::Null),
    )
}

fn ids(list: &Value) -> Vec<&str> {
    list["items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item["metadata"]["name"].as_str())
        .collect()
}

#[tokio::test]
async fn the_history_names_each_closed_change_its_outcome_and_who_decided_it() {
    let (forge, state) = world().await;
    let (status, list) = history(&state, "anna", "").await;
    assert_eq!(status, 200, "{list}");
    // The sync proposal is no Change, the space next door is another project's.
    assert_eq!(ids(&list), vec!["chg-00000002", "chg-00000001"], "{list}");

    let rejected = &list["items"][0];
    assert_eq!(rejected["status"]["phase"], json!("Rejected"));
    assert_eq!(rejected["summary"]["params"]["kind"], json!("Endpoint"));
    assert_eq!(rejected["summary"]["params"]["name"], json!("public-air"));
    assert_eq!(rejected["decision"]["by"], json!(APPROVER));
    assert_eq!(
        rejected["decision"]["reason"],
        json!("the URL is the old one")
    );
    assert_eq!(rejected["decision"]["at"], json!("2026-10-02T10:00:00Z"));

    let merged = &list["items"][1];
    assert_eq!(merged["status"]["phase"], json!("Merged"));
    assert_eq!(merged["summary"]["key"], json!("change.summary.create"));
    assert_eq!(merged["summary"]["params"]["name"], json!("mobility"));
    assert_eq!(merged["decision"]["by"], json!(APPROVER));
    assert!(merged["decision"].get("reason").is_none(), "{merged}");

    // A page shorter than the forge's page is the last one.
    assert!(list.get("next").is_none(), "{list}");
    let writes: Vec<String> = forge
        .received_requests()
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|request| request.method.as_str() != "GET")
        .map(|request| request.url.path().to_owned())
        .collect();
    assert!(writes.is_empty(), "a read wrote to the forge: {writes:?}");
}

/// PF-59, R20: the open list's read rule. A change to a kind the caller does not read is not
/// there, and a project no binding covers is the 404 of one that does not exist.
#[tokio::test]
async fn the_history_keeps_the_read_rule_of_the_open_list() {
    let (_forge, state) = world().await;
    let (status, list) = history(&state, "peter", "").await;
    assert_eq!(status, 200, "{list}");
    assert_eq!(ids(&list), vec!["chg-00000001"], "{list}");
    assert!(!list.to_string().contains("public-air"), "{list}");

    let (status, body) = history(&state, "nobody", "").await;
    assert_eq!(status, 404, "{body}");
}

#[tokio::test]
async fn the_history_filters_by_kind_and_name_and_refuses_what_it_cannot_read() {
    let (_forge, state) = world().await;
    let (_, by_kind) = history(&state, "anna", "?kind=endpoint").await;
    assert_eq!(ids(&by_kind), vec!["chg-00000002"], "{by_kind}");
    let (_, by_name) = history(&state, "anna", "?name=MOB").await;
    assert_eq!(ids(&by_name), vec!["chg-00000001"], "{by_name}");
    let (_, none) = history(&state, "anna", "?name=nothing-like-it").await;
    assert_eq!(ids(&none), Vec::<&str>::new(), "{none}");

    for bad in ["?page=0", "?page=-1", "?state=open", "?page=x"] {
        let (status, body) = history(&state, "anna", bad).await;
        assert_eq!(status, 400, "{bad}: {body}");
    }
}

/// A full page of the forge's says there is an older one, even when none of it was a Change.
#[tokio::test]
async fn a_full_forge_page_points_at_the_next_one() {
    let forge = MockServer::start().await;
    let page: Vec<Value> = (1..=20)
        .map(|n| closed(n, "mirror/bb-peer", true, ""))
        .collect();
    Mock::given(method("GET"))
        .and(path(format!("{REPO}/pulls")))
        .and(query_param("page", "1"))
        .and(query_param("limit", "20"))
        .respond_with(ResponseTemplate::new(200).set_body_json(page))
        .mount(&forge)
        .await;
    let state = state_on(&forge);
    state.mirror.upsert(envelope(
        "Role",
        "reader",
        ORG_NAMESPACE,
        json!({ "rules": [{ "kinds": ["ContextSpace"], "verbs": ["read"] }] }),
    ));
    state.mirror.upsert(envelope(
        "RoleBinding",
        "readers",
        ORG_NAMESPACE,
        json!({ "subjects": [{ "user": "anna@hel.fi" }], "role": "reader", "scope": { "organization": "bb" } }),
    ));
    let (status, list) = history(&state, "anna", "").await;
    assert_eq!(status, 200, "{list}");
    assert_eq!(list["items"], json!([]));
    assert_eq!(list["next"], json!(2));
}
