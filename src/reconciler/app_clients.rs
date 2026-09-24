//! The Keycloak client of every published App (ADR-N-030, AP-111, T-2677).
//!
//! Each published App logs people in with a confidential client of its own, `app-{name}`: the
//! standard flow with PKCE, no direct grants, no service account, redirect and post-logout URIs
//! under `/apps/{name}/` only. This wave is the only writer of such a client: it carries the
//! attribute `managed-by: joinedcontext` and the App it belongs to, a change made in the console
//! is overwritten and reported, and a managed client whose App is no longer published is
//! deleted. A client of that id without the attribute belongs to whoever made it and is never
//! read for drift, written or removed; the App is reported as blocked instead (AP-114).
//!
//! Keycloak generates each secret. The wave reads it back for the edge file (AP-112) and holds
//! it in [`ClientSecret`], whose `Debug` never shows the value; it is never logged, stored in a
//! manifest or written to a ConfigMap.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use jc_core::kinds::AppLifecycle;
use serde::Deserialize;
use serde_json::{json, Value};

use super::groups::{MANAGED_BY, MANAGED_VALUE};
use crate::store::Mirror;

/// The client attribute naming the App a managed client belongs to, `{project}/{name}`.
pub const APP_ATTRIBUTE: &str = "joinedcontext.app";

const TIMEOUT: Duration = Duration::from_secs(20);

/// The id of an App's client: one name for the organization, as the App name is (AP-14a).
pub fn client_id(app: &str) -> String {
    format!("app-{app}")
}

/// A client secret as Keycloak generated it. Only [`ClientSecret::expose`] reads the value.
#[derive(Clone, PartialEq, Eq)]
pub struct ClientSecret(String);

impl ClientSecret {
    /// The value, for the one place that writes it into the edge Secret.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for ClientSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ClientSecret(redacted)")
    }
}

/// What one run did with one App's client.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientOutcome {
    /// The App name, or `*` for a failure before any App was looked at.
    pub app: String,
    /// What was different from the manifest and has been written back; empty when it matched.
    pub drift: Vec<String>,
    pub error: Option<String>,
}

impl ClientOutcome {
    fn of(app: &str) -> Self {
        Self {
            app: app.to_owned(),
            drift: Vec::new(),
            error: None,
        }
    }
}

/// What a run leaves behind: one outcome per App touched, and the secret of every App whose
/// client is in place, keyed by App name.
#[derive(Debug, Default)]
pub struct ClientRun {
    pub outcomes: Vec<ClientOutcome>,
    pub secrets: BTreeMap<String, ClientSecret>,
}

/// One published App, as this wave needs it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PublishedApp {
    project: String,
    name: String,
}

/// The published Apps of the mirror, sorted by name so a run is deterministic.
fn published(mirror: &Mirror) -> Vec<PublishedApp> {
    let mut apps: Vec<PublishedApp> = mirror
        .matching(|envelope| {
            envelope.kind == "App"
                && envelope.spec.get("lifecycle").and_then(Value::as_str)
                    == Some(AppLifecycle::Published.as_str())
        })
        .into_iter()
        .map(|envelope| PublishedApp {
            project: envelope.metadata.namespace.clone().unwrap_or_default(),
            name: envelope.metadata.name,
        })
        .collect();
    apps.sort_by(|a, b| a.name.cmp(&b.name));
    apps.dedup_by(|a, b| a.name == b.name);
    apps
}

/// The client an App should have, as Keycloak's representation (AP-111). `host` is the apex
/// the apps are served on, `city.example.com`.
pub fn desired(project: &str, app: &str, host: &str) -> Value {
    let base = format!("https://{host}/apps/{app}/");
    json!({
        "clientId": client_id(app),
        "name": format!("{project}/{app}"),
        "protocol": "openid-connect",
        "enabled": true,
        "publicClient": false,
        "bearerOnly": false,
        "standardFlowEnabled": true,
        "implicitFlowEnabled": false,
        "directAccessGrantsEnabled": false,
        "serviceAccountsEnabled": false,
        "frontchannelLogout": true,
        "redirectUris": [format!("{base}*")],
        "webOrigins": [format!("https://{host}")],
        "attributes": {
            "pkce.code.challenge.method": "S256",
            "post.logout.redirect.uris": format!("{base}*"),
            // The edge verifies RS256, as it does for the shared `edge` client (AP-27).
            "access.token.signed.response.alg": "RS256",
            "id.token.signed.response.alg": "RS256",
            MANAGED_BY: MANAGED_VALUE,
            APP_ATTRIBUTE: format!("{project}/{app}"),
        },
    })
}

/// The fields of `want` the realm holds otherwise, as sentences for the drift report. Only the
/// fields [`desired`] sets are compared: Keycloak fills in many more, which are its own.
pub fn drift(want: &Value, held: &Value) -> Vec<String> {
    let mut found = Vec::new();
    let Some(want) = want.as_object() else {
        return found;
    };
    for (field, value) in want {
        if field == "attributes" {
            let held_attributes = held.get("attributes");
            for (key, wanted) in value.as_object().into_iter().flatten() {
                let current = held_attributes.and_then(|a| a.get(key));
                if current != Some(wanted) {
                    found.push(format!(
                        "attribute {key} was {}, the App says {wanted}",
                        current.map_or("unset".to_owned(), Value::to_string)
                    ));
                }
            }
            continue;
        }
        let current = held.get(field);
        if current != Some(value) {
            found.push(format!(
                "{field} was {}, the App says {value}",
                current.map_or("unset".to_owned(), Value::to_string)
            ));
        }
    }
    found
}

fn managed(client: &Value) -> bool {
    client
        .get("attributes")
        .and_then(|a| a.get(MANAGED_BY))
        .and_then(Value::as_str)
        == Some(MANAGED_VALUE)
}

#[derive(Debug, Deserialize)]
struct KcToken {
    access_token: String,
}

/// The realm's app clients, as the reconciler's own client may write them.
pub struct AppClientSync {
    http: reqwest::Client,
    /// `https://idm.host/realms/{realm}`: where the token comes from.
    issuer: String,
    /// `https://idm.host/admin/realms/{realm}`: where the clients are.
    admin: String,
    client_id: String,
    client_secret: String,
    /// The apex the apps are served on.
    host: String,
}

impl AppClientSync {
    /// `None` when the issuer is not a realm URL, because then there is nothing to manage.
    pub fn new(
        issuer: &str,
        client_id: String,
        client_secret: String,
        host: String,
    ) -> Option<Self> {
        let trimmed = issuer.trim_end_matches('/');
        let (root, realm) = trimmed.rsplit_once("/realms/")?;
        Some(Self {
            http: reqwest::Client::builder().timeout(TIMEOUT).build().ok()?,
            issuer: trimmed.to_owned(),
            admin: format!("{root}/admin/realms/{realm}"),
            client_id,
            client_secret,
            host,
        })
    }

    async fn token(&self) -> Result<String, String> {
        let response = self
            .http
            .post(format!("{}/protocol/openid-connect/token", self.issuer))
            .form(&[
                ("grant_type", "client_credentials"),
                ("client_id", self.client_id.as_str()),
                ("client_secret", self.client_secret.as_str()),
            ])
            .send()
            .await
            .map_err(|err| err.to_string())?;
        if !response.status().is_success() {
            return Err(format!(
                "the realm refused the reconciler's client: {}",
                response.status()
            ));
        }
        let token: KcToken = response.json().await.map_err(|err| err.to_string())?;
        Ok(token.access_token)
    }

    async fn send(
        &self,
        token: &str,
        method: reqwest::Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Option<Value>, String> {
        let mut request = self
            .http
            .request(method.clone(), format!("{}{path}", self.admin))
            .bearer_auth(token);
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().await.map_err(|err| err.to_string())?;
        if !response.status().is_success() {
            // The path names a client id at most, never a secret; the body is not echoed.
            return Err(format!("{method} {path}: {}", response.status()));
        }
        if method == reqwest::Method::GET {
            return response
                .json()
                .await
                .map(Some)
                .map_err(|err| err.to_string());
        }
        Ok(None)
    }

    /// The realm's client of one id, or `None`.
    async fn find(&self, token: &str, id: &str) -> Result<Option<Value>, String> {
        let found = self
            .send(
                token,
                reqwest::Method::GET,
                &format!("/clients?clientId={id}"),
                None,
            )
            .await?
            .unwrap_or(Value::Null);
        Ok(found.as_array().and_then(|list| list.first()).cloned())
    }

    async fn secret(&self, token: &str, uuid: &str) -> Result<ClientSecret, String> {
        let value = self
            .send(
                token,
                reqwest::Method::GET,
                &format!("/clients/{uuid}/client-secret"),
                None,
            )
            .await?
            .unwrap_or(Value::Null);
        value
            .get("value")
            .and_then(Value::as_str)
            .filter(|secret| !secret.is_empty())
            .map(|secret| ClientSecret(secret.to_owned()))
            .ok_or_else(|| "the realm answered no secret for the client".to_owned())
    }

    /// Brings every published App's client to what [`desired`] says, deletes the managed clients
    /// no published App names, and answers the outcomes and the secrets.
    pub async fn converge(&self, mirror: &Mirror) -> ClientRun {
        let mut run = ClientRun::default();
        let token = match self.token().await {
            Ok(token) => token,
            Err(err) => {
                let mut outcome = ClientOutcome::of("*");
                outcome.error = Some(err);
                run.outcomes.push(outcome);
                return run;
            }
        };

        let apps = published(mirror);
        let wanted: BTreeSet<String> = apps.iter().map(|app| client_id(&app.name)).collect();
        for app in &apps {
            let (outcome, secret) = self.converge_one(&token, app).await;
            if let Some(secret) = secret {
                run.secrets.insert(app.name.clone(), secret);
            }
            run.outcomes.push(outcome);
        }

        // A managed app client no published App names is this wave's to remove (AP-111).
        match self
            .send(
                &token,
                reqwest::Method::GET,
                "/clients?search=true&clientId=app-&max=1000",
                None,
            )
            .await
        {
            Ok(listed) => {
                for client in listed
                    .as_ref()
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let Some(id) = client.get("clientId").and_then(Value::as_str) else {
                        continue;
                    };
                    if !id.starts_with("app-") || !managed(client) || wanted.contains(id) {
                        continue;
                    }
                    let app = id.trim_start_matches("app-");
                    let mut outcome = ClientOutcome::of(app);
                    match client.get("id").and_then(Value::as_str) {
                        Some(uuid) => match self
                            .send(
                                &token,
                                reqwest::Method::DELETE,
                                &format!("/clients/{uuid}"),
                                None,
                            )
                            .await
                        {
                            Ok(_) => outcome.drift.push(
                                "the App is no longer published, so its client was removed"
                                    .to_owned(),
                            ),
                            Err(err) => outcome.error = Some(err),
                        },
                        None => {
                            outcome.error =
                                Some("the realm listed a client without an id".to_owned())
                        }
                    }
                    run.outcomes.push(outcome);
                }
            }
            Err(err) => {
                let mut outcome = ClientOutcome::of("*");
                outcome.error = Some(format!("listing the app clients: {err}"));
                run.outcomes.push(outcome);
            }
        }
        run
    }

    async fn converge_one(
        &self,
        token: &str,
        app: &PublishedApp,
    ) -> (ClientOutcome, Option<ClientSecret>) {
        let mut outcome = ClientOutcome::of(&app.name);
        let id = client_id(&app.name);
        let want = desired(&app.project, &app.name, &self.host);

        let held = match self.find(token, &id).await {
            Ok(held) => held,
            Err(err) => {
                outcome.error = Some(err);
                return (outcome, None);
            }
        };
        let uuid = match held {
            Some(client) if !managed(&client) => {
                outcome.error = Some(format!(
                    "the realm holds a client {id} this platform did not create; it is left \
                     alone and the App has no login of its own until it is renamed or removed \
                     (AP-114)"
                ));
                return (outcome, None);
            }
            Some(client) => {
                let Some(uuid) = client.get("id").and_then(Value::as_str).map(str::to_owned) else {
                    outcome.error = Some(format!("the realm answered {id} without an id"));
                    return (outcome, None);
                };
                let found = drift(&want, &client);
                if !found.is_empty() {
                    if let Err(err) = self
                        .send(
                            token,
                            reqwest::Method::PUT,
                            &format!("/clients/{uuid}"),
                            Some(&want),
                        )
                        .await
                    {
                        outcome.error = Some(err);
                        return (outcome, None);
                    }
                    outcome.drift = found;
                }
                uuid
            }
            None => {
                if let Err(err) = self
                    .send(token, reqwest::Method::POST, "/clients", Some(&want))
                    .await
                {
                    outcome.error = Some(err);
                    return (outcome, None);
                }
                match self.find(token, &id).await {
                    Ok(Some(client)) => match client.get("id").and_then(Value::as_str) {
                        Some(uuid) => uuid.to_owned(),
                        None => {
                            outcome.error = Some(format!("the realm answered {id} without an id"));
                            return (outcome, None);
                        }
                    },
                    Ok(None) => {
                        outcome.error = Some(format!("{id} was created and cannot be read back"));
                        return (outcome, None);
                    }
                    Err(err) => {
                        outcome.error = Some(err);
                        return (outcome, None);
                    }
                }
            }
        };
        match self.secret(token, &uuid).await {
            Ok(secret) => (outcome, Some(secret)),
            Err(err) => {
                outcome.error = Some(err);
                (outcome, None)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_secret_never_shows_in_debug() {
        let secret = ClientSecret("hunter2-value".to_owned());
        assert_eq!(format!("{secret:?}"), "ClientSecret(redacted)");
        assert_eq!(secret.expose(), "hunter2-value");
    }

    #[test]
    fn the_client_redirects_only_under_its_own_path_and_has_no_other_flow() {
        let want = desired("helsinki", "bikes", "city.example");
        assert_eq!(want["clientId"], "app-bikes");
        assert_eq!(
            want["redirectUris"],
            json!(["https://city.example/apps/bikes/*"])
        );
        assert_eq!(want["directAccessGrantsEnabled"], false);
        assert_eq!(want["serviceAccountsEnabled"], false);
        assert_eq!(want["implicitFlowEnabled"], false);
        assert_eq!(want["publicClient"], false);
        assert_eq!(want["attributes"]["pkce.code.challenge.method"], "S256");
        assert_eq!(want["attributes"][MANAGED_BY], MANAGED_VALUE);
        assert_eq!(want["attributes"][APP_ATTRIBUTE], "helsinki/bikes");
    }

    #[test]
    fn drift_names_only_the_fields_the_app_sets() {
        let want = desired("helsinki", "bikes", "city.example");
        let mut held = want.clone();
        held["id"] = json!("uuid-1");
        held["surrogateAuthRequired"] = json!(false);
        assert!(
            drift(&want, &held).is_empty(),
            "fields Keycloak adds are its own"
        );

        held["directAccessGrantsEnabled"] = json!(true);
        held["redirectUris"] = json!(["*"]);
        held["attributes"]["pkce.code.challenge.method"] = json!("plain");
        let found = drift(&want, &held);
        assert_eq!(found.len(), 3, "{found:?}");
        assert!(found
            .iter()
            .any(|d| d.starts_with("directAccessGrantsEnabled")));
        assert!(found.iter().any(|d| d.starts_with("redirectUris")));
        assert!(found
            .iter()
            .any(|d| d.contains("pkce.code.challenge.method")));
    }

    #[test]
    fn a_client_without_the_attribute_is_not_managed() {
        assert!(!managed(&json!({ "clientId": "app-bikes" })));
        assert!(!managed(
            &json!({ "attributes": { MANAGED_BY: "someone" } })
        ));
        assert!(managed(
            &json!({ "attributes": { MANAGED_BY: MANAGED_VALUE } })
        ));
    }
}
