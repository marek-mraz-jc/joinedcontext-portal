//! A write in two calls (AG-149, API/14 §4.3, T-5956): `jc_change_plan` runs each change with the
//! resource API's dry run and keeps the result as a plan bound to its caller and to the etag of
//! every object it touches; `jc_change_apply` opens the change requests (or commits into the
//! workspace) only for that plan, unchanged, within 30 minutes. Neither approves anything: a
//! person approves at the change's page (AG-11, AG-151).
//!
//! Through a connector, a plan names only objects its scope reaches, and an apply needs the
//! connector's `writes` switch and `write` on every item (AG-144). A plan that fails a check is
//! answered 422 with every finding and is not kept, so a plan never holds a value the write path
//! refuses, a credential typed into a manifest included (MF-24, S-29).

use std::collections::HashMap;
use std::sync::Mutex;

use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::bounds::{manifest, text, NAME, TERM};
use super::{parse_input, Annotations, Caller, OpError, Operation};
use crate::api::delete::{self, DeleteOutcome};
use crate::api::mutate::{self, ProposeOutcome};
use crate::change::{Lane, Operation as ChangeOp};
use crate::connectors::{APPLY, PLAN};
use crate::error::ApiError;
use crate::state::AppState;

/// How long a plan may wait for its apply (AG-149).
pub const TTL_MINUTES: i64 = 30;
/// Changes one plan carries (API/14 §4.3).
const MAX_CHANGES: u64 = 50;
/// Plans one Portal keeps at once; the oldest goes first when a new one would pass it.
const MAX_PLANS: usize = 2_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Op {
    Create,
    Replace,
    Patch,
    Delete,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct ChangeInput {
    op: Op,
    kind: String,
    name: String,
    #[serde(default)]
    manifest: Option<Value>,
    #[serde(default)]
    patch: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct PlanInput {
    changes: Vec<ChangeInput>,
    #[serde(default)]
    workspace: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ApplyInput {
    plan_id: String,
}

/// One change of a kept plan: where it goes and what the object was when it was planned.
#[derive(Debug, Clone)]
struct Planned {
    kind: String,
    plural: &'static str,
    home: String,
    name: String,
    /// The whole manifest to propose; `None` for a delete.
    manifest: Option<Value>,
    base: String,
}

#[derive(Debug, Clone)]
struct Plan {
    owner: String,
    connector: Option<String>,
    project: String,
    workspace: Option<String>,
    items: Vec<Planned>,
    expires_at: DateTime<Utc>,
}

/// The plans waiting for their apply, in memory.
// ponytail: one replica (Deployment/02); plans live 30 minutes and a restart loses them, which a
// client answers by planning again. A second replica moves this into Postgres beside connectors.
#[derive(Debug, Default)]
pub struct PlanStore {
    plans: Mutex<HashMap<String, Plan>>,
}

impl PlanStore {
    fn keep(&self, id: String, plan: Plan, now: DateTime<Utc>) {
        let mut plans = self.plans.lock().unwrap_or_else(|p| p.into_inner());
        plans.retain(|_, p| p.expires_at > now);
        if plans.len() >= MAX_PLANS {
            if let Some(oldest) = plans
                .iter()
                .min_by_key(|(_, p)| p.expires_at)
                .map(|(id, _)| id.clone())
            {
                plans.remove(&oldest);
            }
        }
        plans.insert(id, plan);
    }

    /// Takes the plan out, so it is applied once: only for its own caller and connector, before
    /// it expires. Anyone else is told it is not there, which tells them nothing about it.
    fn take(
        &self,
        id: &str,
        owner: &str,
        connector: Option<&str>,
        now: DateTime<Utc>,
    ) -> Option<Plan> {
        let mut plans = self.plans.lock().unwrap_or_else(|p| p.into_inner());
        let mine = plans.get(id).is_some_and(|p| {
            p.owner == owner && p.connector.as_deref() == connector && p.expires_at > now
        });
        mine.then(|| plans.remove(id)).flatten()
    }
}

/// What an object is now, as a plan compares it: its metadata and spec (a status the reconciler
/// writes moves no etag), or `absent`.
fn etag(state: &AppState, home: &str, kind: &str, name: &str) -> String {
    match state.mirror.get(home, kind, name) {
        None => "absent".to_owned(),
        Some(envelope) => {
            let bytes = serde_json::to_vec(&json!({
                "metadata": envelope.metadata,
                "spec": envelope.spec,
            }))
            .unwrap_or_default();
            format!("{:x}", Sha256::digest(bytes))
        }
    }
}

/// 26 random base32 characters, like a connector id: not guessable.
fn new_id() -> String {
    use argon2::password_hash::rand_core::{OsRng, RngCore};
    const ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
    let mut bytes = [0u8; 26];
    OsRng.fill_bytes(&mut bytes);
    bytes
        .iter()
        .map(|b| char::from(ALPHABET[usize::from(b & 31)]))
        .collect()
}

fn invalid(path: String, message: String) -> OpError {
    OpError::InvalidInput { path, message }
}

/// The connector's half of one change (AG-144, AG-149).
fn through_connector(
    caller: &Caller,
    project: &str,
    kind: &str,
    name: &str,
    write: bool,
) -> Result<(), OpError> {
    match caller.access.as_ref().and_then(|a| a.connector()) {
        Some(connector) => connector
            .may_change(project, kind, name, write)
            .map_err(|why| OpError::Api(ApiError::Denied(why))),
        None => Ok(()),
    }
}

/// The manifest a change proposes: the one given, or the object now with the patch merged in.
fn manifest_of(
    state: &AppState,
    at: &str,
    home: &str,
    change: &ChangeInput,
) -> Result<Option<Value>, OpError> {
    let current = state.mirror.get(home, &change.kind, &change.name);
    let exists = current.is_some();
    let named = |what: &str| -> Result<Value, OpError> {
        match (what, &change.manifest, &change.patch) {
            ("manifest", Some(m), None) => Ok(m.clone()),
            ("patch", None, Some(p)) => Ok(p.clone()),
            _ => Err(invalid(
                format!("{at}/{what}"),
                format!("op {:?} takes {what} alone", change.op).to_lowercase(),
            )),
        }
    };
    let missing = || {
        invalid(
            format!("{at}/name"),
            format!(
                "{} '{}' does not exist in project {home}: use op create",
                change.kind, change.name
            ),
        )
    };
    let manifest = match change.op {
        Op::Create if exists => {
            return Err(invalid(
                format!("{at}/op"),
                format!(
                    "{} '{}' exists already: use op replace or patch",
                    change.kind, change.name
                ),
            ))
        }
        Op::Create => named("manifest")?,
        Op::Replace if !exists => return Err(missing()),
        Op::Replace => named("manifest")?,
        Op::Patch => {
            let patch = named("patch")?;
            let mut whole = serde_json::to_value(current.ok_or_else(missing)?)?;
            if let Some(map) = whole.as_object_mut() {
                map.remove("status");
            }
            crate::plan::merge_patch(&mut whole, &patch);
            whole
        }
        Op::Delete if !exists => return Err(missing()),
        Op::Delete if change.manifest.is_some() || change.patch.is_some() => {
            return Err(invalid(
                at.to_owned(),
                "op delete takes neither manifest nor patch".into(),
            ))
        }
        Op::Delete => return Ok(None),
    };
    for (member, want) in [("kind", &change.kind), ("metadata/name", &change.name)] {
        if manifest
            .pointer(&format!("/{member}"))
            .and_then(Value::as_str)
            != Some(want)
        {
            return Err(invalid(
                format!("{at}/manifest/{member}"),
                format!("the manifest's {member} must be the change's, '{want}'"),
            ));
        }
    }
    // A kind kept in the organization's namespace (a RoleBinding) is written there whatever
    // project the call names: say where, at the member, before the dry run's generic mismatch.
    if let Some(namespace) = manifest
        .pointer("/metadata/namespace")
        .and_then(Value::as_str)
        .filter(|ns| !ns.is_empty() && *ns != home)
    {
        return Err(invalid(
            format!("{at}/manifest/metadata/namespace"),
            format!(
                "{} lives in namespace '{home}', not '{namespace}': set metadata.namespace to \
                 '{home}' or leave it out",
                change.kind
            ),
        ));
    }
    Ok(Some(manifest))
}

/// One change checked: its diff, its verdict and what the plan keeps of it.
async fn checked(
    caller: &Caller,
    state: &AppState,
    project: &str,
    at: &str,
    change: &ChangeInput,
    workspace: Option<&str>,
) -> Result<(Value, Planned), OpError> {
    let info = super::resources::kind_named(&change.kind)?;
    through_connector(caller, project, info.kind, &change.name, false)?;
    let home = super::resources::home_holding(state, info, project, &change.name);
    let manifest = manifest_of(state, at, &home, change)?;
    let base = etag(state, &home, info.kind, &change.name);
    let answer = match &manifest {
        Some(m) => {
            let check = super::find("jc_manifest_dry_run").ok_or_else(|| {
                OpError::Api(ApiError::Internal(
                    "jc_manifest_dry_run is not registered".into(),
                ))
            })?;
            (check.run)(caller, state, &home, json!({ "manifest": m })).await?
        }
        None => match delete::delete_with_identity(
            &caller.identity,
            state,
            &home,
            info.plural,
            &change.name,
            true,
            workspace,
        )
        .await?
        {
            DeleteOutcome::DryRun(result) => {
                let mut out = serde_json::to_value(&result)?;
                out["verdict"] = json!({ "ok": result.valid, "findings": [] });
                out
            }
            DeleteOutcome::Referenced { here, elsewhere } => json!({
                "valid": false,
                "verdict": { "ok": false, "findings": [{
                    "level": "error",
                    "path": "",
                    "message": DeleteOutcome::conflict_message(&here, elsewhere),
                }] }
            }),
            DeleteOutcome::Proposed(_) | DeleteOutcome::Workspace(_) => {
                return Err(OpError::Api(ApiError::Internal(
                    "a dry run of a removal wrote something".into(),
                )))
            }
        },
    };
    let mut answer = answer;
    if let (Some(m), "Pipeline") = (&manifest, info.kind) {
        let warnings = super::replace_check::warnings(state, project, &home, m).await;
        if let Some(findings) = answer
            .pointer_mut("/verdict/findings")
            .and_then(Value::as_array_mut)
        {
            findings.extend(warnings);
        }
    }
    let diff = json!({
        "op": change.op_word(),
        "kind": info.kind,
        "name": change.name,
        "lane": answer.get("lane"),
        "plan": answer.get("plan"),
        "goesWith": answer.get("goesWith"),
        "restartsStream": answer.get("restartsStream"),
        "verdict": answer.get("verdict"),
    });
    let planned = Planned {
        kind: info.kind.to_owned(),
        plural: info.plural,
        home,
        name: change.name.clone(),
        manifest,
        base,
    };
    Ok((diff, planned))
}

impl ChangeInput {
    fn op_word(&self) -> &'static str {
        match self.op {
            Op::Create => "create",
            Op::Replace => "replace",
            Op::Patch => "patch",
            Op::Delete => "delete",
        }
    }
}

/// The findings of a red diff, as `path: message` per finding for the 422's `errors[]`.
fn findings_of(at: &str, diff: &Value) -> Vec<String> {
    let findings = diff
        .pointer("/verdict/findings")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut out: Vec<String> = findings
        .iter()
        .filter(|f| f["level"].as_str() != Some("warning") && f["level"].as_str() != Some("info"))
        .map(|f| {
            let path = f["path"].as_str().unwrap_or_default().replace('.', "/");
            let path = if path.is_empty() {
                format!("{at}/manifest")
            } else {
                format!("{at}/manifest/{path}")
            };
            format!(
                "{path}: {}",
                f["message"].as_str().unwrap_or("the check failed")
            )
        })
        .collect();
    if out.is_empty() {
        out.push(format!("{at}/manifest: the check failed"));
    }
    out
}

async fn plan(
    caller: &Caller,
    state: &AppState,
    project: &str,
    input: PlanInput,
) -> Result<Value, OpError> {
    let mut diffs = Vec::new();
    let mut items = Vec::new();
    let mut errors = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for (n, change) in input.changes.iter().enumerate() {
        let at = format!("/changes/{n}");
        if !seen.insert((change.kind.clone(), change.name.clone())) {
            return Err(invalid(
                at,
                format!("{} '{}' is in this plan twice", change.kind, change.name),
            ));
        }
        let (diff, planned) = checked(
            caller,
            state,
            project,
            &at,
            change,
            input.workspace.as_deref(),
        )
        .await?;
        if diff.pointer("/verdict/ok") != Some(&json!(true)) {
            errors.extend(findings_of(&at, &diff));
        }
        diffs.push(diff);
        items.push(planned);
    }
    if !errors.is_empty() {
        return Err(OpError::Api(ApiError::Unprocessable {
            detail: format!(
                "{} of the plan's changes fail their check; nothing was kept. Fix what errors[] \
                 names and plan again",
                errors.len()
            ),
            errors,
        }));
    }
    let now = Utc::now();
    let expires_at = now + Duration::minutes(TTL_MINUTES);
    let base_etag = {
        let mut hash = Sha256::new();
        for item in &items {
            hash.update(item.base.as_bytes());
        }
        format!("{:x}", hash.finalize())
    };
    let id = new_id();
    let lane = diffs
        .iter()
        .filter_map(|d| d["lane"].as_str())
        .max_by_key(|lane| match *lane {
            "red" => 2,
            "yellow" => 1,
            _ => 0,
        })
        .unwrap_or("green")
        .to_owned();
    let writes = caller
        .access
        .as_ref()
        .and_then(|a| a.connector())
        .is_none_or(|c| c.writes);
    state.plans.keep(
        id.clone(),
        Plan {
            owner: caller.identity.subject.clone(),
            connector: caller
                .access
                .as_ref()
                .and_then(|a| a.connector())
                .map(|c| c.id.clone()),
            project: project.to_owned(),
            workspace: input.workspace.clone(),
            items,
            expires_at,
        },
        now,
    );
    Ok(json!({
        "planId": id,
        "baseEtag": base_etag,
        "expiresAt": expires_at.to_rfc3339(),
        "lane": lane,
        "diff": diffs,
        "verdict": { "ok": true, "findings": [] },
        "next": if writes {
            format!("call {APPLY} with this planId within {TTL_MINUTES} minutes; a person approves the change in the Portal")
        } else {
            "this connector has writes off: a person applies this change in the Portal".to_owned()
        },
    }))
}

async fn apply(
    caller: &Caller,
    state: &AppState,
    project: &str,
    input: ApplyInput,
) -> Result<Value, OpError> {
    let connector = caller.access.as_ref().and_then(|a| a.connector());
    let now = Utc::now();
    let not_found = || {
        OpError::Api(ApiError::NotFound(format!(
            "plan '{}' is not there: it expired ({TTL_MINUTES} minutes), was applied, or was \
             made by someone else. Call {PLAN} again",
            input.plan_id
        )))
    };
    // The connector's switch first: a plan it may not apply stays for the Portal.
    if let Some(connector) = connector {
        if !connector.writes {
            return Err(OpError::Api(ApiError::Denied(format!(
                "this connector has writes off: apply the plan in the Portal, or turn writes on \
                 for connector {} on the My connectors page",
                connector.name
            ))));
        }
    }
    let plan = state
        .plans
        .take(
            &input.plan_id,
            &caller.identity.subject,
            connector.map(|c| c.id.as_str()),
            now,
        )
        .ok_or_else(not_found)?;
    if plan.project != project {
        return Err(not_found());
    }
    for item in &plan.items {
        through_connector(caller, project, &item.kind, &item.name, true)?;
    }
    let moved: Vec<String> = plan
        .items
        .iter()
        .filter(|item| etag(state, &item.home, &item.kind, &item.name) != item.base)
        .map(|item| format!("{} {}", item.kind, item.name))
        .collect();
    if !moved.is_empty() {
        return Err(OpError::Api(ApiError::Conflict(format!(
            "{} changed since the plan was made; nothing was applied. Read it again and call {PLAN} \
             anew",
            moved.join(", ")
        ))));
    }
    let workspace = plan.workspace.as_deref();
    let mut opened = Vec::new();
    for item in &plan.items {
        let outcome = match &item.manifest {
            None => match delete::delete_with_identity(
                &caller.identity,
                state,
                &item.home,
                item.plural,
                &item.name,
                false,
                workspace,
            )
            .await
            {
                Ok(DeleteOutcome::Proposed(change)) => Ok(ProposeOutcome::Change(change)),
                Ok(DeleteOutcome::Workspace(commit)) => Ok(ProposeOutcome::Workspace(commit)),
                Ok(other) => Err(ApiError::Conflict(match other {
                    DeleteOutcome::Referenced { here, elsewhere } => {
                        DeleteOutcome::conflict_message(&here, elsewhere)
                    }
                    _ => "the removal answered a dry run".into(),
                })),
                Err(err) => Err(err),
            },
            Some(manifest) => {
                let op = if item.base == "absent" {
                    ChangeOp::Create
                } else {
                    ChangeOp::Update
                };
                // Gated: the proposal needs the green verdict the plan's check recorded (PF-57).
                let outcome = mutate::propose_gated_in(
                    &caller.identity,
                    state,
                    &item.home,
                    item.plural,
                    Some(&item.name),
                    op,
                    manifest.clone(),
                    workspace,
                )
                .await;
                super::forget_check(state, &item.home, manifest).await;
                outcome
            }
        };
        match outcome {
            Ok(outcome) => opened.push(opened_row(outcome)),
            Err(err) if opened.is_empty() => return Err(OpError::Api(err)),
            Err(err) => {
                return Err(OpError::Api(ApiError::Conflict(format!(
                    "{} {} was not applied ({err}); these were: {}",
                    item.kind,
                    item.name,
                    serde_json::to_string(&opened).unwrap_or_default()
                ))))
            }
        }
    }
    let key = if workspace.is_some() {
        "workspaceChanges"
    } else {
        "changeRequests"
    };
    Ok(json!({
        key: opened,
        "approve": "a person with approve on these kinds decides each change at its url in the Portal",
    }))
}

/// What an apply opened, as API/14 §4.3 names it; never an approval.
fn opened_row(outcome: ProposeOutcome) -> Value {
    match outcome {
        ProposeOutcome::Change(change) => json!({
            "id": change.metadata.name,
            "url": change.status.merge_request,
            "lane": change.status.lane,
            "state": change.status.phase,
        }),
        ProposeOutcome::Workspace(commit) => json!({
            "workspace": commit.workspace,
            "id": commit.path,
            "branch": commit.branch,
            "lane": commit.lane,
        }),
        ProposeOutcome::DryRun(result) => serde_json::to_value(result).unwrap_or_default(),
    }
}

fn plan_input_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "changes": {
                "type": "array",
                "description": "The changes to plan together, e.g. [{\"op\": \"patch\", \"kind\": \"Pipeline\", \"name\": \"counters\", \"patch\": {\"spec\": {\"schedule\": {\"period\": \"PT15M\"}}}}]",
                "minItems": 1,
                "maxItems": MAX_CHANGES,
                "items": {
                    "type": "object",
                    "properties": {
                        "op": {
                            "type": "string",
                            "enum": ["create", "replace", "patch", "delete"],
                            "description": "create a new object, replace it whole, merge a JSON merge patch into it, or remove it"
                        },
                        "kind": text("The manifest kind, e.g. DataModel", TERM),
                        "name": text("The object's metadata.name, e.g. bike-counter", NAME),
                        "manifest": manifest("With create or replace: the whole manifest"),
                        "patch": { "type": "object", "description": "With patch: a JSON merge patch (RFC 7386) onto the current manifest" }
                    },
                    "required": ["op", "kind", "name"],
                    "additionalProperties": false
                }
            },
            "workspace": text("Commit into this workspace (a copy of the project) instead of opening change requests", NAME)
        },
        "required": ["changes"],
        "additionalProperties": false
    })
}

fn plan_output_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "planId": { "type": "string" },
            "baseEtag": { "type": "string" },
            "expiresAt": { "type": "string", "format": "date-time" },
            "lane": { "type": "string", "enum": ["green", "yellow", "red"] },
            "diff": { "type": "array", "items": { "type": "object" } },
            "verdict": { "type": "object" },
            "next": { "type": "string" }
        },
        "required": ["planId", "baseEtag", "expiresAt", "diff", "verdict"]
    })
}

fn apply_input_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "planId": text("The planId jc_change_plan answered", TERM)
        },
        "required": ["planId"],
        "additionalProperties": false
    })
}

fn apply_output_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "changeRequests": { "type": "array", "items": { "type": "object" } },
            "workspaceChanges": { "type": "array", "items": { "type": "object" } },
            "approve": { "type": "string" }
        }
    })
}

pub fn operations() -> Vec<Operation> {
    vec![
        Operation {
            name: PLAN,
            title: "Plan Change",
            description: "Checks one or more changes of any kind with the dry run (every check, nothing saved) and answers the diff, the verdict and a planId valid 30 minutes; a failing check answers 422 naming each field",
            input: plan_input_schema,
            output: plan_output_schema,
            annotations: Annotations {
                read_only_hint: false,
                destructive_hint: false,
                idempotent_hint: false,
            },
            kind: "*",
            verb: None,
            lane: Lane::Green,
            validate: |val| parse_input::<PlanInput>(val.clone()).map(|_| ()),
            run: |caller, state, project, val| {
                Box::pin(async move { plan(caller, state, project, parse_input(val)?).await })
            },
        },
        Operation {
            name: APPLY,
            title: "Apply Change",
            description: "Opens the change requests (or workspace commits) of an unchanged plan from jc_change_plan; 409 when an object moved since. Never approves: a person approves in the Portal",
            input: apply_input_schema,
            output: apply_output_schema,
            annotations: Annotations {
                read_only_hint: false,
                destructive_hint: false,
                idempotent_hint: false,
            },
            kind: "*",
            verb: None,
            // The plan was the look before the leap and a person still approves every change
            // it opens (AG-149): no second question at the door.
            lane: Lane::Green,
            validate: |val| parse_input::<ApplyInput>(val.clone()).map(|_| ()),
            run: |caller, state, project, val| {
                Box::pin(async move { apply(caller, state, project, parse_input(val)?).await })
            },
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caller(access: Option<crate::agents::access::Access>) -> Caller {
        Caller {
            identity: crate::auth::session::Identity {
                client: None,
                subject: "sub-jana".into(),
                username: "jana".into(),
                email: None,
                name: None,
                roles: vec![],
                groups: vec![],
                second_factor: false,
            },
            via: super::super::Via::Mcp,
            access,
            bearer: None,
        }
    }

    fn kept(store: &PlanStore, owner: &str, connector: Option<&str>, minutes: i64) -> String {
        let id = new_id();
        store.keep(
            id.clone(),
            Plan {
                owner: owner.into(),
                connector: connector.map(str::to_owned),
                project: "doprava".into(),
                workspace: None,
                items: vec![],
                expires_at: Utc::now() + Duration::minutes(minutes),
            },
            Utc::now(),
        );
        id
    }

    /// A plan answers only its own caller and connector, before it expires, and once.
    #[test]
    fn a_plan_is_taken_once_by_its_owner_through_its_connector() {
        let store = PlanStore::default();
        let now = Utc::now();
        let id = kept(&store, "sub-jana", Some("c1"), TTL_MINUTES);
        assert!(store.take(&id, "sub-eva", Some("c1"), now).is_none());
        assert!(store.take(&id, "sub-jana", Some("c2"), now).is_none());
        assert!(store.take(&id, "sub-jana", None, now).is_none());
        assert!(store.take(&id, "sub-jana", Some("c1"), now).is_some());
        assert!(store.take(&id, "sub-jana", Some("c1"), now).is_none());
        let stale = kept(&store, "sub-jana", None, -1);
        assert!(store.take(&stale, "sub-jana", None, now).is_none());
    }

    /// A connector with writes off is refused at the apply before any plan is looked at.
    #[tokio::test]
    async fn a_connector_with_writes_off_is_refused_at_the_apply() {
        let state = AppState::new(crate::config::Config::for_tests(), None);
        let connector = crate::connectors::Connector {
            id: "c1".into(),
            name: "doprava-in-claude".into(),
            owner: "sub-jana".into(),
            segments: vec!["context".into()],
            scope: vec![],
            writes: false,
            expires_at: Utc::now() + Duration::days(1),
            allowed_clients: vec![],
            client_is_boundary: false,
            state: "active".into(),
            created_at: Utc::now(),
            last_used_at: None,
            url: "https://portal.test/c/c1".into(),
            limits: crate::connectors::DEFAULT_LIMITS,
        };
        let id = kept(&state.plans, "sub-jana", Some("c1"), TTL_MINUTES);
        let err = apply(
            &caller(Some(connector.access())),
            &state,
            "doprava",
            ApplyInput {
                plan_id: id.clone(),
            },
        )
        .await
        .expect_err("writes off");
        assert!(err.to_string().contains("writes off"), "{err}");
        // The plan stays for the Portal.
        assert!(state
            .plans
            .take(&id, "sub-jana", Some("c1"), Utc::now())
            .is_some());
    }
}
