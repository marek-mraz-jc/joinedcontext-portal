//! `get_schema` over the platform's kinds (AG-146, T-5948): the JSON Schema jc-core exports for a
//! kind, the same document `GET /api/v1/kinds/{kind}/schema`, the Portal forms and `jcctl validate`
//! read, so an MCP client learns a kind's fields in one call instead of guessing them.
//!
//! Decided (worker-t5948, owner may override): the schema is served in jc-core's own draft-07
//! dialect, because jc-core pins draft-07 (schema_export_tests) and every other reader takes that
//! document; a 2020-12 rewrite here would be a second copy that can drift. A 2020-12 validator
//! reads it by its `$schema`.

use serde::Deserialize;
use serde_json::{json, Value};

use super::{annotations, parse_input, OpError, Operation};
use crate::change::Lane;
use crate::error::ApiError;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SchemaInput {
    kind: String,
}

/// Every kind jc-core registers, in its order.
pub fn kinds() -> Vec<&'static str> {
    jc_core::registry::KINDS
        .iter()
        .map(|info| info.kind)
        .collect()
}

fn input_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "kind": {
                "type": "string",
                "description": "The manifest kind, e.g. Pipeline",
                "enum": kinds()
            }
        },
        "required": ["kind"],
        "additionalProperties": false,
        "examples": [{ "kind": "Pipeline" }]
    })
}

fn output_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "kind": { "type": "string" },
            "schema": { "type": "object", "description": "The kind's JSON Schema (draft-07, as jc-core exports it)" }
        },
        "required": ["kind", "schema"]
    })
}

/// The answer for one kind; an unknown kind is 404, as the REST door answers it.
pub fn schema_of(kind: &str) -> Result<Value, OpError> {
    let schema = jc_core::registry::schema_of(kind).ok_or_else(|| {
        OpError::Api(ApiError::NotFound(format!(
            "the platform has no kind named `{kind}`"
        )))
    })?;
    Ok(json!({ "kind": kind, "schema": schema }))
}

pub fn operations() -> Vec<Operation> {
    vec![Operation {
        name: "jc_schema_get",
        title: "Get Kind Schema",
        description: "Reads the JSON Schema of one manifest kind: its fields, their types and limits, never data",
        input: input_schema,
        output: output_schema,
        annotations: annotations(true, false, true),
        kind: "*",
        verb: None,
        lane: Lane::Green,
        validate: |val| parse_input::<SchemaInput>(val.clone()).map(|_| ()),
        run: |_caller, _state, _project, val| {
            Box::pin(async move { schema_of(&parse_input::<SchemaInput>(val)?.kind) })
        },
    }]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_kind_of_jc_core_answers_its_schema() {
        let kinds = kinds();
        assert!(kinds.len() >= 30, "only {} kinds", kinds.len());
        for kind in &kinds {
            let answer = schema_of(kind).expect("a registered kind has a schema");
            assert_eq!(answer["kind"], *kind);
            assert!(answer["schema"]["properties"]["spec"].is_object(), "{kind}");
        }
        assert_eq!(input_schema()["properties"]["kind"]["enum"], json!(kinds));
    }

    #[test]
    fn an_unknown_kind_is_not_found() {
        assert!(matches!(
            schema_of("NoSuchKind"),
            Err(OpError::Api(ApiError::NotFound(_)))
        ));
    }
}
