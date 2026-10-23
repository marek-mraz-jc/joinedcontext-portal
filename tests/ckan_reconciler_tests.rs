//! What a reconcile run does to the open-data catalogue (T-2405, EP-62…EP-67, CC-19).
//!
//! The publisher has been complete for a while and nothing drove it: a dataset appeared when
//! somebody ran `jcctl publish ckan` from a shell, and an Endpoint that stopped publishing left
//! its dataset in the catalogue. These tests are about the wave that drives it: what it publishes,
//! what it withdraws, what it refuses to touch, and that the API token is in none of it.
//!
//! The catalogue is the publisher's own in-memory double, which carries a token the way the real
//! transport does, so a payload that contained it would be visible here.

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use jcctl::commands::publish_ckan::{Rows, Target};
use jcctl::loader::{RawManifest, RawMetadata, ResourceId};
use jcctl::publish::ckan::{InMemoryCkan, Outcome, Settings};
use joinedcontext_portal::reconciler::ckan::{
    fingerprint, publish_with, publish_without_rows, sweep_with, withdrawn, CkanSync, Paced,
    Pacing, Publication, Report, CALL_GAP, MOST_BACKOFF, RECORD_READS, REFRESH, ROWS_READS,
};
use joinedcontext_portal::resource::ResourceEnvelope;
use joinedcontext_portal::store::Mirror;
use serde_json::{json, Value};

const PROJECT: &str = "helsinki";
const HOST: &str = "portal.example.fi";
/// The token the catalogue holds. It may not appear in anything a run writes or reports.
const TOKEN: &str = "ckan-api-token-2ZQ8vN";

fn settings() -> Settings {
    Settings::new(HOST).titled("City of Helsinki")
}

fn envelope(kind: &str, name: &str, spec: Value) -> ResourceEnvelope {
    serde_json::from_value(json!({
        "apiVersion": "joinedcontext.com/v1alpha1",
        "kind": kind,
        "metadata": { "name": name, "namespace": PROJECT },
        "spec": spec,
    }))
    .expect("an envelope")
}

/// The catalogue manifest of the seed, without the token (EP-67).
fn instance() -> Value {
    json!({
        "url": "https://data.example.fi",
        "organizationDefault": "hel-fi",
        "apiTokenRef": { "name": "ckan-api-token", "key": "token", "envVar": "CKAN_API_TOKEN" },
    })
}

/// One Endpoint, publishing or not.
fn endpoint(name: &str, audience: &str, publish: Option<Value>) -> Value {
    let mut spec = json!({
        "contextSpaceRef": { "kind": "ContextSpace", "name": "bikes" },
        "slug": "scsd2eehkx42n53z2zyd6vshfh7s7irf",
        "audience": audience,
        "enabledRepresentations": ["ngsi-ld", "csv"],
    });
    if let Some(publication) = publish {
        spec["publish"] = json!({ "ckan": publication });
    }
    let _ = name;
    spec
}

/// The `publish.ckan` block of an Endpoint that also mirrors its rows.
fn with_sheet() -> Value {
    json!({
        "instanceRef": { "kind": "CkanInstance", "name": "hel-fi" },
        "datastore": { "representation": "csv", "refresh": "onReconcile" },
    })
}

/// The `publish.ckan` block of an Endpoint that publishes the dataset alone.
fn dataset_only() -> Value {
    json!({ "instanceRef": { "kind": "CkanInstance", "name": "hel-fi" } })
}

/// A target the way `publisher::targets` builds one, for the calls that need no repository.
fn target(name: &str, audience: &str, publication: Value) -> Target {
    let spec = endpoint(name, audience, Some(publication.clone()));
    Target {
        id: ResourceId {
            group: "joinedcontext.com".to_owned(),
            kind: "Endpoint".to_owned(),
            namespace: Some(PROJECT.to_owned()),
            name: name.to_owned(),
        },
        manifest: RawManifest {
            api_version: "joinedcontext.com/v1alpha1".to_owned(),
            kind: "Endpoint".to_owned(),
            metadata: RawMetadata {
                name: name.to_owned(),
                namespace: Some(PROJECT.to_owned()),
                rest: serde_json::Map::new(),
            },
            spec: spec.clone(),
            status: None,
        },
        slug: "scsd2eehkx42n53z2zyd6vshfh7s7irf".to_owned(),
        publication: serde_json::from_value(publication).expect("a publication"),
        instance_name: "hel-fi".to_owned(),
        instance: serde_json::from_value(instance()).expect("an instance"),
        language: None,
        instance_title: None,
        history: Default::default(),
    }
}

/// The DCAT-AP record the gateway answers with, as the publisher reads it (EP-27).
fn record() -> Value {
    json!({
        "dct:title": "Helsinki city bike stations",
        "dct:description": "Every station, its capacity and how many bikes are free.",
        "dct:license": "cc-by",
        "dct:publisher": "City of Helsinki",
        "dcat:keyword": ["bikes", "mobility"],
        "dct:accrualPeriodicity": "http://publications.europa.eu/resource/authority/frequency/UPDATE_CONT",
    })
}

/// A tabular answer of two stations, as the CSV representation serves it.
const ROWS: &str = "id,type,name,available\nurn:ngsi-ld:BikeStation:hel.fi:bikes:1,BikeStation,Rautatientori,12\nurn:ngsi-ld:BikeStation:hel.fi:bikes:2,BikeStation,Kamppi,4\n";

/// The gateway's answer for a sheet: `csv`, and no model schema or LinkML (T-3012, T-4672).
fn answer(csv: &str) -> Rows {
    Rows {
        csv: csv.to_owned(),
        schema: None,
        linkml: None,
    }
}

#[test]
fn an_endpoint_becomes_a_dataset_with_the_sheet_it_declares() {
    let mut api = InMemoryCkan::new().with_token(TOKEN);
    let target = target("helsinki-bikes", "public", with_sheet());

    let published = publish_with(
        &mut api,
        &target,
        &record(),
        Some(&answer(ROWS)),
        &settings(),
    )
    .expect("the endpoint publishes");
    let Publication::Published {
        dataset,
        outcome,
        rows,
        ..
    } = published
    else {
        panic!("a publication, got {published:?}");
    };
    assert_eq!(dataset, "helsinki-bikes");
    assert_eq!(outcome, Outcome::Created);
    assert_eq!(rows, Some(2));

    let package = api.package("helsinki-bikes").expect("the dataset");
    assert_eq!(package["title"], "Helsinki city bike stations");
    assert_eq!(package["owner_org"], "hel-fi");
    // A public endpoint is a public dataset; the rest of EP-69 is the case below.
    assert_eq!(package["private"], false);
    // The organization the catalogue did not have is created with the installation's own name.
    assert!(api.actions().contains(&"organization_create"));
}

#[test]
fn a_narrower_endpoint_publishes_a_private_dataset() {
    // EP-69, closed by default: only a `public` endpoint may produce a public dataset, and the
    // form offers no visibility of its own that could disagree with it.
    for audience in ["organization", "project-list"] {
        let mut api = InMemoryCkan::new().with_token(TOKEN);
        let target = target("helsinki-bikes", audience, dataset_only());
        publish_with(&mut api, &target, &record(), None, &settings()).expect("it publishes");
        assert_eq!(
            api.package("helsinki-bikes").expect("the dataset")["private"],
            true,
            "{audience} is not public"
        );
    }
}

#[test]
fn a_second_run_over_an_unchanged_endpoint_writes_nothing() {
    // CC-18: the wave runs every tick, so a converged catalogue has to make no writing call at
    // all. Without this a dataset would be rewritten once a minute for its whole life.
    let mut api = InMemoryCkan::new()
        .with_organization("hel-fi")
        .with_token(TOKEN);
    let target = target("helsinki-bikes", "public", dataset_only());
    publish_with(&mut api, &target, &record(), None, &settings()).expect("the first run");
    let calls = api.actions().len();

    let again = publish_with(&mut api, &target, &record(), None, &settings()).expect("the second");
    assert_eq!(
        again,
        Publication::Published {
            dataset: "helsinki-bikes".to_owned(),
            outcome: Outcome::Unchanged,
            rows: None,
            no_linkml: false,
        }
    );
    assert_eq!(api.actions().len(), calls, "the second run wrote something");
}

#[test]
fn the_sheet_follows_the_endpoints_answer_when_an_entity_is_gone() {
    // EP-65: the rows are the endpoint's answer, so an entity the endpoint no longer answers for
    // loses its row. This is what makes a deletion propagate into the catalogue instead of leaving
    // a public copy behind.
    let mut api = InMemoryCkan::new()
        .with_organization("hel-fi")
        .with_token(TOKEN);
    let target = target("helsinki-bikes", "public", with_sheet());
    publish_with(
        &mut api,
        &target,
        &record(),
        Some(&answer(ROWS)),
        &settings(),
    )
    .expect("the first run");

    let fewer =
        "id,type,name,available\nurn:ngsi-ld:BikeStation:hel.fi:bikes:2,BikeStation,Kamppi,4\n";
    let second = publish_with(
        &mut api,
        &target,
        &record(),
        Some(&answer(fewer)),
        &settings(),
    )
    .expect("the second run");
    let Publication::Published { rows, .. } = second else {
        panic!("a publication");
    };
    // Two rows became one: the deletion arrives in the catalogue rather than leaving a stale
    // public copy of the station that is gone.
    assert_eq!(rows, Some(1));
}

#[test]
fn the_token_is_in_nothing_a_run_writes_or_reports() {
    // EP-67: the token travels in the Authorization header of the transport and nowhere else.
    let mut api = InMemoryCkan::new().with_token(TOKEN);
    let target = target("helsinki-bikes", "public", with_sheet());
    let published = publish_with(
        &mut api,
        &target,
        &record(),
        Some(&answer(ROWS)),
        &settings(),
    )
    .expect("it publishes");

    let written = api
        .calls()
        .map(|(action, payload)| format!("{action} {payload}"))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(!written.contains(TOKEN), "a payload carried the token");
    assert!(
        !written.contains("ckan-api-token-"),
        "a payload carried the token"
    );
    assert!(
        !format!("{published:?}").contains(TOKEN),
        "the report carried the token"
    );
    // The reference's own name is fine and useful; the value is not.
    assert_eq!(api.token(), TOKEN);
}

#[test]
fn a_withdrawn_publication_and_a_deleted_endpoint_both_lose_their_dataset() {
    // CC-19: a dataset is withdrawn when the Endpoint that declared it stops declaring one, and
    // when the Endpoint is gone altogether. Both are read from the previous run's mirror, so a
    // dataset this reconciler never published is never deleted by it.
    let previous = Mirror::new();
    previous.upsert(envelope("CkanInstance", "hel-fi", instance()));
    previous.upsert(envelope(
        "Endpoint",
        "still-published",
        endpoint("still-published", "public", Some(dataset_only())),
    ));
    previous.upsert(envelope(
        "Endpoint",
        "block-withdrawn",
        endpoint("block-withdrawn", "public", Some(with_sheet())),
    ));
    previous.upsert(envelope(
        "Endpoint",
        "endpoint-deleted",
        endpoint("endpoint-deleted", "public", Some(dataset_only())),
    ));
    previous.upsert(envelope(
        "Endpoint",
        "never-published",
        endpoint("never-published", "public", None),
    ));

    // What this run publishes: the first endpoint only. The second dropped its block, the third
    // is gone from the repository, the fourth never published.
    let published: BTreeSet<(String, String)> =
        [(PROJECT.to_owned(), "still-published".to_owned())]
            .into_iter()
            .collect();

    let gone = withdrawn(&previous, &published);
    let names: BTreeSet<String> = gone.iter().map(|t| t.id.name.clone()).collect();
    assert_eq!(
        names,
        ["block-withdrawn".to_owned(), "endpoint-deleted".to_owned()]
            .into_iter()
            .collect::<BTreeSet<_>>()
    );
    // Each carries the catalogue it published to, which is the only way its dataset is reachable.
    for target in &gone {
        assert_eq!(target.instance_name, "hel-fi");
        assert_eq!(target.instance.base_url(), "https://data.example.fi");
        assert_eq!(target.id.namespace.as_deref(), Some(PROJECT));
    }
}

#[test]
fn an_endpoint_whose_catalogue_is_also_gone_is_left_alone() {
    // Nothing can be reached without the instance's URL and token reference. Inventing either
    // would be worse than leaving the dataset to a person: the run says so in the log and touches
    // nothing.
    let previous = Mirror::new();
    previous.upsert(envelope(
        "Endpoint",
        "orphaned",
        endpoint("orphaned", "public", Some(dataset_only())),
    ));
    assert!(withdrawn(&previous, &BTreeSet::new()).is_empty());
}

#[test]
fn withdrawing_removes_the_dataset_and_can_be_repeated() {
    // CC-19 through the publisher's explicit-deletion path. Dropping the sheet first needs the
    // resource id CKAN assigns to it, which the in-memory catalogue does not hand back; that half
    // is `jcctl`'s own `ckan_datastore` test. What matters here is that the wave's withdrawal
    // removes the record and that a repeat after a partial failure is not an error.
    let mut api = InMemoryCkan::new()
        .with_organization("hel-fi")
        .with_token(TOKEN);
    let target = target("helsinki-bikes", "public", with_sheet());
    publish_with(
        &mut api,
        &target,
        &record(),
        Some(&answer(ROWS)),
        &settings(),
    )
    .expect("it publishes");
    assert!(api.package("helsinki-bikes").is_some());

    let gone = joinedcontext_portal::reconciler::ckan::withdraw_one(&mut api, &target)
        .expect("it withdraws");
    assert_eq!(
        gone,
        Publication::Withdrawn {
            dataset: "helsinki-bikes".to_owned()
        }
    );
    assert!(
        api.actions().contains(&"package_delete"),
        "{:?}",
        api.actions()
    );

    // A run repeated after a failure withdraws what is already gone without an error.
    joinedcontext_portal::reconciler::ckan::withdraw_one(&mut api, &target)
        .expect("withdrawing twice is not an error");
}

#[tokio::test]
async fn without_a_way_to_read_the_token_the_run_says_so_and_publishes_nothing() {
    // A Portal with no age identity and no variable for the reference: the publication is one
    // failed report naming the reference, and no socket is opened towards the catalogue. The
    // reason is the publisher's own sentence, which names what to pass and never a value.
    let previous = Mirror::new();
    previous.upsert(envelope("CkanInstance", "hel-fi", instance()));
    previous.upsert(envelope(
        "Endpoint",
        "helsinki-bikes",
        endpoint("helsinki-bikes", "public", Some(dataset_only())),
    ));
    let sync = CkanSync::new(HOST);
    let repository = std::env::temp_dir().join("jc-ckan-reconciler-no-secrets");
    std::fs::create_dir_all(&repository).expect("a scratch directory");

    // `converge` over a repository with no manifests publishes nothing and withdraws what the
    // previous run had; both need the token, so the report is the refusal.
    let empty = jcctl::loader::Repository::load(&repository).expect("an empty repository");
    let reports = sync.converge(&empty, &previous, &repository).await;
    assert_eq!(reports.len(), 1, "{reports:?}");
    let Report {
        project,
        endpoint,
        publication,
    } = &reports[0];
    assert_eq!(project, PROJECT);
    assert_eq!(endpoint, "helsinki-bikes");
    let Publication::Failed(reason) = publication else {
        panic!("a refusal, got {publication:?}");
    };
    assert!(
        reason.contains("api-token-env") || reason.contains("age-key-file"),
        "the reason says what is missing: {reason}"
    );
    assert!(!reason.contains(TOKEN), "the reason carried a credential");
}

/// T-2465, EP-62, EP-63: the reconciler's run carries what the walk resolved — the space's
/// language picks the Slovak title and notes, the publication's licence fills the one term the
/// gateway's record lacks, and an organization the catalogue lacks takes the instance's title
/// rather than the installation's branding (which on dev names every organization after Helsinki).
#[test]
fn a_slovak_endpoint_publishes_under_its_slovak_title_licence_and_organization() {
    let mut api = InMemoryCkan::new().with_token(TOKEN);
    let mut target = target(
        "public-air",
        "public",
        json!({ "instanceRef": { "kind": "CkanInstance", "name": "hel-fi" }, "license": "cc-by" }),
    );
    target.language = Some("sk".to_owned());
    target.instance_title = Some("Mesto Banská Bystrica".to_owned());
    let record = json!({
        "dct:title": [
            { "@value": "Air quality in Banská Bystrica", "@language": "en" },
            { "@value": "Kvalita ovzdušia v Banskej Bystrici", "@language": "sk" }
        ],
    });

    publish_with(&mut api, &target, &record, None, &settings()).expect("the endpoint publishes");

    assert_eq!(api.actions(), vec!["organization_create", "package_create"]);
    let (_, organization) = api.calls().next().expect("the organization call");
    assert_eq!(organization["title"], json!("Mesto Banská Bystrica"));
    let dataset = api.package("public-air").expect("the dataset");
    assert_eq!(
        dataset["title"],
        json!("Kvalita ovzdušia v Banskej Bystrici")
    );
    assert_eq!(dataset["license_id"], json!("cc-by"));

    // CC-18: the next reconcile finds the catalogue as it left it.
    let again = publish_with(&mut api, &target, &record, None, &settings()).expect("second run");
    assert!(
        matches!(
            again,
            Publication::Published {
                outcome: Outcome::Unchanged,
                ..
            }
        ),
        "{again:?}"
    );
}

/// T-3903, DM-95: a dataset's measurements are its space's 7-day pass rate, to a hundredth, and
/// the age of the newest data when the daily run read it; nothing measured is no measurement.
#[test]
fn the_measurements_are_the_spaces_pass_rate_and_freshness() {
    use joinedcontext_portal::quality::{SpaceQuality, TypeQuality};
    use joinedcontext_portal::quality_checks::{Reading, Readings};
    use joinedcontext_portal::reconciler::ckan::measurements;

    let at = |text: &str| {
        text.parse::<chrono::DateTime<chrono::Utc>>()
            .expect("a time")
    };
    let checks = Readings::new(None);
    assert_eq!(
        measurements(None, &checks.report("air", &[])),
        jcctl::publish::ckan::Measurements::default()
    );

    let key = |rule: &str, outcome: &str| {
        (
            "air".to_owned(),
            "AirQualityObserved".to_owned(),
            rule.to_owned(),
            outcome.to_owned(),
        )
    };
    checks.record(Reading {
        at: at("2026-10-12T00:00:00Z"),
        counts: [
            (key("pm10", "pass"), 2.0),
            (key("pm10", "reject"), 1.0),
            (key("no2", "pass"), 0.0),
        ]
        .into(),
    });
    let daily = SpaceQuality {
        observed_at: at("2026-10-12T02:00:00Z"),
        checked: 3,
        invalid: 0,
        truncated: false,
        rules: Vec::new(),
        freshness: Vec::new(),
        types: ["2026-10-12T01:56:00Z", "2026-10-12T01:00:00Z"]
            .iter()
            .map(|newest| TypeQuality {
                entity_type: "AirQualityObserved".into(),
                count: 1,
                newest: Some(at(newest)),
                attributes: Vec::new(),
            })
            .collect(),
    };
    let measured = measurements(Some(&daily), &checks.report("air", &[]));
    // The first reading is its own base, so the week counts nothing yet: no rate, never 100 %.
    assert_eq!(measured.pass_rate, None);
    assert_eq!(measured.freshness_seconds, Some(240));

    checks.record(Reading {
        at: at("2026-10-12T01:00:00Z"),
        counts: [(key("pm10", "pass"), 4.0), (key("pm10", "reject"), 2.0)].into(),
    });
    let measured = measurements(Some(&daily), &checks.report("air", &[]));
    assert_eq!(measured.pass_rate, Some(0.67));
}

/// DM-95, T-3903: a dataset's pass rate is its space's, read by the tenant segment the gateway
/// labels its counters with (`helsinki-bikes` here), never by a namesake labelled `bikes`.
#[test]
fn a_datasets_measurements_are_read_by_its_spaces_segment() {
    use std::sync::Arc;

    use joinedcontext_portal::quality::Store;
    use joinedcontext_portal::quality_checks::{Reading, Readings};

    let checks = Arc::new(Readings::new(None));
    for (at, ours, namesake) in [
        ("2026-10-12T00:00:00Z", 0.0, 0.0),
        ("2026-10-12T01:00:00Z", 3.0, 50.0),
    ] {
        let key = |space: &str, outcome: &str| {
            (
                space.to_owned(),
                "Bike".to_owned(),
                "speed".to_owned(),
                outcome.to_owned(),
            )
        };
        checks.record(Reading {
            at: at.parse().expect("a time"),
            counts: [
                (key("helsinki-bikes", "pass"), ours),
                (key("helsinki-bikes", "reject"), ours / 3.0),
                (key("bikes", "reject"), namesake),
            ]
            .into(),
        });
    }
    let sync = CkanSync::new(HOST).with_quality(Arc::new(Store::default()), checks);
    let repository = std::env::temp_dir().join("jc-ckan-reconciler-measured");
    std::fs::create_dir_all(&repository).expect("a scratch directory");
    let repo = jcctl::loader::Repository::load(&repository).expect("an empty repository");
    let measured = sync.measured(&repo, &target("helsinki-bikes", "public", dataset_only()));
    assert_eq!(measured.pass_rate, Some(0.75));
}

/// T-4065: an Endpoint that starts serving its WebSocket brings the dataset a resource for it,
/// whose URL ends `/ws` and whose description links the guide.
#[test]
fn an_endpoint_gaining_websocket_updates_its_dataset_with_the_ws_resource() {
    let mut api = InMemoryCkan::new()
        .with_organization("hel-fi")
        .with_token(TOKEN);
    let settings = settings().documented_at("https://docs.example.fi");
    let before = target("helsinki-transport", "public", dataset_only());
    publish_with(&mut api, &before, &record(), None, &settings).expect("the first run");

    let mut after = before.clone();
    after.manifest.spec["enabledRepresentations"] = json!(["ngsi-ld", "csv", "websocket"]);
    let published =
        publish_with(&mut api, &after, &record(), None, &settings).expect("it publishes");
    assert!(
        matches!(
            published,
            Publication::Published {
                outcome: Outcome::Updated,
                ..
            }
        ),
        "{published:?}"
    );
    assert_eq!(api.actions().last(), Some(&"package_update"));
    let package = api.package("helsinki-transport").expect("the dataset");
    let ws = package["resources"]
        .as_array()
        .expect("resources")
        .iter()
        .find(|resource| {
            resource["url"]
                .as_str()
                .is_some_and(|url| url.ends_with("/ws"))
        })
        .expect("a WebSocket resource");
    assert_eq!(ws["format"], "WebSocket");
    let description = ws["description"].as_str().unwrap_or_default();
    assert!(
        description.contains("https://docs.example.fi/API/07-websocket"),
        "{description}"
    );
}

/// T-4065: rows that do not read (the gateway timing out on a whole Endpoint's CSV) no longer
/// keep the dataset at its old resources: it is updated, the sheet keeps what it holds, and the
/// run fails naming the reason and never the token.
#[test]
fn rows_that_do_not_read_still_bring_the_dataset_to_its_record() {
    let mut api = InMemoryCkan::new()
        .with_organization("hel-fi")
        .with_token(TOKEN);
    let mut target = target("helsinki-transport", "public", with_sheet());
    publish_with(
        &mut api,
        &target,
        &record(),
        Some(&answer(ROWS)),
        &settings(),
    )
    .expect("first run");
    let sheet = api.package("helsinki-transport").expect("the dataset")["resources"]
        .as_array()
        .expect("resources")
        .iter()
        .filter(|resource| resource["url_type"] == "datastore")
        .count();
    assert!(sheet > 0, "the first run made a sheet");

    target.manifest.spec["enabledRepresentations"] = json!(["ngsi-ld", "csv", "websocket"]);
    let unread = "the gateway did not answer file.csv: operation timed out";
    let failed = publish_without_rows(&mut api, &target, &record(), unread, &settings())
        .expect_err("the sheet was not refreshed");
    assert_eq!(
        failed,
        format!("the dataset is updated, its sheet was not refreshed: {unread}")
    );
    let package = api.package("helsinki-transport").expect("the dataset");
    let resources = package["resources"].as_array().expect("resources");
    assert!(resources
        .iter()
        .any(|r| r["url"].as_str().is_some_and(|url| url.ends_with("/ws"))));
    assert_eq!(
        resources
            .iter()
            .filter(|r| r["url_type"] == "datastore")
            .count(),
        sheet,
        "the sheet is kept"
    );
    assert!(!failed.contains(TOKEN));
}

/// T-4065: the log says each Endpoint's outcome when it changes, every write, and a failure
/// again only when its reason changes.
#[test]
fn the_log_says_an_outcome_once_per_change_and_every_write() {
    let sync = CkanSync::new(HOST);
    let report = |publication: Publication| Report {
        project: PROJECT.to_owned(),
        endpoint: "helsinki-transport".to_owned(),
        publication,
    };
    let published = |outcome| {
        report(Publication::Published {
            dataset: "helsinki-transport".to_owned(),
            outcome,
            rows: None,
            no_linkml: false,
        })
    };
    let failed = report(Publication::Failed("the gateway answered 429".to_owned()));
    assert_eq!(
        sync.log(std::slice::from_ref(&failed)),
        ["helsinki/helsinki-transport: failed: the gateway answered 429"]
    );
    assert!(
        sync.log(&[failed]).is_empty(),
        "the same failure is said once"
    );
    assert_eq!(sync.log(&[published(Outcome::Updated)]).len(), 1);
    assert_eq!(
        sync.log(&[published(Outcome::Updated)]).len(),
        1,
        "every write is said"
    );
    assert_eq!(
        sync.log(&[published(Outcome::Unchanged)]),
        ["helsinki/helsinki-transport: unchanged"]
    );
    assert!(sync.log(&[published(Outcome::Unchanged)]).is_empty());
}

/// A catalogue that answers `package_search` over one organization's datasets, which the
/// in-memory double does not; every other call is the publisher's own shape.
struct Searchable {
    datasets: Vec<Value>,
    deleted: Vec<String>,
}

impl jcctl::publish::ckan::CkanApi for Searchable {
    fn show(
        &self,
        action: &str,
        name: &str,
    ) -> Result<Option<Value>, jcctl::publish::ckan::CkanError> {
        assert_eq!(action, "package_show");
        Ok(self
            .datasets
            .iter()
            .find(|d| d["name"] == name && !self.deleted.iter().any(|gone| gone == name))
            .cloned())
    }

    fn action(
        &mut self,
        action: &str,
        payload: &Value,
    ) -> Result<Value, jcctl::publish::ckan::CkanError> {
        match action {
            "package_search" => {
                assert_eq!(payload["fq"], "organization:\"susr\"", "{payload}");
                assert_eq!(payload["include_private"], true, "{payload}");
                let live: Vec<Value> = self
                    .datasets
                    .iter()
                    .filter(|d| !self.deleted.iter().any(|gone| *gone == d["name"]))
                    .cloned()
                    .collect();
                Ok(json!({ "count": live.len(), "results": live }))
            }
            "package_delete" => {
                self.deleted
                    .push(payload["id"].as_str().unwrap_or_default().to_owned());
                Ok(Value::Null)
            }
            other => panic!("no {other} in a sweep"),
        }
    }
}

fn dataset(name: &str, generated_by: Option<&str>) -> Value {
    let extras: Vec<Value> = generated_by
        .map(|value| json!({ "key": "generated_by", "value": value }))
        .into_iter()
        .collect();
    json!({ "name": name, "organization": { "name": "susr" }, "extras": extras })
}

#[test]
fn a_dataset_the_platform_published_for_an_endpoint_that_is_gone_is_withdrawn_and_a_harvests_is_not(
) {
    // T-4461: susr-zo-krajiny's Endpoint left the seed in the apply that restarted the Portal, so
    // no mirror of it ever held the Endpoint; the catalogue's own mark is what says it was ours.
    let mut api = Searchable {
        datasets: vec![
            dataset("susr-om", Some(jcctl::publish::ckan::GENERATOR)),
            dataset("susr-zo-krajiny", Some(jcctl::publish::ckan::GENERATOR)),
            dataset("harvested-from-nkod", None),
            dataset("someone-elses", Some("ckanext-harvest")),
        ],
        deleted: Vec::new(),
    };
    let kept: BTreeSet<String> = ["susr-om".to_owned()].into();
    let swept = sweep_with(&mut api, "susr", &kept).expect("the sweep runs");
    assert_eq!(
        swept,
        vec![(
            "susr-zo-krajiny".to_owned(),
            Publication::Withdrawn {
                dataset: "susr-zo-krajiny".to_owned()
            }
        )]
    );
    assert_eq!(api.deleted, vec!["susr-zo-krajiny".to_owned()]);

    // The next run finds nothing more to withdraw.
    assert!(sweep_with(&mut api, "susr", &kept)
        .expect("it runs again")
        .is_empty());
}

#[tokio::test]
async fn a_pass_with_a_project_whose_publication_does_not_read_sweeps_nothing() {
    // T-4461 review: project b's broken spec leaves its datasets out of what the pass keeps, so a
    // sweep of the shared default organization would withdraw them. No sweep in such a pass.
    let repository =
        std::env::temp_dir().join(format!("jc-ckan-sweep-guard-{}", std::process::id()));
    std::fs::create_dir_all(&repository).expect("a scratch directory");
    let manifest = |project: &str, kind: &str, name: &str, spec: Value| {
        serde_norway::to_string(&json!({
            "apiVersion": "joinedcontext.com/v1alpha1",
            "kind": kind,
            "metadata": { "name": name, "namespace": project },
            "spec": spec,
        }))
        .expect("yaml")
    };
    std::fs::write(
        repository.join("a.yaml"),
        format!(
            "{}---\n{}",
            manifest("a", "CkanInstance", "hel-fi", instance()),
            manifest(
                "a",
                "Endpoint",
                "bikes",
                endpoint("bikes", "public", Some(dataset_only()))
            )
        ),
    )
    .expect("project a");
    std::fs::write(
        repository.join("b.yaml"),
        manifest(
            "b",
            "Endpoint",
            "parking",
            endpoint(
                "parking",
                "public",
                Some(json!({ "instanceRef": { "kind": "CkanInstance", "name": "nowhere" } })),
            ),
        ),
    )
    .expect("project b");
    let repo = jcctl::loader::Repository::load(&repository).expect("the repository loads");
    let reports = CkanSync::new(HOST)
        .converge(&repo, &Mirror::new(), &repository)
        .await;
    // b's spec is reported, a's dataset is tried (and refused for want of a token), and no
    // sweep line of project a's organization follows.
    assert!(
        reports
            .iter()
            .any(|r| r.project == "b" && r.endpoint.is_empty()),
        "{reports:?}"
    );
    assert!(
        !reports
            .iter()
            .any(|r| r.project == "a" && r.endpoint.is_empty()),
        "{reports:?}"
    );
    std::fs::remove_dir_all(&repository).expect("cleaned up");
}

// T-4717: the prod Portal republished every dataset on every sync, through the public edge, at
// about 1,000 requests a minute; the edge answered 429 and each refusal was retried a tick later.

fn key() -> (String, String) {
    (PROJECT.to_owned(), "air".to_owned())
}

fn published_now() -> Publication {
    Publication::Published {
        dataset: "air".to_owned(),
        outcome: Outcome::Unchanged,
        rows: None,
        no_linkml: false,
    }
}

#[test]
fn an_unchanged_endpoint_is_published_again_only_after_the_refresh() {
    let print = fingerprint(&target("air", "public", dataset_only()), &settings());
    let mut pacing = Pacing::default();
    let now = Instant::now();
    assert!(pacing.due(&key(), print, now), "never published, so due");
    pacing.record(key(), print, &published_now(), now);
    assert!(!pacing.due(&key(), print, now + Duration::from_secs(60)));
    assert!(!pacing.due(&key(), print, now + REFRESH - Duration::from_secs(1)));
    assert!(pacing.due(&key(), print, now + REFRESH));
}

#[test]
fn a_changed_endpoint_is_due_at_once() {
    let before = fingerprint(&target("air", "public", dataset_only()), &settings());
    let after = fingerprint(&target("air", "public", with_sheet()), &settings());
    assert_ne!(before, after);
    assert_eq!(
        before,
        fingerprint(&target("air", "public", dataset_only()), &settings())
    );
    let mut pacing = Pacing::default();
    let now = Instant::now();
    pacing.record(key(), before, &published_now(), now);
    assert!(pacing.due(&key(), after, now + Duration::from_secs(1)));
    // A failing Endpoint the user then fixes is not left waiting out its backoff.
    pacing.record(key(), before, &Publication::Failed("refused".into()), now);
    assert!(pacing.due(&key(), after, now));
}

#[test]
fn a_429_backs_off_from_five_minutes_and_doubles_up_to_an_hour() {
    let print = 7;
    let refused =
        Publication::Failed("CKAN rejected organization_show: 429 Too Many Requests".into());
    let mut pacing = Pacing::default();
    let mut now = Instant::now();
    pacing.record(key(), print, &refused, now);
    assert!(!pacing.due(&key(), print, now + Duration::from_secs(299)));
    assert!(pacing.due(&key(), print, now + Duration::from_secs(300)));
    now += Duration::from_secs(300);
    pacing.record(key(), print, &refused, now);
    assert!(!pacing.due(&key(), print, now + Duration::from_secs(599)));
    assert!(pacing.due(&key(), print, now + Duration::from_secs(600)));
    for _ in 0..10 {
        pacing.record(key(), print, &refused, now);
    }
    assert!(!pacing.due(&key(), print, now + MOST_BACKOFF - Duration::from_secs(1)));
    assert!(pacing.due(&key(), print, now + MOST_BACKOFF));
    // Once it goes through, the next is the ordinary refresh.
    pacing.record(key(), print, &published_now(), now);
    assert!(!pacing.due(&key(), print, now + REFRESH - Duration::from_secs(1)));
    assert!(pacing.due(&key(), print, now + REFRESH));
}

#[test]
fn another_failure_is_tried_again_after_a_minute_and_a_number_containing_429_is_not_a_429() {
    let mut pacing = Pacing::default();
    let now = Instant::now();
    let failed = Publication::Failed("the gateway did not answer: 4290 rows, 502".into());
    pacing.record(key(), 1, &failed, now);
    assert!(!pacing.due(&key(), 1, now + Duration::from_secs(59)));
    assert!(pacing.due(&key(), 1, now + Duration::from_secs(60)));
}

/// A catalogue that only notes when it was called.
struct Clocked(Arc<Mutex<Vec<Instant>>>);

impl jcctl::publish::ckan::CkanApi for Clocked {
    fn show(&self, _: &str, _: &str) -> Result<Option<Value>, jcctl::publish::ckan::CkanError> {
        self.0.lock().expect("calls").push(Instant::now());
        Ok(None)
    }

    fn action(&mut self, _: &str, _: &Value) -> Result<Value, jcctl::publish::ckan::CkanError> {
        self.0.lock().expect("calls").push(Instant::now());
        Ok(Value::Null)
    }
}

#[test]
fn calls_to_the_catalogue_keep_the_gap_across_every_client_of_one_portal() {
    use jcctl::publish::ckan::CkanApi;
    let gap = Duration::from_millis(40);
    let calls = Arc::new(Mutex::new(Vec::new()));
    let last = Arc::new(Mutex::new(None));
    let mut first = Paced::new(Clocked(calls.clone()), last.clone(), gap);
    first.show("package_show", "a").expect("show");
    first.action("package_patch", &json!({})).expect("action");
    // The next Endpoint's client is a new one; the gap is the Portal's, not the client's.
    let second = Paced::new(Clocked(calls.clone()), last, gap);
    second.show("package_show", "b").expect("show");
    let at = calls.lock().expect("calls").clone();
    assert_eq!(at.len(), 3);
    for pair in at.windows(2) {
        assert!(pair[1] - pair[0] >= gap, "{:?}", pair[1] - pair[0]);
    }
    assert_eq!(
        CALL_GAP,
        Duration::from_millis(200),
        "at most five calls a second"
    );
}

#[test]
fn the_gateway_reads_of_each_publication_keep_the_catalogues_pace() {
    // T-4717: prod's edge saw the publisher at 25 requests a second, all from the record, `/ws`,
    // file.csv and schema reads, which went out beside the paced catalogue calls.
    use jcctl::publish::ckan::CkanApi;
    let gap = Duration::from_millis(30);
    let calls = Arc::new(Mutex::new(Vec::new()));
    let last = Arc::new(Mutex::new(None));
    let api = Paced::new(Clocked(calls.clone()), last.clone(), gap);
    let read = || calls.lock().expect("calls").push(Instant::now());
    let endpoints = 3;
    for _ in 0..endpoints {
        api.reads(RECORD_READS, read);
        api.reads(ROWS_READS, read);
    }
    // The next Endpoint's catalogue call, on a client of its own, waits for every read before it.
    Paced::new(Clocked(calls.clone()), last, gap)
        .show("package_show", "next")
        .expect("show");
    let at = calls.lock().expect("calls").clone();
    assert_eq!(at.len(), 2 * endpoints + 1);
    let held = gap * (RECORD_READS + ROWS_READS) * endpoints as u32;
    assert!(
        at[at.len() - 1] - at[0] >= held,
        "{:?} < {held:?}",
        at[at.len() - 1] - at[0]
    );
    assert_eq!(
        (RECORD_READS, ROWS_READS),
        (2, 3),
        "/, /ws; file.csv and two schemas"
    );

    // An Endpoint without a sheet reads no rows: nothing to wait for.
    let before = Instant::now();
    api.reads(0, || ());
    assert!(before.elapsed() < gap);
}
