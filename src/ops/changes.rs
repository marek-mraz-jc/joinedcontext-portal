//! The operations on changes: the list a person reviews and the approval only a person may give
//! (CC-34, AG-11).

use super::bounds;
use super::serde_error_path_and_message;
use super::EmptyInput;
use super::OpError;
use super::Operation;
use super::OperationAnnotations;
use super::{empty_input_schema, resources};
use crate::api::changes;
use crate::change::Lane;
use jc_core::kinds::Verb;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ChangeApproveInput {
    pub id: String,
    #[serde(default)]
    pub confirm: Option<String>,
}

fn change_approve_input_schema() -> Value {
    use bounds::*;
    json!({
        "type": "object",
        "properties": {
            "id": text("The Change to approve", ID),
            "confirm": text(
                "For a red-lane Change: the Change's name, typed out as the confirmation (CC-19)",
                NAME
            )
        },
        "required": ["id"],
        "additionalProperties": false
    })
}

/// The `Change` resource as an MCP client reads it (T-0838).
///
/// Written out rather than derived from the OpenAPI document: utoipa's schema points at
/// `#/components/schemas/…`, a pointer no MCP client resolves, so a tool that published it
/// described nothing (AG-60).
fn change_document_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "apiVersion": { "type": "string" },
            "kind": { "type": "string", "enum": ["Change"] },
            "metadata": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "`chg-` and eight hex characters; what `jc_change_approve` takes as `id`" },
                    "namespace": { "type": "string" }
                },
                "required": ["name", "namespace"]
            },
            "status": {
                "type": "object",
                "properties": {
                    "lane": { "type": "string", "enum": ["green", "yellow", "red"] },
                    "phase": { "type": "string", "enum": ["PendingApproval", "Deploying", "Merged", "Applied", "Rejected"] },
                    "mergeRequest": { "type": "string" },
                    "plan": {
                        "type": "object",
                        "properties": {
                            "create": { "type": "integer" },
                            "update": { "type": "integer" },
                            "delete": { "type": "integer" }
                        }
                    }
                },
                "required": ["lane", "phase", "plan"]
            }
        },
        "required": ["apiVersion", "kind", "metadata", "status"]
    })
}

/// What every propose, the resource delete and a rejection answer: the id and the lane beside
/// the `Change` itself, which is what the caller gets, not the bare resource (T-0838).
pub(crate) fn change_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "changeId": { "type": "string", "description": "The change's name; `jc_change_approve` takes it as `id`" },
            "lane": { "type": "string", "enum": ["green", "yellow", "red"] },
            "url": { "type": "string", "description": "The merge request to review, when the forge has one" },
            "change": change_document_schema(),
            "warning": { "type": "string", "description": "Present when the draft was proposed without a fresh green verdict" }
        },
        "required": ["changeId", "lane", "change"]
    })
}

/// What `jc_change_list` answers: the list envelope, not one proposal (T-0838).
fn change_list_output_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "apiVersion": { "type": "string" },
            "kind": { "type": "string", "enum": ["ChangeList"] },
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": { "type": "string" },
                        "title": { "type": "string" },
                        "lane": { "type": "string", "enum": ["green", "yellow", "red"] },
                        "phase": { "type": "string" },
                        "mergeRequest": { "type": "string" },
                        "proposedBy": { "type": "string" }
                    }
                }
            }
        },
        "required": ["apiVersion", "kind", "items"]
    })
}

/// The `Change` the approval answers: the resource itself, with no wrapper around it.
fn approved_change_schema() -> Value {
    change_document_schema()
}

/// This module's operations in the registry (`super::init_registry`).
pub fn operations() -> Vec<Operation> {
    vec![
        Operation {
            name: "jc_change_list",
            title: "List Changes",
            description: "Lists open change proposals and merge requests for review",
            input: empty_input_schema,
            output: change_list_output_schema,
            annotations: OperationAnnotations {
                read_only_hint: true,
                destructive_hint: false,
                idempotent_hint: true,
            },
            // A Change is no manifest kind, so `access.kinds` cannot name it (MF-40) and a profile
            // could never be offered this read. Verbless, so the kind plays no part in `permitted`
            // either: the function checks that the caller may read the project (T-1475, AG-70).
            kind: "*",
            verb: None,
            lane: Lane::Green,
            validate: |val| {
                serde_json::from_value::<EmptyInput>(val.clone())
                    .map(|_| ())
                    .map_err(|e| {
                        let (path, message) = serde_error_path_and_message(&e);
                        OpError::InvalidInput { path, message }
                    })
            },
            run: |caller, state, project, val| {
                Box::pin(async move {
                    let _: EmptyInput = serde_json::from_value(val).map_err(|e| {
                        let (path, message) = serde_error_path_and_message(&e);
                        OpError::InvalidInput { path, message }
                    })?;
                    let list =
                        changes::list_changes_readable(state, &caller.identity, project).await?;
                    Ok(serde_json::to_value(list)?)
                })
            },
        },
        Operation {
            name: "jc_change_approve",
            title: "Approve Change",
            description: "Approves and merges a change proposal",
            input: change_approve_input_schema,
            output: approved_change_schema,
            annotations: OperationAnnotations {
                read_only_hint: false,
                destructive_hint: true,
                idempotent_hint: false,
            },
            kind: "Change",
            verb: Some(Verb::Approve),
            lane: Lane::Red,
            validate: |val| {
                serde_json::from_value::<ChangeApproveInput>(val.clone())
                    .map(|_| ())
                    .map_err(|e| {
                        let (path, message) = serde_error_path_and_message(&e);
                        OpError::InvalidInput { path, message }
                    })
            },
            run: |caller, state, project, val| {
                Box::pin(async move {
                    resources::refuse_agent_decision(caller)?;
                    let input: ChangeApproveInput = serde_json::from_value(val).map_err(|e| {
                        let (path, message) = serde_error_path_and_message(&e);
                        OpError::InvalidInput { path, message }
                    })?;
                    let change = changes::approve_change_for(
                        state,
                        &caller.identity,
                        project,
                        &input.id,
                        input.confirm.as_deref(),
                        changes::ApprovedBy::Operation,
                    )
                    .await?;
                    Ok(serde_json::to_value(change)?)
                })
            },
        },
    ]
}
