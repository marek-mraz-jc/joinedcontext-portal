//! Edge cases of `agents::share` (T-2349, T-2350, EP-72, PF-51, PF-57): a manifest the mirror
//! holds is data the repository wrote, not a shape this module may assume, and the fields a
//! person dictates to the assistant are normalised once, the same way `edit` normalises them.
use joinedcontext_portal::agents::share::{
    edit, render, EditEndpoint, ProposeEndpoint, RateLimits, MAX_REQUESTS_PER_MINUTE,
};
use joinedcontext_portal::resource::API_VERSION;
use serde_json::{json, Value};

fn endpoint_with(spec: Value) -> Value {
    json!({
        "apiVersion": API_VERSION,
        "kind": "Endpoint",
        "metadata": { "name": "bikes", "namespace": "helsinki" },
        "spec": spec,
    })
}

fn widen() -> EditEndpoint {
    EditEndpoint {
        name: "bikes".to_owned(),
        allowed_projects: Some(vec!["transport".to_owned()]),
        ..Default::default()
    }
}

/// PF-57: a manifest whose spec is not an object is bad data, not a crash.
#[test]
fn an_endpoint_whose_spec_is_not_an_object_is_refused_and_does_not_panic() {
    let endpoints = vec![endpoint_with(json!("not an object"))];
    let refused = edit(&endpoints, &widen()).expect_err("bad data is an error, not a panic");
    assert!(refused.contains("bikes"), "{refused}");
    assert!(refused.contains("spec"), "{refused}");
}

/// PF-57: the same for a spec that parsed as a list.
#[test]
fn an_endpoint_whose_spec_is_a_list_is_refused_and_does_not_panic() {
    let endpoints = vec![endpoint_with(json!([1, 2, 3]))];
    let refused = edit(&endpoints, &widen()).expect_err("bad data is an error, not a panic");
    assert!(refused.contains("spec"), "{refused}");
}

/// PF-57: a manifest with no spec at all is refused with the same sentence.
#[test]
fn an_endpoint_with_no_spec_is_refused_and_does_not_panic() {
    let endpoints = vec![json!({
        "apiVersion": API_VERSION,
        "kind": "Endpoint",
        "metadata": { "name": "bikes", "namespace": "helsinki" },
    })];
    let refused = edit(&endpoints, &widen()).expect_err("bad data is an error, not a panic");
    assert!(refused.contains("spec"), "{refused}");
}

/// PF-57: `edit` writes the title into `metadata`, so that shape is checked too.
#[test]
fn an_endpoint_whose_metadata_is_not_an_object_is_refused_and_does_not_panic() {
    let endpoints = vec![json!({
        "apiVersion": API_VERSION,
        "kind": "Endpoint",
        "metadata": "helsinki/bikes",
        "spec": { "audience": "project-list", "allowedProjects": ["water"] },
    })];
    // No endpoint of that name can be found at all when metadata is unreadable: the answer
    // still names the project's endpoints rather than panicking.
    let refused = edit(&endpoints, &widen()).expect_err("bad data is an error, not a panic");
    assert!(refused.contains("bikes"), "{refused}");
}

/// PF-57: `projection` is written into by an edit that hides attributes.
#[test]
fn an_endpoint_whose_projection_is_not_an_object_is_refused_and_does_not_panic() {
    let endpoints = vec![endpoint_with(json!({
        "audience": "project-list",
        "allowedProjects": ["water"],
        "enabledRepresentations": ["ngsi-ld"],
        "projection": "hide everything",
    }))];
    let params = EditEndpoint {
        name: "bikes".to_owned(),
        hidden_attributes: Some(vec!["maintenanceNotes".to_owned()]),
        ..Default::default()
    };
    let refused = edit(&endpoints, &params).expect_err("bad data is an error, not a panic");
    assert!(refused.contains("projection"), "{refused}");
}

/// PF-57: and `rateLimits` by an edit that sets a rate.
#[test]
fn an_endpoint_whose_rate_limits_are_not_an_object_is_refused_and_does_not_panic() {
    let endpoints = vec![endpoint_with(json!({
        "audience": "project-list",
        "allowedProjects": ["water"],
        "enabledRepresentations": ["ngsi-ld"],
        "rateLimits": 60,
    }))];
    let params = EditEndpoint {
        name: "bikes".to_owned(),
        requests_per_minute: Some(120),
        ..Default::default()
    };
    let refused = edit(&endpoints, &params).expect_err("bad data is an error, not a panic");
    assert!(refused.contains("rateLimits"), "{refused}");
}

/// EP-72: one assignee, one Policy — a project the person named twice is one project.
#[test]
fn a_repeated_project_renders_one_policy_and_one_group() {
    let params = ProposeEndpoint {
        context_space: "city".to_owned(),
        name: "bike-share".to_owned(),
        allowed_projects: vec!["transport".to_owned(), "transport".to_owned()],
        ..Default::default()
    };
    let proposal = render("helsinki", "helsinki.fi", &params, &[]).expect("renders");
    assert_eq!(proposal.policies.len(), 1, "{:?}", proposal.policies);
    assert_eq!(proposal.groups.len(), 1, "{:?}", proposal.groups);
    assert_eq!(
        proposal.endpoint["spec"]["allowedProjects"],
        json!(["transport"])
    );
    assert_eq!(proposal.prefill["allowedProjects"], json!(["transport"]));
}

/// EP-72: the order the person wrote survives the dedup.
#[test]
fn deduplicating_projects_keeps_the_order_the_person_wrote() {
    let params = ProposeEndpoint {
        context_space: "city".to_owned(),
        name: "bike-share".to_owned(),
        allowed_projects: vec![
            "water".to_owned(),
            "transport".to_owned(),
            "water".to_owned(),
        ],
        ..Default::default()
    };
    let proposal = render("helsinki", "helsinki.fi", &params, &[]).expect("renders");
    assert_eq!(
        proposal.endpoint["spec"]["allowedProjects"],
        json!(["water", "transport"])
    );
}

/// EP-72: a representation named twice is served once.
#[test]
fn a_repeated_representation_is_rendered_once() {
    let params = ProposeEndpoint {
        context_space: "city".to_owned(),
        name: "bike-share".to_owned(),
        allowed_projects: vec!["transport".to_owned()],
        representations: vec!["ngsi-ld".to_owned(), "ngsi-ld".to_owned()],
        ..Default::default()
    };
    let proposal = render("helsinki", "helsinki.fi", &params, &[]).expect("renders");
    assert_eq!(
        proposal.endpoint["spec"]["enabledRepresentations"],
        json!(["ngsi-ld"])
    );
}

/// EP-72: two labels of 63 characters do not make a third one; the refusal names both halves.
#[test]
fn a_policy_name_longer_than_a_label_is_refused_with_both_halves() {
    let name = "b".repeat(63);
    let project = "t".repeat(63);
    let params = ProposeEndpoint {
        context_space: "city".to_owned(),
        name: name.clone(),
        allowed_projects: vec![project.clone()],
        ..Default::default()
    };
    let refused = render("helsinki", "helsinki.fi", &params, &[]).expect_err("127 is not a label");
    assert!(refused.contains(&name), "{refused}");
    assert!(refused.contains(&project), "{refused}");
    assert!(refused.contains("63"), "{refused}");
}

/// EP-72: the bound `edit` enforces is the bound a share enforces.
#[test]
fn a_share_refuses_the_rate_edit_refuses() {
    let params = ProposeEndpoint {
        context_space: "city".to_owned(),
        name: "bike-share".to_owned(),
        allowed_projects: vec!["transport".to_owned()],
        rate_limits: Some(RateLimits {
            requests_per_minute: u32::MAX,
            burst: None,
        }),
        ..Default::default()
    };
    let refused = render("helsinki", "helsinki.fi", &params, &[])
        .expect_err("u32::MAX requests a minute is not a rate");
    assert!(
        refused.contains(&MAX_REQUESTS_PER_MINUTE.to_string()),
        "{refused}"
    );
}
