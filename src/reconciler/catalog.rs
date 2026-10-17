//! The open-data catalogue as an NGSI-LD Endpoint (T-4500, ADR-N-025, EP-78).
//!
//! An agent's first call goes to the Endpoint named `catalog` on the space named `catalog`, where
//! it finds the dataset it needs with the ordinary NGSI-LD queries; its second call goes to that
//! dataset's own Endpoint. This wave writes that catalogue: one SDM DCAT-AP `Dataset` per context
//! space with a public Endpoint, one `DataService` per public Endpoint.
//!
//! Three rules, each from what goes wrong without it:
//!
//! - **One source.** Every attribute is read from the gateway's DCAT-AP feed (EP-84), which holds
//!   the record of every public Endpoint as the anonymous caller reads it, built by the same
//!   function as each Endpoint's own record. CKAN, a harvester and this catalogue cannot drift,
//!   and no private title, contact or count can reach it: the feed never held one.
//! - **Every write goes through an Endpoint and its Policy**, as the Portal's own client, the way
//!   the drift wave puts a seed entity back. The `catalog` Endpoint's Policy is what admits it.
//! - **Only a change is written.** A run compares with what the last run wrote and sends only the
//!   difference; after a restart, and once an hour, it lists what the catalogue holds instead of
//!   trusting its memory, so an entity a half-finished run left behind is still removed.

use super::drift::Watch;
use crate::resource::reference_name;
pub use jc_core::ngsi_catalog::{entities, fold, Place};
use jcctl::loader::Repository;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// The name of the catalogue's Endpoint and of its space.
pub const CATALOG: &str = "catalog";
/// Entities per batch request.
const BATCH: usize = 100;
/// How long the memory of the last write is trusted before the catalogue is listed again.
const RELIST: Duration = Duration::from_secs(3600);

/// What one run wrote.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Run {
    /// Entities created or replaced.
    pub upserted: usize,
    /// Entities removed.
    pub deleted: usize,
}

/// The catalogue wave of one Portal.
pub struct CatalogSync {
    watch: Arc<Watch>,
    /// What the last run left in the catalogue, by id, and when it was last listed.
    written: Mutex<Option<(Instant, BTreeMap<String, Value>)>>,
}

impl CatalogSync {
    /// A wave writing through the Portal's own client on the gateway `watch` speaks to.
    pub fn new(watch: Arc<Watch>) -> Self {
        Self {
            watch,
            written: Mutex::new(None),
        }
    }

    /// Brings the catalogue to the public Endpoints of `repo`. `Ok(None)` when the repository
    /// declares no catalogue Endpoint, which leaves this wave off.
    pub async fn converge(&self, repo: &Repository) -> Result<Option<Run>, String> {
        let Some(slug) = catalog_slug(repo)? else {
            return Ok(None);
        };
        let (http, base) = self.watch.surface();
        let feed: Value = http
            .get(format!("{base}/catalog.jsonld"))
            .header("Accept", "application/ld+json")
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|err| format!("the DCAT-AP feed did not read: {err}"))?
            .json()
            .await
            .map_err(|err| format!("the DCAT-AP feed is not JSON: {err}"))?;
        let nodes = feed
            .get("@included")
            .and_then(Value::as_array)
            .map_or(&[][..], Vec::as_slice);
        let wanted = entities(nodes, &places(repo));

        let token = self.watch.scan_token().await?;
        let surface = format!("{base}/api/endpoint/{slug}/ngsi-ld/v1");
        let remembered = self
            .written
            .lock()
            .map_err(|_| "the catalogue's memory is poisoned".to_owned())?
            .take()
            .filter(|(listed, _)| listed.elapsed() < RELIST);
        let (listed, known) = match remembered {
            Some(memory) => memory,
            None => (Instant::now(), listing(http, &surface, &token).await?),
        };

        let changed: Vec<&Value> = wanted
            .iter()
            .filter(|(id, entity)| known.get(*id) != Some(entity))
            .map(|(_, entity)| entity)
            .collect();
        let gone: Vec<&String> = known
            .keys()
            .filter(|id| !wanted.contains_key(*id))
            .collect();
        for batch in changed.chunks(BATCH) {
            post(http, &surface, "upsert", &token, &json!(batch)).await?;
        }
        for batch in gone.chunks(BATCH) {
            post(http, &surface, "delete", &token, &json!(batch)).await?;
        }
        let run = Run {
            upserted: changed.len(),
            deleted: gone.len(),
        };
        // Remembered only once every write landed: a failed run lists the catalogue again.
        if let Ok(mut written) = self.written.lock() {
            *written = Some((listed, wanted));
        }
        Ok(Some(run))
    }
}

/// The slug of the repository's catalogue Endpoint: the Endpoint named `catalog` on the space
/// named `catalog`. More than one is a repository that does not say where to write.
pub fn catalog_slug(repo: &Repository) -> Result<Option<String>, String> {
    let slugs: Vec<String> = repo
        .iter()
        .filter(|(id, _)| id.kind == "Endpoint" && id.name == CATALOG)
        .filter(|(_, resource)| {
            resource
                .manifest
                .spec
                .get("contextSpaceRef")
                .and_then(reference_name)
                == Some(CATALOG)
        })
        .filter_map(|(_, resource)| {
            resource
                .manifest
                .spec
                .get("slug")?
                .as_str()
                .map(str::to_owned)
        })
        .collect();
    match slugs.as_slice() {
        [] => Ok(None),
        [one] => Ok(Some(one.clone())),
        _ => Err(format!(
            "{} Endpoints are named `{CATALOG}` on a space `{CATALOG}`; the catalogue is written to none",
            slugs.len()
        )),
    }
}

/// Every public Endpoint's place by slug. The catalogue's own Endpoint is not a dataset.
pub fn places(repo: &Repository) -> BTreeMap<String, Place> {
    let mut areas: BTreeMap<(String, String), [f64; 4]> = BTreeMap::new();
    for (id, resource) in repo.iter() {
        if id.kind != "ContextSpace" {
            continue;
        }
        let rules = resource
            .manifest
            .spec
            .get("quality")
            .and_then(Value::as_array);
        let bbox = rules.into_iter().flatten().find_map(|rule| {
            if rule.get("kind").and_then(Value::as_str) != Some("area") {
                return None;
            }
            let corners: Vec<f64> = rule
                .get("bbox")?
                .as_array()?
                .iter()
                .filter_map(Value::as_f64)
                .collect();
            <[f64; 4]>::try_from(corners).ok()
        });
        if let Some(bbox) = bbox {
            let project = id.namespace.clone().unwrap_or_default();
            areas.insert((project, id.name.clone()), bbox);
        }
    }
    let mut places = BTreeMap::new();
    for (id, resource) in repo.iter() {
        let spec = &resource.manifest.spec;
        if id.kind != "Endpoint" || spec.get("audience").and_then(Value::as_str) != Some("public") {
            continue;
        }
        let (Some(slug), Some(space)) = (
            spec.get("slug").and_then(Value::as_str),
            spec.get("contextSpaceRef").and_then(reference_name),
        ) else {
            continue;
        };
        if id.name == CATALOG && space == CATALOG {
            continue;
        }
        let project = id.namespace.clone().unwrap_or_default();
        let bbox = areas.get(&(project.clone(), space.to_owned())).copied();
        // The `{space}` segment, which is what the gateway knows a space by: the hub's
        // catalogue names the same Dataset (T-4503).
        let segment = repo.space_segment(&project, space);
        places.insert(slug.to_owned(), Place::public(segment, bbox));
    }
    places
}

/// What the catalogue holds now, by id; the values are unknown, so every entity is written once.
async fn listing(
    http: &reqwest::Client,
    surface: &str,
    token: &str,
) -> Result<BTreeMap<String, Value>, String> {
    let mut held = BTreeMap::new();
    let mut offset = 0usize;
    loop {
        let page: Vec<Value> = http
            .get(format!("{surface}/entities"))
            .query(&[
                ("type", "Dataset,DataService"),
                ("options", "keyValues"),
                ("limit", "1000"),
                ("offset", &offset.to_string()),
            ])
            .bearer_auth(token)
            .header("Accept", "application/json")
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|err| format!("the catalogue did not list: {err}"))?
            .json()
            .await
            .map_err(|err| format!("the catalogue's listing is not JSON: {err}"))?;
        if page.is_empty() {
            return Ok(held);
        }
        offset += page.len();
        for entity in page {
            if let Some(id) = entity.get("id").and_then(Value::as_str) {
                held.insert(id.to_owned(), Value::Null);
            }
        }
    }
}

/// One batch operation; a multi-status answer is a failure, with the count of what failed.
async fn post(
    http: &reqwest::Client,
    surface: &str,
    operation: &str,
    token: &str,
    body: &Value,
) -> Result<(), String> {
    let response = http
        .post(format!("{surface}/entityOperations/{operation}"))
        .bearer_auth(token)
        .json(body)
        .send()
        .await
        .map_err(|err| format!("the catalogue {operation} did not reach the gateway: {err}"))?;
    let status = response.status();
    if status == reqwest::StatusCode::MULTI_STATUS {
        let answer: Value = response.json().await.unwrap_or_default();
        let failed = answer
            .get("errors")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        return Err(format!(
            "the catalogue {operation} failed for {failed} entities"
        ));
    }
    if !status.is_success() {
        return Err(format!("the catalogue refused the {operation}: {status}"));
    }
    Ok(())
}
