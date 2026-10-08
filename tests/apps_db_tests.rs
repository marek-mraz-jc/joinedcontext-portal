//! The apps database against a real PostgreSQL 16 (AP-149, AP-150, ADR-N-044): the Portal logs in
//! as a CREATEROLE owner of the database, as on the cluster, never as a superuser.
//!
//! `JC_APPS_DB_TEST_URL` names a server whose user may create roles and databases, e.g.
//! `docker run -e POSTGRES_PASSWORD=pw -p 5434:5432 postgres:16` and
//! `postgres://postgres:pw@127.0.0.1:5434/postgres`. A missing variable fails, never skips.

use joinedcontext_portal::apps::apps_db::{app_id, AppsDb, Error, Migration};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{ConnectOptions, Connection, PgPool};

const ADMIN: &str = "apps_admin_test";

fn server() -> PgConnectOptions {
    std::env::var("JC_APPS_DB_TEST_URL")
        .expect(
            "set JC_APPS_DB_TEST_URL to a PostgreSQL 16 whose user may create roles and databases",
        )
        .parse()
        .expect("JC_APPS_DB_TEST_URL parses")
}

/// Runs `statement` on the server, a role or database another test made at once being no failure.
async fn ensure(pool: &PgPool, statement: &str) {
    let guarded = format!(
        "DO $$ BEGIN {statement}; EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $$"
    );
    sqlx::query(sqlx::AssertSqlSafe(guarded))
        .execute(pool)
        .await
        .expect(statement);
}

struct World {
    db: AppsDb,
    superuser: PgPool,
    host: PgConnectOptions,
    /// Unique to this run: roles are the server's, not the database's, so an App of an earlier
    /// run's database would otherwise share this run's App roles.
    run: String,
}

impl World {
    /// A project name of this run alone.
    fn project(&self, name: &str) -> String {
        format!("{name}-{}", self.run)
    }
}

/// A fresh database owned by the Portal's CREATEROLE login, with the shards' login roles.
async fn world(test: &str) -> World {
    world_of(test, 2).await
}

/// The superuser's statements of apps-db's bootstrap (apps_db/superuser.sql), as CloudNativePG
/// runs them in deployment components/apps-db.
const SUPERUSER_SQL: &str = include_str!("../apps_db/superuser.sql");

async fn world_of(test: &str, shards: u32) -> World {
    let root = PgPoolOptions::new()
        .max_connections(2)
        .connect_with(server())
        .await
        .expect("the test server answers");
    ensure(
        &root,
        &format!("CREATE ROLE {ADMIN} LOGIN CREATEROLE PASSWORD 'pw'"),
    )
    .await;
    for shard in 0..2 {
        ensure(
            &root,
            &format!("CREATE ROLE wasm_host_{shard} LOGIN NOINHERIT PASSWORD 'pw'"),
        )
        .await;
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let name = format!("apps_{test}_{nanos}");
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "CREATE DATABASE {name} OWNER {ADMIN}"
    )))
    .execute(&root)
    .await
    .expect("create the database");
    let here = server().database(&name);
    let superuser = PgPoolOptions::new()
        .max_connections(2)
        .connect_with(here.clone())
        .await
        .expect("superuser");
    // jc_set_config is the server's, made once; the revokes are this database's own.
    let statements: Vec<&str> = SUPERUSER_SQL
        .lines()
        .filter(|line| !line.trim_start().starts_with("--"))
        .collect::<Vec<_>>()
        .join("\n")
        .leak()
        .split(';')
        .map(str::trim)
        .filter(|statement| !statement.is_empty())
        .collect();
    for statement in statements {
        if statement.starts_with("CREATE ROLE") {
            ensure(&superuser, statement).await;
        } else {
            sqlx::query(sqlx::AssertSqlSafe(statement.to_owned()))
                .execute(&superuser)
                .await
                .expect(statement);
        }
    }
    // As deployment components/apps-db makes them members (inRoles), inheriting.
    for member in [ADMIN, "wasm_host_0", "wasm_host_1"] {
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "GRANT jc_set_config TO {member} WITH INHERIT TRUE"
        )))
        .execute(&superuser)
        .await
        .expect("member of jc_set_config");
    }
    let admin_options = here.clone().username(ADMIN).password("pw");
    let admin = PgPoolOptions::new()
        .max_connections(2)
        .connect_with(admin_options.clone())
        .await
        .expect("the Portal's login");
    let db = AppsDb {
        admin,
        connect: here.clone().disable_statement_logging(),
        shards,
    };
    db.bootstrap().await.expect("jc_apps applies");
    World {
        db,
        superuser,
        host: here,
        run: nanos.to_string(),
    }
}

fn file(name: &str, sql: &str) -> Migration {
    Migration {
        file: name.to_owned(),
        sql: sql.to_owned(),
    }
}

const NOTES: &str = "CREATE TABLE notes (id bigserial PRIMARY KEY, body text NOT NULL)";
const AUTHOR: &str = "ALTER TABLE notes ADD COLUMN author text";

/// A connection as the shard's login, which only the host holds (AP-144).
async fn as_host(w: &World, shard: u32) -> sqlx::PgConnection {
    w.host
        .clone()
        .username(&format!("wasm_host_{shard}"))
        .password("pw")
        .connect()
        .await
        .expect("the host's login")
}

async fn published(w: &World, project: &str, name: &str) -> (String, u32) {
    let (id, shard) = w.db.place(project, name).await.expect("placed");
    w.db.provision(&id, shard).await.expect("provisioned");
    w.db.migrate(
        &id,
        &[
            file("0001_notes.sql", NOTES),
            file("0002_author.sql", AUTHOR),
        ],
    )
    .await
    .expect("migrated");
    (id, shard)
}

#[tokio::test]
async fn apps_are_placed_on_the_emptiest_shard_and_stay_there() {
    let w = world("place").await;
    let (a, sa) = w.db.place(&w.project("p-place"), "a").await.expect("a");
    let (b, sb) = w.db.place(&w.project("p-place"), "b").await.expect("b");
    assert_eq!((sa, sb), (0, 1));
    assert_eq!(a, app_id(&w.project("p-place"), "a"));
    assert_eq!(
        w.db.place(&w.project("p-place"), "a").await.expect("again"),
        (a, 0)
    );
    let (_, sc) = w.db.place(&w.project("p-place"), "c").await.expect("c");
    assert_eq!(sc, 0);
    assert_ne!(b, app_id(&w.project("p-place"), "c"));
}

#[tokio::test]
async fn migrations_run_in_order_once_and_the_host_reads_and_writes_but_never_creates() {
    let w = world("migrate").await;
    let (id, shard) =
        w.db.place(&w.project("p-migrate"), "notes")
            .await
            .expect("placed");
    w.db.provision(&id, shard).await.expect("provisioned");
    w.db.provision(&id, shard)
        .await
        .expect("provisioning twice changes nothing");
    // Given out of order, run in the order of their names.
    let files = [
        file("0002_author.sql", AUTHOR),
        file("0001_notes.sql", NOTES),
    ];
    let first = w.db.migrate(&id, &files).await.expect("migrated");
    assert_eq!(first.applied, ["0001_notes.sql", "0002_author.sql"]);
    assert!(w
        .db
        .migrate(&id, &files)
        .await
        .expect("again")
        .applied
        .is_empty());

    let mut host = as_host(&w, shard).await;
    let schema = format!("app_{id}");
    let mut tx = host.begin().await.expect("tx");
    sqlx::query("SELECT set_config('role', $1, true), set_config('search_path', $1, true)")
        .bind(&schema)
        .execute(&mut *tx)
        .await
        .expect("the host becomes the App for one transaction");
    sqlx::query("INSERT INTO notes (body, author) VALUES ('hello', 'me')")
        .execute(&mut *tx)
        .await
        .expect("insert");
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM notes")
        .fetch_one(&mut *tx)
        .await
        .expect("select");
    assert_eq!(count, 1);
    let create = sqlx::query("CREATE TABLE more (x int)")
        .execute(&mut *tx)
        .await;
    assert!(
        create.is_err(),
        "the run-time role creates nothing (AP-144)"
    );
    tx.rollback().await.ok();
    // The setting was the transaction's: the next one is the host again, an App of nobody.
    let role: String = sqlx::query_scalar("SELECT current_user::text")
        .fetch_one(&mut host)
        .await
        .expect("role");
    assert_eq!(role, format!("wasm_host_{shard}"));
    let owner_login: bool =
        sqlx::query_scalar("SELECT rolcanlogin FROM pg_roles WHERE rolname = $1")
            .bind(format!("app_{id}_owner"))
            .fetch_one(&w.superuser)
            .await
            .expect("owner");
    assert!(!owner_login, "the owner logs in only while it migrates");
}

#[tokio::test]
async fn postgres_itself_keeps_apps_and_shards_apart() {
    let w = world("isolation").await;
    let (a, sa) = published(&w, &w.project("p-iso"), "a").await;
    let (b, sb) = published(&w, &w.project("p-iso"), "b").await;
    assert_ne!(sa, sb, "two Apps, two shards");
    // App A's role on App B's table: refused by Postgres, with no host check in the way.
    let mut tx = w.superuser.begin().await.expect("tx");
    sqlx::query("SELECT set_config('role', $1, true)")
        .bind(format!("app_{a}"))
        .execute(&mut *tx)
        .await
        .expect("as A");
    let read = sqlx::query(sqlx::AssertSqlSafe(format!("SELECT * FROM app_{b}.notes")))
        .execute(&mut *tx)
        .await;
    assert!(read.is_err(), "App A reads nothing of App B's (AP-144)");
    tx.rollback().await.ok();
    // Shard A's login becoming App B: refused by Postgres.
    let mut host = as_host(&w, sa).await;
    let become_b = sqlx::query("SELECT set_config('role', $1, false)")
        .bind(format!("app_{b}"))
        .execute(&mut host)
        .await;
    assert!(
        become_b.is_err(),
        "a shard's login is a member of its own shard's Apps alone (AP-144)"
    );
    // Nor the owner of anything, nor the jc_apps tables.
    let owner = sqlx::query("SELECT set_config('role', $1, false)")
        .bind(format!("app_{a}_owner"))
        .execute(&mut host)
        .await;
    assert!(owner.is_err());
    let books = sqlx::query("SELECT * FROM jc_apps.apps")
        .execute(&mut host)
        .await;
    assert!(books.is_err());
}

#[tokio::test]
async fn a_changed_migration_is_refused_and_a_failed_one_leaves_the_last_good_schema() {
    let w = world("failed").await;
    let (id, _) = published(&w, &w.project("p-failed"), "notes").await;
    let changed =
        w.db.migrate(&id, &[file("0001_notes.sql", "CREATE TABLE notes (x int)")])
            .await;
    assert!(
        matches!(&changed, Err(Error::Changed(name)) if name == "0001_notes.sql"),
        "{changed:?}"
    );

    let failed =
        w.db.migrate(
            &id,
            &[
                file("0001_notes.sql", NOTES),
                file("0002_author.sql", AUTHOR),
                file(
                    "0003_tags.sql",
                    "CREATE TABLE tags (id int); ALTER TABLE nowhere ADD COLUMN y int",
                ),
            ],
        )
        .await;
    match failed {
        Err(Error::Failed { file, last, reason }) => {
            assert_eq!(
                (file.as_str(), last.as_str()),
                ("0003_tags.sql", "0002_author.sql")
            );
            assert!(reason.contains("nowhere"), "{reason}");
        }
        other => panic!("{other:?}"),
    }
    let tags: Option<String> = sqlx::query_scalar("SELECT to_regclass($1)::text")
        .bind(format!("app_{id}.tags"))
        .fetch_one(&w.superuser)
        .await
        .expect("regclass");
    assert_eq!(
        tags, None,
        "the failed file's first statement was rolled back with it"
    );
    let recorded: i64 =
        sqlx::query_scalar("SELECT count(*) FROM jc_apps.migrations WHERE app_id = $1")
            .bind(&id)
            .fetch_one(&w.superuser)
            .await
            .expect("records");
    assert_eq!(recorded, 2);
    let bad = w.db.migrate(&id, &[file("../0004.sql", "SELECT 1")]).await;
    assert!(matches!(bad, Err(Error::FileName(_))));
}

#[tokio::test]
async fn a_migration_can_never_become_another_app_or_reach_outside_its_schema() {
    let w = world("escape").await;
    let (victim, _) = published(&w, &w.project("p-escape"), "victim").await;
    let (id, shard) =
        w.db.place(&w.project("p-escape"), "attacker")
            .await
            .expect("placed");
    w.db.provision(&id, shard).await.expect("provisioned");
    for (n, sql) in [
        format!("SET ROLE app_{victim}_owner"),
        format!("DROP TABLE app_{victim}.notes"),
        "RESET ROLE; CREATE ROLE sneaky LOGIN".to_owned(),
        "CREATE SCHEMA mine".to_owned(),
        "CREATE TABLE public.leak (x int)".to_owned(),
        "CREATE TEMPORARY TABLE scratch (x int)".to_owned(),
        "INSERT INTO jc_apps.apps (id, project, name, shard) VALUES ('0000000000000000', 'x', 'y', 0)".to_owned(),
        format!("SELECT jc_apps.provision('{victim}', 'wasm_host_0')"),
        // T-3342's case: a view over another App's table, refused by Postgres because each App
        // migrates as its own owner.
        format!("CREATE VIEW peek AS SELECT * FROM app_{victim}.notes"),
        "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS 'select 1'".to_owned(),
        "CREATE TABLE t (r text DEFAULT set_config('role', 'x', true))".to_owned(),
    ]
    .into_iter()
    .enumerate()
    {
        let outcome = w.db.migrate(&id, &[file(&format!("{n:04}_try.sql"), &sql)]).await;
        assert!(
            matches!(outcome, Err(Error::Failed { .. }) | Err(Error::Refused { .. })),
            "`{sql}` ran: {outcome:?}"
        );
    }
    let victim_notes: Option<String> = sqlx::query_scalar("SELECT to_regclass($1)::text")
        .bind(format!("app_{victim}.notes"))
        .fetch_one(&w.superuser)
        .await
        .expect("regclass");
    assert!(victim_notes.is_some(), "the victim's table stands");
}

#[tokio::test]
async fn retire_drops_the_schema_the_roles_and_the_records() {
    let w = world("retire").await;
    let (id, _) = published(&w, &w.project("p-retire"), "gone").await;
    w.db.retire(&id).await.expect("retired");
    w.db.retire(&id)
        .await
        .expect("retiring twice changes nothing");
    let left: i64 = sqlx::query_scalar(
        "SELECT (SELECT count(*) FROM pg_roles WHERE rolname LIKE $1) + \
                (SELECT count(*) FROM pg_namespace WHERE nspname = $2) + \
                (SELECT count(*) FROM jc_apps.apps WHERE id = $3)",
    )
    .bind(format!("app_{id}%"))
    .bind(format!("app_{id}"))
    .bind(&id)
    .fetch_one(&w.superuser)
    .await
    .expect("count");
    assert_eq!(left, 0);
    // Published again it starts empty, on a shard of its own again.
    let (again, shard) = published(&w, &w.project("p-retire"), "gone").await;
    assert_eq!(again, id);
    assert!(shard < 2);
}

/// T-3358: a refused file is named, and nothing of the run is applied, not even the files before it.
#[tokio::test]
async fn a_refused_migration_runs_nothing_and_names_its_file() {
    let w = world("refused").await;
    let (id, shard) =
        w.db.place(&w.project("p-refused"), "app")
            .await
            .expect("placed");
    w.db.provision(&id, shard).await.expect("provisioned");
    let outcome = w
        .db
        .migrate(
            &id,
            &[
                file("0001_notes.sql", NOTES),
                file("0002_trigger.sql", "CREATE TRIGGER t BEFORE INSERT ON notes FOR EACH ROW EXECUTE FUNCTION nothing()"),
            ],
        )
        .await;
    match outcome {
        Err(Error::Refused { file, what }) => {
            assert_eq!((file.as_str(), what), ("0002_trigger.sql", "a trigger"))
        }
        other => panic!("{other:?}"),
    }
    let notes: Option<String> = sqlx::query_scalar("SELECT to_regclass($1)::text")
        .bind(format!("app_{id}.notes"))
        .fetch_one(&w.superuser)
        .await
        .expect("regclass");
    assert_eq!(notes, None, "0001 did not run either");
}

/// T-3362: two Apps on ONE shard. With the host's guard out of the way, App A's function-form
/// switches into App B, and SQL text handed to a query-running function, are refused by
/// Postgres; the shard's own switch into either still works.
#[tokio::test]
async fn postgres_refuses_an_app_becoming_another_app_of_its_own_shard() {
    let w = world_of("sameshard", 1).await;
    let (a, sa) = published(&w, &w.project("p-same"), "a").await;
    let (b, sb) = published(&w, &w.project("p-same"), "b").await;
    assert_eq!((sa, sb), (0, 0), "both on one shard");
    let mut host = as_host(&w, 0).await;
    for escape in [
        format!("SELECT set_config('role', 'app_{b}', true)"),
        format!("SELECT \"set_config\"('role', 'app_{b}', true)"),
        format!("SELECT pg_catalog.set_config('search_path', 'app_{b}', true)"),
        format!("SELECT query_to_xml('select * from app_{b}.notes', true, false, '')"),
        format!("SELECT ts_stat('select to_tsvector(body) from app_{b}.notes')"),
    ] {
        let mut tx = host.begin().await.expect("tx");
        sqlx::query("SELECT set_config('role', $1, true)")
            .bind(format!("app_{a}"))
            .execute(&mut *tx)
            .await
            .expect("the shard becomes App A");
        let outcome = sqlx::query(sqlx::AssertSqlSafe(escape.clone()))
            .execute(&mut *tx)
            .await;
        assert!(outcome.is_err(), "`{escape}` ran as App A");
        tx.rollback().await.ok();
    }
    // App A still reads its own table; the shard still becomes B when the host asks.
    for (app, other) in [(&a, &b), (&b, &a)] {
        let mut tx = host.begin().await.expect("tx");
        sqlx::query("SELECT set_config('role', $1, true)")
            .bind(format!("app_{app}"))
            .execute(&mut *tx)
            .await
            .expect("the shard's own switch");
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "SELECT count(*) FROM app_{app}.notes"
        )))
        .execute(&mut *tx)
        .await
        .expect("its own table");
        let theirs = sqlx::query(sqlx::AssertSqlSafe(format!(
            "SELECT count(*) FROM app_{other}.notes"
        )))
        .execute(&mut *tx)
        .await;
        assert!(theirs.is_err(), "the other App's table");
        tx.rollback().await.ok();
    }
    // The shard holds no App's privileges of its own.
    let own = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT count(*) FROM app_{a}.notes"
    )))
    .execute(&mut host)
    .await;
    assert!(
        own.is_err(),
        "INHERIT FALSE: the shard reads nothing as itself"
    );
}
