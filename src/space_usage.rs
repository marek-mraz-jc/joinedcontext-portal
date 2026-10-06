//! How much a space holds, as the broker that holds it counts it (API/01 §29, T-2889, T-2996).
//!
//! The broker keeps a space's entities in its tenant. The Portal asks the count with the
//! conformant NGSI-LD query every broker serves (CIM 009 6.3.13): `GET /ngsi-ld/v1/entities` with
//! `local=true` (every type, the tenant's own entities and no registered source's), `count=true`
//! and `limit=0`, under the tenant's `NGSILD-Tenant`, and reads `NGSILD-Results-Count`. A count is
//! a scan on the broker's side, so each answer is kept for a few minutes: these are dashboard
//! numbers, not per-request work. The storage size in bytes waits for a broker surface (T-2890).

use std::collections::HashMap;
use std::sync::RwLock;
use std::time::Duration;

use chrono::{DateTime, Utc};
use reqwest::StatusCode;
use serde::Serialize;
use serde_json::Value;

/// The tenant header of the broker's NGSI-LD API (CIM 009 6.3.5).
const TENANT_HEADER: &str = "NGSILD-Tenant";
/// Where the broker answers the count of a query (CIM 009 6.3.13).
const COUNT_HEADER: &str = "NGSILD-Results-Count";
/// The problem type of a tenant the broker has never written to.
const NONEXISTENT_TENANT: &str = "https://uri.etsi.org/ngsi-ld/errors/NonexistentTenant";
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
            .get(format!("{broker}/ngsi-ld/v1/entities"))
            .query(&[("local", "true"), ("count", "true"), ("limit", "0")])
            .header(TENANT_HEADER, space)
            .send()
            .await
            .map_err(|err| {
                tracing::warn!(space, error = %err, "the broker did not answer a space's counts");
                "the broker did not answer; try again in a minute".to_owned()
            })?;
        let entities = match response.status() {
            status if status.is_success() => count_of(response.headers().get(COUNT_HEADER))?,
            // The broker creates a tenant on its first write: no tenant is an empty space. Any
            // other 404 is an address that reaches no broker, never an empty space.
            StatusCode::NOT_FOUND => {
                let body: Value = response.json().await.unwrap_or(Value::Null);
                if body["type"] != NONEXISTENT_TENANT {
                    return Err(format!(
                        "the broker answered {} for the space's entities",
                        StatusCode::NOT_FOUND
                    ));
                }
                0
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

/// The entity count of a `count=true` answer's `NGSILD-Results-Count`.
fn count_of(header: Option<&reqwest::header::HeaderValue>) -> Result<u64, String> {
    header
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .ok_or_else(|| format!("the broker's answer holds no readable {COUNT_HEADER} count"))
}

#[cfg(test)]
mod tests {
    use super::*;

    use reqwest::header::HeaderValue;

    #[test]
    fn the_count_is_read_from_the_results_count_header() {
        assert_eq!(
            count_of(Some(&HeaderValue::from_static("14232"))),
            Ok(14232)
        );
        assert_eq!(count_of(Some(&HeaderValue::from_static("0"))), Ok(0));
    }

    #[test]
    fn an_answer_without_a_count_is_an_error_and_never_a_zero() {
        assert!(count_of(None).is_err());
        assert!(count_of(Some(&HeaderValue::from_static("-1"))).is_err());
        assert!(count_of(Some(&HeaderValue::from_static("many"))).is_err());
    }

    #[tokio::test]
    async fn without_a_broker_address_the_reason_is_answered() {
        let err = Counter::new(None).usage("air").await.unwrap_err();
        assert!(err.contains("JC_PORTAL_BROKER_URL"), "{err}");
    }
}
