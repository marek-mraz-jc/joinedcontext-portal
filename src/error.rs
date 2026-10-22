use axum::body::Body;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use jc_core::error::ProblemType;
use serde::Serialize;
use utoipa::ToSchema;

/// RFC 7807 Problem Details representation.
#[derive(Debug, Clone, Serialize, serde::Deserialize, ToSchema, PartialEq, Eq)]
pub struct ProblemDetails {
    pub r#type: String,
    pub title: String,
    pub status: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance: Option<String>,
    /// What the caller does about it, one English sentence: the catalogue's hint of the slug
    /// (API/00 §4, API/09); the Portal UI shows its own translation by the slug instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    /// Every violation of one request, when there is more than one thing to say. A form marks
    /// all its bad fields from this in one pass instead of one round trip per mistake (CC-24).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub errors: Option<Vec<String>>,
}

/// The problem types only the Portal writes (T-4485, API/09); every other `type` it answers with is
/// one of jc-core's `PROBLEM_TYPES`. The test below holds every slug the Portal's source writes to
/// the two lists, and the docs check holds API/09 to them: one section per slug, no section without.
#[rustfmt::skip]
pub const PORTAL_PROBLEM_TYPES: &[ProblemType] = &[
    ProblemType { slug: "invalid-request", status: 400, title: "Invalid Request", hint: "Correct the request as the detail says; errors lists every violation at once." },
    ProblemType { slug: "self-approval", status: 403, title: "Self Approval Forbidden", hint: "Ask another person who may approve changes in this project to approve it." },
    ProblemType { slug: "service-off", status: 403, title: "Service Off", hint: "Ask an administrator to switch the service on at the layer the answer names." },
    ProblemType { slug: "recipient-refused", status: 403, title: "Recipient Refused", hint: "Send only to people of the organization with a verified address." },
    ProblemType { slug: "draft-conflict", status: 409, title: "Draft Conflict", hint: "Someone saved the draft since you opened it: read current, then make your change on it." },
    ProblemType { slug: "verdict-required", status: 409, title: "Verdict Required", hint: "Run the check the answer names and send the change again with its verdict." },
    ProblemType { slug: "file-too-large", status: 413, title: "File Too Large", hint: "Store a smaller object; the answer names the limit in bytes." },
    ProblemType { slug: "unprocessable", status: 422, title: "Unprocessable Content", hint: "Correct each member errors names; the dry run lists the same findings before you send." },
    ProblemType { slug: "quota", status: 429, title: "Quota Used", hint: "Wait until resetAt, delete what the App no longer needs, or ask an administrator to raise the quota." },
    ProblemType { slug: "not-implemented", status: 501, title: "Not Implemented", hint: "This Portal does not do this yet; the detail names what it does instead." },
    ProblemType { slug: "no-json", status: 502, title: "No JSON", hint: "The model answered with something other than JSON of the schema; ask again." },
    ProblemType { slug: "no-model-key", status: 503, title: "No Model Key", hint: "Ask an administrator to set or top up the organization's model key." },
];

/// The hint of a slug, from jc-core's catalogue or the Portal's own; nothing for an unknown one.
pub fn hint_of(slug: &str) -> Option<String> {
    jc_core::error::problem_type(slug)
        .or_else(|| PORTAL_PROBLEM_TYPES.iter().find(|known| known.slug == slug))
        .map(|known| known.hint.to_owned())
}

/// Portal API error variants conforming to RFC 7807.
#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("bad request: {0}")]
    BadRequest(String),
    /// A bad request with one entry per violation, so the caller gets them all at once (CC-24).
    #[error("bad request: {detail}")]
    Invalid { detail: String, errors: Vec<String> },
    /// 422: the manifest parses, and a member of it names what the model or the contract
    /// refuses, one entry per member with its path (API/11 EP-159, the UI DONE rule).
    #[error("unprocessable: {detail}")]
    Unprocessable { detail: String, errors: Vec<String> },
    #[error("unauthorized")]
    Unauthorized,
    #[error("forbidden")]
    Forbidden,
    /// 403 with the reason: the verb no role grants, or the constraint the manifest violates (PF-50).
    #[error("forbidden: {0}")]
    Denied(String),
    #[error("self-approval: {0}")]
    SelfApproval(String),
    #[error("conflict: {0}")]
    Conflict(String),
    /// 409 with the verdict gate's own document (PF-57): `error: verdict_required`, the check to
    /// run and why; the body the operations registry answers, so every door reads alike (T-0956).
    #[error("verdict required")]
    VerdictRequired(serde_json::Value),
    #[error("unsupported media type: {0}")]
    UnsupportedMediaType(String),
    #[error("payload too large: {0}")]
    TooLarge(String),
    #[error("too many requests: {0}")]
    TooManyRequests(String),
    #[error("service unavailable: {0}")]
    Unavailable(String),
    #[error("not implemented: {0}")]
    NotImplemented(String),
    #[error("internal error: {0}")]
    Internal(String),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let this = match self {
            Self::VerdictRequired(body) => {
                return (
                    StatusCode::CONFLICT,
                    [(header::CONTENT_TYPE, "application/json")],
                    axum::Json(body),
                )
                    .into_response()
            }
            other => other,
        };
        let mut errors = None;
        let (status, slug, title, detail) = match this {
            Self::NotFound(msg) => (
                StatusCode::NOT_FOUND,
                "resource-not-found",
                "Resource Not Found",
                Some(msg),
            ),
            Self::BadRequest(msg) => (
                StatusCode::BAD_REQUEST,
                "invalid-request",
                "Invalid Request",
                Some(msg),
            ),
            Self::Invalid {
                detail,
                errors: violations,
            } => {
                errors = Some(violations);
                (
                    StatusCode::BAD_REQUEST,
                    "invalid-request",
                    "Invalid Request",
                    Some(detail),
                )
            }
            Self::Unprocessable {
                detail,
                errors: violations,
            } => {
                errors = Some(violations);
                (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "unprocessable",
                    "Unprocessable Content",
                    Some(detail),
                )
            }
            Self::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "Unauthorized",
                None,
            ),
            Self::Forbidden => (StatusCode::FORBIDDEN, "forbidden", "Forbidden", None),
            Self::Denied(msg) => (StatusCode::FORBIDDEN, "forbidden", "Forbidden", Some(msg)),
            Self::SelfApproval(msg) => (
                StatusCode::FORBIDDEN,
                "self-approval",
                "Self Approval Forbidden",
                Some(msg),
            ),
            Self::Conflict(msg) => (StatusCode::CONFLICT, "conflict", "Conflict", Some(msg)),
            // Answered above with its own document; kept here so the match stays exhaustive.
            Self::VerdictRequired(body) => (
                StatusCode::CONFLICT,
                "verdict-required",
                "Verdict Required",
                Some(body.to_string()),
            ),
            Self::UnsupportedMediaType(msg) => (
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "unsupported-media-type",
                "Unsupported Media Type",
                Some(msg),
            ),
            Self::TooLarge(msg) => (
                StatusCode::PAYLOAD_TOO_LARGE,
                "payload-too-large",
                "Payload Too Large",
                Some(msg),
            ),
            Self::TooManyRequests(msg) => (
                StatusCode::TOO_MANY_REQUESTS,
                "too-many-requests",
                "Too Many Requests",
                Some(msg),
            ),
            Self::Unavailable(msg) => (
                StatusCode::SERVICE_UNAVAILABLE,
                "service-unavailable",
                "Service Unavailable",
                Some(msg),
            ),
            Self::NotImplemented(msg) => (
                StatusCode::NOT_IMPLEMENTED,
                "not-implemented",
                "Not Implemented",
                Some(msg),
            ),
            Self::Internal(err) => {
                tracing::error!(error = %err, "internal server error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal-error",
                    "Internal Server Error",
                    Some("Unexpected internal error".to_string()),
                )
            }
        };

        let problem = ProblemDetails {
            r#type: format!("https://joinedcontext.com/errors/{slug}"),
            title: title.to_string(),
            status: status.as_u16(),
            detail,
            instance: None,
            hint: hint_of(slug),
            errors,
        };

        let body = serde_json::to_string(&problem).unwrap_or_else(|_| {
            r#"{"type":"https://joinedcontext.com/errors/internal-error","title":"Internal Server Error","status":500}"#.to_string()
        });

        Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, "application/problem+json")
            .body(Body::from(body))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;

    #[tokio::test]
    async fn status_codes_and_content_type() {
        let cases = [
            (ApiError::NotFound("test".into()), StatusCode::NOT_FOUND),
            (ApiError::BadRequest("test".into()), StatusCode::BAD_REQUEST),
            (ApiError::Unauthorized, StatusCode::UNAUTHORIZED),
            (ApiError::Forbidden, StatusCode::FORBIDDEN),
            (ApiError::SelfApproval("test".into()), StatusCode::FORBIDDEN),
            (ApiError::Conflict("test".into()), StatusCode::CONFLICT),
            (
                ApiError::TooManyRequests("test".into()),
                StatusCode::TOO_MANY_REQUESTS,
            ),
            (
                ApiError::UnsupportedMediaType("test".into()),
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
            ),
            (
                ApiError::Unavailable("test".into()),
                StatusCode::SERVICE_UNAVAILABLE,
            ),
            (
                ApiError::NotImplemented("test".into()),
                StatusCode::NOT_IMPLEMENTED,
            ),
            (
                ApiError::Internal("test".into()),
                StatusCode::INTERNAL_SERVER_ERROR,
            ),
        ];

        for (err, expected_status) in cases {
            let res = err.into_response();
            assert_eq!(res.status(), expected_status);
            assert_eq!(
                res.headers().get(header::CONTENT_TYPE).unwrap(),
                "application/problem+json"
            );
        }
    }

    #[tokio::test]
    async fn every_problem_carries_its_catalogued_hint() {
        for (err, slug) in [
            (ApiError::SelfApproval("mine".into()), "self-approval"),
            (ApiError::Forbidden, "forbidden"),
        ] {
            let body = err
                .into_response()
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes();
            let problem: ProblemDetails = serde_json::from_slice(&body).unwrap();
            assert_eq!(
                problem.r#type,
                format!("https://joinedcontext.com/errors/{slug}")
            );
            assert_eq!(problem.hint, hint_of(slug));
            assert!(problem.hint.is_some_and(|hint| !hint.is_empty()), "{slug}");
        }
        assert_eq!(hint_of("no-such-slug"), None);
    }

    #[tokio::test]
    async fn internal_error_hides_message() {
        let secret_msg = "database password leaked";
        let res = ApiError::Internal(secret_msg.to_string()).into_response();
        assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);

        let body_bytes = res.into_body().collect().await.unwrap().to_bytes();
        let problem: ProblemDetails = serde_json::from_slice(&body_bytes).unwrap();
        assert_eq!(
            problem.detail,
            Some("Unexpected internal error".to_string())
        );
        assert!(!String::from_utf8_lossy(&body_bytes).contains(secret_msg));
        assert_eq!(
            problem.r#type,
            "https://joinedcontext.com/errors/internal-error"
        );
        assert_eq!(problem.title, "Internal Server Error");
    }

    /// Every slug the Portal writes is catalogued (T-4485): the slug that follows a status in the
    /// source (`ApiError`'s table, `services::problem`, the basemap's problems) and every type
    /// written whole. A slug outside both lists would be a `type` with no page in API/09.
    #[test]
    fn every_slug_the_portal_writes_is_catalogued() {
        let known = |slug: &str| {
            jc_core::error::problem_type(slug).is_some()
                || PORTAL_PROBLEM_TYPES.iter().any(|known| known.slug == slug)
        };
        let after_status = regex::Regex::new(r#"StatusCode::[A-Z_]+,\s*"([a-z][a-z-]*)""#).unwrap();
        let whole =
            regex::Regex::new(r"https://joinedcontext\.com/(?:errors|problems)/([a-z][a-z-]*)")
                .unwrap();
        let mut seen = std::collections::BTreeSet::new();
        let mut stack = vec![std::path::PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src"
        ))];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.extension().is_some_and(|ext| ext == "rs") {
                    let text = std::fs::read_to_string(&path).unwrap();
                    // a module's tests make up slugs to prove a refusal; they are not written
                    let text = text.split("#[cfg(test)]").next().unwrap_or_default();
                    for found in after_status
                        .captures_iter(text)
                        .chain(whole.captures_iter(text))
                    {
                        seen.insert((found[1].to_owned(), path.display().to_string()));
                    }
                }
            }
        }
        assert!(
            seen.iter().any(|(slug, _)| slug == "self-approval"),
            "the scan found nothing"
        );
        let unknown: Vec<_> = seen.iter().filter(|(slug, _)| !known(slug)).collect();
        assert!(
            unknown.is_empty(),
            "no PORTAL_PROBLEM_TYPES entry for {unknown:?}"
        );
        for portal in PORTAL_PROBLEM_TYPES {
            assert!(
                jc_core::error::problem_type(portal.slug).is_none(),
                "{} is jc-core's",
                portal.slug
            );
            assert!(
                seen.iter().any(|(slug, _)| slug == portal.slug),
                "nothing writes {}",
                portal.slug
            );
        }
    }
}
