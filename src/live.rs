//! Live updates of a space's entities (API/01 §32, ADR-N-042 §3.4, T-3105).
//!
//! An open data view watches one space and type. The first watcher of a pair has the Portal write
//! one NGSI-LD subscription through the space surface with its own ServiceAccount, delivering to
//! `/live-notify/{key}` on the Portal's public host; the gateway projects every notification and
//! the hub passes on which entities and attributes changed, never their values, to every window
//! watching that pair. A window then reads the rows again with the person's session, so a
//! notification, forged or not, shows nobody anything their grants do not.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use hmac::{Hmac, Mac};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::broadcast;

use crate::reconciler::subscriptions::SubscriptionSync;

/// How long a written subscription lives in the broker.
pub const LIFETIME: Duration = Duration::from_secs(24 * 3600);
/// A watcher after this long writes the subscription again, before it expires.
pub const RENEW_AFTER: Duration = Duration::from_secs(12 * 3600);
/// How many changes a slow window may fall behind before it misses some and reads again.
const BUFFER: usize = 256;

/// What changed, by name: the type, the entities and the attributes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Changed {
    #[serde(rename = "type")]
    pub entity_type: String,
    pub ids: Vec<String>,
    pub attrs: Vec<String>,
}

type Pair = (String, String);

pub struct LiveHub {
    secret: Vec<u8>,
    /// The Portal's public origin, where the gateway delivers.
    public_base: String,
    channels: Mutex<HashMap<Pair, broadcast::Sender<Arc<Changed>>>>,
    keys: Mutex<HashMap<String, Pair>>,
    written: Mutex<HashMap<Pair, Instant>>,
    writer: Option<Arc<SubscriptionSync>>,
}

impl LiveHub {
    /// A hub writing subscriptions with `writer`; without one the windows hear nothing, and say so
    /// nowhere because there is nothing wrong with the data.
    pub fn new(public_base: &str, writer: Option<Arc<SubscriptionSync>>) -> Self {
        // The CSPRNG the CSRF token and the OIDC state are minted with.
        let secret = crate::auth::csrf::new_token().into_bytes();
        Self {
            secret,
            public_base: public_base.trim_end_matches('/').to_owned(),
            channels: Mutex::new(HashMap::new()),
            keys: Mutex::new(HashMap::new()),
            written: Mutex::new(HashMap::new()),
            writer,
        }
    }

    /// The delivery key of one pair: an HMAC only this process can make.
    pub fn key(&self, space: &str, entity_type: &str) -> String {
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&self.secret).expect("any key length");
        mac.update(space.as_bytes());
        mac.update(&[0]);
        mac.update(entity_type.as_bytes());
        hex(&mac.finalize().into_bytes())
    }

    /// A window's stream of one pair's changes; the subscription is written when it is new or old.
    pub fn watch(
        self: &Arc<Self>,
        space: &str,
        entity_type: &str,
    ) -> broadcast::Receiver<Arc<Changed>> {
        let pair = (space.to_owned(), entity_type.to_owned());
        self.keys
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(self.key(space, entity_type), pair.clone());
        let receiver = self
            .channels
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(pair.clone())
            .or_insert_with(|| broadcast::channel(BUFFER).0)
            .subscribe();
        let due = {
            let mut written = self.written.lock().unwrap_or_else(|e| e.into_inner());
            let due = written
                .get(&pair)
                .is_none_or(|at| at.elapsed() >= RENEW_AFTER);
            if due {
                written.insert(pair.clone(), Instant::now());
            }
            due
        };
        if due {
            let hub = Arc::clone(self);
            tokio::spawn(async move {
                if let Err(reason) = hub.write(&pair.0, &pair.1).await {
                    tracing::warn!(space = %pair.0, r#type = %pair.1, %reason, "live-update subscription not written");
                    // The next window tries again rather than waiting half a day.
                    hub.written
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .remove(&pair);
                }
            });
        }
        receiver
    }

    /// The subscription of one pair, as API/01 §32 describes it.
    pub fn subscription(&self, id: &str, space: &str, entity_type: &str) -> Value {
        let expires = time::OffsetDateTime::now_utc() + LIFETIME;
        json!({
            "id": id,
            "type": "Subscription",
            "description": "Portal live updates of open data views (API/01 §32)",
            "entities": [{ "type": entity_type }],
            "notification": {
                "format": "keyValues",
                "endpoint": {
                    "uri": format!("{}/live-notify/{}", self.public_base, self.key(space, entity_type)),
                    "accept": "application/json"
                }
            },
            "expiresAt": expires
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap_or_default(),
        })
    }

    async fn write(&self, space: &str, entity_type: &str) -> Result<(), String> {
        let Some(writer) = &self.writer else {
            return Err("no gateway, realm client or organization domain to write with".into());
        };
        // One id per pair, so a second write updates; the type is hashed into a name segment.
        let digest = Sha256::digest(entity_type.as_bytes());
        let id = writer.urn(space, &format!("portal-live-{}", &hex(&digest)[..16]));
        let token = writer.token().await?;
        writer
            .write(
                &token,
                space,
                &id,
                &self.subscription(&id, space, entity_type),
            )
            .await
    }

    /// Passes one notification on; `false` for a key this process never made.
    pub fn deliver(&self, key: &str, body: &Value) -> bool {
        let Some(pair) = self
            .keys
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(key)
            .cloned()
        else {
            return false;
        };
        let changed = Arc::new(changed_of(&pair.1, body));
        if let Some(sender) = self
            .channels
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&pair)
        {
            // No window left is not an error: the subscription expires on its own.
            let _ = sender.send(changed);
        }
        true
    }
}

/// Which entities and attributes a notification names; its values are dropped here.
pub fn changed_of(entity_type: &str, body: &Value) -> Changed {
    let mut ids = Vec::new();
    let mut attrs = std::collections::BTreeSet::new();
    for entity in body["data"].as_array().into_iter().flatten() {
        if let Some(id) = entity["id"].as_str() {
            ids.push(id.to_owned());
        }
        for key in entity
            .as_object()
            .into_iter()
            .flat_map(|object| object.keys())
        {
            if !matches!(key.as_str(), "id" | "type" | "@context") {
                attrs.insert(key.clone());
            }
        }
    }
    Changed {
        entity_type: entity_type.to_owned(),
        ids,
        attrs: attrs.into_iter().collect(),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_names_one_pair_and_only_this_process_makes_it() {
        let hub = LiveHub::new("https://portal.example/", None);
        let other = LiveHub::new("https://portal.example", None);
        assert_eq!(hub.key("bikes", "Station"), hub.key("bikes", "Station"));
        assert_ne!(hub.key("bikes", "Station"), hub.key("bikes", "Road"));
        assert_ne!(hub.key("bikes", "Station"), hub.key("bikesS", "tation"));
        assert_ne!(hub.key("bikes", "Station"), other.key("bikes", "Station"));
        let body = hub.subscription("urn:ngsi-ld:Subscription:x", "bikes", "Station");
        assert_eq!(
            body["notification"]["endpoint"]["uri"],
            format!(
                "https://portal.example/live-notify/{}",
                hub.key("bikes", "Station")
            )
        );
        assert_eq!(body["entities"], json!([{ "type": "Station" }]));
    }

    #[test]
    fn a_notification_is_passed_on_by_name_without_its_values() {
        let changed = changed_of(
            "Station",
            &json!({ "data": [
                { "id": "urn:ngsi-ld:Station:1", "type": "Station", "free": 3, "name": "A" },
                { "id": "urn:ngsi-ld:Station:2", "type": "Station", "free": 0 },
                "not an entity"
            ] }),
        );
        assert_eq!(
            changed.ids,
            ["urn:ngsi-ld:Station:1", "urn:ngsi-ld:Station:2"]
        );
        assert_eq!(changed.attrs, ["free", "name"]);
        assert!(!serde_json::to_string(&changed)
            .expect("json")
            .contains("\"A\""));
    }

    #[tokio::test]
    async fn the_first_watcher_writes_the_subscription_once_through_the_space_surface() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/realms/jc/protocol/openid-connect/token"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({ "access_token": "t", "expires_in": 60 })),
            )
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/cs/bikes/ngsi-ld/v1/subscriptions"))
            .respond_with(ResponseTemplate::new(201))
            .expect(1)
            .mount(&server)
            .await;
        let writer = SubscriptionSync::new(
            server.uri(),
            &format!("{}/realms/jc", server.uri()),
            "portal".into(),
            crate::config::ClientAuth::Secret("secret".into()),
            "hel.fi",
        );
        let hub = Arc::new(LiveHub::new(
            "https://portal.example",
            Some(Arc::new(writer)),
        ));
        let _a = hub.watch("bikes", "Station");
        let _b = hub.watch("bikes", "Station");
        for _ in 0..50 {
            if !server
                .received_requests()
                .await
                .unwrap_or_default()
                .iter()
                .any(|r| r.url.path().contains("/subscriptions"))
            {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
        let written: Vec<Value> = server
            .received_requests()
            .await
            .unwrap_or_default()
            .iter()
            .filter(|r| r.url.path().contains("/subscriptions"))
            .map(|r| serde_json::from_slice(&r.body).unwrap_or_default())
            .collect();
        assert_eq!(written.len(), 1, "one write for two windows");
        assert!(written[0]["id"]
            .as_str()
            .unwrap_or_default()
            .starts_with("urn:ngsi-ld:Subscription:hel.fi:bikes:portal-live-"));
        assert_eq!(
            written[0]["notification"]["endpoint"]["uri"],
            format!(
                "https://portal.example/live-notify/{}",
                hub.key("bikes", "Station")
            )
        );
    }

    #[tokio::test]
    async fn a_watcher_hears_its_pair_and_an_unknown_key_is_refused() {
        let hub = Arc::new(LiveHub::new("https://portal.example", None));
        let mut stations = hub.watch("bikes", "Station");
        let mut roads = hub.watch("bikes", "Road");
        assert!(hub.deliver(
            &hub.key("bikes", "Station"),
            &json!({ "data": [{ "id": "urn:ngsi-ld:Station:1", "free": 1 }] })
        ));
        assert_eq!(
            stations.recv().await.expect("a change").ids,
            ["urn:ngsi-ld:Station:1"]
        );
        assert!(roads.try_recv().is_err());
        assert!(!hub.deliver("0".repeat(64).as_str(), &json!({})));
        assert!(!hub.deliver(&LiveHub::new("x", None).key("bikes", "Station"), &json!({})));
    }
}
