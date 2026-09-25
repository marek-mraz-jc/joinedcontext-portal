//! The people of the organization's realm, through Keycloak's admin API (PF-90, ADR-N-031).
//!
//! A person is a Keycloak user and never a manifest: their name and e-mail are personal data, so
//! they stay out of Git. The Portal's admin client (`JC_PORTAL_KEYCLOAK_ADMIN_CLIENT_ID`) holds
//! `manage-users` and `query-groups` of `realm-management` and nothing else (PF-63), which is
//! every right these calls need. Nothing here logs a password, a token or a request body.

use std::collections::HashMap;
use std::time::Duration;

use argon2::password_hash::rand_core::{OsRng, RngCore};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::ApiError;

const TIMEOUT: Duration = Duration::from_secs(20);

/// What the realm answered, in the words a caller of the people routes acts on.
#[derive(Debug, PartialEq, Eq)]
pub enum PeopleError {
    /// No such user.
    NotFound,
    /// Keycloak refused a duplicate: the e-mail or the username is taken.
    Conflict,
    /// The realm said no in some other way: status and what it said, never a secret.
    Refused(u16, String),
    /// The realm could not be reached, or answered something that is not JSON.
    Unreachable(String),
}

impl From<PeopleError> for ApiError {
    fn from(err: PeopleError) -> Self {
        match err {
            PeopleError::NotFound => ApiError::NotFound("the realm has no such person".into()),
            PeopleError::Conflict => {
                ApiError::Conflict("the realm already has a person with this e-mail".into())
            }
            PeopleError::Refused(status, message) => ApiError::Unavailable(format!(
                "the realm refused the request ({status}): {message}"
            )),
            PeopleError::Unreachable(message) => {
                ApiError::Unavailable(format!("the realm could not be reached: {message}"))
            }
        }
    }
}

/// A user as the admin API represents one; unknown members are ignored, since this is the realm's
/// shape and not ours.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KcUser {
    pub id: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub first_name: Option<String>,
    #[serde(default)]
    pub last_name: Option<String>,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub email_verified: bool,
    #[serde(default)]
    pub created_timestamp: Option<i64>,
    #[serde(default)]
    pub required_actions: Vec<String>,
    #[serde(default)]
    pub attributes: HashMap<String, Vec<String>>,
}

impl KcUser {
    /// The language the person chose, as Keycloak keeps it (the `locale` attribute).
    pub fn locale(&self) -> Option<&str> {
        self.attributes
            .get("locale")
            .and_then(|values| values.first())
            .map(String::as_str)
    }
}

/// A person to create: the e-mail is also the username (PF-04).
pub struct NewPerson<'a> {
    pub email: &'a str,
    pub first_name: &'a str,
    pub last_name: &'a str,
    pub locale: Option<&'a str>,
}

#[derive(Deserialize)]
struct Token {
    access_token: String,
}

#[derive(Deserialize)]
struct Credential {
    id: String,
    #[serde(rename = "type", default)]
    kind: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserSession {
    #[serde(default)]
    last_access: Option<i64>,
}

#[derive(Deserialize)]
struct NamedGroup {
    name: String,
}

#[derive(Deserialize)]
struct NamedRole {
    name: String,
}

/// The second factors a realm stores as credentials: removing them makes the person enrol again.
const SECOND_FACTORS: [&str; 3] = ["otp", "webauthn", "webauthn-passwordless"];

/// The realm's people, as this Portal's admin client may manage them.
pub struct People {
    http: reqwest::Client,
    issuer: String,
    admin: String,
    client_id: String,
    client_secret: String,
}

/// One authenticated conversation with the admin API: the token is fetched once per request the
/// Portal serves, not once per call.
pub struct Admin<'a> {
    people: &'a People,
    token: String,
}

impl People {
    /// `None` when the issuer is not a realm URL: then there is no realm to manage.
    pub fn new(issuer: &str, client_id: String, client_secret: String) -> Option<Self> {
        let issuer = issuer.trim_end_matches('/').to_owned();
        let (root, realm) = issuer.rsplit_once("/realms/")?;
        let admin = format!("{root}/admin/realms/{realm}");
        Some(Self {
            http: reqwest::Client::builder().timeout(TIMEOUT).build().ok()?,
            issuer,
            admin,
            client_id,
            client_secret,
        })
    }

    pub async fn admin(&self) -> Result<Admin<'_>, PeopleError> {
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
            .map_err(|err| PeopleError::Unreachable(err.without_url().to_string()))?;
        if !response.status().is_success() {
            return Err(PeopleError::Refused(
                response.status().as_u16(),
                "the realm refused the Portal's admin client".into(),
            ));
        }
        let token: Token = response
            .json()
            .await
            .map_err(|err| PeopleError::Unreachable(err.to_string()))?;
        Ok(Admin {
            people: self,
            token: token.access_token,
        })
    }
}

/// The realm's own message, when it gave one; never the request.
async fn refusal(response: reqwest::Response) -> PeopleError {
    let status = response.status().as_u16();
    match status {
        404 => PeopleError::NotFound,
        409 => PeopleError::Conflict,
        _ => {
            let message = response
                .json::<Value>()
                .await
                .ok()
                .and_then(|body| {
                    body.get("errorMessage")
                        .or_else(|| body.get("error"))
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .unwrap_or_else(|| "no reason given".into());
            PeopleError::Refused(status, message)
        }
    }
}

impl Admin<'_> {
    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.people.admin)
    }

    async fn send(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<reqwest::Response, PeopleError> {
        let response = request
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|err| PeopleError::Unreachable(err.without_url().to_string()))?;
        if response.status().is_success() {
            Ok(response)
        } else {
            Err(refusal(response).await)
        }
    }

    async fn json<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T, PeopleError> {
        self.send(self.people.http.get(self.url(path)))
            .await?
            .json()
            .await
            .map_err(|err| PeopleError::Unreachable(err.to_string()))
    }

    /// One page of people, `search` matching the name, e-mail or username.
    pub async fn list(
        &self,
        search: &str,
        first: u32,
        max: u32,
    ) -> Result<Vec<KcUser>, PeopleError> {
        let request = self.people.http.get(self.url("/users")).query(&[
            ("search", search),
            ("first", &first.to_string()),
            ("max", &max.to_string()),
            ("briefRepresentation", "false"),
        ]);
        self.send(request)
            .await?
            .json()
            .await
            .map_err(|err| PeopleError::Unreachable(err.to_string()))
    }

    pub async fn get(&self, id: &str) -> Result<KcUser, PeopleError> {
        self.json(&format!("/users/{}", segment(id)?)).await
    }

    /// The raw representation, for a read-modify-write that keeps what the Portal does not edit.
    async fn raw(&self, id: &str) -> Result<Value, PeopleError> {
        self.json(&format!("/users/{}", segment(id)?)).await
    }

    /// Creates the person with `VERIFY_EMAIL` and `UPDATE_PASSWORD` required, and answers the id.
    pub async fn create(&self, person: &NewPerson<'_>) -> Result<String, PeopleError> {
        let mut body = json!({
            "username": person.email,
            "email": person.email,
            "firstName": person.first_name,
            "lastName": person.last_name,
            "enabled": true,
            "emailVerified": false,
            "requiredActions": ["VERIFY_EMAIL", "UPDATE_PASSWORD"],
        });
        if let Some(locale) = person.locale {
            body["attributes"] = json!({ "locale": [locale] });
        }
        let response = self
            .send(self.people.http.post(self.url("/users")).json(&body))
            .await?;
        // The id is the last segment of `Location`; without one, find the person by e-mail.
        if let Some(id) = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|location| location.rsplit('/').next())
            .filter(|id| !id.is_empty())
        {
            return Ok(id.to_owned());
        }
        let found: Vec<KcUser> = self
            .send(
                self.people
                    .http
                    .get(self.url("/users"))
                    .query(&[("email", person.email), ("exact", "true")]),
            )
            .await?
            .json()
            .await
            .map_err(|err| PeopleError::Unreachable(err.to_string()))?;
        found
            .into_iter()
            .next()
            .map(|user| user.id)
            .ok_or(PeopleError::NotFound)
    }

    /// Changes what `edit` sets on the stored representation and writes it back whole, so an
    /// attribute the Portal does not know survives the edit.
    pub async fn update(&self, id: &str, edit: impl FnOnce(&mut Value)) -> Result<(), PeopleError> {
        let mut user = self.raw(id).await?;
        edit(&mut user);
        self.send(
            self.people
                .http
                .put(self.url(&format!("/users/{}", segment(id)?)))
                .json(&user),
        )
        .await
        .map(drop)
    }

    /// Asks the realm to send its execute-actions e-mail. `Ok(false)` when the realm cannot send
    /// mail (it answers 5xx), which is when the Portal falls back to a temporary password (PF-92).
    pub async fn send_actions(&self, id: &str, actions: &[&str]) -> Result<bool, PeopleError> {
        let request = self
            .people
            .http
            .put(self.url(&format!("/users/{}/execute-actions-email", segment(id)?)))
            .json(&actions);
        match self.send(request).await {
            Ok(_) => Ok(true),
            Err(PeopleError::Refused(status, _)) if status >= 500 => Ok(false),
            Err(err) => Err(err),
        }
    }

    /// Sets `password` as a temporary password: the realm requires a new one at the next login.
    pub async fn set_temporary_password(
        &self,
        id: &str,
        password: &str,
    ) -> Result<(), PeopleError> {
        self.send(
            self.people
                .http
                .put(self.url(&format!("/users/{}/reset-password", segment(id)?)))
                .json(&json!({ "type": "password", "value": password, "temporary": true })),
        )
        .await
        .map(drop)
    }

    /// Ends every session of the person.
    pub async fn sign_out(&self, id: &str) -> Result<(), PeopleError> {
        self.send(
            self.people
                .http
                .post(self.url(&format!("/users/{}/logout", segment(id)?))),
        )
        .await
        .map(drop)
    }

    /// Removes every OTP and WebAuthn credential; answers how many there were.
    pub async fn remove_second_factor(&self, id: &str) -> Result<usize, PeopleError> {
        let id = segment(id)?;
        let credentials: Vec<Credential> = self.json(&format!("/users/{id}/credentials")).await?;
        let mut removed = 0;
        for credential in credentials
            .iter()
            .filter(|credential| SECOND_FACTORS.contains(&credential.kind.as_str()))
        {
            self.send(self.people.http.delete(self.url(&format!(
                "/users/{id}/credentials/{}",
                segment(&credential.id)?
            ))))
            .await?;
            removed += 1;
        }
        Ok(removed)
    }

    /// The last access of the person's newest open session, in milliseconds since the epoch.
    pub async fn last_seen(&self, id: &str) -> Result<Option<i64>, PeopleError> {
        let sessions: Vec<UserSession> = self
            .json(&format!("/users/{}/sessions", segment(id)?))
            .await?;
        Ok(sessions.iter().filter_map(|s| s.last_access).max())
    }

    /// The names of the realm groups the person is in, and of the realm roles they hold, managed
    /// or not: the bootstrap administrators are one of these (PF-50).
    pub async fn groups_and_roles(&self, id: &str) -> Result<Vec<String>, PeopleError> {
        let id = segment(id)?;
        let groups: Vec<NamedGroup> = self.json(&format!("/users/{id}/groups")).await?;
        let roles: Vec<NamedRole> = self
            .json(&format!("/users/{id}/role-mappings/realm/composite"))
            .await?;
        Ok(groups
            .into_iter()
            .map(|g| g.name)
            .chain(roles.into_iter().map(|r| r.name))
            .collect())
    }

    pub async fn delete(&self, id: &str) -> Result<(), PeopleError> {
        self.send(
            self.people
                .http
                .delete(self.url(&format!("/users/{}", segment(id)?))),
        )
        .await
        .map(drop)
    }
}

/// A Keycloak id as one path segment: letters, digits and `-` only, so no id reaches another
/// admin route.
fn segment(id: &str) -> Result<&str, PeopleError> {
    if !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        Ok(id)
    } else {
        Err(PeopleError::NotFound)
    }
}

/// A temporary password the realm's policy accepts: 24 characters from a CSPRNG with at least one
/// upper-case letter, lower-case letter, digit and special character (the realms ask for up to
/// 20 and each class once). Shown to the creator once, never stored or logged (PF-92).
pub fn temporary_password() -> String {
    const UPPER: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ";
    const LOWER: &[u8] = b"abcdefghijkmnopqrstuvwxyz";
    const DIGIT: &[u8] = b"23456789";
    const SPECIAL: &[u8] = b"!#%+-=?@_";
    let all: Vec<u8> = [UPPER, LOWER, DIGIT, SPECIAL].concat();
    let pick = |set: &[u8]| -> u8 {
        // Rejection sampling keeps every character equally likely.
        let limit = 256 - (256 % set.len());
        loop {
            let mut byte = [0u8; 1];
            OsRng.fill_bytes(&mut byte);
            if usize::from(byte[0]) < limit {
                return set[usize::from(byte[0]) % set.len()];
            }
        }
    };
    let mut chars: Vec<u8> = vec![pick(UPPER), pick(LOWER), pick(DIGIT), pick(SPECIAL)];
    while chars.len() < 24 {
        chars.push(pick(&all));
    }
    // Fisher-Yates, so the guaranteed classes are not always in front.
    for i in (1..chars.len()).rev() {
        let j = loop {
            let mut bytes = [0u8; 1];
            OsRng.fill_bytes(&mut bytes);
            let limit = 256 - (256 % (i + 1));
            if usize::from(bytes[0]) < limit {
                break usize::from(bytes[0]) % (i + 1);
            }
        };
        chars.swap(i, j);
    }
    chars.into_iter().map(char::from).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_temporary_password_meets_the_strictest_realm_policy() {
        for _ in 0..200 {
            let password = temporary_password();
            assert_eq!(password.len(), 24);
            assert!(
                password.bytes().any(|b| b.is_ascii_uppercase()),
                "{password}"
            );
            assert!(
                password.bytes().any(|b| b.is_ascii_lowercase()),
                "{password}"
            );
            assert!(password.bytes().any(|b| b.is_ascii_digit()), "{password}");
            assert!(
                password.bytes().any(|b| !b.is_ascii_alphanumeric()),
                "{password}"
            );
        }
        assert_ne!(temporary_password(), temporary_password());
    }

    #[test]
    fn an_id_is_one_path_segment() {
        assert!(segment("7d1f0c9e-4b8a-4f63-9a51-2c0d8e3b6f14").is_ok());
        for bad in ["", "../clients", "a/b", "a?b", "x%2F"] {
            assert_eq!(segment(bad), Err(PeopleError::NotFound), "{bad}");
        }
    }

    #[test]
    fn the_admin_base_is_derived_from_the_realm_issuer() {
        let people = People::new(
            "https://id.example.org/realms/hel/",
            "portal".into(),
            "s".into(),
        )
        .expect("a realm URL");
        assert_eq!(people.admin, "https://id.example.org/admin/realms/hel");
        assert!(People::new("https://id.example.org/", "p".into(), "s".into()).is_none());
    }
}
