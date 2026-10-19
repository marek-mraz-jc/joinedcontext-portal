//! The answers jc-assistant keeps for repeated questions are forgotten when a Policy or an
//! Endpoint changes, so nobody is served an answer read under rules that no longer hold (T-4731,
//! API/01 §34).

use std::hash::{DefaultHasher, Hash, Hasher};

use crate::state::AppState;
use crate::store::Mirror;

/// The kinds whose change can make a kept answer wrong or no longer the asker's to read.
const RULING: [&str; 2] = ["Policy", "Endpoint"];

/// A digest of every mirrored Policy and Endpoint: it moves when any of them is added, removed
/// or edited, and only then.
pub fn fingerprint(mirror: &Mirror) -> u64 {
    let mut ruling: Vec<String> = mirror
        .matching(|env| RULING.contains(&env.kind.as_str()))
        .iter()
        .map(|env| {
            let key = env.key();
            format!("{}/{}/{}={}", key.namespace, key.kind, key.name, env.spec)
        })
        .collect();
    ruling.sort();
    let mut hash = DefaultHasher::new();
    ruling.hash(&mut hash);
    hash.finish()
}

/// Asks jc-assistant to forget the kept answers of every mirrored AssistantDeployment; how many
/// it forgot. A deployment the assistant cannot be asked for is logged and left to its answers'
/// own life (an hour at most).
// ponytail: every deployment of every project, since a connector may read another project's
// Endpoint; per-deployment purges through resolve_connectors if Policy changes become frequent.
pub async fn forget_all(state: &AppState) -> u64 {
    if state.config.knowledge_url.is_none() {
        return 0;
    }
    let mut forgotten = 0;
    for env in state
        .mirror
        .matching(|env| env.kind == "AssistantDeployment")
    {
        let key = env.key();
        let path = format!(
            "{}/knowledge/deployments/{}/answers",
            key.namespace, key.name
        );
        match crate::api::knowledge::ask(state, reqwest::Method::DELETE, &path, None).await {
            Ok((_, body)) => forgotten += body["forgotten"].as_u64().unwrap_or(0),
            Err(err) => {
                tracing::warn!(deployment = %path, error = %err, "the kept answers were not forgotten")
            }
        }
    }
    forgotten
}

/// Looks at the mirror every 30 seconds and forgets every kept answer once a Policy or an
/// Endpoint changed since the last look.
pub(crate) fn spawn_periodic(state: AppState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut seen = fingerprint(&state.mirror);
        loop {
            interval.tick().await;
            let now = fingerprint(&state.mirror);
            if now != seen {
                let forgotten = forget_all(&state).await;
                tracing::info!(
                    forgotten,
                    "a Policy or an Endpoint changed: kept answers forgotten"
                );
                seen = now;
            }
        }
    });
}
