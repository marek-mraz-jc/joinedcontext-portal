//! People by Keycloak user id (ADR-N-061, T-5711).
//!
//! A manifest names a person by their Keycloak user id, never by an address. Two doors follow
//! from it: a reviewer who decides on people or groups reads the names behind the ids, and an
//! administrator proposes, once per repository, the Change that rewrites the e-mails older
//! manifests still hold into ids. Git history keeps what it had: the Change rewrites files, not
//! commits.

use std::collections::{BTreeMap, BTreeSet};

use axum::extract::{Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use jc_core::kinds::{Verb, PERSON};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::{IntoParams, ToSchema};

use crate::auth::CurrentUser;
use crate::change::{Change, ChangePhase, ChangeStatus, Lane, PlanSummary};
use crate::error::{ApiError, ProblemDetails};
use crate::git::Author;
use crate::people::KcUser;
use crate::permissions::{is_person_id, ORG_NAMESPACE};
use crate::resource::ResourceEnvelope;
use crate::state::AppState;
use crate::store::Mirror;

/// How many ids one name lookup resolves.
const MAX_IDS: usize = 100;
/// One page of the realm's users while the migration reads them all.
const PAGE: u32 = 500;
/// The kinds whose manifests name people.
const NAMING: [&str; 5] = ["Group", "RoleBinding", "Policy", "App", "Endpoint"];

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct NamesQuery {
    /// Comma-separated Keycloak user ids, at most 100. Optional so the right is checked first.
    #[serde(default)]
    pub ids: String,
}

/// One id and the name of the person behind it.
#[derive(Debug, Serialize, ToSchema)]
pub struct PersonName {
    pub id: String,
    /// First and last name; the e-mail when the realm holds no name.
    pub name: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct PersonNames {
    /// The ids the realm knows; an id it does not know is left out.
    pub items: Vec<PersonName>,
}

/// Who reads names behind ids: a holder of `update` on Person or `approve` on Group (ADR-N-061).
/// Anyone else sees the ids alone.
fn may_resolve(
    state: &AppState,
    identity: &crate::auth::session::Identity,
) -> Result<(), ApiError> {
    let effective = crate::permissions::for_request(state, identity, ORG_NAMESPACE);
    if effective.check(PERSON, Verb::Update, None).is_ok()
        || effective.check("Group", Verb::Approve, None).is_ok()
    {
        return Ok(());
    }
    Err(ApiError::Denied(
        "the names behind people's ids are read by whoever updates people or approves groups; \
         ask an Organization Administrator (ADR-N-061)"
            .into(),
    ))
}

#[utoipa::path(
    get,
    path = "/api/v1/organization/people/names",
    summary = "Resolve Person Names",
    description = "Answers the name behind each Keycloak user id a manifest names. Needs `update` on Person or `approve` on Group.",
    tag = "people",
    params(NamesQuery),
    responses(
        (status = 200, description = "The names of the ids the realm knows", body = PersonNames),
        (status = 403, description = "The caller neither updates people nor approves groups", body = ProblemDetails),
        (status = 422, description = "An id is not a Keycloak user id, or more than 100", body = ProblemDetails),
        (status = 503, description = "No Keycloak admin client", body = ProblemDetails),
    )
)]
pub async fn person_names(
    user: CurrentUser,
    State(state): State<AppState>,
    Query(query): Query<NamesQuery>,
) -> Result<Json<PersonNames>, ApiError> {
    may_resolve(&state, &user.0.identity)?;
    let ids: BTreeSet<&str> = query
        .ids
        .split(',')
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .collect();
    let mut errors: Vec<String> = ids
        .iter()
        .filter(|id| !is_person_id(id))
        .map(|id| format!("ids: '{id}' is not a Keycloak user id (a lower-case UUID)"))
        .collect();
    if ids.len() > MAX_IDS {
        errors.push(format!("ids: at most {MAX_IDS} at once"));
    }
    if !errors.is_empty() {
        return Err(ApiError::Unprocessable {
            detail: "the ids to resolve are not valid".into(),
            errors,
        });
    }
    let admin = super::people::people(&state)?.admin().await?;
    let mut items = Vec::with_capacity(ids.len());
    for id in ids {
        match admin.get(id).await {
            Ok(found) => items.push(PersonName {
                id: found.id.clone(),
                name: name_of(&found),
            }),
            Err(crate::people::PeopleError::NotFound) => {}
            Err(err) => return Err(err.into()),
        }
    }
    Ok(Json(PersonNames { items }))
}

fn name_of(user: &KcUser) -> String {
    let name = format!(
        "{} {}",
        user.first_name.as_deref().unwrap_or_default(),
        user.last_name.as_deref().unwrap_or_default()
    );
    match name.trim() {
        "" => user.email.clone().unwrap_or_else(|| user.username.clone()),
        name => name.to_owned(),
    }
}

#[derive(Debug, Default, Deserialize, IntoParams)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
pub struct MigrateQuery {
    /// `true` answers the plan and proposes nothing.
    #[serde(default)]
    pub dry_run: bool,
}

/// What the migration rewrites in one repository.
#[derive(Debug, Serialize, ToSchema)]
pub struct RepositoryPlan {
    /// `organization`, or the project whose own repository it is.
    pub repository: String,
    /// `Kind namespace/name` of each manifest the Change rewrites.
    pub manifests: Vec<String>,
    /// The Change proposed for it; absent in a dry run.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct MigrationPlan {
    pub repositories: Vec<RepositoryPlan>,
    /// Addresses and usernames no Keycloak user carries: they stay as they are, and the
    /// reconciler leaves a group naming one as the realm holds it until somebody fixes it.
    pub unresolved: Vec<String>,
}

/// The rewrite, per repository: `organization` or a project with its own repository.
#[derive(Debug, Default)]
pub struct Plan {
    pub repositories: BTreeMap<String, Vec<ResourceEnvelope>>,
    pub unresolved: BTreeSet<String>,
}

/// The Keycloak user id a manifest's value names, if it needs one: `None` for a value that is
/// an id already or a `service-account-<client>` user, `Some(Err(()))` for one nobody carries.
fn id_for(value: &str, users: &[KcUser]) -> Option<Result<String, ()>> {
    if is_person_id(value) || value.starts_with("service-account-") {
        return None;
    }
    Some(
        users
            .iter()
            .find(|user| {
                user.email
                    .as_deref()
                    .is_some_and(|email| email.eq_ignore_ascii_case(value))
                    || user.username.eq_ignore_ascii_case(value)
            })
            .map(|user| user.id.clone())
            .ok_or(()),
    )
}

/// Rewrites `slot` (a member's or a subject's `user`, a Policy's assignee `id`) in place.
fn rewrite(slot: &mut Value, users: &[KcUser], unresolved: &mut BTreeSet<String>) -> bool {
    let Some(value) = slot.as_str() else {
        return false;
    };
    match id_for(value, users) {
        Some(Ok(id)) => {
            *slot = Value::String(id);
            true
        }
        Some(Err(())) => {
            unresolved.insert(value.to_ascii_lowercase());
            false
        }
        None => false,
    }
}

/// Every `members[]` and `subjects[]` entry's `user` anywhere in `value`.
fn rewrite_lists(value: &mut Value, users: &[KcUser], unresolved: &mut BTreeSet<String>) -> bool {
    let mut changed = false;
    match value {
        Value::Object(map) => {
            for (key, inner) in map.iter_mut() {
                if matches!(key.as_str(), "members" | "subjects") {
                    for entry in inner.as_array_mut().into_iter().flatten() {
                        if let Some(slot) = entry.get_mut("user") {
                            changed |= rewrite(slot, users, unresolved);
                        }
                    }
                } else {
                    changed |= rewrite_lists(inner, users, unresolved);
                }
            }
        }
        Value::Array(items) => {
            for inner in items {
                changed |= rewrite_lists(inner, users, unresolved);
            }
        }
        _ => {}
    }
    changed
}

/// The manifests of `mirror` that name a person other than by id, rewritten, grouped by the
/// repository that holds them.
pub fn plan(mirror: &Mirror, users: &[KcUser]) -> Plan {
    let mut plan = Plan::default();
    for mut envelope in mirror.matching(|candidate| NAMING.contains(&candidate.kind.as_str())) {
        let changed = if envelope.kind == "Policy" {
            let assignee = envelope.spec.get_mut("assignee");
            match assignee {
                Some(assignee) if assignee.get("kind").and_then(Value::as_str) == Some("user") => {
                    match assignee.get_mut("id") {
                        Some(slot) => rewrite(slot, users, &mut plan.unresolved),
                        None => false,
                    }
                }
                _ => false,
            }
        } else {
            rewrite_lists(&mut envelope.spec, users, &mut plan.unresolved)
        };
        if !changed {
            continue;
        }
        let namespace = envelope
            .metadata
            .namespace
            .clone()
            .unwrap_or_else(|| ORG_NAMESPACE.to_owned());
        let repository = match mirror.repository_of(&namespace) {
            Some(_) if namespace != ORG_NAMESPACE => namespace,
            _ => "organization".to_owned(),
        };
        envelope.strip_status();
        plan.repositories
            .entry(repository)
            .or_default()
            .push(envelope);
    }
    plan
}

fn label(envelope: &ResourceEnvelope) -> String {
    format!(
        "{} {}/{}",
        envelope.kind,
        envelope
            .metadata
            .namespace
            .as_deref()
            .unwrap_or(ORG_NAMESPACE),
        envelope.metadata.name
    )
}

async fn every_user(admin: &crate::people::Admin<'_>) -> Result<Vec<KcUser>, ApiError> {
    let mut users = Vec::new();
    loop {
        let page = admin.list("", users.len() as u32, PAGE).await?;
        let last = page.len() < PAGE as usize;
        users.extend(page);
        if last {
            return Ok(users);
        }
    }
}

#[utoipa::path(
    post,
    path = "/api/v1/organization/people/name-by-id",
    summary = "Name People by Id",
    description = "Proposes, per repository, one Change rewriting every Group member, RoleBinding and role subject and Policy user assignee that names a person by e-mail or username into their Keycloak user id (ADR-N-061), and lists the addresses no user carries. `dryRun=true` answers the plan alone. Needs `update` on Person.",
    tag = "people",
    params(MigrateQuery),
    responses(
        (status = 200, description = "The plan, and the Change of each repository unless a dry run", body = MigrationPlan),
        (status = 403, description = "The caller lacks update on Person, or is not a person", body = ProblemDetails),
        (status = 503, description = "No Keycloak admin client or forge", body = ProblemDetails),
    )
)]
pub async fn name_by_id(
    user: CurrentUser,
    State(state): State<AppState>,
    Query(query): Query<MigrateQuery>,
) -> Result<Json<MigrationPlan>, ApiError> {
    let identity = &user.0.identity;
    super::people::refuse_bearer(identity)?;
    super::people::allow(&state, identity, Verb::Update)?;
    let admin = super::people::people(&state)?.admin().await?;
    let users = every_user(&admin).await?;
    let plan = plan(&state.mirror, &users);
    let mut repositories = Vec::with_capacity(plan.repositories.len());
    for (repository, manifests) in &plan.repositories {
        let change = if query.dry_run {
            None
        } else {
            Some(
                propose(
                    &state,
                    identity,
                    repository,
                    manifests,
                    plan.unresolved.len(),
                )
                .await?,
            )
        };
        repositories.push(RepositoryPlan {
            repository: repository.clone(),
            manifests: manifests.iter().map(label).collect(),
            change,
        });
    }
    Ok(Json(MigrationPlan {
        repositories,
        unresolved: plan.unresolved.into_iter().collect(),
    }))
}

/// One Change in `repository`; its title and body name counts, never a person.
async fn propose(
    state: &AppState,
    identity: &crate::auth::session::Identity,
    repository: &str,
    manifests: &[ResourceEnvelope],
    unresolved: usize,
) -> Result<String, ApiError> {
    let namespace = if repository == "organization" {
        ORG_NAMESPACE
    } else {
        repository
    };
    let gitea = state
        .forge_for(namespace)
        .ok_or_else(|| ApiError::Unavailable("git forge is not configured".into()))?;
    let default_branch = gitea.default_branch().await?;
    let branch = crate::api::mutate::create_or_reuse_branch(
        &gitea,
        "portal/name-people-by-id",
        &default_branch,
    )
    .await?;
    let mut uploads = Vec::with_capacity(manifests.len());
    for envelope in manifests {
        let info = crate::resource::by_kind(&envelope.kind).ok_or_else(|| {
            ApiError::Internal(format!("no catalogue entry for {}", envelope.kind))
        })?;
        let path = crate::api::mutate::resolve_repo_path(
            envelope,
            info,
            envelope
                .metadata
                .namespace
                .as_deref()
                .unwrap_or(ORG_NAMESPACE),
        )?;
        let yaml = serde_norway::to_string(envelope)
            .map_err(|e| ApiError::Internal(format!("serialize manifest to yaml: {e}")))?;
        uploads.push((path, yaml));
    }
    let (author_name, author_email) = crate::api::mutate::author_credentials(identity, namespace);
    let title = "name people by their Keycloak user id (ADR-N-061)";
    gitea
        .change_files(
            &branch,
            title,
            Author {
                name: &author_name,
                email: &author_email,
            },
            &uploads,
            &[],
        )
        .await?;
    let body = format!(
        "Proposed via joinedcontext Portal. Rewrites {} manifest(s) that named a person by \
         e-mail or username into the person's Keycloak user id (ADR-N-061). {unresolved} \
         address(es) no user carries stay as they are; the People page lists them to its \
         administrators. The history keeps the old text.",
        uploads.len()
    );
    let pr = gitea
        .create_pull_request(&branch, &default_branch, title, &body)
        .await?;
    let meta = crate::api::changes::change_meta(state, &gitea, pr.number, namespace);
    let change = Change::new(
        meta,
        ChangeStatus::new(
            Lane::Red,
            ChangePhase::PendingApproval,
            PlanSummary::new(0, uploads.len(), 0),
        )
        .in_repository(&pr.repository)
        .proposed_through(&pr.body)
        .with_merge_request(pr.url.clone()),
    );
    Ok(change.metadata.name)
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/organization/people/names", get(person_names))
        .route("/organization/people/name-by-id", post(name_by_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resource::{ObjectMeta, API_VERSION};
    use serde_json::json;

    const JANA: &str = "00000000-0000-4000-8000-00000000000a";

    fn user(id: &str, email: &str, username: &str) -> KcUser {
        serde_json::from_value(json!({ "id": id, "email": email, "username": username }))
            .expect("user")
    }

    fn envelope(kind: &str, name: &str, namespace: &str, spec: Value) -> ResourceEnvelope {
        ResourceEnvelope {
            api_version: API_VERSION.to_owned(),
            kind: kind.to_owned(),
            metadata: ObjectMeta::new(name, namespace),
            spec,
            status: None,
        }
    }

    #[test]
    fn the_dry_run_rewrites_each_address_to_its_id_per_repository_and_lists_the_unknown() {
        let mirror = Mirror::new();
        mirror.upsert(envelope(
            "Group",
            "leads",
            ORG_NAMESPACE,
            json!({ "members": [{ "user": "Jana@hel.fi" }, { "user": "nobody@hel.fi" }, { "user": JANA }] }),
        ));
        mirror.upsert(envelope(
            "RoleBinding",
            "ci",
            ORG_NAMESPACE,
            json!({ "subjects": [{ "user": "service-account-jc-build-lane" }, { "group": "leads" }], "role": "r", "scope": {} }),
        ));
        mirror.upsert(envelope(
            "Policy",
            "upload",
            "helsinki",
            json!({ "assignee": { "kind": "user", "id": "jana" } }),
        ));
        mirror.upsert(envelope(
            "App",
            "kpis",
            "helsinki",
            json!({ "access": [{ "role": "viewer", "subjects": [{ "user": "jana@hel.fi" }] }] }),
        ));
        let users = [user(JANA, "jana@hel.fi", "jana")];

        let plan = plan(&mirror, &users);

        // A namespace without a repository of its own lives in the organization's.
        let organization = &plan.repositories["organization"];
        let kinds: Vec<&str> = organization.iter().map(|e| e.kind.as_str()).collect();
        assert_eq!(
            kinds.len(),
            3,
            "the binding names nobody by address: {kinds:?}"
        );
        let of = |kind: &str| organization.iter().find(|e| e.kind == kind).expect(kind);
        assert_eq!(
            of("Group").spec["members"],
            json!([{ "user": JANA }, { "user": "nobody@hel.fi" }, { "user": JANA }])
        );
        assert_eq!(of("Policy").spec["assignee"]["id"], JANA);
        assert_eq!(of("App").spec["access"][0]["subjects"][0]["user"], JANA);
        assert_eq!(
            plan.unresolved.into_iter().collect::<Vec<_>>(),
            vec!["nobody@hel.fi".to_owned()]
        );
    }

    #[test]
    fn a_project_with_its_own_repository_gets_its_own_change_and_ids_are_left_alone() {
        let mirror = Mirror::new();
        mirror.set_repositories([("helsinki".to_owned(), "helsinki-config".to_owned())].into());
        mirror.upsert(envelope(
            "Policy",
            "upload",
            "helsinki",
            json!({ "assignee": { "kind": "user", "id": "jana@hel.fi" } }),
        ));
        mirror.upsert(envelope(
            "Group",
            "done",
            ORG_NAMESPACE,
            json!({ "members": [{ "user": JANA }] }),
        ));
        let plan = plan(&mirror, &[user(JANA, "jana@hel.fi", "jana")]);
        assert_eq!(
            plan.repositories.keys().collect::<Vec<_>>(),
            vec!["helsinki"]
        );
        assert!(plan.unresolved.is_empty());
    }
}
