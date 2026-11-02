//! The Keycloak groups the repository owns (PF-62, PF-63, T-0866).
//!
//! A `Group` manifest is the membership; Keycloak is where it takes effect. This wave is the
//! only writer of the groups it manages: each one carries the attribute `managed-by:
//! joinedcontext`, and a group without that attribute — the bootstrap administrators' group
//! included — is never read for drift, never written and never removed.
//!
//! What somebody changed in the console between two runs is overwritten and reported, so the
//! repository stays the answer to "who is in this group" and the Access page can show that the
//! two disagreed (PF-63, PF-51).

use crate::config::ClientAuth;
use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, Utc};
use jc_core::kinds::GroupSpec;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::permissions::{is_person_id, organization_of, project_members, ORG_NAMESPACE};
use crate::store::{ListOptions, Mirror};

/// The attribute that says a group is this platform's to write (PF-63).
pub const MANAGED_BY: &str = "managed-by";
pub const MANAGED_VALUE: &str = "joinedcontext";

/// The attributes the realm's `jc_org` and `jc_groups` mappers read (ADR-N-067 2.2).
const ORGANIZATION_ATTRIBUTE: &str = "jc_org";
const GROUPS_ATTRIBUTE: &str = "jc_groups";

/// A group the platform derives (PF-87): a project's `{slug}-readers` or `{slug}-writers`, by
/// Keycloak user id, carrying the project's Organization, so whom a binding fills it with hold
/// `jc_org` (T-6461) until the binding goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DerivedGroup {
    pub name: String,
    pub members: BTreeSet<String>,
    pub organization: Option<String>,
}

/// Every registered project's derived groups as `mirror` holds its bindings at `now`: a binding
/// taken away or run out empties its person from them, and only a binding that reaches the
/// project counts, so none of another Organization grants its Organization here.
pub fn derived_groups(
    mirror: &Mirror,
    projects: &BTreeMap<String, String>,
    now: DateTime<Utc>,
) -> Vec<DerivedGroup> {
    projects
        .keys()
        .flat_map(|slug| {
            let members = project_members(mirror, slug, now);
            let organization = organization_of(mirror, slug);
            let [(readers, _), (writers, _)] = super::project_teams::teams_of(slug);
            [(readers, members.readers), (writers, members.writers)].map(|(name, members)| {
                DerivedGroup {
                    name,
                    members,
                    organization: organization.clone(),
                }
            })
        })
        .collect()
}

/// What one run did with one group, in the shape the mirror and the feed both carry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupOutcome {
    pub name: String,
    /// Empty when the realm already matched the manifest.
    pub drift: Vec<String>,
    /// A member the realm has no user for: the binding takes effect at their first login
    /// (PF-04), so this is a warning and never a failure.
    pub warnings: Vec<String>,
    pub error: Option<String>,
}

impl GroupOutcome {
    fn of(name: &str) -> Self {
        Self {
            name: name.to_owned(),
            drift: Vec::new(),
            warnings: Vec::new(),
            error: None,
        }
    }
}

#[derive(Debug, Deserialize)]
struct KcGroup {
    id: String,
    name: String,
    #[serde(default)]
    attributes: std::collections::HashMap<String, Vec<String>>,
}

impl KcGroup {
    fn managed(&self) -> bool {
        self.attributes
            .get(MANAGED_BY)
            .is_some_and(|values| values.iter().any(|v| v == MANAGED_VALUE))
    }
}

#[derive(Debug, Deserialize)]
struct KcUser {
    id: String,
}

/// The realm's groups, as this Portal's own client may write them.
pub struct GroupSync {
    admin: super::app_clients::Admin,
    /// Where a run records the groups it may not write, for the write doors (AP-115).
    foreign: Option<std::sync::Arc<super::foreign::ForeignNames>>,
}

impl GroupSync {
    /// Makes each run record the realm's unmanaged group names where the write doors read them.
    pub fn with_foreign(mut self, foreign: std::sync::Arc<super::foreign::ForeignNames>) -> Self {
        self.foreign = Some(foreign);
        self
    }

    /// `None` when no admin client is configured: the groups are then read from the repository
    /// and written nowhere, which is what a Portal without the credential does.
    pub fn new(issuer: &str, client_id: String, auth: ClientAuth) -> Option<Self> {
        Some(Self {
            admin: super::app_clients::Admin::new(issuer, client_id, auth)?,
            foreign: None,
        })
    }

    /// Brings the realm to what the manifests say, and answers what it had to change.
    ///
    /// The mirror is the repository as this run loaded it; only `Group` manifests of the
    /// organization namespace are read, and only groups carrying the managed attribute are
    /// written or removed.
    pub async fn converge(&self, mirror: &Mirror) -> Vec<GroupOutcome> {
        self.converge_with(mirror, &[]).await
    }

    /// [`Self::converge`], and besides the manifests the groups the platform derives: a
    /// project's `{slug}-readers` and `{slug}-writers`, which its bindings fill (PF-87). They are
    /// managed like a manifest's group and removed with the project; a `Group` manifest of the
    /// same name wins, and the clash is the outcome's error.
    pub async fn converge_with(
        &self,
        mirror: &Mirror,
        generated: &[DerivedGroup],
    ) -> Vec<GroupOutcome> {
        let token = match self.admin.token().await {
            Ok(token) => token,
            Err(err) => {
                return vec![GroupOutcome {
                    name: "*".to_owned(),
                    drift: Vec::new(),
                    warnings: Vec::new(),
                    error: Some(err),
                }]
            }
        };

        let existing: Vec<KcGroup> = match self
            .admin
            .get::<Value>(&token, "/groups?briefRepresentation=false&max=1000")
            .await
            .and_then(|value| serde_json::from_value(value).map_err(|err| err.to_string()))
        {
            Ok(groups) => groups,
            Err(err) => {
                return vec![GroupOutcome {
                    name: "*".to_owned(),
                    drift: Vec::new(),
                    warnings: Vec::new(),
                    error: Some(err),
                }]
            }
        };

        if let Some(foreign) = self.foreign.as_ref() {
            foreign.set_groups(
                existing
                    .iter()
                    .filter(|group| !group.managed())
                    .map(|group| group.name.clone())
                    .collect(),
            );
        }

        let mut outcomes = Vec::new();
        let mut wanted: BTreeSet<String> = BTreeSet::new();
        for envelope in mirror
            .list(ORG_NAMESPACE, "Group", &ListOptions::default())
            .items
        {
            let name = envelope.metadata.name.clone();
            wanted.insert(name.clone());
            let spec: GroupSpec = match serde_json::from_value(envelope.spec) {
                Ok(spec) => spec,
                Err(err) => {
                    let mut outcome = GroupOutcome::of(&name);
                    outcome.error = Some(format!("the manifest does not parse: {err}"));
                    outcomes.push(outcome);
                    continue;
                }
            };
            let held = existing.iter().find(|group| group.name == name);
            let members = spec
                .members
                .iter()
                .map(|member| member.user.trim().to_owned())
                .collect();
            outcomes.push(self.converge_one(&token, &name, &members, None, held).await);
        }
        for derived in generated {
            let name = &derived.name;
            if !wanted.insert(name.clone()) {
                let mut outcome = GroupOutcome::of(name);
                outcome.error = Some(format!(
                    "a Group manifest declares '{name}', the name of a project's forge group \
                     (PF-87); the manifest decides its members, so the project's bindings do not \
                     reach the forge through it. Rename the manifest"
                ));
                outcomes.push(outcome);
                continue;
            }
            let held = existing.iter().find(|group| &group.name == name);
            let organization = derived.organization.as_deref();
            outcomes.push(
                self.converge_one(&token, name, &derived.members, organization, held)
                    .await,
            );
        }

        // A managed group the repository no longer declares is this wave's to remove; one
        // without the attribute belongs to whoever made it (PF-63).
        for group in existing.iter().filter(|g| g.managed()) {
            if wanted.contains(&group.name) {
                continue;
            }
            let mut outcome = GroupOutcome::of(&group.name);
            match self
                .admin
                .send(
                    &token,
                    reqwest::Method::DELETE,
                    &format!("/groups/{}", group.id),
                    None,
                )
                .await
            {
                Ok(_) => outcome.drift.push(
                    "the group was managed here and no manifest declares it any more; it was \
                     removed from the realm"
                        .to_owned(),
                ),
                Err(err) => outcome.error = Some(err),
            }
            outcomes.push(outcome);
        }
        outcomes
    }

    async fn converge_one(
        &self,
        token: &str,
        name: &str,
        wanted: &BTreeSet<String>,
        organization: Option<&str>,
        held: Option<&KcGroup>,
    ) -> GroupOutcome {
        let mut outcome = GroupOutcome::of(name);
        let id = match held {
            Some(group) if !group.managed() => {
                // Somebody else's group under the same name: it is not ours to write, and
                // saying so is the whole of the report (PF-63).
                outcome.error = Some(format!(
                    "the realm has a group '{name}' without the {MANAGED_BY}: {MANAGED_VALUE} \
                     attribute; the platform never writes a group it does not manage"
                ));
                return outcome;
            }
            Some(group) => group.id.clone(),
            None => {
                if let Err(err) = self
                    .admin
                    .send(
                        token,
                        reqwest::Method::POST,
                        "/groups",
                        Some(&json!({ "name": name, "attributes": attributes_of(name, organization) })),
                    )
                    .await
                {
                    outcome.error = Some(err);
                    return outcome;
                }
                outcome
                    .drift
                    .push(format!("the realm had no group '{name}'; it was created"));
                match self
                    .admin
                    .get::<Value>(token, &format!("/groups?search={name}&exact=true"))
                    .await
                    .and_then(|v| {
                        serde_json::from_value::<Vec<KcGroup>>(v).map_err(|e| e.to_string())
                    }) {
                    Ok(found) => match found.into_iter().find(|group| group.name == name) {
                        Some(group) => group.id,
                        None => {
                            outcome.error =
                                Some("the realm did not return the group it just created".into());
                            return outcome;
                        }
                    },
                    Err(err) => {
                        outcome.error = Some(err);
                        return outcome;
                    }
                }
            }
        };

        self.keep_organization(token, held, organization, &mut outcome)
            .await;

        // A manifest written before ADR-N-061 names members by e-mail. Matching those against
        // the realm's ids would take every such person out, so the group is left as the realm
        // holds it until the repository's migration Change names them by id. No value is
        // echoed: the outcome reaches the logs and the feed.
        let unnamed = wanted.iter().filter(|member| !is_person_id(member)).count();
        if unnamed > 0 {
            outcome.error = Some(format!(
                "{unnamed} member(s) of '{name}' are not named by their Keycloak user id \
                 (ADR-N-061), so the group is left as the realm holds it; merge the migration \
                 Change that names them by id (People, Name people by id)"
            ));
            return outcome;
        }

        // Who is in the group now, by Keycloak user id, against who the manifest says: a member
        // without an e-mail is a member like any other (PF-62).
        let held: BTreeSet<String> = match self
            .admin
            .get::<Value>(token, &format!("/groups/{id}/members?max=1000"))
            .await
            .and_then(|v| serde_json::from_value::<Vec<KcUser>>(v).map_err(|e| e.to_string()))
        {
            Ok(members) => members.into_iter().map(|user| user.id).collect(),
            Err(err) => {
                outcome.error = Some(err);
                return outcome;
            }
        };
        for user in wanted.difference(&held) {
            match self.user_exists(token, user).await {
                Ok(true) => {
                    match self
                        .admin
                        .send(
                            token,
                            reqwest::Method::PUT,
                            &format!("/users/{user}/groups/{id}"),
                            None,
                        )
                        .await
                    {
                        Ok(_) => outcome
                            .drift
                            .push(format!("{user} belongs in the group and was added")),
                        Err(err) => outcome.error = Some(err),
                    }
                }
                // Not an error: the account may come back, or the manifest is fixed next.
                Ok(false) => outcome.warnings.push(format!(
                    "{user} belongs in the group and the realm has no user with that id"
                )),
                Err(err) => outcome.error = Some(err),
            }
        }

        for user in held.difference(wanted) {
            match self
                .admin
                .send(
                    token,
                    reqwest::Method::DELETE,
                    &format!("/users/{user}/groups/{id}"),
                    None,
                )
                .await
            {
                Ok(_) => outcome.drift.push(format!(
                    "{user} was in the realm's group and does not belong in it; the \
                     membership was removed"
                )),
                Err(err) => outcome.error = Some(err),
            }
        }
        outcome
    }

    /// Brings a derived group already in the realm to its project's Organization: a group made
    /// before T-6461 carries none, and a project can move to another one. A manifest's group
    /// (no Organization) is left as it is.
    async fn keep_organization(
        &self,
        token: &str,
        held: Option<&KcGroup>,
        organization: Option<&str>,
        outcome: &mut GroupOutcome,
    ) {
        let (Some(group), Some(organization)) = (held, organization) else {
            return;
        };
        let attributes = attributes_of(&group.name, Some(organization));
        let says = |key: &str| group.attributes.get(key).map(|values| json!(values));
        if [ORGANIZATION_ATTRIBUTE, GROUPS_ATTRIBUTE]
            .iter()
            .all(|key| says(key).as_ref() == attributes.get(*key))
        {
            return;
        }
        let body = json!({ "name": group.name, "attributes": attributes });
        let sent = self
            .admin
            .send(
                token,
                reqwest::Method::PUT,
                &format!("/groups/{}", group.id),
                Some(&body),
            )
            .await;
        match sent {
            Ok(_) => outcome.drift.push(format!(
                "the group did not name Organization {organization}; it does now"
            )),
            Err(err) => outcome.error = Some(err),
        }
    }

    /// Whether the realm has a user with this id; a 404 is `false`, any other refusal an error.
    async fn user_exists(&self, token: &str, user: &str) -> Result<bool, String> {
        self.admin.exists(token, &format!("/users/{user}")).await
    }
}

/// What a group the platform writes carries: the managed mark and, for a derived group, its
/// Organization as the token claims read it. The path in `jc_groups` is a name, not the group's
/// place in the realm: the group is a root group so that the forge's team map finds it (PF-87).
fn attributes_of(name: &str, organization: Option<&str>) -> Value {
    let mut attributes = json!({ MANAGED_BY: [MANAGED_VALUE] });
    if let Some(organization) = organization {
        attributes[ORGANIZATION_ATTRIBUTE] = json!([organization]);
        attributes[GROUPS_ATTRIBUTE] = json!([format!("/{organization}/{name}")]);
    }
    attributes
}

/// The few characters an address may carry that a query string may not (`+` above all).
pub(super) fn urlencoding(value: &str) -> String {
    value
        .chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' | '~' | '@' => c.to_string(),
            other => other
                .to_string()
                .as_bytes()
                .iter()
                .map(|b| format!("%{b:02X}"))
                .collect(),
        })
        .collect()
}

/// What the Access page reads: the drift and the warnings of one run, on the Group manifest
/// itself, so a person sees the disagreement where the membership is (PF-62, UI-44).
pub fn record(mirror: &Mirror, outcomes: &[GroupOutcome]) {
    for outcome in outcomes {
        let Some(mut envelope) = mirror.get(ORG_NAMESPACE, "Group", &outcome.name) else {
            continue;
        };
        let Some(status) = envelope.status.as_mut() else {
            continue;
        };
        if let Some(error) = &outcome.error {
            status.phase = crate::resource::Phase::Error;
            status.conditions = vec![super::streams::make_condition(
                "GroupSynced",
                "False",
                "RealmRefused",
                error,
            )];
        } else if !outcome.drift.is_empty() {
            status.conditions = vec![super::streams::make_condition(
                "GroupSynced",
                "True",
                "DriftCorrected",
                &outcome.drift.join("; "),
            )];
        } else if !outcome.warnings.is_empty() {
            status.conditions = vec![super::streams::make_condition(
                "GroupSynced",
                "True",
                "MemberUnknown",
                &outcome.warnings.join("; "),
            )];
        }
        mirror.upsert(envelope);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_address_is_safe_in_a_query_string() {
        assert_eq!(urlencoding("jana+test@hel.fi"), "jana%2Btest@hel.fi");
        assert_eq!(urlencoding("jana@hel.fi"), "jana@hel.fi");
    }

    #[test]
    fn only_a_group_carrying_the_attribute_is_ours() {
        let ours = KcGroup {
            id: "1".into(),
            name: "city-leads".into(),
            attributes: [(MANAGED_BY.to_owned(), vec![MANAGED_VALUE.to_owned()])]
                .into_iter()
                .collect(),
        };
        let theirs = KcGroup {
            id: "2".into(),
            name: "platform-admins".into(),
            attributes: Default::default(),
        };
        assert!(ours.managed());
        assert!(!theirs.managed());
    }
}
