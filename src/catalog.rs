//! An Endpoint's catalogue block at the Portal's door (T-2789, EP-80).
//!
//! The contact point of a DCAT-AP record is published to everyone who reads the record, and a
//! harvester copies it into every catalogue downstream. It is a role address, an open-data
//! desk, never a person's own inbox. jc-core checks that it is an address; whether it belongs to
//! a person is something only the Portal knows, from the people its manifests name.

use std::collections::BTreeSet;

use serde_json::Value;

use crate::auth::session::Identity;
use crate::error::ApiError;
use crate::permissions::ORG_NAMESPACE;
use crate::store::{ListOptions, Mirror};

/// Refuses an Endpoint whose `spec.catalog.contactPoint.email` is a person the Portal knows:
/// the proposer, anyone a Group or a RoleBinding names, or a personal contact of the
/// Organization (EP-80).
pub fn check_contact(
    mirror: &Mirror,
    identity: &Identity,
    kind: &str,
    spec: &Value,
) -> Result<(), ApiError> {
    if kind != "Endpoint" {
        return Ok(());
    }
    let Some(email) = spec
        .pointer("/catalog/contactPoint/email")
        .and_then(Value::as_str)
    else {
        return Ok(());
    };
    if people(mirror, identity).contains(&email.trim().to_lowercase()) {
        return Err(ApiError::BadRequest(format!(
            "spec.catalog.contactPoint.email '{email}' is a person's own address, and the record \
             publishes it to everyone who reads it; name the organization's open-data desk or \
             another role address (EP-80)"
        )));
    }
    Ok(())
}

/// Every address the Portal knows to be one person's, lowercased.
fn people(mirror: &Mirror, identity: &Identity) -> BTreeSet<String> {
    let mut people: BTreeSet<String> = [identity.email.as_deref(), Some(&identity.username)]
        .into_iter()
        .flatten()
        .filter(|address| address.contains('@'))
        .map(str::to_lowercase)
        .collect();
    let mut namespaces = mirror.namespaces();
    namespaces.push(ORG_NAMESPACE.to_owned());
    for namespace in &namespaces {
        for (kind, list, member) in [
            ("Group", "/members", "user"),
            ("RoleBinding", "/subjects", "user"),
            ("Organization", "/contacts", "email"),
        ] {
            for envelope in mirror.list(namespace, kind, &ListOptions::default()).items {
                for entry in envelope
                    .spec
                    .pointer(list)
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    // The open-data desk is the one contact of the Organization meant to be named.
                    if entry.get("role").and_then(Value::as_str) == Some("open-data") {
                        continue;
                    }
                    if let Some(address) = entry.get(member).and_then(Value::as_str) {
                        people.insert(address.trim().to_lowercase());
                    }
                }
            }
        }
    }
    people
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resource::{ObjectMeta, ResourceEnvelope, API_VERSION};
    use serde_json::json;

    fn envelope(kind: &str, name: &str, namespace: &str, spec: Value) -> ResourceEnvelope {
        ResourceEnvelope {
            api_version: API_VERSION.to_owned(),
            kind: kind.to_owned(),
            metadata: ObjectMeta::new(name, namespace),
            spec,
            status: None,
        }
    }

    fn identity(email: &str) -> Identity {
        Identity {
            client: None,
            subject: "0f6c".to_owned(),
            username: email.to_owned(),
            email: Some(email.to_owned()),
            name: Some("Aino".to_owned()),
            roles: Vec::new(),
            groups: Vec::new(),
        }
    }

    fn mirror() -> Mirror {
        let mirror = Mirror::new();
        mirror.upsert(envelope(
            "Group",
            "stewards",
            ORG_NAMESPACE,
            json!({ "members": [{ "user": "Jana.Novak@city.example.org" }] }),
        ));
        mirror.upsert(envelope(
            "RoleBinding",
            "air-stewards",
            "ovzdusie",
            json!({ "roleRef": { "name": "steward" }, "subjects": [{ "user": "peter@city.example.org" }] }),
        ));
        mirror.upsert(envelope(
            "Organization",
            "city",
            ORG_NAMESPACE,
            json!({ "contacts": [
                { "role": "data-protection", "name": "Eva Dpo", "email": "eva@city.example.org" },
                { "role": "open-data", "name": "Open data", "email": "opendata@city.example.org" }
            ] }),
        ));
        mirror
    }

    fn endpoint(email: &str) -> Value {
        json!({ "catalog": { "contactPoint": { "name": "Desk", "email": email } } })
    }

    #[test]
    fn a_member_the_proposer_or_a_personal_contact_is_refused_with_the_field_named() {
        let mirror = mirror();
        let aino = identity("aino@city.example.org");
        for person in [
            "jana.novak@city.example.org",
            "peter@city.example.org",
            "eva@city.example.org",
            "AINO@city.example.org",
        ] {
            let refusal =
                check_contact(&mirror, &aino, "Endpoint", &endpoint(person)).expect_err(person);
            assert!(
                refusal
                    .to_string()
                    .contains("spec.catalog.contactPoint.email"),
                "{refusal}"
            );
        }
    }

    #[test]
    fn the_open_data_desk_and_an_unknown_role_address_pass() {
        let mirror = mirror();
        let aino = identity("aino@city.example.org");
        for desk in ["opendata@city.example.org", "data@city.example.org"] {
            check_contact(&mirror, &aino, "Endpoint", &endpoint(desk)).expect(desk);
        }
    }

    #[test]
    fn an_endpoint_without_a_contact_and_another_kind_pass() {
        let mirror = mirror();
        let aino = identity("aino@city.example.org");
        check_contact(&mirror, &aino, "Endpoint", &json!({})).expect("no catalog");
        check_contact(&mirror, &aino, "Group", &endpoint("aino@city.example.org"))
            .expect("not an endpoint");
    }
}
