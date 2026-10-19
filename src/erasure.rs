//! The data subject's erasure in a space (API/01 §46, DM-126, DM-127, ADR-N-054 §2.6, T-4668).
//!
//! An erasure is a row of `erasures`, the erasure log: the subject's keyed hash, never the
//! value, the Entities that named the subject, grouped by class with the Attributes that hold
//! their personal data, and one state per store the erasure reaches. The request answers at
//! once; each store is asked then and again every minute until it reports done, so a store that
//! is down keeps the erasure open instead of finishing it early. After [`MAX_ATTEMPTS`] a store
//! is `failed` and the erasure stays open for a person to read why.
//!
//! The stores: the broker (current state, every version, dead letters; it keeps its own record
//! and applies it again after a restore), the Portal's own copies (the trash, the comments), the
//! CKAN DataStore tables (asked by the reconciler, which holds the catalogue credentials), the
//! assistant's stored conversations, and the export files and entity caches, which this platform
//! does not keep: the gateway streams `file.csv` and answers every read `private`.

use std::collections::BTreeMap;

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use sqlx::PgPool;

use crate::state::AppState;

/// Every store an erasure reaches, in the order a person reads them.
pub const STORES: [&str; 6] = [
    "broker",
    "portal",
    "ckanDatastore",
    "conversations",
    "exports",
    "caches",
];
/// The store the reconciler asks, with the catalogue credentials only it resolves.
pub const CKAN: &str = "ckanDatastore";
/// How often a store is asked before it is `failed`: an hour of the minute loop.
pub const MAX_ATTEMPTS: u32 = 60;
/// The longest subject value or reason a request carries.
pub const MAX_SUBJECT: usize = 256;
pub const MAX_REASON: usize = 500;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StoreState {
    #[default]
    Pending,
    Done,
    Failed,
}

/// One store's part of an erasure.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Store {
    pub state: StoreState,
    /// What went: Entities, rows, conversations.
    pub count: u64,
    /// The broker's history rows, the versions that went.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub versions: Option<u64>,
    pub attempts: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Store {
    /// Done, with nothing to do: a store this platform does not keep.
    fn none_kept() -> Self {
        Self {
            state: StoreState::Done,
            ..Self::default()
        }
    }

    /// The store after one more attempt: done with what went, else pending again until
    /// [`MAX_ATTEMPTS`], then failed. The error is the store's own sentence, never a value.
    pub fn after(&self, outcome: Result<(u64, Option<u64>), String>) -> Self {
        let attempts = self.attempts.saturating_add(1);
        match outcome {
            Ok((count, versions)) => Self {
                state: StoreState::Done,
                count,
                versions,
                attempts,
                error: None,
            },
            Err(error) => Self {
                state: if attempts >= MAX_ATTEMPTS {
                    StoreState::Failed
                } else {
                    StoreState::Pending
                },
                attempts,
                error: Some(error.chars().take(300).collect()),
                ..self.clone()
            },
        }
    }
}

/// The Entities of one class that name the subject, and the Attributes to erase of them;
/// `attrs: None` erases the whole Entity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Group {
    pub class: String,
    pub entities: Vec<String>,
    pub attrs: Option<Vec<String>>,
}

/// One erasure as the log holds it.
#[derive(Debug, Clone, PartialEq)]
pub struct Erasure {
    pub id: String,
    pub project: String,
    pub space: String,
    pub subject: String,
    pub reason: String,
    pub actor: String,
    pub requested_at: time::OffsetDateTime,
    pub completed_at: Option<time::OffsetDateTime>,
    pub groups: Vec<Group>,
    pub stores: BTreeMap<String, Store>,
}

impl Erasure {
    /// `done` once every store is, `failed` once none is pending and one gave up, else `open`.
    pub fn state(&self) -> &'static str {
        let states = || self.stores.values().map(|s| s.state);
        if states().all(|s| s == StoreState::Done) {
            "done"
        } else if states().any(|s| s == StoreState::Pending) {
            "open"
        } else {
            "failed"
        }
    }

    /// Every Entity the erasure names.
    pub fn urns(&self) -> Vec<String> {
        self.groups
            .iter()
            .flat_map(|g| g.entities.iter().cloned())
            .collect()
    }

    /// The erasure as API/01 §46 answers it: its state, the counts per store, each store's part.
    pub fn view(&self) -> Value {
        let rfc = |at: time::OffsetDateTime| {
            at.format(&time::format_description::well_known::Rfc3339)
                .unwrap_or_default()
        };
        let mut counts: BTreeMap<&str, u64> = BTreeMap::new();
        for (name, store) in &self.stores {
            counts.insert(name.as_str(), store.count);
            if let Some(versions) = store.versions {
                counts.insert("versions", versions);
            }
        }
        json!({
            "id": self.id,
            "state": self.state(),
            "requestedAt": rfc(self.requested_at),
            "completedAt": self.completed_at.map(rfc),
            "entities": self.urns().len(),
            "counts": counts,
            "stores": self.stores,
        })
    }
}

/// A fresh erasure: every store pending but the two this platform does not keep.
pub fn begin(
    (project, space): (&str, &str),
    subject: String,
    reason: &str,
    actor: &str,
    groups: Vec<Group>,
) -> Erasure {
    let now = time::OffsetDateTime::now_utc();
    let stores = STORES
        .iter()
        .map(|&name| {
            let store = match name {
                "exports" | "caches" => Store::none_kept(),
                _ => Store::default(),
            };
            (name.to_owned(), store)
        })
        .collect();
    Erasure {
        id: new_id(now),
        project: project.to_owned(),
        space: space.to_owned(),
        subject,
        reason: reason.trim().to_owned(),
        actor: actor.to_owned(),
        requested_at: now,
        completed_at: None,
        groups,
        stores,
    }
}

/// `er-20261019-<12 hex>`.
fn new_id(now: time::OffsetDateTime) -> String {
    use sha2::Digest;
    // Six bytes of the CSPRNG the CSRF token is minted with.
    let drawn = Sha256::digest(crate::auth::csrf::new_token().as_bytes());
    let hex: String = drawn[..6].iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "er-{:04}{:02}{:02}-{hex}",
        now.year(),
        u8::from(now.month()),
        now.day()
    )
}

/// Whether `id` is shaped as [`new_id`] mints them.
pub fn is_id(id: &str) -> bool {
    id.len() == 24
        && id.starts_with("er-")
        && id[3..11].bytes().all(|b| b.is_ascii_digit())
        && id.as_bytes()[11] == b'-'
        && id[12..]
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// The subject's keyed hash in one space: 32 hex of an HMAC-SHA256 under `key`, so the log and
/// the broker's record name the subject without holding a value anyone can look up.
pub fn subject_hash(key: &str, project: &str, space: &str, subject: &str) -> String {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key.as_bytes())
        .unwrap_or_else(|_| unreachable!("HMAC takes a key of any length"));
    mac.update(format!("joinedcontext/erasure-subject/v1/{project}/{space}").as_bytes());
    mac.update(&[0]);
    mac.update(subject.trim().as_bytes());
    mac.finalize().into_bytes()[..16]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Why `subject` cannot name a data subject, if it cannot: 1 to [`MAX_SUBJECT`] characters with
/// no control character and no quote or backslash, so it goes into an NGSI-LD `q` as one string.
pub fn subject_refusal(subject: &str) -> Option<String> {
    let trimmed = subject.trim();
    let bad = trimmed.is_empty()
        || trimmed.chars().count() > MAX_SUBJECT
        || trimmed
            .chars()
            .any(|c| c.is_control() || c == '"' || c == '\\');
    bad.then(|| {
        format!("subject is 1 to {MAX_SUBJECT} characters, with no quote, backslash or control character")
    })
}

/// A class of the space's model that names its data subject: the slot that holds the subject
/// (`dataSubjectRef`) and the Attributes to erase, `None` when the whole class is personal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubjectClass {
    pub class: String,
    pub slot: String,
    pub attrs: Option<Vec<String>>,
}

/// The classes of a LinkML model that declare `dataSubjectRef` (Architecture/11 §9), with the
/// slots marked `personalData` on the slot, in the class's `slot_usage` or its `attributes`,
/// and the subject slot itself. A class marked `personalData` as a whole goes whole.
pub fn subject_classes(linkml: &str) -> Vec<SubjectClass> {
    use serde_norway::Value as Yaml;
    let Ok(model) = serde_norway::from_str::<Yaml>(linkml) else {
        return Vec::new();
    };
    // `annotations: {name: value}` or `{name: {tag: name, value: value}}`.
    let annotation = |node: &Yaml, name: &str| -> Option<Yaml> {
        let found = node.get("annotations")?.get(name)?;
        Some(found.get("value").cloned().unwrap_or_else(|| found.clone()))
    };
    let truthy = |value: Option<Yaml>| match value {
        Some(Yaml::Bool(b)) => b,
        Some(Yaml::String(s)) => s.eq_ignore_ascii_case("true"),
        _ => false,
    };
    let Some(classes) = model.get("classes").and_then(Yaml::as_mapping) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (name, class) in classes {
        let (Some(name), Some(slot)) = (
            name.as_str(),
            annotation(class, "dataSubjectRef").and_then(|s| s.as_str().map(str::to_owned)),
        ) else {
            continue;
        };
        let attrs = if truthy(annotation(class, "personalData")) {
            None
        } else {
            let listed = class
                .get("slots")
                .and_then(Yaml::as_sequence)
                .into_iter()
                .flatten()
                .filter_map(Yaml::as_str)
                .map(str::to_owned);
            let own = class
                .get("attributes")
                .and_then(Yaml::as_mapping)
                .into_iter()
                .flatten()
                .filter_map(|(k, _)| k.as_str().map(str::to_owned));
            let mut attrs: Vec<String> = listed
                .chain(own)
                .filter(|s| {
                    let marked = |node: Option<&Yaml>| {
                        node.is_some_and(|n| truthy(annotation(n, "personalData")))
                    };
                    *s == slot
                        || marked(model.get("slots").and_then(|all| all.get(s.as_str())))
                        || marked(class.get("slot_usage").and_then(|u| u.get(s.as_str())))
                        || marked(class.get("attributes").and_then(|a| a.get(s.as_str())))
                })
                .collect();
            if !attrs.contains(&slot) {
                attrs.push(slot.clone());
            }
            attrs.sort();
            attrs.dedup();
            Some(attrs)
        };
        out.push(SubjectClass {
            class: name.to_owned(),
            slot,
            attrs,
        });
    }
    out
}

/// The NGSI-LD `q` that finds the Entities naming `subject` in `slot`.
pub fn subject_query(slot: &str, subject: &str) -> String {
    format!("{slot}==\"{}\"", subject.trim())
}

// --- the log ------------------------------------------------------------------------------

type Row = (
    String,
    String,
    String,
    String,
    String,
    String,
    time::OffsetDateTime,
    Option<time::OffsetDateTime>,
    Value,
    Value,
);

fn from_row(row: Row) -> Erasure {
    let (id, project, space, subject, reason, actor, requested_at, completed_at, groups, stores) =
        row;
    Erasure {
        id,
        project,
        space,
        subject,
        reason,
        actor,
        requested_at,
        completed_at,
        groups: serde_json::from_value(groups).unwrap_or_default(),
        stores: serde_json::from_value(stores).unwrap_or_default(),
    }
}

pub async fn insert(pool: &PgPool, erasure: &Erasure) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO erasures (id, project, space, subject, reason, actor, requested_at, groups, stores) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(&erasure.id)
    .bind(&erasure.project)
    .bind(&erasure.space)
    .bind(&erasure.subject)
    .bind(&erasure.reason)
    .bind(&erasure.actor)
    .bind(erasure.requested_at)
    .bind(json!(erasure.groups))
    .bind(json!(erasure.stores))
    .execute(pool)
    .await
    .map(|_| ())
}

/// One erasure of the space, or `None`.
pub async fn get(
    pool: &PgPool,
    project: &str,
    space: &str,
    id: &str,
) -> Result<Option<Erasure>, sqlx::Error> {
    sqlx::query_as::<_, Row>(
        "SELECT id, project, space, subject, reason, actor, requested_at, completed_at, groups, stores \
         FROM erasures WHERE id = $1 AND project = $2 AND space = $3",
    )
    .bind(id)
    .bind(project)
    .bind(space)
    .fetch_optional(pool)
    .await
    .map(|row| row.map(from_row))
}

/// The erasures with a store still pending, oldest first.
pub async fn open(pool: &PgPool) -> Result<Vec<Erasure>, sqlx::Error> {
    sqlx::query_as::<_, Row>(
        "SELECT id, project, space, subject, reason, actor, requested_at, completed_at, groups, stores \
         FROM erasures WHERE completed_at IS NULL AND EXISTS \
         (SELECT 1 FROM jsonb_each(stores) s WHERE s.value->>'state' = 'pending') \
         ORDER BY requested_at LIMIT 100",
    )
    .fetch_all(pool)
    .await
    .map(|rows| rows.into_iter().map(from_row).collect())
}

/// Writes one store's part, and the completion once every store is done. One store per
/// statement, so the reconciler's CKAN pass and the minute loop never overwrite each other.
pub async fn save(pool: &PgPool, id: &str, name: &str, store: &Store) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE erasures SET stores = jsonb_set(stores, ARRAY[$2], $3), \
           completed_at = CASE WHEN NOT EXISTS (SELECT 1 FROM jsonb_each(jsonb_set(stores, ARRAY[$2], $3)) s \
                                                WHERE s.value->>'state' <> 'done') \
                               THEN coalesce(completed_at, now()) ELSE completed_at END \
         WHERE id = $1",
    )
    .bind(id)
    .bind(name)
    .bind(json!(store))
    .execute(pool)
    .await
    .map(|_| ())
}

// --- the stores ----------------------------------------------------------------------------

/// Asks every pending store but the CKAN DataStore once and saves each outcome. `words` is the
/// subject's own value, which the log never keeps: given on the first attempt only, so the
/// stored conversations are searched for it then and for the Entities' URNs on a retry.
pub async fn attempt(state: &AppState, pool: &PgPool, erasure: &Erasure, words: Option<&str>) {
    for (name, store) in &erasure.stores {
        if store.state != StoreState::Pending || name == CKAN {
            continue;
        }
        let outcome = match name.as_str() {
            "broker" => broker(state, erasure).await,
            "portal" => portal(pool, erasure).await.map(|n| (n, None)),
            "conversations" => conversations(state, erasure, words)
                .await
                .map(|n| (n, None)),
            _ => Ok((0, None)),
        };
        if let Err(reason) = &outcome {
            tracing::warn!(erasure = %erasure.id, store = %name, %reason, "an erasure's store did not answer; asked again in a minute");
        }
        if let Err(err) = save(pool, &erasure.id, name, &store.after(outcome)).await {
            tracing::warn!(erasure = %erasure.id, error = %err, "an erasure's outcome was not saved");
        }
    }
}

async fn broker(state: &AppState, erasure: &Erasure) -> Result<(u64, Option<u64>), String> {
    let views = state
        .views
        .as_ref()
        .ok_or("this Portal has no broker address or admin token")?;
    let tenant = crate::spaces::segment(&state.mirror, &erasure.project, &erasure.space);
    let (mut entities, mut history) = (0, 0);
    for group in erasure.groups.iter().filter(|g| !g.entities.is_empty()) {
        let counts = views
            .erase(
                &tenant,
                &group.entities,
                group.attrs.as_deref(),
                (&erasure.subject, &erasure.actor, &erasure.reason),
            )
            .await?;
        let n = |k: &str| counts.get(k).and_then(Value::as_u64).unwrap_or(0);
        entities += n("entities");
        history += n("history");
    }
    Ok((entities, Some(history)))
}

/// The Portal's own copies of the Entities: the trash and the comments.
async fn portal(pool: &PgPool, erasure: &Erasure) -> Result<u64, String> {
    let urns = erasure.urns();
    let mut gone = 0;
    for sql in [
        "DELETE FROM entity_trash WHERE project = $1 AND space = $2 AND urn = ANY($3)",
        "DELETE FROM entity_comments WHERE project = $1 AND space = $2 AND urn = ANY($3)",
    ] {
        gone += sqlx::query(sql)
            .bind(&erasure.project)
            .bind(&erasure.space)
            .bind(&urns)
            .execute(pool)
            .await
            .map_err(|err| format!("the Portal's copies were not reached: {err}"))?
            .rows_affected();
    }
    Ok(gone)
}

/// The assistant's stored conversations that mention an Entity or the subject's words (5
/// characters or more: a shorter word would match unrelated conversations).
async fn conversations(
    state: &AppState,
    erasure: &Erasure,
    words: Option<&str>,
) -> Result<u64, String> {
    let mut terms = erasure.urns();
    terms.extend(
        words
            .map(|w| w.trim().to_owned())
            .filter(|w| w.chars().count() >= 5),
    );
    if terms.is_empty() {
        return Ok(0);
    }
    if state.config.knowledge_url.is_none() {
        // A Portal without the assistant has no conversations to erase.
        return Ok(0);
    }
    let mut gone = 0;
    for batch in terms.chunks(1000) {
        let (status, body) = crate::api::knowledge::ask(
            state,
            reqwest::Method::POST,
            &format!("{}/knowledge/erasures", erasure.project),
            Some(json!({ "terms": batch })),
        )
        .await
        .map_err(|err| err.to_string())?;
        match status.as_u16() {
            200 => gone += body["conversations"].as_u64().unwrap_or(0),
            // A project the assistant never heard of holds no conversation.
            404 => {}
            other => return Err(format!("the assistant answered {other}")),
        }
    }
    Ok(gone)
}

/// The CKAN DataStore part of every open erasure, with the reconciler's catalogue: the rows of
/// the space's mirrored tables whose `entity_id` is one of the erasure's Entities. The next
/// mirror run writes back what an Entity still holds after the broker erased its personal
/// Attributes, so a whole row going is the erasure, not a loss.
pub(crate) async fn ckan_pass(
    pool: &PgPool,
    catalogue: &crate::reconciler::ckan::CkanSync,
    (repo, repository): (&jcctl::loader::Repository, &std::path::Path),
) {
    let open = match open(pool).await {
        Ok(open) => open,
        Err(err) => {
            tracing::warn!(error = %err, "the open erasures could not be read");
            return;
        }
    };
    for erasure in open {
        let Some(store) = erasure
            .stores
            .get(CKAN)
            .filter(|s| s.state == StoreState::Pending)
        else {
            continue;
        };
        let urns = erasure.urns();
        let outcome = if urns.is_empty() {
            Ok(0)
        } else {
            catalogue
                .erase_rows(repo, repository, (&erasure.project, &erasure.space), &urns)
                .await
        };
        if let Err(reason) = &outcome {
            tracing::warn!(erasure = %erasure.id, %reason, "the CKAN DataStore rows were not erased; asked again next run");
        }
        if let Err(err) = save(
            pool,
            &erasure.id,
            CKAN,
            &store.after(outcome.map(|n| (n, None))),
        )
        .await
        {
            tracing::warn!(erasure = %erasure.id, error = %err, "an erasure's outcome was not saved");
        }
    }
}

/// Whether the broker's `records` hold the erasure of `group` for `subject`: one record of the
/// subject that names every Entity of the group.
pub fn recorded(records: &[Value], subject: &str, group: &Group) -> bool {
    records.iter().any(|record| {
        record["subject"].as_str() == Some(subject)
            && group.entities.iter().all(|id| {
                record["entities"]
                    .as_array()
                    .is_some_and(|named| named.iter().any(|n| n.as_str() == Some(id)))
            })
    })
}

/// The erasure log applied again to the brokers (DM-127): every erasure the broker finished whose
/// record the broker no longer holds, after its database was restored from a backup older than
/// the erasure, is sent again. Returns how many of how many logged erasures were sent.
///
/// ponytail: a resent erasure also takes what the space wrote about the Entities after the
/// first one; the broker's own re-apply keeps that, a resend with its `before` time when it matters.
pub(crate) async fn reapply(state: &AppState, pool: &PgPool) -> Result<(usize, usize), String> {
    let views = state
        .views
        .as_ref()
        .ok_or("this Portal has no broker address or admin token")?;
    let done: Vec<Erasure> = sqlx::query_as::<_, Row>(
        "SELECT id, project, space, subject, reason, actor, requested_at, completed_at, groups, stores \
         FROM erasures WHERE stores->'broker'->>'state' = 'done' ORDER BY requested_at",
    )
    .fetch_all(pool)
    .await
    .map_err(|err| err.to_string())?
    .into_iter()
    .map(from_row)
    .collect();
    let mut held: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    let mut resent = 0;
    for erasure in &done {
        let tenant = crate::spaces::segment(&state.mirror, &erasure.project, &erasure.space);
        if !held.contains_key(&tenant) {
            held.insert(tenant.clone(), views.erasure_records(&tenant).await?);
        }
        let records = held.get(&tenant).map(Vec::as_slice).unwrap_or_default();
        let missing: Vec<&Group> = erasure
            .groups
            .iter()
            .filter(|g| !g.entities.is_empty() && !recorded(records, &erasure.subject, g))
            .collect();
        for group in &missing {
            views
                .erase(
                    &tenant,
                    &group.entities,
                    group.attrs.as_deref(),
                    (&erasure.subject, &erasure.actor, &erasure.reason),
                )
                .await?;
        }
        resent += usize::from(!missing.is_empty());
    }
    Ok((resent, done.len()))
}

/// Asks the pending stores of every open erasure once a minute, and applies the erasure log
/// again to the brokers when the Portal starts and every hour after (DM-127).
pub(crate) fn spawn_periodic(state: AppState) {
    let Some(pool) = state.db.clone() else {
        return;
    };
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut tick: u64 = 0;
        loop {
            interval.tick().await;
            if tick.is_multiple_of(60) {
                match reapply(&state, &pool).await {
                    Ok((resent, logged)) => {
                        tracing::info!(resent, logged, "erasure log re-applied")
                    }
                    Err(reason) => {
                        tracing::warn!(%reason, "the erasure log was not re-applied; again in an hour")
                    }
                }
            }
            tick = tick.wrapping_add(1);
            match open(&pool).await {
                Ok(open) => {
                    for erasure in &open {
                        attempt(&state, &pool, erasure, None).await;
                    }
                }
                Err(err) => tracing::warn!(error = %err, "the open erasures could not be read"),
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_store_is_done_with_its_count_or_asked_again_until_it_fails() {
        let fresh = Store::default();
        let done = fresh.after(Ok((3, Some(12))));
        assert_eq!(
            (done.state, done.count, done.versions, done.attempts),
            (StoreState::Done, 3, Some(12), 1)
        );
        let mut store = fresh;
        for _ in 1..MAX_ATTEMPTS {
            store = store.after(Err("the broker did not answer".into()));
            assert_eq!(store.state, StoreState::Pending);
        }
        store = store.after(Err("x".repeat(1000)));
        assert_eq!(
            (store.state, store.attempts),
            (StoreState::Failed, MAX_ATTEMPTS)
        );
        assert_eq!(store.error.as_deref().map(str::len), Some(300));
    }

    #[test]
    fn an_erasure_is_open_until_every_store_is_done_and_failed_once_one_gave_up() {
        let mut erasure = begin(
            ("hel", "bikes"),
            "0".repeat(32),
            " Art. 17 ",
            "f:1:anna",
            vec![],
        );
        assert!(is_id(&erasure.id), "{}", erasure.id);
        assert_eq!(erasure.reason, "Art. 17");
        assert_eq!(erasure.stores["exports"].state, StoreState::Done);
        assert_eq!(erasure.state(), "open");
        for store in erasure.stores.values_mut() {
            *store = store.after(Ok((1, None)));
        }
        assert_eq!(erasure.state(), "done");
        erasure.stores.insert(
            "broker".into(),
            Store {
                state: StoreState::Failed,
                ..Store::default()
            },
        );
        assert_eq!(erasure.state(), "failed");
        erasure.stores.insert("portal".into(), Store::default());
        assert_eq!(erasure.state(), "open");
        let view = erasure.view();
        assert_eq!(view["counts"]["broker"], 0);
        assert!(
            view.to_string().find("Art. 17").is_none(),
            "the view carries no reason"
        );
    }

    #[test]
    fn a_broker_record_covers_a_group_only_for_the_same_subject_and_every_entity() {
        let group = Group {
            class: "BikeTrip".into(),
            entities: vec!["a".into(), "b".into()],
            attrs: None,
        };
        let record =
            |subject: &str, entities: Value| json!({"subject": subject, "entities": entities});
        assert!(recorded(
            &[record("s1", json!(["b", "a", "c"]))],
            "s1",
            &group
        ));
        assert!(!recorded(&[record("s1", json!(["a"]))], "s1", &group));
        assert!(!recorded(&[record("s2", json!(["a", "b"]))], "s1", &group));
        assert!(!recorded(&[], "s1", &group));
    }

    #[test]
    fn ids_are_shaped_and_nothing_else_passes() {
        assert!(is_id("er-20261019-0a1b2c3d4e5f"));
        for bad in [
            "er-20261019-0A1B2C3D4E5F",
            "er-2026101-0a1b2c3d4e5f0",
            "../../etc/passwd",
            "",
        ] {
            assert!(!is_id(bad), "{bad}");
        }
    }

    #[test]
    fn the_subject_hash_is_keyed_per_space_and_never_the_value() {
        let one = subject_hash("k1", "hel", "bikes", "Ján Nováček");
        assert_eq!(one.len(), 32);
        assert!(one.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(one, subject_hash("k1", "hel", "bikes", " Ján Nováček "));
        assert_ne!(one, subject_hash("k2", "hel", "bikes", "Ján Nováček"));
        assert_ne!(one, subject_hash("k1", "hel", "trips", "Ján Nováček"));
    }

    #[test]
    fn a_subject_goes_into_q_as_one_string_or_is_refused() {
        assert_eq!(subject_query("rider", " r-42 "), "rider==\"r-42\"");
        assert!(subject_refusal("r-42").is_none());
        assert!(subject_refusal("Ján Nováček").is_none());
        for bad in [
            "",
            "   ",
            "a\"|rider!=\"x",
            "a\\b",
            "a\nb",
            &"x".repeat(257),
        ] {
            assert!(subject_refusal(bad).is_some(), "{bad:?}");
        }
    }

    #[test]
    fn the_model_names_the_subject_slot_and_the_personal_attributes() {
        let linkml = r#"
id: https://example.org/bikes
slots:
  rider:
    range: string
  riderName:
    annotations:
      personalData: true
  station:
    range: string
classes:
  BikeTrip:
    annotations:
      dataSubjectRef: rider
    slots: [rider, riderName, station]
    slot_usage:
      station: {}
    attributes:
      phone:
        annotations:
          personalData:
            tag: personalData
            value: "true"
  Account:
    annotations:
      dataSubjectRef:
        tag: dataSubjectRef
        value: owner
      personalData: true
    slots: [owner]
  Station:
    slots: [station]
"#;
        assert_eq!(
            subject_classes(linkml),
            [
                SubjectClass {
                    class: "BikeTrip".into(),
                    slot: "rider".into(),
                    attrs: Some(vec!["phone".into(), "rider".into(), "riderName".into()])
                },
                SubjectClass {
                    class: "Account".into(),
                    slot: "owner".into(),
                    attrs: None
                },
            ]
        );
        assert!(subject_classes("not: [yaml").is_empty());
        assert!(subject_classes("classes: {}").is_empty());
    }
}
