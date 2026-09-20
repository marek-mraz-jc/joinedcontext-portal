//! Edge cases of the key store itself (T-2063, T-2064; PF-36, PF-38, OPS-48).
//!
//! **The contract, in one sentence:** a key row is what is left of an API key once its secret has been
//! hashed and forgotten, the project and the account are part of every lookup, and a revocation is
//! written once and never rewritten — so the audit trail of a key that existed survives whatever anybody
//! does to it afterwards.
//!
//! `service_account_api_tests.rs` covers the routes above these functions (the raw key once, a rotation
//! that keeps both alive, a revocation that ends one now) and `edge_keys_sync_tests.rs` covers the
//! refusals that never reach a database at all. This file is the store: what a lookup of another
//! project's key answers, what a second revocation does to the first one's timestamp, and what a name
//! full of SQL metacharacters does to the table.
//!
//! These cases need a PostgreSQL and skip without one, like every database test in this crate:
//! `JC_PORTAL_TEST_DATABASE_URL=postgres://…`. The migrations run themselves on connect.
//!
//! Tests only (the family's rule). Every case here is green; a red one becomes its own task.

use joinedcontext_portal::db::{self, KeyRow};
use sqlx::PgPool;
use time::OffsetDateTime;

const PROJECT: &str = "banskabystrica";
const ELSEWHERE: &str = "doprava";
const ACCOUNT: &str = "vendorx-parking-push";

fn database_url() -> Option<String> {
    std::env::var("JC_PORTAL_TEST_DATABASE_URL")
        .ok()
        .filter(|url| !url.trim().is_empty())
}

/// A pool with the schema up to date, or `None` when this run has no database.
async fn pool() -> Option<PgPool> {
    let url = database_url()?;
    Some(
        db::connect(&url)
            .await
            .expect("connect to the test database and migrate"),
    )
}

/// A key id nobody else in this database has: the suite shares one PostgreSQL and a case is run more
/// than once, so every row a case writes is named for that run.
fn run_id() -> &'static str {
    static RUN: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    RUN.get_or_init(|| {
        format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|since| since.as_nanos())
                .unwrap_or_default()
        )
    })
}

fn id(name: &str) -> String {
    format!("{name}-{}", run_id())
}

/// A key row with no secret in it: the hash is a stand-in for the Argon2id PHC string the gateway
/// verifies against, and there is nowhere in this type to put a token even if one wanted to.
fn a_key(key_id: &str, project: &str, account: &str, created_ago: i64) -> KeyRow {
    KeyRow {
        key_id: key_id.to_owned(),
        project: project.to_owned(),
        account: account.to_owned(),
        credential: "legacy-push".to_owned(),
        secret_hash: format!("$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$notarealhashfor-{key_id}"),
        created_at: OffsetDateTime::now_utc() - time::Duration::seconds(created_ago),
        created_by: "jana.kovacova".to_owned(),
        expires_at: None,
        last_used_at: None,
        revoked_at: None,
    }
}

/// Every key of this test's account, so one case does not read another's rows: the suite shares one
/// database, and each case uses key ids of its own.
async fn only(pool: &PgPool, project: &str, account: &str, ids: &[String]) -> Vec<KeyRow> {
    db::list_keys(pool, project, account)
        .await
        .expect("list the keys")
        .into_iter()
        .filter(|row| ids.contains(&row.key_id))
        .collect()
}

/// PF-36, PF-38: the project and the account are part of every lookup, so a key id is never enough to
/// reach a row. A list of an account of another project with the same name is empty, a read of one
/// project's key id under another project's name is a miss, and a revocation aimed the same way changes
/// nothing — the key it names keeps working.
#[tokio::test]
async fn a_key_id_alone_reaches_nothing_across_a_project_or_an_account() {
    let Some(pool) = pool().await else {
        eprintln!("skipped: JC_PORTAL_TEST_DATABASE_URL is not set");
        return;
    };
    let here = a_key(&id("edge-cross-here"), PROJECT, ACCOUNT, 10);
    let there = a_key(&id("edge-cross-there"), ELSEWHERE, ACCOUNT, 10);
    for row in [&here, &there] {
        db::insert_key(&pool, row).await.expect("insert");
    }

    // Each project sees its own and only its own, although the account name is the same in both.
    let mine = only(
        &pool,
        PROJECT,
        ACCOUNT,
        &[id("edge-cross-here"), id("edge-cross-there")],
    )
    .await;
    assert_eq!(
        mine.iter().map(|row| &row.key_id).collect::<Vec<_>>(),
        vec![&id("edge-cross-here")],
        "one project's list carries another project's key",
    );

    // A read of the right key id under the wrong project, the wrong account, and with both wrong.
    for (project, account) in [
        (ELSEWHERE, ACCOUNT),
        (PROJECT, "another-account"),
        (ELSEWHERE, "another-account"),
    ] {
        let found = db::get_key(&pool, project, account, &id("edge-cross-here"))
            .await
            .expect("read");
        assert!(
            found.is_none(),
            "{project}/{account} read a key of {PROJECT}/{ACCOUNT}: {found:?}",
        );
        let revoked = db::revoke_key(
            &pool,
            project,
            account,
            &id("edge-cross-here"),
            OffsetDateTime::now_utc(),
        )
        .await
        .expect("revoke");
        assert!(
            !revoked,
            "{project}/{account} revoked a key of {PROJECT}/{ACCOUNT}",
        );
    }

    // And the key it aimed at is untouched: not revoked, and its expiry not pulled forward.
    let still = db::get_key(&pool, PROJECT, ACCOUNT, &id("edge-cross-here"))
        .await
        .expect("read")
        .expect("the key");
    assert!(still.revoked_at.is_none(), "{still:?}");
    assert!(still.expires_at.is_none(), "{still:?}");
}

/// PF-38, OPS-48: a revocation is written once. A second one answers that a row was matched, because
/// one was, and leaves the first revocation's instant where it is — `COALESCE(revoked_at, $4)` is what
/// makes the audit trail of when a key stopped working survive a person clicking twice, or two
/// operators revoking at once. The row itself stays in the list, revoked, for the same reason.
#[tokio::test]
async fn a_second_revocation_never_rewrites_the_first_ones_instant() {
    let Some(pool) = pool().await else {
        eprintln!("skipped: JC_PORTAL_TEST_DATABASE_URL is not set");
        return;
    };
    db::insert_key(&pool, &a_key(&id("edge-twice"), PROJECT, ACCOUNT, 60))
        .await
        .expect("insert");

    let first_at = OffsetDateTime::now_utc() - time::Duration::seconds(30);
    assert!(
        db::revoke_key(&pool, PROJECT, ACCOUNT, &id("edge-twice"), first_at)
            .await
            .expect("revoke"),
        "the first revocation matched no row",
    );
    let after_first = db::get_key(&pool, PROJECT, ACCOUNT, &id("edge-twice"))
        .await
        .expect("read")
        .expect("the key");
    let revoked_at = after_first.revoked_at.expect("a revocation instant");

    // Again, later: still `true`, because the row is there, and the instant does not move.
    assert!(db::revoke_key(
        &pool,
        PROJECT,
        ACCOUNT,
        &id("edge-twice"),
        OffsetDateTime::now_utc() + time::Duration::hours(1),
    )
    .await
    .expect("revoke"),);
    let after_second = db::get_key(&pool, PROJECT, ACCOUNT, &id("edge-twice"))
        .await
        .expect("read")
        .expect("the key");
    assert_eq!(
        after_second.revoked_at,
        Some(revoked_at),
        "the second revocation moved the first one's instant",
    );
    assert_eq!(
        after_second.expires_at,
        Some(revoked_at),
        "a revocation pulls the expiry to the revocation and not past it",
    );

    // And a revocation never gives a key more life: an expiry already behind the revocation stays.
    db::insert_key(&pool, &a_key(&id("edge-short"), PROJECT, ACCOUNT, 60))
        .await
        .expect("insert");
    db::expire_key_at(
        &pool,
        &id("edge-short"),
        OffsetDateTime::now_utc() - time::Duration::hours(2),
    )
    .await
    .expect("expire");
    // Read the stored instant back rather than comparing to the one sent: the column keeps
    // microseconds and `OffsetDateTime::now_utc` carries nanoseconds.
    let early = db::get_key(&pool, PROJECT, ACCOUNT, &id("edge-short"))
        .await
        .expect("read")
        .expect("the key")
        .expires_at
        .expect("an expiry");
    db::revoke_key(
        &pool,
        PROJECT,
        ACCOUNT,
        &id("edge-short"),
        OffsetDateTime::now_utc(),
    )
    .await
    .expect("revoke");
    let short = db::get_key(&pool, PROJECT, ACCOUNT, &id("edge-short"))
        .await
        .expect("read")
        .expect("the key");
    assert_eq!(
        short.expires_at,
        Some(early),
        "revoking a key that had already expired extended it",
    );

    // Both are still listed: an operator has to be able to see that a key existed.
    let listed = only(
        &pool,
        PROJECT,
        ACCOUNT,
        &[id("edge-twice"), id("edge-short")],
    )
    .await;
    assert_eq!(listed.len(), 2, "a revoked key left the list: {listed:?}");
    assert!(
        listed.iter().all(|row| row.revoked_at.is_some()),
        "{listed:?}",
    );
}

/// PF-38: `expire_key_at` is what ends a predecessor's overlap window after a rotation, and it only
/// ever shortens a life. Moving the expiry to an instant further out leaves the nearer one, whether the
/// key had an expiry or not; a key id nobody has is not an error, because a rotation that already ran
/// must be repeatable.
#[tokio::test]
async fn moving_an_expiry_only_ever_shortens_a_keys_life() {
    let Some(pool) = pool().await else {
        eprintln!("skipped: JC_PORTAL_TEST_DATABASE_URL is not set");
        return;
    };
    db::insert_key(&pool, &a_key(&id("edge-overlap"), PROJECT, ACCOUNT, 10))
        .await
        .expect("insert");

    let soon = OffsetDateTime::now_utc() + time::Duration::hours(1);
    let later = OffsetDateTime::now_utc() + time::Duration::hours(48);

    // From no expiry at all to one: taken, because there was nothing nearer.
    db::expire_key_at(&pool, &id("edge-overlap"), soon)
        .await
        .expect("expire");
    let first = db::get_key(&pool, PROJECT, ACCOUNT, &id("edge-overlap"))
        .await
        .expect("read")
        .expect("the key")
        .expires_at
        .expect("an expiry");

    // And from that to one further out: refused by `LEAST`, so a second rotation cannot lengthen the
    // window a first one set.
    db::expire_key_at(&pool, &id("edge-overlap"), later)
        .await
        .expect("expire");
    let second = db::get_key(&pool, PROJECT, ACCOUNT, &id("edge-overlap"))
        .await
        .expect("read")
        .expect("the key")
        .expires_at
        .expect("an expiry");
    assert_eq!(second, first, "the overlap window was lengthened");

    // A key id nobody has: not an error, so a rotation is safe to repeat.
    db::expire_key_at(&pool, &id("edge-nobody-has-this"), soon)
        .await
        .expect("a missing key is not an error");
}

/// Every value a caller can shape reaches the statement as a bound parameter, so a project or an
/// account name full of SQL is a name and not a statement: the lookups answer nothing, the revocation
/// matches nothing, and the table is still there afterwards. `src/db.rs:10` is the module's own note
/// that only a `const` column list is ever interpolated.
#[tokio::test]
async fn a_name_full_of_sql_is_a_name_and_the_table_survives_it() {
    let Some(pool) = pool().await else {
        eprintln!("skipped: JC_PORTAL_TEST_DATABASE_URL is not set");
        return;
    };
    db::insert_key(&pool, &a_key(&id("edge-injection"), PROJECT, ACCOUNT, 10))
        .await
        .expect("insert");

    let nasty = [
        "'; DROP TABLE service_account_keys; --",
        "' OR '1'='1",
        "banskabystrica' --",
        "%",
        "_",
        "banskabystrica\ndoprava",
    ];
    for name in nasty {
        // As a project, as an account, and as a key id: three parameters, one answer each.
        let listed = db::list_keys(&pool, name, ACCOUNT).await.expect("list");
        assert!(listed.is_empty(), "{name:?} listed rows: {listed:?}");
        let listed = db::list_keys(&pool, PROJECT, name).await.expect("list");
        assert!(listed.is_empty(), "{name:?} listed rows: {listed:?}");
        let found = db::get_key(&pool, PROJECT, ACCOUNT, name)
            .await
            .expect("read");
        assert!(found.is_none(), "{name:?} read a row: {found:?}");
        let revoked = db::revoke_key(&pool, PROJECT, ACCOUNT, name, OffsetDateTime::now_utc())
            .await
            .expect("revoke");
        assert!(!revoked, "{name:?} revoked a row");
    }

    // A name carrying a nul is refused by the driver before it is a query at all: PostgreSQL has no
    // such text, so the lookup is an error and never a match. Fails closed, which is what matters.
    let with_a_nul = "banskabystrica\0doprava";
    assert!(
        db::list_keys(&pool, with_a_nul, ACCOUNT).await.is_err(),
        "a name with a nul was accepted as text",
    );
    assert!(db::revoke_key(
        &pool,
        PROJECT,
        ACCOUNT,
        with_a_nul,
        OffsetDateTime::now_utc()
    )
    .await
    .is_err(),);

    // `%` and `_` are wildcards to `LIKE` and nothing at all to `=`, which is what these lookups use.
    let mine = only(&pool, PROJECT, ACCOUNT, &[id("edge-injection")]).await;
    assert_eq!(mine.len(), 1, "the table is not what it was: {mine:?}");
    assert!(
        mine[0].secret_hash.starts_with("$argon2id$"),
        "the row carries something other than a hash: {:?}",
        mine[0].key_id,
    );
}

/// The list is newest first, and `created_at` is the only thing it is ordered by: two keys minted in
/// the same instant come back in whatever order the database chose. Written down in
/// `/workspace/chyby.md` rather than asserted as wanted, because the fix is a tiebreaker in the
/// `ORDER BY` (`src/db.rs:98`) and this case is what proves the order once there is one.
#[tokio::test]
async fn the_list_is_newest_first_and_ties_are_not_broken() {
    let Some(pool) = pool().await else {
        eprintln!("skipped: JC_PORTAL_TEST_DATABASE_URL is not set");
        return;
    };
    let account = &id("edge-order-account");
    let same_instant = OffsetDateTime::now_utc() - time::Duration::seconds(5);
    for (id, created_ago) in [(&id("edge-order-old"), 300), (&id("edge-order-new"), 1)] {
        db::insert_key(&pool, &a_key(id, PROJECT, account, created_ago))
            .await
            .expect("insert");
    }
    for id in [&id("edge-order-tie-a"), &id("edge-order-tie-b")] {
        let mut row = a_key(id, PROJECT, account, 0);
        row.created_at = same_instant;
        db::insert_key(&pool, &row).await.expect("insert");
    }

    let listed = db::list_keys(&pool, PROJECT, account).await.expect("list");
    let ids: Vec<&str> = listed.iter().map(|row| row.key_id.as_str()).collect();
    assert_eq!(ids.len(), 4, "{ids:?}");
    assert_eq!(
        ids[0],
        &id("edge-order-new"),
        "the newest is not first: {ids:?}"
    );
    assert_eq!(
        ids[3],
        &id("edge-order-old"),
        "the oldest is not last: {ids:?}"
    );
    // The two in the middle are the tie, in no order this test may rely on.
    let tied: std::collections::BTreeSet<&str> = ids[1..3].iter().copied().collect();
    assert_eq!(
        tied,
        [id("edge-order-tie-a"), id("edge-order-tie-b")]
            .iter()
            .map(String::as_str)
            .collect::<std::collections::BTreeSet<&str>>(),
        "{ids:?}",
    );
}
