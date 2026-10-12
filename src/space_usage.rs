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
    /// The `ContextBroker` the space lives on, which counted it (PF-111).
    pub broker: String,
    /// When the broker answered.
    #[schema(value_type = String, format = DateTime)]
    pub observed_at: DateTime<Utc>,
}

/// Asks the broker for a space's counts and keeps each answer for five minutes.
pub struct Counter {
    broker: Option<String>,
    template: Option<String>,
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
            template: None,
            token_file,
            http: reqwest::Client::builder()
                .timeout(TIMEOUT)
                .build()
                .unwrap_or_default(),
            cache: RwLock::default(),
        }
    }

    /// Counts a space on a broker other than `main` at `template` (`JC_PORTAL_BROKER_URL_TEMPLATE`).
    pub fn with_broker_template(mut self, template: Option<String>) -> Self {
        self.template = template;
        self
    }

    /// The usage of the space whose broker tenant is `tenant` (its URN segment, PF-84) on the
    /// broker named `broker` (PF-111, empty when its `brokerRef` resolves to none). `tenant`
    /// must already be a DNS-1123 name: it becomes a path segment.
    pub async fn usage(&self, broker_name: &str, tenant: &str) -> Result<SpaceUsage, String> {
        let Some(broker) = crate::spaces::broker_address(
            broker_name,
            self.broker.as_deref(),
            self.template.as_deref(),
        ) else {
            return Err(match broker_name {
                "" => "the space's brokerRef names no ContextBroker; fix the space's manifest"
                    .to_owned(),
                jc_core::kinds::IMPLICIT_BROKER => {
                    "no broker address is configured (JC_PORTAL_BROKER_URL)".to_owned()
                }
                name => {
                    format!("the broker '{name}' has no address; set JC_PORTAL_BROKER_URL_TEMPLATE")
                }
            });
        };
        let key = format!("{broker}/{tenant}");
        let now = Utc::now();
        if let Some(kept) = self
            .cache
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(&key)
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
            broker: broker_name.to_owned(),
            observed_at: now,
        };
        self.cache
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key, usage.clone());
        Ok(usage)
    }

    /// Whether the Portal has an address for broker `broker_name`.
    pub fn reaches(&self, broker_name: &str) -> bool {
        crate::spaces::broker_address(
            broker_name,
            self.broker.as_deref(),
            self.template.as_deref(),
        )
        .is_some()
    }

    /// The version broker `broker_name` reports on `GET /q/health`, or why it is not up
    /// (API/01 §42). Asked on every call: a health answer kept for minutes would hide an outage.
    pub async fn health(&self, broker_name: &str) -> Result<String, String> {
        let broker = crate::spaces::broker_address(
            broker_name,
            self.broker.as_deref(),
            self.template.as_deref(),
        )
        .ok_or_else(|| {
            "the Portal has no address for this broker (JC_PORTAL_BROKER_URL, \
             JC_PORTAL_BROKER_URL_TEMPLATE)"
                .to_owned()
        })?;
        let response = self
            .http
            .get(format!("{broker}/q/health"))
            .send()
            .await
            .map_err(|err| {
                tracing::warn!(broker_name, error = %err.without_url(), "a broker did not answer its health");
                "the broker did not answer; try again in a minute".to_owned()
            })?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("the broker answered {status} for its health"));
        }
        let body: Value = response.json().await.unwrap_or(Value::Null);
        Ok(body["version"].as_str().unwrap_or_default().to_owned())
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
        let err = Counter::new(None, None)
            .usage("main", "air")
            .await
            .unwrap_err();
        assert!(err.contains("JC_PORTAL_BROKER_URL"), "{err}");
    }

    /// PF-111: each space is counted on its own broker, with the same tenant name on both.
    #[tokio::test]
    async fn each_space_is_counted_on_its_own_broker() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let main = MockServer::start().await;
        let canary = MockServer::start().await;
        for (server, count) in [(&main, 3), (&canary, 7)] {
            Mock::given(method("GET"))
                .and(path("/q/tenants/air"))
                .respond_with(
                    ResponseTemplate::new(200)
                        .set_body_json(json!({"counts": {"entities": count}})),
                )
                .expect(1)
                .mount(server)
                .await;
        }
        let file = std::env::temp_dir().join(format!("usage-token-{}", std::process::id()));
        std::fs::write(&file, "t").expect("write the token");
        let counter = Counter::new(Some(main.uri()), Some(file.clone()))
            .with_broker_template(Some(canary.uri().replace("127.0.0.1", "{broker}")));
        let on_main = counter.usage("main", "air").await;
        let on_canary = counter.usage("127.0.0.1", "air").await;
        let _ = std::fs::remove_file(&file);
        assert_eq!(on_main.map(|u| u.entities), Ok(3));
        assert_eq!(on_canary.map(|u| u.entities), Ok(7));
    }

    #[tokio::test]
    async fn a_space_on_an_unreachable_broker_is_never_counted_on_main() {
        let counter = Counter::new(Some("http://127.0.0.1:9".into()), None);
        let err = counter.usage("canary", "air").await.unwrap_err();
        assert!(err.contains("JC_PORTAL_BROKER_URL_TEMPLATE"), "{err}");
        let err = counter.usage("", "air").await.unwrap_err();
        assert!(err.contains("brokerRef"), "{err}");
    }
}
