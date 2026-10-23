//! Checking a KPI over several sources (API/01 §55, PL-102…PL-105, T-4935): jc-core's rules with
//! the field at fault, each source's readability for the pipeline's account, and the preview on
//! the sources' current pages read as the person.

mod common;

use std::path::Path;
use std::sync::Arc;

use axum::http::StatusCode;
use serde_json::{json, Value};
use wiremock::matchers::{method, path, path_regex, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

use common::{envelope, person, send};
use joinedcontext_portal::config::Config;
use joinedcontext_portal::permissions::ORG_NAMESPACE;
use joinedcontext_portal::reconciler::views::ViewSync;
use joinedcontext_portal::state::AppState;

const PARKING: &str = "p4y7pq2mzt6vhx3nbwrs5cjdaf";
const STOPS: &str = "s3nq7pzk2mtv6hx5brj4gcdsfa";
const SECRET: &str = "x7nq7pzk2mtv6hx5brj4gcdsfa";
const TOKEN: &str = "an-admin-token-of-at-least-32-bytes!";
const ROUTE: &str = "/api/v1/projects/city/kpis/check";

/// The spaces `mobility` (parking and stops) and `secret` of `city`, as the reconciler reads them.
fn repository(dir: &Path) -> jcctl::loader::Repository {
    let write = |rel: &str, body: String| {
        let path = dir.join(rel);
        std::fs::create_dir_all(path.parent().expect("a parent")).expect("mkdir");
        std::fs::write(path, body).expect("write");
    };
    let head = |kind: &str, name: &str| {
        format!("apiVersion: joinedcontext.com/v1alpha1\nkind: {kind}\nmetadata:\n  name: {name}\n  namespace: city\nspec:\n")
    };
    for space in ["mobility", "secret"] {
        write(
            &format!("projects/city/spaces/{space}/space.yaml"),
            format!("{}  isSandbox: false\n", head("ContextSpace", space)),
        );
    }
    for (space, name, slug) in [
        ("mobility", "parking", PARKING),
        ("mobility", "stops", STOPS),
        ("secret", "hidden", SECRET),
    ] {
        write(
            &format!("projects/city/spaces/{space}/endpoints/{name}.yaml"),
            format!("{}  contextSpaceRef: {space}\n  slug: {slug}\n  audience: organization\n  enabledRepresentations: [ngsi-ld]\n", head("Endpoint", name)),
        );
    }
    write(
        "projects/city/spaces/mobility/policies/read.yaml",
        format!("{}  contextSpaceRef: mobility\n  assigner: did:web:city.example\n  assignee: {{ kind: role, id: public }}\n  operations: [retrieveOps]\n  information:\n    - entities: [{{ type: ParkingSite }}, {{ type: TransitStop }}]\n      propertyNames: [occupied, district]\n", head("Policy", "read")),
    );
    jcctl::loader::Repository::load(dir).expect("the repository loads")
}

/// A broker whose parking page has districts A (10 + 5 occupied) and B (6), and whose stops
/// page has two stops in A and one in B.
async fn broker() -> MockServer {
    let broker = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/q/views"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .mount(&broker)
        .await;
    let row = |id: &str, district: &str, occupied: Option<u32>| {
        let mut row = json!({ "id": id, "type": "T",
            "district": { "type": "Property", "value": district } });
        if let Some(n) = occupied {
            row["occupied"] = json!({ "type": "Property", "value": n });
        }
        row
    };
    for (entity_type, rows) in [
        (
            "ParkingSite",
            vec![
                row("p1", "A", Some(10)),
                row("p2", "A", Some(5)),
                row("p3", "B", Some(6)),
            ],
        ),
        (
            "TransitStop",
            vec![
                row("s1", "A", None),
                row("s2", "A", None),
                row("s3", "B", None),
            ],
        ),
    ] {
        Mock::given(method("POST"))
            .and(path_regex("^/q/views/[a-z0-9-]+/preview$"))
            .and(query_param("type", entity_type))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({ "count": 3, "entities": rows })),
            )
            .mount(&broker)
            .await;
    }
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&broker)
        .await;
    Mock::given(method("PUT"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&broker)
        .await;
    broker
}

struct Rig {
    state: AppState,
    broker: MockServer,
}

/// jana may propose pipelines in `city` and read its space `mobility`; eva only reads it. The
/// pipeline `kpi`'s account holds a read grant on TransitStop.
async fn rig() -> Rig {
    let broker = broker().await;
    let mut state = AppState::new(Config::for_tests(), None);
    for space in ["mobility", "secret"] {
        state
            .mirror
            .upsert(envelope("ContextSpace", space, "city", json!({})));
    }
    for (space, name, slug) in [
        ("mobility", "parking", PARKING),
        ("mobility", "stops", STOPS),
        ("secret", "hidden", SECRET),
    ] {
        state.mirror.upsert(envelope(
            "Endpoint",
            name,
            "city",
            json!({ "contextSpaceRef": space, "slug": slug, "audience": "organization" }),
        ));
    }
    state.mirror.upsert(envelope(
        "Policy",
        "pl-kpi-stops",
        "city",
        json!({ "contextSpaceRef": "mobility", "operations": ["retrieveOps"],
                "assignee": { "kind": "serviceAccount", "id": "city/pl-kpi" },
                "information": [{ "entities": [{ "type": "TransitStop" }] }] }),
    ));
    for (role, rules) in [
        (
            "pipeline-author",
            json!([{ "kinds": ["Project"], "verbs": ["read"] },
                   { "kinds": ["Pipeline"], "verbs": ["read", "propose"] }]),
        ),
        (
            "space-reader",
            json!([{ "kinds": ["ContextSpace", "Project"], "verbs": ["read"] }]),
        ),
    ] {
        state.mirror.upsert(envelope(
            "Role",
            role,
            ORG_NAMESPACE,
            json!({ "rules": rules }),
        ));
    }
    // jana proposes pipelines anywhere in the project and reads only the space `mobility`.
    for (name, who, role, scope) in [
        (
            "jana-pipelines",
            "jana",
            "pipeline-author",
            json!({ "project": "city" }),
        ),
        (
            "jana-mobility",
            "jana",
            "space-reader",
            json!({ "contextSpace": "mobility" }),
        ),
        (
            "eva-mobility",
            "eva",
            "space-reader",
            json!({ "contextSpace": "mobility" }),
        ),
    ] {
        state.mirror.upsert(envelope(
            "RoleBinding",
            name,
            ORG_NAMESPACE,
            json!({ "subjects": [{ "user": format!("{who}@hel.fi") }], "role": role, "scope": scope }),
        ));
    }
    let dir = std::env::temp_dir().join(format!(
        "portal-kpi-check-{}-{:?}",
        std::process::id(),
        std::time::SystemTime::now()
    ));
    let token = dir.join("token");
    let repo = repository(&dir);
    std::fs::write(&token, format!("{TOKEN}\n")).expect("write the token");
    let views = ViewSync::new(broker.uri(), &token);
    views.converge(&repo).await;
    state.views = Some(Arc::new(views));
    Rig { state, broker }
}

fn draft(formula: &str, second: &str) -> Value {
    json!({ "pipeline": {
        "apiVersion": "joinedcontext.com/v1alpha2", "kind": "Pipeline",
        "metadata": { "name": "kpi" },
        "spec": {
            "class": "scheduled", "schedule": "0 * * * *",
            "sources": [
                { "name": "parking", "endpointRef": { "kind": "Endpoint", "name": "parking" },
                  "query": { "type": "ParkingSite", "attrs": ["occupied", "district"] } },
                { "name": "stops", "endpointRef": { "kind": "Endpoint", "name": second },
                  "query": { "type": "TransitStop", "attrs": ["district"] } }
            ],
            "steps": [{ "kind": "kpi", "kpi": {
                "name": "parking-per-stop", "formula": formula, "unitCode": "C62",
                "join": { "by": "area", "keys": { "parking": "district", "stops": "district" } } } }],
            "outputs": [{ "targetEndpoint": "urn:ngsi-ld:Endpoint:hel.fi:city-kpi:kpi-writer" }]
        }
    }, "preview": true })
}

async fn previews(broker: &MockServer) -> usize {
    broker
        .received_requests()
        .await
        .unwrap_or_default()
        .iter()
        .filter(|request| request.url.path().ends_with("/preview"))
        .count()
}

/// PL-104, PL-105: one value per district both sources have, computed on the pages the person
/// reads; the stops source is readable by the pipeline's grant, parking is not yet.
#[tokio::test]
async fn a_valid_draft_previews_one_value_per_area() {
    let r = rig().await;
    let answer = send(
        &r.state,
        person("jana"),
        "POST",
        ROUTE,
        Some(draft("sum(parking.occupied) / count(stops)", "stops")),
    )
    .await;
    assert_eq!(answer.status, StatusCode::OK, "{}", answer.text);
    let body: Value = serde_json::from_str(&answer.text).expect("JSON");
    assert_eq!(body["problems"], json!([]));
    assert_eq!(
        body["sources"],
        json!([
            { "name": "parking", "endpoint": "parking", "readable": false },
            { "name": "stops", "endpoint": "stops", "readable": true }
        ])
    );
    assert_eq!(
        body["preview"],
        json!({
            "values": [
                { "key": "A", "name": "parking-per-stop-a", "value": 7.5 },
                { "key": "B", "name": "parking-per-stop-b", "value": 6.0 }
            ],
            "rows": { "parking": 3, "stops": 3 }
        })
    );
}

/// PL-103: a formula naming an attribute the source does not read is refused at its field, in
/// words, and nothing is read from the broker.
#[tokio::test]
async fn a_refused_formula_names_its_field_and_reads_nothing() {
    let r = rig().await;
    let answer = send(
        &r.state,
        person("jana"),
        "POST",
        ROUTE,
        Some(draft("sum(parking.free) / count(stops)", "stops")),
    )
    .await;
    assert_eq!(answer.status, StatusCode::OK, "{}", answer.text);
    let body: Value = serde_json::from_str(&answer.text).expect("JSON");
    let problems = body["problems"].as_array().expect("problems");
    assert_eq!(problems.len(), 1, "{problems:?}");
    assert!(
        problems[0]["field"]
            .as_str()
            .is_some_and(|f| f.starts_with("spec.")),
        "{problems:?}"
    );
    assert!(
        problems[0]["reason"]
            .as_str()
            .is_some_and(|r| r.contains("free")),
        "{problems:?}"
    );
    assert!(body.get("preview").is_none());
    assert_eq!(previews(&r.broker).await, 0);
}

/// SP-06: a source in a space the person does not read is an unknown Endpoint, the same words
/// as one that is not there, and the broker is never asked.
#[tokio::test]
async fn a_source_in_an_unread_space_is_unknown() {
    let r = rig().await;
    let hidden = send(
        &r.state,
        person("jana"),
        "POST",
        ROUTE,
        Some(draft("sum(parking.occupied) / count(stops)", "hidden")),
    )
    .await;
    let absent = send(
        &r.state,
        person("jana"),
        "POST",
        ROUTE,
        Some(draft("sum(parking.occupied) / count(stops)", "absent")),
    )
    .await;
    let body = |text: &str| serde_json::from_str::<Value>(text).expect("JSON")["problems"].clone();
    assert_eq!(hidden.status, StatusCode::OK, "{}", hidden.text);
    assert_eq!(
        body(&hidden.text),
        json!([{ "field": "spec.sources[1].endpointRef",
                 "reason": "no Endpoint 'hidden' in project 'city' that you may read" }])
    );
    assert_eq!(
        body(&absent.text)[0]["reason"],
        "no Endpoint 'absent' in project 'city' that you may read"
    );
    assert_eq!(previews(&r.broker).await, 0);
}

/// PF-52: a reader who may not propose a pipeline is refused before anything is read; a workload
/// token's 403 is the authorization matrix's service-account cell (tests/authz_matrix.yaml).
#[tokio::test]
async fn only_a_person_who_may_propose_checks() {
    let r = rig().await;
    let reader = send(
        &r.state,
        person("eva"),
        "POST",
        ROUTE,
        Some(draft("count(stops)", "stops")),
    )
    .await;
    assert_eq!(reader.status, StatusCode::FORBIDDEN, "{}", reader.text);
    assert_eq!(previews(&r.broker).await, 0);
}
