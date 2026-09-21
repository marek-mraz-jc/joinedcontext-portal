//! The service account key operations through every door of the registry (T-1530; AG-64, PF-50,
//! PF-36, PF-37, PF-38, AG-11).
//!
//! What was there before this file: the REST routes are tested in `service_account_api_tests.rs`
//! (the token once, the listing without it, rotation's overlap, revocation, 404 for a caller who
//! may not manage the account) and `edge_keys_sync_tests.rs`, and
//! `attack_person_only_operations_tests.rs` refuses mint, rotate and revoke to a run. No test called
//! the four operations through the registry as a person, a viewer or an MCP client.
//!
//! The refusals need no database: the account check and the registry's gate come before it. The
//! happy paths do, as `service_account_api_tests.rs` does: they run where
//! `JC_PORTAL_TEST_DATABASE_URL` names a PostgreSQL (ci-full), and say so when it does not.
//!
//! API/01 (the operation door) refuses these three to an agent run and leaves them to a person's
//! own MCP client; the MCP case below asserts that contract as written.

mod common;

use std::io::Write;
use std::sync::{Arc, Mutex};

use axum::http::StatusCode;
use common::doors::{self, mcp, run, session, steward, stranger, viewer, PROJECT};
use common::envelope;
use joinedcontext_portal::config::Config;
use joinedcontext_portal::state::AppState;
use serde_json::{json, Value};

const ACCOUNT: &str = "air-push";
const KEYS: &str = "/api/v1/projects/ovzdusie/serviceaccounts/air-push/keys";
const WRITES: [&str; 3] = [
    "jc_service_account_key_mint",
    "jc_service_account_key_rotate",
    "jc_service_account_key_revoke",
];

fn with_account(state: AppState) -> AppState {
    let state = doors::state_with(state);
    state.mirror.upsert(envelope(
        "ServiceAccount",
        ACCOUNT,
        PROJECT,
        json!({
            "owner": { "user": "jana" },
            "purpose": "The air sensors push their readings",
            "roles": [],
            "credentials": [
                { "kind": "oauth-client", "name": "main" },
                { "kind": "api-key", "name": "sensor-push" }
            ]
        }),
    ));
    state
}

async fn with_db() -> Option<AppState> {
    let url = std::env::var("JC_PORTAL_TEST_DATABASE_URL")
        .ok()
        .filter(|url| !url.trim().is_empty())?;
    let pool = joinedcontext_portal::db::connect(&url)
        .await
        .expect("connect + migrate");
    Some(with_account(
        AppState::new(Config::for_tests(), None).with_db(pool),
    ))
}

fn input(name: &str, key_id: &str) -> Value {
    match name {
        "jc_service_account_key_list" => json!({ "account": ACCOUNT }),
        "jc_service_account_key_mint" => json!({ "account": ACCOUNT, "credential": "sensor-push" }),
        _ => json!({ "account": ACCOUNT, "keyId": key_id }),
    }
}

/// Everything written to the log while the guard lives, on this thread.
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

impl Log {
    fn text(&self) -> String {
        self.0
            .lock()
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .unwrap_or_default()
    }
}

/// PF-36, PF-37, PF-38: the steward mints, lists, rotates and revokes through the session and
/// through her MCP client. The token is in the mint's and the rotation's answer and nowhere after:
/// not in the listing, not in the log, and no Change is opened for it.
#[tokio::test]
async fn every_person_door_mints_lists_rotates_and_revokes_and_the_token_is_shown_once() {
    let Some(state) = with_db().await else {
        eprintln!("skipped: JC_PORTAL_TEST_DATABASE_URL is not set");
        return;
    };
    let log = Log::default();
    let writer = log.clone();
    let _guard = tracing::subscriber::set_default(
        tracing_subscriber::fmt()
            .with_max_level(tracing::Level::TRACE)
            .with_writer(move || writer.clone())
            .finish(),
    );
    for caller in [session(steward()), mcp(steward())] {
        let minted = doors::call(
            "jc_service_account_key_mint",
            &caller,
            &state,
            input("jc_service_account_key_mint", ""),
        )
        .await;
        assert_eq!(StatusCode::OK, minted.status, "{}", minted.text());
        let token = minted.body["token"].as_str().unwrap_or_default().to_owned();
        let key_id = minted.body["keyId"].as_str().unwrap_or_default().to_owned();
        assert!(
            token.starts_with(&format!("jc_{key_id}_")),
            "{}",
            minted.text()
        );
        assert!(
            minted.body.get("changeId").is_none(),
            "a key went into a Change"
        );

        let rotated = doors::call(
            "jc_service_account_key_rotate",
            &caller,
            &state,
            input("jc_service_account_key_rotate", &key_id),
        )
        .await;
        assert_eq!(StatusCode::OK, rotated.status, "{}", rotated.text());
        let successor = rotated.body["token"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        assert!(!successor.is_empty() && successor != token);

        let listed = doors::call(
            "jc_service_account_key_list",
            &caller,
            &state,
            input("jc_service_account_key_list", ""),
        )
        .await;
        assert_eq!(StatusCode::OK, listed.status, "{}", listed.text());
        assert!(listed.text().contains(&key_id), "{}", listed.text());
        for secret in [&token, &successor] {
            assert!(
                !listed.text().contains(secret.as_str()),
                "a token was listed again"
            );
            assert!(
                !log.text().contains(secret.as_str()),
                "a token reached the log"
            );
        }

        let revoked = doors::call(
            "jc_service_account_key_revoke",
            &caller,
            &state,
            input("jc_service_account_key_revoke", &key_id),
        )
        .await;
        assert_eq!(StatusCode::OK, revoked.status, "{}", revoked.text());
        assert_eq!(json!(true), revoked.body["revoked"]);
    }
    assert!(
        log.text().contains("api key minted"),
        "the log was not captured: {}",
        log.text()
    );
}

/// PF-38: revoking or rotating a key the account never had answers 404 and names the key alone.
#[tokio::test]
async fn an_unknown_key_is_not_there_to_revoke_or_rotate() {
    let Some(state) = with_db().await else {
        eprintln!("skipped: JC_PORTAL_TEST_DATABASE_URL is not set");
        return;
    };
    for name in [
        "jc_service_account_key_revoke",
        "jc_service_account_key_rotate",
    ] {
        let missing = doors::call(
            name,
            &session(steward()),
            &state,
            input(name, "0123456789abcdef"),
        )
        .await;
        assert_eq!(
            StatusCode::NOT_FOUND,
            missing.status,
            "{name}: {}",
            missing.text()
        );
        assert!(
            missing.text().contains("0123456789abcdef"),
            "{}",
            missing.text()
        );
    }
}

/// PF-50, PF-59: a viewer manages no key of an account she neither owns nor may propose: the
/// account is not there for her, at every door and through the REST route alike.
#[tokio::test]
async fn a_viewer_manages_no_key_at_any_door() {
    let state = with_account(AppState::new(Config::for_tests(), None));
    for caller in [session(viewer()), mcp(viewer())] {
        for name in ["jc_service_account_key_list"].into_iter().chain(WRITES) {
            let refused = doors::call(name, &caller, &state, input(name, "0123456789abcdef")).await;
            assert_eq!(
                StatusCode::NOT_FOUND,
                refused.status,
                "{name}: {}",
                refused.text()
            );
        }
    }
    let rest = doors::http(
        &state,
        viewer(),
        "POST",
        KEYS,
        Some(json!({ "credential": "sensor-push" })),
    )
    .await;
    let door = doors::post_op(
        &state,
        viewer(),
        "jc_service_account_key_mint",
        input("jc_service_account_key_mint", ""),
    )
    .await;
    assert_eq!(
        rest.status,
        door.status,
        "{} vs {}",
        rest.text(),
        door.text()
    );
    let rest = doors::http(&state, viewer(), "GET", KEYS, None).await;
    let door = doors::post_op(
        &state,
        viewer(),
        "jc_service_account_key_list",
        input("jc_service_account_key_list", ""),
    )
    .await;
    assert_eq!(
        rest.status,
        door.status,
        "{} vs {}",
        rest.text(),
        door.text()
    );
}

/// PF-59, R20: a person with no binding in the project finds no account at any door, for the read
/// and for every write, and the REST route answers her the same.
#[tokio::test]
async fn a_stranger_finds_no_account_at_any_door() {
    let state = with_account(AppState::new(Config::for_tests(), None));
    for caller in [session(stranger()), mcp(stranger())] {
        for name in ["jc_service_account_key_list"].into_iter().chain(WRITES) {
            let refused = doors::call(name, &caller, &state, input(name, "0123456789abcdef")).await;
            assert_eq!(
                StatusCode::NOT_FOUND,
                refused.status,
                "{name}: {}",
                refused.text()
            );
        }
    }
    let rest = doors::http(
        &state,
        stranger(),
        "POST",
        KEYS,
        Some(json!({ "credential": "sensor-push" })),
    )
    .await;
    let door = doors::post_op(
        &state,
        stranger(),
        "jc_service_account_key_mint",
        input("jc_service_account_key_mint", ""),
    )
    .await;
    assert_eq!(StatusCode::NOT_FOUND, rest.status, "{}", rest.text());
    assert_eq!(
        rest.status,
        door.status,
        "{} vs {}",
        rest.text(),
        door.text()
    );
}

/// AG-11: an agent run never mints, rotates or revokes a key, however wide its profile, and is
/// never offered the three; it may list the keys when its profile names that read. A person's own
/// MCP client is offered them, as API/01 has it.
#[tokio::test]
async fn an_agent_run_is_never_offered_a_key_write() {
    let state = with_account(AppState::new(Config::for_tests(), None));
    let agent = run(
        steward(),
        &[
            "jc_service_account_key_list",
            "jc_service_account_key_mint",
            "jc_service_account_key_rotate",
            "jc_service_account_key_revoke",
        ],
    );
    let offered = doors::offered(&agent, &state);
    assert!(
        offered.contains(&"jc_service_account_key_list".to_owned()),
        "{offered:?}"
    );
    for name in WRITES {
        assert!(
            !offered.contains(&name.to_owned()),
            "{name} offered to a run"
        );
        let refused = doors::call(name, &agent, &state, input(name, "0123456789abcdef")).await;
        assert_eq!(
            StatusCode::FORBIDDEN,
            refused.status,
            "{name}: {}",
            refused.text()
        );
        assert!(
            refused.text().contains("AG-11"),
            "{name}: {}",
            refused.text()
        );
    }
    let person = doors::offered(&mcp(steward()), &state);
    for name in WRITES {
        assert!(
            person.contains(&name.to_owned()),
            "{name} not offered to the person's MCP client"
        );
    }
}

/// PF-37: an input the route would refuse is refused at the door: an unknown field, a credential
/// the account does not declare, and an expiry in the past.
#[tokio::test]
async fn an_input_the_route_would_refuse_is_refused_at_the_door() {
    let state = with_account(AppState::new(Config::for_tests(), None));
    let caller = session(steward());
    for (name, bad) in [
        (
            "jc_service_account_key_mint",
            json!({ "account": ACCOUNT, "credential": "sensor-push", "token": "jc_x_y" }),
        ),
        (
            "jc_service_account_key_mint",
            json!({ "account": ACCOUNT, "credential": "main" }),
        ),
        (
            "jc_service_account_key_mint",
            json!({ "account": ACCOUNT, "credential": "sensor-push", "expiresAt": "2001-01-01T00:00:00Z" }),
        ),
        (
            "jc_service_account_key_revoke",
            json!({ "account": ACCOUNT }),
        ),
    ] {
        let refused = doors::call(name, &caller, &state, bad.clone()).await;
        assert!(
            refused.status == StatusCode::BAD_REQUEST
                || refused.status == StatusCode::UNPROCESSABLE_ENTITY,
            "{name} {bad}: {} {}",
            refused.status,
            refused.text()
        );
        assert!(!refused.text().contains("jc_x_y"), "the input was echoed");
    }
}
