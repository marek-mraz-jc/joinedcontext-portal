//! The host of every published App (ADR-N-037, AP-133, T-2838).
//!
//! An App is served on `{name}.apps.{domain}`, and the zone has no DNS API, so each host gets a
//! certificate of its own by HTTP-01. In the APISIX namespace this wave creates, per published
//! App, a cert-manager `Certificate` `app-{name}` from the issuer of the edge's own certificate
//! (`apisix-edge`), and an `Ingress` `app-{name}` copied from the chart's edge Ingress (`apisix`)
//! for that one host, which carries the challenge and then the App's traffic to APISIX.
//!
//! It creates both once, when the App is published, and never again on a reconcile: Let's
//! Encrypt issues 50 certificates per registered domain a week, and cert-manager renews one that
//! exists. It deletes both when the App is no longer published. An object of that name it did
//! not create is never read for its state, changed or deleted; the App is reported instead.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Map, Value};

use crate::apps::kube::{KubeClient, KubeError};

/// The chart's edge Ingress, the one every App's Ingress is copied from.
pub const EDGE_INGRESS: &str = "apisix";
/// The chart's edge Certificate, whose issuer every App's certificate is requested from.
pub const EDGE_CERTIFICATE: &str = "apisix-edge";
const MANAGED_BY: &str = "app.kubernetes.io/managed-by";
const MANAGED_VALUE: &str = "joinedcontext-portal";
const COMPONENT: &str = "app.kubernetes.io/component";
const COMPONENT_VALUE: &str = "app-host";
const APP_LABEL: &str = crate::apps::reconciler::APP_LABEL;
const CERTIFICATE_API: &str = "cert-manager.io/v1";
const INGRESS_API: &str = "networking.k8s.io/v1";

/// Where one App's host stands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostState {
    /// The certificate is issued: the App answers on its host.
    Ready,
    /// The certificate is requested and not issued yet, with what cert-manager last said.
    Pending(String),
    /// The host cannot be served, and why. Never carries a secret.
    Failed(String),
}

/// The name of both objects of one App's host.
fn object_name(app: &str) -> String {
    format!("app-{app}")
}

fn labels(app: &str) -> Value {
    json!({ MANAGED_BY: MANAGED_VALUE, COMPONENT: COMPONENT_VALUE, APP_LABEL: app })
}

/// The App this wave created `object` for, or `None` when it is somebody else's.
fn managed_app(object: &Value) -> Option<&str> {
    let labels = &object["metadata"]["labels"];
    (labels[MANAGED_BY] == MANAGED_VALUE && labels[COMPONENT] == COMPONENT_VALUE)
        .then(|| labels[APP_LABEL].as_str())
        .flatten()
}

/// The certificate of one App's host, from the edge certificate's issuer.
pub fn certificate(namespace: &str, app: &str, host: &str, issuer_ref: &Value) -> Value {
    let name = object_name(app);
    json!({
        "apiVersion": CERTIFICATE_API,
        "kind": "Certificate",
        "metadata": { "name": name, "namespace": namespace, "labels": labels(app) },
        "spec": {
            "secretName": format!("{name}-tls"),
            "issuerRef": issuer_ref,
            "dnsNames": [host],
        },
    })
}

/// The edge Ingress of one App's host: the chart's class, its TLS and listener annotations and
/// its backend, for this host alone. `None` when the template has no backend to copy.
pub fn ingress(template: &Value, namespace: &str, app: &str, host: &str) -> Option<Value> {
    let path = template["spec"]["rules"][0]["http"]["paths"][0].clone();
    if !path["backend"].is_object() {
        return None;
    }
    // The chart's Certificate is explicit and so is this one: an ingress-shim annotation would
    // make a second owner order the same name.
    let annotations: Map<String, Value> = template["metadata"]["annotations"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(key, _)| !key.starts_with("cert-manager.io/"))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    let name = object_name(app);
    let mut spec = json!({
        "tls": [{ "hosts": [host], "secretName": format!("{name}-tls") }],
        "rules": [{ "host": host, "http": { "paths": [path] } }],
    });
    if let Some(class) = template["spec"]["ingressClassName"].as_str() {
        spec["ingressClassName"] = json!(class);
    }
    Some(json!({
        "apiVersion": INGRESS_API,
        "kind": "Ingress",
        "metadata": {
            "name": name,
            "namespace": namespace,
            "labels": labels(app),
            "annotations": annotations,
        },
        "spec": spec,
    }))
}

/// What cert-manager says of one certificate.
pub fn state_of(certificate: &Value) -> HostState {
    let ready = certificate["status"]["conditions"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|condition| condition["type"] == "Ready");
    match ready {
        Some(condition) if condition["status"] == "True" => HostState::Ready,
        Some(condition) => HostState::Pending(
            condition["message"]
                .as_str()
                .unwrap_or("cert-manager has not issued it yet")
                .to_owned(),
        ),
        None => HostState::Pending("cert-manager has not picked it up yet".to_owned()),
    }
}

/// A kube error as a sentence that names the object and the status, never the body sent.
fn said(object: &str, err: &KubeError) -> String {
    match err {
        KubeError::Api { status, .. } => format!("the API server answered {status} for {object}"),
        other => format!("{object}: {other}"),
    }
}

/// The hosts of one installation's Apps, in the APISIX namespace.
pub struct AppHosts {
    kube: KubeClient,
    namespace: String,
}

impl AppHosts {
    pub fn new(kube: KubeClient, namespace: String) -> Self {
        Self { kube, namespace }
    }

    /// Brings the hosts to the published Apps, `apex` the domain their hosts sit under: creates
    /// what a newly published App lacks and reads what an App's certificate says. Removing the
    /// hosts of Apps no longer published is [`AppHosts::retire`], which the caller runs only
    /// when `published` is the whole organization's.
    pub async fn converge(
        &self,
        published: &BTreeSet<String>,
        apex: &str,
    ) -> BTreeMap<String, HostState> {
        let failed_all = |reason: String| {
            published
                .iter()
                .map(|app| (app.clone(), HostState::Failed(reason.clone())))
                .collect()
        };
        let ns = self.namespace.as_str();
        let template = match self
            .kube
            .get(INGRESS_API, "Ingress", ns, EDGE_INGRESS)
            .await
        {
            Ok(Some(template)) => template,
            Ok(None) => {
                return failed_all(format!(
                    "the edge Ingress {EDGE_INGRESS} is not in {ns}; the apisix chart renders it"
                ))
            }
            Err(err) => return failed_all(said(&format!("Ingress {EDGE_INGRESS}"), &err)),
        };
        let issuer = match self
            .kube
            .get(CERTIFICATE_API, "Certificate", ns, EDGE_CERTIFICATE)
            .await
        {
            Ok(Some(edge)) if edge["spec"]["issuerRef"].is_object() => {
                edge["spec"]["issuerRef"].clone()
            }
            Ok(_) => {
                return failed_all(format!(
                    "the edge Certificate {EDGE_CERTIFICATE} in {ns} names no issuer to request an App's from"
                ))
            }
            Err(err) => return failed_all(said(&format!("Certificate {EDGE_CERTIFICATE}"), &err)),
        };

        let mut states = BTreeMap::new();
        for app in published {
            let host = crate::reconciler::edge_file::app_host(app, apex);
            let state = self.host(&template, &issuer, app, &host).await;
            states.insert(app.clone(), state);
        }
        states
    }

    async fn host(&self, template: &Value, issuer: &Value, app: &str, host: &str) -> HostState {
        let ns = self.namespace.as_str();
        let name = object_name(app);
        let Some(wanted_ingress) = ingress(template, ns, app, host) else {
            return HostState::Failed(format!(
                "the edge Ingress {EDGE_INGRESS} routes no backend to copy"
            ));
        };
        let held = match self
            .kube
            .get(CERTIFICATE_API, "Certificate", ns, &name)
            .await
        {
            Ok(held) => held,
            Err(err) => return HostState::Failed(said(&format!("Certificate {name}"), &err)),
        };
        let state = match held {
            None => {
                // Requested once: from here on the Certificate exists and cert-manager renews it.
                if let Err(err) = self
                    .kube
                    .create(&certificate(ns, app, host, issuer))
                    .await
                {
                    return HostState::Failed(said(&format!("Certificate {name}"), &err));
                }
                HostState::Pending("the certificate is requested".to_owned())
            }
            Some(held) if managed_app(&held) != Some(app) => {
                return HostState::Failed(format!(
                    "a Certificate {name} in {ns} exists that the Portal did not create; rename the App or remove it"
                ))
            }
            Some(held) => state_of(&held),
        };
        match self.kube.get(INGRESS_API, "Ingress", ns, &name).await {
            Ok(None) => match self.kube.create(&wanted_ingress).await {
                Ok(()) => state,
                Err(err) => HostState::Failed(said(&format!("Ingress {name}"), &err)),
            },
            Ok(Some(held)) if managed_app(&held) != Some(app) => HostState::Failed(format!(
                "an Ingress {name} in {ns} exists that the Portal did not create; rename the App or remove it"
            )),
            Ok(Some(_)) => state,
            Err(err) => HostState::Failed(said(&format!("Ingress {name}"), &err)),
        }
    }

    /// Deletes the host of every App this wave made one for that is no longer published. A
    /// failure is logged and tried again on the next run.
    ///
    /// `published` must be complete: an App missing from it only because its project's
    /// repository did not stage would lose its certificate, and every re-request counts against
    /// Let's Encrypt's five duplicate certificates per host and week.
    // ponytail: the TLS Secret stays behind; cert-manager's --enable-certificate-owner-ref
    // removes it with its Certificate, and the Portal holds no right to delete Secrets here.
    pub async fn retire(&self, published: &BTreeSet<String>) {
        let ns = self.namespace.as_str();
        let selector = format!("{MANAGED_BY}={MANAGED_VALUE},{COMPONENT}={COMPONENT_VALUE}");
        for (api, kind) in [(CERTIFICATE_API, "Certificate"), (INGRESS_API, "Ingress")] {
            let held = match self.kube.list(api, kind, ns, &selector).await {
                Ok(held) => held,
                Err(err) => {
                    tracing::warn!(error = %said(kind, &err), "app hosts were not listed");
                    continue;
                }
            };
            for object in held {
                let Some(app) = managed_app(&object) else {
                    continue;
                };
                if published.contains(app) {
                    continue;
                }
                let name = object_name(app);
                match self.kube.delete(api, kind, ns, &name).await {
                    Ok(()) => tracing::info!(%app, kind, "retired App's host removed"),
                    Err(err) => {
                        tracing::warn!(%app, error = %said(&format!("{kind} {name}"), &err), "retired App's host not removed")
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn template() -> Value {
        json!({
            "metadata": {
                "name": "apisix",
                "annotations": {
                    "traefik.ingress.kubernetes.io/router.tls.options": "apisix-bsi-tr-02102@kubernetescrd",
                    "cert-manager.io/cluster-issuer": "letsencrypt-prod",
                },
            },
            "spec": {
                "ingressClassName": "traefik",
                "rules": [{ "host": "city.example", "http": { "paths": [{
                    "path": "/", "pathType": "ImplementationSpecific",
                    "backend": { "service": { "name": "apisix-gateway", "port": { "number": 80 } } },
                }] } }],
                "tls": [{ "hosts": ["city.example"], "secretName": "apisix-edge-tls" }],
            },
        })
    }

    #[test]
    fn an_app_ingress_is_the_edges_for_its_host_alone() {
        let made =
            ingress(&template(), "apisix", "bikes", "bikes.apps.city.example").expect("an Ingress");
        assert_eq!(made["metadata"]["name"], "app-bikes");
        assert_eq!(made["metadata"]["namespace"], "apisix");
        assert_eq!(made["spec"]["ingressClassName"], "traefik");
        assert_eq!(
            made["spec"]["rules"],
            json!([{ "host": "bikes.apps.city.example", "http": { "paths": [{
                "path": "/", "pathType": "ImplementationSpecific",
                "backend": { "service": { "name": "apisix-gateway", "port": { "number": 80 } } },
            }] } }])
        );
        assert_eq!(
            made["spec"]["tls"],
            json!([{ "hosts": ["bikes.apps.city.example"], "secretName": "app-bikes-tls" }])
        );
        let annotations = made["metadata"]["annotations"]
            .as_object()
            .expect("annotations");
        assert!(annotations.contains_key("traefik.ingress.kubernetes.io/router.tls.options"));
        assert!(
            !annotations
                .keys()
                .any(|key| key.starts_with("cert-manager.io/")),
            "one owner orders the certificate: {annotations:?}"
        );
        assert_eq!(managed_app(&made), Some("bikes"));
        assert!(
            !made.to_string().contains("\"city.example\""),
            "the apex is not its host"
        );
    }

    #[test]
    fn a_template_without_a_backend_makes_no_ingress() {
        let mut bare = template();
        bare["spec"]["rules"] = json!([]);
        assert!(ingress(&bare, "apisix", "bikes", "bikes.apps.city.example").is_none());
    }

    #[test]
    fn an_app_certificate_names_its_host_and_the_edges_issuer() {
        let issuer = json!({ "name": "letsencrypt-prod", "kind": "ClusterIssuer" });
        let made = certificate("apisix", "bikes", "bikes.apps.city.example", &issuer);
        assert_eq!(made["apiVersion"], "cert-manager.io/v1");
        assert_eq!(made["metadata"]["name"], "app-bikes");
        assert_eq!(made["spec"]["dnsNames"], json!(["bikes.apps.city.example"]));
        assert_eq!(made["spec"]["secretName"], "app-bikes-tls");
        assert_eq!(made["spec"]["issuerRef"], issuer);
        assert_eq!(managed_app(&made), Some("bikes"));
    }

    #[test]
    fn a_certificate_is_ready_only_when_cert_manager_says_so() {
        let with = |conditions: Value| json!({ "status": { "conditions": conditions } });
        assert_eq!(
            state_of(&with(json!([{ "type": "Ready", "status": "True" }]))),
            HostState::Ready
        );
        assert_eq!(
            state_of(&with(
                json!([{ "type": "Ready", "status": "False", "message": "Issuing certificate as Secret does not exist" }])
            )),
            HostState::Pending("Issuing certificate as Secret does not exist".into())
        );
        assert!(matches!(state_of(&json!({})), HostState::Pending(_)));
        assert!(matches!(
            state_of(&with(json!([{ "type": "Issuing", "status": "True" }]))),
            HostState::Pending(_)
        ));
    }

    #[test]
    fn an_object_somebody_else_made_is_nobodys_app() {
        assert_eq!(managed_app(&template()), None);
        let mut forged = template();
        forged["metadata"]["labels"] = json!({ MANAGED_BY: MANAGED_VALUE, APP_LABEL: "bikes" });
        assert_eq!(
            managed_app(&forged),
            None,
            "the component label is part of it"
        );
    }
}
