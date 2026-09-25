//! How much a space holds, as the broker that holds it counts it (API/01 §29, T-2889).
//!
//! The broker keeps a space's entities in its tenant and answers the tenant's counts on its admin
//! surface (`GET /q/tenants/{tenant}`), the one the Portal already reaches for registrations. A
//! count is a scan on the broker's side, so each answer is kept for a few minutes: these are
//! dashboard numbers, not per-request work. The storage size in bytes waits for a broker surface
//! (T-2890).

use std::collections::HashMap;
use std::sync::RwLock;
use std::time::Duration;

use chrono::{DateTime, Utc};
use reqwest::StatusCode;
use serde::Serialize;
use serde_json::Value;
use utoipa::ToSchema;

/// How long one broker answer is shown before it is asked again.
const FRESH: chrono::Duration = chrono::Duration::minutes(5);
/// How long the Portal waits for the broker.
const TIMEOUT: Duration = Duration::from_secs(5);

/// What one space holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SpaceUsage {
    /// The entities of the space's tenant, as the broker counts them.
    pub entities: u64,
    /// When the broker answered.
    #[schema(value_type = String, format = DateTime)]
    pub observed_at: DateTime<Utc>,
}

/// Asks the broker for a space's counts and keeps each answer for five minutes.
pub struct Counter {
    broker: Option<String>,
    http: reqwest::Client,
    cache: RwLock<HashMap<String, SpaceUsage>>,
}

impl Counter {
    /// `broker` is `JC_PORTAL_BROKER_URL`; without it every read answers why.
    pub fn new(broker: Option<String>) -> Self {
        Self {
            broker: broker.map(|url| url.trim_end_matches('/').to_owned()),
            http: reqwest::Client::builder()
                .timeout(TIMEOUT)
                .build()
                .unwrap_or_default(),
            cache: RwLock::default(),
        }
    }

    /// The usage of one space. `space` must already be a DNS-1123 name: it becomes a path segment.
    pub async fn usage(&self, space: &str) -> Result<SpaceUsage, String> {
        let Some(broker) = &self.broker else {
            return Err("no broker address is configured (JC_PORTAL_BROKER_URL)".to_owned());
        };
        let now = Utc::now();
        if let Some(kept) = self
            .cache
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(space)
            .filter(|kept| now - kept.observed_at < FRESH)
        {
            return Ok(kept.clone());
        }
        let response = self
            .http
            .get(format!("{broker}/q/tenants/{space}"))
            .send()
            .await
            .map_err(|err| {
                tracing::warn!(space, error = %err, "the broker did not answer a space's counts");
                "the broker did not answer; try again in a minute".to_owned()
            })?;
        let entities = match response.status() {
            // The broker creates a tenant on its first write: no tenant is an empty space.
            StatusCode::NOT_FOUND => 0,
            status if status.is_success() => {
                let body: Value = response
                    .json()
                    .await
                    .map_err(|_| "the broker's answer is not JSON".to_owned())?;
                entities_of(&body)?
            }
            status => return Err(format!("the broker answered {status}")),
        };
        let usage = SpaceUsage {
            entities,
            observed_at: now,
        };
        self.cache
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .insert(space.to_owned(), usage.clone());
        Ok(usage)
    }
}

/// The entity count of a `GET /q/tenants/{tenant}` answer.
fn entities_of(body: &Value) -> Result<u64, String> {
    body["counts"]["entities"]
        .as_u64()
        .ok_or_else(|| "the broker's answer holds no entity count".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_count_is_read_from_the_tenants_counts() {
        let body = json!({ "tenant": "air", "counts": { "entities": 14232, "subscriptions": 2 } });
        assert_eq!(entities_of(&body), Ok(14232));
    }

    #[test]
    fn an_answer_without_a_count_is_an_error_and_never_a_zero() {
        assert!(entities_of(&json!({ "tenant": "air" })).is_err());
        assert!(entities_of(&json!({ "counts": { "entities": -1 } })).is_err());
    }

    #[tokio::test]
    async fn without_a_broker_address_the_reason_is_answered() {
        let err = Counter::new(None).usage("air").await.unwrap_err();
        assert!(err.contains("JC_PORTAL_BROKER_URL"), "{err}");
    }
}
