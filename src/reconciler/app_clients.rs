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
//! The App's roles live on its client (AP-113): every `spec.roles[]` entry is a client role, and
//! every `spec.access[]` subject a role mapping this wave writes, a group mapping for a `group`
//! and a user mapping for a `user`. It is the only writer of both, so a role or a mapping made in
//! the console is removed and reported. Audience mappers put `app-{name}` and the slug of every
//! Endpoint the App reads into the client's tokens, so the gateway admits them there.
//!
//! Keycloak generates each secret. The wave reads it back for the edge file (AP-112) and holds
//! it in [`ClientSecret`], whose `Debug` never shows the value; it is never logged, stored in a
//! manifest or written to a ConfigMap.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use jc_core::kinds::{AppLifecycle, AppSpec};
use serde::Deserialize;
use serde_json::{json, Value};

use super::groups::{MANAGED_BY, MANAGED_VALUE};
use crate::resource::ResourceEnvelope;
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

impl From<String> for ClientSecret {
    fn from(value: String) -> Self {
        Self(value)
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
    /// A subject the realm has no group or user for yet: its mapping is written once it does
    /// (a group the group wave creates, a person at their first login), so never a failure.
    pub warnings: Vec<String>,
    pub error: Option<String>,
}

impl ClientOutcome {
    pub(crate) fn of(app: &str) -> Self {
        Self {
            app: app.to_owned(),
            drift: Vec::new(),
            warnings: Vec::new(),
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
#[derive(Debug, Clone)]
struct PublishedApp {
    project: String,
    name: String,
    /// What the login page calls the App (PF-90): [`title_of`].
    title: String,
    /// `None` when the manifest does not parse: the client is still kept, its roles are not.
    spec: Option<AppSpec>,
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
            title: title_of(&envelope),
            name: envelope.metadata.name,
            spec: serde_json::from_value(envelope.spec).ok(),
        })
        .collect();
    apps.sort_by(|a, b| a.name.cmp(&b.name));
    apps.dedup_by(|a, b| a.name == b.name);
    apps
}

/// The App's title as a person reads it on the login page, "Sign in to {title} · {organization}"
/// (PF-90): the English title of the legacy map, the plain one, or the App's name when it has
/// none. The realm's default language is English, and a client has one name.
pub fn title_of(app: &ResourceEnvelope) -> String {
    app.metadata
        .title
        .as_ref()
        .map(|title| title.resolve(&["en".to_owned()], "").trim().to_owned())
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| app.metadata.name.clone())
}

/// The client an App should have, as Keycloak's representation (AP-111). `host` is the apex
/// the apps are served on, `city.example.com`; `title` is [`title_of`] the App.
pub fn desired(project: &str, app: &str, title: &str, host: &str) -> Value {
    let base = format!("https://{host}/apps/{app}/");
    json!({
        "clientId": client_id(app),
        "name": title,
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

/// Who holds an App role: a Keycloak group by name, or a user by e-mail or username.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum Holder {
    Group(String),
    User(String),
}

impl std::fmt::Display for Holder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Holder::Group(name) => write!(f, "group {name}"),
            Holder::User(user) => write!(f, "user {user}"),
        }
    }
}

/// Each role of the App with the subjects `spec.access` gives it (AP-113). A role nobody holds is
/// still a role; an access entry naming a role the App does not declare grants nothing (jc-core
/// refuses such a manifest, and this does not trust that alone).
pub fn holders(spec: &AppSpec) -> BTreeMap<String, BTreeSet<Holder>> {
    let mut roles: BTreeMap<String, BTreeSet<Holder>> = spec
        .roles
        .iter()
        .map(|role| (role.name.clone(), BTreeSet::new()))
        .collect();
    for access in &spec.access {
        let Some(held) = roles.get_mut(&access.role) else {
            continue;
        };
        for subject in &access.subjects {
            if let Some(group) = &subject.group {
                held.insert(Holder::Group(group.clone()));
            }
            if let Some(user) = &subject.user {
                held.insert(Holder::User(user.to_ascii_lowercase()));
            }
        }
    }
    roles
}

/// The prefix of the audience mappers this wave owns on an App's client.
const AUDIENCE_MAPPER: &str = "audience-";

/// The audience mapper that puts `audience` into the client's access tokens (AP-113).
pub fn audience_mapper(audience: &str) -> Value {
    json!({
        "name": format!("{AUDIENCE_MAPPER}{audience}"),
        "protocol": "openid-connect",
        "protocolMapper": "oidc-audience-mapper",
        "config": {
            "included.custom.audience": audience,
            "access.token.claim": "true",
            "id.token.claim": "false",
            "introspection.token.claim": "true",
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

pub(crate) fn managed(client: &Value) -> bool {
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

/// A role, or a group, as the admin API lists one.
#[derive(Debug, Deserialize)]
struct KcNamed {
    id: String,
    name: String,
}

#[derive(Debug, Deserialize)]
struct KcUserRef {
    id: String,
    #[serde(default)]
    username: String,
    #[serde(default)]
    email: Option<String>,
}

impl KcUserRef {
    fn is(&self, user: &str) -> bool {
        self.username.eq_ignore_ascii_case(user)
            || self
                .email
                .as_deref()
                .is_some_and(|email| email.eq_ignore_ascii_case(user))
    }
}

/// The realm's groups and users one run has looked up, so each is asked for once per run.
#[derive(Default)]
struct RealmIndex {
    groups: Option<BTreeMap<String, String>>,
    users: BTreeMap<String, Option<String>>,
}

/// The realm's admin API as the Portal's own client reaches it: a token by `client_credentials`
/// and calls under `/admin/realms/{realm}`. Shared by every wave that writes clients.
pub struct Admin {
    http: reqwest::Client,
    /// `https://idm.host/realms/{realm}`: where the token comes from.
    issuer: String,
    /// `https://idm.host/admin/realms/{realm}`: where the clients are.
    admin: String,
    client_id: String,
    client_secret: String,
}

impl Admin {
    /// `None` when the issuer is not a realm URL, because then there is nothing to manage.
    pub fn new(issuer: &str, client_id: String, client_secret: String) -> Option<Self> {
        let trimmed = issuer.trim_end_matches('/');
        let (root, realm) = trimmed.rsplit_once("/realms/")?;
        Some(Self {
            http: reqwest::Client::builder().timeout(TIMEOUT).build().ok()?,
            issuer: trimmed.to_owned(),
            admin: format!("{root}/admin/realms/{realm}"),
            client_id,
            client_secret,
        })
    }

    pub(crate) async fn token(&self) -> Result<String, String> {
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

    pub(crate) async fn send(
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

    pub(crate) async fn get<T: serde::de::DeserializeOwned>(
        &self,
        token: &str,
        path: &str,
    ) -> Result<T, String> {
        let value = self
            .send(token, reqwest::Method::GET, path, None)
            .await?
            .unwrap_or(Value::Null);
        serde_json::from_value(value).map_err(|err| format!("GET {path}: {err}"))
    }

    /// The realm's client of one id, or `None`.
    pub(crate) async fn find(&self, token: &str, id: &str) -> Result<Option<Value>, String> {
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

    /// The client's audience mappers brought to `audiences`: a missing one is added, a changed
    /// one written back, and one this platform wrote for an audience no longer named removed.
    /// `owner` names what decides the audiences in the drift report, "the App" or "the account".
    pub(crate) async fn converge_audiences(
        &self,
        token: &str,
        uuid: &str,
        audiences: &[String],
        owner: &str,
        outcome: &mut ClientOutcome,
    ) -> Result<(), String> {
        use reqwest::Method;
        let client = format!("/clients/{uuid}");
        let mappers: Vec<Value> = self
            .get(token, &format!("{client}/protocol-mappers/models"))
            .await?;
        let ours = |mapper: &&Value| {
            mapper["protocolMapper"] == "oidc-audience-mapper"
                && mapper["name"]
                    .as_str()
                    .is_some_and(|name| name.starts_with(AUDIENCE_MAPPER))
        };
        for audience in audiences {
            let want = audience_mapper(audience);
            match mappers
                .iter()
                .filter(ours)
                .find(|m| m["name"] == want["name"])
            {
                None => {
                    self.send(
                        token,
                        Method::POST,
                        &format!("{client}/protocol-mappers/models"),
                        Some(&want),
                    )
                    .await?;
                }
                Some(mapper) => {
                    let differs = want["config"]
                        .as_object()
                        .into_iter()
                        .flatten()
                        .any(|(key, value)| mapper["config"].get(key) != Some(value));
                    if differs {
                        let Some(id) = mapper["id"].as_str() else {
                            return Err(format!("the mapper {} has no id", want["name"]));
                        };
                        let mut body = want.clone();
                        body["id"] = json!(id);
                        self.send(
                            token,
                            Method::PUT,
                            &format!("{client}/protocol-mappers/models/{id}"),
                            Some(&body),
                        )
                        .await?;
                        outcome.drift.push(format!(
                            "the audience mapper for {audience} was changed; it was written back"
                        ));
                    }
                }
            }
        }
        for mapper in mappers.iter().filter(ours) {
            let name = mapper["name"].as_str().unwrap_or_default();
            if audiences
                .iter()
                .any(|a| name == format!("{AUDIENCE_MAPPER}{a}"))
            {
                continue;
            }
            let Some(id) = mapper["id"].as_str() else {
                continue;
            };
            self.send(
                token,
                Method::DELETE,
                &format!("{client}/protocol-mappers/models/{id}"),
                None,
            )
            .await?;
            outcome.drift.push(format!(
                "the client put the audience {} in its tokens, which {owner} does not read; the mapper was removed",
                name.trim_start_matches(AUDIENCE_MAPPER)
            ));
        }
        Ok(())
    }
}

/// The realm's app clients, as the reconciler's own client may write them.
pub struct AppClientSync {
    admin: Admin,
    /// The apex the apps are served on.
    host: String,
    /// Where a run records the `app-*` clients it may not write, for the write doors (AP-114).
    foreign: Option<std::sync::Arc<super::foreign::ForeignNames>>,
}

impl AppClientSync {
    /// Makes each run record the realm's unmanaged `app-*` clients where the write doors read
    /// them.
    pub fn with_foreign(mut self, foreign: std::sync::Arc<super::foreign::ForeignNames>) -> Self {
        self.foreign = Some(foreign);
        self
    }

    /// `None` when the issuer is not a realm URL, because then there is nothing to manage.
    pub fn new(
        issuer: &str,
        client_id: String,
        client_secret: String,
        host: String,
    ) -> Option<Self> {
        Some(Self {
            admin: Admin::new(issuer, client_id, client_secret)?,
            host,
            foreign: None,
        })
    }

    /// The id of the realm's group of this name; `None` while there is none.
    async fn group_id(
        &self,
        token: &str,
        index: &mut RealmIndex,
        name: &str,
    ) -> Result<Option<String>, String> {
        if index.groups.is_none() {
            let groups: Vec<KcNamed> = self
                .admin
                .get(token, "/groups?briefRepresentation=true&max=1000")
                .await?;
            index.groups = Some(groups.into_iter().map(|g| (g.name, g.id)).collect());
        }
        Ok(index
            .groups
            .as_ref()
            .and_then(|groups| groups.get(name))
            .cloned())
    }

    /// The id of the realm's user of this e-mail or username; `None` before their first login.
    async fn user_id(
        &self,
        token: &str,
        index: &mut RealmIndex,
        user: &str,
    ) -> Result<Option<String>, String> {
        if let Some(known) = index.users.get(user) {
            return Ok(known.clone());
        }
        let field = if user.contains('@') {
            "email"
        } else {
            "username"
        };
        let found: Vec<KcUserRef> = self
            .admin
            .get(
                token,
                &format!(
                    "/users?exact=true&{field}={}",
                    super::groups::urlencoding(user)
                ),
            )
            .await?;
        let id = found.into_iter().find(|u| u.is(user)).map(|u| u.id);
        index.users.insert(user.to_owned(), id.clone());
        Ok(id)
    }

    /// The App's roles, who holds each, and its audiences, brought to the manifest (AP-113).
    /// What the realm held and the manifest does not say goes, and is reported as drift.
    async fn converge_grants(
        &self,
        token: &str,
        uuid: &str,
        spec: &AppSpec,
        audiences: &[String],
        index: &mut RealmIndex,
        outcome: &mut ClientOutcome,
    ) -> Result<(), String> {
        use reqwest::Method;
        let client = format!("/clients/{uuid}");
        let wanted = holders(spec);

        let mut held: Vec<KcNamed> = self.admin.get(token, &format!("{client}/roles")).await?;
        for role in held.iter().filter(|role| !wanted.contains_key(&role.name)) {
            self.admin
                .send(
                    token,
                    Method::DELETE,
                    &format!("{client}/roles/{}", role.name),
                    None,
                )
                .await?;
            outcome.drift.push(format!(
                "the client held the role {}, which the App does not declare; it was removed",
                role.name
            ));
        }
        let missing: Vec<&String> = wanted
            .keys()
            .filter(|name| !held.iter().any(|role| &role.name == *name))
            .collect();
        for name in &missing {
            self.admin
                .send(
                    token,
                    Method::POST,
                    &format!("{client}/roles"),
                    Some(&json!({ "name": name })),
                )
                .await?;
        }
        if !missing.is_empty() {
            held = self.admin.get(token, &format!("{client}/roles")).await?;
        }

        for (name, subjects) in &wanted {
            let role = held
                .iter()
                .find(|role| &role.name == name)
                .ok_or_else(|| format!("the role {name} was created and cannot be read back"))?;
            let mapping = json!([{ "id": role.id, "name": role.name }]);

            let groups: Vec<KcNamed> = self
                .admin
                .get(
                    token,
                    &format!("{client}/roles/{name}/groups?briefRepresentation=true&max=1000"),
                )
                .await?;
            let users: Vec<KcUserRef> = self
                .admin
                .get(token, &format!("{client}/roles/{name}/users?max=1000"))
                .await?;
            for group in &groups {
                if !subjects.contains(&Holder::Group(group.name.clone())) {
                    self.admin
                        .send(
                            token,
                            Method::DELETE,
                            &format!("/groups/{}/role-mappings/clients/{uuid}", group.id),
                            Some(&mapping),
                        )
                        .await?;
                    outcome.drift.push(format!(
                        "the group {} held the role {name} and the App does not give it; the mapping was removed",
                        group.name
                    ));
                }
            }
            for user in &users {
                let named = subjects
                    .iter()
                    .any(|holder| matches!(holder, Holder::User(u) if user.is(u)));
                if !named {
                    self.admin
                        .send(
                            token,
                            Method::DELETE,
                            &format!("/users/{}/role-mappings/clients/{uuid}", user.id),
                            Some(&mapping),
                        )
                        .await?;
                    outcome.drift.push(format!(
                        "the user {} held the role {name} and the App does not give it; the mapping was removed",
                        user.email.as_deref().unwrap_or(&user.username)
                    ));
                }
            }
            for holder in subjects {
                let (path, id) = match holder {
                    Holder::Group(group) => {
                        if groups.iter().any(|g| &g.name == group) {
                            continue;
                        }
                        ("groups", self.group_id(token, index, group).await?)
                    }
                    Holder::User(user) => {
                        if users.iter().any(|u| u.is(user)) {
                            continue;
                        }
                        ("users", self.user_id(token, index, user).await?)
                    }
                };
                match id {
                    Some(id) => {
                        self.admin
                            .send(
                                token,
                                Method::POST,
                                &format!("/{path}/{id}/role-mappings/clients/{uuid}"),
                                Some(&mapping),
                            )
                            .await?;
                    }
                    None => outcome.warnings.push(format!(
                        "the realm has no {holder} yet, so the role {name} is mapped once it does"
                    )),
                }
            }
        }

        self.admin
            .converge_audiences(token, uuid, audiences, "the App", outcome)
            .await
    }

    async fn secret(&self, token: &str, uuid: &str) -> Result<ClientSecret, String> {
        let value = self
            .admin
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
        let token = match self.admin.token().await {
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
        let mut index = RealmIndex::default();
        for app in &apps {
            let audiences: Vec<String> = std::iter::once(client_id(&app.name))
                .chain(app.spec.iter().flat_map(|spec| {
                    crate::apps::static_host::served_endpoints(
                        mirror,
                        &app.project,
                        &app.name,
                        spec,
                    )
                    .into_iter()
                    .map(|endpoint| endpoint.slug)
                }))
                .collect();
            let (outcome, secret) = self.converge_one(&token, app, &audiences, &mut index).await;
            if let Some(secret) = secret {
                run.secrets.insert(app.name.clone(), secret);
            }
            run.outcomes.push(outcome);
        }

        // A managed app client no published App names is this wave's to remove (AP-111).
        match self
            .admin
            .send(
                &token,
                reqwest::Method::GET,
                "/clients?search=true&clientId=app-&max=1000",
                None,
            )
            .await
        {
            Ok(listed) => {
                if let Some(foreign) = self.foreign.as_ref() {
                    foreign.set_clients(
                        listed
                            .as_ref()
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .filter(|client| !managed(client))
                            .filter_map(|client| client.get("clientId").and_then(Value::as_str))
                            .filter(|id| id.starts_with("app-"))
                            .map(str::to_owned)
                            .collect(),
                    );
                }
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
                            .admin
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
        audiences: &[String],
        index: &mut RealmIndex,
    ) -> (ClientOutcome, Option<ClientSecret>) {
        let mut outcome = ClientOutcome::of(&app.name);
        let id = client_id(&app.name);
        let want = desired(&app.project, &app.name, &app.title, &self.host);

        let held = match self.admin.find(token, &id).await {
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
                        .admin
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
                    .admin
                    .send(token, reqwest::Method::POST, "/clients", Some(&want))
                    .await
                {
                    outcome.error = Some(err);
                    return (outcome, None);
                }
                match self.admin.find(token, &id).await {
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
        // The login works without the roles, so a failure here keeps the secret on the edge.
        let grants = match &app.spec {
            Some(spec) => {
                self.converge_grants(token, &uuid, spec, audiences, index, &mut outcome)
                    .await
            }
            None => {
                Err("the App manifest does not parse, so its roles were not written".to_owned())
            }
        };
        if let Err(err) = grants {
            outcome.error = Some(format!("roles of {id}: {err}"));
        }
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

    /// PF-90: the login page reads "Sign in to {client name} · {organization}", so the client is
    /// named after the App's title, and an App without one after its name, never `project/app`.
    #[test]
    fn the_client_is_named_after_the_apps_title() {
        let titled = envelope_of(json!({ "name": "air-quality", "namespace": "helsinki",
            "title": { "fi": "Ilmanlaatu", "en": "Air quality" } }));
        assert_eq!(title_of(&titled), "Air quality");
        let plain =
            envelope_of(json!({ "name": "bikes", "namespace": "helsinki", "title": "City bikes" }));
        assert_eq!(title_of(&plain), "City bikes");
        let blank = envelope_of(json!({ "name": "bikes", "namespace": "helsinki", "title": "  " }));
        assert_eq!(title_of(&blank), "bikes");
        let untitled = envelope_of(json!({ "name": "bikes", "namespace": "helsinki" }));
        assert_eq!(title_of(&untitled), "bikes");
        assert_eq!(
            desired("helsinki", "bikes", "City bikes", "city.example")["name"],
            "City bikes"
        );
    }

    fn envelope_of(metadata: Value) -> ResourceEnvelope {
        serde_json::from_value(json!({
            "apiVersion": "joinedcontext.com/v1alpha1", "kind": "App", "metadata": metadata, "spec": {},
        }))
        .expect("an envelope")
    }

    #[test]
    fn a_secret_never_shows_in_debug() {
        let secret = ClientSecret("hunter2-value".to_owned());
        assert_eq!(format!("{secret:?}"), "ClientSecret(redacted)");
        assert_eq!(secret.expose(), "hunter2-value");
    }

    #[test]
    fn the_client_redirects_only_under_its_own_path_and_has_no_other_flow() {
        let want = desired("helsinki", "bikes", "Bikes", "city.example");
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
        let want = desired("helsinki", "bikes", "Bikes", "city.example");
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
    fn holders_follow_access_and_an_undeclared_role_grants_nothing() {
        let spec: AppSpec = serde_json::from_value(json!({
            "kind": "static", "source": { "path": "." }, "build": {}, "visibility": "project",
            "dataNeeds": [],
            "roles": [{ "name": "viewer" }, { "name": "steward" }],
            "access": [
                { "role": "viewer", "subjects": [{ "group": "stewards" }, { "user": "Jana@Hel.fi" }] },
                { "role": "ghost", "subjects": [{ "group": "everyone" }] },
            ],
        }))
        .expect("an App spec");
        let held = holders(&spec);
        assert_eq!(held.len(), 2, "every declared role, and no other");
        assert_eq!(
            held["viewer"],
            BTreeSet::from([
                Holder::Group("stewards".into()),
                Holder::User("jana@hel.fi".into())
            ])
        );
        assert!(held["steward"].is_empty());
        assert!(!held.contains_key("ghost"));
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
