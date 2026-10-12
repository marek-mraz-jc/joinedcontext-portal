//! How much a space holds, as the broker that holds it counts it (API/01 §29, T-2889, T-2996).
//!
//! The broker keeps a space's entities in its tenant, named by the space's URN segment (PF-84).
//! The Portal reads the count from the broker's admin route `GET /q/tenants/{tenant}` with the
//! broker's admin token, the same bearer its view writer sends (T-3640). The NGSI-LD count query
//! (`GET /ngsi-ld/v1/entities?local=true&count=true&limit=0`) is not usable here: the
//! `joinedcontext` policy engine denies a caller without subject headers on every query clause,
//! so on dev it answered 403 for every space (T-3983). A count is a scan on the broker's side,
//! so each answer is kept for a few minutes: these are dashboard numbers, not per-request work.
//! The storage size in bytes waits for a broker surface (T-2890).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::RwLock;
use std::time::Duration;

use chrono::{DateTime, Utc};
use reqwest::StatusCode;
use serde::Serialize;
use serde_json::Value;

/// The problem type of a tenant the broker has never written to (`GET /q/tenants/{tenant}`).
const NO_TENANT: &str = "https://uri.etsi.org/ngsi-ld/errors/ResourceNotFound";
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
    token_file: Option<PathBuf>,
    http: reqwest::Client,
    cache: RwLock<HashMap<String, SpaceUsage>>,
}

impl Counter {
    /// `broker` is `JC_PORTAL_BROKER_URL` and `token_file` `JC_PORTAL_BROKER_ADMIN_TOKEN_FILE`;
    /// without either every read answers why.
    pub fn new(broker: Option<String>, token_file: Option<PathBuf>) -> Self {
        Self {
            broker: broker.map(|url| url.trim_end_matches('/').to_owned()),
            token_file,
            http: reqwest::Client::builder()
                .timeout(TIMEOUT)
                .build()
                .unwrap_or_default(),
            cache: RwLock::default(),
        }
    }

    /// The usage of the space whose broker tenant is `tenant` (its URN segment, PF-84), which
    /// must already be a DNS-1123 name: it becomes a path segment.
    pub async fn usage(&self, tenant: &str) -> Result<SpaceUsage, String> {
        let Some(broker) = &self.broker else {
            return Err("no broker address is configured (JC_PORTAL_BROKER_URL)".to_owned());
        };
        let now = Utc::now();
        if let Some(kept) = self
            .cache
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(tenant)
            .filter(|kept| now - kept.observed_at < FRESH)
        {
            return Ok(kept.clone());
        }
        // Read on every ask, like the view writer: a rotated Secret needs no restart.
        let token = self
            .token_file
            .as_ref()
            .and_then(|file| std::fs::read_to_string(file).ok())
            .map(|token| token.trim().to_owned())
            .filter(|token| !token.is_empty())
            .ok_or_else(|| {
                "the broker's admin token is not readable (JC_PORTAL_BROKER_ADMIN_TOKEN_FILE)"
                    .to_owned()
            })?;
        let response = self
            .http
            .get(format!("{broker}/q/tenants/{tenant}"))
            .bearer_auth(token)
            .send()
            .await
            .map_err(|err| {
                tracing::warn!(tenant, error = %err.without_url(), "the broker did not answer a space's counts");
                "the broker did not answer; try again in a minute".to_owned()
            })?;
        let status = response.status();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        let entities = match status {
            status if status.is_success() => count_of(&body)?,
            // The broker creates a tenant on its first write: no tenant is an empty space. Any
            // other 404 is an address that reaches no broker, never an empty space.
            StatusCode::NOT_FOUND if body["type"] == NO_TENANT => 0,
            status => {
                tracing::warn!(tenant, %status, "the broker refused a space's counts");
                return Err(format!(
                    "the broker answered {status} for the space's counts"
                ));
            }
        };
        let usage = SpaceUsage {
            entities,
            observed_at: now,
        };
        self.cache
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .insert(tenant.to_owned(), usage.clone());
        Ok(usage)
    }
}

/// The entity count of a `GET /q/tenants/{tenant}` answer.
fn count_of(body: &Value) -> Result<u64, String> {
    body["counts"]["entities"]
        .as_u64()
        .ok_or_else(|| "the broker's answer holds no readable entity count".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    use serde_json::json;

    #[test]
    fn the_count_is_read_from_the_tenants_entity_count() {
        assert_eq!(count_of(&json!({"counts": {"entities": 14232}})), Ok(14232));
        assert_eq!(count_of(&json!({"counts": {"entities": 0}})), Ok(0));
    }

    #[test]
    fn an_answer_without_a_count_is_an_error_and_never_a_zero() {
        assert!(count_of(&Value::Null).is_err());
        assert!(count_of(&json!({"counts": {"entities": -1}})).is_err());
        assert!(count_of(&json!({"counts": {"entities": "many"}})).is_err());
    }

    #[tokio::test]
    async fn without_a_broker_address_the_reason_is_answered() {
        let err = Counter::new(None, None).usage("air").await.unwrap_err();
        assert!(err.contains("JC_PORTAL_BROKER_URL"), "{err}");
    }
}
