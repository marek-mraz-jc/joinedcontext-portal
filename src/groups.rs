//! A Group name is one Keycloak group for the whole organization (AP-115, ADR-N-030 §3.5,
//! ADR-N-031).
//!
//! A `Group` belongs to the organization, or to the App whose default group it is, which the
//! annotation `joinedcontext.com/app: {project}/{app}` says. A write that would hand a group of
//! one owner to another is refused, and so is a new group whose name the realm already holds
//! without this platform managing it: the reconciler never takes such a group over (PF-63).
//! Both are refused before a Change exists, naming both owners.

use jc_core::ObjectMeta;

use crate::apps::reconciler::APP_LABEL;
use crate::auth::Identity;
use crate::error::ApiError;
use crate::permissions::ORG_NAMESPACE;
use crate::state::AppState;

/// Refuses a `Group` whose name another owner holds (AP-115). Writing a group again under the
/// owner it has, or without saying one (a person editing the members), is an update.
pub fn check(
    state: &AppState,
    identity: &Identity,
    kind: &str,
    meta: &ObjectMeta,
) -> Result<(), ApiError> {
    if kind != "Group" {
        return Ok(());
    }
    let name = &meta.name;
    let wanted = meta.annotations.get(APP_LABEL);
    let Some(held) = state.mirror.get(ORG_NAMESPACE, "Group", name) else {
        if state.foreign_names.has_group(name) {
            return Err(ApiError::Denied(format!(
                "the group '{name}' for {} already exists in the realm and this platform does \
                 not manage it; it is never taken over (AP-115). Choose another name, or ask a \
                 realm administrator to rename or remove that group",
                written(wanted)
            )));
        }
        return Ok(());
    };
    let current = held.metadata.annotations.get(APP_LABEL);
    if wanted.is_none() || wanted == current {
        return Ok(());
    }
    Err(ApiError::Denied(format!(
        "the group '{name}' belongs to {}, so it cannot become the group of {} (AP-115); \
         choose another name",
        owner(state, identity, current),
        written(wanted)
    )))
}

/// The owner the write names, in words: the caller's own manifest, so nothing is disclosed.
fn written(app: Option<&String>) -> String {
    match app.map(|app| app.split_once('/')) {
        None => "the organization".to_owned(),
        Some(Some((project, name))) => format!("the App {name} of project {project}"),
        Some(None) => format!("the App {}", app.map_or("", String::as_str)),
    }
}

/// Who a group belongs to today, in words: an App's project only to a caller who may read Apps
/// there (PF-59).
fn owner(state: &AppState, identity: &Identity, app: Option<&String>) -> String {
    match app.and_then(|app| app.split_once('/')) {
        None if app.is_none() => "the organization".to_owned(),
        Some((project, _))
            if crate::permissions::for_request(state, identity, project).may_read("App") =>
        {
            written(app)
        }
        _ => "an App of another project".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::resource::{ResourceEnvelope, API_VERSION};
    use serde_json::json;
    use std::collections::BTreeSet;

    fn who(email: &str) -> Identity {
        Identity {
            subject: format!("f:1:{email}"),
            username: email.split('@').next().unwrap_or(email).to_owned(),
            email: Some(email.to_owned()),
            name: None,
            roles: Vec::new(),
            groups: Vec::new(),
        }
    }

    fn meta(name: &str, app: Option<&str>) -> ObjectMeta {
        let mut meta = ObjectMeta::new(name, ORG_NAMESPACE);
        if let Some(app) = app {
            meta.annotations
                .insert(APP_LABEL.to_owned(), app.to_owned());
        }
        meta
    }

    fn manifest(kind: &str, meta: ObjectMeta, spec: serde_json::Value) -> ResourceEnvelope {
        ResourceEnvelope {
            api_version: API_VERSION.to_owned(),
            kind: kind.to_owned(),
            metadata: meta,
            spec,
            status: None,
        }
    }

    /// The org holds `operators`; `board` of `doprava` holds `board-viewer`; the realm holds
    /// `admins` unmanaged. `reader_in` may read Apps in that project.
    fn world(reader_in: Option<&str>) -> AppState {
        let state = AppState::new(Config::for_tests(), None);
        let group = |meta| manifest("Group", meta, json!({ "members": [] }));
        state.mirror.upsert(group(self::meta("operators", None)));
        state
            .mirror
            .upsert(group(self::meta("board-viewer", Some("doprava/board"))));
        if let Some(project) = reader_in {
            state.mirror.upsert(manifest(
                "Role",
                ObjectMeta::new("app-reader", ORG_NAMESPACE),
                json!({ "rules": [{ "kinds": ["App"], "verbs": ["read"] }] }),
            ));
            state.mirror.upsert(manifest(
                "RoleBinding",
                ObjectMeta::new("jana-reads-apps", ORG_NAMESPACE),
                json!({
                    "subjects": [{ "user": "jana@hel.fi" }],
                    "role": "app-reader",
                    "scope": { "project": project },
                }),
            ));
        }
        state
            .foreign_names
            .set_groups(BTreeSet::from(["admins".to_owned()]));
        state
    }

    fn refusal(state: &AppState, kind: &str, meta: &ObjectMeta) -> Option<String> {
        match check(state, &who("jana@hel.fi"), kind, meta) {
            Ok(()) => None,
            Err(ApiError::Denied(message)) => Some(message),
            Err(other) => panic!("a clash is a refusal, not {other:?}"),
        }
    }

    /// AP-115: an App's default group named like the organization's group, or like another
    /// App's, is refused naming both owners.
    #[test]
    fn a_group_of_another_owner_is_refused_naming_both() {
        let state = world(Some("doprava"));
        let message =
            refusal(&state, "Group", &meta("operators", Some("ovzdusie/air"))).expect("a clash");
        assert!(message.contains("belongs to the organization"), "{message}");
        assert!(
            message.contains("the App air of project ovzdusie"),
            "{message}"
        );
        let message = refusal(
            &state,
            "Group",
            &meta("board-viewer", Some("ovzdusie/board")),
        )
        .expect("a clash");
        assert!(
            message.contains("belongs to the App board of project doprava"),
            "{message}"
        );
        assert!(message.contains("AP-115"), "{message}");
    }

    /// PF-59: the other owner's project is named only to a caller who may read Apps there.
    #[test]
    fn a_project_the_caller_cannot_read_is_not_named() {
        let state = world(None);
        let message = refusal(
            &state,
            "Group",
            &meta("board-viewer", Some("ovzdusie/board")),
        )
        .expect("a clash");
        assert!(message.contains("an App of another project"), "{message}");
        assert!(!message.contains("doprava"), "{message}");
    }

    /// AP-115: a new group the realm holds unmanaged is refused; the bootstrap administrators'
    /// group is never taken over.
    #[test]
    fn a_new_group_somebody_else_made_in_the_realm_is_refused() {
        let state = world(None);
        let message = refusal(&state, "Group", &meta("admins", None)).expect("a clash");
        assert!(
            message.contains("'admins' for the organization"),
            "{message}"
        );
        assert!(message.contains("never taken over"), "{message}");
    }

    /// The same group written again under its owner, or by a person editing its members, is an
    /// update; another kind or a free name is no clash.
    #[test]
    fn the_same_owner_a_members_edit_and_a_free_name_pass() {
        let state = world(None);
        assert_eq!(
            refusal(
                &state,
                "Group",
                &meta("board-viewer", Some("doprava/board"))
            ),
            None
        );
        assert_eq!(refusal(&state, "Group", &meta("board-viewer", None)), None);
        assert_eq!(refusal(&state, "Group", &meta("operators", None)), None);
        assert_eq!(
            refusal(&state, "Group", &meta("air-viewer", Some("ovzdusie/air"))),
            None
        );
        assert_eq!(refusal(&state, "Role", &meta("admins", None)), None);
    }
}
