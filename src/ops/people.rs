//! People as operations of the registry (T-2732; PF-90…PF-94, AG-77, API/01 §24): the assistant
//! and an MCP client reach the same routes the Organization's People page calls, each operation
//! calling the route's own function, so the check is the route's — `Person` at organization
//! scope, and never a person who holds a right the caller lacks (PF-93).
//!
//! What stays a route of a person: resetting a password and removing a second factor, which hand
//! over or take away a way in, and deleting a person, which is a Change of its own. What no
//! operation ever answers: the temporary password a creation makes when the realm sends no
//! e-mail. The route answers it once, to the person at the Portal; a tool's answer reaches a
//! model, so here it is dropped and the answer says who hands one over instead.

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::bounds::{text, ID, TITLE};
use super::runs::as_user;
use super::{parse_input, Annotations, Operation};
use crate::api::people::{
    disable_person, edit_person, enable_person, get_person, list_people, sign_out_person,
};
use crate::change::Lane;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ListInput {
    #[serde(default)]
    search: Option<String>,
    #[serde(default)]
    first: Option<u32>,
    #[serde(default)]
    max: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct IdInput {
    id: String,
}

/// The route's `CreatePerson`, as the operation reads it and sends it on.
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CreateInput {
    email: String,
    first_name: String,
    last_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    locale: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct EditInput {
    id: String,
    #[serde(default)]
    first_name: Option<String>,
    #[serde(default)]
    last_name: Option<String>,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    locale: Option<String>,
}

/// What the answer says in place of a temporary password (PF-92).
const HAND_OVER: &str = "The realm sent no e-mail, so the person has no way in yet. A person \
     with update on Person gives them a password with Reset password on their page in the Portal; \
     a password is never answered to a tool.";

fn annotations(read_only: bool, destructive: bool, idempotent: bool) -> Annotations {
    Annotations {
        read_only_hint: read_only,
        destructive_hint: destructive,
        idempotent_hint: idempotent,
    }
}

fn id_schema(what: &str) -> Value {
    json!({
        "type": "object",
        "properties": { "id": text(what, ID) },
        "required": ["id"],
        "additionalProperties": false
    })
}

fn list_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "search": text("A part of the name or the e-mail", TITLE),
            "first": { "type": "integer", "minimum": 0, "description": "Offset, default 0" },
            "max": { "type": "integer", "minimum": 1, "maximum": 100, "description": "Page size, default 50" }
        },
        "additionalProperties": false
    })
}

fn create_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "email": text("The person's e-mail address: their sign-in name and where the invitation goes", 254),
            "firstName": text("Given name", 255),
            "lastName": text("Family name", 255),
            "locale": text("The Portal language they start in: en, sk, cs or de", 8)
        },
        "required": ["email", "firstName", "lastName"],
        "additionalProperties": false
    })
}

fn edit_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "id": text("The person's Keycloak user id", ID),
            "firstName": text("Given name", 255),
            "lastName": text("Family name", 255),
            "email": text("A new e-mail address, verified again", 254),
            "locale": text("The Portal language: en, sk, cs or de", 8)
        },
        "required": ["id"],
        "additionalProperties": false
    })
}

fn person_schema() -> Value {
    json!({ "type": "object", "description": "One person as the People page shows them" })
}

fn page_schema() -> Value {
    json!({ "type": "object", "description": "One page of people, with the total" })
}

fn created_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "person": person_schema(),
            "emailSent": { "type": "boolean" },
            "handOver": { "type": "string", "description": "Present when no e-mail went out: who gives the person a way in" }
        },
        "required": ["person", "emailSent"]
    })
}

fn signed_out_schema() -> Value {
    json!({
        "type": "object",
        "properties": { "id": { "type": "string" }, "signedOut": { "type": "boolean" } },
        "required": ["id", "signedOut"]
    })
}

pub fn operations() -> Vec<Operation> {
    vec![
        Operation {
            name: "jc_person_list",
            title: "List People",
            description: "Searches the people of the organization's realm and pages them. Needs `read` on Person at organization scope",
            input: list_schema,
            output: page_schema,
            annotations: annotations(true, false, true),
            // People live in the realm, not in a project, so the route's own check at
            // organization scope decides (PF-91); the registry does not pre-judge it.
            kind: "*",
            verb: None,
            lane: Lane::Green,
            validate: |val| parse_input::<ListInput>(val.clone()).map(|_| ()),
            run: |caller, state, _project, val| {
                Box::pin(async move {
                    let input: ListInput = parse_input(val)?;
                    let mut query = HashMap::new();
                    if let Some(search) = input.search {
                        query.insert("search".to_owned(), search);
                    }
                    if let Some(first) = input.first {
                        query.insert("first".to_owned(), first.to_string());
                    }
                    if let Some(max) = input.max {
                        query.insert("max".to_owned(), max.to_string());
                    }
                    let axum::Json(page) =
                        list_people(as_user(caller), State(state.clone()), Query(query)).await?;
                    Ok(serde_json::to_value(page)?)
                })
            },
        },
        Operation {
            name: "jc_person_get",
            title: "Get Person",
            description: "One person with their groups, platform roles and application roles. Needs `read` on Person",
            input: || id_schema("The person's Keycloak user id"),
            output: person_schema,
            annotations: annotations(true, false, true),
            kind: "*",
            verb: None,
            lane: Lane::Green,
            validate: |val| parse_input::<IdInput>(val.clone()).map(|_| ()),
            run: |caller, state, _project, val| {
                Box::pin(async move {
                    let input: IdInput = parse_input(val)?;
                    let axum::Json(person) =
                        get_person(as_user(caller), State(state.clone()), Path(input.id)).await?;
                    Ok(serde_json::to_value(person)?)
                })
            },
        },
        Operation {
            name: "jc_person_create",
            title: "Create Person",
            description: "Creates a person and sends the realm's execute-actions e-mail; without SMTP the route answers a temporary password once and the operation never does. Needs `create` on Person",
            input: create_schema,
            output: created_schema,
            annotations: annotations(false, false, false),
            kind: "*",
            verb: None,
            lane: Lane::Green,
            validate: |val| parse_input::<CreateInput>(val.clone()).map(|_| ()),
            run: |caller, state, _project, val| {
                Box::pin(async move {
                    let input: CreateInput = parse_input(val)?;
                    let body = serde_json::to_vec(&input)?;
                    let created =
                        crate::api::people::create(state, &caller.identity, &body).await?;
                    let mut answer =
                        json!({ "person": created.person, "emailSent": created.email_sent });
                    if created.temporary_password.is_some() {
                        answer["handOver"] = json!(HAND_OVER);
                    }
                    Ok(answer)
                })
            },
        },
        Operation {
            name: "jc_person_edit",
            title: "Edit Person",
            description: "Edits the name, the e-mail (verified again) or the language. Needs `update` on Person and every right the person holds",
            input: edit_schema,
            output: person_schema,
            annotations: annotations(false, false, true),
            kind: "*",
            verb: None,
            lane: Lane::Green,
            validate: |val| parse_input::<EditInput>(val.clone()).map(|_| ()),
            run: |caller, state, _project, val| {
                Box::pin(async move {
                    let input: EditInput = parse_input(val)?;
                    let mut body = serde_json::Map::new();
                    for (key, value) in [
                        ("firstName", input.first_name),
                        ("lastName", input.last_name),
                        ("email", input.email),
                        ("locale", input.locale),
                    ] {
                        if let Some(value) = value {
                            body.insert(key.to_owned(), Value::String(value));
                        }
                    }
                    let body = Bytes::from(serde_json::to_vec(&body)?);
                    let axum::Json(person) =
                        edit_person(as_user(caller), State(state.clone()), Path(input.id), body)
                            .await?;
                    Ok(serde_json::to_value(person)?)
                })
            },
        },
        Operation {
            name: "jc_person_disable",
            title: "Disable Person",
            description: "Disables the person and ends every session. Needs `disable` on Person; never the caller or the last Organization Administrator",
            input: || id_schema("The person's Keycloak user id"),
            output: person_schema,
            annotations: annotations(false, true, true),
            kind: "*",
            verb: None,
            lane: Lane::Green,
            validate: |val| parse_input::<IdInput>(val.clone()).map(|_| ()),
            run: |caller, state, _project, val| {
                Box::pin(async move {
                    let input: IdInput = parse_input(val)?;
                    let axum::Json(person) =
                        disable_person(as_user(caller), State(state.clone()), Path(input.id))
                            .await?;
                    Ok(serde_json::to_value(person)?)
                })
            },
        },
        Operation {
            name: "jc_person_enable",
            title: "Enable Person",
            description: "Enables a disabled person. Needs `disable` on Person",
            input: || id_schema("The person's Keycloak user id"),
            output: person_schema,
            annotations: annotations(false, false, true),
            kind: "*",
            verb: None,
            lane: Lane::Green,
            validate: |val| parse_input::<IdInput>(val.clone()).map(|_| ()),
            run: |caller, state, _project, val| {
                Box::pin(async move {
                    let input: IdInput = parse_input(val)?;
                    let axum::Json(person) =
                        enable_person(as_user(caller), State(state.clone()), Path(input.id))
                            .await?;
                    Ok(serde_json::to_value(person)?)
                })
            },
        },
        Operation {
            name: "jc_person_sign_out",
            title: "Sign Person Out",
            description: "Ends every session of the person. Needs `disable` on Person and every right the person holds",
            input: || id_schema("The person's Keycloak user id"),
            output: signed_out_schema,
            annotations: annotations(false, true, true),
            kind: "*",
            verb: None,
            lane: Lane::Green,
            validate: |val| parse_input::<IdInput>(val.clone()).map(|_| ()),
            run: |caller, state, _project, val| {
                Box::pin(async move {
                    let input: IdInput = parse_input(val)?;
                    sign_out_person(as_user(caller), State(state.clone()), Path(input.id.clone()))
                        .await?;
                    Ok(json!({ "id": input.id, "signedOut": true }))
                })
            },
        },
    ]
}
