//! Attack vector: an MCP client or an agent run reaches an operation a person must perform
//! (T-1689; AG-11, AG-82, AG-45, AG-70, AG-77, PF-58).
//!
//! **The attack.** Arrive as `Via::Mcp` and as `Via::Agent` and take, by name, the operations the
//! platform reserves for a person: approve a change, reject one, delete a resource, delete a
//! project, mint a service account's key, rotate one, bring a workspace back, throw one away, and
//! answer the question a run asked. Name them even where the caller's profile does not, and name
//! them where the widest profile an author could write does.
//!
//! **The defence.** Each is refused on the caller and the operation alone — before the profile is
//! consulted, before the input is read and before the body runs — with the reason that says whose
//! the act is. Two of the nine are not refused and must not be: proposing a deletion is an agent's
//! to do (AG-77), because a deletion is a Red Change that a person still approves. The vector's
//! property is that nothing is decided, not that nothing is asked for.
//!
//! What the existing tests already play, read before this file was written:
//!
//! - `ops_registry_tests.rs::a_change_is_never_decided_over_mcp_or_by_an_agent` — approve and
//!   reject, over MCP and as a run, refused with the AG-11 reason.
//! - `workspace_api_tests.rs::an_agent_or_an_mcp_client_never_brings_a_workspace_back` and
//!   `::an_agent_or_an_mcp_client_never_throws_a_workspace_away` — the two ways out of a workspace.
//! - `workspace_api_tests.rs::the_listing_an_agent_reads_offers_the_work_and_neither_way_out` —
//!   the workspace half of the listing.
//! - `edge_ops_gate_tests.rs::no_profile_however_wide_lets_a_run_decide_a_change_or_move_a_workspace`
//!   — the widest profile over those same four.
//! - `ops_registry_tests.rs::the_run_operations_answer_and_an_agent_is_refused_by_name` — create,
//!   cancel and publish as a run, and that a person's own MCP session is not stopped by that gate.
//!
//! What was left, and is this file: the keys and the run's answer (refused nowhere the listing could
//! see, so `GET …/ops` and `tools/list` offered a run three operations it would always be denied —
//! fixed in `src/ops/mod.rs::may_run`), the reason a refused key mint reads (one sentence about
//! runs, which told a reader nothing), the two proposals that are deliberately open, and the
//! evidence that a refused call writes, fetches and echoes nothing.

mod common;

use std::sync::Arc;

use axum::http::StatusCode;
use axum::response::IntoResponse;
use jc_core::kinds::Verb;
use joinedcontext_portal::agents::access::Access;
use joinedcontext_portal::auth::session::Identity;
use joinedcontext_portal::change::Lane;
use joinedcontext_portal::config::Config;
use joinedcontext_portal::ops::{self, Caller, OpError, Via};
use joinedcontext_portal::permissions::ORG_NAMESPACE;
use joinedcontext_portal::resource::{ObjectMeta, ResourceEnvelope, API_VERSION};
use joinedcontext_portal::state::AppState;
use joinedcontext_portal::store::Mirror;
use serde_json::{json, Value};
use wiremock::MockServer;

const PROJECT: &str = "ovzdusie";

/// A string that exists only in the input of a refused call: it may appear in no answer and in no
/// request the Portal makes.
const CANARY: &str = "kanarik-nikdy-v-odpovedi";

/// The operations this vector attacks, with the words their refusal must carry. `None` is an
/// operation that is deliberately open to a run: a proposal a person still approves (AG-77).
fn attacked() -> Vec<(&'static str, Option<&'static str>)> {
    vec![
        ("jc_change_approve", Some("approves or rejects")),
        ("jc_change_reject", Some("approves or rejects")),
        ("jc_workspace_propose", Some("brings a workspace back")),
        ("jc_workspace_discard", Some("throws a workspace away")),
        ("jc_service_account_key_mint", Some("service account's key")),
        (
            "jc_service_account_key_rotate",
            Some("service account's key"),
        ),
        (
            "jc_service_account_key_revoke",
            Some("service account's key"),
        ),
        ("jc_run_answer", Some("answer the question a run asked")),
        (
            "jc_run_create",
            Some("start, cancel or publish another run"),
        ),
        (
            "jc_run_cancel",
            Some("start, cancel or publish another run"),
        ),
        (
            "jc_run_publish",
            Some("start, cancel or publish another run"),
        ),
        ("jc_resource_delete", None),
        ("jc_project_delete", None),
    ]
}

/// An input for each, carrying [`CANARY`] wherever the schema takes a free string, so a refusal
/// that echoed its input would be caught.
fn attack_input(operation: &str) -> Value {
    match operation {
        "jc_change_approve" => json!({ "id": format!("chg-{CANARY}") }),
        "jc_change_reject" => json!({ "id": format!("chg-{CANARY}"), "reason": CANARY }),
        "jc_workspace_propose" | "jc_workspace_discard" => json!({ "name": CANARY }),
        "jc_service_account_key_mint" => json!({ "account": CANARY, "credential": CANARY }),
        "jc_service_account_key_rotate" => {
            json!({ "account": CANARY, "keyId": CANARY, "overlapHours": 1 })
        }
        "jc_service_account_key_revoke" => json!({ "account": CANARY, "keyId": CANARY }),
        "jc_run_answer" => {
            json!({ "id": CANARY, "questionId": CANARY, "answers": { "where": CANARY } })
        }
        "jc_run_create" => json!({ "appName": CANARY, "prompt": CANARY, "dataNeeds": [] }),
        "jc_run_cancel" | "jc_run_publish" => json!({ "id": CANARY }),
        "jc_resource_delete" => json!({ "kind": "Endpoint", "name": CANARY, "confirm": CANARY }),
        "jc_project_delete" => json!({ "name": CANARY, "confirm": CANARY }),
        other => panic!("no input written for {other}"),
    }
}

fn steward() -> Identity {
    Identity {
        client: None,
        subject: "f:1:jana".into(),
        username: "jana".into(),
        email: Some("jana@banskabystrica.sk".into()),
        name: Some("Jana".into()),
        roles: vec!["portal-approver".into()],
        groups: vec!["city-stewards".into()],
    }
}

fn org(kind: &str, name: &str, spec: Value) -> ResourceEnvelope {
    ResourceEnvelope {
        api_version: API_VERSION.to_owned(),
        kind: kind.to_owned(),
        metadata: ObjectMeta::new(name, ORG_NAMESPACE),
        spec,
        status: None,
    }
}

/// A steward who may do everything the attacked operations need on the person's side, so what
/// refuses the run is never a missing binding.
fn state_with_a_steward() -> AppState {
    let state = AppState::new(Config::for_tests(), None).with_mirror(Arc::new(Mirror::new()));
    let kinds: Vec<&str> = vec![
        "Endpoint",
        "ContextSpace",
        "Pipeline",
        "Policy",
        "App",
        "Change",
        "ServiceAccount",
        "Project",
        "AgentProfile",
        "DataSource",
        "DataModel",
        "RoleBinding",
        "Role",
    ];
    state.mirror.upsert(org(
        "Role",
        "steward-role",
        json!({ "rules": [{ "kinds": kinds,
                            "verbs": ["read", "propose", "approve", "delete"] }] }),
    ));
    state.mirror.upsert(org(
        "RoleBinding",
        "steward-binding",
        json!({
            "subjects": [{ "group": "city-stewards" }],
            "role": "steward-role",
            "scope": { "project": PROJECT },
        }),
    ));
    state
}

/// The widest access block an author could write: every registered operation, every verb on every
/// kind any of them touches.
fn profile_naming_everything() -> Access {
    let operations: Vec<&str> = ops::registry().iter().map(|op| op.name).collect();
    let kinds: Vec<Value> = ops::registry()
        .iter()
        .map(|op| json!({ "kind": op.kind, "verbs": ["read", "propose", "approve", "delete"] }))
        .collect();
    Access::from_spec(&json!({ "access": { "operations": operations, "kinds": kinds } }))
}

fn op(name: &str) -> &'static ops::Operation {
    ops::find(name).unwrap_or_else(|| panic!("{name} is not registered"))
}

/// AG-11, AG-45: every operation of this vector is refused for an agent run on the caller and the
/// operation alone, and the reason names the act rather than a neighbouring one. A run reading
/// "an agent run does not start, cancel or publish another run" after asking for a key mint learns
/// nothing it can act on, which is why the reason is looked up by name.
#[test]
fn an_agent_run_is_refused_each_operation_a_person_must_perform_with_its_own_reason() {
    let run = Caller::for_run(steward(), Access::default());
    let mut refused = 0;
    for (name, expected) in attacked() {
        let Some(words) = expected else { continue };
        refused += 1;
        let err = run
            .may_run(op(name))
            .expect_err(&format!("{name} was allowed for an agent run"));
        let said = err.to_string();
        assert!(
            said.contains(words),
            "{name} was refused with the wrong act: {said}",
        );
        assert!(
            said.contains("a person "),
            "{name} does not say whose the act is: {said}",
        );
        assert!(
            said.contains("AG-11") || said.contains("AG-82"),
            "{name} does not cite the requirement it holds: {said}",
        );
        assert_eq!(
            StatusCode::FORBIDDEN,
            err.into_response().status(),
            "{name} reaches the caller as something other than a refusal",
        );
    }
    assert_eq!(
        refused, 11,
        "the vector no longer covers what it was written for"
    );
}

/// AG-11 and the owner's decision of 2026-09-17 (T-1005): an MCP client is a tool a model drives
/// even when it carries the person's token, so the decisions and the two ways out of a workspace
/// are refused over MCP as they are for a run. The rest of the vector is the person's own session,
/// through whichever door they chose — this case pins that boundary so a later reading of it is a
/// decision and not a drift.
#[test]
fn an_mcp_client_is_refused_every_decision_and_keeps_the_doors_a_person_may_use() {
    let over_mcp = Caller::new(steward(), Via::Mcp);
    let never_over_mcp = [
        "jc_change_approve",
        "jc_change_reject",
        "jc_workspace_propose",
        "jc_workspace_discard",
    ];
    for name in never_over_mcp {
        let said = over_mcp
            .may_run(op(name))
            .expect_err(&format!("{name} was allowed over MCP"))
            .to_string();
        assert!(said.contains("a person "), "{name}: {said}");
    }
    for (name, _) in attacked() {
        if never_over_mcp.contains(&name) {
            continue;
        }
        assert!(
            over_mcp.may_run(op(name)).is_ok(),
            "{name} is refused to a person's own MCP session, which no requirement asks for",
        );
    }
}

/// AG-70 before nothing: the profile only ever narrows, so naming an operation in it grants none of
/// this vector. The reason a refused run reads is the true one — being told the profile does not
/// grant what it plainly lists explains nothing.
#[test]
fn the_widest_profile_grants_none_of_them_and_never_answers_with_its_own_reason() {
    let wide = profile_naming_everything();
    let run = Caller::for_run(steward(), wide);
    let person = Caller::new(steward(), Via::Session);
    for (name, expected) in attacked() {
        let Some(words) = expected else {
            assert!(
                run.may_run(op(name)).is_ok(),
                "{name} is a proposal a run may make (AG-77) and was refused",
            );
            continue;
        };
        let said = run
            .may_run(op(name))
            .expect_err(&format!("the widest profile took {name}"))
            .to_string();
        assert!(said.contains(words), "{name}: {said}");
        assert!(
            !said.contains("agent profile does not grant"),
            "{name} was refused with the profile's reason, which explains nothing here: {said}",
        );
        // The rule is about runs, not a dead route: the same operation is the person's to take.
        assert!(
            person.may_run(op(name)).is_ok(),
            "{name} is refused even for a person at a keyboard",
        );
    }
}

/// API/01 §21: `GET …/ops` lists exactly the operations the caller would be let through, and
/// `tools/list` is the same listing. An operation refused only inside its body was still offered,
/// so a model was taught that minting a key is something it does and then fails at (the reasoning
/// of `may_run`, AG-63). None of this vector is offered to a run, whatever its profile says.
#[test]
fn not_one_of_them_is_offered_to_an_agent_run() {
    let state = state_with_a_steward();
    let run = Caller::for_run(steward(), profile_naming_everything());
    let offered: Vec<String> = ops::listing(&run, &state, PROJECT)
        .into_iter()
        .map(|summary| summary.name)
        .collect();
    for (name, expected) in attacked() {
        if expected.is_none() {
            continue;
        }
        assert!(
            !offered.contains(&name.to_owned()),
            "{name} is offered to a run that would always be refused it: {offered:?}",
        );
    }
    // The listing is not empty for want of a binding: the work a run is for is still in it.
    assert!(
        offered.iter().any(|name| name == "jc_workspace_open"),
        "the run was offered nothing at all, so this case proves nothing: {offered:?}",
    );
    // What a person sees at the same door still holds the decisions.
    let person = ops::listing(&Caller::new(steward(), Via::Session), &state, PROJECT);
    assert!(
        person
            .iter()
            .any(|summary| summary.name == "jc_change_approve"),
        "a person is no longer offered the approval this rule reserves for them",
    );
}

/// PF-50, AG-11: the refusal arrives before the input is looked at and before the body runs, so a
/// refused call writes nothing, fetches nothing and echoes nothing of what it was given. The forge
/// is a mock with nothing mounted: any request the Portal made against it would be recorded here.
#[tokio::test]
async fn a_refused_call_reaches_no_forge_and_echoes_nothing_of_its_input() {
    let gitea = MockServer::start().await;
    let state = common::state_on(&gitea).with_mirror(Arc::new(Mirror::new()));
    let run = Caller::for_run(steward(), profile_naming_everything());
    let over_mcp = Caller::new(steward(), Via::Mcp);

    for (name, expected) in attacked() {
        let Some(_) = expected else { continue };
        let input = attack_input(name);
        let mut callers = vec![("a run", &run)];
        if matches!(
            name,
            "jc_change_approve"
                | "jc_change_reject"
                | "jc_workspace_propose"
                | "jc_workspace_discard"
        ) {
            callers.push(("an MCP client", &over_mcp));
        }
        for (who, caller) in callers {
            let err = ops::call(op(name), caller, &state, PROJECT, input.clone())
                .await
                .expect_err(&format!("{who} was allowed {name}"));
            let said = format!("{err:?}");
            assert!(
                !said.contains(CANARY),
                "{name} answered {who} with its own input: {said}",
            );
            assert!(
                !said.contains("invalid_input") && !said.contains("InvalidInput"),
                "{name} read the input of a caller who may not run it: {said}",
            );
        }
    }
    let seen = gitea.received_requests().await.unwrap_or_default();
    assert!(
        seen.is_empty(),
        "a refused call reached the forge: {:?}",
        seen.iter().map(|r| r.url.to_string()).collect::<Vec<_>>(),
    );
}

/// AG-77: proposing a deletion is an agent's to do, and this is the half of the vector that is
/// refuted rather than fixed. A deletion is not a deletion until a person approves it: both
/// operations open a Red Change, and the approval of that Change is the one thing no profile
/// grants. Were the proposal itself closed, the four channels AG-77 requires would be three.
#[test]
fn a_run_may_propose_a_deletion_and_still_never_decides_one() {
    let run = Caller::for_run(steward(), profile_naming_everything());
    for name in ["jc_resource_delete", "jc_project_delete"] {
        let operation = op(name);
        assert!(
            run.may_run(operation).is_ok(),
            "{name} is the proposal AG-77 requires of every channel and was refused",
        );
        assert_eq!(
            Lane::Red,
            operation.lane,
            "{name} no longer takes the lane that makes a person approve it (CC-19, CC-39)",
        );
        assert!(
            operation.annotations.destructive_hint,
            "{name} no longer warns a client what it proposes",
        );
    }
    // The decision on whatever those proposals opened stays a person's.
    for decision in ops::registry()
        .iter()
        .filter(|op| op.kind == "Change" && op.verb == Some(Verb::Approve))
    {
        assert!(
            run.may_run(decision).is_err(),
            "{} would let a run finish the deletion it proposed",
            decision.name,
        );
    }
}

/// The same rule, read from the other side: an operation whose body refuses an agent run must be
/// refused by `may_run` too, or the listing lies about it. The body is the second lock; the gate is
/// the one `GET …/ops` can see.
#[test]
fn every_operation_the_registry_refuses_a_run_is_refused_before_it_is_listed() {
    let run = Caller::for_run(steward(), profile_naming_everything());
    let refused: Vec<&str> = ops::registry()
        .iter()
        .filter(|op| run.may_run(op).is_err())
        .map(|op| op.name)
        .collect();
    for (name, expected) in attacked() {
        assert_eq!(
            expected.is_some(),
            refused.contains(&name),
            "{name}: the gate and this vector no longer agree on whose the act is",
        );
    }
}

/// The refusal a person reads must not be the same sentence for two different acts, or it stops
/// being a reason. Every refusal of this vector is one of six distinct sentences: deciding a change,
/// bringing a workspace back, throwing one away, driving another run, answering a run's question,
/// and a service account's keys.
#[test]
fn the_refusals_of_this_vector_are_distinct_sentences() {
    let run = Caller::for_run(steward(), Access::default());
    let mut sentences: Vec<String> = attacked()
        .into_iter()
        .filter(|(_, expected)| expected.is_some())
        .map(|(name, _)| run.may_run(op(name)).expect_err("refused").to_string())
        .collect();
    sentences.sort();
    sentences.dedup();
    assert_eq!(
        6,
        sentences.len(),
        "six acts, six sentences; found {sentences:#?}",
    );
}

/// `OpError` carries the refusal to the caller as a 403 with a reason a person can act on, whichever
/// door they came through: the MCP door reads the same error the REST door does.
#[test]
fn the_refusal_reaches_every_door_as_a_forbidden_with_its_reason() {
    let run = Caller::for_run(steward(), Access::default());
    for (name, expected) in attacked() {
        let Some(words) = expected else { continue };
        let err: OpError = run.may_run(op(name)).expect_err("refused");
        let api: joinedcontext_portal::error::ApiError = err.into();
        let said = api.to_string();
        assert!(said.contains(words), "{name}: {said}");
        assert_eq!(
            StatusCode::FORBIDDEN,
            api.into_response().status(),
            "{name} does not reach a client as a refusal",
        );
    }
}
