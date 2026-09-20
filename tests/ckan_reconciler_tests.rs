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

use jcctl::commands::publish_ckan::Target;
use jcctl::loader::{RawManifest, RawMetadata, ResourceId};
use jcctl::publish::ckan::{InMemoryCkan, Outcome, Settings};
use joinedcontext_portal::reconciler::ckan::{
    publish_with, withdrawn, CkanSync, Publication, Report,
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
const ROWS: &str = "id,name,available\nurn:ngsi-ld:BikeStation:hel.fi:bikes:1,Rautatientori,12\nurn:ngsi-ld:BikeStation:hel.fi:bikes:2,Kamppi,4\n";

#[test]
fn an_endpoint_becomes_a_dataset_with_the_sheet_it_declares() {
    let mut api = InMemoryCkan::new().with_token(TOKEN);
    let target = target("helsinki-bikes", "public", with_sheet());

    let published = publish_with(&mut api, &target, &record(), Some(ROWS), &settings())
        .expect("the endpoint publishes");
    let Publication::Published {
        dataset,
        outcome,
        rows,
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
    publish_with(&mut api, &target, &record(), Some(ROWS), &settings()).expect("the first run");

    let fewer = "id,name,available\nurn:ngsi-ld:BikeStation:hel.fi:bikes:2,Kamppi,4\n";
    let second = publish_with(&mut api, &target, &record(), Some(fewer), &settings())
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
    let published =
        publish_with(&mut api, &target, &record(), Some(ROWS), &settings()).expect("it publishes");

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
    publish_with(&mut api, &target, &record(), Some(ROWS), &settings()).expect("it publishes");
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
