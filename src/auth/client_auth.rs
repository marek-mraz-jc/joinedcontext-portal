//! How the Portal proves one of its own Keycloak clients at the realm's token endpoint (PF-47,
//! T-2868).
//!
//! Either a client secret (a mounted Secret, the old way), or a Kubernetes projected
//! ServiceAccount token sent as an RFC 7523 client assertion to a `federated-jwt` client. The
//! token file is read on every request, because the kubelet rotates it in place; nothing of it is
//! kept. With an assertion the request carries no `client_id`: Keycloak finds the client from the
//! token's subject and refuses the pair ("client_id parameter does not match sub claim", T-1513).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::apps::kube::KubeClient;
use crate::config::ConfigError;

/// RFC 7523 §2.2, the `client_assertion_type` of a JWT client assertion.
pub const JWT_BEARER: &str = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

#[derive(Clone)]
pub enum ClientAuth {
    /// `client_id` and `client_secret` in the request body.
    Secret(String),
    /// The projected ServiceAccount token at this path, as `client_assertion`.
    Assertion(PathBuf),
    /// A token of another ServiceAccount of this pod's namespace, minted per request by the
    /// pod's own identity (TokenRequest), as `client_assertion`: a second federated client in
    /// one pod, whose own account is the first client's subject.
    Minted {
        kube: Arc<KubeClient>,
        namespace: String,
        account: String,
        /// The realm issuer, which Keycloak expects as the token's audience.
        audience: String,
    },
}

/// The lifetime of a minted token, the shortest the API server accepts.
const MINTED_SECONDS: u32 = 600;

impl ClientAuth {
    /// The fields of a token request: `grant` followed by the client's proof, read now.
    ///
    /// The error names the file and never a token: an unreadable or empty file is a mount
    /// problem a person fixes in the deployment.
    pub async fn form(
        &self,
        client_id: &str,
        grant: &[(&'static str, &str)],
    ) -> Result<Vec<(&'static str, String)>, String> {
        let mut form: Vec<(&'static str, String)> = grant
            .iter()
            .map(|(key, value)| (*key, (*value).to_owned()))
            .collect();
        match self {
            Self::Secret(secret) => {
                form.push(("client_id", client_id.to_owned()));
                form.push(("client_secret", secret.clone()));
            }
            Self::Assertion(path) => {
                let token = std::fs::read_to_string(path)
                    .map_err(|err| format!("the client token {}: {err}", path.display()))?;
                let token = token.trim();
                if token.is_empty() {
                    return Err(format!("the client token {} is empty", path.display()));
                }
                form.push(("client_assertion_type", JWT_BEARER.to_owned()));
                form.push(("client_assertion", token.to_owned()));
            }
            Self::Minted {
                kube,
                namespace,
                account,
                audience,
            } => {
                let token = kube
                    .service_account_token(namespace, account, audience, MINTED_SECONDS)
                    .await
                    .map_err(|err| format!("the token of {namespace}/{account}: {err}"))?;
                form.push(("client_assertion_type", JWT_BEARER.to_owned()));
                form.push(("client_assertion", token));
            }
        }
        Ok(form)
    }

    /// Exactly one of `secret_var` and `file_var`, or neither (`None`); both is a start-up error,
    /// so a migration never leaves a secret behind as a silent fallback. A blank value is unset.
    pub fn from_vars(
        lookup: &impl Fn(&str) -> Option<String>,
        secret_var: &'static str,
        file_var: &'static str,
    ) -> Result<Option<Self>, ConfigError> {
        let set = |var: &str| lookup(var).filter(|value| !value.trim().is_empty());
        match (set(secret_var), set(file_var)) {
            (Some(_), Some(_)) => Err(ConfigError::Invalid {
                var: file_var,
                reason: format!(
                    "{secret_var} and {file_var} are both set; a client authenticates one way"
                ),
            }),
            (Some(secret), None) => Ok(Some(Self::Secret(secret))),
            (None, Some(path)) => Ok(Some(Self::Assertion(PathBuf::from(path.trim())))),
            (None, None) => Ok(None),
        }
    }
}

impl ClientAuth {
    /// [`ClientAuth::Minted`] for `account`, by the identity mounted at `dir` against the API
    /// server `api`: the account lives in the namespace the mount names. Outside a cluster there
    /// is no mount, and that is a start-up error naming what is missing.
    pub fn minted(dir: &Path, api: &str, account: &str, audience: &str) -> Result<Self, String> {
        jc_core::names::validate_dns1123_label(account)
            .map_err(|_| format!("{account} is not a ServiceAccount name"))?;
        let kube = KubeClient::from_mount(dir, api)
            .map_err(|err| err.to_string())?
            .ok_or_else(|| {
                format!(
                    "no ServiceAccount token at {} to mint {account}'s with",
                    dir.display()
                )
            })?;
        let namespace = KubeClient::namespace_of(dir)
            .ok_or_else(|| format!("no namespace at {}", dir.display()))?;
        Ok(Self::Minted {
            kube: Arc::new(kube),
            namespace,
            account: account.to_owned(),
            audience: audience.to_owned(),
        })
    }
}

impl std::fmt::Debug for ClientAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Secret(_) => f.write_str("Secret([redacted])"),
            Self::Assertion(path) => f.debug_tuple("Assertion").field(path).finish(),
            Self::Minted {
                namespace, account, ..
            } => write!(f, "Minted({namespace}/{account})"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GRANT: [(&str, &str); 1] = [("grant_type", "client_credentials")];

    /// A fresh directory of this test's own under the system temp dir.
    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("jc-client-auth-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        dir
    }

    fn vars<'a>(pairs: &'a [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |key| {
            pairs
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| (*v).to_owned())
        }
    }

    #[tokio::test]
    async fn a_secret_sends_the_id_and_the_secret() {
        let form = ClientAuth::Secret("s3cr3t".into())
            .form("portal-api", &GRANT)
            .await
            .expect("form");
        assert_eq!(
            form,
            vec![
                ("grant_type", "client_credentials".to_owned()),
                ("client_id", "portal-api".to_owned()),
                ("client_secret", "s3cr3t".to_owned()),
            ]
        );
    }

    #[tokio::test]
    async fn an_assertion_sends_the_token_read_now_and_neither_id_nor_secret() {
        let path = scratch("rotate").join("token");
        std::fs::write(&path, "eyJ.first.sig\n").expect("write");
        let auth = ClientAuth::Assertion(path.clone());
        let form = auth.form("portal-api", &GRANT).await.expect("form");
        assert_eq!(
            form,
            vec![
                ("grant_type", "client_credentials".to_owned()),
                ("client_assertion_type", JWT_BEARER.to_owned()),
                ("client_assertion", "eyJ.first.sig".to_owned()),
            ]
        );
        assert!(form
            .iter()
            .all(|(key, _)| *key != "client_id" && *key != "client_secret"));

        // The kubelet rotates the file in place: the next request sends the new token.
        std::fs::write(&path, "eyJ.second.sig").expect("rotate");
        let form = auth.form("portal-api", &GRANT).await.expect("form");
        assert_eq!(form[2], ("client_assertion", "eyJ.second.sig".to_owned()));
    }

    #[tokio::test]
    async fn a_missing_or_empty_token_file_is_an_error_naming_the_file() {
        let dir = scratch("missing");
        let missing = dir.join("absent");
        let err = ClientAuth::Assertion(missing.clone())
            .form("c", &GRANT)
            .await
            .expect_err("missing");
        assert!(err.contains(&missing.display().to_string()), "{err}");

        let empty = dir.join("empty");
        std::fs::write(&empty, " \n").expect("write");
        let err = ClientAuth::Assertion(empty)
            .form("c", &GRANT)
            .await
            .expect_err("empty");
        assert!(err.ends_with("is empty"), "{err}");
    }

    #[test]
    fn exactly_one_way_or_none_and_both_is_refused() {
        let pick = |pairs: &[(&'static str, &'static str)]| {
            ClientAuth::from_vars(&vars(pairs), "X_SECRET", "X_FILE")
        };
        assert!(matches!(pick(&[("X_SECRET", "s")]), Ok(Some(ClientAuth::Secret(s))) if s == "s"));
        assert!(matches!(
            pick(&[("X_FILE", " /var/run/token ")]),
            Ok(Some(ClientAuth::Assertion(p))) if p == std::path::Path::new("/var/run/token")
        ));
        assert!(matches!(
            pick(&[("X_SECRET", " "), ("X_FILE", "")]),
            Ok(None)
        ));
        let err = pick(&[("X_SECRET", "s"), ("X_FILE", "/t")]).expect_err("both");
        assert_eq!(
            err,
            ConfigError::Invalid {
                var: "X_FILE",
                reason: "X_SECRET and X_FILE are both set; a client authenticates one way".into()
            }
        );
    }

    /// A pod's ServiceAccount mount in a fresh directory: its own token and its namespace.
    fn mount(name: &str) -> PathBuf {
        let dir = scratch(name);
        std::fs::write(dir.join("token"), "own-pod-token").expect("token");
        std::fs::write(dir.join("namespace"), "portal\n").expect("namespace");
        dir
    }

    #[tokio::test]
    async fn a_minted_assertion_is_a_tokenrequest_for_that_account_and_the_realm_alone() {
        use wiremock::matchers::{body_json, header, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let api = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/namespaces/portal/serviceaccounts/portal-reconciler/token"))
            .and(header("authorization", "Bearer own-pod-token"))
            .and(body_json(serde_json::json!({
                "apiVersion": "authentication.k8s.io/v1",
                "kind": "TokenRequest",
                "spec": { "audiences": ["https://idm.example/realms/dev"], "expirationSeconds": 600 },
            })))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "status": { "token": "eyJ.minted.sig", "expirationTimestamp": "2026-10-10T22:00:00Z" }
            })))
            .expect(2)
            .mount(&api)
            .await;
        let auth = ClientAuth::minted(
            &mount("minted"),
            &api.uri(),
            "portal-reconciler",
            "https://idm.example/realms/dev",
        )
        .expect("in a cluster");

        for _ in 0..2 {
            let form = auth.form("portal-reconciler", &GRANT).await.expect("form");
            assert_eq!(
                form,
                vec![
                    ("grant_type", "client_credentials".to_owned()),
                    ("client_assertion_type", JWT_BEARER.to_owned()),
                    ("client_assertion", "eyJ.minted.sig".to_owned()),
                ]
            );
        }
        assert_eq!(format!("{auth:?}"), "Minted(portal/portal-reconciler)");
    }

    #[tokio::test]
    async fn a_refused_tokenrequest_is_an_error_naming_the_account_and_no_token() {
        use wiremock::matchers::method;
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let api = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(403).set_body_json(serde_json::json!({
                "kind": "Status", "message": "serviceaccounts \"portal-reconciler\" is forbidden"
            })))
            .mount(&api)
            .await;
        let auth = ClientAuth::minted(&mount("refused"), &api.uri(), "portal-reconciler", "aud")
            .expect("in a cluster");
        let err = auth.form("c", &GRANT).await.expect_err("refused");
        assert!(err.contains("portal/portal-reconciler"), "{err}");
        assert!(!err.contains("own-pod-token"), "{err}");
    }

    #[test]
    fn minting_needs_a_mount_and_an_account_name() {
        let empty = scratch("no-mount");
        let err = ClientAuth::minted(
            &empty,
            "https://kubernetes.default.svc",
            "portal-reconciler",
            "aud",
        )
        .expect_err("outside a cluster");
        assert!(err.starts_with("no ServiceAccount token at"), "{err}");
        let err = ClientAuth::minted(
            &mount("bad-name"),
            "https://kubernetes.default.svc",
            "Not/AName",
            "aud",
        )
        .expect_err("not a name");
        assert_eq!(err, "Not/AName is not a ServiceAccount name");
    }

    #[test]
    fn its_debug_output_never_carries_the_secret() {
        let shown = format!("{:?}", ClientAuth::Secret("s3cr3t-do-not-leak".into()));
        assert!(!shown.contains("s3cr3t"), "{shown}");
    }
}
