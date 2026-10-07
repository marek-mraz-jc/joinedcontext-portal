//! `jc_model_infer` from an address (T-3250): fetched on the project's runner, under the grant a
//! data source's Check needs, and refused before anything runs when it is no http(s) address.

mod common;

use axum::http::StatusCode;
use common::doors::{self, session, steward, viewer};
use joinedcontext_portal::config::Config;
use joinedcontext_portal::state::AppState;
use serde_json::json;

fn state() -> AppState {
    doors::state_with(AppState::new(Config::for_tests(), None))
}

#[tokio::test]
async fn an_address_that_is_not_http_is_refused_at_the_field() {
    let state = state();
    for url in [
        "ftp://data.example.org/a.json",
        "file:///etc/passwd",
        "not an address",
    ] {
        let answer = doors::call(
            "jc_model_infer",
            &session(steward()),
            &state,
            json!({ "url": url }),
        )
        .await;
        assert_eq!(
            StatusCode::UNPROCESSABLE_ENTITY,
            answer.status,
            "{url}: {}",
            answer.text()
        );
        assert!(answer.text().contains("url"), "{}", answer.text());
    }
}

#[tokio::test]
async fn fetching_an_address_needs_the_grant_a_data_source_check_needs() {
    // The viewer reads every kind of the project, so inferring from a file is theirs; fetching an
    // address on the project's runner is a data source's Check, which needs propose.
    let answer = doors::call(
        "jc_model_infer",
        &session(viewer()),
        &state(),
        json!({ "url": "https://data.example.org/a.json" }),
    )
    .await;
    assert_eq!(StatusCode::FORBIDDEN, answer.status, "{}", answer.text());
    assert!(answer.text().contains("DataSource"), "{}", answer.text());
}

#[tokio::test]
async fn no_runner_to_fetch_with_is_unavailable_not_the_address_s_fault() {
    let answer = doors::call(
        "jc_model_infer",
        &session(steward()),
        &state(),
        json!({ "url": "https://data.example.org/a.json" }),
    )
    .await;
    assert_eq!(
        StatusCode::SERVICE_UNAVAILABLE,
        answer.status,
        "{}",
        answer.text()
    );
}
