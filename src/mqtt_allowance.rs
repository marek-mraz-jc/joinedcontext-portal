//! What a project may run as MQTT edge brokers, and what its brokers use of it (PF-117…PF-119,
//! ADR-N-048 §2.9–§2.11).
//!
//! The allowance is the Project's own `spec.quotas.mqtt` when it has one, else the
//! Organization's `spec.limits.mqtt`, else off. Usage is counted from the committed `MqttBroker`
//! manifests, not from connected devices, so the refusal happens before a `Change` exists on
//! every door, and the reconciler judges the same numbers before it renders.

use jc_core::kinds::{MqttAllowance, MqttBrokerSpec, MqttUsage};
use serde_json::Value;

use crate::api::organization_limits::LimitOrigin;
use crate::error::ApiError;
use crate::permissions::ORG_NAMESPACE;
use crate::store::{ListOptions, Mirror};

/// The allowance in force for `project` and where it comes from.
pub fn effective(mirror: &Mirror, project: &str) -> (MqttAllowance, LimitOrigin) {
    let read = |spec: &Value, pointer: &str| {
        serde_json::from_value::<MqttAllowance>(spec.pointer(pointer)?.clone()).ok()
    };
    if let Some(own) = mirror
        .get(ORG_NAMESPACE, "Project", project)
        .and_then(|project| read(&project.spec, "/quotas/mqtt"))
    {
        return (own, LimitOrigin::Project);
    }
    mirror
        .list(ORG_NAMESPACE, "Organization", &ListOptions::default())
        .items
        .into_iter()
        .find_map(|organization| read(&organization.spec, "/limits/mqtt"))
        .map_or((MqttAllowance::default(), LimitOrigin::Default), |org| {
            (org, LimitOrigin::Organization)
        })
}

/// The project's brokers whose manifest reads, sorted by name.
pub fn brokers(mirror: &Mirror, project: &str) -> Vec<(String, MqttBrokerSpec)> {
    let mut brokers: Vec<(String, MqttBrokerSpec)> = mirror
        .list(project, "MqttBroker", &ListOptions::default())
        .items
        .into_iter()
        .filter_map(|envelope| {
            let spec = serde_json::from_value(envelope.spec).ok()?;
            Some((envelope.metadata.name, spec))
        })
        .collect();
    brokers.sort_by(|a, b| a.0.cmp(&b.0));
    brokers
}

/// What the project's brokers use, leaving out `except`.
pub fn usage(brokers: &[(String, MqttBrokerSpec)], except: Option<&str>) -> MqttUsage {
    let mut used = MqttUsage::default();
    for (_, spec) in brokers
        .iter()
        .filter(|(name, _)| Some(name.as_str()) != except)
    {
        used.add(spec);
    }
    used
}

/// Refuses the broker `name` that would pass what the project's allowance leaves, naming the
/// limit, the usage and who can raise it (PF-101). A deletion is never checked; a spec that does
/// not read was refused by its kind's own check before.
pub fn check(mirror: &Mirror, project: &str, name: &str, spec: &Value) -> Result<(), ApiError> {
    let Ok(spec) = serde_json::from_value::<MqttBrokerSpec>(spec.clone()) else {
        return Ok(());
    };
    let (allowance, _) = effective(mirror, project);
    let brokers = brokers(mirror, project);
    let previous = brokers
        .iter()
        .find(|(held, _)| held == name)
        .map(|(_, spec)| spec);
    match allowance.refusal(project, &usage(&brokers, Some(name)), &spec, previous) {
        Some(reason) => Err(ApiError::Denied(reason)),
        None => Ok(()),
    }
}

/// The checks of this module a proposal of `envelope` passes on every door (step 4b-mqtt of
/// the verdict); a deletion is never checked.
pub fn check_manifest(
    state: &crate::state::AppState,
    identity: &crate::auth::session::Identity,
    project: &str,
    envelope: &crate::resource::ResourceEnvelope,
) -> Result<(), ApiError> {
    let name = &envelope.metadata.name;
    match envelope.kind.as_str() {
        "MqttBroker" => {
            check_accounts(state, identity, project, &envelope.spec)?;
            check(&state.mirror, project, name, &envelope.spec)
        }
        "Project" => check_project(state, identity, name, &envelope.spec),
        _ => Ok(()),
    }
}

/// Refuses a role naming an account the caller may not read in the same words as one that is not
/// there (T-5590): the form offers only the accounts the caller's list holds, and a name sent past
/// it neither reaches an account they cannot see nor tells them it exists. An account that is not
/// there is left to the reference check (MF-13), which also knows the Change that creates it.
fn check_accounts(
    state: &crate::state::AppState,
    identity: &crate::auth::session::Identity,
    project: &str,
    spec: &Value,
) -> Result<(), ApiError> {
    let effective = crate::permissions::for_request(state, identity, project);
    let roles = spec.get("roles").and_then(Value::as_array);
    for (i, role) in roles.into_iter().flatten().enumerate() {
        let accounts = role.get("serviceAccounts").and_then(Value::as_array);
        for (j, name) in accounts.into_iter().flatten().enumerate() {
            let Some(name) = name.as_str() else { continue };
            let Some(account) = state.mirror.get(project, "ServiceAccount", name) else {
                continue;
            };
            let readable = serde_json::to_value(&account)
                .is_ok_and(|manifest| effective.may_read_manifest("ServiceAccount", &manifest));
            if !readable {
                let missing = crate::references::Missing {
                    path: format!("spec.roles[{i}].serviceAccounts[{j}]"),
                    kind: "ServiceAccount".to_owned(),
                    name: name.to_owned(),
                };
                return Err(crate::references::refusal(project, &missing));
            }
        }
    }
    Ok(())
}

/// The MQTT rows of a project on the organization limits page (API/01 §46): `(dimension,
/// limit, used)`, and whether the project's own `spec.quotas.mqtt` sets them.
pub fn quota_rows(mirror: &Mirror, project: &str) -> (Vec<(&'static str, u32, u32)>, bool) {
    let (allowance, origin) = effective(mirror, project);
    let used = usage(&brokers(mirror, project), None);
    let clamp = |n: u64| u32::try_from(n).unwrap_or(u32::MAX);
    let rows = vec![
        ("mqttBrokers", allowance.limit("brokers"), used.brokers),
        (
            "mqttConnections",
            allowance.limit("connections"),
            clamp(used.connections),
        ),
        (
            "mqttMessagesPerSecond",
            allowance.limit("messagesPerSecond"),
            clamp(used.messages_per_second),
        ),
    ];
    (rows, origin == LimitOrigin::Project)
}

/// Refuses a change of a Project's `spec.quotas.mqtt` by anybody but an org admin, since the
/// allowance is the organization's to give whatever the caller's verbs on `Project` (PF-117),
/// and a number outside the operator's bound (PF-97).
fn check_project(
    state: &crate::state::AppState,
    identity: &crate::auth::session::Identity,
    project_name: &str,
    spec: &Value,
) -> Result<(), ApiError> {
    let stored = state
        .mirror
        .get(ORG_NAMESPACE, "Project", project_name)
        .and_then(|project| project.spec.pointer("/quotas/mqtt").cloned());
    let asked = spec.pointer("/quotas/mqtt");
    if asked == stored.as_ref() {
        return Ok(());
    }
    crate::permissions::require_organization_admin(state, identity, "changing spec.quotas.mqtt")?;
    let Some(Ok(allowance)) = asked.map(|v| serde_json::from_value::<MqttAllowance>(v.clone()))
    else {
        return Ok(());
    };
    state
        .config
        .organization_bounds
        .check_mqtt(&allowance, "spec.quotas.mqtt")
        .map_err(|e| {
            ApiError::BadRequest(format!(
                "{e}; the operator moves the bound in the deployment \
                 (portal.organizationBounds), never the Portal (PF-97)"
            ))
        })
}

/// Which broker holds each dedicated port of the project, by name order (API/01 §47).
pub fn ports_in_use(brokers: &[(String, MqttBrokerSpec)]) -> Vec<(u16, String)> {
    brokers
        .iter()
        .filter_map(|(name, spec)| Some((spec.port?, name.clone())))
        .collect()
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

    pub(crate) fn broker(connections: u32) -> Value {
        json!({
            "roles": [{"name": "camera", "serviceAccounts": ["cam"], "publish": ["cams/${clientid}/#"]}],
            "limits": {"maxConnections": connections, "messagesPerSecond": 1}
        })
    }

    fn holding(org: Option<Value>, own: Option<Value>, brokers: &[(&str, u32)]) -> Mirror {
        let mirror = Mirror::new();
        if let Some(org) = org {
            mirror.upsert(envelope(
                "Organization",
                "hel",
                ORG_NAMESPACE,
                json!({"domain": "hel.fi", "limits": {"mqtt": org}}),
            ));
        }
        let mut project = json!({"organizationRef": {"name": "hel"}});
        if let Some(own) = own {
            project["quotas"] = json!({"mqtt": own});
        }
        mirror.upsert(envelope("Project", "helsinki", ORG_NAMESPACE, project));
        for (name, connections) in brokers {
            mirror.upsert(envelope(
                "MqttBroker",
                name,
                "helsinki",
                broker(*connections),
            ));
        }
        mirror
    }

    fn refused(mirror: &Mirror, name: &str, spec: &Value) -> String {
        match check(mirror, "helsinki", name, spec) {
            Err(ApiError::Denied(reason)) => reason,
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn a_project_nobody_enabled_is_refused_and_told_who_turns_it_on() {
        let mirror = holding(None, None, &[]);
        assert_eq!(effective(&mirror, "helsinki").1, LimitOrigin::Default);
        let reason = refused(&mirror, "cams", &broker(10));
        assert!(
            reason.contains("MQTT is off for project helsinki"),
            "{reason}"
        );
        let off = holding(Some(json!({"enabled": false})), None, &[]);
        assert!(refused(&off, "cams", &broker(10)).contains("MQTT is off"));
    }

    #[test]
    fn the_projects_own_allowance_replaces_the_organizations_and_may_exceed_it() {
        let mirror = holding(
            Some(json!({"enabled": true, "brokers": 1})),
            Some(json!({"enabled": true, "brokers": 2})),
            &[("one", 10)],
        );
        let (allowance, origin) = effective(&mirror, "helsinki");
        assert_eq!(
            (allowance.limit("brokers"), origin),
            (2, LimitOrigin::Project)
        );
        assert!(check(&mirror, "helsinki", "two", &broker(10)).is_ok());
        mirror.upsert(envelope("MqttBroker", "two", "helsinki", broker(10)));
        let reason = refused(&mirror, "three", &broker(10));
        assert!(
            reason.contains("the project may run 2 MQTT brokers (2 in use)"),
            "{reason}"
        );
        assert!(reason.contains("Organization settings > Projects > helsinki"));
        assert!(
            check(&mirror, "helsinki", "two", &broker(20)).is_ok(),
            "an edit is not counted twice"
        );
    }

    #[test]
    fn each_sum_is_refused_past_what_is_left() {
        let mirror = holding(
            Some(
                json!({"enabled": true, "brokers": 5, "connections": 1000, "messagesPerSecond": 100000}),
            ),
            None,
            &[("one", 600)],
        );
        assert_eq!(effective(&mirror, "helsinki").1, LimitOrigin::Organization);
        let reason = refused(&mirror, "two", &broker(500));
        assert!(reason.contains("600 in use, 400 left"), "{reason}");
        assert!(check(&mirror, "helsinki", "two", &broker(400)).is_ok());
        let rate = json!({
            "roles": [{"name": "camera", "serviceAccounts": ["cam"], "publish": ["a"]}],
            "limits": {"maxConnections": 100, "messagesPerSecond": 1000}
        });
        assert!(refused(&mirror, "two", &rate).contains("messagesPerSecond"));
    }

    #[test]
    fn mode_and_port_come_from_the_allowance() {
        let mirror = holding(Some(json!({"enabled": true})), None, &[]);
        let mut relay = broker(10);
        relay["mode"] = json!("relay");
        assert!(refused(&mirror, "cams", &relay).contains("spec.mode relay"));
        let mut ported = broker(10);
        ported["port"] = json!(18831);
        assert!(refused(&mirror, "cams", &ported).contains("not assigned to project helsinki"));
    }

    #[test]
    fn the_limits_page_rows_carry_the_allowance_and_the_usage() {
        let mirror = holding(
            None,
            Some(json!({"enabled": true, "brokers": 3})),
            &[("a", 10)],
        );
        let (rows, own) = quota_rows(&mirror, "helsinki");
        assert!(own);
        assert_eq!(rows[0], ("mqttBrokers", 3, 1));
        assert_eq!(rows[1], ("mqttConnections", 1000, 10));
        let (_, own) = quota_rows(&holding(None, None, &[]), "helsinki");
        assert!(!own);
    }

    #[test]
    fn usage_leaves_out_the_broker_being_written_and_lists_ports() {
        let mirror = holding(None, None, &[("a", 10), ("b", 20)]);
        let held = brokers(&mirror, "helsinki");
        assert_eq!(usage(&held, None).connections, 30);
        assert_eq!(usage(&held, Some("a")).connections, 20);
        assert!(ports_in_use(&held).is_empty());
    }
}
