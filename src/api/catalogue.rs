//! `GET /api/v1/catalogue`: every public dataset of the installation, searched and faceted
//! (EP-81, EP-82, Architecture/21 §6).
//!
//! The page reads CKAN, never the manifests, so what it lists is what `data.{host}` holds. It
//! reads as an anonymous caller: no API token is ever sent, CKAN answers such a caller with
//! public datasets only, and a dataset still marked `private` is dropped here as well, so a
//! restricted dataset can only be absent (EP-67, EP-69). The routes need no session for the
//! same reason: they carry nothing the public catalogue does not already show.
//!
//! Facets are computed here and not by CKAN's Solr, because the extras the publisher writes
//! (`theme`, `spatial_uri`, `temporal_start`) are free text to Solr and cannot be faceted there.

use std::collections::{BTreeMap, HashMap};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{Path, RawQuery, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::Datelike;
use jc_core::kinds::ckan::CkanInstanceSpec;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;
use utoipa::ToSchema;

use crate::error::ApiError;
use crate::state::AppState;
use crate::store::ListOptions;

/// How long a browser, and this Portal, may keep a catalogue answer.
pub const MAX_AGE_SECONDS: u64 = 60;
/// Datasets on one page of the list.
pub const PAGE_SIZE: usize = 20;
/// The most datasets read from one catalogue per search.
// ponytail: one search of 1000 rows per catalogue, faceted in memory; page through CKAN when a
// catalogue outgrows it.
const ROWS: usize = 1000;
/// The most rows a sample shows (EP-82).
const SAMPLE_ROWS: usize = 10;

static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .user_agent("joinedcontext-portal catalogue")
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap_or_default()
});

/// A catalogue's base URL and the search text.
type SearchKey = (String, String);
/// When a search was answered, and its datasets.
type SearchAnswer = (Instant, Vec<Value>);

/// One search answer per catalogue and query text, kept for [`MAX_AGE_SECONDS`], so a burst of
/// anonymous visitors costs CKAN one search a minute.
// ponytail: one replica's memory; share it only when the Portal runs more than one pod.
static SEARCHES: LazyLock<Mutex<HashMap<SearchKey, SearchAnswer>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// One page of the catalogue.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CataloguePage {
    /// Datasets matching the search and every filter.
    pub total: usize,
    /// The page shown, from 1.
    pub page: usize,
    /// Datasets per page.
    pub page_size: usize,
    /// The datasets of this page.
    pub datasets: Vec<CatalogueDataset>,
    /// Counts per facet value, each over the datasets every other filter keeps.
    pub facets: CatalogueFacets,
    /// Catalogues that did not answer; the others still did.
    pub unavailable: Vec<String>,
}

/// A dataset as the list shows it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CatalogueDataset {
    pub name: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publisher: Option<CataloguePublisher>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub licence: Option<CatalogueLicence>,
    pub formats: Vec<String>,
    /// EU data-theme codes (`ECON`, `ENVI`, …); the UI names them in the reader's language.
    pub themes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified: Option<String>,
}

/// The CKAN organization a dataset belongs to: one per project (Architecture/21 §1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct CataloguePublisher {
    pub name: String,
    pub title: String,
}

/// A licence as the catalogue's register names it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct CatalogueLicence {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// Every facet of the list.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct CatalogueFacets {
    pub publisher: Vec<CatalogueFacetValue>,
    pub theme: Vec<CatalogueFacetValue>,
    pub format: Vec<CatalogueFacetValue>,
    pub licence: Vec<CatalogueFacetValue>,
    pub spatial: Vec<CatalogueFacetValue>,
    pub year: Vec<CatalogueFacetValue>,
}

/// One value of a facet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct CatalogueFacetValue {
    pub value: String,
    pub label: String,
    pub count: usize,
}

/// One dataset, as its page shows it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CatalogueDatasetDetail {
    pub name: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    pub keywords: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publisher: Option<CataloguePublisher>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub licence: Option<CatalogueLicence>,
    /// The EU frequency the record names (`dct:accrualPeriodicity`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frequency: Option<String>,
    pub themes: Vec<CatalogueTheme>,
    pub spatial: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temporal: Option<CatalogueTemporal>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contact: Option<CatalogueContact>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified: Option<String>,
    /// The dataset on the catalogue's own site.
    pub catalogue_url: String,
    pub resources: Vec<CatalogueResource>,
    /// The Endpoint of this installation the dataset describes, when it names one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<CatalogueEndpoint>,
    /// The model the Endpoint's space holds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<CatalogueDataModel>,
}

/// An EU data theme: its code and its English name (the UI names it in the reader's language).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct CatalogueTheme {
    pub code: String,
    pub label: String,
}

/// The EU data-theme vocabulary (`http://publications.europa.eu/resource/authority/data-theme`).
const THEMES: [(&str, &str); 14] = [
    ("AGRI", "Agriculture, fisheries, forestry and food"),
    ("ECON", "Economy and finance"),
    ("EDUC", "Education, culture and sport"),
    ("ENER", "Energy"),
    ("ENVI", "Environment"),
    ("GOVE", "Government and public sector"),
    ("HEAL", "Health"),
    ("INTR", "International issues"),
    ("JUST", "Justice, legal system and public safety"),
    ("OP_DATPRO", "Provisional data"),
    ("REGI", "Regions and cities"),
    ("SOCI", "Population and society"),
    ("TECH", "Science and technology"),
    ("TRAN", "Transport"),
];

/// The English name of a theme code; a code outside the vocabulary names itself.
fn theme_label(code: &str) -> String {
    THEMES
        .iter()
        .find(|(c, _)| *c == code)
        .map_or_else(|| code.to_owned(), |(_, label)| (*label).to_owned())
}

/// The period a dataset covers; either end may be open.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct CatalogueTemporal {
    pub start: Option<String>,
    pub end: Option<String>,
}

/// Where questions about the dataset go: a role address (EP-80).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct CatalogueContact {
    pub name: Option<String>,
    pub email: Option<String>,
}

/// One resource of a dataset (EP-64).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CatalogueResource {
    pub name: String,
    pub format: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The DataStore preview, on a resource with an active sheet (EP-65).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_url: Option<String>,
}

/// The Endpoint a dataset describes, on this installation's own host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CatalogueEndpoint {
    pub url: String,
    /// The representations it serves, which decide the "Use this data" snippets.
    pub representations: Vec<String>,
}

/// The data model behind a dataset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CatalogueDataModel {
    pub name: String,
    pub classes: Vec<CatalogueClass>,
    /// The model's documentation, the dataset's Markdown schema resource.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub docs_url: Option<String>,
}

/// One class of the model, described as its LinkML describes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct CatalogueClass {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// The model's classes with their LinkML `description`: a plain string, or the English (else
/// the first) entry of a map per language. A source that does not parse describes nothing.
pub fn classes(names: &[String], linkml: Option<&str>) -> Vec<CatalogueClass> {
    let model = linkml.and_then(|l| serde_yaml_ng::from_str::<serde_yaml_ng::Value>(l).ok());
    names
        .iter()
        .map(|name| {
            let description = model.as_ref().and_then(|m| {
                let d = &m["classes"][name.as_str()]["description"];
                d.as_str()
                    .or_else(|| d["en"].as_str())
                    .or_else(|| d.as_mapping()?.values().find_map(|v| v.as_str()))
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
            });
            CatalogueClass {
                name: name.clone(),
                description,
            }
        })
        .collect()
}

/// Up to ten entities of a dataset, read through its Endpoint (EP-82).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct CatalogueSample {
    #[serde(rename = "type")]
    pub entity_type: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

/// The filters of one search.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Filters {
    pub q: String,
    pub publisher: Vec<String>,
    pub theme: Vec<String>,
    pub format: Vec<String>,
    pub licence: Vec<String>,
    pub spatial: Vec<String>,
    pub year: Vec<String>,
    pub page: usize,
}

impl Filters {
    /// Reads `?q=…&publisher=a&publisher=b&page=2`; an unknown key is ignored, a page that is
    /// not a positive number is the first.
    pub fn parse(query: Option<&str>) -> Self {
        let mut filters = Filters {
            page: 1,
            ..Filters::default()
        };
        for (key, value) in url::form_urlencoded::parse(query.unwrap_or_default().as_bytes()) {
            let value = value.trim().to_owned();
            if value.is_empty() {
                continue;
            }
            match key.as_ref() {
                "q" => filters.q = value.chars().take(200).collect(),
                "publisher" => filters.publisher.push(value),
                "theme" => filters.theme.push(value),
                "format" => filters.format.push(value),
                "licence" => filters.licence.push(value),
                "spatial" => filters.spatial.push(value),
                "year" => filters.year.push(value),
                "page" => filters.page = value.parse().ok().filter(|p| *p > 0).unwrap_or(1),
                _ => {}
            }
        }
        filters
    }
}

/// What one dataset is filed under, per facet.
struct Filed {
    summary: CatalogueDataset,
    publisher: Vec<(String, String)>,
    theme: Vec<(String, String)>,
    format: Vec<(String, String)>,
    licence: Vec<(String, String)>,
    spatial: Vec<(String, String)>,
    year: Vec<(String, String)>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Facet {
    Publisher,
    Theme,
    Format,
    Licence,
    Spatial,
    Year,
}

const FACETS: [Facet; 6] = [
    Facet::Publisher,
    Facet::Theme,
    Facet::Format,
    Facet::Licence,
    Facet::Spatial,
    Facet::Year,
];

impl Filed {
    fn of(dataset: &Value, this_year: i32) -> Self {
        let summary = summary(dataset);
        let pairs = |values: &[String]| {
            values
                .iter()
                .map(|v| (v.clone(), v.clone()))
                .collect::<Vec<_>>()
        };
        Filed {
            publisher: summary
                .publisher
                .iter()
                .map(|p| (p.name.clone(), p.title.clone()))
                .collect(),
            theme: summary
                .themes
                .iter()
                .map(|code| (code.clone(), theme_label(code)))
                .collect(),
            format: pairs(&summary.formats),
            licence: summary
                .licence
                .iter()
                .map(|l| (l.id.clone(), l.title.clone()))
                .collect(),
            spatial: spatial(dataset)
                .into_iter()
                .map(|s| (s.clone(), spatial_label(&s)))
                .collect(),
            year: years(dataset, this_year)
                .into_iter()
                .map(|y| (y.to_string(), y.to_string()))
                .collect(),
            summary,
        }
    }

    fn values(&self, facet: Facet) -> &[(String, String)] {
        match facet {
            Facet::Publisher => &self.publisher,
            Facet::Theme => &self.theme,
            Facet::Format => &self.format,
            Facet::Licence => &self.licence,
            Facet::Spatial => &self.spatial,
            Facet::Year => &self.year,
        }
    }

    /// Kept by the filter of `facet`: no filter, or one of its values.
    fn kept_by(&self, facet: Facet, filters: &Filters) -> bool {
        let wanted = match facet {
            Facet::Publisher => &filters.publisher,
            Facet::Theme => &filters.theme,
            Facet::Format => &filters.format,
            Facet::Licence => &filters.licence,
            Facet::Spatial => &filters.spatial,
            Facet::Year => &filters.year,
        };
        wanted.is_empty()
            || self
                .values(facet)
                .iter()
                .any(|(value, _)| wanted.contains(value))
    }
}

/// Filters, facets and pages the datasets a search returned (EP-81). Pure, so every rule is
/// tested without a catalogue.
pub fn page_of(datasets: &[Value], filters: &Filters, this_year: i32) -> CataloguePage {
    let filed: Vec<Filed> = datasets
        .iter()
        .filter(|d| d.get("private").and_then(Value::as_bool) != Some(true))
        .map(|d| Filed::of(d, this_year))
        .collect();

    let mut facets = CatalogueFacets::default();
    for facet in FACETS {
        let mut counts: BTreeMap<String, (String, usize)> = BTreeMap::new();
        for dataset in filed.iter().filter(|d| {
            FACETS
                .iter()
                .all(|other| *other == facet || d.kept_by(*other, filters))
        }) {
            for (value, label) in dataset.values(facet) {
                counts.entry(value.clone()).or_insert((label.clone(), 0)).1 += 1;
            }
        }
        let mut values: Vec<CatalogueFacetValue> = counts
            .into_iter()
            .map(|(value, (label, count))| CatalogueFacetValue {
                value,
                label,
                count,
            })
            .collect();
        values.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.label.cmp(&b.label)));
        *match facet {
            Facet::Publisher => &mut facets.publisher,
            Facet::Theme => &mut facets.theme,
            Facet::Format => &mut facets.format,
            Facet::Licence => &mut facets.licence,
            Facet::Spatial => &mut facets.spatial,
            Facet::Year => &mut facets.year,
        } = values;
    }

    let kept: Vec<CatalogueDataset> = filed
        .into_iter()
        .filter(|d| FACETS.iter().all(|facet| d.kept_by(*facet, filters)))
        .map(|d| d.summary)
        .collect();
    let total = kept.len();
    let datasets = kept
        .into_iter()
        .skip((filters.page - 1).saturating_mul(PAGE_SIZE))
        .take(PAGE_SIZE)
        .collect();
    CataloguePage {
        total,
        page: filters.page,
        page_size: PAGE_SIZE,
        datasets,
        facets,
        unavailable: Vec::new(),
    }
}

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// The value of one CKAN extra.
fn extra(dataset: &Value, key: &str) -> Option<String> {
    dataset
        .get("extras")?
        .as_array()?
        .iter()
        .find(|e| e.get("key").and_then(Value::as_str) == Some(key))
        .and_then(|e| text(e, "value"))
}

/// An extra that holds one value or a JSON array of them.
fn extra_list(dataset: &Value, key: &str) -> Vec<String> {
    let Some(raw) = extra(dataset, key) else {
        return Vec::new();
    };
    match serde_json::from_str::<Value>(&raw) {
        Ok(Value::Array(items)) => items
            .iter()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect(),
        _ => vec![raw],
    }
}

fn last_segment(iri: &str) -> String {
    iri.trim_end_matches('/')
        .rsplit(['/', '#'])
        .next()
        .unwrap_or(iri)
        .to_owned()
}

fn summary(dataset: &Value) -> CatalogueDataset {
    let name = text(dataset, "name").unwrap_or_default();
    let mut formats: Vec<String> = dataset
        .get("resources")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|r| text(r, "format"))
        .collect();
    formats.sort();
    formats.dedup();
    CatalogueDataset {
        title: text(dataset, "title").unwrap_or_else(|| name.clone()),
        name,
        notes: text(dataset, "notes"),
        publisher: publisher(dataset),
        licence: licence(dataset),
        formats,
        themes: extra_list(dataset, "theme")
            .iter()
            .map(|iri| last_segment(iri))
            .collect(),
        modified: text(dataset, "metadata_modified"),
    }
}

fn publisher(dataset: &Value) -> Option<CataloguePublisher> {
    let organization = dataset.get("organization")?;
    let name = text(organization, "name")?;
    Some(CataloguePublisher {
        title: text(organization, "title").unwrap_or_else(|| name.clone()),
        name,
    })
}

fn licence(dataset: &Value) -> Option<CatalogueLicence> {
    let id = text(dataset, "license_id")?;
    Some(CatalogueLicence {
        title: text(dataset, "license_title").unwrap_or_else(|| id.clone()),
        url: text(dataset, "license_url"),
        id,
    })
}

fn spatial(dataset: &Value) -> Vec<String> {
    let uris = extra_list(dataset, "spatial_uri");
    if uris.is_empty() {
        // `spatial` alone is GeoJSON to the spatial extension; only a plain code is a facet.
        extra_list(dataset, "spatial")
            .into_iter()
            .filter(|s| !s.starts_with('{'))
            .collect()
    } else {
        uris
    }
}

fn spatial_label(value: &str) -> String {
    last_segment(value)
}

/// The calendar years a dataset covers; an open end runs to `this_year`.
fn years(dataset: &Value, this_year: i32) -> Vec<i32> {
    let year = |key| {
        extra(dataset, key)
            .and_then(|date| date.get(..4).and_then(|y| y.parse::<i32>().ok()))
            .filter(|y| (1000..=9999).contains(y))
    };
    match (year("temporal_start"), year("temporal_end")) {
        (Some(start), end) => {
            let end = end.unwrap_or(this_year).max(start);
            // A century is the most a facet lists for one dataset.
            (start..=end.min(start + 99)).collect()
        }
        (None, Some(end)) => vec![end],
        (None, None) => Vec::new(),
    }
}

/// The distinct catalogues the installation's `CkanInstance`s name.
fn catalogues(state: &AppState) -> Vec<String> {
    let mut urls: Vec<String> = state
        .mirror
        .namespaces()
        .into_iter()
        .flat_map(|project| {
            state
                .mirror
                .list(&project, "CkanInstance", &ListOptions::default())
                .items
        })
        .filter_map(|env| {
            let spec: CkanInstanceSpec = serde_json::from_value(env.spec).ok()?;
            Some(spec.base_url().to_owned())
        })
        .filter(|url| Url::parse(url).is_ok_and(|u| matches!(u.scheme(), "http" | "https")))
        .collect();
    urls.sort();
    urls.dedup();
    urls
}

/// Why a CKAN action gave no result.
enum Failure {
    /// CKAN answered `success: false`: not found, not authorised, or a bad parameter.
    Refused,
    /// No CKAN document came back.
    Unreachable(String),
}

/// A CKAN action as an anonymous caller: no token is ever sent (EP-67).
async fn action(base: &str, action: &str, params: &[(&str, &str)]) -> Result<Value, Failure> {
    let url = format!("{base}/api/3/action/{action}");
    let response = HTTP
        .get(&url)
        .query(params)
        .send()
        .await
        .map_err(|e| Failure::Unreachable(format!("{base} did not answer: {e}")))?;
    let status = response.status();
    let body: Value = response.json().await.map_err(|e| {
        Failure::Unreachable(format!(
            "{base} answered {status} with no CKAN document: {e}"
        ))
    })?;
    if body.get("success").and_then(Value::as_bool) == Some(true) {
        Ok(body.get("result").cloned().unwrap_or(Value::Null))
    } else {
        Err(Failure::Refused)
    }
}

async fn search(base: &str, q: &str) -> Result<Vec<Value>, String> {
    let key = (base.to_owned(), q.to_owned());
    if let Some((at, datasets)) = SEARCHES.lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
        if at.elapsed() < Duration::from_secs(MAX_AGE_SECONDS) {
            return Ok(datasets.clone());
        }
    }
    let rows = ROWS.to_string();
    let result = action(
        base,
        "package_search",
        &[("q", q), ("rows", &rows), ("include_private", "false")],
    )
    .await;
    let result = match result {
        Ok(result) => result,
        // CKAN refuses a search text Solr cannot parse (`a:`): no dataset matches it.
        Err(Failure::Refused) => Value::Null,
        Err(Failure::Unreachable(reason)) => return Err(reason),
    };
    let datasets = result
        .get("results")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut cache = SEARCHES.lock().unwrap_or_else(|e| e.into_inner());
    if cache.len() > 256 {
        cache.retain(|_, (at, _)| at.elapsed() < Duration::from_secs(MAX_AGE_SECONDS));
    }
    cache.insert(key, (Instant::now(), datasets.clone()));
    Ok(datasets)
}

fn cached<T: Serialize>(body: T) -> Response {
    (
        [(
            header::CACHE_CONTROL,
            format!("public, max-age={MAX_AGE_SECONDS}"),
        )],
        Json(body),
    )
        .into_response()
}

#[utoipa::path(
    get,
    path = "/api/v1/catalogue",
    summary = "Search the Catalogue",
    description = "Every public dataset of the installation's open-data catalogues, searched and faceted (EP-81). Public: it lists only what an anonymous caller of the catalogue sees.",
    tag = "ckan",
    params(
        ("q" = Option<String>, Query, description = "Full-text search, passed to CKAN"),
        ("publisher" = Option<Vec<String>>, Query, description = "CKAN organization names"),
        ("theme" = Option<Vec<String>>, Query, description = "EU data-theme codes"),
        ("format" = Option<Vec<String>>, Query, description = "Resource formats"),
        ("licence" = Option<Vec<String>>, Query, description = "CKAN licence ids"),
        ("spatial" = Option<Vec<String>>, Query, description = "NUTS codes or location IRIs"),
        ("year" = Option<Vec<String>>, Query, description = "Calendar years covered"),
        ("page" = Option<usize>, Query, description = "Page, from 1"),
    ),
    responses(
        (status = 200, description = "One page of datasets and the facets", body = CataloguePage),
        (status = 503, description = "No catalogue answered", body = crate::error::ProblemDetails),
    )
)]
pub async fn get_catalogue(
    State(state): State<AppState>,
    RawQuery(query): RawQuery,
) -> Result<Response, ApiError> {
    let filters = Filters::parse(query.as_deref());
    let urls = catalogues(&state);
    let mut datasets = Vec::new();
    let mut unavailable = Vec::new();
    for url in &urls {
        match search(url, &filters.q).await {
            Ok(found) => datasets.extend(found),
            Err(reason) => {
                tracing::warn!(catalogue = %url, %reason, "catalogue search failed");
                unavailable.push(url.clone());
            }
        }
    }
    if !urls.is_empty() && unavailable.len() == urls.len() {
        return Err(ApiError::Unavailable(format!(
            "no open-data catalogue answered ({}); try again in a minute",
            unavailable.join(", ")
        )));
    }
    let mut page = page_of(&datasets, &filters, chrono::Utc::now().year());
    page.unavailable = unavailable;
    Ok(cached(page))
}

/// The public dataset `name` and the catalogue that holds it.
async fn dataset(state: &AppState, name: &str) -> Result<(String, Value), ApiError> {
    let not_found = || ApiError::NotFound(format!("dataset '{name}' is not in the catalogue"));
    if name.is_empty() || name.len() > 100 {
        return Err(not_found());
    }
    let urls = catalogues(state);
    let mut answered = false;
    for url in &urls {
        match action(url, "package_show", &[("id", name)]).await {
            Ok(found) => {
                answered = true;
                if found.get("private").and_then(Value::as_bool) != Some(true)
                    && text(&found, "name").as_deref() == Some(name)
                {
                    return Ok((url.clone(), found));
                }
            }
            // CKAN answers an unknown or private dataset with `success: false`: an answer.
            Err(Failure::Refused) => answered = true,
            Err(Failure::Unreachable(reason)) => {
                tracing::warn!(catalogue = %url, %reason, "catalogue dataset read failed");
            }
        }
    }
    if urls.is_empty() || answered {
        Err(not_found())
    } else {
        Err(ApiError::Unavailable(
            "no open-data catalogue answered; try again in a minute".to_owned(),
        ))
    }
}

/// The slug of an Endpoint of this installation, read from the dataset's `endpoint` extra. A
/// URL on any other host, or of any other shape, names none: the Portal never fetches an
/// address the catalogue supplies (EP-82).
pub fn endpoint_slug(extra: &str, public_base: &Url) -> Option<String> {
    let url = Url::parse(extra).ok()?;
    if url.host_str() != public_base.host_str()
        || url.port_or_known_default() != public_base.port_or_known_default()
    {
        return None;
    }
    let slug = url
        .path()
        .strip_prefix("/api/endpoint/")?
        .trim_end_matches('/');
    let valid = slug.len() >= 26
        && slug
            .bytes()
            .all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b));
    valid.then(|| slug.to_owned())
}

/// The public Endpoint with `slug`, and the project it belongs to.
fn public_endpoint(
    state: &AppState,
    slug: &str,
) -> Option<(String, crate::resource::ResourceEnvelope)> {
    state.mirror.namespaces().into_iter().find_map(|project| {
        let endpoint = state
            .mirror
            .list(&project, "Endpoint", &ListOptions::default())
            .items
            .into_iter()
            .find(|env| env.spec["slug"].as_str() == Some(slug))?;
        (endpoint.spec["audience"].as_str() == Some("public")).then_some((project, endpoint))
    })
}

/// The DataModel of the space the Endpoint serves, with its classes described from the LinkML
/// source; a source the forge cannot give leaves the classes undescribed.
async fn model_of(
    state: &AppState,
    project: &str,
    endpoint: &Value,
    docs_url: Option<String>,
) -> Option<CatalogueDataModel> {
    let space = crate::resource::reference_name(&endpoint["contextSpaceRef"])?;
    let space = state.mirror.get(project, "ContextSpace", space)?;
    let name = crate::resource::reference_name(&space.spec["dataModelRef"])?.to_owned();
    let model = state.mirror.get(project, "DataModel", &name)?;
    let names: Vec<String> = model.spec["classes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| c.as_str().map(str::to_owned))
        .collect();
    let linkml = crate::api::datamodels::read_source(state, project, &name)
        .await
        .ok();
    Some(CatalogueDataModel {
        classes: classes(&names, linkml.as_deref()),
        docs_url,
        name,
    })
}

fn endpoint_url(base: &Url, slug: &str) -> String {
    let origin = base.origin().ascii_serialization();
    format!("{origin}/api/endpoint/{slug}/")
}

fn representations(endpoint: &Value) -> Vec<String> {
    endpoint["enabledRepresentations"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| r.as_str().map(str::to_owned))
        .collect()
}

/// The dataset page's answer, from `package_show` and, when it names one, the Endpoint in the
/// mirror (EP-82).
pub async fn detail(state: &AppState, catalogue: &str, dataset: &Value) -> CatalogueDatasetDetail {
    let summary = summary(dataset);
    let name = summary.name.clone();
    let resources: Vec<CatalogueResource> = dataset
        .get("resources")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|r| {
            let url = text(r, "url")?;
            let id = text(r, "id");
            Some(CatalogueResource {
                name: text(r, "name").unwrap_or_else(|| url.clone()),
                format: text(r, "format").unwrap_or_default(),
                description: text(r, "description"),
                preview_url: (r.get("datastore_active").and_then(Value::as_bool) == Some(true))
                    .then_some(id)
                    .flatten()
                    .map(|id| format!("{catalogue}/dataset/{name}/resource/{id}")),
                url,
            })
        })
        .collect();

    let base = &state.config.public_base_url;
    let found = extra(dataset, "endpoint")
        .and_then(|e| endpoint_slug(&e, base))
        .and_then(|slug| public_endpoint(state, &slug).map(|found| (slug, found)));
    let (endpoint, model) = match found {
        Some((slug, (project, endpoint))) => {
            let url = endpoint_url(base, &slug);
            let docs_url = resources
                .iter()
                .map(|r| &r.url)
                .find(|u| u.starts_with(&url) && u.ends_with(".md"))
                .cloned();
            let model = model_of(state, &project, &endpoint.spec, docs_url).await;
            (
                Some(CatalogueEndpoint {
                    url,
                    representations: representations(&endpoint.spec),
                }),
                model,
            )
        }
        None => (None, None),
    };

    CatalogueDatasetDetail {
        keywords: dataset
            .get("tags")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|t| text(t, "display_name").or_else(|| text(t, "name")))
            .collect(),
        frequency: extra(dataset, "frequency"),
        spatial: spatial(dataset),
        temporal: match (
            extra(dataset, "temporal_start"),
            extra(dataset, "temporal_end"),
        ) {
            (None, None) => None,
            (start, end) => Some(CatalogueTemporal { start, end }),
        },
        contact: match (
            extra(dataset, "contact_name"),
            extra(dataset, "contact_email"),
        ) {
            (None, None) => None,
            (name, email) => Some(CatalogueContact { name, email }),
        },
        catalogue_url: format!("{catalogue}/dataset/{name}"),
        resources,
        endpoint,
        model,
        name,
        title: summary.title,
        notes: summary.notes,
        publisher: summary.publisher,
        licence: summary.licence,
        themes: summary
            .themes
            .into_iter()
            .map(|code| CatalogueTheme {
                label: theme_label(&code),
                code,
            })
            .collect(),
        modified: summary.modified,
    }
}

#[utoipa::path(
    get,
    path = "/api/v1/catalogue/datasets/{name}",
    summary = "Read a Catalogue Dataset",
    description = "One public dataset: its description, resources, and the Endpoint and model behind it when it is this installation's (EP-82).",
    tag = "ckan",
    params(("name" = String, Path, description = "The dataset's name in the catalogue")),
    responses(
        (status = 200, description = "The dataset", body = CatalogueDatasetDetail),
        (status = 404, description = "No public dataset has this name", body = crate::error::ProblemDetails),
    )
)]
pub async fn get_dataset(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<Response, ApiError> {
    let (catalogue, found) = dataset(&state, &name).await?;
    Ok(cached(detail(&state, &catalogue, &found).await))
}

/// A cell of the sample: text as it is, anything else as compact JSON.
fn cell(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

/// The table of up to ten keyValues entities: `id` and `type` first, then every other member
/// in the order it first appears.
pub fn table(entity_type: &str, entities: &[Value]) -> CatalogueSample {
    let mut columns = vec!["id".to_owned(), "type".to_owned()];
    let entities: Vec<&serde_json::Map<String, Value>> = entities
        .iter()
        .filter_map(Value::as_object)
        .take(SAMPLE_ROWS)
        .collect();
    for entity in &entities {
        for key in entity.keys() {
            if key != "@context" && !columns.contains(key) {
                columns.push(key.clone());
            }
        }
    }
    CatalogueSample {
        entity_type: entity_type.to_owned(),
        rows: entities
            .iter()
            .map(|entity| columns.iter().map(|c| cell(entity.get(c))).collect())
            .collect(),
        columns,
    }
}

#[utoipa::path(
    get,
    path = "/api/v1/catalogue/datasets/{name}/sample",
    summary = "Sample a Catalogue Dataset",
    description = "Up to ten entities of the dataset's first model class, read anonymously through its Endpoint (EP-82, EP-66).",
    tag = "ckan",
    params(("name" = String, Path, description = "The dataset's name in the catalogue")),
    responses(
        (status = 200, description = "The sample", body = CatalogueSample),
        (status = 404, description = "No public dataset of an Endpoint here that serves NGSI-LD", body = crate::error::ProblemDetails),
        (status = 503, description = "The Endpoint did not answer", body = crate::error::ProblemDetails),
    )
)]
pub async fn get_sample(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<Response, ApiError> {
    let (catalogue, found) = dataset(&state, &name).await?;
    let detail = detail(&state, &catalogue, &found).await;
    let no_sample = || {
        ApiError::NotFound(format!(
            "dataset '{name}' has no endpoint here that serves NGSI-LD"
        ))
    };
    let endpoint = detail.endpoint.ok_or_else(no_sample)?;
    if !endpoint.representations.iter().any(|r| r == "ngsi-ld") {
        return Err(no_sample());
    }
    let entity_type = detail
        .model
        .and_then(|m| m.classes.into_iter().next())
        .map(|c| c.name)
        .ok_or_else(no_sample)?;
    let slug = endpoint_slug(&endpoint.url, &state.config.public_base_url).ok_or_else(no_sample)?;
    // In the cluster the gateway answers directly; the public host is the same Endpoint.
    let base = state
        .config
        .gateway_url
        .as_deref()
        .and_then(|g| Url::parse(g).ok())
        .unwrap_or_else(|| state.config.public_base_url.clone());
    let url = format!("{}ngsi-ld/v1/entities", endpoint_url(&base, &slug));
    let limit = SAMPLE_ROWS.to_string();
    let unavailable = |reason: String| {
        tracing::warn!(dataset = %name, %reason, "catalogue sample failed");
        ApiError::Unavailable(format!(
            "the endpoint of dataset '{name}' did not answer; try again in a minute"
        ))
    };
    let response = HTTP
        .get(&url)
        .query(&[
            ("type", entity_type.as_str()),
            ("limit", limit.as_str()),
            ("options", "keyValues"),
        ])
        .header(header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|e| unavailable(e.to_string()))?;
    if !response.status().is_success() {
        return Err(unavailable(format!("status {}", response.status())));
    }
    let entities: Vec<Value> = response
        .json()
        .await
        .map_err(|e| unavailable(e.to_string()))?;
    Ok(cached(table(&entity_type, &entities)))
}

pub fn router() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/catalogue", axum::routing::get(get_catalogue))
        .route(
            "/catalogue/datasets/{name}",
            axum::routing::get(get_dataset),
        )
        .route(
            "/catalogue/datasets/{name}/sample",
            axum::routing::get(get_sample),
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn dataset(name: &str, org: &str, extras: Value, formats: &[&str], private: bool) -> Value {
        json!({
            "name": name,
            "title": name.to_uppercase(),
            "private": private,
            "organization": { "name": org, "title": format!("{org} title") },
            "license_id": "cc-by",
            "license_title": "Creative Commons Attribution",
            "resources": formats.iter().map(|f| json!({ "format": f, "url": "https://x/" })).collect::<Vec<_>>(),
            "extras": extras,
        })
    }

    fn extras(pairs: &[(&str, &str)]) -> Value {
        Value::Array(
            pairs
                .iter()
                .map(|(k, v)| json!({ "key": k, "value": v }))
                .collect(),
        )
    }

    fn fixture() -> Vec<Value> {
        vec![
            dataset(
                "air",
                "banskabystrica",
                extras(&[
                    (
                        "theme",
                        r#"["http://publications.europa.eu/resource/authority/data-theme/ENVI"]"#,
                    ),
                    ("temporal_start", "2024-03-01"),
                    ("temporal_end", "2025-06-30"),
                    ("spatial_uri", "http://data.europa.eu/nuts/code/SK032"),
                ]),
                &["CSV", "NGSI-LD"],
                false,
            ),
            dataset(
                "kpi",
                "bbsk",
                extras(&[(
                    "theme",
                    r#"["http://publications.europa.eu/resource/authority/data-theme/ECON","http://publications.europa.eu/resource/authority/data-theme/ENVI"]"#,
                )]),
                &["CSV"],
                false,
            ),
            dataset("secret", "bbsk", json!([]), &["CSV"], true),
        ]
    }

    #[test]
    fn a_private_dataset_is_never_listed_nor_counted() {
        let page = page_of(&fixture(), &Filters::parse(None), 2026);
        assert_eq!(page.total, 2);
        assert!(page.datasets.iter().all(|d| d.name != "secret"));
        let bbsk = page
            .facets
            .publisher
            .iter()
            .find(|v| v.value == "bbsk")
            .unwrap();
        assert_eq!(bbsk.count, 1);
    }

    #[test]
    fn facets_count_over_the_other_filters_and_values_of_one_filter_are_alternatives() {
        let filters = Filters::parse(Some("theme=ECON&theme=ENVI&publisher=bbsk"));
        let page = page_of(&fixture(), &filters, 2026);
        assert_eq!(page.total, 1);
        assert_eq!(page.datasets[0].name, "kpi");
        // The publisher facet ignores its own filter: both publishers stay selectable.
        assert_eq!(page.facets.publisher.len(), 2);
        // The theme facet counts under the publisher filter only.
        let themes: Vec<(&str, usize)> = page
            .facets
            .theme
            .iter()
            .map(|v| (v.value.as_str(), v.count))
            .collect();
        assert_eq!(themes, vec![("ECON", 1), ("ENVI", 1)]);
    }

    #[test]
    fn temporal_coverage_is_one_value_per_year_and_an_open_end_runs_to_this_year() {
        let page = page_of(&fixture(), &Filters::parse(Some("year=2025")), 2026);
        assert_eq!(page.total, 1);
        let years: Vec<&str> = page.facets.year.iter().map(|v| v.value.as_str()).collect();
        assert_eq!(years, vec!["2024", "2025"]);
        let open = dataset(
            "open",
            "o",
            extras(&[("temporal_start", "2025-01-01")]),
            &[],
            false,
        );
        assert_eq!(years_of(&open), vec![2025, 2026]);
        let bad = dataset(
            "bad",
            "o",
            extras(&[("temporal_start", "someday")]),
            &[],
            false,
        );
        assert!(years_of(&bad).is_empty());
    }

    fn years_of(d: &Value) -> Vec<i32> {
        years(d, 2026)
    }

    #[test]
    fn spatial_is_labelled_by_its_code_and_geojson_is_no_facet() {
        let page = page_of(&fixture(), &Filters::default_page(), 2026);
        assert_eq!(page.facets.spatial[0].label, "SK032");
        let geo = dataset(
            "geo",
            "o",
            extras(&[("spatial", r#"{"type":"Point"}"#)]),
            &[],
            false,
        );
        assert!(spatial(&geo).is_empty());
    }

    #[test]
    fn pages_are_twenty_datasets_and_a_bad_page_is_the_first() {
        let many: Vec<Value> = (0..45)
            .map(|i| dataset(&format!("d{i}"), "o", json!([]), &[], false))
            .collect();
        assert_eq!(
            page_of(&many, &Filters::parse(Some("page=3")), 2026)
                .datasets
                .len(),
            5
        );
        assert_eq!(Filters::parse(Some("page=0")).page, 1);
        assert_eq!(Filters::parse(Some("page=x")).page, 1);
        assert_eq!(
            page_of(&many, &Filters::parse(Some("page=9")), 2026)
                .datasets
                .len(),
            0
        );
    }

    #[test]
    fn only_an_endpoint_url_on_this_host_names_a_slug() {
        let base = Url::parse("https://dev.joinedcontext.com").unwrap();
        let slug = "mluyob4nz52lok3ssk7pgn5vwt";
        assert_eq!(
            endpoint_slug(
                &format!("https://dev.joinedcontext.com/api/endpoint/{slug}/"),
                &base
            ),
            Some(slug.to_owned())
        );
        for foreign in [
            format!("https://evil.example/api/endpoint/{slug}/"),
            format!("https://dev.joinedcontext.com:8443/api/endpoint/{slug}/"),
            format!("https://dev.joinedcontext.com/api/endpoint/{slug}/../../internal"),
            "https://dev.joinedcontext.com/api/endpoint/short/".to_owned(),
            format!("https://dev.joinedcontext.com/cs/{slug}"),
            "not a url".to_owned(),
        ] {
            assert_eq!(endpoint_slug(&foreign, &base), None, "{foreign}");
        }
    }

    #[test]
    fn the_sample_puts_id_and_type_first_and_writes_nested_values_as_json() {
        let sample = table(
            "KeyPerformanceIndicator",
            &[
                json!({ "id": "urn:a", "type": "KeyPerformanceIndicator", "value": 12, "@context": "x" }),
                json!({ "id": "urn:b", "type": "KeyPerformanceIndicator", "name": "b", "loc": { "type": "Point" } }),
            ],
        );
        assert_eq!(sample.columns, vec!["id", "type", "value", "loc", "name"]);
        assert_eq!(
            sample.rows[0],
            vec!["urn:a", "KeyPerformanceIndicator", "12", "", ""]
        );
        assert_eq!(sample.rows[1][3], r#"{"type":"Point"}"#);
        let many: Vec<Value> = (0..30)
            .map(|i| json!({ "id": format!("urn:{i}") }))
            .collect();
        assert_eq!(table("T", &many).rows.len(), 10);
        assert!(table("T", &[]).rows.is_empty());
    }

    #[test]
    fn a_theme_facet_is_named_by_the_eu_vocabulary_and_an_unknown_code_by_itself() {
        let page = page_of(&fixture(), &Filters::parse(None), 2026);
        let labels: Vec<(&str, &str)> = page
            .facets
            .theme
            .iter()
            .map(|v| (v.value.as_str(), v.label.as_str()))
            .collect();
        assert_eq!(
            labels,
            vec![("ENVI", "Environment"), ("ECON", "Economy and finance")]
        );
        assert_eq!(theme_label("XYZ"), "XYZ");
    }

    #[test]
    fn classes_are_described_from_the_linkml_in_any_of_its_shapes() {
        let linkml = r#"
classes:
  School:
    description: A school of the region.
  Course:
    description:
      sk: Kurz
      en: A course taught at a school.
  Pupil:
    description:
      sk: Žiak
  Room: {}
"#;
        let names: Vec<String> = ["School", "Course", "Pupil", "Room", "Ghost"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        let got = classes(&names, Some(linkml));
        assert_eq!(
            got[0].description.as_deref(),
            Some("A school of the region.")
        );
        assert_eq!(
            got[1].description.as_deref(),
            Some("A course taught at a school.")
        );
        assert_eq!(got[2].description.as_deref(), Some("Žiak"));
        assert_eq!(got[3].description, None);
        assert_eq!(got[4].name, "Ghost");
        assert_eq!(got[4].description, None);
        assert!(classes(&names, Some(": not yaml ["))
            .iter()
            .all(|c| c.description.is_none()));
        assert!(classes(&names, None)
            .iter()
            .all(|c| c.description.is_none()));
    }

    impl Filters {
        fn default_page() -> Self {
            Filters::parse(None)
        }
    }
}
