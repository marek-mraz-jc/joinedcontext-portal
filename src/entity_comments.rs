//! Comments on a space's entities and the notifications their mentions send (API/01 §34,
//! ADR-N-042 §3.1, T-3106). Each comment names its entity by `(project, space, urn)` and changes
//! no data. Durable with a database, in memory without.

use std::sync::RwLock;

use serde::Serialize;
use utoipa::ToSchema;

/// The most comments one entity keeps.
pub const MAX_PER_ENTITY: i64 = 1000;
/// The longest comment, in characters.
pub const MAX_TEXT: usize = 4000;
/// How much of a comment a notification carries, in characters.
pub const EXCERPT: usize = 200;
/// The most notifications one answer lists.
pub const LISTED: i64 = 100;

/// One comment as stored.
#[derive(Debug, Clone, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: i64,
    pub urn: String,
    /// Who wrote it: their username, as the Portal knows them.
    pub author: String,
    /// What the Portal shows for the author.
    pub author_name: String,
    pub text: String,
    /// The people the comment notified, by identifier.
    pub mentions: Vec<String>,
    /// RFC 3339.
    pub created_at: String,
}

/// One notification of a mention.
#[derive(Debug, Clone, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    pub id: i64,
    pub project: String,
    pub space: String,
    pub urn: String,
    pub comment_id: i64,
    pub author: String,
    pub author_name: String,
    /// The first [`EXCERPT`] characters of the comment.
    pub excerpt: String,
    /// RFC 3339.
    pub created_at: String,
    pub read: bool,
}

/// Who writes a comment.
pub struct Author<'a> {
    pub id: &'a str,
    pub name: &'a str,
}

/// What a new comment says and whom it notifies.
pub struct NewComment<'a> {
    pub project: &'a str,
    pub space: &'a str,
    pub urn: &'a str,
    pub text: &'a str,
    pub mentions: &'a [String],
}

#[derive(Default)]
struct Memory {
    next: i64,
    /// project, space, comment.
    comments: Vec<(String, String, Comment)>,
    /// recipient, notification.
    notifications: Vec<(String, Notification)>,
}

pub struct CommentStore {
    inner: Inner,
}

enum Inner {
    Postgres(sqlx::PgPool),
    Memory(RwLock<Memory>),
}

fn rfc3339(at: time::OffsetDateTime) -> String {
    at.format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

/// The first [`EXCERPT`] characters of a comment, whole characters only.
pub fn excerpt(text: &str) -> String {
    text.chars().take(EXCERPT).collect()
}

type CommentRow = (
    i64,
    String,
    String,
    String,
    String,
    Vec<String>,
    time::OffsetDateTime,
);
type NotificationRow = (
    i64,
    String,
    String,
    String,
    i64,
    String,
    String,
    String,
    time::OffsetDateTime,
    Option<time::OffsetDateTime>,
);

fn comment_of((id, urn, author, author_name, text, mentions, at): CommentRow) -> Comment {
    Comment {
        id,
        urn,
        author,
        author_name,
        text,
        mentions,
        created_at: rfc3339(at),
    }
}

fn notification_of(
    (id, project, space, urn, comment_id, author, author_name, excerpt, at, read_at): NotificationRow,
) -> Notification {
    Notification {
        id,
        project,
        space,
        urn,
        comment_id,
        author,
        author_name,
        excerpt,
        created_at: rfc3339(at),
        read: read_at.is_some(),
    }
}

impl CommentStore {
    pub fn new(db: Option<sqlx::PgPool>) -> Self {
        Self {
            inner: match db {
                Some(pool) => Inner::Postgres(pool),
                None => Inner::Memory(RwLock::new(Memory::default())),
            },
        }
    }

    /// Stores one comment and one notification per mentioned person, in one transaction;
    /// `None` when the entity already holds [`MAX_PER_ENTITY`] comments.
    pub async fn add(
        &self,
        author: Author<'_>,
        new: NewComment<'_>,
    ) -> Result<Option<Comment>, sqlx::Error> {
        let short = excerpt(new.text);
        match &self.inner {
            Inner::Postgres(pool) => {
                let mut tx = pool.begin().await?;
                let (held,): (i64,) = sqlx::query_as(
                    "SELECT count(*) FROM entity_comments WHERE project = $1 AND space = $2 AND urn = $3",
                )
                .bind(new.project)
                .bind(new.space)
                .bind(new.urn)
                .fetch_one(&mut *tx)
                .await?;
                if held >= MAX_PER_ENTITY {
                    return Ok(None);
                }
                let row: CommentRow = sqlx::query_as(
                    "INSERT INTO entity_comments (project, space, urn, author, author_name, body, mentions) \
                     VALUES ($1, $2, $3, $4, $5, $6, $7) \
                     RETURNING id, urn, author, author_name, body, mentions, created_at",
                )
                .bind(new.project)
                .bind(new.space)
                .bind(new.urn)
                .bind(author.id)
                .bind(author.name)
                .bind(new.text)
                .bind(new.mentions)
                .fetch_one(&mut *tx)
                .await?;
                for recipient in new.mentions {
                    sqlx::query(
                        "INSERT INTO notifications (recipient, project, space, urn, comment_id, author, author_name, excerpt) \
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
                    )
                    .bind(recipient)
                    .bind(new.project)
                    .bind(new.space)
                    .bind(new.urn)
                    .bind(row.0)
                    .bind(author.id)
                    .bind(author.name)
                    .bind(&short)
                    .execute(&mut *tx)
                    .await?;
                }
                tx.commit().await?;
                Ok(Some(comment_of(row)))
            }
            Inner::Memory(lock) => {
                let mut memory = lock.write().unwrap_or_else(|e| e.into_inner());
                let held = memory
                    .comments
                    .iter()
                    .filter(|(p, s, c)| p == new.project && s == new.space && c.urn == new.urn)
                    .count() as i64;
                if held >= MAX_PER_ENTITY {
                    return Ok(None);
                }
                let at = rfc3339(time::OffsetDateTime::now_utc());
                memory.next += 1;
                let comment = Comment {
                    id: memory.next,
                    urn: new.urn.to_owned(),
                    author: author.id.to_owned(),
                    author_name: author.name.to_owned(),
                    text: new.text.to_owned(),
                    mentions: new.mentions.to_vec(),
                    created_at: at.clone(),
                };
                memory.comments.push((
                    new.project.to_owned(),
                    new.space.to_owned(),
                    comment.clone(),
                ));
                for recipient in new.mentions {
                    memory.next += 1;
                    let notification = Notification {
                        id: memory.next,
                        project: new.project.to_owned(),
                        space: new.space.to_owned(),
                        urn: new.urn.to_owned(),
                        comment_id: comment.id,
                        author: author.id.to_owned(),
                        author_name: author.name.to_owned(),
                        excerpt: short.clone(),
                        created_at: at.clone(),
                        read: false,
                    };
                    memory.notifications.push((recipient.clone(), notification));
                }
                Ok(Some(comment))
            }
        }
    }

    /// The comments on one entity, oldest first.
    pub async fn list(
        &self,
        project: &str,
        space: &str,
        urn: &str,
    ) -> Result<Vec<Comment>, sqlx::Error> {
        match &self.inner {
            Inner::Postgres(pool) => {
                let rows: Vec<CommentRow> = sqlx::query_as(
                    "SELECT id, urn, author, author_name, body, mentions, created_at FROM entity_comments \
                     WHERE project = $1 AND space = $2 AND urn = $3 ORDER BY id LIMIT $4",
                )
                .bind(project)
                .bind(space)
                .bind(urn)
                .bind(MAX_PER_ENTITY)
                .fetch_all(pool)
                .await?;
                Ok(rows.into_iter().map(comment_of).collect())
            }
            Inner::Memory(lock) => {
                let memory = lock.read().unwrap_or_else(|e| e.into_inner());
                Ok(memory
                    .comments
                    .iter()
                    .filter(|(p, s, c)| p == project && s == space && c.urn == urn)
                    .map(|(_, _, c)| c.clone())
                    .collect())
            }
        }
    }

    /// Removes one of the author's comments and the notifications it sent; `false` when the
    /// author holds none by that id in this space.
    pub async fn remove(
        &self,
        project: &str,
        space: &str,
        author: &str,
        id: i64,
    ) -> Result<bool, sqlx::Error> {
        match &self.inner {
            // The notifications go with it: `ON DELETE CASCADE` (migration 0025).
            Inner::Postgres(pool) => Ok(sqlx::query(
                "DELETE FROM entity_comments WHERE project = $1 AND space = $2 AND author = $3 AND id = $4",
            )
            .bind(project)
            .bind(space)
            .bind(author)
            .bind(id)
            .execute(pool)
            .await?
            .rows_affected()
                > 0),
            Inner::Memory(lock) => {
                let mut memory = lock.write().unwrap_or_else(|e| e.into_inner());
                let before = memory.comments.len();
                memory
                    .comments
                    .retain(|(p, s, c)| !(p == project && s == space && c.author == author && c.id == id));
                let removed = memory.comments.len() < before;
                if removed {
                    memory.notifications.retain(|(_, n)| n.comment_id != id);
                }
                Ok(removed)
            }
        }
    }

    /// The notifications of a person known by any of `recipients`, newest first, at most
    /// [`LISTED`], and how many of all theirs are unread.
    pub async fn notifications(
        &self,
        recipients: &[String],
    ) -> Result<(Vec<Notification>, i64), sqlx::Error> {
        match &self.inner {
            Inner::Postgres(pool) => {
                let rows: Vec<NotificationRow> = sqlx::query_as(
                    "SELECT id, project, space, urn, comment_id, author, author_name, excerpt, created_at, read_at \
                     FROM notifications WHERE recipient = ANY($1) ORDER BY id DESC LIMIT $2",
                )
                .bind(recipients)
                .bind(LISTED)
                .fetch_all(pool)
                .await?;
                let (unread,): (i64,) = sqlx::query_as(
                    "SELECT count(*) FROM notifications WHERE recipient = ANY($1) AND read_at IS NULL",
                )
                .bind(recipients)
                .fetch_one(pool)
                .await?;
                Ok((rows.into_iter().map(notification_of).collect(), unread))
            }
            Inner::Memory(lock) => {
                let memory = lock.read().unwrap_or_else(|e| e.into_inner());
                let mine: Vec<&Notification> = memory
                    .notifications
                    .iter()
                    .filter(|(r, _)| recipients.contains(r))
                    .map(|(_, n)| n)
                    .collect();
                let unread = mine.iter().filter(|n| !n.read).count() as i64;
                Ok((
                    mine.into_iter()
                        .rev()
                        .take(LISTED as usize)
                        .cloned()
                        .collect(),
                    unread,
                ))
            }
        }
    }

    /// Marks one of the person's notifications read; `false` when none of theirs has that id.
    pub async fn mark_read(&self, recipients: &[String], id: i64) -> Result<bool, sqlx::Error> {
        match &self.inner {
            Inner::Postgres(pool) => Ok(sqlx::query(
                "UPDATE notifications SET read_at = coalesce(read_at, now()) WHERE id = $1 AND recipient = ANY($2)",
            )
            .bind(id)
            .bind(recipients)
            .execute(pool)
            .await?
            .rows_affected()
                > 0),
            Inner::Memory(lock) => {
                let mut memory = lock.write().unwrap_or_else(|e| e.into_inner());
                let mut found = false;
                for (recipient, notification) in memory.notifications.iter_mut() {
                    if notification.id == id && recipients.contains(recipient) {
                        notification.read = true;
                        found = true;
                    }
                }
                Ok(found)
            }
        }
    }
}
