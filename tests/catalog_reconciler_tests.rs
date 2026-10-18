//! The open-data catalogue as an NGSI-LD Endpoint (T-4500): the gateway's DCAT-AP feed becomes one
//! `Dataset` per context space and one `DataService` per public Endpoint, written through the
//! repository's `catalog` Endpoint; a change is written in the wave it appears, and only it.

use joinedcontext_portal::config::ClientAuth;
use joinedcontext_portal::reconciler::catalog::{entities, fold, places, CatalogSync, Place, Run};
use joinedcontext_portal::reconciler::drift::Watch;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const PROJECT: &str = "mesto";
const CATALOG_SLUG: &str = "cccccccccccccccccccccccccc";
const AIR: &str = "32ea6ze7db7g6u7qnlgezpwp75";
const AIR_HISTORY: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const BIKES: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const INNER: &str = "iiiiiiiiiiiiiiiiiiiiiiiiii";
const HOST: &str = "https://city.example";

/// A fresh directory of this test process.
fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("jc-catalog-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("a scratch directory");
    dir
}

fn manifest(kind: &str, name: &str, spec: Value) -> String {
    json!({
        "apiVersion": "joinedcontext.com/v1alpha1",
        "kind": kind,
        "metadata": { "name": name, "namespace": PROJECT },
        "spec": spec,
    })
    .to_string()
}

fn endpoint(name: &str, slug: &str, space: &str, audience: &str) -> String {
    manifest(
        "Endpoint",
        name,
        json!({
            "contextSpaceRef": { "kind": "ContextSpace", "name": space },
            "slug": slug,
            "audience": audience,
            "enabledRepresentations": ["ngsi-ld", "mcp"],
        }),
    )
}

fn space(name: &str, bbox: Option<[f64; 4]>) -> String {
    let quality = bbox.map_or_else(Vec::new, |bbox| {
        vec![json!({
            "name": "in-the-city", "entityType": "AirQualityObserved", "kind": "area",
            "attribute": "location", "bbox": bbox,
        })]
    });
    manifest("ContextSpace", name, json!({ "quality": quality }))
}

/// The city: the catalogue, two public Endpoints of the air space, one of bikes, one internal.
fn city(dir: &Path, with_bikes: bool) -> jcctl::loader::Repository {
    let mut files = vec![
        ("catalog-space.yaml", space("catalog", None)),
        (
            "catalog.yaml",
            endpoint("catalog", CATALOG_SLUG, "catalog", "public"),
        ),
        (
            "ovzdusie.yaml",
            space("ovzdusie", Some([19.05, 48.68, 19.25, 48.8])),
        ),
        ("air.yaml", endpoint("air", AIR, "ovzdusie", "public")),
        (
            "air-history.yaml",
            endpoint("air-history", AIR_HISTORY, "ovzdusie", "public"),
        ),
        (
            "register.yaml",
            endpoint("register", INNER, "register", "organization"),
        ),
    ];
    if with_bikes {
        files.push(("bikes.yaml", endpoint("bikes", BIKES, "doprava", "public")));
    }
    for entry in std::fs::read_dir(dir).expect("the repository dir") {
        std::fs::remove_file(entry.expect("an entry").path()).expect("a file removed");
    }
    for (name, text) in files {
        std::fs::write(dir.join(name), text).expect("a manifest");
    }
    jcctl::loader::Repository::load(dir).expect("the repository loads")
}

fn tagged(en: &str, sk: &str) -> Value {
    json!([{ "@language": "en", "@value": en }, { "@language": "sk", "@value": sk }])
}

/// One Endpoint's record and service, the way the gateway's feed carries them.
fn record(slug: &str, title: (&str, &str)) -> [Value; 2] {
    let id = format!("{HOST}/api/endpoint/{slug}");
    [
        json!({
            "@id": id, "@type": "dcat:Dataset", "dct:identifier": slug,
            "dct:title": tagged(title.0, title.1),
            "dct:description": tagged("Hourly readings.", "Hodinové merania."),
            "dcat:keyword": tagged("air", "ovzdušie"),
            "dcat:theme": ["http://publications.europa.eu/resource/authority/data-theme/ENVI"],
            "dct:spatial": ["https://data.gov.sk/id/lau2/SK0321508438"],
            "dct:temporal": { "@type": "dct:PeriodOfTime", "dcat:startDate": "2020-01-01" },
            "dct:accrualPeriodicity": "http://publications.europa.eu/resource/authority/frequency/HOURLY",
            "dct:publisher": { "@id": "https://banskabystrica.sk/", "@type": "foaf:Agent",
                "foaf:name": tagged("City of Banská Bystrica", "Mesto Banská Bystrica") },
            "dct:accessRights": "http://publications.europa.eu/resource/authority/access-right/PUBLIC",
            "dct:license": "http://publications.europa.eu/resource/authority/licence/CC_BY_4_0",
            "dcat:distribution": [{
                "@id": format!("{id}/ngsi-ld/v1/"), "@type": "dcat:Distribution",
                "dcat:accessURL": format!("{id}/ngsi-ld/v1/"),
                "dct:conformsTo": "https://www.etsi.org/deliver/etsi_gs/CIM/001_099/009/",
                "dcat:mediaType": "https://www.iana.org/assignments/media-types/application/ld+json",
            }],
        }),
        json!({
            "@id": format!("{id}#service"), "@type": "dcat:DataService",
            "dcat:endpointURL": format!("{id}/"), "dcat:servesDataset": id,
        }),
    ]
}

fn feed(records: &[[Value; 2]]) -> Value {
    let included: Vec<Value> = records
        .iter()
        .flat_map(|pair| pair.iter().cloned())
        .collect();
    json!({ "@type": "dcat:Catalog", "@included": included })
}

fn air_feed(air_title: &str) -> Value {
    feed(&[
        record(AIR, (air_title, "Ovzdušie v Banskej Bystrici")),
        record(AIR_HISTORY, ("Air quality history", "História ovzdušia")),
        record(BIKES, ("Bike stations", "Stanice bicyklov")),
        // An organization Endpoint's record never reaches the feed; were it there, the
        // repository's audience still keeps it out.
        record(INNER, ("Internal registry", "Interný register")),
    ])
}

#[test]
fn a_dataset_per_space_and_a_service_per_public_endpoint_agree_with_the_record() {
    let dir = scratch("1");
    let places = places(&city(&dir, true));
    assert!(!places.contains_key(INNER) && !places.contains_key(CATALOG_SLUG));
    let feed = air_feed("Air quality in Banská Bystrica");
    let built = entities(feed["@included"].as_array().expect("nodes"), &places);
    let ids: Vec<&str> = built.keys().map(String::as_str).collect();
    assert_eq!(
        ids,
        [
            format!("urn:ngsi-ld:DataService:{AIR}").as_str(),
            &format!("urn:ngsi-ld:DataService:{AIR_HISTORY}"),
            &format!("urn:ngsi-ld:DataService:{BIKES}"),
            "urn:ngsi-ld:Dataset:mesto-doprava",
            "urn:ngsi-ld:Dataset:mesto-ovzdusie",
        ]
    );
    assert!(!serde_json::to_string(&built)
        .expect("json")
        .contains("Internal registry"));

    // Field by field, what the record says.
    let [record, _] = record(
        AIR,
        (
            "Air quality in Banská Bystrica",
            "Ovzdušie v Banskej Bystrici",
        ),
    );
    let service = &built[&format!("urn:ngsi-ld:DataService:{AIR}")];
    assert_eq!(
        service["title"]["languageMap"]["en"],
        "Air quality in Banská Bystrica"
    );
    assert_eq!(
        service["title"]["languageMap"]["sk"],
        "Ovzdušie v Banskej Bystrici"
    );
    assert_eq!(
        service["description"]["languageMap"]["sk"],
        "Hodinové merania."
    );
    assert_eq!(service["identifier"]["value"], AIR);
    assert_eq!(
        service["endpointURL"]["value"],
        format!("{HOST}/api/endpoint/{AIR}/")
    );
    assert_eq!(
        service["accessURL"]["value"][0]["accessURL"],
        record["dcat:distribution"][0]["dcat:accessURL"]
    );
    assert_eq!(
        service["accessURL"]["value"][0]["conformsTo"],
        record["dcat:distribution"][0]["dct:conformsTo"]
    );
    assert_eq!(service["accessRights"]["value"], record["dct:accessRights"]);
    assert_eq!(service["license"]["value"], record["dct:license"]);
    assert_eq!(
        service["servesDataset"]["object"],
        "urn:ngsi-ld:Dataset:mesto-ovzdusie"
    );

    let dataset = &built["urn:ngsi-ld:Dataset:mesto-ovzdusie"];
    // The space's first public Endpoint by slug names it.
    assert_eq!(
        dataset["title"]["languageMap"]["en"],
        "Air quality in Banská Bystrica"
    );
    assert_eq!(dataset["theme"]["value"], record["dcat:theme"]);
    assert_eq!(dataset["spatial"]["value"], record["dct:spatial"]);
    assert_eq!(dataset["keyword"]["value"], json!(["air", "ovzdušie"]));
    assert_eq!(
        dataset["temporal"]["value"],
        json!({ "startDate": "2020-01-01" })
    );
    assert_eq!(
        dataset["frequency"]["value"],
        record["dct:accrualPeriodicity"]
    );
    assert_eq!(
        dataset["publisher"]["value"]["id"],
        "https://banskabystrica.sk/"
    );
    assert_eq!(
        dataset["publisher"]["value"]["name"]["sk"],
        "Mesto Banská Bystrica"
    );
    assert_eq!(
        dataset["location"]["value"]["coordinates"][0][2],
        json!([19.25, 48.8]),
        "the space's area is where `georel=near` finds it"
    );
    let services: Vec<&Value> = dataset["dataService"]["value"]
        .as_array()
        .expect("a list")
        .iter()
        .map(|link| &link["identifier"])
        .collect();
    assert_eq!(services, [AIR, AIR_HISTORY]);
    let search = dataset["searchText"]["value"].as_str().expect("text");
    assert!(
        search.contains("banska bystrica") && search.contains("bystrici"),
        "{search}"
    );
    assert!(
        search.contains("ovzdusie") && !search.contains('š'),
        "{search}"
    );
    // No area declared: no location written, not an empty one.
    assert!(built["urn:ngsi-ld:Dataset:mesto-doprava"]
        .get("location")
        .is_none());
}

#[test]
fn folding_drops_diacritics_and_case() {
    assert_eq!(
        fold("Banská Bystrica, ŽILINA, Hämeenlinna"),
        "banska bystrica, zilina, hameenlinna"
    );
}

struct Gateway {
    server: MockServer,
    feed: Arc<std::sync::Mutex<Value>>,
}

impl Gateway {
    async fn start(feed: Value) -> Self {
        let server = MockServer::start().await;
        let shared = Arc::new(std::sync::Mutex::new(feed));
        let served = Arc::clone(&shared);
        Mock::given(method("POST"))
            .and(path("/realms/city/protocol/openid-connect/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "access_token": "t" })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/catalog.jsonld"))
            .respond_with(move |_: &wiremock::Request| {
                ResponseTemplate::new(200).set_body_json(served.lock().expect("feed").clone())
            })
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path(format!(
                "/api/endpoint/{CATALOG_SLUG}/ngsi-ld/v1/entities"
            )))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([])))
            .mount(&server)
            .await;
        for operation in ["upsert", "delete"] {
            Mock::given(method("POST"))
                .and(path(format!(
                    "/api/endpoint/{CATALOG_SLUG}/ngsi-ld/v1/entityOperations/{operation}"
                )))
                .respond_with(ResponseTemplate::new(204))
                .mount(&server)
                .await;
        }
        Self {
            server,
            feed: shared,
        }
    }

    fn sync(&self) -> CatalogSync {
        CatalogSync::new(Arc::new(Watch::new(
            self.server.uri(),
            &format!("{}/realms/city", self.server.uri()),
            "portal".to_owned(),
            ClientAuth::Secret("s".into()),
        )))
    }

    /// The ids each batch call since `from` sent, by operation, and how many listings ran.
    async fn sent(&self, from: usize) -> (BTreeMap<String, Vec<String>>, usize) {
        let requests = self.server.received_requests().await.expect("recorded");
        let mut sent: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let mut listings = 0;
        for request in &requests[from..] {
            let url = request.url.path();
            if url.ends_with("/entities") {
                listings += 1;
            }
            let Some(operation) = url.rsplit_once("entityOperations/").map(|(_, op)| op) else {
                continue;
            };
            let body: Vec<Value> = serde_json::from_slice(&request.body).expect("a batch");
            sent.entry(operation.to_owned())
                .or_default()
                .extend(body.iter().map(|item| {
                    item.get("id")
                        .unwrap_or(item)
                        .as_str()
                        .unwrap_or_default()
                        .to_owned()
                }));
        }
        (sent, listings)
    }

    async fn requests(&self) -> usize {
        self.server
            .received_requests()
            .await
            .expect("recorded")
            .len()
    }
}

#[tokio::test]
async fn an_endpoint_created_renamed_and_deleted_shows_in_the_catalog_within_one_wave() {
    let dir = scratch("2");
    let gateway = Gateway::start(air_feed("Air quality in Banská Bystrica")).await;
    let sync = gateway.sync();

    let run = sync
        .converge(&city(&dir, true))
        .await
        .expect("the first wave");
    assert_eq!(
        run,
        Some(Run {
            upserted: 5,
            deleted: 0
        })
    );
    let (sent, listings) = gateway.sent(0).await;
    assert_eq!(listings, 1, "a fresh Portal lists what the catalogue holds");
    assert_eq!(sent["upsert"].len(), 5);

    // Nothing changed: nothing is written, and the memory is trusted.
    let from = gateway.requests().await;
    assert_eq!(
        sync.converge(&city(&dir, true)).await,
        Ok(Some(Run::default()))
    );
    let (sent, listings) = gateway.sent(from).await;
    assert!(sent.is_empty() && listings == 0, "{sent:?}");

    // Renamed: its service and its space's Dataset, and nothing else.
    *gateway.feed.lock().expect("feed") = air_feed("Air in Banská Bystrica");
    let from = gateway.requests().await;
    sync.converge(&city(&dir, true)).await.expect("the rename");
    let (sent, _) = gateway.sent(from).await;
    assert_eq!(
        sent["upsert"],
        [
            format!("urn:ngsi-ld:DataService:{AIR}"),
            "urn:ngsi-ld:Dataset:mesto-ovzdusie".to_owned()
        ]
    );

    // Deleted from the repository: its service and its now empty space go.
    let from = gateway.requests().await;
    let run = sync.converge(&city(&dir, false)).await.expect("the delete");
    assert_eq!(
        run,
        Some(Run {
            upserted: 0,
            deleted: 2
        })
    );
    let (sent, _) = gateway.sent(from).await;
    assert_eq!(
        sent["delete"],
        [
            format!("urn:ngsi-ld:DataService:{BIKES}"),
            "urn:ngsi-ld:Dataset:mesto-doprava".to_owned(),
        ]
    );
}

#[tokio::test]
async fn a_repository_without_a_catalog_endpoint_writes_nothing() {
    let dir = scratch("3");
    let gateway = Gateway::start(air_feed("Air")).await;
    std::fs::write(
        dir.join("air.yaml"),
        endpoint("air", AIR, "ovzdusie", "public"),
    )
    .expect("a file");
    let repo = jcctl::loader::Repository::load(&dir).expect("loads");
    assert_eq!(gateway.sync().converge(&repo).await, Ok(None));
    assert_eq!(gateway.requests().await, 0);
}

#[tokio::test]
async fn a_refused_write_is_an_error_and_the_next_wave_lists_again() {
    let dir = scratch("4");
    let gateway = Gateway::start(air_feed("Air")).await;
    // A higher priority than the 204 the gateway answers by default.
    let refusal = Mock::given(method("POST"))
        .and(path(format!(
            "/api/endpoint/{CATALOG_SLUG}/ngsi-ld/v1/entityOperations/upsert"
        )))
        .respond_with(ResponseTemplate::new(403))
        .with_priority(1)
        .up_to_n_times(1)
        .mount_as_scoped(&gateway.server)
        .await;
    let sync = gateway.sync();
    let err = sync.converge(&city(&dir, true)).await.expect_err("refused");
    assert!(err.contains("403"), "{err}");
    drop(refusal);
    let from = gateway.requests().await;
    sync.converge(&city(&dir, true))
        .await
        .expect("the next wave");
    let (sent, listings) = gateway.sent(from).await;
    assert_eq!((listings, sent["upsert"].len()), (1, 5));
}

#[tokio::test]
async fn ten_thousand_endpoints_are_written_in_one_wave() {
    let dir = scratch("5");
    let mut files = vec![(
        "catalog.yaml".to_owned(),
        endpoint("catalog", CATALOG_SLUG, "catalog", "public"),
    )];
    let mut records = Vec::new();
    for n in 0..10_000 {
        let slug = format!("{n:0>26}");
        files.push((
            format!("e{n}.yaml"),
            endpoint(&format!("e{n}"), &slug, &format!("s{n}"), "public"),
        ));
        records.push(record(&slug, ("Dataset", "Dataset")));
    }
    for (name, text) in &files {
        std::fs::write(dir.join(name), text).expect("a manifest");
    }
    let repo = jcctl::loader::Repository::load(&dir).expect("loads");
    let gateway = Gateway::start(feed(&records)).await;
    let started = std::time::Instant::now();
    let run = gateway.sync().converge(&repo).await.expect("the wave");
    let took = started.elapsed();
    eprintln!("10,000 Endpoints: {took:?}");
    assert_eq!(
        run,
        Some(Run {
            upserted: 20_000,
            deleted: 0
        })
    );
    assert!(took < std::time::Duration::from_secs(30), "{took:?}");
}

#[test]
fn places_names_only_public_endpoints_and_their_space_area() {
    let dir = scratch("6");
    let places = places(&city(&dir, false));
    assert_eq!(
        places.get(AIR),
        Some(&Place::public(
            "mesto-ovzdusie",
            Some([19.05, 48.68, 19.25, 48.8])
        ))
    );
    assert_eq!(places.len(), 2);
}

/// T-4526: each DataService names the types its Endpoint holds with their counts, as the
/// anonymous caller reads them, and the call that reads it; the Dataset's searchText names the
/// types. A wave within the hour reads no count again.
#[tokio::test]
async fn a_service_lists_its_types_with_counts_and_the_next_query() {
    let dir = scratch("7");
    let gateway = Gateway::start(air_feed("Air quality in Banská Bystrica")).await;
    let surface = format!("/api/endpoint/{AIR}/ngsi-ld/v1");
    Mock::given(method("GET"))
        .and(path(format!("{surface}/types")))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            json!({ "id": "urn:ngsi-ld:EntityTypeList:1", "type": "EntityTypeList",
                    "typeList": ["AirQualityObserved", "https://example.org/Station"] }),
        ))
        .mount(&gateway.server)
        .await;
    for (name, count) in [
        ("AirQualityObserved", "53"),
        ("https://example.org/Station", "7"),
    ] {
        Mock::given(method("GET"))
            .and(path(format!("{surface}/entities")))
            .and(wiremock::matchers::query_param("type", name))
            .and(wiremock::matchers::query_param("count", "true"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("NGSILD-Results-Count", count)
                    .set_body_json(json!([])),
            )
            .mount(&gateway.server)
            .await;
    }
    let sync = gateway.sync();
    sync.converge(&city(&dir, true)).await.expect("a wave");

    let requests = gateway.server.received_requests().await.expect("recorded");
    let anonymous = requests
        .iter()
        .filter(|r| r.url.path().starts_with(&surface))
        .all(|r| !r.headers.contains_key("authorization"));
    assert!(anonymous, "the counts are read as the anonymous caller");
    let written: Vec<Value> = requests
        .iter()
        .filter(|r| r.url.path().ends_with("entityOperations/upsert"))
        .flat_map(|r| serde_json::from_slice::<Vec<Value>>(&r.body).expect("a batch"))
        .collect();
    let service = written
        .iter()
        .find(|e| e["id"] == format!("urn:ngsi-ld:DataService:{AIR}"))
        .expect("the air service");
    assert_eq!(
        service["entityTypes"]["value"],
        json!([{ "type": "AirQualityObserved", "count": 53 }, { "type": "Station", "count": 7 }])
    );
    assert_eq!(
        service["nextQuery"]["value"],
        json!({ "tool": "query_entities", "arguments": { "endpoint": AIR, "type": "AirQualityObserved", "limit": 10 } })
    );
    let dataset = written
        .iter()
        .find(|e| e["id"] == "urn:ngsi-ld:Dataset:mesto-ovzdusie")
        .expect("the air dataset");
    assert!(
        dataset["searchText"]["value"]
            .as_str()
            .is_some_and(|t| t.contains("airqualityobserved")),
        "{dataset}"
    );
    // A bikes service whose counts did not read has no types, and the wave still wrote it.
    assert!(written
        .iter()
        .any(|e| e["id"] == format!("urn:ngsi-ld:DataService:{BIKES}")
            && e.get("entityTypes").is_none()));

    let from = requests.len();
    sync.converge(&city(&dir, true))
        .await
        .expect("a second wave");
    let again = gateway.server.received_requests().await.expect("recorded");
    assert!(
        !again[from..]
            .iter()
            .any(|r| r.url.path().starts_with(&surface)),
        "counts are read once an hour"
    );
}
