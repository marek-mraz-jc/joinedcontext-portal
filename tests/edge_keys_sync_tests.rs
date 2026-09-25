//! Edge cases of the four api-key routes and the three sync-source routes (T-2036 … T-2042; MF-24,
//! PF-34, PF-59, R20, T-1361).
//!
//! **The contract, in one sentence:** the keys of a ServiceAccount are managed by its owner or by
//! somebody who may propose one in the project, everyone else is told the account is not there, and a
//! sync source is read by a member while running it and pausing it need `propose` — so a refusal never
//! mints, rotates, revokes or drives anything.
//!
//! The happy paths live in `service_account_api_tests.rs` (the raw key once, rotation with an overlap,
//! revocation, the 503 without a database) and `sync_source_routes_tests.rs` (the pause, the detach, the
//! bindings). This file is the other side: an expiry in the past, an overlap nobody serves, a key id that
//! is not one, a driver that is not running.
//!
//! Every case here runs without a key database on purpose: each refusal it asserts is reached **before**
//! `pool(&state)` is, which is what proves the order — a caller who may not manage an account never
//! reaches the store at all, and neither does a request that could not be honoured.
//!
//! Tests only (the family's rule). Every case here is green; a red one becomes its own task.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use axum_extra::extract::cookie::PrivateCookieJar;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

use joinedcontext_portal::auth::csrf::{CSRF_COOKIE, CSRF_HEADER};
use joinedcontext_portal::auth::session::{self, Identity, Session};
use joinedcontext_portal::config::Config;
use joinedcontext_portal::permissions::ORG_NAMESPACE;
use joinedcontext_portal::resource::{ObjectMeta, ResourceEnvelope, API_VERSION};
use joinedcontext_portal::server;
use joinedcontext_portal::state::AppState;
use joinedcontext_portal::store::Mirror;

const PROJECT: &str = "banskabystrica";
const ELSEWHERE: &str = "doprava";
const ACCOUNT: &str = "vendorx-parking-push";
const SOURCE: &str = "shmu-open-data";
const CSRF: &str = "csrf-token-edge-keys";
const OWNER: &str = "jana.kovacova";
const STEWARD: &str = "eva.steward";
const READER: &str = "peter.reader";
const STRANGER: &str = "nobody";

fn envelope(kind: &str, name: &str, namespace: &str, spec: Value) -> ResourceEnvelope {
    ResourceEnvelope {
        api_version: API_VERSION.into(),
        kind: kind.into(),
        metadata: ObjectMeta {
            name: name.into(),
            namespace: Some(namespace.into()),
            ..Default::default()
        },
        spec,
        status: None,
    }
}

fn org(kind: &str, name: &str, spec: Value) -> ResourceEnvelope {
    envelope(kind, name, ORG_NAMESPACE, spec)
}

/// One ServiceAccount owned by `OWNER` with one api-key credential, one SyncSource, and the bindings
/// that tell a steward who may propose from a reader who may only read. The owner reads the project
/// like any member: an owner with no binding left in it manages none of the keys (T-2487, T-2567).
fn mirror() -> Arc<Mirror> {
    let mirror = Arc::new(Mirror::new());
    mirror.upsert(envelope(
        "ServiceAccount",
        ACCOUNT,
        PROJECT,
        json!({
            "owner": { "user": OWNER },
            "purpose": "VendorX pushes ParkingSpot updates every 10 s",
            "roles": [],
            "credentials": [
                { "kind": "oauth-client", "name": "main" },
                { "kind": "api-key", "name": "legacy-push" }
            ]
        }),
    ));
    mirror.upsert(envelope(
        "SyncSource",
        SOURCE,
        PROJECT,
        json!({
            "url": "https://opendata.shmu.sk/catalog.json",
            "kind": "ckan",
            "schedule": "PT1H",
        }),
    ));
    mirror.upsert(org(
        "Role",
        "account-steward",
        json!({ "rules": [{ "kinds": ["ServiceAccount", "SyncSource"],
                            "verbs": ["read", "propose"] }] }),
    ));
    mirror.upsert(org(
        "Role",
        "account-reader",
        json!({ "rules": [{ "kinds": ["ServiceAccount", "SyncSource"], "verbs": ["read"] }] }),
    ));
    for (name, user, role) in [
        ("stewards", STEWARD, "account-steward"),
        ("readers", READER, "account-reader"),
        ("owners", OWNER, "account-reader"),
    ] {
        mirror.upsert(org(
            "RoleBinding",
            name,
            json!({ "subjects": [{ "user": format!("{user}@banskabystrica.sk") }],
                    "role": role, "scope": { "project": PROJECT } }),
        ));
    }
    mirror
}

fn cookie(config: &Config, username: &str) -> String {
    use axum::response::IntoResponse;
    let now = session::now_unix();
    let session = Session {
        identity: Identity {
            client: None,
            subject: format!("f:1:{username}"),
            username: username.into(),
            email: Some(format!("{username}@banskabystrica.sk")),
            name: None,
            roles: Vec::new(),
            groups: Vec::new(),
        },
        expires_at: now + 3600,
        issued_at: now,
        id_token: "id-token-placeholder".into(),
        access_expires_at: now + 3600,
        refresh_token: None,
    };
    let jar = session::store(PrivateCookieJar::new(config.cookie_key.clone()), &session)
        .expect("store session");
    let response = (jar, StatusCode::OK).into_response();
    let mut parts: Vec<String> = response
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .map(|raw| raw.split(';').next().unwrap_or_default().to_owned())
        .collect();
    parts.push(format!("{CSRF_COOKIE}={CSRF}"));
    parts.join("; ")
}

fn world() -> AppState {
    AppState::new(Config::for_tests(), None).with_mirror(mirror())
}

async fn send(
    state: &AppState,
    who: &str,
    verb: Method,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(verb)
        .uri(uri)
        .header(header::COOKIE, cookie(&state.config, who))
        .header(CSRF_HEADER, CSRF);
    let body = match body {
        Some(json) => {
            request = request.header(header::CONTENT_TYPE, "application/json");
            Body::from(json.to_string())
        }
        None => Body::empty(),
    };
    let response = server::app(state.clone())
        .oneshot(request.body(body).expect("a request"))
        .await
        .expect("a response");
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("a body")
        .to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// The four key routes of one account, each with a body it would accept, so a case can sweep all of
/// them without a parse error standing in for the answer it is about. `rotate` and `list` deny an
/// unknown field, so the mint's body is not shared.
fn every_key_route(project: &str, account: &str) -> Vec<(Method, String, Option<Value>)> {
    let keys = format!("/api/v1/projects/{project}/serviceaccounts/{account}/keys");
    vec![
        (Method::GET, keys.clone(), None),
        (
            Method::POST,
            keys.clone(),
            Some(json!({ "credential": "legacy-push" })),
        ),
        (
            Method::POST,
            format!("{keys}/some-key-id/rotate"),
            Some(json!({ "overlapHours": 1 })),
        ),
        (Method::DELETE, format!("{keys}/some-key-id"), None),
    ]
}

// -------------------------------------------------------------------------------------------------
// T-2036 … T-2039: who may manage an account's keys at all
// -------------------------------------------------------------------------------------------------

/// PF-34, R20: the keys of a ServiceAccount are its owner's and its project's stewards'. Everybody else
/// is told the account is not there — the same body for a reader of the project, for a person no binding
/// covers, for an account nobody has and for a name that could not be one — and no answer ever carries a
/// token, on any of the four routes.
#[tokio::test]
async fn the_keys_of_an_account_are_not_there_for_anybody_who_may_not_manage_it() {
    let state = world();

    for who in [READER, STRANGER] {
        for (verb, uri, body) in every_key_route(PROJECT, ACCOUNT) {
            let (status, body) = send(&state, who, verb.clone(), &uri, body).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{who} {verb} {uri}: {body}");
            let text = body.to_string();
            for leaked in ["token", "secret", "legacy-push", OWNER] {
                assert!(
                    !text.contains(leaked),
                    "{who} {verb} {uri} answered with {leaked:?}: {text}",
                );
            }
        }
    }

    // An account nobody has, a name that could not be one, and the same account asked for through
    // another project's path: the same answer for the owner as for anybody else.
    for (project, account) in [
        (PROJECT, "nothing-like-this"),
        (PROJECT, "VendorX-Parking-Push"),
        (PROJECT, "%2e%2e"),
        (ELSEWHERE, ACCOUNT),
        ("Banskabystrica", ACCOUNT),
    ] {
        for (verb, uri, body) in every_key_route(project, account) {
            let (status, body) = send(&state, OWNER, verb.clone(), &uri, body).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{verb} {uri}: {body}");
        }
    }

    // The owner, on their own account: past the gate, and this installation has no key database, so
    // every route says so rather than answering an empty list or a key that was never stored.
    for (verb, uri, body) in every_key_route(PROJECT, ACCOUNT) {
        let (status, body) = send(&state, OWNER, verb.clone(), &uri, body).await;
        assert_eq!(
            status,
            StatusCode::SERVICE_UNAVAILABLE,
            "{verb} {uri}: {body}",
        );
        assert!(
            body["detail"]
                .as_str()
                .unwrap_or_default()
                .contains("database"),
            "{verb} {uri} does not say what is missing: {body}",
        );
    }

    // And the steward of the project, who is not the owner, may manage them too (PF-34).
    let (status, body) = send(
        &state,
        STEWARD,
        Method::GET,
        &format!("/api/v1/projects/{PROJECT}/serviceaccounts/{ACCOUNT}/keys"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
}

/// PF-34, MF-24: a minting request that could not be honoured is refused before a key exists — a
/// credential the manifest does not declare, an expiry that is not a moment or is already past, and a
/// body that is not a request. The manifest is the authority on which credentials there are, so a key
/// for one nobody reviewed is never minted.
#[tokio::test]
async fn a_minting_request_that_could_not_be_honoured_never_reaches_the_store() {
    let state = world();
    let keys = format!("/api/v1/projects/{PROJECT}/serviceaccounts/{ACCOUNT}/keys");

    // A credential the manifest does not declare, including the oauth-client it does declare: a key
    // is minted for an api-key credential and for nothing else.
    for credential in ["main", "legacy", "Legacy-Push", "", "../legacy-push"] {
        let (status, body) = send(
            &state,
            OWNER,
            Method::POST,
            &keys,
            Some(json!({ "credential": credential })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{credential:?}: {body}");
        assert!(
            body["detail"]
                .as_str()
                .unwrap_or_default()
                .contains("api-key"),
            "{credential:?} does not say what kind of credential is wanted: {body}",
        );
    }

    // An expiry that is not a moment, or is one that has already passed: refused before the mint.
    for expires_at in [
        "yesterday",
        "2020-01-01T00:00:00Z",
        "2026-13-01T00:00:00Z",
        "2026-09-19",
        "",
    ] {
        let (status, body) = send(
            &state,
            OWNER,
            Method::POST,
            &keys,
            Some(json!({ "credential": "legacy-push", "expiresAt": expires_at })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{expires_at:?}: {body}");
    }

    // A body that is not a minting request.
    for body in [
        json!({}),
        json!("legacy-push"),
        json!({ "credential": 7 }),
        Value::Null,
    ] {
        let (status, answer) = send(&state, OWNER, Method::POST, &keys, Some(body.clone())).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}: {answer}");
    }

    // A rotation asks for an overlap this Portal serves, and the check comes before the store: a
    // negative overlap and one longer than the ceiling are the caller's mistake, not a 503.
    for overlap in [json!(-1), json!(1000), json!(24 * 400)] {
        let (status, body) = send(
            &state,
            OWNER,
            Method::POST,
            &format!("{keys}/some-key-id/rotate"),
            Some(json!({ "overlapHours": overlap })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{overlap}: {body}");
    }
    // An empty rotation body is the default rotation and not a parse error, so it reaches the store —
    // which is the 503 of an installation without one.
    let (status, body) = send(
        &state,
        OWNER,
        Method::POST,
        &format!("{keys}/some-key-id/rotate"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
}

// -------------------------------------------------------------------------------------------------
// T-2040 `status`, T-2041 `sync_now`, T-2042 `pause`
// -------------------------------------------------------------------------------------------------

/// PF-59, T-1361: a sync source's status is a read of the project's sources, while running one and
/// pausing one drive the loop and need `propose`. A reader may look and not drive, a caller no binding
/// covers is told the source is not there, and a source the repository does not hold is not driven for
/// anybody.
#[tokio::test]
async fn a_sync_source_is_read_by_a_member_and_driven_only_by_one_who_may_propose() {
    let state = world();
    let source = format!("/api/v1/projects/{PROJECT}/syncsources/{SOURCE}");
    let status_uri = format!("{source}/status");
    let now_uri = format!("{source}/sync");
    let pause_uri = format!("{source}/pause");

    // A caller no binding covers: the source is not there, on the read and on both writes.
    let (status, body) = send(&state, STRANGER, Method::GET, &status_uri, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    for uri in [&now_uri, &pause_uri] {
        let (status, body) = send(
            &state,
            STRANGER,
            Method::POST,
            uri,
            Some(json!({ "paused": true })),
        )
        .await;
        // The refusal grammar of the two sides is not the same, and deliberately so: `status` is a
        // read, so it hides the source (PF-59, R20), while `sync` and `pause` are writes, so they
        // name the verb the caller has not got. Both are refusals before the loop is looked for, so
        // neither tells a stranger whether this project syncs anything.
        assert_eq!(status, StatusCode::FORBIDDEN, "{uri}: {body}");
        assert!(
            !body.to_string().contains(SOURCE),
            "{uri} named the source to a stranger: {body}",
        );
    }

    // A reader of the project's sources may look — this installation runs no loop, so the answer is
    // that there is none rather than an invented status — and may drive neither.
    let (status, body) = send(&state, READER, Method::GET, &status_uri, None).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert!(
        body["detail"].as_str().unwrap_or_default().contains("sync"),
        "{body}",
    );
    for uri in [&now_uri, &pause_uri] {
        let (status, body) = send(
            &state,
            READER,
            Method::POST,
            uri,
            Some(json!({ "paused": true })),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{uri}: {body}");
    }

    // The steward may drive, and gets the same "no loop is running" rather than a silent nothing.
    for (verb, uri, body) in [
        (Method::POST, &now_uri, None),
        (Method::POST, &pause_uri, Some(json!({ "paused": true }))),
    ] {
        let (status, answer) = send(&state, STEWARD, verb, uri, body).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{uri}: {answer}");
    }

    // A pause that does not say which way: refused as a body, before the loop is looked for.
    for body in [
        json!({}),
        json!({ "paused": "yes" }),
        json!(true),
        Value::Null,
    ] {
        let (status, answer) = send(
            &state,
            STEWARD,
            Method::POST,
            &pause_uri,
            Some(body.clone()),
        )
        .await;
        assert!(
            status.is_client_error(),
            "{body} answered {status}: {answer}",
        );
    }

    // A source the repository does not hold, and names that could not be one: not found for the
    // steward who may drive, which is the order that matters — the verb first, then the source.
    for (project, name) in [
        (PROJECT, "nothing-like-this"),
        (PROJECT, "SHMU-Open-Data"),
        (PROJECT, "%2e%2e"),
        (ELSEWHERE, SOURCE),
    ] {
        let (status, body) = send(
            &state,
            STEWARD,
            Method::GET,
            &format!("/api/v1/projects/{project}/syncsources/{name}/status"),
            None,
        )
        .await;
        assert!(
            status == StatusCode::NOT_FOUND || status == StatusCode::SERVICE_UNAVAILABLE,
            "{project}/{name} answered {status}: {body}",
        );
    }
}
