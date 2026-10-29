//! T-6058: the tool definitions a model re-reads on every turn stay under a byte ratchet.
//!
//! A client hands its model each listed tool's name, description and input schema on every
//! turn (Claude, Claude Code and the connector lane's `tests/connector_scenarios/model.rs` alike),
//! so those bytes are paid once per turn per tool. `project`'s meaning is said once, in the
//! `initialize` instructions, and each tool's schema keeps its bounds.

use joinedcontext_portal::mcp::tool_definition;
use joinedcontext_portal::ops::{registry, summary};
use serde_json::{json, Value};

/// What a model reads of one tool.
fn read_by_the_model(tool: &Value) -> usize {
    json!({
        "name": tool["name"],
        "description": tool["description"],
        "inputSchema": tool["inputSchema"],
    })
    .to_string()
    .len()
}

/// The whole registry, as the Portal door lists it to a person who may run every operation: 78
/// tools measured 62,597 bytes on main 0023cec1 (125,945 with output schemas and the rest a client
/// keeps for itself). The ratchet only comes down.
#[test]
fn the_tool_definitions_a_model_reads_stay_under_their_byte_ratchet() {
    let mut sizes: Vec<(usize, &str)> = registry()
        .iter()
        .map(|op| (read_by_the_model(&tool_definition(&summary(op))), op.name))
        .collect();
    sizes.sort_unstable();
    let total: usize = sizes.iter().map(|(bytes, _)| bytes).sum();
    eprintln!("{} tools, {total} bytes: {sizes:?}", sizes.len());
    assert!(total < RATCHET, "{total} bytes, the ratchet is {RATCHET}");
}

/// 53,459 once `project` is said once in `initialize` and the descriptions lost what their names
/// and bounds already say (T-6058); 50,592 once the four per-kind propose tools, whose input was
/// `jc_resource_propose`'s, left the registry (T-6067).
const RATCHET: usize = 50_600;

/// The cut never opens a schema: every MCP input stays closed, and `project` stays bounded.
#[test]
fn every_listed_input_stays_closed_and_project_bounded() {
    for op in registry() {
        let tool = tool_definition(&summary(op));
        let schema = &tool["inputSchema"];
        assert_eq!(schema["additionalProperties"], json!(false), "{}", op.name);
        assert_eq!(
            schema["properties"]["project"]["maxLength"],
            json!(63),
            "{}",
            op.name
        );
        assert_eq!(schema.get("description"), None, "{}", op.name);
    }
}
