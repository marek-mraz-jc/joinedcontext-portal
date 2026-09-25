//! Roles as code, enforced (T-0526, PF-50, PF-51): the `Role` and `RoleBinding` manifests of
//! the organization repository decide who may propose, approve and delete what, per project.
//! The token contributes identity only (`sub`, e-mail, username, groups); no permission is
//! read from it. A caller without a binding reads and proposes nothing.

use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, Utc};
use jc_core::kinds::{
    Constraint, RoleBindingSpec, RoleScope, RoleSpec, Rule, ServiceAccountSpec, Verb,
};
use serde::Serialize;
use serde_json::Value;
use utoipa::ToSchema;

use crate::auth::session::Identity;
use crate::error::ApiError;
use crate::state::AppState;
use crate::store::{ListOptions, Mirror};

/// The namespace the organization repository's `users/` manifests carry.
pub const ORG_NAMESPACE: &str = "org";

/// One rule in force, with the binding and role it came through, so a refusal can be traced.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct Grant {
    pub role: String,
    pub binding: String,
    /// Where the binding that carries this rule applies: `organization`, `project:{name}` or
    /// `contextSpace:{name}`. A grant read here may have been inherited from the organization,
    /// and the page says so rather than making it look local (PF-60, PF-61).
    pub scope: String,
    /// Set when the binding is scoped to one context space: the rule then applies only to a
    /// manifest whose `spec.contextSpaceRef` names it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub space: Option<String>,
    #[schema(value_type = Object)]
    pub rule: Rule,
}

/// Something the caller may or may not do that no rule expresses as a kind and a verb, with the
/// API's own words for the refusal: the control is rendered disabled with the reason, never
/// hidden (UI-44).
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct Affordance {
    pub allowed: bool,
    /// Why not; absent when the caller may.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// What the organization's own settings let this caller do with projects (PF-65).
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ProjectAffordances {
    /// Whether `POST /api/v1/projects` would open a project for this caller.
    pub creation: Affordance,
}

/// What one caller may do in one project: `GET /api/v1/projects/{project}/permissions/me`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct Effective {
    pub project: String,
    /// The caller is in the bootstrap group of `JC_PORTAL_BOOTSTRAP_ADMINS`: everything,
    /// everywhere, so the first binding can be written into an empty repository.
    pub bootstrap: bool,
    pub grants: Vec<Grant>,
    /// Filled by the route, not by the rules: opening a project is the organization's own
    /// setting and no binding expresses it (PF-65, T-0870).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub projects: Option<ProjectAffordances>,
}

/// The effective permissions of the signed-in caller in `project`, right now.
/// Refuses anybody but an administrator of the organization, with a `403` that names what
/// `action` needs (UI-87). The administrator is PF-03's: `approve` and `delete` on `RoleBinding`
/// at organization scope, as the seeded `org-admin` holds them and validation health asks.
pub fn require_organization_admin(
    state: &AppState,
    identity: &Identity,
    action: &str,
) -> Result<(), ApiError> {
    let effective = for_request(state, identity, ORG_NAMESPACE);
    if effective.may("RoleBinding", Verb::Approve) && effective.may("RoleBinding", Verb::Delete) {
        return Ok(());
    }
    Err(ApiError::Denied(format!(
        "{action} is for organization administrators, on the Administration page (UI-87)"
    )))
}

pub fn for_request(state: &AppState, identity: &Identity, project: &str) -> Effective {
    effective(
        &state.mirror,
        &state.config.bootstrap_admins,
        identity,
        project,
        Utc::now(),
    )
}

/// Whether the caller holds a binding in force anywhere in the organization, or is in the
/// bootstrap group: who reads an organization model, since a schema carries no data (DM-75).
pub fn is_organization_member(state: &AppState, identity: &Identity) -> bool {
    in_group(identity, &state.config.bootstrap_admins)
        || !in_force(&state.mirror, identity, Utc::now()).is_empty()
}

/// Reads every `Role` and `RoleBinding` of the mirror and keeps the rules whose binding names
/// the caller, covers the project and is in force at `now`.
pub fn effective(
    mirror: &Mirror,
    bootstrap_group: &str,
    identity: &Identity,
    project: &str,
    now: DateTime<Utc>,
) -> Effective {
    if in_group(identity, bootstrap_group) {
        return Effective {
            project: project.to_owned(),
            bootstrap: true,
            grants: Vec::new(),
            projects: None,
        };
    }
    let grants = in_force(mirror, identity, now)
        .into_iter()
        .filter_map(|(reach, mut grant)| {
            grant.space = match reach {
                Reach::Organization => None,
                Reach::Project(p) if p == project => None,
                Reach::Project(_) => return None,
                Reach::Space(space) => Some(space),
            };
            Some(grant)
        })
        .collect();
    Effective {
        project: project.to_owned(),
        bootstrap: false,
        grants,
        projects: None,
    }
}

impl Effective {
    /// Whether the caller administers the organization (PF-03): `approve` and `delete` on
    /// `RoleBinding`, as `org-admin` holds them, asked of the permissions at [`ORG_NAMESPACE`].
    /// What only an administrator reads asks this one question: the validation health (OPS-53)
    /// and the organization-level Endpoints page (PF-61).
    pub fn administers_organization(&self) -> bool {
        self.may("RoleBinding", Verb::Approve) && self.may("RoleBinding", Verb::Delete)
    }

    /// Whether the caller may read anything in this project (PF-59): a binding whose scope
    /// covers it, or the bootstrap group. What is not readable is `404` and not `403`, so a
    /// project nobody bound the caller to reads like a project that is not there (R20).
    pub fn may_read_project(&self) -> bool {
        self.bootstrap || !self.grants.is_empty()
    }

    /// Whether some grant here lets the caller propose anything: what opening a workspace
    /// asks for (API/01 §22). Each write into it is still checked on its own kind (PF-82).
    pub fn may_propose_anything(&self) -> bool {
        self.bootstrap
            || self.grants.iter().any(|grant| {
                grant
                    .rule
                    .kinds
                    .iter()
                    .any(|kind| grant.rule.grants(kind, Verb::Propose))
            })
    }

    /// Whether some grant here lets the caller `verb` on `kind` at all, whatever the content:
    /// the question asked before a manifest is read, so a caller without the right learns
    /// nothing of the kind's schema (T-2576, PF-50). The content is judged by [`Self::check`].
    pub fn may(&self, kind: &str, verb: Verb) -> bool {
        self.bootstrap
            || self
                .grants
                .iter()
                .any(|grant| grant.rule.grants(kind, verb))
    }

    /// Whether the caller may read `kind` here (PF-59). `propose` on a kind implies `read` on
    /// it, which is what keeps a role written before the verb working (jc-core `Rule::grants`).
    pub fn may_read(&self, kind: &str) -> bool {
        self.bootstrap
            || self
                .grants
                .iter()
                .any(|grant| grant.rule.grants(kind, Verb::Read))
    }

    /// Whether a role of this caller names `field` in a constraint on `propose` of `kind`
    /// (AP-73): a constraint on a `status.*` field means that role writes the field and nobody
    /// else does.
    ///
    /// The bootstrap group is not a shortcut here. `status` is the platform's own computation
    /// and `status.build` is the build lane's alone, so the one writer is the one role — an
    /// administrator who wants it binds themselves to that role in the open.
    pub fn may_write_status_field(&self, kind: &str, field: &str) -> bool {
        self.grants.iter().any(|grant| {
            grant.rule.grants(kind, Verb::Propose)
                && grant.rule.constraints.iter().any(|c| c.field == field)
        })
    }

    /// Whether the caller may read this one manifest (PF-59, PF-60): a grant that reads the
    /// kind, and — when the binding is scoped to one context space — a manifest of that space.
    /// This is what an organization-level list filters with, item by item.
    pub fn may_read_manifest(&self, kind: &str, manifest: &Value) -> bool {
        self.may_read_in(kind, space_ref(manifest).as_deref())
    }

    /// [`Self::may_read_manifest`] for a manifest known only by its kind and its context space
    /// (`None` for a kind that lives outside one), as a draft event carries them.
    pub fn may_read_in(&self, kind: &str, space: Option<&str>) -> bool {
        if self.bootstrap {
            return true;
        }
        self.grants.iter().any(|grant| {
            grant.rule.grants(kind, Verb::Read)
                && match &grant.space {
                    None => true,
                    Some(bound) => space == Some(bound.as_str()),
                }
        })
    }

    /// `Ok` when a grant allows `verb` on `kind` for `target` (the whole manifest as JSON, when
    /// there is one); a 403 that names the missing verb or the violated constraint otherwise.
    pub fn check(&self, kind: &str, verb: Verb, target: Option<&Value>) -> Result<(), ApiError> {
        if self.bootstrap {
            return Ok(());
        }
        // An App that declares destinations on the internet lets data out as surely as a public
        // one, so its approval is judged as a public App's: publisher or org-admin (AP-134,
        // PF-71). The seeded steward's approve is constrained to a non-public visibility.
        let egress_declared = kind == "App" && verb == Verb::Approve && declares_egress(target);
        let judged_as_public = egress_declared.then(|| {
            let mut judged = target.cloned().unwrap_or_default();
            judged["spec"]["visibility"] = Value::from("public");
            judged
        });
        let target = judged_as_public.as_ref().or(target);
        let space_of_target = target.and_then(space_ref);
        let mut violation: Option<String> = None;
        for grant in &self.grants {
            let rule = &grant.rule;
            if !rule.kinds.iter().any(|k| k == kind) || !rule.verbs.contains(&verb) {
                continue;
            }
            // The build lane's rule writes `status.build` and authorizes no other proposal: its
            // one write is judged by `may_write_status_field` and the unchanged spec (AP-73).
            if verb == Verb::Propose && writes_status_only(rule) {
                continue;
            }
            if let Some(space) = &grant.space {
                if space_of_target.as_deref() != Some(space.as_str()) {
                    continue;
                }
            }
            match rule.constraints.iter().find(|c| !satisfied(c, target)) {
                None => return Ok(()),
                Some(c) => {
                    violation.get_or_insert_with(|| {
                        format!(
                            "{} does not satisfy role {} ({})",
                            c.field,
                            grant.role,
                            describe(c)
                        )
                    });
                }
            }
        }
        // Letting data out to the public is a right of its own, and the one refusal that says
        // which role holds it: every door goes through this check, so the Approvals page, the
        // operations registry and the assistant all say the same sentence (EP-76, PF-71, PF-72).
        if kind == "Endpoint" && verb == Verb::Approve && audience_of(target) == Some("public") {
            return Err(ApiError::Denied(
                "approving a public Endpoint needs publisher, the role whose approve is \
                 constrained to a public audience; org-admin holds it too (EP-76, PF-71)"
                    .to_owned(),
            ));
        }
        if egress_declared {
            return Err(ApiError::Denied(
                "approving an App that declares spec.egress needs publisher, the role whose \
                 approve is constrained to a public visibility; org-admin holds it too (AP-134, \
                 PF-71)"
                    .to_owned(),
            ));
        }
        if kind == "App"
            && verb == Verb::Approve
            && target
                .and_then(|t| t.pointer("/spec/visibility"))
                .and_then(Value::as_str)
                == Some("public")
        {
            return Err(ApiError::Denied(
                "approving a public App needs publisher, the role whose approve is constrained \
                 to a public visibility; org-admin holds it too (AP-120, PF-71)"
                    .to_owned(),
            ));
        }
        Err(ApiError::Denied(violation.unwrap_or_else(|| {
            format!(
                "no role grants {} on {kind} in project {} (PF-50)",
                verb_name(verb),
                self.project
            )
        })))
    }
}

/// Whether an App manifest declares a destination beyond its endpoint (AP-134).
fn declares_egress(target: Option<&Value>) -> bool {
    target
        .and_then(|t| t.pointer("/spec/egress"))
        .and_then(Value::as_array)
        .is_some_and(|egress| !egress.is_empty())
}

/// Where a binding applies.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Reach {
    Organization,
    Project(String),
    Space(String),
}

impl Reach {
    /// What `permissions/me` calls this scope (PF-61).
    fn name(&self) -> String {
        match self {
            Self::Organization => "organization".to_owned(),
            Self::Project(project) => format!("project:{project}"),
            Self::Space(space) => format!("contextSpace:{space}"),
        }
    }

    fn of(scope: &RoleScope) -> Option<Self> {
        match (&scope.organization, &scope.project, &scope.context_space) {
            (Some(_), _, _) => Some(Self::Organization),
            (_, Some(project), _) => Some(Self::Project(project.clone())),
            (_, _, Some(space)) => Some(Self::Space(space.clone())),
            _ => None,
        }
    }

    /// Whether a grant held here also holds at `target`: the organization covers everything, a
    /// project its own context spaces.
    fn covers(&self, target: &Self, mirror: &Mirror) -> bool {
        match (self, target) {
            (Self::Organization, _) => true,
            (Self::Project(held), Self::Project(wanted)) => held == wanted,
            (Self::Project(held), Self::Space(space)) => {
                mirror.get(held, "ContextSpace", space).is_some()
            }
            (Self::Space(held), Self::Space(wanted)) => held == wanted,
            _ => false,
        }
    }
}

/// The roles of one namespace: the organization's `users/roles/`, or one project's own (PF-68).
fn roles(mirror: &Mirror, namespace: &str) -> Vec<(String, RoleSpec)> {
    mirror
        .list(namespace, "Role", &ListOptions::default())
        .items
        .into_iter()
        .filter_map(|env| match serde_json::from_value::<RoleSpec>(env.spec) {
            Ok(spec) => Some((env.metadata.name, spec)),
            Err(e) => {
                tracing::warn!(role = %env.metadata.name, error = %e, "Role in the mirror does not parse; it grants nothing");
                None
            }
        })
        .collect()
}

/// The project a context space belongs to, which is the project whose roles a binding scoped to
/// that space may reach (PF-69).
fn project_of_space(mirror: &Mirror, space: &str) -> Option<String> {
    mirror
        .find(|env| env.kind == "ContextSpace" && env.metadata.name == space)
        .and_then(|env| env.metadata.namespace)
}

/// The role a binding names, looked up where the binding reaches it: the organization's roles
/// first, then the roles of the project its scope names (PF-68, PF-69).
///
/// A name in both places is refused by `jcctl validate` before the manifest ever lands, so the
/// organization's copy winning here is a tie that cannot happen, not a precedence rule.
fn role_of(
    mirror: &Mirror,
    organization: &[(String, RoleSpec)],
    reach: &Reach,
    name: &str,
) -> Option<(String, RoleSpec)> {
    if let Some((found, spec)) = organization.iter().find(|(role, _)| role == name) {
        return Some((found.clone(), spec.clone()));
    }
    let project = match reach {
        Reach::Organization => return None,
        Reach::Project(project) => project.clone(),
        Reach::Space(space) => project_of_space(mirror, space)?,
    };
    roles(mirror, &project)
        .into_iter()
        .find(|(role, _)| role == name)
}

/// Every rule a binding in force at `now` gives the caller, with where the binding applies.
fn in_force(mirror: &Mirror, identity: &Identity, now: DateTime<Utc>) -> Vec<(Reach, Grant)> {
    let organization = roles(mirror, ORG_NAMESPACE);
    let mut grants = Vec::new();
    for env in mirror
        .list(ORG_NAMESPACE, "RoleBinding", &ListOptions::default())
        .items
    {
        let binding = match serde_json::from_value::<RoleBindingSpec>(env.spec) {
            Ok(spec) => spec,
            Err(e) => {
                tracing::warn!(binding = %env.metadata.name, error = %e, "RoleBinding in the mirror does not parse; it grants nothing");
                continue;
            }
        };
        if !binding.subjects.iter().any(|s| is_subject(identity, s)) {
            continue;
        }
        if binding.validity.as_ref().is_some_and(|v| !v.contains(now)) {
            continue;
        }
        let Some(reach) = Reach::of(&binding.scope) else {
            continue;
        };
        let Some((role_name, role)) = role_of(mirror, &organization, &reach, &binding.role) else {
            tracing::warn!(binding = %env.metadata.name, role = %binding.role, "RoleBinding names a Role it does not reach");
            continue;
        };
        for rule in &role.rules {
            grants.push((
                reach.clone(),
                Grant {
                    role: role_name.clone(),
                    binding: env.metadata.name.clone(),
                    scope: reach.name(),
                    space: None,
                    rule: rule.clone(),
                },
            ));
        }
    }
    grants.extend(account_grants(mirror, &organization, identity));
    grants
}

/// Whether one of a ServiceAccount's roles names a `Role` (§2a), so the account acts on the
/// Portal and its client's tokens carry the Portal's audience (PF-47).
pub(crate) fn account_holds_portal_role(mirror: &Mirror, spec: &ServiceAccountSpec) -> bool {
    let organization = roles(mirror, ORG_NAMESPACE);
    spec.roles.iter().any(|granted| {
        Reach::of(&granted.scope)
            .is_some_and(|reach| role_of(mirror, &organization, &reach, &granted.role).is_some())
    })
}

/// The account a bearer token speaks for (PF-46, PF-49): its `azp` is the derived client id of
/// exactly one `ServiceAccount`, and its user is that client's own service account, so a person
/// who signed in through some client is never mistaken for it. An id two accounts derive is
/// nobody's, as at the gateway (T-1454).
fn account_of(mirror: &Mirror, identity: &Identity) -> Option<(String, ServiceAccountSpec)> {
    use jc_core::kinds::service_account::keycloak_client_id;
    let client = identity.client.as_deref()?;
    if !identity
        .username
        .eq_ignore_ascii_case(&format!("service-account-{client}"))
    {
        return None;
    }
    let mut matches = mirror.namespaces().into_iter().flat_map(|namespace| {
        mirror
            .list(&namespace, "ServiceAccount", &ListOptions::default())
            .items
            .into_iter()
            .filter(move |env| keycloak_client_id(&namespace, &env.metadata.name) == client)
    });
    let env = matches.next()?;
    if matches.next().is_some() {
        tracing::warn!(
            client,
            "two ServiceAccounts derive this Keycloak client id; it grants nothing"
        );
        return None;
    }
    match serde_json::from_value::<ServiceAccountSpec>(env.spec) {
        Ok(spec) => Some((env.metadata.name, spec)),
        Err(e) => {
            tracing::warn!(account = %env.metadata.name, error = %e, "ServiceAccount in the mirror does not parse; it grants nothing");
            None
        }
    }
}

/// The rules of the caller's own `ServiceAccount`: each of its `roles` that names a `Role`, on
/// the scope beside it, without `approve` (PF-58: a workload proposes, a person approves). Its
/// other roles are the gateway's templates and grant nothing here (CC-60).
fn account_grants(
    mirror: &Mirror,
    organization: &[(String, RoleSpec)],
    identity: &Identity,
) -> Vec<(Reach, Grant)> {
    let Some((account, spec)) = account_of(mirror, identity) else {
        return Vec::new();
    };
    let mut grants = Vec::new();
    for granted in &spec.roles {
        let Some(reach) = Reach::of(&granted.scope) else {
            continue;
        };
        let Some((role_name, role)) = role_of(mirror, organization, &reach, &granted.role) else {
            continue;
        };
        for rule in role.rules {
            let verbs: Vec<Verb> = rule
                .verbs
                .iter()
                .copied()
                .filter(|verb| *verb != Verb::Approve)
                .collect();
            if verbs.is_empty() {
                continue;
            }
            grants.push((
                reach.clone(),
                Grant {
                    role: role_name.clone(),
                    binding: format!("serviceaccount/{account}"),
                    scope: reach.name(),
                    space: None,
                    rule: Rule { verbs, ..rule },
                },
            ));
        }
    }
    grants
}

/// Who reaches one project's repository in the forge, by lower-case identifier (PF-87): the
/// people a binding in force at the organization or at the project lets read some kind, and
/// those it lets propose, approve or delete. A `group` subject counts through the members of its
/// `Group` manifest. A binding scoped to one context space counts for nobody: the repository
/// holds every space of the project, so a clone would reach past the grant.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ProjectMembers {
    pub readers: BTreeSet<String>,
    pub writers: BTreeSet<String>,
}

pub fn project_members(mirror: &Mirror, project: &str, now: DateTime<Utc>) -> ProjectMembers {
    let organization = roles(mirror, ORG_NAMESPACE);
    let groups: BTreeMap<String, Vec<String>> = mirror
        .list(ORG_NAMESPACE, "Group", &ListOptions::default())
        .items
        .into_iter()
        .map(|env| {
            let members = serde_json::from_value::<jc_core::kinds::GroupSpec>(env.spec)
                .map(|spec| spec.members.into_iter().map(|m| m.user).collect())
                .unwrap_or_default();
            (env.metadata.name, members)
        })
        .collect();
    let mut members = ProjectMembers::default();
    for env in mirror
        .list(ORG_NAMESPACE, "RoleBinding", &ListOptions::default())
        .items
    {
        let Ok(binding) = serde_json::from_value::<RoleBindingSpec>(env.spec) else {
            continue;
        };
        if binding.validity.as_ref().is_some_and(|v| !v.contains(now)) {
            continue;
        }
        let reach = match Reach::of(&binding.scope) {
            Some(Reach::Organization) => Reach::Organization,
            Some(Reach::Project(p)) if p == project => Reach::Project(p),
            _ => continue,
        };
        let Some((_, role)) = role_of(mirror, &organization, &reach, &binding.role) else {
            continue;
        };
        let grants = |verb: Verb| {
            role.rules
                .iter()
                .any(|rule| rule.kinds.iter().any(|kind| rule.grants(kind, verb)))
        };
        let reads = grants(Verb::Read);
        let writes = [Verb::Propose, Verb::Approve, Verb::Delete]
            .into_iter()
            .any(grants);
        if !reads && !writes {
            continue;
        }
        let people = binding.subjects.iter().flat_map(|subject| {
            let direct = subject.user.iter().cloned();
            let through = subject
                .group
                .as_ref()
                .and_then(|group| groups.get(group))
                .into_iter()
                .flatten()
                .cloned();
            direct.chain(through)
        });
        for person in people {
            let person = person.trim().to_ascii_lowercase();
            if person.is_empty() {
                continue;
            }
            if reads {
                members.readers.insert(person.clone());
            }
            if writes {
                members.writers.insert(person);
            }
        }
    }
    members
}

/// Every `group` subject of a `RoleBinding` or `ServiceAccount` names a `Group` manifest of the
/// organization (PF-62, PF-64). A binding to a group nobody declared matches nobody and says
/// nothing about it, which is the silence this refusal replaces. The bootstrap administrators
/// are not a subject — they are the platform setting of PF-52 — so nothing here touches them.
fn subjects_name_a_group(mirror: &Mirror, manifest: &Value) -> Result<(), ApiError> {
    let kind = manifest.get("kind").and_then(Value::as_str).unwrap_or("");
    if kind != "RoleBinding" && kind != "ServiceAccount" {
        return Ok(());
    }
    let named = manifest
        .pointer("/spec/subjects")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|subject| subject.get("group").and_then(Value::as_str));
    for group in named {
        if mirror.get(ORG_NAMESPACE, "Group", group).is_none() {
            let declared: Vec<String> = mirror
                .list(ORG_NAMESPACE, "Group", &ListOptions::default())
                .items
                .into_iter()
                .map(|env| env.metadata.name)
                .collect();
            return Err(ApiError::BadRequest(format!(
                "spec.subjects names the group '{group}', and no Group manifest declares it; \
                 propose the group first, or a binding to it matches nobody (PF-62, PF-64). \
                 Declared: {}",
                if declared.is_empty() {
                    "none".to_owned()
                } else {
                    declared.join(", ")
                }
            )));
        }
    }
    Ok(())
}

/// A change to the organization's access, as the PF-03 guard reads it: a manifest written, or
/// one removed.
pub enum AccessChange<'a> {
    Write(&'a Value),
    Remove {
        kind: &'a str,
        namespace: &'a str,
        name: &'a str,
    },
}

/// PF-03: the organization keeps at least one administrator. A change that would take the last
/// one away is refused before anything is written or merged, on every door that writes or removes
/// a `Role` or `RoleBinding`.
///
/// An administrator is who can hand access out and take it back: a binding at organization scope,
/// in force and naming somebody, whose organization role grants `approve` and `delete` on
/// `RoleBinding` with no constraint. The role is read by what it grants rather than by the name
/// `org-admin`, because the taxonomy is a seed an organization extends (PF-56). An organization
/// that has none yet (it runs on the bootstrap group) is not held to it: the guard stops the last
/// one from going, it does not demand a first.
pub fn keeps_an_administrator(mirror: &Mirror, change: AccessChange<'_>) -> Result<(), ApiError> {
    keeps_an_administrator_after(mirror, &[change])
}

/// [`keeps_an_administrator`] for several access changes that land together, judged on the state
/// after all of them: two removals that each leave an administrator can together leave none.
pub fn keeps_an_administrator_after(
    mirror: &Mirror,
    changes: &[AccessChange<'_>],
) -> Result<(), ApiError> {
    let mut roles: BTreeMap<String, Value> = mirror
        .list(ORG_NAMESPACE, "Role", &ListOptions::default())
        .items
        .into_iter()
        .map(|env| (env.metadata.name, env.spec))
        .collect();
    let mut bindings: BTreeMap<String, Value> = mirror
        .list(ORG_NAMESPACE, "RoleBinding", &ListOptions::default())
        .items
        .into_iter()
        .map(|env| (env.metadata.name, env.spec))
        .collect();
    let now = Utc::now();
    let before = administrators(&roles, &bindings, now);
    if before.is_empty() {
        return Ok(());
    }
    let mut touched = false;
    for change in changes {
        let (kind, namespace, name, written) = match change {
            AccessChange::Write(manifest) => (
                manifest
                    .get("kind")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                manifest
                    .pointer("/metadata/namespace")
                    .and_then(Value::as_str)
                    .unwrap_or(ORG_NAMESPACE),
                manifest
                    .pointer("/metadata/name")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                manifest.get("spec").cloned(),
            ),
            AccessChange::Remove {
                kind,
                namespace,
                name,
            } => (*kind, *namespace, *name, None),
        };
        if !matches!(kind, "Role" | "RoleBinding") || !matches!(namespace, ORG_NAMESPACE | "") {
            continue;
        }
        touched = true;
        let table = if kind == "Role" {
            &mut roles
        } else {
            &mut bindings
        };
        match written {
            Some(spec) => table.insert(name.to_owned(), spec),
            None => table.remove(name),
        };
    }
    if touched && administrators(&roles, &bindings, now).is_empty() {
        return Err(ApiError::Conflict(format!(
            "this change would leave the organization without an administrator: after it, no \
             binding at organization scope grants approve and delete on RoleBinding (today: {}). \
             Bind another person to such a role first, then make this change (PF-03)",
            before.join(", ")
        )));
    }
    Ok(())
}

/// Every person an administrator binding names, directly or through a `Group` they are in, by
/// lower-case e-mail (PF-03): who would be left to run the organization.
pub fn administrator_people(mirror: &Mirror) -> BTreeSet<String> {
    let table = |kind: &str| -> BTreeMap<String, Value> {
        mirror
            .list(ORG_NAMESPACE, kind, &ListOptions::default())
            .items
            .into_iter()
            .map(|env| (env.metadata.name, env.spec))
            .collect()
    };
    let roles = table("Role");
    let bindings = table("RoleBinding");
    let groups = table("Group");
    let mut people = BTreeSet::new();
    for name in administrators(&roles, &bindings, Utc::now()) {
        let Some(binding) = bindings
            .get(&name)
            .and_then(|spec| serde_json::from_value::<RoleBindingSpec>(spec.clone()).ok())
        else {
            continue;
        };
        for subject in binding.subjects {
            if let Some(user) = subject.user {
                people.insert(user.to_ascii_lowercase());
            }
            if let Some(group) = subject.group.and_then(|group| groups.get(&group).cloned()) {
                let members = serde_json::from_value::<jc_core::kinds::GroupSpec>(group)
                    .map(|spec| spec.members)
                    .unwrap_or_default();
                people.extend(members.into_iter().map(|m| m.user.to_ascii_lowercase()));
            }
        }
    }
    people
}

/// The organization bindings that make somebody an administrator, by name (PF-03).
fn administrators(
    roles: &BTreeMap<String, Value>,
    bindings: &BTreeMap<String, Value>,
    now: DateTime<Utc>,
) -> Vec<String> {
    let administers = |role: &str| {
        roles
            .get(role)
            .and_then(|spec| serde_json::from_value::<RoleSpec>(spec.clone()).ok())
            .is_some_and(|spec| {
                spec.rules.iter().any(|rule| {
                    rule.constraints.is_empty()
                        && rule.kinds.iter().any(|kind| kind == "RoleBinding")
                        && rule.verbs.contains(&Verb::Approve)
                        && rule.verbs.contains(&Verb::Delete)
                })
            })
    };
    bindings
        .iter()
        .filter_map(|(name, spec)| {
            let binding: RoleBindingSpec = serde_json::from_value(spec.clone()).ok()?;
            let in_force = binding.validity.as_ref().is_none_or(|v| v.contains(now));
            (binding.scope.organization.is_some()
                && !binding.subjects.is_empty()
                && in_force
                && administers(&binding.role))
            .then(|| name.clone())
        })
        .collect()
}

/// Nobody grants above their own rights (PF-52, AG-77): every verb on every kind a proposed
/// `Role` (on the organization), `RoleBinding` (on its scope) or `ServiceAccount` (through each of
/// its roles the organization defines, on that role's scope) would grant must be one `identity`
/// holds there, under no constraint the new rule drops. `who` is "proposer" or "approver"; any
/// other kind and the bootstrap group pass.
pub fn within_own_rights(
    state: &AppState,
    identity: &Identity,
    manifest: &Value,
    who: &str,
) -> Result<(), ApiError> {
    let mirror = &state.mirror;
    // PF-64: a subject that names a group names a `Group` manifest. Checked here because this
    // is the gate every door to a `users/` manifest passes through — the resource route, an
    // import, a blueprint and an approval.
    subjects_name_a_group(mirror, manifest)?;
    keeps_an_administrator(mirror, AccessChange::Write(manifest))?;
    let spec = manifest.get("spec").cloned().unwrap_or(Value::Null);
    let unreadable = |e: serde_json::Error| ApiError::BadRequest(format!("spec: {e}"));
    let no_scope = || {
        ApiError::BadRequest("spec.scope names no organization, project or context space".into())
    };
    let organization = roles(mirror, ORG_NAMESPACE);
    // The role a manifest names, read where that manifest reaches it: a binding at project
    // scope may name the project's own role, an organization one may not (PF-69).
    let rules_at = |name: &str, target: &Reach| {
        role_of(mirror, &organization, target, name).map(|(_, spec)| spec.rules)
    };
    let (noun, grants): (&str, Vec<(Vec<Rule>, Reach)>) =
        match manifest.get("kind").and_then(Value::as_str) {
            Some("Role") => {
                let role: RoleSpec = serde_json::from_value(spec).map_err(unreadable)?;
                // A role of a project is measured against what its proposer holds in that project,
                // an organization role against what they hold organization-wide (PF-68).
                let namespace = manifest
                    .pointer("/metadata/namespace")
                    .and_then(Value::as_str)
                    .unwrap_or(ORG_NAMESPACE);
                let at = match namespace {
                    ORG_NAMESPACE | "" => Reach::Organization,
                    project => Reach::Project(project.to_owned()),
                };
                ("role", vec![(role.rules, at)])
            }
            Some("RoleBinding") => {
                let binding: RoleBindingSpec = serde_json::from_value(spec).map_err(unreadable)?;
                let target = Reach::of(&binding.scope).ok_or_else(no_scope)?;
                let rules = rules_at(&binding.role, &target).ok_or_else(|| {
                    ApiError::Denied(format!(
                        "no role {} is defined where this binding applies; propose the role \
                     before a binding to it (PF-52, PF-69)",
                        binding.role
                    ))
                })?;
                ("binding", vec![(rules, target)])
            }
            // A service account's other roles are the gateway's role templates, which grant data
            // access through Policies and nothing here (CC-60).
            Some("ServiceAccount") => {
                let account: ServiceAccountSpec =
                    serde_json::from_value(spec).map_err(unreadable)?;
                let mut grants = Vec::new();
                for granted in &account.roles {
                    let target = Reach::of(&granted.scope).ok_or_else(no_scope)?;
                    if let Some(rules) = rules_at(&granted.role, &target) {
                        grants.push((rules, target));
                    }
                }
                ("service account", grants)
            }
            _ => return Ok(()),
        };
    if in_group(identity, &state.config.bootstrap_admins) {
        return Ok(());
    }
    let held = in_force(mirror, identity, Utc::now());
    let mut missing: Vec<String> = Vec::new();
    for (rules, target) in &grants {
        for rule in rules {
            for kind in &rule.kinds {
                for verb in &rule.verbs {
                    // `Rule::grants`, so `propose` holds `read` here as it does at every door:
                    // an administrator who proposes a kind may hand out reading it (PF-59).
                    let holds = held.iter().any(|(reach, grant)| {
                        reach.covers(target, mirror)
                            && grant.rule.grants(kind, *verb)
                            && grant
                                .rule
                                .constraints
                                .iter()
                                .all(|c| rule.constraints.contains(c))
                    });
                    let item = format!("{} on {kind}", verb_name(*verb));
                    if !holds && !missing.contains(&item) {
                        missing.push(item);
                    }
                }
            }
        }
    }
    if missing.is_empty() {
        return Ok(());
    }
    Err(ApiError::Denied(format!(
        "a {noun} may not grant more than its {who} holds: missing {} (PF-52)",
        missing.join(", ")
    )))
}

fn in_group(identity: &Identity, group: &str) -> bool {
    // Keycloak realm roles count as groups here: the dev realm assigns people through them
    // and a realm role, like a group, says who somebody is, not what they may do (PF-50).
    identity.groups.iter().any(|g| g == group) || identity.roles.iter().any(|r| r == group)
}

fn is_subject(identity: &Identity, subject: &jc_core::kinds::Subject) -> bool {
    if let Some(user) = &subject.user {
        return identity
            .email
            .as_deref()
            .is_some_and(|e| e.eq_ignore_ascii_case(user))
            || identity.username.eq_ignore_ascii_case(user)
            || identity.subject == *user;
    }
    subject
        .group
        .as_deref()
        .is_some_and(|g| in_group(identity, g))
}

/// `spec.contextSpaceRef` of a manifest, written bare or as `{ name }`.
/// The audience of the manifest under approval, when it has one (EP-14).
fn audience_of(target: Option<&Value>) -> Option<&str> {
    target?.pointer("/spec/audience")?.as_str()
}

pub fn space_ref(target: &Value) -> Option<String> {
    let value = target.pointer("/spec/contextSpaceRef")?;
    value
        .as_str()
        .or_else(|| value.get("name").and_then(Value::as_str))
        .map(str::to_owned)
}

/// The value at a dotted path of the manifest, as text; `None` when absent or structured.
fn field_text(target: Option<&Value>, path: &str) -> Option<String> {
    let mut cursor = target?;
    for segment in path.split('.') {
        cursor = cursor.get(segment)?;
    }
    match cursor {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// Whether `rule` is the build lane's: `propose` on `App` constrained to `status.build`, which
/// names the field's writer and carries no operator (AP-73, jc-core `Rule::writes_status_only`).
fn writes_status_only(rule: &Rule) -> bool {
    rule.constraints.iter().any(|c| c.field == "status.build")
}

/// jc-core reads the operators, so the Portal and the forge's `roles.rego` agree (PF-51).
fn satisfied(constraint: &Constraint, target: Option<&Value>) -> bool {
    constraint.holds(field_text(target, &constraint.field).as_deref())
}

fn describe(constraint: &Constraint) -> String {
    if let Some(expected) = &constraint.equals {
        format!("must equal {expected}")
    } else if let Some(pattern) = &constraint.pattern {
        format!("must match {pattern}")
    } else if !constraint.one_of.is_empty() {
        format!("must be one of {}", constraint.one_of.join(", "))
    } else {
        format!("must not be one of {}", constraint.not_in.join(", "))
    }
}

pub fn verb_name(verb: Verb) -> &'static str {
    verb.as_str()
}
