//! People: the whole lifecycle of a person in the organization's realm (PF-90…PF-94,
//! ADR-N-031, API/01 §24).
//!
//! A person lives in Keycloak and never in a manifest, so these routes call the realm's admin API
//! directly, each one held to a verb on the kind `Person` at organization scope (PF-91). What they
//! may never do: act on a person who holds a right the caller lacks, which is how a reset's
//! temporary password would open a stronger account; disable or delete the caller or the last
//! Organization Administrator (PF-93, PF-03). Membership stays as code: deleting a person is a
//! Change that takes them out of every `Group` and `RoleBinding`, and the Keycloak user goes only
//! once that Change is merged. Every action is one `person.changed` activity event naming the
//! actor, the action and the person's id, never a password, an e-mail body or a token (PF-90).

use std::collections::{BTreeMap, HashMap};

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use jc_core::kinds::{Verb, PERSON};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use utoipa::ToSchema;

use crate::auth::session::Identity;
use crate::auth::CurrentUser;
use crate::change::{Change, ChangePhase, ChangeStatus, Lane, PlanSummary};
use crate::error::{ApiError, ProblemDetails};
use crate::git::Author;
use crate::people::{Admin, KcUser, NewPerson, People};
use crate::permissions::ORG_NAMESPACE;
use crate::resource::ResourceEnvelope;
use crate::state::AppState;

/// The languages the Portal speaks, and so the ones a person may be given (UI-09).
const LOCALES: [&str; 4] = ["en", "sk", "cs", "de"];
const DEFAULT_PAGE: u32 = 50;
const MAX_PAGE: u32 = 100;
const MAX_NAME: usize = 255;

/// A person as the Portal shows one (API/01 §24).
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub id: String,
    pub email: String,
    pub first_name: String,
    pub last_name: String,
    pub locale: Option<String>,
    pub enabled: bool,
    pub email_verified: bool,
    pub required_actions: Vec<String>,
    /// When the realm created the person (RFC 3339).
    pub created_at: Option<String>,
    /// The last access of the person's newest open session; `null` when none is open.
    pub last_seen: Option<String>,
    /// The Change a deletion waits for; `null` when none is pending.
    pub pending_deletion: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct PersonPage {
    pub items: Vec<Person>,
    /// `first` of the following page, when there is one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<u32>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct GroupRef {
    pub name: String,
}

/// A platform role the person holds, and the binding and the way it reaches them (PF-94).
#[derive(Debug, Serialize, ToSchema)]
pub struct PlatformRole {
    pub role: String,
    pub binding: String,
    #[schema(value_type = Object)]
    pub scope: Value,
    /// `{ "user": … }` or `{ "group": … }`.
    #[schema(value_type = Object)]
    pub via: Value,
}

/// An application role the person holds (PF-94).
#[derive(Debug, Serialize, ToSchema)]
pub struct AppRole {
    pub project: String,
    pub app: String,
    pub role: String,
    #[schema(value_type = Object)]
    pub via: Value,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PersonDetail {
    pub person: Person,
    pub groups: Vec<GroupRef>,
    pub platform_roles: Vec<PlatformRole>,
    pub app_roles: Vec<AppRole>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CreatePerson {
    pub email: String,
    pub first_name: String,
    pub last_name: String,
    #[serde(default)]
    pub locale: Option<String>,
}

#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EditPerson {
    #[serde(default)]
    pub first_name: Option<String>,
    #[serde(default)]
    pub last_name: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub locale: Option<String>,
}

/// The one answer that may carry a temporary password, once (PF-92).
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreatedPerson {
    pub person: Person,
    pub email_sent: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temporary_password: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PasswordReset {
    pub email_sent: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temporary_password: Option<String>,
}

fn people(state: &AppState) -> Result<&People, ApiError> {
    state.people.as_deref().ok_or_else(|| {
        ApiError::Unavailable(
            "no Keycloak admin client is configured, so people cannot be managed here".into(),
        )
    })
}

/// The caller holds `verb` on `Person` in a binding at organization scope (PF-91).
fn allow(state: &AppState, identity: &Identity, verb: Verb) -> Result<(), ApiError> {
    crate::permissions::for_request(state, identity, ORG_NAMESPACE).check(PERSON, verb, None)
}

fn parse<T: serde::de::DeserializeOwned>(body: &[u8]) -> Result<T, ApiError> {
    serde_json::from_slice(body).map_err(|err| ApiError::BadRequest(format!("invalid body: {err}")))
}

/// An e-mail address as the realm and the manifests carry it: trimmed, lower case, one `@`, a
/// dot in the domain, nothing that is not printable.
fn email(raw: &str) -> Result<String, ApiError> {
    let email = raw.trim().to_ascii_lowercase();
    let valid = email.len() <= 254
        && email.split('@').count() == 2
        && email.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty()
                && domain.contains('.')
                && !domain.starts_with('.')
                && !domain.ends_with('.')
        })
        && email.chars().all(|c| c.is_ascii_graphic());
    if valid {
        Ok(email)
    } else {
        Err(ApiError::BadRequest(format!(
            "'{}' is not an e-mail address",
            raw.trim()
        )))
    }
}

fn name(field: &str, raw: &str) -> Result<String, ApiError> {
    let name = raw.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME || name.chars().any(char::is_control) {
        return Err(ApiError::BadRequest(format!(
            "{field} is 1 to {MAX_NAME} characters without control characters"
        )));
    }
    Ok(name.to_owned())
}

fn locale(raw: &str) -> Result<String, ApiError> {
    LOCALES
        .iter()
        .find(|locale| **locale == raw)
        .map(|locale| (*locale).to_owned())
        .ok_or_else(|| {
            ApiError::BadRequest(format!(
                "locale '{raw}' is not one of {}",
                LOCALES.join(", ")
            ))
        })
}

fn rfc3339(millis: Option<i64>) -> Option<String> {
    millis
        .and_then(chrono::DateTime::from_timestamp_millis)
        .map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}

fn email_of(user: &KcUser) -> String {
    user.email
        .clone()
        .unwrap_or_else(|| user.username.clone())
        .to_ascii_lowercase()
}

fn person(user: &KcUser, last_seen: Option<i64>, pending: Option<String>) -> Person {
    Person {
        id: user.id.clone(),
        email: email_of(user),
        first_name: user.first_name.clone().unwrap_or_default(),
        last_name: user.last_name.clone().unwrap_or_default(),
        locale: user.locale().map(str::to_owned),
        enabled: user.enabled,
        email_verified: user.email_verified,
        required_actions: user.required_actions.clone(),
        created_at: rfc3339(user.created_timestamp),
        last_seen: rfc3339(last_seen),
        pending_deletion: pending,
    }
}

async fn pending(state: &AppState, id: &str) -> Option<String> {
    let pool = state.db.as_ref()?;
    match crate::db::person_deletion(pool, id).await {
        Ok(row) => row.map(|row| row.change_name),
        Err(err) => {
            tracing::warn!(error = %err, "the pending removals could not be read");
            None
        }
    }
}

/// One `person.changed` event (PF-90): the actor, the action, the person's id.
async fn record(state: &AppState, identity: &Identity, action: &str, id: &str) {
    let event = crate::activity::ActivityEvent {
        time: chrono::Utc::now(),
        project: ORG_NAMESPACE.to_owned(),
        space: None,
        kind: "person.changed".to_owned(),
        source: "portal".to_owned(),
        summary: format!("{} {action} person {id}", identity.username),
        severity: "info".to_owned(),
        correlation_id: None,
        details: json!({ "action": action, "person": id, "actor": identity.username }),
    };
    if let Err(err) = state.activity.append(&[event]).await {
        tracing::warn!(person = %id, error = %err, "the person's change is not on the activity feed");
    }
}

/// The `Group` manifests naming `email` as a member.
fn groups_of(state: &AppState, email: &str) -> Vec<ResourceEnvelope> {
    state.mirror.matching(|candidate| {
        candidate.kind == "Group"
            && candidate.metadata.namespace.as_deref() == Some(ORG_NAMESPACE)
            && members(&candidate.spec).any(|member| member == email)
    })
}

fn members(spec: &Value) -> impl Iterator<Item = String> + '_ {
    spec.get("members")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|member| member.get("user").and_then(Value::as_str))
        .map(str::to_ascii_lowercase)
}

/// How a subject list reaches `email`: the person themselves, or one of `groups`.
fn reaches(subjects: Option<&Value>, email: &str, groups: &[String]) -> Option<Value> {
    subjects?.as_array()?.iter().find_map(|subject| {
        if let Some(user) = subject.get("user").and_then(Value::as_str) {
            if user.eq_ignore_ascii_case(email) {
                return Some(json!({ "user": email }));
            }
        }
        subject
            .get("group")
            .and_then(Value::as_str)
            .filter(|group| groups.iter().any(|g| g == group))
            .map(|group| json!({ "group": group }))
    })
}

/// The bindings that give `email` a role, directly or through a group.
fn bindings_reaching(
    state: &AppState,
    email: &str,
    groups: &[String],
) -> Vec<(ResourceEnvelope, Value)> {
    state
        .mirror
        .matching(|candidate| candidate.kind == "RoleBinding")
        .into_iter()
        .filter_map(|binding| {
            let via = reaches(binding.spec.get("subjects"), email, groups)?;
            Some((binding, via))
        })
        .collect()
}

/// PF-93: the caller may act on this person only when they hold every right the person holds, so
/// a reset's temporary password never opens a stronger account. The bootstrap administrators'
/// realm group or role counts as every right.
async fn holds_what_they_hold(
    state: &AppState,
    identity: &Identity,
    admin: &Admin<'_>,
    user: &KcUser,
) -> Result<(), ApiError> {
    let effective = crate::permissions::for_request(state, identity, ORG_NAMESPACE);
    if effective.bootstrap {
        return Ok(());
    }
    let email = email_of(user);
    let held = admin.groups_and_roles(&user.id).await?;
    let bootstrap = &state.config.bootstrap_admins;
    if held.iter().any(|name| name == bootstrap) {
        return Err(ApiError::Denied(format!(
            "{email} is in {bootstrap}, which holds every right; only another member of it may \
             change this person (PF-93)"
        )));
    }
    let groups: Vec<String> = groups_of(state, &email)
        .into_iter()
        .map(|group| group.metadata.name)
        .collect();
    for (binding, _) in bindings_reaching(state, &email, &groups) {
        let manifest =
            serde_json::to_value(&binding).map_err(|e| ApiError::Internal(e.to_string()))?;
        crate::permissions::within_own_rights(state, identity, &manifest, "people administrator")
            .map_err(|err| match err {
            ApiError::Denied(reason) => ApiError::Denied(format!(
                "{email} holds a right you do not, through the binding '{}': {reason} (PF-93)",
                binding.metadata.name
            )),
            other => other,
        })?;
    }
    Ok(())
}

/// PF-93, PF-03: nobody disables or deletes themselves, or the last Organization Administrator.
fn not_self_nor_last(state: &AppState, identity: &Identity, user: &KcUser) -> Result<(), ApiError> {
    let email = email_of(user);
    let own = identity
        .email
        .as_deref()
        .is_some_and(|own| own.eq_ignore_ascii_case(&email));
    if user.id == identity.subject || own {
        return Err(ApiError::Conflict(
            "you cannot disable or delete yourself; another administrator can (PF-93)".into(),
        ));
    }
    let administrators = crate::permissions::administrator_people(&state.mirror);
    if !administrators.is_empty() && administrators.iter().all(|admin| *admin == email) {
        return Err(ApiError::Conflict(format!(
            "{email} is the last Organization Administrator; bind another person to an \
             administrator role first (PF-03)"
        )));
    }
    Ok(())
}

/// The person `id`, after the verb and the takeover guard.
async fn target<'a>(
    state: &'a AppState,
    identity: &Identity,
    verb: Verb,
    id: &str,
) -> Result<(Admin<'a>, KcUser), ApiError> {
    allow(state, identity, verb)?;
    let admin = people(state)?.admin().await?;
    let user = admin.get(id).await?;
    if verb != Verb::Read {
        holds_what_they_hold(state, identity, &admin, &user).await?;
    }
    Ok((admin, user))
}

#[utoipa::path(
    get,
    path = "/api/v1/organization/people",
    summary = "List People",
    description = "Searches the people of the organization's realm and pages them. Needs `read` on Person at organization scope.",
    tag = "people",
    params(
        ("search" = Option<String>, Query, description = "A substring of the name or e-mail"),
        ("first" = Option<u32>, Query, description = "Offset, default 0"),
        ("max" = Option<u32>, Query, description = "Page size, default 50, at most 100"),
    ),
    responses(
        (status = 200, description = "One page of people", body = PersonPage),
        (status = 400, description = "Bad request", body = ProblemDetails),
        (status = 403, description = "The caller lacks read on Person", body = ProblemDetails),
        (status = 503, description = "No Keycloak admin client", body = ProblemDetails),
    )
)]
pub async fn list_people(
    user: CurrentUser,
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<PersonPage>, ApiError> {
    let identity = &user.0.identity;
    allow(&state, identity, Verb::Read)?;
    if let Some(unknown) = query
        .keys()
        .find(|key| !matches!(key.as_str(), "search" | "first" | "max"))
    {
        return Err(ApiError::BadRequest(format!(
            "unknown query parameter '{unknown}'"
        )));
    }
    let number = |key: &str, default: u32| -> Result<u32, ApiError> {
        query.get(key).map_or(Ok(default), |raw| {
            raw.parse()
                .map_err(|_| ApiError::BadRequest(format!("{key} is a whole number, not '{raw}'")))
        })
    };
    let first = number("first", 0)?;
    let max = number("max", DEFAULT_PAGE)?;
    if max == 0 || max > MAX_PAGE {
        return Err(ApiError::BadRequest(format!("max is 1 to {MAX_PAGE}")));
    }
    let search = query.get("search").map(|s| s.trim()).unwrap_or_default();
    if search.chars().count() > MAX_NAME {
        return Err(ApiError::BadRequest(
            "search is at most 255 characters".into(),
        ));
    }
    let admin = people(&state)?.admin().await?;
    let mut users = admin.list(search, first, max + 1).await?;
    let next = (users.len() > max as usize).then(|| first + max);
    users.truncate(max as usize);
    let seen =
        futures_util::future::join_all(users.iter().map(|user| admin.last_seen(&user.id))).await;
    let mut items = Vec::with_capacity(users.len());
    for (user, seen) in users.iter().zip(seen) {
        items.push(person(
            user,
            seen.unwrap_or(None),
            pending(&state, &user.id).await,
        ));
    }
    Ok(Json(PersonPage { items, next }))
}

#[utoipa::path(
    post,
    path = "/api/v1/organization/people",
    summary = "Create Person",
    description = "Creates a person and sends the realm's execute-actions e-mail; without SMTP the route answers a temporary password once and the operation never does. Needs `create` on Person.",
    tag = "people",
    request_body(content = CreatePerson, example = json!({ "email": "jana.kovacova@example.org", "firstName": "Jana", "lastName": "Kováčová", "locale": "sk" })),
    responses(
        (status = 201, description = "Created; the only answer that may carry a temporary password", body = CreatedPerson),
        (status = 400, description = "Invalid input", body = ProblemDetails),
        (status = 403, description = "The caller lacks create on Person", body = ProblemDetails),
        (status = 409, description = "The e-mail is taken", body = ProblemDetails),
        (status = 503, description = "No Keycloak admin client", body = ProblemDetails),
    )
)]
pub async fn create_person(
    user: CurrentUser,
    State(state): State<AppState>,
    body: Bytes,
) -> Result<Response, ApiError> {
    let created = create(&state, &user.0.identity, &body).await?;
    Ok((StatusCode::CREATED, Json(created)).into_response())
}

/// The route's whole body, which `jc_person_create` calls too (T-2732): the caller's `create` on
/// Person first, then the input, then the realm.
pub(crate) async fn create(
    state: &AppState,
    identity: &Identity,
    body: &[u8],
) -> Result<CreatedPerson, ApiError> {
    allow(state, identity, Verb::Create)?;
    let body: CreatePerson = parse(body)?;
    let address = email(&body.email)?;
    let first_name = name("firstName", &body.first_name)?;
    let last_name = name("lastName", &body.last_name)?;
    let language = body.locale.as_deref().map(locale).transpose()?;
    let admin = people(state)?.admin().await?;
    let id = admin
        .create(&NewPerson {
            email: &address,
            first_name: &first_name,
            last_name: &last_name,
            locale: language.as_deref(),
        })
        .await
        .map_err(|err| match err {
            crate::people::PeopleError::Conflict => ApiError::Conflict(format!(
                "{address} already belongs to a person of the realm"
            )),
            other => other.into(),
        })?;
    let (email_sent, temporary_password) =
        invite(&admin, &id, &["VERIFY_EMAIL", "UPDATE_PASSWORD"]).await?;
    record(state, identity, "created", &id).await;
    let created = admin.get(&id).await?;
    Ok(CreatedPerson {
        person: person(&created, None, None),
        email_sent,
        temporary_password,
    })
}

/// The realm's e-mail, or when it cannot send one, a temporary password answered once (PF-92).
async fn invite(
    admin: &Admin<'_>,
    id: &str,
    actions: &[&str],
) -> Result<(bool, Option<String>), ApiError> {
    if admin.send_actions(id, actions).await? {
        return Ok((true, None));
    }
    let password = crate::people::temporary_password();
    admin.set_temporary_password(id, &password).await?;
    Ok((false, Some(password)))
}

#[utoipa::path(
    get,
    path = "/api/v1/organization/people/{id}",
    summary = "Get Person",
    description = "One person with their groups, platform roles and application roles. Needs `read` on Person.",
    tag = "people",
    params(("id" = String, Path, description = "The Keycloak user id")),
    responses(
        (status = 200, description = "The person and where they are granted something", body = PersonDetail),
        (status = 403, description = "The caller lacks read on Person", body = ProblemDetails),
        (status = 404, description = "No such person", body = ProblemDetails),
        (status = 503, description = "No Keycloak admin client", body = ProblemDetails),
    )
)]
pub async fn get_person(
    user: CurrentUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<PersonDetail>, ApiError> {
    let (admin, found) = target(&state, &user.0.identity, Verb::Read, &id).await?;
    let email = email_of(&found);
    let groups: Vec<String> = groups_of(&state, &email)
        .into_iter()
        .map(|group| group.metadata.name)
        .collect();
    let mut platform_roles: Vec<PlatformRole> = bindings_reaching(&state, &email, &groups)
        .into_iter()
        .map(|(binding, via)| PlatformRole {
            role: binding
                .spec
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            binding: binding.metadata.name,
            scope: binding.spec.get("scope").cloned().unwrap_or(Value::Null),
            via,
        })
        .collect();
    platform_roles.sort_by(|a, b| (&a.role, &a.binding).cmp(&(&b.role, &b.binding)));
    let mut app_roles = Vec::new();
    for app in state.mirror.matching(|candidate| candidate.kind == "App") {
        for entry in app
            .spec
            .get("access")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(via) = reaches(entry.get("subjects"), &email, &groups) {
                app_roles.push(AppRole {
                    project: app.metadata.namespace.clone().unwrap_or_default(),
                    app: app.metadata.name.clone(),
                    role: entry
                        .get("role")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    via,
                });
            }
        }
    }
    app_roles.sort_by(|a, b| (&a.project, &a.app, &a.role).cmp(&(&b.project, &b.app, &b.role)));
    let seen = admin.last_seen(&found.id).await.unwrap_or(None);
    Ok(Json(PersonDetail {
        person: person(&found, seen, pending(&state, &found.id).await),
        groups: groups.into_iter().map(|name| GroupRef { name }).collect(),
        platform_roles,
        app_roles,
    }))
}

#[utoipa::path(
    patch,
    path = "/api/v1/organization/people/{id}",
    summary = "Edit Person",
    description = "Edits the name, the e-mail (verified again) or the language. Needs `update` on Person and every right the person holds.",
    tag = "people",
    params(("id" = String, Path, description = "The Keycloak user id")),
    request_body(content = EditPerson, example = json!({ "lastName": "Nováková" })),
    responses(
        (status = 200, description = "The person as edited", body = Person),
        (status = 400, description = "Invalid input", body = ProblemDetails),
        (status = 403, description = "The caller lacks update on Person, or a right the person holds", body = ProblemDetails),
        (status = 404, description = "No such person", body = ProblemDetails),
        (status = 409, description = "The e-mail is taken", body = ProblemDetails),
        (status = 503, description = "No Keycloak admin client", body = ProblemDetails),
    )
)]
pub async fn edit_person(
    user: CurrentUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
    body: Bytes,
) -> Result<Json<Person>, ApiError> {
    let identity = &user.0.identity;
    allow(&state, identity, Verb::Update)?;
    let edit: EditPerson = parse(&body)?;
    let first_name = edit
        .first_name
        .as_deref()
        .map(|v| name("firstName", v))
        .transpose()?;
    let last_name = edit
        .last_name
        .as_deref()
        .map(|v| name("lastName", v))
        .transpose()?;
    let address = edit.email.as_deref().map(email).transpose()?;
    let language = edit.locale.as_deref().map(locale).transpose()?;
    if first_name.is_none() && last_name.is_none() && address.is_none() && language.is_none() {
        return Err(ApiError::BadRequest(
            "name at least one of firstName, lastName, email, locale".into(),
        ));
    }
    let (admin, found) = target(&state, identity, Verb::Update, &id).await?;
    let changed_email = address.filter(|address| *address != email_of(&found));
    admin
        .update(&found.id, |rep| {
            if let Some(first) = &first_name {
                rep["firstName"] = json!(first);
            }
            if let Some(last) = &last_name {
                rep["lastName"] = json!(last);
            }
            if let Some(language) = &language {
                if !rep["attributes"].is_object() {
                    rep["attributes"] = json!({});
                }
                rep["attributes"]["locale"] = json!([language]);
            }
            if let Some(address) = &changed_email {
                rep["email"] = json!(address);
                rep["emailVerified"] = json!(false);
                let mut actions: Vec<Value> = rep["requiredActions"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                if !actions.iter().any(|a| a == "VERIFY_EMAIL") {
                    actions.push(json!("VERIFY_EMAIL"));
                }
                rep["requiredActions"] = Value::Array(actions);
            }
        })
        .await
        .map_err(|err| match err {
            crate::people::PeopleError::Conflict => ApiError::Conflict(format!(
                "{} already belongs to another person of the realm",
                changed_email.as_deref().unwrap_or_default()
            )),
            other => other.into(),
        })?;
    if changed_email.is_some() {
        // The realm asks for the new address to be verified; without mail it waits for the login.
        admin.send_actions(&found.id, &["VERIFY_EMAIL"]).await?;
    }
    record(&state, identity, "edited", &found.id).await;
    let edited = admin.get(&found.id).await?;
    Ok(Json(person(
        &edited,
        None,
        pending(&state, &found.id).await,
    )))
}

/// Disable or enable, the person as it now is.
async fn set_enabled(
    state: &AppState,
    identity: &Identity,
    id: &str,
    enabled: bool,
) -> Result<Json<Person>, ApiError> {
    let (admin, found) = target(state, identity, Verb::Disable, id).await?;
    if !enabled {
        not_self_nor_last(state, identity, &found)?;
    }
    admin
        .update(&found.id, |rep| rep["enabled"] = json!(enabled))
        .await?;
    if !enabled {
        admin.sign_out(&found.id).await?;
    }
    record(
        state,
        identity,
        if enabled { "enabled" } else { "disabled" },
        &found.id,
    )
    .await;
    let now = admin.get(&found.id).await?;
    Ok(Json(person(&now, None, pending(state, &found.id).await)))
}

#[utoipa::path(
    post,
    path = "/api/v1/organization/people/{id}/disable",
    summary = "Disable Person",
    description = "Disables the person and ends every session. Needs `disable` on Person; never the caller or the last Organization Administrator.",
    tag = "people",
    params(("id" = String, Path, description = "The Keycloak user id")),
    responses(
        (status = 200, description = "The person, disabled", body = Person),
        (status = 403, description = "The caller lacks disable on Person, or a right the person holds", body = ProblemDetails),
        (status = 404, description = "No such person", body = ProblemDetails),
        (status = 409, description = "The caller themselves, or the last Organization Administrator", body = ProblemDetails),
        (status = 503, description = "No Keycloak admin client", body = ProblemDetails),
    )
)]
pub async fn disable_person(
    user: CurrentUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Person>, ApiError> {
    set_enabled(&state, &user.0.identity, &id, false).await
}

#[utoipa::path(
    post,
    path = "/api/v1/organization/people/{id}/enable",
    summary = "Enable Person",
    description = "Enables a disabled person. Needs `disable` on Person.",
    tag = "people",
    params(("id" = String, Path, description = "The Keycloak user id")),
    responses(
        (status = 200, description = "The person, enabled", body = Person),
        (status = 403, description = "The caller lacks disable on Person, or a right the person holds", body = ProblemDetails),
        (status = 404, description = "No such person", body = ProblemDetails),
        (status = 503, description = "No Keycloak admin client", body = ProblemDetails),
    )
)]
pub async fn enable_person(
    user: CurrentUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Person>, ApiError> {
    set_enabled(&state, &user.0.identity, &id, true).await
}

#[utoipa::path(
    post,
    path = "/api/v1/organization/people/{id}/reset-password",
    summary = "Reset Password",
    description = "Sends the realm's password reset; without SMTP answers a temporary password once. Needs `update` on Person and every right the person holds.",
    tag = "people",
    params(("id" = String, Path, description = "The Keycloak user id")),
    responses(
        (status = 202, description = "The reset e-mail went", body = PasswordReset),
        (status = 200, description = "The realm cannot send mail: a temporary password, once", body = PasswordReset),
        (status = 403, description = "The caller lacks update on Person, or a right the person holds", body = ProblemDetails),
        (status = 404, description = "No such person", body = ProblemDetails),
        (status = 503, description = "No Keycloak admin client", body = ProblemDetails),
    )
)]
pub async fn reset_password(
    user: CurrentUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let identity = &user.0.identity;
    let (admin, found) = target(&state, identity, Verb::Update, &id).await?;
    let (email_sent, temporary_password) = invite(&admin, &found.id, &["UPDATE_PASSWORD"]).await?;
    record(&state, identity, "reset the password of", &found.id).await;
    let status = if email_sent {
        StatusCode::ACCEPTED
    } else {
        StatusCode::OK
    };
    Ok((
        status,
        Json(PasswordReset {
            email_sent,
            temporary_password,
        }),
    )
        .into_response())
}

#[utoipa::path(
    post,
    path = "/api/v1/organization/people/{id}/remove-second-factor",
    summary = "Remove Second Factor",
    description = "Removes every OTP and WebAuthn credential of the person. Needs `disable` on Person and every right the person holds.",
    tag = "people",
    params(("id" = String, Path, description = "The Keycloak user id")),
    responses(
        (status = 204, description = "Removed"),
        (status = 403, description = "The caller lacks disable on Person, or a right the person holds", body = ProblemDetails),
        (status = 404, description = "No such person", body = ProblemDetails),
        (status = 503, description = "No Keycloak admin client", body = ProblemDetails),
    )
)]
pub async fn remove_second_factor(
    user: CurrentUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let identity = &user.0.identity;
    let (admin, found) = target(&state, identity, Verb::Disable, &id).await?;
    admin.remove_second_factor(&found.id).await?;
    record(&state, identity, "removed the second factor of", &found.id).await;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    post,
    path = "/api/v1/organization/people/{id}/sign-out",
    summary = "Sign Person Out",
    description = "Ends every session of the person. Needs `disable` on Person and every right the person holds.",
    tag = "people",
    params(("id" = String, Path, description = "The Keycloak user id")),
    responses(
        (status = 204, description = "Signed out everywhere"),
        (status = 403, description = "The caller lacks disable on Person, or a right the person holds", body = ProblemDetails),
        (status = 404, description = "No such person", body = ProblemDetails),
        (status = 503, description = "No Keycloak admin client", body = ProblemDetails),
    )
)]
pub async fn sign_out_person(
    user: CurrentUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let identity = &user.0.identity;
    let (admin, found) = target(&state, identity, Verb::Disable, &id).await?;
    admin.sign_out(&found.id).await?;
    record(&state, identity, "signed out", &found.id).await;
    Ok(StatusCode::NO_CONTENT)
}

/// What a person's removal writes: every Group and RoleBinding naming them, without them.
#[derive(Default)]
struct Removal {
    edited: Vec<ResourceEnvelope>,
    removed: Vec<ResourceEnvelope>,
}

fn removal(state: &AppState, email: &str) -> Result<Removal, ApiError> {
    let mut removal = Removal::default();
    let mut elsewhere = Vec::new();
    for mut envelope in state
        .mirror
        .matching(|candidate| matches!(candidate.kind.as_str(), "Group" | "RoleBinding"))
    {
        let namespace = envelope.metadata.namespace.clone().unwrap_or_default();
        let field = if envelope.kind == "Group" {
            "members"
        } else {
            "subjects"
        };
        let Some(list) = envelope.spec.get_mut(field).and_then(Value::as_array_mut) else {
            continue;
        };
        let before = list.len();
        list.retain(|entry| {
            !entry
                .get("user")
                .and_then(Value::as_str)
                .is_some_and(|user| user.eq_ignore_ascii_case(email))
        });
        if list.len() == before {
            continue;
        }
        let emptied = list.is_empty() && envelope.kind == "RoleBinding";
        if namespace != ORG_NAMESPACE && state.mirror.repository_of(&namespace).is_some() {
            elsewhere.push(format!(
                "{} {} in project {namespace}",
                envelope.kind, envelope.metadata.name
            ));
            continue;
        }
        envelope.strip_status();
        if emptied {
            removal.removed.push(envelope);
        } else {
            removal.edited.push(envelope);
        }
    }
    if !elsewhere.is_empty() {
        elsewhere.sort();
        return Err(ApiError::Conflict(format!(
            "the person is still named by {}, which live in their project's own repository; take \
             them out there first (PF-93)",
            elsewhere.join(", ")
        )));
    }
    Ok(removal)
}

#[utoipa::path(
    delete,
    path = "/api/v1/organization/people/{id}",
    summary = "Delete Person",
    description = "Proposes one Change taking the person out of every Group and RoleBinding and disables them; the Keycloak user is deleted once it is merged. A person nothing names is deleted at once. Needs `delete` on Person and every right the person holds.",
    tag = "people",
    params(("id" = String, Path, description = "The Keycloak user id")),
    responses(
        (status = 202, description = "The Change the deletion waits for", body = Change),
        (status = 204, description = "Deleted: no manifest named the person"),
        (status = 403, description = "The caller lacks delete on Person, or a right the person holds", body = ProblemDetails),
        (status = 404, description = "No such person", body = ProblemDetails),
        (status = 409, description = "The caller, the last Organization Administrator, a removal already pending, or a reference in a project's own repository", body = ProblemDetails),
        (status = 503, description = "No Keycloak admin client, forge or database", body = ProblemDetails),
    )
)]
pub async fn delete_person(
    user: CurrentUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let identity = &user.0.identity;
    let (admin, found) = target(&state, identity, Verb::Delete, &id).await?;
    not_self_nor_last(&state, identity, &found)?;
    let email = email_of(&found);
    let removal = removal(&state, &email)?;
    if removal.edited.is_empty() && removal.removed.is_empty() {
        admin.delete(&found.id).await?;
        record(&state, identity, "deleted", &found.id).await;
        return Ok(StatusCode::NO_CONTENT.into_response());
    }

    let pool = state.db.as_ref().ok_or_else(|| {
        ApiError::Unavailable(
            "the person is named in the repository, and without a database the Portal cannot \
             hold their removal until its Change is merged"
                .into(),
        )
    })?;
    if let Some(open) = crate::db::person_deletion(pool, &found.id)
        .await
        .map_err(db_error)?
    {
        return Err(ApiError::Conflict(format!(
            "a removal of this person is already open: {}; approve or reject it first",
            open.change_name
        )));
    }
    let manifests: Vec<Value> = removal
        .edited
        .iter()
        .map(serde_json::to_value)
        .collect::<Result<_, _>>()
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    let changes: Vec<_> = manifests
        .iter()
        .map(crate::permissions::AccessChange::Write)
        .chain(removal.removed.iter().map(|envelope| {
            crate::permissions::AccessChange::Remove {
                kind: &envelope.kind,
                namespace: envelope
                    .metadata
                    .namespace
                    .as_deref()
                    .unwrap_or(ORG_NAMESPACE),
                name: &envelope.metadata.name,
            }
        }))
        .collect();
    crate::permissions::keeps_an_administrator_after(&state.mirror, &changes)?;

    let gitea = state
        .forge_for(ORG_NAMESPACE)
        .ok_or_else(|| ApiError::Unavailable("git forge is not configured".into()))?;
    let default_branch = gitea.default_branch().await?;
    let short: String = found
        .id
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(12)
        .collect();
    let branch = crate::api::mutate::create_or_reuse_branch(
        &gitea,
        &format!("portal/remove-person-{short}"),
        &default_branch,
    )
    .await?;
    let path_of = |envelope: &ResourceEnvelope| -> Result<String, ApiError> {
        let info = crate::resource::by_kind(&envelope.kind).ok_or_else(|| {
            ApiError::Internal(format!("no catalogue entry for {}", envelope.kind))
        })?;
        let namespace = envelope
            .metadata
            .namespace
            .as_deref()
            .unwrap_or(ORG_NAMESPACE);
        crate::api::mutate::resolve_repo_path(envelope, info, namespace)
    };
    let mut uploads = Vec::new();
    for envelope in &removal.edited {
        let yaml = serde_yaml_ng::to_string(envelope)
            .map_err(|e| ApiError::Internal(format!("serialize manifest to yaml: {e}")))?;
        uploads.push((path_of(envelope)?, yaml));
    }
    let mut deletes = Vec::new();
    for envelope in &removal.removed {
        let path = path_of(envelope)?;
        if let Some(file) = gitea.get_file(&path, &default_branch).await? {
            deletes.push((path, file.sha));
        }
    }
    let (author_name, author_email) =
        crate::api::mutate::author_credentials(identity, ORG_NAMESPACE);
    let title = format!("remove person {} from every group and binding", found.id);
    gitea
        .change_files(
            &branch,
            &title,
            Author {
                name: &author_name,
                email: &author_email,
            },
            &uploads,
            &deletes,
        )
        .await?;
    let body = format!(
        "Proposed via joinedcontext Portal. Takes person {} out of {} manifest(s) and removes {} \
         binding(s) left naming nobody; the person's Keycloak user is deleted once this is merged \
         (PF-93).",
        found.id,
        removal.edited.len(),
        removal.removed.len()
    );
    let pr = gitea
        .create_pull_request(&branch, &default_branch, &title, &body)
        .await?;
    let meta = crate::api::changes::change_meta(&state, &gitea, pr.number, ORG_NAMESPACE);
    let change = Change::new(
        meta,
        ChangeStatus::new(
            Lane::Red,
            ChangePhase::PendingApproval,
            PlanSummary::new(0, removal.edited.len(), removal.removed.len()),
        )
        .in_repository(&pr.repository)
        .with_merge_request(pr.url.clone()),
    );
    crate::db::insert_person_deletion(
        pool,
        &found.id,
        pr.number,
        &change.metadata.name,
        &identity.username,
    )
    .await
    .map_err(db_error)?;
    // Disabled at once: a person on the way out keeps no session while the Change waits.
    admin
        .update(&found.id, |rep| rep["enabled"] = json!(false))
        .await?;
    admin.sign_out(&found.id).await?;
    record(&state, identity, "proposed the removal of", &found.id).await;
    Ok((StatusCode::ACCEPTED, Json(change)).into_response())
}

fn db_error(err: sqlx::Error) -> ApiError {
    tracing::error!(error = %err, "the pending removals could not be read or written");
    ApiError::Internal("the people database did not answer".into())
}

/// The reconciler's step for pending removals (PF-93): a merged Change deletes the Keycloak user,
/// a Change closed without merging drops the pending removal and leaves the person disabled for
/// an administrator to enable; an open one waits.
pub async fn finish_deletions(
    people: &People,
    pool: &sqlx::PgPool,
    gitea: &crate::git::GiteaClient,
) {
    let rows = match crate::db::person_deletions(pool).await {
        Ok(rows) if rows.is_empty() => return,
        Ok(rows) => rows,
        Err(err) => {
            tracing::warn!(error = %err, "the pending removals could not be read");
            return;
        }
    };
    let admin = match people.admin().await {
        Ok(admin) => admin,
        Err(err) => {
            tracing::warn!(error = ?err, "the realm refused the admin client: pending removals wait");
            return;
        }
    };
    let mut decided: BTreeMap<String, &str> = BTreeMap::new();
    for row in rows {
        let Ok(number) = u64::try_from(row.pull_request) else {
            continue;
        };
        let pr = match gitea.pull_request(number).await {
            Ok(pr) => pr,
            Err(err) => {
                tracing::warn!(change = %row.change_name, error = %err, "the removal's Change could not be read");
                continue;
            }
        };
        if pr.merged {
            match admin.delete(&row.person_id).await {
                Ok(()) | Err(crate::people::PeopleError::NotFound) => {
                    decided.insert(row.person_id, "deleted");
                }
                Err(err) => {
                    tracing::warn!(person = %row.person_id, error = ?err, "the merged removal did not delete the person yet");
                }
            }
        } else if pr.state == "closed" {
            decided.insert(row.person_id, "kept");
        }
    }
    for (person, outcome) in decided {
        if let Err(err) = crate::db::remove_person_deletion(pool, &person).await {
            tracing::warn!(person = %person, error = %err, "the finished removal stays recorded");
        } else {
            tracing::info!(person = %person, outcome, "a pending removal was finished");
        }
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/organization/people", get(list_people).post(create_person))
        .route(
            "/organization/people/{id}",
            get(get_person).patch(edit_person).delete(delete_person),
        )
        .route("/organization/people/{id}/disable", post(disable_person))
        .route("/organization/people/{id}/enable", post(enable_person))
        .route(
            "/organization/people/{id}/reset-password",
            post(reset_password),
        )
        .route(
            "/organization/people/{id}/remove-second-factor",
            post(remove_second_factor),
        )
        .route("/organization/people/{id}/sign-out", post(sign_out_person))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_email_is_trimmed_lowered_and_shaped() {
        assert_eq!(
            email(" Jana.K@Example.ORG ").ok().as_deref(),
            Some("jana.k@example.org")
        );
        for bad in [
            "",
            "jana",
            "@example.org",
            "jana@example",
            "a@b@c.d",
            "jana @x.org",
            "jana@.org",
        ] {
            assert!(email(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_name_and_a_locale_are_checked() {
        assert!(name("firstName", "  ").is_err());
        assert!(name("firstName", &"x".repeat(256)).is_err());
        assert!(name("firstName", "a\u{0}b").is_err());
        assert_eq!(name("firstName", " Jana ").ok().as_deref(), Some("Jana"));
        assert!(locale("sk").is_ok());
        assert!(locale("fr").is_err());
    }
}
