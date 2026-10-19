//! The open-data catalogue as an NGSI-LD Endpoint (T-4500, ADR-N-025, EP-78).
//!
//! An agent's first call goes to the Endpoint named `catalog` on the space named `catalog`, where
//! it finds the dataset it needs with the ordinary NGSI-LD queries; its second call goes to that
//! dataset's own Endpoint. This wave writes that catalogue (EP-140, T-4746): one SDM DCAT-AP
//! `Dataset` per public CKAN dataset, named as CKAN names it, one `Organization` per CKAN
//! organization that publishes one, one `DataService` per public Endpoint, and a `Dataset` of its
//! own for a public Endpoint no CKAN dataset names.
//!
//! Three rules, each from what goes wrong without it:
//!
//! - **Read, never listed.** The Endpoints come from the gateway's DCAT-AP feed (EP-84), which
//!   holds the record of every public Endpoint as the anonymous caller reads it, and the datasets
//!   from CKAN's own `package_search`, read anonymously, so only public ones: a dataset added,
//!   renamed or withdrawn in CKAN is here at the next run, and no private title, contact or count
//!   can reach the catalogue. A CKAN that does not answer fails the run, which then writes
//!   nothing, rather than turn every CKAN dataset back into its Endpoint's.
//! - **Every write goes through an Endpoint and its Policy**, as the Portal's own client, the way
//!   the drift wave puts a seed entity back. The `catalog` Endpoint's Policy is what admits it.
//! - **Only a change is written.** A run compares with what the last run wrote and sends only the
//!   difference; after a restart, and once an hour, it lists what the catalogue holds instead of
//!   trusting its memory, so an entity a half-finished run left behind is still removed.

use super::drift::Watch;
use crate::resource::reference_name;
use futures_util::StreamExt as _;
pub use jc_core::ngsi_catalog::{entities, fold, link, Ckan, Package, Place};
use jcctl::loader::Repository;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// The name of the catalogue's Endpoint and of its space.
pub const CATALOG: &str = "catalog";
/// Entities per batch request.
const BATCH: usize = 100;
/// Datasets per page of CKAN's `package_search`, its own ceiling, and the pages read at most.
const CKAN_PAGE: usize = 1000;
const CKAN_PAGES: usize = 20;
/// How long the memory of the last write is trusted before the catalogue is listed again.
const RELIST: Duration = Duration::from_secs(3600);

/// An Endpoint's entity types, each with how many entities it holds, most first.
type Counts = Vec<(String, u64)>;

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
    /// Per public Endpoint slug, its entity types and their counts as an anonymous caller reads
    /// them, and when they were read (T-4526).
    counts: Mutex<HashMap<String, (Instant, Counts)>>,
}

impl CatalogSync {
    /// A wave writing through the Portal's own client on the gateway `watch` speaks to.
    pub fn new(watch: Arc<Watch>) -> Self {
        Self {
            watch,
            written: Mutex::new(None),
            counts: Mutex::new(HashMap::new()),
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
        let places = places(repo);
        let sites = ckan_sites(repo);
        let mut wanted = BTreeMap::new();
        if sites.is_empty() {
            wanted = entities(nodes, &places, None);
        }
        for site in &sites {
            let packages = packages(http, site).await?;
            wanted.extend(entities(
                nodes,
                &places,
                Some(Ckan {
                    site,
                    packages: &packages,
                }),
            ));
        }
        // Two catalogues name the same Endpoints: tied once more over both.
        link(&mut wanted);
        let counted = self.counted(http, base, &wanted).await;
        with_types(&mut wanted, &counted);

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

impl CatalogSync {
    /// Per DataService of `wanted`, its types and counts: from memory while younger than
    /// [`RELIST`], else read anonymously from the Endpoint itself, eight Endpoints at a time. A
    /// read that fails keeps what was read before, or leaves the Endpoint without types.
    async fn counted(
        &self,
        http: &reqwest::Client,
        base: &str,
        wanted: &BTreeMap<String, Value>,
    ) -> HashMap<String, Counts> {
        let slugs: Vec<String> = wanted
            .keys()
            .filter_map(|id| id.strip_prefix("urn:ngsi-ld:DataService:"))
            .map(str::to_owned)
            .collect();
        let mut held = match self.counts.lock() {
            Ok(mut counts) => std::mem::take(&mut *counts),
            Err(_) => HashMap::new(),
        };
        held.retain(|slug, _| slugs.contains(slug));
        let stale: Vec<String> = slugs
            .iter()
            .filter(|slug| {
                held.get(*slug)
                    .is_none_or(|(read, _)| read.elapsed() >= RELIST)
            })
            .cloned()
            .collect();
        let read: Vec<(String, Result<Counts, String>)> = futures_util::stream::iter(stale)
            .map(|slug| async move {
                let types = types_of(http, base, &slug).await;
                (slug, types)
            })
            .buffer_unordered(8)
            .collect()
            .await;
        for (slug, types) in read {
            match types {
                Ok(types) => {
                    held.insert(slug, (Instant::now(), types));
                }
                Err(why) => tracing::warn!(endpoint = %slug, %why, "catalogue counts not read"),
            }
        }
        let out = held
            .iter()
            .map(|(slug, (_, types))| (slug.clone(), types.clone()))
            .collect();
        if let Ok(mut counts) = self.counts.lock() {
            *counts = held;
        }
        out
    }
}

/// An Endpoint's entity types and their counts, read as the anonymous caller: its `/types`, then
/// per type `count=true&limit=0`.
async fn types_of(http: &reqwest::Client, base: &str, slug: &str) -> Result<Counts, String> {
    let surface = format!("{base}/api/endpoint/{slug}/ngsi-ld/v1");
    let list: Value = http
        .get(format!("{surface}/types"))
        .header("Accept", "application/json")
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|err| format!("/types did not read: {err}"))?
        .json()
        .await
        .map_err(|err| format!("/types is not JSON: {err}"))?;
    let names: Vec<String> = list
        .get("typeList")
        .and_then(Value::as_array)
        .map(|names| {
            names
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let mut out = Vec::with_capacity(names.len());
    for name in names {
        let answer = http
            .get(format!("{surface}/entities"))
            .query(&[("type", name.as_str()), ("count", "true"), ("limit", "0")])
            .header("Accept", "application/json")
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|err| format!("the count of {name} did not read: {err}"))?;
        let count = answer
            .headers()
            .get("NGSILD-Results-Count")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .ok_or_else(|| format!("the count of {name} came without NGSILD-Results-Count"))?;
        // A type outside the core @context comes back as its IRI; the catalogue names its term.
        let term = name.rsplit(['/', '#']).next().unwrap_or(&name).to_owned();
        out.push((term, count));
    }
    out.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    Ok(out)
}

/// Puts each DataService's `entityTypes` and `nextQuery` on it, and the type names in the
/// `searchText` of every Dataset it lists in `refDataset` (T-4526).
pub fn with_types(
    wanted: &mut BTreeMap<String, Value>,
    counted: &HashMap<String, Vec<(String, u64)>>,
) {
    let mut words: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (id, entity) in wanted.iter_mut() {
        let Some(slug) = id.strip_prefix("urn:ngsi-ld:DataService:") else {
            continue;
        };
        let Some(types) = counted.get(slug).filter(|types| !types.is_empty()) else {
            continue;
        };
        entity["entityTypes"] = json!({ "type": "Property", "value": types
            .iter()
            .map(|(name, count)| json!({ "type": name, "count": count }))
            .collect::<Vec<_>>() });
        entity["nextQuery"] = json!({ "type": "Property", "value": {
            "tool": "query_entities",
            "arguments": { "endpoint": slug, "type": types[0].0, "limit": 10 },
        }});
        let datasets = entity["refDataset"]["objectList"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|item| item["object"].as_str());
        for dataset in datasets {
            words
                .entry(dataset.to_owned())
                .or_default()
                .extend(types.iter().map(|(name, _)| name.clone()));
        }
    }
    for (dataset, names) in words {
        if let Some(entity) = wanted.get_mut(&dataset) {
            let text = entity["searchText"]["value"]
                .as_str()
                .unwrap_or("")
                .to_owned();
            entity["searchText"]["value"] = json!(format!("{text} {}", fold(&names.join(" "))));
        }
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

/// The address of every CKAN instance of the repository, once each.
pub fn ckan_sites(repo: &Repository) -> std::collections::BTreeSet<String> {
    repo.iter()
        .filter(|(id, _)| id.kind == "CkanInstance")
        .filter_map(|(_, resource)| resource.manifest.spec.get("url")?.as_str())
        .map(|url| url.trim_end_matches('/').to_owned())
        .collect()
}

/// Every public dataset of the CKAN at `site`, read anonymously a page at a time.
async fn packages(http: &reqwest::Client, site: &str) -> Result<Vec<Package>, String> {
    let mut out = Vec::new();
    let mut start = 0usize;
    for _ in 0..CKAN_PAGES {
        let page: Value = http
            .get(format!("{site}/api/3/action/package_search"))
            .query(&[
                ("rows", CKAN_PAGE.to_string()),
                ("start", start.to_string()),
                ("sort", "name asc".to_owned()),
            ])
            .header("Accept", "application/json")
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|err| format!("CKAN at {site} did not list its datasets: {err}"))?
            .json()
            .await
            .map_err(|err| format!("CKAN at {site} did not answer JSON: {err}"))?;
        let (results, count) = ckan_page(&page)
            .ok_or_else(|| format!("CKAN at {site} answered no package_search result"))?;
        start += results.len();
        out.extend(results.iter().filter_map(Package::from_ckan));
        if results.is_empty() || start as u64 >= count {
            return Ok(out);
        }
    }
    Err(format!(
        "CKAN at {site} holds more than {} datasets; the catalogue reads no further",
        CKAN_PAGE * CKAN_PAGES
    ))
}

/// The datasets of one `package_search` answer and the count of all of them.
fn ckan_page(page: &Value) -> Option<(&Vec<Value>, u64)> {
    if page.get("success").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let result = page.get("result")?;
    Some((
        result.get("results")?.as_array()?,
        result.get("count")?.as_u64()?,
    ))
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
                ("type", "Dataset,DataService,Organization"),
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
