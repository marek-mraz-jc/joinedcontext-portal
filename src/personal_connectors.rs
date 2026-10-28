//! The one move of the old personal connectors (UI-98, kept in a person's preferences and served
//! at `/api/mcp/me/{name}`) into the connector store (API/14, T-5970), so one store holds every
//! connector. Each old one becomes a `data-read` connector of the same name, read-only, for the
//! default ceiling's days, whose scope reaches no more than its selector did: a selector of only
//! projects or spaces keeps them as items, any other is resolved today to the Endpoints it took.
//! The old list then leaves the preferences document.

use chrono::{Duration, Utc};
use jc_core::kinds::Audience;
use jc_core::kinds::EndpointSpec;
use jc_core::reach::EndpointFacts;
use serde::Deserialize;
use serde_json::Value;

use crate::connectors::{ItemAccess, NewConnector, ScopeItem, DEFAULT_CEILING};
use crate::error::ApiError;
use crate::state::AppState;
use crate::store::Mirror;

/// The preferences key the old connectors lived under.
const KEY: &str = "connectors";
/// Scope items a connector may carry (connectors::validate).
const MAX_SCOPE: usize = 50;

/// An old personal connector as preferences held it.
#[derive(Debug, Clone, Deserialize)]
pub struct Old {
    pub name: String,
    #[serde(default)]
    pub select: OldSelect,
}

/// The old selector: an Endpoint matched when it matched every field given.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OldSelect {
    #[serde(default)]
    pub projects: Vec<String>,
    #[serde(default)]
    pub spaces: Vec<String>,
    #[serde(default)]
    pub domains: Vec<String>,
    #[serde(default)]
    pub themes: Vec<String>,
    #[serde(default)]
    pub access_level: Vec<String>,
    #[serde(default)]
    pub endpoints: Vec<String>,
}

/// What one person's move did.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Moved {
    /// Old connectors now in the store.
    pub moved: usize,
    /// Old connectors refused as a conflict: their name is live already (a second Portal moved
    /// them first), or the person holds the most live connectors.
    pub present: usize,
    /// Old connectors whose selector takes no Endpoint today: nothing to reach, nothing kept.
    pub empty: usize,
}

/// Whether an Endpoint's audience passes the old `accessLevel`. A project Endpoint passes only
/// when both `project` and `grant` were picked: which of the two a person reads it by is known
/// per call only, so one of them alone keeps it out rather than letting the other in.
fn level_passes(levels: &[String], audience: Audience) -> bool {
    let has = |level: &str| levels.iter().any(|l| l == level);
    levels.is_empty()
        || match audience {
            Audience::Public => has("public"),
            Audience::Organization => has("organization"),
            Audience::ProjectList => has("project") && has("grant"),
        }
}

/// Whether the old selector took `e`, `accessLevel` judged by [`level_passes`].
fn takes(select: &OldSelect, e: &EndpointFacts) -> bool {
    fn any(wanted: &[String], has: impl Fn(&String) -> bool) -> bool {
        wanted.is_empty() || wanted.iter().any(has)
    }
    let space = format!("{}/{}", e.project, e.space);
    any(&select.projects, |p| *p == e.project)
        && any(&select.spaces, |s| *s == space)
        && any(&select.endpoints, |s| *s == e.slug)
        && any(&select.domains, |d| e.domains.contains(d))
        && any(&select.themes, |t| {
            e.themes.iter().any(|theme| {
                serde_json::to_value(theme)
                    .ok()
                    .as_ref()
                    .and_then(Value::as_str)
                    == Some(t)
            })
        })
        && level_passes(&select.access_level, e.audience)
}

fn item(project: &str) -> ScopeItem {
    ScopeItem {
        project: project.to_owned(),
        space: None,
        endpoint: None,
        pipeline: None,
        access: ItemAccess::Read,
    }
}

/// Every Endpoint of the mirror as the facts a selector reads.
fn facts(mirror: &Mirror) -> Vec<EndpointFacts> {
    let mut facts: Vec<EndpointFacts> = mirror
        .matching(|env| env.kind == "Endpoint")
        .into_iter()
        .filter_map(|env| {
            let project = env.metadata.namespace?;
            let spec: EndpointSpec = serde_json::from_value(env.spec).ok()?;
            let types = crate::api::assistant_context::model_classes(
                mirror,
                &project,
                spec.context_space_ref.name(),
            );
            Some(EndpointFacts::of(
                &project,
                &env.metadata.name,
                &spec,
                types,
            ))
        })
        .collect();
    facts.sort_by(|a, b| a.slug.cmp(&b.slug));
    facts
}

/// The scope reaching no more than `select` did over `endpoints`. Projects and spaces alone stay
/// items (an Endpoint added there later is reached, as it was); anything finer is the Endpoints
/// it takes today. Empty when it takes none; at most [`MAX_SCOPE`] items, the rest left out.
pub fn scope_of(select: &OldSelect, endpoints: &[EndpointFacts]) -> Vec<ScopeItem> {
    let coarse = select.domains.is_empty()
        && select.themes.is_empty()
        && select.access_level.is_empty()
        && select.endpoints.is_empty();
    let mut scope: Vec<ScopeItem> = if coarse && !select.spaces.is_empty() {
        select
            .spaces
            .iter()
            .filter_map(|written| written.split_once('/'))
            .filter(|(p, _)| select.projects.is_empty() || select.projects.iter().any(|q| q == p))
            .map(|(p, space)| ScopeItem {
                space: Some(space.to_owned()),
                ..item(p)
            })
            .collect()
    } else if coarse {
        let mut projects: Vec<String> = if select.projects.is_empty() {
            endpoints.iter().map(|e| e.project.clone()).collect()
        } else {
            select.projects.clone()
        };
        projects.sort();
        projects.dedup();
        projects.iter().map(|p| item(p)).collect()
    } else {
        endpoints
            .iter()
            .filter(|e| takes(select, e))
            .map(|e| ScopeItem {
                endpoint: Some(e.name.clone()),
                ..item(&e.project)
            })
            .collect()
    };
    scope.truncate(MAX_SCOPE);
    scope
}

/// The new connector an old one becomes, `None` when its selector takes nothing today.
pub fn adopted(old: &Old, endpoints: &[EndpointFacts]) -> Option<NewConnector> {
    let scope = scope_of(&old.select, endpoints);
    (!scope.is_empty()).then(|| NewConnector {
        name: old.name.clone(),
        segments: vec!["data-read".to_owned()],
        scope,
        writes: false,
        expires_at: Utc::now() + Duration::days(DEFAULT_CEILING.max_days),
        allowed_clients: Vec::new(),
    })
}

fn db_error(err: sqlx::Error) -> ApiError {
    tracing::error!(error = %err, "moving personal connectors: database call failed");
    ApiError::Internal("the preferences database did not answer".into())
}

/// Moves `subject`'s old connectors into the store and drops them from their preferences. Answers
/// 503 while the mirror holds no Endpoints yet (a selector would resolve to nothing); does nothing
/// without a database or old connectors.
pub async fn move_one(state: &AppState, subject: &str) -> Result<Moved, ApiError> {
    let Some(pool) = state.db.as_ref() else {
        return Ok(Moved::default());
    };
    let Some(mut doc) = crate::db::load_preferences(pool, subject)
        .await
        .map_err(db_error)?
    else {
        return Ok(Moved::default());
    };
    if doc.get(KEY).is_none() {
        return Ok(Moved::default());
    }
    if state.mirror.is_empty() {
        // Before the first mirror a selector resolves to nothing: wait rather than lose it.
        return Err(ApiError::Unavailable(
            "your connectors are being moved to the connector store; try again in a minute".into(),
        ));
    }
    let old = doc
        .as_object_mut()
        .and_then(|o| o.remove(KEY))
        .unwrap_or_default();
    let old: Vec<Old> = serde_json::from_value(old).unwrap_or_default();
    let endpoints = facts(&state.mirror);
    let base = crate::api::connectors::base(state);
    let mut moved = Moved::default();
    for one in &old {
        let Some(new) = adopted(one, &endpoints) else {
            tracing::info!(connector = %one.name, "an old personal connector takes no Endpoint today; not moved");
            moved.empty += 1;
            continue;
        };
        match state.connectors.create(subject, new, &base).await {
            Ok(_) => moved.moved += 1,
            // Its name is live already (another Portal moved it), or the person holds the most
            // live connectors: the old one is not kept, and the log says which.
            Err(ApiError::Conflict(why)) => {
                tracing::info!(connector = %one.name, %why, "an old personal connector was not moved");
                moved.present += 1;
            }
            Err(other) => return Err(other),
        }
    }
    crate::db::save_preferences(pool, subject, &doc)
        .await
        .map_err(db_error)?;
    Ok(moved)
}

/// Moves every person's old connectors, once the mirror holds the Endpoints; logs the counts the
/// deployer compares with the count before (T-5970).
pub async fn move_all(state: &AppState) -> Result<Moved, ApiError> {
    let Some(pool) = state.db.as_ref() else {
        return Ok(Moved::default());
    };
    let (old,): (i64,) = sqlx::query_as(
        "SELECT coalesce(sum(jsonb_array_length(preferences -> 'connectors')), 0)::bigint \
         FROM user_preferences WHERE jsonb_typeof(preferences -> 'connectors') = 'array'",
    )
    .fetch_one(pool)
    .await
    .map_err(db_error)?;
    let subjects: Vec<String> =
        sqlx::query_scalar("SELECT subject FROM user_preferences WHERE preferences ? 'connectors'")
            .fetch_all(pool)
            .await
            .map_err(db_error)?;
    let mut total = Moved::default();
    for subject in &subjects {
        let one = move_one(state, subject).await?;
        total.moved += one.moved;
        total.present += one.present;
        total.empty += one.empty;
    }
    tracing::info!(
        old,
        people = subjects.len(),
        moved = total.moved,
        present = total.present,
        empty = total.empty,
        "old personal connectors moved into the connector store"
    );
    Ok(total)
}

/// Waits for the first mirror, then runs [`move_all`] once.
pub async fn move_when_ready(state: AppState) {
    while state.mirror.is_empty() {
        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
    }
    if let Err(error) = move_all(&state).await {
        tracing::warn!(%error, "old personal connectors were not moved; the next start tries again");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jc_core::kinds::catalog::DataTheme;
    use std::collections::BTreeSet;

    fn endpoint(
        project: &str,
        name: &str,
        space: &str,
        audience: Audience,
        theme: Option<DataTheme>,
    ) -> EndpointFacts {
        EndpointFacts {
            project: project.into(),
            name: name.into(),
            slug: format!("slug-{name}"),
            space: space.into(),
            audience,
            types: BTreeSet::new(),
            domains: BTreeSet::new(),
            themes: theme.into_iter().collect(),
        }
    }

    fn catalogue() -> Vec<EndpointFacts> {
        vec![
            endpoint(
                "doprava",
                "buses",
                "transit",
                Audience::Public,
                Some(DataTheme::Tran),
            ),
            endpoint(
                "doprava",
                "counts",
                "transit",
                Audience::ProjectList,
                Some(DataTheme::Tran),
            ),
            endpoint(
                "ovzdusie",
                "air",
                "air",
                Audience::Organization,
                Some(DataTheme::Envi),
            ),
        ]
    }

    fn select(value: Value) -> OldSelect {
        serde_json::from_value(value).expect("an old selector")
    }

    fn named(scope: &[ScopeItem]) -> Vec<String> {
        scope
            .iter()
            .map(|i| {
                let narrowed = i
                    .space
                    .as_deref()
                    .map(|s| format!("space {s}"))
                    .or_else(|| i.endpoint.as_deref().map(|e| format!("endpoint {e}")))
                    .unwrap_or_else(|| "all".into());
                format!("{} {narrowed}", i.project)
            })
            .collect()
    }

    #[test]
    fn projects_and_spaces_alone_stay_items() {
        let c = catalogue();
        assert_eq!(
            named(&scope_of(&select(serde_json::json!({})), &c)),
            ["doprava all", "ovzdusie all"]
        );
        assert_eq!(
            named(&scope_of(
                &select(serde_json::json!({"projects": ["doprava"]})),
                &c
            )),
            ["doprava all"]
        );
        assert_eq!(
            named(&scope_of(
                &select(
                    serde_json::json!({"projects": ["ovzdusie"], "spaces": ["doprava/transit", "ovzdusie/air"]})
                ),
                &c
            )),
            ["ovzdusie space air"]
        );
    }

    #[test]
    fn a_finer_selector_becomes_the_endpoints_it_takes_today() {
        let c = catalogue();
        assert_eq!(
            named(&scope_of(
                &select(serde_json::json!({"themes": ["TRAN"]})),
                &c
            )),
            ["doprava endpoint buses", "doprava endpoint counts"]
        );
        assert_eq!(
            named(&scope_of(
                &select(serde_json::json!({"endpoints": ["slug-air"], "projects": ["doprava"]})),
                &c
            )),
            Vec::<String>::new()
        );
        assert_eq!(
            named(&scope_of(
                &select(serde_json::json!({"endpoints": ["slug-air"]})),
                &c
            )),
            ["ovzdusie endpoint air"]
        );
    }

    #[test]
    fn an_access_level_never_lets_more_in() {
        let c = catalogue();
        let only = |levels: Value| {
            named(&scope_of(
                &select(serde_json::json!({"accessLevel": levels})),
                &c,
            ))
        };
        assert_eq!(
            only(serde_json::json!(["public"])),
            ["doprava endpoint buses"]
        );
        assert_eq!(only(serde_json::json!(["project"])), Vec::<String>::new());
        assert_eq!(
            only(serde_json::json!(["project", "grant"])),
            ["doprava endpoint counts"]
        );
        assert_eq!(
            only(serde_json::json!(["organization"])),
            ["ovzdusie endpoint air"]
        );
    }

    #[test]
    fn a_moved_connector_reads_only_for_the_default_days() {
        let old: Old = serde_json::from_value(
            serde_json::json!({"name": "my-air", "select": {"themes": ["ENVI"]}}),
        )
        .expect("an old connector");
        let new = adopted(&old, &catalogue()).expect("it takes one Endpoint");
        assert_eq!(new.name, "my-air");
        assert_eq!(new.segments, ["data-read"]);
        assert!(!new.writes);
        assert!(new.scope.iter().all(|i| i.access == ItemAccess::Read));
        crate::connectors::validate(&new, &DEFAULT_CEILING, Utc::now())
            .expect("within the default ceiling");
        let none: Old = serde_json::from_value(
            serde_json::json!({"name": "x", "select": {"themes": ["AGRI"]}}),
        )
        .expect("an old connector");
        assert!(adopted(&none, &catalogue()).is_none());
    }

    #[test]
    fn a_selector_wider_than_the_cap_is_cut_never_widened() {
        let many: Vec<EndpointFacts> = (0..60)
            .map(|i| endpoint("p", &format!("e{i:02}"), "s", Audience::Public, None))
            .collect();
        let scope = scope_of(
            &select(serde_json::json!({"accessLevel": ["public"]})),
            &many,
        );
        assert_eq!(scope.len(), MAX_SCOPE);
        assert!(scope.iter().all(|i| i.endpoint.is_some()));
    }
}
