//! People (T-2683, PF-90…PF-94, ADR-N-031, API/01 §24): the whole lifecycle of a person through
//! the realm's admin API, against a stub Keycloak. Every route is held to its verb on `Person`; no
//! route acts on a person who holds a right the caller lacks, so a reset's temporary password
//! never opens a stronger account; nobody disables or deletes themselves or the last Organization
//! Administrator; the temporary password is answered once and never logged; and deleting a
//! person named in the repository is a Change, the Keycloak user going only once it is merged.
//! The deletion's database half runs where `JC_PORTAL_TEST_DATABASE_URL` names a PostgreSQL
//! (ci-full), as the key store's tests do.

mod common;

use std::io::Write;
use std::sync::{Arc, Mutex};

use axum::http::StatusCode;
use serde_json::{json, Value};
use wiremock::matchers::{method, path, path_regex};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

use common::{envelope, forge, person, send, REPO};
use joinedcontext_portal::people::People;
use joinedcontext_portal::permissions::ORG_NAMESPACE;
use joinedcontext_portal::state::AppState;

const PEOPLE: &str = "/api/v1/organization/people";
const ADMIN: &str = "/admin/realms/hel";

fn user(id: &str, email: &str) -> Value {
    json!({
        "id": id, "username": email, "email": email, "firstName": "F", "lastName": "L",
        "enabled": true, "emailVerified": true, "createdTimestamp": 1_758_700_000_000_i64,
        "requiredActions": [], "attributes": { "locale": ["sk"] },
    })
}

/// A realm holding ada (the organization's administrator), pia (people-admin only) and jana (a
/// pipeline reader through the group `stewards`). `smtp` says whether the realm can send mail.
async fn realm(smtp: bool) -> MockServer {
    let kc = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/realms/hel/protocol/openid-connect/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "access_token": "t" })))
        .mount(&kc)
        .await;
    for (id, email) in [
        ("ada-id", "ada@hel.fi"),
        ("pia-id", "pia@hel.fi"),
        ("jana-id", "jana@hel.fi"),
    ] {
        Mock::given(method("GET"))
            .and(path(format!("{ADMIN}/users/{id}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(user(id, email)))
            .mount(&kc)
            .await;
    }
    Mock::given(method("GET"))
        .and(path(format!("{ADMIN}/users/new-id")))
        .respond_with(ResponseTemplate::new(200).set_body_json(user("new-id", "new@example.org")))
        .mount(&kc)
        .await;
    Mock::given(method("POST"))
        .and(path(format!("{ADMIN}/users")))
        .respond_with(
            ResponseTemplate::new(201)
                .insert_header("Location", format!("{}{ADMIN}/users/new-id", kc.uri())),
        )
        .mount(&kc)
        .await;
    Mock::given(method("PUT"))
        .and(path_regex(format!(
            "^{ADMIN}/users/[a-z-]+/execute-actions-email$"
        )))
        .respond_with(if smtp {
            ResponseTemplate::new(204)
        } else {
            ResponseTemplate::new(500)
                .set_body_json(json!({ "errorMessage": "Failed to send execute actions email" }))
        })
        .mount(&kc)
        .await;
    for (verb, pattern) in [
        ("PUT", format!("^{ADMIN}/users/[a-z-]+$")),
        ("PUT", format!("^{ADMIN}/users/[a-z-]+/reset-password$")),
        ("POST", format!("^{ADMIN}/users/[a-z-]+/logout$")),
        ("DELETE", format!("^{ADMIN}/users/[a-z-]+$")),
    ] {
        Mock::given(method(verb))
            .and(path_regex(pattern))
            .respond_with(ResponseTemplate::new(204))
            .mount(&kc)
            .await;
    }
    for pattern in [
        "groups",
        "role-mappings/realm/composite",
        "sessions",
        "credentials",
    ] {
        Mock::given(method("GET"))
            .and(path_regex(format!("^{ADMIN}/users/[a-z-]+/{pattern}$")))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([])))
            .mount(&kc)
            .await;
    }
    Mock::given(method("GET"))
        .and(path(format!("{ADMIN}/users")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([
            user("ada-id", "ada@hel.fi"),
            user("jana-id", "jana@hel.fi"),
            user("pia-id", "pia@hel.fi"),
        ])))
        .mount(&kc)
        .await;
    kc
}

fn state_with(kc: &MockServer, gitea: &MockServer) -> AppState {
    let mut state = common::state_on(gitea);
    state.people = People::new(
        &format!("{}/realms/hel", kc.uri()),
        "portal".into(),
        "secret".into(),
    )
    .map(Arc::new);
    organization(&state);
    state
}

fn organization(state: &AppState) {
    let people =
        json!({ "kinds": ["Person"], "verbs": ["read", "create", "update", "disable", "delete"] });
    let mirror = &state.mirror;
    mirror.upsert(envelope(
        "Role",
        "people-admin",
        ORG_NAMESPACE,
        json!({ "rules": [people.clone()] }),
    ));
    mirror.upsert(envelope(
        "Role",
        "org-admin",
        ORG_NAMESPACE,
        json!({ "rules": [
            { "kinds": ["Pipeline", "Group", "Role", "RoleBinding"], "verbs": ["read", "propose", "approve", "delete"] },
            people,
        ]}),
    ));
    mirror.upsert(envelope(
        "Role",
        "pipeline-reader",
        ORG_NAMESPACE,
        json!({ "rules": [{ "kinds": ["Pipeline"], "verbs": ["read"] }] }),
    ));
    for (name, subjects, role) in [
        ("admins", json!([{ "user": "ada@hel.fi" }]), "org-admin"),
        (
            "people-admins",
            json!([{ "user": "pia@hel.fi" }]),
            "people-admin",
        ),
        (
            "readers",
            json!([{ "group": "stewards" }]),
            "pipeline-reader",
        ),
        (
            "jana-alone",
            json!([{ "user": "jana@hel.fi" }]),
            "pipeline-reader",
        ),
    ] {
        mirror.upsert(envelope(
            "RoleBinding",
            name,
            ORG_NAMESPACE,
            json!({ "subjects": subjects, "role": role, "scope": { "organization": "hel" } }),
        ));
    }
    mirror.upsert(envelope(
        "Group",
        "stewards",
        ORG_NAMESPACE,
        json!({ "members": [{ "user": "jana@hel.fi" }, { "user": "eva@hel.fi" }] }),
    ));
}

async fn received(kc: &MockServer, verb: &str, suffix: &str) -> Vec<Request> {
    kc.received_requests()
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|r| r.method.as_str() == verb && r.url.path().ends_with(suffix))
        .collect()
}

#[derive(Clone, Default)]
struct Log(Arc<Mutex<Vec<u8>>>);

impl Write for Log {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0
            .lock()
            .map_err(|_| std::io::Error::other("poisoned"))?
            .extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// PF-92: creating a person sends the realm's execute-actions e-mail and answers no password.
#[tokio::test]
async fn creating_a_person_sends_the_realms_actions_email() {
    let (kc, gitea) = (realm(true).await, forge().await);
    let state = state_with(&kc, &gitea);
    let body = json!({ "email": " New@Example.org ", "firstName": "Nora", "lastName": "Nová", "locale": "sk" });

    let created = send(&state, person("pia"), "POST", PEOPLE, Some(body)).await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.text);
    let answer: Value = serde_json::from_str(&created.text).expect("json");
    assert_eq!(answer["emailSent"], true);
    assert!(answer.get("temporaryPassword").is_none(), "{answer}");

    let posted = received(&kc, "POST", "/users").await;
    let user: Value = serde_json::from_slice(&posted[0].body).expect("a user");
    assert_eq!(user["email"], "new@example.org");
    assert_eq!(user["username"], "new@example.org");
    assert_eq!(user["attributes"]["locale"], json!(["sk"]));
    let actions = received(&kc, "PUT", "/new-id/execute-actions-email").await;
    let asked: Value = serde_json::from_slice(&actions[0].body).expect("actions");
    assert_eq!(asked, json!(["VERIFY_EMAIL", "UPDATE_PASSWORD"]));
}

/// PF-92: without SMTP the creator gets a temporary password once; it never reaches the log.
#[tokio::test]
async fn without_smtp_a_temporary_password_is_answered_once_and_never_logged() {
    let (kc, gitea) = (realm(false).await, forge().await);
    let state = state_with(&kc, &gitea);
    let log = Log::default();
    let writer = log.clone();
    let _guard = tracing::subscriber::set_default(
        tracing_subscriber::fmt()
            .with_max_level(tracing::Level::TRACE)
            .with_writer(move || writer.clone())
            .finish(),
    );

    let created = send(
        &state,
        person("pia"),
        "POST",
        PEOPLE,
        Some(json!({ "email": "new@example.org", "firstName": "Nora", "lastName": "Nová" })),
    )
    .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.text);
    let answer: Value = serde_json::from_str(&created.text).expect("json");
    assert_eq!(answer["emailSent"], false);
    let password = answer["temporaryPassword"]
        .as_str()
        .expect("a temporary password")
        .to_owned();
    assert!(
        password.len() >= 20,
        "the strictest realm policy asks for 20"
    );

    let set = received(&kc, "PUT", "/new-id/reset-password").await;
    let credential: Value = serde_json::from_slice(&set[0].body).expect("a credential");
    assert_eq!(
        credential["temporary"], true,
        "the person must set their own at the first login"
    );
    assert_eq!(credential["value"], password.as_str());

    let logged = String::from_utf8_lossy(&log.0.lock().expect("log")).into_owned();
    assert!(
        !logged.contains(&password),
        "the temporary password reached the log"
    );

    // Reading the person again answers no password: it was shown once.
    let read = send(
        &state,
        person("pia"),
        "GET",
        &format!("{PEOPLE}/new-id"),
        None,
    )
    .await;
    assert_eq!(read.status, StatusCode::OK, "{}", read.text);
    assert!(!read.text.contains(&password));
}

/// PF-93: disabling ends every session; the person is written back whole, `enabled: false`.
#[tokio::test]
async fn disabling_a_person_ends_their_sessions() {
    let (kc, gitea) = (realm(true).await, forge().await);
    let state = state_with(&kc, &gitea);

    let answer = send(
        &state,
        person("ada"),
        "POST",
        &format!("{PEOPLE}/jana-id/disable"),
        None,
    )
    .await;
    assert_eq!(answer.status, StatusCode::OK, "{}", answer.text);
    let put = received(&kc, "PUT", "/users/jana-id").await;
    let written: Value = serde_json::from_slice(&put[0].body).expect("a user");
    assert_eq!(written["enabled"], false);
    assert_eq!(
        written["attributes"]["locale"],
        json!(["sk"]),
        "what the Portal does not edit survives"
    );
    assert_eq!(
        received(&kc, "POST", "/users/jana-id/logout").await.len(),
        1
    );
}

/// PF-93 (integrator's review): a people-admin who is not an administrator cannot reset an
/// administrator's password, or anyone's who holds a right they lack; no password is set or sent.
#[tokio::test]
async fn a_people_admin_cannot_act_on_a_person_holding_a_right_they_lack() {
    let (kc, gitea) = (realm(false).await, forge().await);
    let state = state_with(&kc, &gitea);

    for target in ["ada-id", "jana-id"] {
        let refused = send(
            &state,
            person("pia"),
            "POST",
            &format!("{PEOPLE}/{target}/reset-password"),
            None,
        )
        .await;
        assert_eq!(
            refused.status,
            StatusCode::FORBIDDEN,
            "{target}: {}",
            refused.text
        );
        assert!(
            refused.text.contains("holds a right you do not"),
            "{}",
            refused.text
        );
        assert!(!refused.text.contains("temporaryPassword"));
    }
    assert!(
        received(&kc, "PUT", "/reset-password").await.is_empty(),
        "no password was set"
    );
    assert!(
        received(&kc, "PUT", "/execute-actions-email")
            .await
            .is_empty(),
        "no e-mail was sent"
    );

    // A person holding no more than the caller is theirs to reset.
    let own_level = send(
        &state,
        person("ada"),
        "POST",
        &format!("{PEOPLE}/pia-id/reset-password"),
        None,
    )
    .await;
    assert_eq!(own_level.status, StatusCode::OK, "{}", own_level.text);
}

/// PF-93, PF-03: nobody disables or deletes themselves, or the last Organization Administrator.
#[tokio::test]
async fn the_last_administrator_is_not_disabled_or_deleted() {
    let (kc, gitea) = (realm(true).await, forge().await);
    let state = state_with(&kc, &gitea);

    for (verb, route) in [
        ("POST", format!("{PEOPLE}/ada-id/disable")),
        ("DELETE", format!("{PEOPLE}/ada-id")),
    ] {
        let refused = send(&state, person("ada"), verb, &route, None).await;
        assert_eq!(
            refused.status,
            StatusCode::CONFLICT,
            "{route}: {}",
            refused.text
        );
        assert!(refused.text.contains("yourself"), "{}", refused.text);
    }
    // The bootstrap group may do everything, except leave the organization without its administrator.
    let mut root = person("root");
    root.groups = vec![state.config.bootstrap_admins.clone()];
    let refused = send(
        &state,
        root,
        "POST",
        &format!("{PEOPLE}/ada-id/disable"),
        None,
    )
    .await;
    assert_eq!(refused.status, StatusCode::CONFLICT, "{}", refused.text);
    assert!(
        refused.text.contains("last Organization Administrator"),
        "{}",
        refused.text
    );
    assert!(received(&kc, "PUT", "/users/ada-id").await.is_empty());
}

/// PF-91: every route refuses a caller whose role grants nothing on Person, with 403.
#[tokio::test]
async fn a_caller_without_people_admin_is_refused_on_every_route() {
    let (kc, gitea) = (realm(true).await, forge().await);
    let state = state_with(&kc, &gitea);
    let routes = [
        ("GET", PEOPLE.to_owned(), None),
        (
            "POST",
            PEOPLE.to_owned(),
            Some(json!({ "email": "x@example.org", "firstName": "X", "lastName": "Y" })),
        ),
        ("GET", format!("{PEOPLE}/jana-id"), None),
        (
            "PATCH",
            format!("{PEOPLE}/jana-id"),
            Some(json!({ "firstName": "Z" })),
        ),
        ("POST", format!("{PEOPLE}/jana-id/disable"), None),
        ("POST", format!("{PEOPLE}/jana-id/enable"), None),
        ("POST", format!("{PEOPLE}/jana-id/reset-password"), None),
        (
            "POST",
            format!("{PEOPLE}/jana-id/remove-second-factor"),
            None,
        ),
        ("POST", format!("{PEOPLE}/jana-id/sign-out"), None),
        ("DELETE", format!("{PEOPLE}/jana-id"), None),
    ];
    for (verb, route, body) in routes {
        let refused = send(&state, person("jana"), verb, &route, body).await;
        assert_eq!(
            refused.status,
            StatusCode::FORBIDDEN,
            "{verb} {route}: {}",
            refused.text
        );
        assert!(
            refused.text.contains("Person"),
            "{verb} {route}: {}",
            refused.text
        );
    }
    let wrote = kc
        .received_requests()
        .await
        .unwrap_or_default()
        .iter()
        .any(|r| r.url.path().starts_with(ADMIN));
    assert!(!wrote, "nothing reached the realm's admin API");
}

/// PF-92: an e-mail another person has is a 409 naming it; bad input is a 400 in RFC 7807.
#[tokio::test]
async fn a_taken_email_is_a_conflict_and_bad_input_a_bad_request() {
    let (kc, gitea) = (realm(true).await, forge().await);
    Mock::given(method("POST"))
        .and(path(format!("{ADMIN}/users")))
        .respond_with(
            ResponseTemplate::new(409)
                .set_body_json(json!({ "errorMessage": "User exists with same email" })),
        )
        .with_priority(1)
        .mount(&kc)
        .await;
    let state = state_with(&kc, &gitea);

    let taken = send(
        &state,
        person("pia"),
        "POST",
        PEOPLE,
        Some(json!({ "email": "jana@hel.fi", "firstName": "J", "lastName": "K" })),
    )
    .await;
    assert_eq!(taken.status, StatusCode::CONFLICT, "{}", taken.text);
    assert!(taken.text.contains("jana@hel.fi"), "{}", taken.text);

    for body in [
        json!({ "email": "not-an-address", "firstName": "J", "lastName": "K" }),
        json!({ "email": "a@example.org", "firstName": " ", "lastName": "K" }),
        json!({ "email": "a@example.org", "firstName": "J", "lastName": "K", "locale": "fr" }),
        json!({ "email": "a@example.org", "firstName": "J", "lastName": "K", "password": "x" }),
    ] {
        let refused = send(&state, person("pia"), "POST", PEOPLE, Some(body.clone())).await;
        assert_eq!(
            refused.status,
            StatusCode::BAD_REQUEST,
            "{body}: {}",
            refused.text
        );
        assert!(
            refused.text.contains("\"status\":400"),
            "RFC 7807: {}",
            refused.text
        );
    }
    let paged = send(
        &state,
        person("pia"),
        "GET",
        &format!("{PEOPLE}?max=500"),
        None,
    )
    .await;
    assert_eq!(paged.status, StatusCode::BAD_REQUEST, "{}", paged.text);
}

/// PF-94: a person's page lists their groups, platform roles with scope and way, and app roles.
#[tokio::test]
async fn a_persons_page_names_their_groups_and_roles() {
    let (kc, gitea) = (realm(true).await, forge().await);
    let state = state_with(&kc, &gitea);
    state.mirror.upsert(envelope(
        "App",
        "alerts",
        "helsinki",
        json!({ "kind": "static", "roles": [{ "name": "viewer" }], "access": [{ "role": "viewer", "subjects": [{ "group": "stewards" }] }] }),
    ));

    let read = send(
        &state,
        person("pia"),
        "GET",
        &format!("{PEOPLE}/jana-id"),
        None,
    )
    .await;
    assert_eq!(read.status, StatusCode::OK, "{}", read.text);
    let detail: Value = serde_json::from_str(&read.text).expect("json");
    assert_eq!(detail["person"]["email"], "jana@hel.fi");
    assert_eq!(detail["groups"], json!([{ "name": "stewards" }]));
    let ways: Vec<Value> = detail["platformRoles"]
        .as_array()
        .expect("roles")
        .iter()
        .map(|r| r["via"].clone())
        .collect();
    assert!(
        ways.contains(&json!({ "group": "stewards" }))
            && ways.contains(&json!({ "user": "jana@hel.fi" })),
        "{ways:?}"
    );
    assert_eq!(
        detail["appRoles"],
        json!([{ "project": "helsinki", "app": "alerts", "role": "viewer", "via": { "group": "stewards" } }])
    );
}

/// PF-93: deleting a person named in the repository proposes one Change taking them out of every
/// Group and RoleBinding, disables them at once, and deletes the Keycloak user only once that
/// Change is merged. Needs a PostgreSQL (ci-full); without one it says so and checks nothing.
#[tokio::test]
async fn deleting_a_person_proposes_the_change_and_deletes_them_only_after_the_merge() {
    let Some(url) = std::env::var("JC_PORTAL_TEST_DATABASE_URL")
        .ok()
        .filter(|u| !u.trim().is_empty())
    else {
        eprintln!("skipped: JC_PORTAL_TEST_DATABASE_URL is not set");
        return;
    };
    let pool = joinedcontext_portal::db::connect(&url)
        .await
        .expect("connect + migrate");
    joinedcontext_portal::db::remove_person_deletion(&pool, "jana-id")
        .await
        .expect("a clean row");
    let (kc, gitea) = (realm(true).await, forge().await);
    Mock::given(method("GET"))
        .and(path_regex(format!("^{REPO}/contents/.+")))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({ "sha": "blob-1", "content": "" })),
        )
        .with_priority(5)
        .mount(&gitea)
        .await;
    let mut state = state_with(&kc, &gitea).with_db(pool.clone());
    state.people = People::new(
        &format!("{}/realms/hel", kc.uri()),
        "portal".into(),
        "secret".into(),
    )
    .map(Arc::new);

    let answer = send(
        &state,
        person("ada"),
        "DELETE",
        &format!("{PEOPLE}/jana-id"),
        None,
    )
    .await;
    assert_eq!(answer.status, StatusCode::ACCEPTED, "{}", answer.text);

    let commits: Vec<Value> = gitea
        .received_requests()
        .await
        .unwrap_or_default()
        .iter()
        .filter(|r| r.method.as_str() == "POST" && r.url.path() == format!("{REPO}/contents"))
        .filter_map(|r| serde_json::from_slice(&r.body).ok())
        .collect();
    let files = commits[0]["files"].as_array().expect("files").clone();
    let find = |suffix: &str| {
        files
            .iter()
            .find(|f| f["path"].as_str().is_some_and(|p| p.ends_with(suffix)))
            .cloned()
    };
    assert_eq!(
        find("groups/stewards.yaml").expect("the group is edited")["operation"],
        "upload"
    );
    assert_eq!(
        find("jana-alone.yaml").expect("her own binding goes")["operation"],
        "delete"
    );
    assert!(
        find("readers.yaml").is_none(),
        "a binding naming her group only is not touched"
    );

    let disabled = received(&kc, "PUT", "/users/jana-id").await;
    assert_eq!(
        serde_json::from_slice::<Value>(&disabled[0].body).expect("user")["enabled"],
        false
    );
    assert!(
        received(&kc, "DELETE", "/users/jana-id").await.is_empty(),
        "not before the merge"
    );

    // A second removal while this one is open is refused.
    let again = send(
        &state,
        person("ada"),
        "DELETE",
        &format!("{PEOPLE}/jana-id"),
        None,
    )
    .await;
    assert_eq!(again.status, StatusCode::CONFLICT, "{}", again.text);

    let pull = |merged: bool, state: &str| json!({ "number": 9, "html_url": "https://gitea.example/pulls/9", "state": state, "merged": merged });
    Mock::given(method("GET"))
        .and(path(format!("{REPO}/pulls/9")))
        .respond_with(ResponseTemplate::new(200).set_body_json(pull(false, "open")))
        .up_to_n_times(1)
        .with_priority(1)
        .mount(&gitea)
        .await;
    Mock::given(method("GET"))
        .and(path(format!("{REPO}/pulls/9")))
        .respond_with(ResponseTemplate::new(200).set_body_json(pull(true, "closed")))
        .with_priority(2)
        .mount(&gitea)
        .await;
    let people = state.people.clone().expect("people");
    let forge_client = state.forge_for(ORG_NAMESPACE).expect("forge");
    joinedcontext_portal::api::people::finish_deletions(&people, &pool, &forge_client).await;
    assert!(
        received(&kc, "DELETE", "/users/jana-id").await.is_empty(),
        "the Change is still open"
    );
    joinedcontext_portal::api::people::finish_deletions(&people, &pool, &forge_client).await;
    assert_eq!(
        received(&kc, "DELETE", "/users/jana-id").await.len(),
        1,
        "merged: the user goes"
    );
    assert!(joinedcontext_portal::db::person_deletion(&pool, "jana-id")
        .await
        .expect("read")
        .is_none());
}

/// A person nothing in the repository names is deleted at once.
#[tokio::test]
async fn a_person_nothing_names_is_deleted_at_once() {
    let (kc, gitea) = (realm(true).await, forge().await);
    let state = state_with(&kc, &gitea);

    let answer = send(
        &state,
        person("ada"),
        "DELETE",
        &format!("{PEOPLE}/pia-id"),
        None,
    )
    .await;
    // pia is named by `people-admins`: that is a Change, so give her a colleague who is named nowhere.
    assert_eq!(
        answer.status,
        StatusCode::SERVICE_UNAVAILABLE,
        "no database holds the pending removal: {}",
        answer.text
    );
    Mock::given(method("GET"))
        .and(path(format!("{ADMIN}/users/eva-id")))
        .respond_with(ResponseTemplate::new(200).set_body_json(user("eva-id", "eve@example.org")))
        .mount(&kc)
        .await;
    let answer = send(
        &state,
        person("ada"),
        "DELETE",
        &format!("{PEOPLE}/eva-id"),
        None,
    )
    .await;
    assert_eq!(answer.status, StatusCode::NO_CONTENT, "{}", answer.text);
    assert_eq!(received(&kc, "DELETE", "/users/eva-id").await.len(), 1);
}
