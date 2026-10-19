//! API/01 §46, DM-126, DM-127, T-4668: the erasure log on PostgreSQL. One store that does not
//! answer keeps the erasure open and is asked again; the Portal's own copies go at once; the
//! erasure is done only once every store is. Runs when `JC_PORTAL_TEST_DATABASE_URL` points at a
//! PostgreSQL the test may write to; otherwise it says so and returns.

use joinedcontext_portal::config::Config;
use joinedcontext_portal::erasure::{self, Group, Store, StoreState, CKAN};
use joinedcontext_portal::state::AppState;
use serde_json::json;

#[tokio::test]
async fn a_store_that_does_not_answer_keeps_the_erasure_open_until_it_does() {
    let Some(url) = std::env::var("JC_PORTAL_TEST_DATABASE_URL")
        .ok()
        .filter(|url| !url.trim().is_empty())
    else {
        eprintln!("skipped: JC_PORTAL_TEST_DATABASE_URL is not set");
        return;
    };
    let pool = joinedcontext_portal::db::connect(&url)
        .await
        .expect("the test database answers and migrates");
    let project = format!(
        "erase-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default()
    );
    // No broker and no assistant: the broker fails, the conversations have nothing to hold.
    let state = AppState::new(Config::for_tests(), None).with_db(pool.clone());
    let trip = "urn:ngsi-ld:BikeTrip:hel.fi:t-42";
    let other = "urn:ngsi-ld:BikeTrip:hel.fi:t-43";
    for urn in [trip, other] {
        state
            .trash
            .keep(
                (&project, "trips", "f:1:anna"),
                urn,
                "BikeTrip",
                &json!({"id": urn, "type": "BikeTrip"}),
            )
            .await
            .expect("kept");
    }
    sqlx::query(
        "INSERT INTO entity_comments (project, space, urn, author, author_name, body) \
         VALUES ($1, 'trips', $2, 'f:1:anna', 'Anna', 'Ján rode it')",
    )
    .bind(&project)
    .bind(trip)
    .execute(&pool)
    .await
    .expect("a comment");

    let groups = vec![Group {
        class: "BikeTrip".into(),
        entities: vec![trip.into()],
        attrs: Some(vec!["rider".into()]),
    }];
    let begun = erasure::begin(
        (&project, "trips"),
        "ab".repeat(16),
        "Art. 17",
        "user:anna",
        groups,
    );
    erasure::insert(&pool, &begun).await.expect("logged");
    erasure::attempt(&state, &pool, &begun, Some("Ján Nováček")).await;

    let now = erasure::get(&pool, &project, "trips", &begun.id)
        .await
        .expect("read")
        .expect("held");
    assert_eq!(now.state(), "open");
    let broker = &now.stores["broker"];
    assert_eq!((broker.state, broker.attempts), (StoreState::Pending, 1));
    assert!(
        broker
            .error
            .as_deref()
            .is_some_and(|e| e.contains("broker")),
        "{broker:?}"
    );
    assert_eq!(
        now.stores["portal"],
        Store {
            state: StoreState::Done,
            count: 2,
            attempts: 1,
            ..Store::default()
        }
    );
    assert_eq!(now.stores["conversations"].state, StoreState::Done);
    assert_eq!(
        now.stores[CKAN].state,
        StoreState::Pending,
        "the reconciler asks the catalogue"
    );
    // Only the erased Entity's copies went.
    assert_eq!(
        state
            .trash
            .list((&project, "trips", "f:1:anna"))
            .await
            .expect("listed")
            .len(),
        1
    );
    assert!(erasure::open(&pool)
        .await
        .expect("open")
        .iter()
        .any(|e| e.id == begun.id));
    // Another space reads none of it; the log holds the hash, never the subject's words.
    assert!(erasure::get(&pool, &project, "bikes", &begun.id)
        .await
        .expect("read")
        .is_none());
    let row: serde_json::Value =
        sqlx::query_scalar("SELECT to_jsonb(e) FROM erasures e WHERE id = $1")
            .bind(&begun.id)
            .fetch_one(&pool)
            .await
            .expect("row");
    assert!(!row.to_string().contains("Nováček"));

    // A retry asks the broker again, the done stores never.
    erasure::attempt(&state, &pool, &now, None).await;
    let again = erasure::get(&pool, &project, "trips", &begun.id)
        .await
        .expect("read")
        .expect("held");
    assert_eq!(again.stores["broker"].attempts, 2);
    assert_eq!(again.stores["portal"].attempts, 1);

    for name in ["broker", CKAN] {
        erasure::save(
            &pool,
            &begun.id,
            name,
            &again.stores[name].after(Ok((1, None))),
        )
        .await
        .expect("saved");
    }
    let done = erasure::get(&pool, &project, "trips", &begun.id)
        .await
        .expect("read")
        .expect("held");
    assert_eq!(done.state(), "done");
    assert!(done.completed_at.is_some());
    assert!(!erasure::open(&pool)
        .await
        .expect("open")
        .iter()
        .any(|e| e.id == begun.id));
}
