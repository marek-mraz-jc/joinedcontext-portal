//! An Endpoint that lists a domain-standard representation is checked against its space's model
//! on the write path (EP-125, T-4584, T-4900): the `ical` mapping, the `sdm-event` preset when
//! none is written, must fit the space's model, and the Portal refuses one that does not with
//! `jcctl validate`'s sentences before a Change exists, so the reconciler is never handed an
//! Endpoint jcctl would refuse. The form's dry run answers the same sentences.

mod common;

use axum::http::StatusCode;
use joinedcontext_portal::auth::session::Identity;
use joinedcontext_portal::state::AppState;
use serde_json::{json, Value};
use wiremock::matchers::{method, path};
use wiremock::{Mock, ResponseTemplate};

const PROJECT: &str = "kultura";

/// The Smart Data Models Event, as a space would hold it: `startDate` and `name` required.
const EVENTS: &str = r#"id: https://example.org/models/events
name: events
classes:
  Event:
    slots:
      - name
      - startDate
      - endDate
slots:
  name:
    range: string
    required: true
  startDate:
    range: datetime
    required: true
  endDate:
    range: datetime
"#;

/// A model of the space without the Event type.
const PLACES: &str = r#"id: https://example.org/models/places
name: places
classes:
  PointOfInterest:
    slots:
      - name
slots:
  name:
    range: string
    required: true
"#;

fn admin() -> Identity {
    let mut identity = common::person("admin");
    identity.groups = vec!["portal-approver".to_owned()];
    identity
}

/// The Portal against a forge holding `linkml` as the model of space `podujatia`.
async fn portal(linkml: &str) -> (AppState, wiremock::MockServer) {
    // Deprecated backs a surface like published, without the four artifacts (DM-02, DM-26).
    portal_at(linkml, "deprecated").await
}

/// The Portal with the space's model in `lifecycle`.
async fn portal_at(linkml: &str, lifecycle: &str) -> (AppState, wiremock::MockServer) {
    let gitea = common::forge().await;
    Mock::given(method("GET"))
        .and(path(format!(
            "{}/contents/projects/{PROJECT}/spaces/podujatia/datamodels/model.linkml.yaml",
            common::REPO
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "sha": "sha-linkml-1",
            "content": common::encode(linkml)
        })))
        .mount(&gitea)
        .await;
    let state = common::state_on(&gitea);
    state.mirror.upsert(common::envelope(
        "ContextSpace",
        "podujatia",
        PROJECT,
        json!({ "isSandbox": true }),
    ));
    state.mirror.upsert(common::envelope(
        "DataModel",
        "model",
        PROJECT,
        json!({
            "contextSpaceRef": "podujatia",
            "linkml": "./model.linkml.yaml",
            "version": "1.0.0",
            "lifecycle": lifecycle,
        }),
    ));
    (state, gitea)
}

/// The Endpoint; one that serves `ical` lists one calendar, `vsetky`, over the `sdm-event`
/// preset, as a calendar is served only for a listed output (EP-159, T-5208).
fn endpoint(representations: Value) -> Value {
    let mut manifest = plain_endpoint(representations);
    if manifest["spec"]["enabledRepresentations"]
        .as_array()
        .is_some_and(|served| served.contains(&json!("ical")))
    {
        manifest["spec"]["representations"] = json!({ "ical": [{ "name": "vsetky", "sources": [{ "type": "Event", "preset": "sdm-event" }] }] });
    }
    manifest
}

fn plain_endpoint(representations: Value) -> Value {
    json!({
        "apiVersion": "joinedcontext.com/v1alpha1",
        "kind": "Endpoint",
        "metadata": { "name": "kalendar", "namespace": PROJECT },
        "spec": {
            "contextSpaceRef": { "kind": "ContextSpace", "name": "podujatia" },
            "slug": "si6epqkx364lprho5uaigutk274r5grb",
            "audience": "project-list",
            "allowedProjects": [PROJECT],
            "enabledRepresentations": representations
        }
    })
}

async fn propose(state: &AppState, manifest: Value) -> common::Answer {
    common::checked_send(
        state,
        admin(),
        "POST",
        &format!("/api/v1/projects/{PROJECT}/endpoints"),
        Some(manifest),
    )
    .await
}

#[tokio::test]
async fn ical_on_a_space_without_the_event_type_is_refused_with_jcctl_s_sentence() {
    let (state, gitea) = portal(PLACES).await;
    let answer = propose(&state, endpoint(json!(["ngsi-ld", "ical"]))).await;
    assert_eq!(answer.status, StatusCode::BAD_REQUEST, "{}", answer.text);
    assert!(
        answer.text.contains(
            "Endpoint kultura/kalendar, space podujatia: `ical` output `vsetky` maps the type Event, which the \
             data model does not have (EP-125)"
        ),
        "{}",
        answer.text
    );
    let requests = gitea.received_requests().await.expect("recorded");
    assert!(
        !requests.iter().any(|r| r.method.as_str() == "POST"),
        "no Change was opened"
    );
}

#[tokio::test]
async fn ical_without_a_required_start_names_the_attribute() {
    let optional_start = EVENTS.replacen(
        "  startDate:\n    range: datetime\n    required: true\n",
        "  startDate:\n    range: datetime\n",
        1,
    );
    let (state, _gitea) = portal(&optional_start).await;
    let answer = propose(&state, endpoint(json!(["ical"]))).await;
    assert_eq!(answer.status, StatusCode::BAD_REQUEST, "{}", answer.text);
    assert!(
        answer.text.contains(
            "`ical` output `vsetky` maps DTSTART to `startDate`, which is not a required attribute of Event"
        ),
        "{}",
        answer.text
    );
}

#[tokio::test]
async fn ical_on_the_sdm_event_model_opens_a_change() {
    let (state, _gitea) = portal(EVENTS).await;
    let answer = propose(&state, endpoint(json!(["ngsi-ld", "ical"]))).await;
    assert!(
        answer.status.is_success(),
        "{} {}",
        answer.status,
        answer.text
    );
}

#[tokio::test]
async fn an_endpoint_without_ical_is_not_held_to_the_event_type() {
    let (state, _gitea) = portal(PLACES).await;
    let answer = propose(&state, endpoint(json!(["ngsi-ld", "csv"]))).await;
    assert!(
        answer.status.is_success(),
        "{} {}",
        answer.status,
        answer.text
    );
}

fn mapped(mapping: Value) -> Value {
    let mut manifest = endpoint(json!(["ngsi-ld", "ical"]));
    manifest["spec"]["representations"] = json!({ "ical": { "mapping": mapping } });
    manifest
}

/// A mapping the Endpoint writes is checked field by field: every gap is one line, in the words
/// jc-core gives `jcctl validate`, and the form's dry run shows the same lines.
#[tokio::test]
async fn a_written_mapping_is_refused_per_gap_and_the_dry_run_says_the_same() {
    let (state, gitea) = portal(EVENTS).await;
    let broken = mapped(json!({ "SUMMARY": "name", "DTEND": "name" }));
    let answer = propose(&state, broken.clone()).await;
    assert_eq!(answer.status, StatusCode::BAD_REQUEST, "{}", answer.text);
    let lines = [
        "Endpoint kultura/kalendar, space podujatia: `ical` output `events` maps no DTSTART, which every calendar entry needs (EP-125)",
        "Endpoint kultura/kalendar, space podujatia: `ical` output `events` maps DTEND to `name`, range string; DTEND takes date or datetime (EP-125)",
    ];
    for line in lines {
        assert!(answer.text.contains(line), "{line} in {}", answer.text);
    }
    let dry = common::checked_send(
        &state,
        admin(),
        "POST",
        &format!("/api/v1/projects/{PROJECT}/endpoints?dryRun=All"),
        Some(broken),
    )
    .await;
    for line in lines {
        assert!(
            dry.text.contains(line),
            "{line} in the dry run {}",
            dry.text
        );
    }
    let requests = gitea.received_requests().await.expect("recorded");
    assert!(
        !requests.iter().any(|r| r.method.as_str() == "POST"),
        "no Change was opened"
    );

    let fitting = mapped(
        json!({ "DTSTART": "startDate", "SUMMARY": { "attribute": "name", "truncate": 120 } }),
    );
    let answer = propose(&state, fitting).await;
    assert!(
        answer.status.is_success(),
        "{} {}",
        answer.status,
        answer.text
    );
}

/// T-4886: a draft or retired model backs no domain standard; the fitting Event model is refused
/// until it is published, with the lifecycle named and nothing of the data shown.
#[tokio::test]
async fn ical_on_a_draft_model_is_refused_until_it_is_published() {
    for lifecycle in ["draft", "retired"] {
        let (state, gitea) = portal_at(EVENTS, lifecycle).await;
        let answer = propose(&state, endpoint(json!(["ngsi-ld", "ical"]))).await;
        assert_eq!(answer.status, StatusCode::BAD_REQUEST, "{}", answer.text);
        assert!(
            answer.text.contains(&format!(
                "Endpoint kultura/kalendar: `ical` needs a published data model in space \
                 podujatia; its model is {lifecycle} (EP-125, DM-26)"
            )),
            "{}",
            answer.text
        );
        let requests = gitea.received_requests().await.expect("recorded");
        assert!(!requests.iter().any(|r| r.method.as_str() == "POST"));
    }
}

#[tokio::test]
async fn a_draft_model_does_not_hold_back_an_endpoint_without_a_domain_standard() {
    let (state, _gitea) = portal_at(PLACES, "draft").await;
    let answer = propose(&state, endpoint(json!(["ngsi-ld", "csv"]))).await;
    assert!(
        answer.status.is_success(),
        "{} {}",
        answer.status,
        answer.text
    );
}
