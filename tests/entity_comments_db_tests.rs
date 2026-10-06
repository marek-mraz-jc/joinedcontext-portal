//! API/01 §34, T-3106: comments and notifications on PostgreSQL. A comment notifies each mentioned
//! person once, its author removes it with its notifications, and a notification is read by its
//! recipient alone. Runs when `JC_PORTAL_TEST_DATABASE_URL` points at a PostgreSQL the test may
//! write to; otherwise it says so and returns, like the other database suites.

use joinedcontext_portal::entity_comments::{Author, CommentStore, NewComment};

#[tokio::test]
async fn a_comment_notifies_its_mentions_and_leaves_with_its_notifications() {
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
    let store = CommentStore::new(Some(pool));
    let project = format!(
        "comments-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default()
    );
    let anna = format!("anna@{project}.example");
    let pia = format!("pia@{project}.example");
    let mentions = vec![anna.clone(), pia.clone()];
    let urn = "urn:ngsi-ld:T:x:air:1";
    let made = store
        .add(
            Author {
                id: "sami",
                name: "Sami",
            },
            NewComment {
                project: &project,
                space: "air",
                urn,
                text: "pm10 jumped",
                mentions: &mentions,
            },
        )
        .await
        .expect("stored")
        .expect("room for it");
    assert_eq!(made.mentions, mentions);
    store
        .add(
            Author {
                id: "anna",
                name: "Anna",
            },
            NewComment {
                project: &project,
                space: "air",
                urn,
                text: "seen",
                mentions: &[],
            },
        )
        .await
        .expect("stored");

    let listed = store.list(&project, "air", urn).await.expect("listed");
    assert_eq!(
        listed.iter().map(|c| c.text.as_str()).collect::<Vec<_>>(),
        ["pm10 jumped", "seen"]
    );
    assert!(store
        .list(&project, "other", urn)
        .await
        .expect("listed")
        .is_empty());

    let (inbox, unread) = store
        .notifications(std::slice::from_ref(&anna))
        .await
        .expect("read");
    assert_eq!((inbox.len(), unread), (1, 1));
    assert_eq!(inbox[0].comment_id, made.id);
    assert!(!store
        .mark_read(std::slice::from_ref(&pia), inbox[0].id)
        .await
        .expect("asked"));
    assert!(store
        .mark_read(std::slice::from_ref(&anna), inbox[0].id)
        .await
        .expect("asked"));
    assert_eq!(
        store
            .notifications(std::slice::from_ref(&anna))
            .await
            .expect("read")
            .1,
        0
    );

    assert!(!store
        .remove(&project, "air", "anna", made.id)
        .await
        .expect("asked"));
    assert!(store
        .remove(&project, "air", "sami", made.id)
        .await
        .expect("asked"));
    assert!(
        store
            .notifications(&[pia])
            .await
            .expect("read")
            .0
            .is_empty(),
        "the notification left with its comment"
    );
}
