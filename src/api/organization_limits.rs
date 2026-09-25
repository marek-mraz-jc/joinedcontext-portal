//! `GET /api/v1/organization/limits`: what Organization settings shows for every policy and limit
//! (PF-96…PF-102, ADR-N-035; API/01 §28). The catalog of jc-core with the operator's bound on each
//! entry, the value the Organization sets and where it comes from, and each readable project's
//! quota with what it uses.

use std::collections::BTreeMap;

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use jc_core::kinds::org_settings::{BoundKind, CATALOG};
use jc_core::kinds::OrganizationSpec;
use serde::Serialize;
use utoipa::ToSchema;

use crate::auth::session::CurrentUser;
use crate::error::ApiError;
use crate::permissions::ORG_NAMESPACE;
use crate::state::AppState;
use crate::store::ListOptions;

/// Where a value in force comes from (PF-101).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum LimitOrigin {
    /// The Project's own `spec.quotas`.
    Project,
    /// The Organization manifest.
    Organization,
    /// Nothing sets it: the catalog's default.
    Default,
}

/// One entry of the catalog as the settings page shows it (PF-102).
#[derive(Debug, Serialize, ToSchema)]
pub struct LimitEntry {
    /// The manifest path, e.g. `spec.limits.edge.requestsPerMinute.web`.
    pub path: String,
    /// The settings section: `projects`, `applications`, `edge`, `signIn`, `people`, `agents`,
    /// `pipelinesAndData`.
    pub section: String,
    /// Whether the operator may only tighten the bound (ADR-N-035 §3.2).
    pub security: bool,
    /// The catalog's default; `null` is no limit.
    pub default: Option<u32>,
    /// The smallest value the organization may set.
    pub min: u32,
    /// The largest value the organization may set; `null` where nobody sets a ceiling.
    pub max: Option<u32>,
    /// What the Organization manifest sets; `null` when it sets nothing.
    pub value: Option<u32>,
    /// `organization` or `default`.
    pub origin: LimitOrigin,
}

/// One quota dimension of a project.
#[derive(Debug, Serialize, ToSchema)]
pub struct QuotaUse {
    /// `null` is no limit.
    pub limit: Option<u32>,
    /// The manifest count for a countable dimension (PF-75); `null` for a runtime limit.
    pub used: Option<u32>,
}

/// The quota in force for one project the caller may read.
#[derive(Debug, Serialize, ToSchema)]
pub struct ProjectQuota {
    pub project: String,
    pub origin: LimitOrigin,
    pub quota: BTreeMap<String, QuotaUse>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct OrganizationLimits {
    pub entries: Vec<LimitEntry>,
    pub projects: Vec<ProjectQuota>,
}

/// The section's name as the page and the API spell it: jc-core's own serialization.
fn section_name(section: jc_core::kinds::org_settings::Section) -> String {
    serde_json::to_value(section)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default()
}

#[utoipa::path(
    get,
    path = "/api/v1/organization/limits",
    summary = "Read Organization Limits",
    description = "Every policy and limit of the catalog with the operator's bound, the value in force and where it comes from, and the quota of each project the caller may read (PF-96…PF-102, ADR-N-035).",
    tag = "system",
    responses(
        (status = 200, description = "The catalog and the values in force", body = OrganizationLimits),
        (status = 401, description = "Not signed in", body = crate::error::ProblemDetails),
    )
)]
pub async fn get_limits(
    user: CurrentUser,
    State(state): State<AppState>,
) -> Result<Json<OrganizationLimits>, ApiError> {
    let organization = state
        .mirror
        .list(ORG_NAMESPACE, "Organization", &ListOptions::default())
        .items
        .into_iter()
        .find_map(|envelope| serde_json::from_value::<OrganizationSpec>(envelope.spec).ok());
    let bounds = &state.config.organization_bounds;
    let entries = CATALOG
        .iter()
        .map(|entry| {
            let (min, max) = bounds.range(entry);
            let value = organization
                .as_ref()
                .and_then(|spec| spec.setting(entry.path));
            LimitEntry {
                path: entry.path.to_owned(),
                section: section_name(entry.section),
                security: entry.kind == BoundKind::Security,
                default: entry.default,
                min,
                max,
                value,
                origin: if value.is_some() {
                    LimitOrigin::Organization
                } else {
                    LimitOrigin::Default
                },
            }
        })
        .collect();

    let identity = &user.0.identity;
    let organization_set = organization
        .as_ref()
        .and_then(|spec| spec.projects.quota.as_ref())
        .is_some();
    // A BTreeSet: the rows come out ordered by name.
    let projects: Vec<ProjectQuota> = state
        .mirror
        .namespaces()
        .into_iter()
        .filter(|project| project != ORG_NAMESPACE)
        .chain(
            state
                .mirror
                .list(ORG_NAMESPACE, "Project", &ListOptions::default())
                .items
                .into_iter()
                .map(|envelope| envelope.metadata.name),
        )
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        // A project the caller may not read is left out, so nothing of its size is said (R20).
        .filter(|project| {
            crate::permissions::for_request(&state, identity, project).may_read_project()
        })
        .map(|project| {
            let own = state
                .mirror
                .get(ORG_NAMESPACE, "Project", &project)
                .is_some_and(|envelope| envelope.spec.get("quotas").is_some());
            let quotas = crate::quotas::effective(&state.mirror, &project);
            let used = crate::quotas::usage(&state.mirror, &project);
            let quota = quotas
                .dimensions()
                .into_iter()
                .map(|(dimension, limit)| {
                    let used = used.get(dimension).copied();
                    (dimension.to_owned(), QuotaUse { limit, used })
                })
                .collect();
            ProjectQuota {
                origin: if own {
                    LimitOrigin::Project
                } else if organization_set {
                    LimitOrigin::Organization
                } else {
                    LimitOrigin::Default
                },
                project,
                quota,
            }
        })
        .collect();
    Ok(Json(OrganizationLimits { entries, projects }))
}

pub fn router() -> Router<AppState> {
    Router::new().route("/organization/limits", get(get_limits))
}
