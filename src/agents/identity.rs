//! The person's identity, handed to `jc-agent-proxy` once when their run starts (ADR-N-038 §3.1,
//! AG-94).
//!
//! The proxy exchanges the person's access token for a grant of its own client whose subject is
//! that person, and every data call of the run carries it. The Portal keeps no copy: the token is
//! read from the request that starts the run, sent once, and never stored, logged or written to
//! the run record. A run that starts without one reads no data through the proxy.

use std::time::Duration;

use axum::http::{header, HeaderMap};

use crate::auth::oidc::OidcClient;
use crate::auth::session::{Front, EDGE_TOKEN_HEADER};

/// The person's access token on the request that starts a run: the edge's `X-Access-Token`
/// where an edge is trusted, or the caller's own bearer. A Portal cookie session holds no access
/// token (only its refresh token, which is the Portal's and not the run's), so it hands over none.
pub fn persons_token(headers: &HeaderMap, trust_edge_token: bool) -> Option<&str> {
    match Front::of(headers, trust_edge_token) {
        Front::Edge => headers.get(&EDGE_TOKEN_HEADER)?.to_str().ok(),
        Front::Bearer => headers
            .get(header::AUTHORIZATION)?
            .to_str()
            .ok()?
            .strip_prefix("Bearer "),
        Front::Portal => None,
    }
    .map(str::trim)
    .filter(|token| !token.is_empty())
}

/// Hands `token` to the proxy for `run_id`, as the Portal's own service account.
///
/// Best effort by design: a refused or failed hand-over leaves the run without a grant, and the
/// proxy answers the run's data calls `401` with the reason (ADR-N-038 §3.3). The run itself may
/// still build, so the start of the run is not failed over it. What went wrong is logged without
/// either token.
pub async fn hand_over(
    oidc: Option<&OidcClient>,
    proxy_base: &str,
    run_id: &str,
    token: Option<&str>,
) {
    let Some(token) = token else {
        tracing::info!(run = %run_id, "the run starts without its person's token and reads no data (ADR-N-038)");
        return;
    };
    let Some(oidc) = oidc else {
        tracing::warn!(run = %run_id, "no Keycloak client to hand the run its person's identity with");
        return;
    };
    let service = match oidc.service_token().await {
        Ok(service) => service,
        Err(error) => {
            tracing::warn!(run = %run_id, %error, "no service token to hand the run its person's identity with");
            return;
        }
    };
    // The body carries a person's token: a redirect would carry it wherever the proxy named.
    let http = match reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()
    {
        Ok(http) => http,
        Err(error) => {
            tracing::warn!(run = %run_id, %error, "no HTTP client for the identity hand-over");
            return;
        }
    };
    let url = format!(
        "{}/internal/runs/{run_id}/identity",
        proxy_base.trim_end_matches('/')
    );
    let sent = http
        .post(url)
        .bearer_auth(service)
        .json(&serde_json::json!({ "subjectToken": token }))
        .send()
        .await;
    match sent {
        Ok(response) if response.status().is_success() => {
            tracing::info!(run = %run_id, "the run holds its person's identity");
        }
        Ok(response) => {
            tracing::warn!(run = %run_id, status = %response.status(), "the proxy refused the run's identity; the run reads no data");
        }
        Err(error) => {
            tracing::warn!(run = %run_id, error = %error.without_url(), "the proxy could not be reached with the run's identity; the run reads no data");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;
    use wiremock::matchers::{body_json, header as wm_header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in pairs {
            headers.insert(*name, HeaderValue::from_str(value).expect("a header value"));
        }
        headers
    }

    #[test]
    fn the_persons_token_comes_from_the_trusted_edge_or_the_bearer_and_never_the_cookie() {
        let edge = headers(&[("x-access-token", "edge-token")]);
        assert_eq!(persons_token(&edge, true), Some("edge-token"));
        // Untrusted, the edge header is somebody typing a header (ADR-N-019).
        assert_eq!(persons_token(&edge, false), None);
        let bearer = headers(&[("authorization", "Bearer  own-token ")]);
        assert_eq!(persons_token(&bearer, true), Some("own-token"));
        for refused in ["Basic Zm9v", "Bearer ", "Bearer    "] {
            assert_eq!(
                persons_token(&headers(&[("authorization", refused)]), true),
                None
            );
        }
        assert_eq!(
            persons_token(&headers(&[("cookie", "jc_session=x")]), true),
            None
        );
    }

    /// A realm the Portal can discover, whose token endpoint answers the client-credentials grant.
    async fn realm() -> (MockServer, OidcClient) {
        let server = MockServer::start().await;
        let issuer = format!("{}/realms/bb", server.uri());
        Mock::given(method("GET"))
            .and(path("/realms/bb/.well-known/openid-configuration"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "issuer": issuer,
                "authorization_endpoint": format!("{issuer}/protocol/openid-connect/auth"),
                "token_endpoint": format!("{issuer}/protocol/openid-connect/token"),
                "jwks_uri": format!("{issuer}/protocol/openid-connect/certs"),
                "response_types_supported": ["code"],
                "subject_types_supported": ["public"],
                "id_token_signing_alg_values_supported": ["RS256"]
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/realms/bb/protocol/openid-connect/certs"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "keys": [] })),
            )
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/realms/bb/protocol/openid-connect/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "portal-service-token", "token_type": "Bearer", "expires_in": 300
            })))
            .mount(&server)
            .await;
        let config = crate::config::Config::from_vars(|k| match k {
            "JC_OIDC_ISSUER" => Some(issuer.clone()),
            "JC_OIDC_CLIENT_ID" => Some("portal-api".to_owned()),
            "JC_OIDC_CLIENT_SECRET" => Some("portal-secret".to_owned()),
            _ => None,
        })
        .expect("config")
        .oidc
        .expect("an oidc block");
        let client = OidcClient::discover(&config, "https://portal.test/cb")
            .await
            .expect("discovery");
        (server, client)
    }

    #[tokio::test]
    async fn the_persons_token_is_handed_to_the_proxy_as_the_portals_service_account() {
        let (_realm, oidc) = realm().await;
        let proxy = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/internal/runs/run-1/identity"))
            .and(wm_header("authorization", "Bearer portal-service-token"))
            .and(body_json(
                serde_json::json!({ "subjectToken": "persons-token" }),
            ))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&proxy)
            .await;

        hand_over(
            Some(&oidc),
            &format!("{}/", proxy.uri()),
            "run-1",
            Some("persons-token"),
        )
        .await;
        proxy.verify().await;
    }

    #[tokio::test]
    async fn no_token_or_no_client_hands_over_nothing() {
        let (_realm, oidc) = realm().await;
        let proxy = MockServer::start().await;
        hand_over(Some(&oidc), &proxy.uri(), "run-1", None).await;
        hand_over(None, &proxy.uri(), "run-1", Some("persons-token")).await;
        assert!(proxy
            .received_requests()
            .await
            .unwrap_or_default()
            .is_empty());
    }

    /// A refusal and an unreachable proxy end the hand-over quietly: the run starts, and reads
    /// no data (ADR-N-038 §3.3).
    #[tokio::test]
    async fn a_refused_or_unreachable_proxy_does_not_fail_the_start() {
        let (_realm, oidc) = realm().await;
        let proxy = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(403))
            .expect(1)
            .mount(&proxy)
            .await;
        hand_over(Some(&oidc), &proxy.uri(), "run-1", Some("persons-token")).await;
        proxy.verify().await;
        hand_over(
            Some(&oidc),
            "http://127.0.0.1:9",
            "run-1",
            Some("persons-token"),
        )
        .await;
    }
}
