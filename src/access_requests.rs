//! Pipeline access requests (API/01 §47, PL-90…PL-93, T-4863): a pipeline's ask for its
//! ServiceAccount's read or write on an Endpoint of another Context Space.
//!
//! A request grants nothing. It waits in the owning project; an owner of the Endpoint's space
//! approves it, and the approval proposes the grant as a Change of the owning project, authored
//! by the approver and judged by that project's lane: the Endpoint admitting the requesting
//! project and one Policy naming exactly the requested types and attributes for the pipeline's
//! own account. Revoking proposes that Policy ended now.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgPool;
use time::OffsetDateTime;
use utoipa::ToSchema;

/// At most this many entity types in one request (PL-90).
pub const MAX_TYPES: usize = 20;
/// At most this many attributes per type (PL-90).
pub const MAX_ATTRS: usize = 50;
/// The longest reason a request or a decision carries.
pub const MAX_REASON: usize = 500;

/// What the pipeline asks to do through the Endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum Operations {
    Read,
    Write,
}

impl Operations {
    fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
        }
    }

    fn parse(text: &str) -> Self {
        if text == "write" {
            Self::Write
        } else {
            Self::Read
        }
    }

    /// The Policy operations: a read is the retrieve group, a write the pipeline's own write
    /// grant (PL-20).
    pub fn policy_operations(self) -> Value {
        match self {
            Self::Read => json!(["retrieveOps"]),
            Self::Write => json!(["upsertBatch", "createBatch", "queryBatch"]),
        }
    }
}

/// One entity type and the attributes asked for on it, each written out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct TypeGrant {
    #[serde(rename = "type")]
    pub entity_type: String,
    pub attrs: Vec<String>,
}

/// The Endpoint a request names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct EndpointName {
    pub project: String,
    pub name: String,
}

/// The body a requester sends.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct NewRequest {
    pub endpoint: EndpointName,
    pub operations: Operations,
    pub types: Vec<TypeGrant>,
    /// The grant's end, RFC 3339; none is no end.
    #[serde(default)]
    pub until: Option<String>,
    pub reason: String,
}

/// A stored request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccessRequest {
    pub id: String,
    pub project: String,
    pub pipeline: String,
    pub endpoint_project: String,
    pub endpoint: String,
    pub space: String,
    pub operations: Operations,
    pub types: Vec<TypeGrant>,
    pub until: Option<OffsetDateTime>,
    pub reason: String,
    pub state: String,
    pub requested_by: String,
    pub requested_at: OffsetDateTime,
    pub decided_by: Option<String>,
    pub decided_at: Option<OffsetDateTime>,
    pub decision_reason: Option<String>,
    pub change: Option<String>,
}

fn rfc3339(at: OffsetDateTime) -> String {
    at.format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

impl AccessRequest {
    /// The account a grant names: the pipeline's own, qualified by its project (PL-19, PL-92).
    pub fn account(&self) -> String {
        format!("{}/pl-{}", self.project, self.pipeline)
    }

    /// The Policy that carries the grant (PL-91).
    pub fn policy_name(&self) -> String {
        format!("{}-{}-{}", self.endpoint, self.project, self.pipeline)
    }

    /// The state a reader sees: an approved grant whose end has passed is `ended`.
    pub fn shown_state(&self, now: OffsetDateTime) -> &str {
        match self.until {
            Some(until) if self.state == "approved" && until <= now => "ended",
            _ => self.state.as_str(),
        }
    }

    /// The request as the API answers it: names and the asked-for grant, never the space's data.
    pub fn view(&self, now: OffsetDateTime) -> Value {
        json!({
            "id": self.id,
            "pipeline": { "project": self.project, "name": self.pipeline },
            "account": self.account(),
            "endpoint": { "project": self.endpoint_project, "name": self.endpoint },
            "space": self.space,
            "operations": self.operations.as_str(),
            "types": self.types,
            "until": self.until.map(rfc3339),
            "reason": self.reason,
            "state": self.shown_state(now),
            "requestedBy": self.requested_by,
            "requestedAt": rfc3339(self.requested_at),
            "decidedBy": self.decided_by,
            "decidedAt": self.decided_at.map(rfc3339),
            "decisionReason": self.decision_reason,
            "change": self.change,
        })
    }
}

/// An NGSI-LD attribute name as a grant may hold it: a term, never a wildcard or an IRI.
fn is_attr_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && name.len() <= 64
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// A reason as stored: trimmed, one to 500 characters.
pub fn reason(text: &str) -> Result<String, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_REASON {
        return Err(format!(
            "reason is required, at most {MAX_REASON} characters (reason-required)"
        ));
    }
    Ok(trimmed.to_owned())
}

/// The types and attributes of a request, refused when one asks for more than it names
/// (PL-90): one to twenty distinct types, each with one to fifty distinct attribute names.
pub fn checked_types(types: &[TypeGrant]) -> Result<Vec<TypeGrant>, String> {
    if types.is_empty() || types.len() > MAX_TYPES {
        return Err(format!(
            "name one to {MAX_TYPES} entity types; a request never asks for every type"
        ));
    }
    let mut seen = std::collections::BTreeSet::new();
    let mut out = Vec::with_capacity(types.len());
    for grant in types {
        let entity_type = grant.entity_type.trim();
        jc_core::names::validate_entity_type(entity_type).map_err(|_| {
            format!("'{entity_type}' is not an entity type name (PascalCase, PF-42)")
        })?;
        if !seen.insert(entity_type.to_owned()) {
            return Err(format!("the type {entity_type} is named twice"));
        }
        if grant.attrs.is_empty() || grant.attrs.len() > MAX_ATTRS {
            return Err(format!(
                "name one to {MAX_ATTRS} attributes of {entity_type}; a request never asks for all of them"
            ));
        }
        let mut attrs = Vec::with_capacity(grant.attrs.len());
        for attr in &grant.attrs {
            let attr = attr.trim();
            if !is_attr_name(attr) {
                return Err(format!(
                    "'{attr}' is not an attribute name of {entity_type}: a letter, then letters, digits or _"
                ));
            }
            if attrs.iter().any(|known: &String| known == attr) {
                return Err(format!(
                    "the attribute {attr} of {entity_type} is named twice"
                ));
            }
            attrs.push(attr.to_owned());
        }
        out.push(TypeGrant {
            entity_type: entity_type.to_owned(),
            attrs,
        });
    }
    Ok(out)
}

/// The end date of a request: in the future, or none.
pub fn checked_until(
    until: Option<&str>,
    now: OffsetDateTime,
) -> Result<Option<OffsetDateTime>, String> {
    let Some(text) = until.map(str::trim).filter(|t| !t.is_empty()) else {
        return Ok(None);
    };
    let at = OffsetDateTime::parse(text, &time::format_description::well_known::Rfc3339).map_err(
        |_| format!("until '{text}' is not an RFC 3339 time, e.g. 2027-01-31T23:59:59Z"),
    )?;
    if at <= now {
        return Err("until has passed; choose a later end or none".into());
    }
    Ok(Some(at))
}

/// Whether the Policy `policy` already grants `account` the operations on every requested type,
/// so a request would add nothing (PL-90).
pub fn already_granted(
    policies: &[Value],
    account: &str,
    request: &[TypeGrant],
    ops: Operations,
) -> bool {
    let wanted = ops.policy_operations();
    let wanted: Vec<&str> = wanted
        .as_array()
        .map(|ops| ops.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    request.iter().all(|grant| {
        policies.iter().any(|policy| {
            let spec = &policy["spec"];
            let ops: Vec<&str> = spec["operations"]
                .as_array()
                .map(|ops| ops.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            spec["assignee"]["kind"] == "serviceAccount"
                && spec["assignee"]["id"] == account
                && spec["validity"]["to"].is_null()
                && wanted.iter().all(|op| ops.contains(op))
                && spec["information"].as_array().is_some_and(|infos| {
                    infos.iter().any(|info| {
                        info["entities"].as_array().is_some_and(|entities| {
                            entities
                                .iter()
                                .any(|e| e["type"] == grant.entity_type.as_str())
                        })
                    })
                })
        })
    })
}

/// A manifest as the import takes it back: without the status the platform computed.
fn writable(manifest: &Value) -> Value {
    let mut copy = manifest.clone();
    if let Some(map) = copy.as_object_mut() {
        map.remove("status");
    }
    copy
}

/// What approving `request` proposes (PL-91): the Endpoint admitting the requesting project when
/// its audience is a list, and the Policy granting exactly what was asked to the pipeline's
/// account until the request's end.
pub fn grant_bundle(request: &AccessRequest, endpoint: &Value) -> Vec<Value> {
    let mut manifests = Vec::with_capacity(2);
    let audience = endpoint["spec"]["audience"].as_str().unwrap_or("project");
    if audience != "organization" && audience != "public" {
        let mut updated = writable(endpoint);
        let mut allowed: Vec<String> = updated["spec"]["allowedProjects"]
            .as_array()
            .map(|list| {
                list.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        if !allowed.contains(&request.project) {
            allowed.push(request.project.clone());
        }
        updated["spec"]["audience"] = json!("project-list");
        updated["spec"]["allowedProjects"] = json!(allowed);
        manifests.push(updated);
    }
    let information: Vec<Value> = request
        .types
        .iter()
        .map(|grant| json!({ "entities": [{ "type": grant.entity_type }], "propertyNames": grant.attrs }))
        .collect();
    let mut spec = json!({
        "contextSpaceRef": { "kind": "ContextSpace", "name": request.space },
        // Rendered by the loader, so a copied organization is its own assigner (CC-82).
        "assigner": "did:web:{orgDomain}",
        "assignee": { "kind": "serviceAccount", "id": request.account() },
        "operations": request.operations.policy_operations(),
        "information": information,
    });
    if let Some(until) = request.until {
        spec["validity"] = json!({ "to": rfc3339(until) });
    }
    manifests.push(json!({
        "apiVersion": crate::resource::API_VERSION,
        "kind": "Policy",
        "metadata": {
            "name": request.policy_name(),
            "namespace": request.endpoint_project,
            "description": { "en": format!("Access request {} by {}: {}", request.id, request.requested_by, request.reason) },
        },
        "spec": spec,
    }));
    manifests
}

/// What revoking proposes (PL-93): the grant's Policy ended `now`, and the Endpoint without the
/// requesting project when no other Policy of the Endpoint still names that project.
pub fn revoke_bundle(
    request: &AccessRequest,
    endpoint: &Value,
    policies: &[Value],
    now: OffsetDateTime,
) -> Vec<Value> {
    let mut manifests = Vec::with_capacity(2);
    let own = request.policy_name();
    let share = format!("{}-{}", request.endpoint, request.project);
    let others_remain = policies.iter().any(|policy| {
        let name = policy["metadata"]["name"].as_str().unwrap_or_default();
        name != own
            && (name == share || name.starts_with(&format!("{share}-")))
            && policy["spec"]["validity"]["to"]
                .as_str()
                .and_then(|to| {
                    OffsetDateTime::parse(to, &time::format_description::well_known::Rfc3339).ok()
                })
                .is_none_or(|to| to > now)
    });
    let listed = endpoint["spec"]["allowedProjects"]
        .as_array()
        .is_some_and(|list| list.iter().any(|p| p == request.project.as_str()));
    if listed && !others_remain {
        let mut updated = writable(endpoint);
        if let Some(list) = updated["spec"]["allowedProjects"].as_array_mut() {
            list.retain(|p| p != request.project.as_str());
        }
        manifests.push(updated);
    }
    if let Some(policy) = policies
        .iter()
        .find(|policy| policy["metadata"]["name"] == own.as_str())
    {
        let mut ended = writable(policy);
        ended["spec"]["validity"]["to"] = json!(rfc3339(now));
        manifests.push(ended);
    }
    manifests
}

/// A new request id: `ar-` and twelve hex digits from the CSPRNG.
pub fn new_id() -> String {
    use sha2::{Digest, Sha256};
    let drawn = Sha256::digest(crate::auth::csrf::new_token().as_bytes());
    let hex: String = drawn[..6].iter().map(|b| format!("{b:02x}")).collect();
    format!("ar-{hex}")
}

/// Whether `id` has the shape of a request id, so a malformed one never reaches the database.
pub fn is_id(id: &str) -> bool {
    id.len() == 15
        && id.starts_with("ar-")
        && id[3..]
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

// --- the store -----------------------------------------------------------------------------

#[derive(sqlx::FromRow)]
struct Row {
    id: String,
    project: String,
    pipeline: String,
    endpoint_project: String,
    endpoint: String,
    space: String,
    operations: String,
    types: Value,
    until: Option<OffsetDateTime>,
    reason: String,
    state: String,
    requested_by: String,
    requested_at: OffsetDateTime,
    decided_by: Option<String>,
    decided_at: Option<OffsetDateTime>,
    decision_reason: Option<String>,
    change: Option<String>,
}

impl From<Row> for AccessRequest {
    fn from(row: Row) -> Self {
        Self {
            id: row.id,
            project: row.project,
            pipeline: row.pipeline,
            endpoint_project: row.endpoint_project,
            endpoint: row.endpoint,
            space: row.space,
            operations: Operations::parse(&row.operations),
            types: serde_json::from_value(row.types).unwrap_or_default(),
            until: row.until,
            reason: row.reason,
            state: row.state,
            requested_by: row.requested_by,
            requested_at: row.requested_at,
            decided_by: row.decided_by,
            decided_at: row.decided_at,
            decision_reason: row.decision_reason,
            change: row.change,
        }
    }
}

/// A `SELECT` of every column, with the rest of the statement: one static string, as sqlx asks.
macro_rules! select {
    ($rest:literal) => {
        concat!(
            "SELECT id, project, pipeline, endpoint_project, endpoint, space, operations, types, until, \
             reason, state, requested_by, requested_at, decided_by, decided_at, decision_reason, change \
             FROM access_requests ",
            $rest
        )
    };
}

/// Stores a new request; `Ok(false)` when the pipeline already has an open or granted one for
/// that Endpoint (PL-90).
pub(crate) async fn insert(pool: &PgPool, request: &AccessRequest) -> Result<bool, sqlx::Error> {
    let done = sqlx::query(
        "INSERT INTO access_requests (id, project, pipeline, endpoint_project, endpoint, space, operations, \
           types, until, reason, state, requested_by, requested_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11, $12) ON CONFLICT DO NOTHING",
    )
    .bind(&request.id)
    .bind(&request.project)
    .bind(&request.pipeline)
    .bind(&request.endpoint_project)
    .bind(&request.endpoint)
    .bind(&request.space)
    .bind(request.operations.as_str())
    .bind(json!(request.types))
    .bind(request.until)
    .bind(&request.reason)
    .bind(&request.requested_by)
    .bind(request.requested_at)
    .execute(pool)
    .await?;
    Ok(done.rows_affected() == 1)
}

/// One request into `endpoint_project`, or `None`.
pub async fn get(
    pool: &PgPool,
    endpoint_project: &str,
    id: &str,
) -> Result<Option<AccessRequest>, sqlx::Error> {
    sqlx::query_as::<_, Row>(select!("WHERE id = $1 AND endpoint_project = $2"))
        .bind(id)
        .bind(endpoint_project)
        .fetch_optional(pool)
        .await
        .map(|row| row.map(AccessRequest::from))
}

/// The requests into `endpoint_project`'s spaces, newest first.
pub async fn incoming(
    pool: &PgPool,
    endpoint_project: &str,
) -> Result<Vec<AccessRequest>, sqlx::Error> {
    sqlx::query_as::<_, Row>(select!(
        "WHERE endpoint_project = $1 ORDER BY requested_at DESC LIMIT 200"
    ))
    .bind(endpoint_project)
    .fetch_all(pool)
    .await
    .map(|rows| rows.into_iter().map(AccessRequest::from).collect())
}

/// The requests of one pipeline, newest first.
pub async fn outgoing(
    pool: &PgPool,
    project: &str,
    pipeline: &str,
) -> Result<Vec<AccessRequest>, sqlx::Error> {
    sqlx::query_as::<_, Row>(select!(
        "WHERE project = $1 AND pipeline = $2 ORDER BY requested_at DESC LIMIT 200"
    ))
    .bind(project)
    .bind(pipeline)
    .fetch_all(pool)
    .await
    .map(|rows| rows.into_iter().map(AccessRequest::from).collect())
}

/// Moves a request from `from` to `to`, recording who decided, why and the Change; `Ok(false)`
/// when it was no longer in `from` (another owner decided first).
pub(crate) async fn decide(
    pool: &PgPool,
    id: &str,
    (from, to): (&str, &str),
    by: &str,
    reason: Option<&str>,
    change: Option<&str>,
) -> Result<bool, sqlx::Error> {
    let done = sqlx::query(
        "UPDATE access_requests SET state = $3, decided_by = $4, decided_at = now(), \
           decision_reason = COALESCE($5, decision_reason), change = COALESCE($6, change) \
         WHERE id = $1 AND state = $2",
    )
    .bind(id)
    .bind(from)
    .bind(to)
    .bind(by)
    .bind(reason)
    .bind(change)
    .execute(pool)
    .await?;
    Ok(done.rows_affected() == 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> AccessRequest {
        AccessRequest {
            id: "ar-0a1b2c3d4e5f".into(),
            project: "city-kpis".into(),
            pipeline: "air-index".into(),
            endpoint_project: "helsinki".into(),
            endpoint: "air-quality".into(),
            space: "air".into(),
            operations: Operations::Read,
            types: vec![TypeGrant {
                entity_type: "AirQualityObserved".into(),
                attrs: vec!["pm10".into(), "pm25".into()],
            }],
            until: Some(time::macros::datetime!(2027-01-31 23:59:59 UTC)),
            reason: "air index for the city dashboard".into(),
            state: "pending".into(),
            requested_by: "jana".into(),
            requested_at: time::macros::datetime!(2026-10-20 19:40 UTC),
            decided_by: None,
            decided_at: None,
            decision_reason: None,
            change: None,
        }
    }

    fn endpoint(audience: &str, allowed: &[&str]) -> Value {
        json!({
            "apiVersion": "joinedcontext.com/v1alpha1",
            "kind": "Endpoint",
            "metadata": { "name": "air-quality", "namespace": "helsinki" },
            "spec": { "contextSpaceRef": "air", "audience": audience, "allowedProjects": allowed, "slug": "s" },
            "status": { "ready": true },
        })
    }

    /// PL-90: a request names what it asks for; no wildcard, no empty list, no duplicates.
    #[test]
    fn a_request_names_every_type_and_attribute_it_asks_for() {
        let grant = |t: &str, attrs: &[&str]| TypeGrant {
            entity_type: t.into(),
            attrs: attrs.iter().map(|a| (*a).to_owned()).collect(),
        };
        assert!(
            checked_types(&[grant("AirQualityObserved", &["pm10", " no2 "])])
                .is_ok_and(|t| t[0].attrs == ["pm10", "no2"])
        );
        for refused in [
            vec![],
            vec![grant("AirQualityObserved", &[])],
            vec![grant("AirQualityObserved", &["*"])],
            vec![grant(
                "AirQualityObserved",
                &["https://uri.etsi.org/ngsi-ld/x"],
            )],
            vec![grant("*", &["pm10"])],
            vec![grant("airQuality", &["pm10"])],
            vec![grant("AirQualityObserved", &["pm10", "pm10"])],
            vec![
                grant("AirQualityObserved", &["pm10"]),
                grant("AirQualityObserved", &["no2"]),
            ],
        ] {
            assert!(checked_types(&refused).is_err(), "accepted {refused:?}");
        }
        let many: Vec<TypeGrant> = (0..21)
            .map(|i| grant(&format!("Type{i}"), &["a"]))
            .collect();
        assert!(checked_types(&many).is_err());
    }

    #[test]
    fn an_end_date_is_in_the_future_or_absent() {
        let now = time::macros::datetime!(2026-10-20 20:00 UTC);
        assert_eq!(checked_until(None, now), Ok(None));
        assert_eq!(checked_until(Some(" "), now), Ok(None));
        assert!(checked_until(Some("2027-01-31T23:59:59Z"), now).is_ok_and(|u| u.is_some()));
        assert!(checked_until(Some("2026-10-20T19:00:00Z"), now).is_err());
        assert!(checked_until(Some("tomorrow"), now).is_err());
        assert!(reason("  ").is_err());
        assert!(reason(&"x".repeat(501)).is_err());
    }

    /// PL-91: approval admits the project on a listed Endpoint and grants exactly what was asked
    /// to the pipeline's qualified account, until the request's end.
    #[test]
    fn the_approval_grants_exactly_the_requested_types_to_the_pipelines_own_account() {
        let bundle = grant_bundle(&request(), &endpoint("project-list", &["traffic"]));
        assert_eq!(bundle.len(), 2);
        assert_eq!(
            bundle[0]["spec"]["allowedProjects"],
            json!(["traffic", "city-kpis"])
        );
        assert!(
            bundle[0].get("status").is_none(),
            "the computed status is not written back"
        );
        let policy = &bundle[1];
        assert_eq!(
            policy["metadata"]["name"],
            "air-quality-city-kpis-air-index"
        );
        assert_eq!(policy["metadata"]["namespace"], "helsinki");
        assert_eq!(
            policy["spec"]["assignee"],
            json!({ "kind": "serviceAccount", "id": "city-kpis/pl-air-index" })
        );
        assert_eq!(policy["spec"]["operations"], json!(["retrieveOps"]));
        assert_eq!(
            policy["spec"]["information"],
            json!([{ "entities": [{ "type": "AirQualityObserved" }], "propertyNames": ["pm10", "pm25"] }])
        );
        assert_eq!(policy["spec"]["validity"]["to"], "2027-01-31T23:59:59Z");
        assert_eq!(policy["spec"]["contextSpaceRef"]["name"], "air");

        // An organization-wide Endpoint keeps its audience: only the Policy is proposed.
        let open = grant_bundle(&request(), &endpoint("organization", &[]));
        assert_eq!(open.len(), 1);
        assert_eq!(open[0]["kind"], "Policy");

        let mut write = request();
        write.operations = Operations::Write;
        write.until = None;
        let policy = &grant_bundle(&write, &endpoint("project", &[]))[1];
        assert_eq!(
            policy["spec"]["operations"],
            json!(["upsertBatch", "createBatch", "queryBatch"])
        );
        assert!(policy["spec"].get("validity").is_none());
    }

    /// PL-93: revoking ends the Policy now and takes the project off the list unless another
    /// live grant of the Endpoint still names it.
    #[test]
    fn revoking_ends_the_grant_and_unlists_the_project_when_nothing_else_names_it() {
        let now = time::macros::datetime!(2026-11-01 08:00 UTC);
        let request = request();
        let ours = grant_bundle(&request, &endpoint("project-list", &["city-kpis"]))[1].clone();
        let bundle = revoke_bundle(
            &request,
            &endpoint("project-list", &["city-kpis", "traffic"]),
            std::slice::from_ref(&ours),
            now,
        );
        assert_eq!(bundle.len(), 2);
        assert_eq!(bundle[0]["spec"]["allowedProjects"], json!(["traffic"]));
        assert_eq!(bundle[1]["spec"]["validity"]["to"], "2026-11-01T08:00:00Z");

        let share = json!({ "metadata": { "name": "air-quality-city-kpis" }, "spec": {} });
        let kept = revoke_bundle(
            &request,
            &endpoint("project-list", &["city-kpis"]),
            &[ours, share],
            now,
        );
        assert_eq!(kept.len(), 1, "the project's share still needs the listing");
        assert_eq!(kept[0]["kind"], "Policy");
    }

    #[test]
    fn a_grant_already_held_makes_the_request_pointless() {
        let request = request();
        let policy = grant_bundle(&request, &endpoint("organization", &[]))[0].clone();
        let mut open = policy.clone();
        open["spec"].as_object_mut().map(|s| s.remove("validity"));
        assert!(already_granted(
            &[open],
            &request.account(),
            &request.types,
            Operations::Read
        ));
        assert!(
            !already_granted(
                std::slice::from_ref(&policy),
                &request.account(),
                &request.types,
                Operations::Read
            ),
            "an ending grant is renewed by a request"
        );
        assert!(!already_granted(
            &[],
            &request.account(),
            &request.types,
            Operations::Read
        ));
    }

    #[test]
    fn a_request_reads_as_ended_once_its_end_passed_and_ids_are_checked() {
        let mut approved = request();
        approved.state = "approved".into();
        assert_eq!(
            approved.shown_state(time::macros::datetime!(2026-12-01 0:00 UTC)),
            "approved"
        );
        assert_eq!(
            approved.shown_state(time::macros::datetime!(2027-02-01 0:00 UTC)),
            "ended"
        );
        assert!(is_id(&new_id()));
        assert!(!is_id("ar-0A1B2C3D4E5F") && !is_id("ar-1") && !is_id("er-0a1b2c3d4e5f"));
        let view = approved.view(time::macros::datetime!(2026-12-01 0:00 UTC));
        assert_eq!(
            view["endpoint"],
            json!({ "project": "helsinki", "name": "air-quality" })
        );
        assert_eq!(view["account"], "city-kpis/pl-air-index");
    }
}
