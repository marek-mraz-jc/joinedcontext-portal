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

use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;

use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::bounds::{manifest, text, NAME, TERM};
use super::{parse_input, Annotations, Caller, OpError, Operation};
use crate::api::datamodels::{self, ModelChange, SourceDryRunResult};
use crate::api::delete::{self, DeleteOutcome};
use crate::api::mutate::{self, ProposeOutcome};
use crate::change::{Lane, Operation as ChangeOp};
use crate::connectors::{APPLY, PLAN, REVERT};
use crate::error::ApiError;
use crate::state::AppState;
use crate::tools::model_tools::MAX_REQUEST_BYTES;

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
    /// With a DataModel: the whole LinkML file `spec.linkml` names (S-10, S-15).
    #[serde(default)]
    source: Option<String>,
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
    /// A DataModel planned with its LinkML file, checked as the source route checks it.
    model: Option<ModelPlan>,
}

/// The LinkML half of a DataModel change, and the published file it was checked against.
#[derive(Debug, Clone)]
struct ModelPlan {
    source: String,
    checked: SourceDryRunResult,
    next_val: Value,
    imports: BTreeMap<String, String>,
    creating: bool,
    /// [`source_etag`] of the published file at plan time.
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

/// What the published LinkML file of a DataModel is now: its hash, or `absent`. An apply over a
/// file that moved since the plan would overwrite someone's change.
async fn source_etag(state: &AppState, home: &str, name: &str) -> Result<String, OpError> {
    if state.mirror.get(home, "DataModel", name).is_none() {
        return Ok("absent".to_owned());
    }
    match datamodels::read_source(state, home, name).await {
        Ok(text) => Ok(format!("{:x}", Sha256::digest(text.as_bytes()))),
        Err(ApiError::NotFound(_)) => Ok("absent".to_owned()),
        Err(err) => Err(OpError::Api(err)),
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
    let named = |what: &str| given(at, change, what);
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
        Op::Patch => patched(
            at,
            change,
            serde_json::to_value(current.ok_or_else(missing)?)?,
        )?,
        Op::Delete if !exists => return Err(missing()),
        Op::Delete if change.manifest.is_some() || change.patch.is_some() => {
            return Err(invalid(
                at.to_owned(),
                "op delete takes neither manifest nor patch".into(),
            ))
        }
        Op::Delete => return Ok(None),
    };
    names_the_change(at, home, change, &manifest)?;
    Ok(Some(manifest))
}

/// The object now, without its status, with the change's patch merged in; a patch that only
/// carries a LinkML source leaves the manifest as it is.
fn patched(at: &str, change: &ChangeInput, mut whole: Value) -> Result<Value, OpError> {
    let patch = match (&change.patch, &change.source) {
        (None, Some(_)) => json!({}),
        _ => given(at, change, "patch")?,
    };
    if let Some(map) = whole.as_object_mut() {
        map.remove("status");
    }
    crate::plan::merge_patch(&mut whole, &patch);
    Ok(whole)
}

/// The manifest or the patch a change carries, refused when it carries the other one too.
fn given(at: &str, change: &ChangeInput, what: &str) -> Result<Value, OpError> {
    match (what, &change.manifest, &change.patch) {
        ("manifest", Some(m), None) => Ok(m.clone()),
        ("patch", None, Some(p)) => Ok(p.clone()),
        _ => Err(invalid(
            format!("{at}/{what}"),
            format!("op {:?} takes {what} alone", change.op).to_lowercase(),
        )),
    }
}

/// The manifest names the change's kind and object, in the namespace the object lives in.
fn names_the_change(
    at: &str,
    home: &str,
    change: &ChangeInput,
    manifest: &Value,
) -> Result<(), OpError> {
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
    Ok(())
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
    if change.source.is_some() {
        source_fits(at, info.kind, change, workspace)?;
    }
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
        None => removal_dry_run(caller, state, &home, info.plural, &change.name, workspace).await?,
    };
    let model = match change.source {
        None => None,
        Some(_) => Some(model_checked(caller, state, at, &home, change, manifest.as_ref()).await?),
    };
    let mut diff = json!({
        "op": change.op_word(),
        "kind": info.kind,
        "name": change.name,
        "lane": answer.get("lane"),
        "plan": answer.get("plan"),
        "goesWith": answer.get("goesWith"),
        "restartsStream": answer.get("restartsStream"),
        "verdict": answer.get("verdict"),
    });
    let model = match model {
        None => None,
        Some((shown, Err(findings))) => {
            diff["model"] = shown;
            diff["verdict"]["ok"] = json!(false);
            if let Some(all) = diff["verdict"]["findings"].as_array_mut() {
                all.extend(findings);
            } else {
                diff["verdict"]["findings"] = Value::Array(findings);
            }
            None
        }
        Some((shown, Ok(model))) => {
            diff["lane"] = shown["lane"].clone();
            diff["model"] = shown;
            Some(model)
        }
    };
    let planned = Planned {
        kind: info.kind.to_owned(),
        plural: info.plural,
        home,
        name: change.name.clone(),
        manifest,
        base,
        model,
    };
    Ok((diff, planned))
}

/// A LinkML source rides only on a DataModel change that is no removal and no workspace commit.
fn source_fits(
    at: &str,
    kind: &str,
    change: &ChangeInput,
    workspace: Option<&str>,
) -> Result<(), OpError> {
    let refuse = |why: &str| Err(invalid(format!("{at}/source"), why.to_owned()));
    if kind != "DataModel" {
        return refuse("only a DataModel change carries a LinkML source");
    }
    if change.op == Op::Delete {
        return refuse("op delete takes no source");
    }
    if workspace.is_some() {
        return refuse("a model's source opens its own change request: plan it without workspace");
    }
    Ok(())
}

/// The dry run of a removal, in the shape `jc_manifest_dry_run` answers.
async fn removal_dry_run(
    caller: &Caller,
    state: &AppState,
    home: &str,
    plural: &'static str,
    name: &str,
    workspace: Option<&str>,
) -> Result<Value, OpError> {
    Ok(
        match delete::delete_with_identity(
            &caller.identity,
            state,
            home,
            plural,
            name,
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
    )
}

/// The LinkML half of a DataModel change (S-10, S-15): the check `PUT .../source` runs (no
/// literal secret, versioning, ranges that name a defined class, Model Tools), and for each
/// breaking change the stored entities of the classes it touches. Answers what the diff shows,
/// and the plan's half or the findings that refuse it.
async fn model_checked(
    caller: &Caller,
    state: &AppState,
    at: &str,
    home: &str,
    change: &ChangeInput,
    manifest: Option<&Value>,
) -> Result<(Value, Result<ModelPlan, Vec<Value>>), OpError> {
    let source = change.source.as_deref().unwrap_or_default();
    let Some(manifest) = manifest else {
        return Err(invalid(
            format!("{at}/source"),
            "op delete takes no source".into(),
        ));
    };
    let current = state.mirror.get(home, "DataModel", &change.name);
    let creating = current.is_none();
    let spec = current.map_or_else(|| manifest["spec"].clone(), |envelope| envelope.spec);
    let wanted = manifest.pointer("/spec/version").and_then(Value::as_str);
    let version = match (creating, wanted) {
        (true, wanted) => Some(wanted.unwrap_or("0.1.0")),
        (false, Some(wanted)) if spec["version"].as_str() != Some(wanted) => Some(wanted),
        (false, _) => None,
    };
    let base = source_etag(state, home, &change.name).await?;
    let checked = datamodels::check_source(
        state,
        &caller.identity,
        home,
        &change.name,
        &spec,
        source,
        version,
    )
    .await;
    let finding = |path: &str, message: String| json!({ "level": "error", "at": format!("/source{path}"), "message": message });
    let (checked, next_val, imports) = match checked {
        Ok(done) => done,
        Err(ApiError::Invalid { detail, errors }) => {
            let findings = errors
                .iter()
                .map(|error| match error.split_once(": ") {
                    Some((path, message)) if !path.contains(' ') => {
                        finding(&format!("/{path}"), message.to_owned())
                    }
                    _ => finding("", format!("{detail}: {error}")),
                })
                .collect();
            return Ok((json!({ "ok": false }), Err(findings)));
        }
        Err(ApiError::BadRequest(message)) => {
            return Ok((json!({ "ok": false }), Err(vec![finding("", message)])))
        }
        Err(err) => return Err(OpError::Api(err)),
    };
    let lane = datamodels::model_lane(home, creating, &checked.severity);
    let changes = affected(state, home, &change.name, manifest, &checked.changes).await;
    let shown = json!({
        "ok": true,
        "file": manifest.pointer("/spec/linkml"),
        "severity": checked.severity,
        "version": checked.version,
        "lane": lane,
        "changes": changes,
    });
    let plan = ModelPlan {
        source: source.to_owned(),
        checked,
        next_val,
        imports,
        creating,
        base,
    };
    Ok((shown, Ok(plan)))
}

/// The model's changes, each breaking one with `affectedEntities`: how many stored entities of
/// the classes it touches the model's space holds, as its broker counts them by type.
// ponytail: counts the class itself, not its `is_a` subclasses; add those when a seeded model
// stores entities of a subclass.
async fn affected(
    state: &AppState,
    home: &str,
    name: &str,
    manifest: &Value,
    changes: &[ModelChange],
) -> Vec<Value> {
    let mut rows: Vec<Value> = changes
        .iter()
        .map(|change| serde_json::to_value(change).unwrap_or_default())
        .collect();
    if !changes.iter().any(|change| change.severity == "breaking") {
        return rows;
    }
    let published: Value = datamodels::read_source(state, home, name)
        .await
        .ok()
        .and_then(|text| serde_norway::from_str(&text).ok())
        .unwrap_or(Value::Null);
    let space = manifest
        .pointer("/spec/contextSpaceRef")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let counted: Result<BTreeMap<String, u64>, String> = if space.is_empty() {
        Err("the model names no contextSpaceRef".to_owned())
    } else {
        let broker = crate::spaces::broker(&state.mirror, home, space);
        let tenant = crate::spaces::segment(&state.mirror, home, space);
        match state.space_usage.usage(&broker, &tenant).await {
            Ok(usage) => match usage.bytes {
                Some(bytes) => Ok(bytes.by_type),
                None if usage.entities == 0 => Ok(BTreeMap::new()),
                None => Err(format!("broker '{broker}' does not count by type")),
            },
            Err(why) => Err(why),
        }
    };
    for (row, change) in rows.iter_mut().zip(changes) {
        let classes = classes_of(&published, &change.subject);
        if change.severity != "breaking" || classes.is_empty() {
            continue;
        }
        match &counted {
            Ok(by_type) => {
                let held: u64 = by_type
                    .iter()
                    .filter(|(iri, _)| {
                        let term = iri.rsplit(['/', '#']).next().unwrap_or(iri);
                        classes.iter().any(|class| class == term)
                    })
                    .map(|(_, n)| *n)
                    .sum();
                row["affectedEntities"] = json!(held);
                row["space"] = json!(space);
            }
            Err(why) => {
                row["affectedEntities"] = Value::Null;
                row["notCounted"] = json!(format!(
                    "the stored {} entities could not be counted: {why}",
                    classes.join(", ")
                ));
            }
        }
    }
    rows
}

/// The classes of the published model a change's subject touches: `Class` or `Class.slot`, or
/// every class that lists a top-level slot.
fn classes_of(published: &Value, subject: &str) -> Vec<String> {
    let Some(classes) = published["classes"].as_object() else {
        return Vec::new();
    };
    let head = subject.split('.').next().unwrap_or(subject);
    if classes.contains_key(head) {
        return vec![head.to_owned()];
    }
    classes
        .iter()
        .filter(|(_, class)| {
            class["slots"]
                .as_array()
                .is_some_and(|slots| slots.iter().any(|slot| slot == subject))
        })
        .map(|(class, _)| class.clone())
        .collect()
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
            let path = if let Some(within) = f["at"].as_str() {
                format!("{at}{within}")
            } else if path.is_empty() {
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

/// What the proposal's verdict gate (PF-57) refuses for a planned manifest whose dry run was
/// green: a Pipeline's records are tested on a sample, not dry-run (T-4840). Asked at plan time,
/// so a plan never promises a change its apply cannot open, and again before an apply commits
/// anything, so an apply never opens half a plan.
async fn gate_refusal(state: &AppState, item: &Planned) -> Result<Option<String>, OpError> {
    let Some(manifest) = &item.manifest else {
        return Ok(None);
    };
    match super::verdict_for_manifest(state, &item.home, manifest).await {
        Ok(_) => Ok(None),
        Err(OpError::Conflict(body)) => Ok(Some(format!(
            "{} Run `{}` on it, then call {PLAN} again",
            body["detail"].as_str().unwrap_or("its check is not fresh."),
            body["check"].as_str().unwrap_or("jc_manifest_dry_run")
        ))),
        Err(other) => Err(other),
    }
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
    // A plan waits in memory with its sources: all of them together stay under one source's cap.
    let sources: usize = input
        .changes
        .iter()
        .filter_map(|change| change.source.as_ref())
        .map(String::len)
        .sum();
    if sources > MAX_REQUEST_BYTES {
        return Err(invalid(
            "/changes".into(),
            format!(
                "the plan's LinkML sources take {sources} bytes together, more than the \
                 {MAX_REQUEST_BYTES} byte limit: plan the models one at a time"
            ),
        ));
    }
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
        } else if let Some(refusal) = gate_refusal(state, &planned).await? {
            errors.push(format!("{at}/manifest: {refusal}"));
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
    unchanged_and_gated(state, &plan.items).await?;
    let workspace = plan.workspace.as_deref();
    let mut opened = Vec::new();
    for item in &plan.items {
        match open_one(caller, state, item, workspace).await {
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

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct RevertInput {
    id: String,
    #[serde(default)]
    workspace: Option<String>,
}

/// A file of the forge as a value: the YAML parsed, or its text when it is no YAML, so two reads
/// of one file compare by content and not by formatting.
async fn file_at(
    forge: &crate::git::GiteaClient,
    path: &str,
    at: &str,
) -> Result<Option<Value>, OpError> {
    Ok(forge
        .get_file(path, at)
        .await
        .map_err(ApiError::from)?
        .map(|file| {
            serde_norway::from_str::<Value>(&file.content).unwrap_or(Value::String(file.content))
        }))
}

/// The kind and name a manifest names, when it is one of this Portal's kinds.
fn manifest_names(manifest: &Value) -> Option<(String, String)> {
    let kind = manifest.get("kind").and_then(Value::as_str)?;
    let name = manifest.pointer("/metadata/name").and_then(Value::as_str)?;
    crate::resource::by_kind(kind).map(|info| (info.kind.to_owned(), name.to_owned()))
}

/// The plan that undoes merged change `id` (T-5974, S-53): every file it touched goes back to what
/// it was at the commit the change was cut from. A file main changed since the merge is a
/// conflict, and a file that is no manifest of the project cannot be planned: both are named and
/// nothing is kept. The revert is then an ordinary plan, so it is checked, held to the caller's
/// rights and the connector's scope, and opened by `jc_change_apply` for a person to approve.
async fn revert(
    caller: &Caller,
    state: &AppState,
    project: &str,
    input: RevertInput,
) -> Result<Value, OpError> {
    let missing = || {
        OpError::Api(ApiError::NotFound(format!(
            "change '{}' not found in project '{project}'",
            input.id
        )))
    };
    let effective = crate::permissions::for_request(state, &caller.identity, project);
    if !effective.may_read_project() {
        return Err(missing());
    }
    let (forge, number) = crate::api::changes::resolve_change(state, project, &input.id)?;
    let pr = match forge.pull_request(number).await {
        Ok(pr) => pr,
        Err(crate::git::GitError::NotFound | crate::git::GitError::Api { status: 404, .. }) => {
            return Err(missing())
        }
        Err(err) => return Err(OpError::Api(err.into())),
    };
    // Only a change the Portal opened is the Portal's to revert, as `/undo` holds (T-3274).
    let branch = pr
        .head_branch
        .strip_prefix("refs/heads/")
        .unwrap_or(&pr.head_branch);
    if !branch.starts_with("portal/") && !branch.starts_with("workspace/") {
        return Err(missing());
    }
    if !pr.merged || pr.merge_base.is_empty() {
        return Err(OpError::Api(ApiError::Conflict(format!(
            "change '{}' is not merged, so there is nothing to revert: reject it on its page instead",
            input.id
        ))));
    }
    let after = if pr.merge_commit_sha.is_empty() {
        pr.head_ref().to_owned()
    } else {
        pr.merge_commit_sha.clone()
    };
    let home = format!("projects/{project}/");
    let files = forge
        .pull_request_files(number)
        .await
        .map_err(ApiError::from)?;
    let mut changes = Vec::new();
    let mut moved = Vec::new();
    let mut outside = Vec::new();
    for file in &files {
        if !file.path.starts_with(&home) {
            outside.push(format!(
                "{}: outside project {project}; revert it in the forge",
                file.path
            ));
            continue;
        }
        let before = file_at(&forge, &file.path, &pr.merge_base).await?;
        let now = file_at(&forge, &file.path, &pr.base_branch).await?;
        let made = file_at(&forge, &file.path, &after).await?;
        let Some((kind, name)) = [&before, &made, &now]
            .into_iter()
            .find_map(|v| v.as_ref().and_then(manifest_names))
        else {
            outside.push(format!(
                "{}: no manifest, so no plan can write it; revert it in the forge",
                file.path
            ));
            continue;
        };
        // A narrowed connector hears of nothing outside its scope, a conflict included.
        through_connector(caller, project, &kind, &name, false)?;
        if now != made {
            moved.push(file.path.clone());
            continue;
        }
        let (op, manifest) = match (before, now.is_some()) {
            (Some(before), true) => (Op::Replace, Some(before)),
            (Some(before), false) => (Op::Create, Some(before)),
            (None, true) => (Op::Delete, None),
            (None, false) => continue,
        };
        // The revert writes what the original wrote, so it needs the same right on each item:
        // a manifest put back is judged as its proposal is, its space and constraints included.
        match &manifest {
            Some(m) => {
                let envelope =
                    serde_json::from_value::<crate::resource::ResourceEnvelope>(m.clone())
                        .map_err(|err| invalid("/id".into(), format!("{}: {err}", file.path)))?;
                crate::api::import::authorize_manifest(
                    state,
                    &caller.identity,
                    project,
                    &effective,
                    &envelope,
                )?;
            }
            None => effective.check(&kind, jc_core::kinds::Verb::Delete, None)?,
        }
        changes.push(ChangeInput {
            op,
            kind,
            name,
            manifest,
            patch: None,
            source: None,
        });
    }
    if !moved.is_empty() {
        return Err(OpError::Api(ApiError::Conflict(format!(
            "main changed {} since change '{}' was merged, so a revert would undo that too; \
             nothing was planned. Plan the change you want with {PLAN} instead",
            moved.join(", "),
            input.id
        ))));
    }
    if !outside.is_empty() {
        return Err(OpError::Api(ApiError::Unprocessable {
            detail: format!(
                "change '{}' touched files a plan cannot write; nothing was planned",
                input.id
            ),
            errors: outside,
        }));
    }
    if changes.is_empty() {
        return Err(OpError::Api(ApiError::Conflict(format!(
            "change '{}' left nothing to revert",
            input.id
        ))));
    }
    let mut answer = plan(
        caller,
        state,
        project,
        PlanInput {
            changes,
            workspace: input.workspace,
        },
    )
    .await?;
    answer["reverts"] = json!(input.id);
    Ok(answer)
}

/// Refuses the whole plan when an object moved since it was planned or its gate turned red.
async fn unchanged_and_gated(state: &AppState, items: &[Planned]) -> Result<(), OpError> {
    let mut moved: Vec<String> = Vec::new();
    for item in items {
        let file_moved = match &item.model {
            Some(model) => source_etag(state, &item.home, &item.name).await? != model.base,
            None => false,
        };
        if file_moved || etag(state, &item.home, &item.kind, &item.name) != item.base {
            moved.push(format!("{} {}", item.kind, item.name));
        }
    }
    if !moved.is_empty() {
        return Err(OpError::Api(ApiError::Conflict(format!(
            "{} changed since the plan was made; nothing was applied. Read it again and call {PLAN} \
             anew",
            moved.join(", ")
        ))));
    }
    let mut refused = Vec::new();
    for item in items {
        if let Some(refusal) = gate_refusal(state, item).await? {
            refused.push(format!("{} {}: {refusal}", item.kind, item.name));
        }
    }
    if !refused.is_empty() {
        return Err(OpError::Api(ApiError::Conflict(format!(
            "nothing was applied: {}",
            refused.join("; ")
        ))));
    }
    Ok(())
}

/// Opens one planned change: its change request, or its commit on the workspace.
async fn open_one(
    caller: &Caller,
    state: &AppState,
    item: &Planned,
    workspace: Option<&str>,
) -> Result<ProposeOutcome, ApiError> {
    match &item.manifest {
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
        Some(manifest) if item.model.is_some() => {
            let outcome = propose_source(caller, state, item, manifest).await;
            super::forget_check(state, &item.home, manifest).await;
            outcome.map(ProposeOutcome::Change)
        }
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
    }
}

/// Opens the change of a DataModel planned with its LinkML file: manifest, source and generated
/// artifacts in one change request, as `PUT .../source` opens it (DM-22).
async fn propose_source(
    caller: &Caller,
    state: &AppState,
    item: &Planned,
    manifest: &Value,
) -> Result<crate::change::Change, ApiError> {
    let model = item
        .model
        .as_ref()
        .ok_or_else(|| ApiError::Internal("a model change without its source".into()))?;
    crate::permissions::for_request(state, &caller.identity, &item.home).check(
        "DataModel",
        jc_core::kinds::Verb::Propose,
        Some(manifest),
    )?;
    let envelope: crate::resource::ResourceEnvelope = serde_json::from_value(manifest.clone())
        .map_err(|e| ApiError::BadRequest(format!("invalid DataModel manifest: {e}")))?;
    let (verb, noun) = if model.creating {
        ("create", "creation")
    } else {
        ("update", "update")
    };
    datamodels::propose_model(
        state,
        &caller.identity,
        datamodels::ModelProposal {
            namespace: &item.home,
            name: &item.name,
            envelope,
            source: &model.source,
            checked: model.checked.clone(),
            next_val: model.next_val.clone(),
            imports: model.imports.clone(),
            creating: model.creating,
            lane: datamodels::model_lane(&item.home, model.creating, &model.checked.severity),
            title: format!("{verb} DataModel {}", item.name),
            body: format!(
                "Proposed {noun} of DataModel `{}` source, manifest and generated artifacts in \
                 project `{}` through a plan (AG-149).",
                item.name, item.home
            ),
        },
    )
    .await
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
                        "patch": { "type": "object", "description": "With patch: a JSON merge patch (RFC 7386) onto the current manifest" },
                        "source": { "type": "string", "maxLength": MAX_REQUEST_BYTES, "description": "With a DataModel: its whole LinkML file (the one spec.linkml names), e.g. \"classes:\\n  BikeCounter:\\n    attributes:\\n      count: { range: integer }\\n\"; the plan shows each change, the version it takes and the stored entities a breaking one affects" }
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

fn revert_input_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "id": text("The merged Change to undo, e.g. chg-0000002a", TERM),
            "workspace": text("Commit the revert into this workspace (a copy of the project) instead of opening change requests", NAME)
        },
        "required": ["id"],
        "additionalProperties": false
    })
}

fn revert_output_schema() -> Value {
    let mut schema = plan_output_schema();
    schema["properties"]["reverts"] = json!({ "type": "string" });
    schema
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
            name: REVERT,
            title: "Plan Revert",
            description: "Plans the undo of a merged Change, every file back to before it, for jc_change_apply; 409 names files changed since",
            input: revert_input_schema,
            output: revert_output_schema,
            annotations: Annotations {
                read_only_hint: false,
                destructive_hint: false,
                idempotent_hint: false,
            },
            kind: "*",
            verb: None,
            lane: Lane::Green,
            validate: |val| parse_input::<RevertInput>(val.clone()).map(|_| ()),
            run: |caller, state, project, val| {
                Box::pin(async move { revert(caller, state, project, parse_input(val)?).await })
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

    /// S-10: a breaking change counts the stored entities of the class it touches, also for a
    /// top-level slot a class lists.
    #[test]
    fn a_change_touches_its_class_or_every_class_listing_its_slot() {
        let published = json!({ "classes": {
            "BikeCounter": { "slots": ["owner"] },
            "Station": { "slots": ["owner", "name"] },
            "Kiosk": {}
        } });
        assert_eq!(classes_of(&published, "BikeCounter.count"), ["BikeCounter"]);
        assert_eq!(classes_of(&published, "Kiosk"), ["Kiosk"]);
        assert_eq!(classes_of(&published, "owner"), ["BikeCounter", "Station"]);
        assert!(classes_of(&published, "Direction.in").is_empty());
        assert!(classes_of(&Value::Null, "BikeCounter.count").is_empty());
    }

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

    /// A LinkML source rides only with a DataModel, never with a delete or into a workspace, and a
    /// plan's sources together stay under one source's cap: each refused at its path before
    /// anything is read or kept.
    #[tokio::test]
    async fn a_source_is_refused_off_a_model_in_a_workspace_and_over_the_cap() {
        let state = AppState::new(crate::config::Config::for_tests(), None);
        let change = |op: Op, kind: &str, source: &str| ChangeInput {
            op,
            kind: kind.into(),
            name: "bike-counter".into(),
            manifest: None,
            patch: None,
            source: Some(source.into()),
        };
        let refused = |changes: Vec<ChangeInput>, workspace: Option<&str>| {
            let input = PlanInput {
                changes,
                workspace: workspace.map(str::to_owned),
            };
            let state = &state;
            async move {
                plan(&caller(None), state, "doprava", input)
                    .await
                    .expect_err("refused")
                    .to_string()
            }
        };
        let off_model = refused(vec![change(Op::Patch, "ContextSpace", "classes: {}")], None).await;
        assert!(off_model.contains("/changes/0/source"), "{off_model}");
        assert!(off_model.contains("only a DataModel"), "{off_model}");
        let delete = refused(vec![change(Op::Delete, "DataModel", "classes: {}")], None).await;
        assert!(delete.contains("op delete takes no source"), "{delete}");
        let workspace = refused(
            vec![change(Op::Patch, "DataModel", "classes: {}")],
            Some("w1"),
        )
        .await;
        assert!(workspace.contains("without workspace"), "{workspace}");
        let half = "x".repeat(MAX_REQUEST_BYTES / 2 + 1);
        let mut other = change(Op::Patch, "DataModel", &half);
        other.name = "station".into();
        let over = refused(vec![change(Op::Patch, "DataModel", &half), other], None).await;
        assert!(over.contains("one at a time"), "{over}");
        let kept = state.plans.plans.lock().map(|p| p.len()).unwrap_or(1);
        assert_eq!(kept, 0);
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
