//! Each WASM shard's placement and store key (AP-157, AP-158, ADR-N-044).
//!
//! A shard of `jc-wasm-host` serves the Apps its placement file names and reaches the Apps bucket
//! with a key of its own. On every converge the reconciler writes, in the host's namespace, the
//! ConfigMap `jc-wasm-host-<shard>-placements` (key `placements.json`) for every shard, empty or
//! not, and the Secret `apps-host-<shard>-store` with the shard's derived key.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use crate::apps::apps_db::app_id;
use crate::apps::kube::KubeClient;
use crate::artifact_store;

/// One published `wasm` App as the placement names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlacedApp {
    /// The App's project, the host's `tenant`.
    pub project: String,
    pub name: String,
    pub shard: u32,
    /// `sha256:<hex>`, the component the publish recorded in `status.build.component`.
    pub digest: String,
}

impl PlacedApp {
    /// A published `wasm` App with its shard and its component recorded, from its envelope; any
    /// other App, or one still missing either, is not placed.
    pub fn of(envelope: &crate::resource::ResourceEnvelope) -> Option<Self> {
        let spec = &envelope.spec;
        let wasm = spec.get("kind").and_then(Value::as_str) == Some("wasm");
        let published = spec.get("lifecycle").and_then(Value::as_str)
            == Some(jc_core::kinds::AppLifecycle::Published.as_str());
        if envelope.kind != "App" || !wasm || !published {
            return None;
        }
        let status = envelope.status.as_ref()?;
        Some(Self {
            project: envelope.metadata.namespace.clone()?,
            name: envelope.metadata.name.clone(),
            shard: status.shard?,
            digest: status.build.as_ref()?.component.clone()?,
        })
    }
}

/// The placement of `shard`: its Apps by name, each once. The host routes `/apps/{name}/api` by
/// name and refuses a file that names one twice, so of two projects' Apps of one name on one
/// shard the first by project is placed and the rest are returned, to be said rather than lose
/// the whole shard.
pub fn placement(shard: u32, apps: &[PlacedApp]) -> (Value, Vec<PlacedApp>) {
    let mut chosen: BTreeMap<&str, &PlacedApp> = BTreeMap::new();
    let mut clashing = Vec::new();
    let mut on_shard: Vec<&PlacedApp> = apps.iter().filter(|app| app.shard == shard).collect();
    on_shard.sort_by(|a, b| (&a.name, &a.project).cmp(&(&b.name, &b.project)));
    for app in on_shard {
        if chosen.contains_key(app.name.as_str()) {
            clashing.push(app.clone());
        } else {
            chosen.insert(&app.name, app);
        }
    }
    let placed: Vec<Value> = chosen
        .values()
        .map(|app| {
            json!({
                "name": app.name,
                "id": app_id(&app.project, &app.name),
                "tenant": app.project,
                "digest": app.digest,
            })
        })
        .collect();
    (
        json!({ "shard": shard.to_string(), "apps": placed }),
        clashing,
    )
}

/// The ConfigMap a shard's pods mount its placement from.
pub fn config_map(namespace: &str, shard: u32, placement: &Value) -> Value {
    json!({
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": {
            "name": format!("jc-wasm-host-{shard}-placements"),
            "namespace": namespace,
            "labels": {
                "app.kubernetes.io/managed-by": "joinedcontext-portal",
                "joinedcontext.com/wasm-shard": shard.to_string(),
            },
        },
        "data": { "placements.json": placement.to_string() },
    })
}

/// Writes every shard's placement and key.
pub struct WasmShards {
    kube: KubeClient,
    namespace: String,
    shards: u32,
    bucket: String,
}

impl WasmShards {
    pub fn new(kube: KubeClient, namespace: String, shards: u32, bucket: String) -> Self {
        Self {
            kube,
            namespace,
            shards,
            bucket,
        }
    }

    /// One converge: each shard's placement of `apps`, and, where `store` is configured, its
    /// key. Returns what went wrong, one sentence each; a shard that failed keeps what it had.
    pub async fn converge(
        &self,
        apps: &[PlacedApp],
        store: Option<&artifact_store::Client>,
    ) -> Vec<String> {
        let mut problems = Vec::new();
        for shard in 0..self.shards {
            let (placement, clashing) = placement(shard, apps);
            for app in clashing {
                problems.push(format!(
                    "shard {shard}: App {}/{} is not served, another project's App of the same name is",
                    app.project, app.name
                ));
            }
            if let Err(err) = self
                .kube
                .apply_placement(&config_map(&self.namespace, shard, &placement))
                .await
            {
                problems.push(format!(
                    "shard {shard}: its placement was not written: {err}"
                ));
            }
            let Some(store) = store else {
                continue;
            };
            match store.ensure_shard(&self.bucket, shard).await {
                Ok(key) => {
                    let secret = artifact_store::shard_secret(&self.namespace, shard, &key);
                    if let Err(err) = self.kube.apply(&secret).await {
                        problems.push(format!(
                            "shard {shard}: its store key was not handed over: {err}"
                        ));
                    }
                }
                Err(err) => {
                    problems.push(format!("shard {shard}: the store refused its key: {err}"))
                }
            }
        }
        problems
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(project: &str, name: &str, shard: u32) -> PlacedApp {
        PlacedApp {
            project: project.to_owned(),
            name: name.to_owned(),
            shard,
            digest: format!("sha256:{}", "a".repeat(64)),
        }
    }

    #[test]
    fn a_shard_names_its_own_apps_only_by_name_and_id() {
        let apps = [
            app("helsinki", "notes", 0),
            app("praha", "odpad", 1),
            app("helsinki", "air", 0),
        ];
        let (zero, clashing) = placement(0, &apps);
        assert!(clashing.is_empty());
        assert_eq!(zero["shard"], "0");
        let names: Vec<&str> = zero["apps"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["air", "notes"]);
        assert_eq!(zero["apps"][1]["id"], app_id("helsinki", "notes"));
        assert_eq!(zero["apps"][1]["tenant"], "helsinki");
        let (two, _) = placement(2, &apps);
        assert_eq!(two["apps"], json!([]));
    }

    #[test]
    fn two_projects_apps_of_one_name_on_one_shard_place_the_first_and_say_the_other() {
        let (zero, clashing) =
            placement(0, &[app("praha", "notes", 0), app("helsinki", "notes", 0)]);
        assert_eq!(zero["apps"].as_array().unwrap().len(), 1);
        assert_eq!(zero["apps"][0]["tenant"], "helsinki");
        assert_eq!(clashing, [app("praha", "notes", 0)]);
    }

    #[test]
    fn the_config_map_carries_the_placement_under_its_key() {
        let (placed, _) = placement(1, &[app("helsinki", "notes", 1)]);
        let map = config_map("apps-host", 1, &placed);
        assert_eq!(map["metadata"]["name"], "jc-wasm-host-1-placements");
        assert_eq!(map["metadata"]["namespace"], "apps-host");
        let text = map["data"]["placements.json"].as_str().unwrap();
        assert_eq!(serde_json::from_str::<Value>(text).unwrap(), placed);
    }
}
