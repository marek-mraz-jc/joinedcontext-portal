//! ServiceAccount API keys through the real router (T-0189, PF-36, PF-37, PF-38, PF-40).
//!
//! The database tests run when `JC_PORTAL_TEST_DATABASE_URL` points at a PostgreSQL the test may
//! write to (locally: `docker run -e POSTGRES_PASSWORD=… postgres:17-alpine`); the rest of the
//! file, the parts that decide who may manage an account, needs no database at all.

mod common;

use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use axum_extra::extract::cookie::PrivateCookieJar;
use http_body_util::BodyExt;
use joinedcontext_portal::auth::session::{self, Identity, Session};
use joinedcontext_portal::config::Config;
use joinedcontext_portal::error::ApiError;
use joinedcontext_portal::permissions::ORG_NAMESPACE;
use joinedcontext_portal::resource::{ObjectMeta, ResourceEnvelope, API_VERSION};
use joinedcontext_portal::server;
use joinedcontext_portal::state::AppState;
use joinedcontext_portal::store::Mirror;
use serde_json::{json, Value};
use tower::ServiceExt;

const CSRF: &str = "csrf-token-value";
const OWNER: &str = "jana.kovacova";
/// Named as an owner, with no binding left anywhere: they left the department (T-2487).
const FORMER: &str = "eva.horvathova";

fn session_cookie(config: &Config, username: &str, roles: &[&str]) -> String {
    use axum::response::IntoResponse;
    let now = session::now_unix();
    let session = Session {
        identity: Identity {
            client: None,
            subject: format!("f:1:{username}"),
            username: username.into(),
            email: Some(format!("{username}@banskabystrica.sk")),
            name: None,
            roles: roles.iter().map(|role| role.to_string()).collect(),
            groups: Vec::new(),
        },
        expires_at: now + 3600,
        issued_at: now,
        id_token: "id-token-placeholder".into(),
        access_expires_at: now + 3600,
        refresh_token: None,
    };
    let jar = PrivateCookieJar::new(config.cookie_key.clone());
    let jar = session::store(jar, &session).expect("store session");
    let response = (jar, StatusCode::OK).into_response();
    let mut parts: Vec<String> = response
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .map(|raw| raw.split(';').next().unwrap_or_default().to_string())
        .collect();
    parts.push(format!("jc_csrf={CSRF}"));
    parts.join("; ")
}

fn mirror() -> Arc<Mirror> {
    let mirror = Arc::new(Mirror::new());
    mirror.upsert(ResourceEnvelope {
        api_version: API_VERSION.into(),
        kind: "ServiceAccount".into(),
        metadata: ObjectMeta {
            name: "vendorx-parking-push".into(),
            namespace: Some("banskabystrica".into()),
            ..Default::default()
        },
        spec: json!({
            "owner": { "user": OWNER },
            "purpose": "VendorX pushes ParkingSpot updates every 10 s",
            "roles": [],
            "credentials": [
                { "kind": "oauth-client", "name": "main" },
                { "kind": "api-key", "name": "legacy-push" }
            ]
        }),
        status: None,
    });
    // The same kind of account, owned by a person who holds no binding in the project any more.
    mirror.upsert(ResourceEnvelope {
        api_version: API_VERSION.into(),
        kind: "ServiceAccount".into(),
        metadata: ObjectMeta {
            name: "air-push".into(),
            namespace: Some("banskabystrica".into()),
            ..Default::default()
        },
        spec: json!({
            "owner": { "user": FORMER },
            "purpose": "Pushes the air-quality readings of the city gateway",
            "roles": [],
            "credentials": [{ "kind": "api-key", "name": "legacy-push" }]
        }),
        status: None,
    });
    // The owner still works in the project: one binding that lets them read it.
    for (kind, name, spec) in [
        (
            "Role",
            "project-reader",
            json!({ "rules": [{ "kinds": ["ServiceAccount"], "verbs": ["read"] }] }),
        ),
        (
            "RoleBinding",
            "owner-reads-banskabystrica",
            json!({
                "subjects": [{ "user": OWNER }],
                "role": "project-reader",
                "scope": { "project": "banskabystrica" },
            }),
        ),
    ] {
        mirror.upsert(ResourceEnvelope {
            api_version: API_VERSION.into(),
            kind: kind.into(),
            metadata: ObjectMeta {
                name: name.into(),
                namespace: Some(ORG_NAMESPACE.into()),
                ..Default::default()
            },
            spec,
            status: None,
        });
    }
    mirror
}

async fn call(
    app: &axum::Router,
    cookie: &str,
    method: Method,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::COOKIE, cookie)
        .header("x-csrf-token", CSRF);
    let body = match body {
        Some(json) => {
            request = request.header(header::CONTENT_TYPE, "application/json");
            Body::from(json.to_string())
        }
        None => Body::empty(),
    };
    let response = app
        .clone()
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn database_url() -> Option<String> {
    std::env::var("JC_PORTAL_TEST_DATABASE_URL")
        .ok()
        .filter(|url| !url.trim().is_empty())
}

/// The router with a live database, and the very configuration it was built from: the session
/// cookies are encrypted with that config's key, and `Config::for_tests` mints a fresh key on
/// every call, so a second config would produce cookies this router cannot read.
async fn app_with_db() -> Option<(axum::Router, Config)> {
    let url = database_url()?;
    let pool = joinedcontext_portal::db::connect(&url)
        .await
        .expect("connect + migrate");
    let config = Config::for_tests();
    let app = server::app(
        AppState::new(config.clone(), None)
            .with_mirror(mirror())
            .with_db(pool),
    );
    Some((app, config))
}

const KEYS: &str = "/api/v1/projects/banskabystrica/serviceaccounts/vendorx-parking-push/keys";

#[tokio::test]
async fn anonymous_calls_never_reach_the_key_store() {
    let app = server::app(AppState::new(Config::for_tests(), None).with_mirror(mirror()));
    let response = app
        .oneshot(Request::builder().uri(KEYS).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_stranger_is_told_the_account_does_not_exist() {
    let config = Config::for_tests();
    let cookie = session_cookie(&config, "peter.novak", &[]);
    let app = server::app(AppState::new(config, None).with_mirror(mirror()));

    let (status, body) = call(&app, &cookie, Method::GET, KEYS, None).await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "an account a caller may not manage is not disclosed as existing (R20)"
    );
    assert_eq!(body["status"], 404);
}

#[tokio::test]
async fn an_unknown_account_and_a_forbidden_one_answer_the_same() {
    let config = Config::for_tests();
    let cookie = session_cookie(&config, "peter.novak", &[]);
    let app = server::app(AppState::new(config, None).with_mirror(mirror()));

    let (forbidden, _) = call(&app, &cookie, Method::GET, KEYS, None).await;
    let (unknown, _) = call(
        &app,
        &cookie,
        Method::GET,
        "/api/v1/projects/banskabystrica/serviceaccounts/invented/keys",
        None,
    )
    .await;
    assert_eq!(forbidden, unknown);
}

#[tokio::test]
async fn without_a_database_the_owner_gets_503_and_not_an_empty_list() {
    let config = Config::for_tests();
    let cookie = session_cookie(&config, OWNER, &[]);
    let app = server::app(AppState::new(config, None).with_mirror(mirror()));

    let (status, body) = call(&app, &cookie, Method::GET, KEYS, None).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["status"], 503);
}

#[tokio::test]
async fn the_raw_key_is_returned_once_and_never_again() {
    let Some((app, config)) = app_with_db().await else {
        eprintln!("skipped: JC_PORTAL_TEST_DATABASE_URL is not set");
        return;
    };
    let cookie = session_cookie(&config, OWNER, &[]);

    let (status, minted) = call(
        &app,
        &cookie,
        Method::POST,
        KEYS,
        Some(json!({ "credential": "legacy-push" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let token = minted["token"].as_str().expect("a token, once").to_string();
    let key_id = minted["keyId"].as_str().expect("a key id").to_string();
    let secret = token
        .strip_prefix(&format!("jc_{key_id}_"))
        .expect("the token is jc_{keyId}_{secret} (PF-37)");
    assert!(secret.len() >= 40, "32 random bytes in base64: {secret}");

    let (status, listed) = call(&app, &cookie, Method::GET, KEYS, None).await;
    assert_eq!(status, StatusCode::OK);
    let items = listed["items"].as_array().expect("a list");
    let mine = items
        .iter()
        .find(|item| item["keyId"] == key_id.as_str())
        .expect("the key is listed");
    assert!(
        mine.get("token").is_none(),
        "the token is never listed again"
    );
    assert!(
        !listed.to_string().contains(&token),
        "neither the token nor its hash may appear in a listing"
    );
    assert_eq!(mine["credential"], "legacy-push");
}

#[tokio::test]
async fn a_key_for_an_undeclared_credential_is_refused() {
    let Some((app, config)) = app_with_db().await else {
        eprintln!("skipped: JC_PORTAL_TEST_DATABASE_URL is not set");
        return;
    };
    let cookie = session_cookie(&config, OWNER, &[]);

    for credential in ["main", "invented"] {
        let (status, body) = call(
            &app,
            &cookie,
            Method::POST,
            KEYS,
            Some(json!({ "credential": credential })),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "'{credential}' is not an api-key credential of the manifest"
        );
        assert_eq!(body["status"], 400);
    }

    let (status, _) = call(
        &app,
        &cookie,
        Method::POST,
        KEYS,
        Some(json!({ "credential": "legacy-push", "expiresAt": "2020-01-01T00:00:00Z" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "an expiry in the past");
}

#[tokio::test]
async fn rotation_keeps_both_keys_alive_and_revocation_ends_one_now() {
    let Some((app, config)) = app_with_db().await else {
        eprintln!("skipped: JC_PORTAL_TEST_DATABASE_URL is not set");
        return;
    };
    // Not the owner: the platform administrator's realm role is the other way in (CC-60).
    let cookie = session_cookie(&config, "marek.mraz", &["portal-approver"]);

    let (_, first) = call(
        &app,
        &cookie,
        Method::POST,
        KEYS,
        Some(json!({ "credential": "legacy-push" })),
    )
    .await;
    let old_id = first["keyId"].as_str().expect("a key id").to_string();

    let (status, second) = call(
        &app,
        &cookie,
        Method::POST,
        &format!("{KEYS}/{old_id}/rotate"),
        Some(json!({ "overlapHours": 1 })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let new_id = second["keyId"].as_str().expect("a successor").to_string();
    assert_ne!(new_id, old_id);
    assert_ne!(second["token"], first["token"]);

    let (_, listed) = call(&app, &cookie, Method::GET, KEYS, None).await;
    let items = listed["items"].as_array().expect("a list");
    let old = items
        .iter()
        .find(|item| item["keyId"] == old_id.as_str())
        .expect("the predecessor is still listed");
    assert!(
        old["expiresAt"].is_string(),
        "the rotated key now ends, but only when the overlap does (PF-38)"
    );
    assert!(old["revokedAt"].is_null() || old.get("revokedAt").is_none());
    assert!(items.iter().any(|item| item["keyId"] == new_id.as_str()));

    let (status, _) = call(
        &app,
        &cookie,
        Method::DELETE,
        &format!("{KEYS}/{new_id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (_, listed) = call(&app, &cookie, Method::GET, KEYS, None).await;
    let revoked = listed["items"]
        .as_array()
        .expect("a list")
        .iter()
        .find(|item| item["keyId"] == new_id.as_str())
        .expect("a revoked key keeps its row for the audit trail");
    assert!(revoked["revokedAt"].is_string());

    let (status, _) = call(
        &app,
        &cookie,
        Method::DELETE,
        &format!("{KEYS}/deadbeefdeadbeef"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "an unknown key id");
}

#[tokio::test]
async fn a_write_without_the_csrf_token_is_refused() {
    let Some((app, config)) = app_with_db().await else {
        eprintln!("skipped: JC_PORTAL_TEST_DATABASE_URL is not set");
        return;
    };
    let cookie = session_cookie(&config, OWNER, &[]);

    let response = app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(KEYS)
                .header(header::COOKIE, &cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "credential": "legacy-push" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

/// T-1456: `helsinki` + `kpi-writer` and `helsinki-kpi` + `writer` derive one Keycloak client id,
/// which the gateway then resolves to nobody (T-1454). The Check refuses the second account and
/// names the id, not the account or project that holds it; a name that derives a free id passes
/// this rule, and re-proposing the account that holds the id is not a collision with itself.
#[tokio::test]
async fn an_account_whose_client_id_another_project_derives_is_refused_at_check() {
    let forge = common::forge().await;
    let state = common::state_on(&forge);
    let account = |project: &str, name: &str| {
        json!({
            "apiVersion": "joinedcontext.com/v1alpha1",
            "kind": "ServiceAccount",
            "metadata": { "name": name, "namespace": project },
            "spec": {
                "owner": { "user": "demo.steward" },
                "purpose": "writes indicators",
                "roles": [{ "role": "space-writer", "scope": { "project": project } }],
                "credentials": [{ "kind": "oauth-client", "name": "default" }]
            }
        })
    };
    let held = account("helsinki", "kpi-writer");
    state
        .mirror
        .upsert(serde_json::from_value(held.clone()).expect("an envelope"));
    let mut admin = common::person("admin");
    admin.groups = vec!["portal-approver".into()];
    let check = |project: &'static str, body: Value| {
        let state = state.clone();
        let admin = admin.clone();
        async move {
            common::send(
                &state,
                admin,
                "POST",
                &format!("/api/v1/projects/{project}/serviceaccounts?dryRun=All"),
                Some(body),
            )
            .await
        }
    };

    let refused = check("helsinki-kpi", account("helsinki-kpi", "writer")).await;
    // A check that rejects the manifest answers the red verdict that says why (T-2234); PF-59 is
    // the point of the case, and the holder must not be named whatever shape the refusal takes.
    assert_eq!(refused.status, StatusCode::OK, "{}", refused.text);
    assert!(
        refused.text.contains("\"ok\":false"),
        "the check refuses it: {}",
        refused.text
    );
    assert!(
        refused.text.contains("helsinki-kpi-writer"),
        "{}",
        refused.text
    );
    assert!(
        !refused.text.contains("'kpi-writer'") && !refused.text.contains("'helsinki'"),
        "the holder is not named: {}",
        refused.text
    );

    for (project, body) in [
        ("helsinki-kpi", account("helsinki-kpi", "reader")),
        ("helsinki", held),
    ] {
        let answer = check(project, body).await;
        assert!(
            !answer.text.contains("T-1456"),
            "{project}: {}",
            answer.text
        );
    }
}

const FORMER_KEYS: &str = "/api/v1/projects/banskabystrica/serviceaccounts/air-push/keys";

/// T-2487, PF-50, PF-59: the owner a manifest still names, whose last binding in the project is
/// gone, lists, mints, rotates and revokes nothing and is answered like a stranger. Without a
/// database an admitted caller is answered 503, so a 404 here proves the refusal comes before the
/// key store is reached, and no key row can have been written.
#[tokio::test]
async fn an_owner_with_no_binding_left_manages_no_key_of_the_account() {
    let config = Config::for_tests();
    let cookie = session_cookie(&config, FORMER, &[]);
    let app = server::app(AppState::new(config, None).with_mirror(mirror()));
    let key = format!("{FORMER_KEYS}/k-1");
    for (method, uri, body) in [
        (Method::GET, FORMER_KEYS.to_owned(), None),
        (
            Method::POST,
            FORMER_KEYS.to_owned(),
            Some(json!({ "credential": "legacy-push" })),
        ),
        (
            Method::POST,
            format!("{key}/rotate"),
            Some(json!({ "overlapHours": 1 })),
        ),
        (Method::DELETE, key.clone(), None),
    ] {
        let (status, answer) = call(&app, &cookie, method.clone(), &uri, body).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{method} {uri}: {answer}");
        assert!(answer.get("token").is_none(), "{method} {uri}: {answer}");
    }
}

/// T-2487: the operation the assistant and MCP reach is refused the same way, as the same 404.
#[tokio::test]
async fn an_owner_with_no_binding_left_mints_nothing_through_the_operation() {
    use joinedcontext_portal::ops::{self, Caller, OpError, Via};
    let state = AppState::new(Config::for_tests(), None).with_mirror(mirror());
    let former = Identity {
        client: None,
        subject: format!("f:1:{FORMER}"),
        username: FORMER.into(),
        email: Some(format!("{FORMER}@banskabystrica.sk")),
        name: None,
        roles: Vec::new(),
        groups: vec!["another-city".into()],
    };
    let op = ops::find("jc_service_account_key_mint").expect("registered");
    let refused = ops::call(
        op,
        &Caller::new(former, Via::Session),
        &state,
        "banskabystrica",
        json!({ "account": "air-push", "credential": "legacy-push" }),
    )
    .await
    .expect_err("no key is minted");
    assert!(
        matches!(
            refused,
            OpError::Api(ApiError::NotFound(_)) | OpError::Forbidden(_)
        ),
        "{refused:?}"
    );
}

/// T-2487: the owner who still reads the project is admitted as before: without a database that
/// is the key store's 503, not the stranger's 404.
#[tokio::test]
async fn an_owner_who_still_reads_the_project_is_admitted() {
    let config = Config::for_tests();
    let cookie = session_cookie(&config, OWNER, &[]);
    let app = server::app(AppState::new(config, None).with_mirror(mirror()));
    let (status, _) = call(
        &app,
        &cookie,
        Method::POST,
        KEYS,
        Some(json!({ "credential": "legacy-push" })),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
}
