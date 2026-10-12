//! Every `MqttBroker`'s release and Keycloak client (ADR-N-048 §2.6–§2.7, MF-54, PL-74, T-3994).
//!
//! The deployment renders the broker chart once with sentinels into the ConfigMap
//! [`TEMPLATE`] (key `objects.yaml`) in the brokers' namespace. Per broker the reconciler fills
//! the sentinels and applies every object by server-side apply, the way the App hosts copy the
//! edge Ingress, so the chart stays the one description of a broker. The names it fills are DNS
//! labels and the limits numbers, so a filled value can never open a sentinel or a YAML structure
//! of its own.
//!
//! A manifest the platform refuses (its kind's rules, a ServiceAccount its project does not
//! declare, a dedicated port another broker holds) is not applied: the release it had keeps
//! running, and the error goes into the broker's status. A broker whose manifest is gone loses its
//! objects, and its client `mqtt-{project}-{name}`: bearer-only, no secret, the audience the
//! gateway checks a device's token against. The ServiceAccounts a broker's roles name get that
//! audience on their own clients (`workload_clients`).

use std::collections::{BTreeMap, BTreeSet};

use jc_core::kinds::mqtt_broker::release_name;
use jc_core::kinds::MqttBrokerSpec;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::app_clients::{drift, managed, Admin, ClientOutcome};
use super::groups::{MANAGED_BY, MANAGED_VALUE};
use crate::apps::kube::KubeClient;
use crate::store::{ListOptions, Mirror};

/// The ConfigMap the deployment renders the broker chart into, sentinels for the values. Not named
/// `mqtt-…`, so the client's `*_mqtt` methods can never write or remove it.
pub const TEMPLATE: &str = "broker-template";
/// Its key.
pub const TEMPLATE_KEY: &str = "objects.yaml";
/// The labels every object of a broker the reconciler made carries, and the ones it retires by.
pub const SELECTOR: &str =
    "app.kubernetes.io/part-of=mqtt-brokers,app.kubernetes.io/managed-by=joinedcontext-portal";
/// The label naming the release an object belongs to.
const INSTANCE: &str = "app.kubernetes.io/instance";
/// The client attribute naming the broker a managed client belongs to, `{project}/{name}`.
pub const BROKER_ATTRIBUTE: &str = "joinedcontext.mqttbroker";

/// One broker of the mirror, its manifest read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Broker {
    pub project: String,
    pub name: String,
    /// `mqtt-{project}-{name}`: its objects, its ServiceAccount and its Keycloak client.
    pub release: String,
    /// `Err` with the reason when the platform refuses the manifest.
    pub spec: Result<MqttBrokerSpec, String>,
}

impl Broker {
    pub fn label(&self) -> String {
        format!("{}/{}", self.project, self.name)
    }
}

/// Every broker of the mirror, sorted by project and name, each judged as `jcctl validate` judges
/// it (MF-54): its kind's rules, every ServiceAccount its roles name declared in its project, and
/// a dedicated port held by the first broker in that order, the later ones refused with the holder
/// named. A port is the node's, so it is checked across projects.
pub fn declared(mirror: &Mirror) -> Vec<Broker> {
    let mut brokers: Vec<Broker> = mirror
        .namespaces()
        .into_iter()
        .flat_map(|project| {
            let accounts: BTreeSet<String> = mirror
                .list(&project, "ServiceAccount", &ListOptions::default())
                .items
                .into_iter()
                .map(|account| account.metadata.name)
                .collect();
            mirror
                .list(&project, "MqttBroker", &ListOptions::default())
                .items
                .into_iter()
                .map(move |envelope| {
                    let name = envelope.metadata.name;
                    let spec = serde_json::from_value::<MqttBrokerSpec>(envelope.spec)
                        .map_err(|err| format!("spec does not read: {err}"))
                        .and_then(|spec| {
                            spec.validate().map_err(|err| err.to_string())?;
                            known_accounts(&spec, &accounts)?;
                            Ok(spec)
                        });
                    Broker {
                        release: release_name(&project, &name),
                        project: project.clone(),
                        name,
                        spec,
                    }
                })
                .collect::<Vec<_>>()
        })
        .collect();
    brokers.sort_by(|a, b| (&a.project, &a.name).cmp(&(&b.project, &b.name)));
    let mut ports: BTreeMap<u16, String> = BTreeMap::new();
    for broker in &mut brokers {
        let Some(port) = broker.spec.as_ref().ok().and_then(|spec| spec.port) else {
            continue;
        };
        match ports.get(&port) {
            Some(holder) => {
                broker.spec = Err(format!(
                    "spec.port {port} is already held by {holder}; pick another port from the \
                     reserved range (MF-54)"
                ))
            }
            None => {
                ports.insert(port, broker.label());
            }
        }
    }
    brokers
}

fn known_accounts(spec: &MqttBrokerSpec, accounts: &BTreeSet<String>) -> Result<(), String> {
    for role in &spec.roles {
        if let Some(missing) = role
            .service_accounts
            .iter()
            .find(|account| !accounts.contains(*account))
        {
            return Err(format!(
                "role `{}` names ServiceAccount `{missing}`, which no manifest of this project \
                 declares (MF-54)",
                role.name
            ));
        }
    }
    Ok(())
}

/// The broker clients a ServiceAccount's token names as audiences: every broker of its project
/// whose roles name it (ADR-N-048 §2.7), whatever else the broker's manifest says, so a device
/// keeps its audience while a typo elsewhere in the manifest is fixed.
pub fn audiences_of(mirror: &Mirror, project: &str, account: &str) -> Vec<String> {
    mirror
        .list(project, "MqttBroker", &ListOptions::default())
        .items
        .into_iter()
        .filter(|envelope| {
            serde_json::from_value::<MqttBrokerSpec>(envelope.spec.clone())
                .is_ok_and(|spec| spec.roles_of(account).next().is_some())
        })
        .map(|envelope| release_name(project, &envelope.metadata.name))
        .collect()
}

/// The template's objects for one broker: the sentinels filled, and `checksum/config` the hash of
/// everything else, so a change of any value restarts the broker and nothing else does.
pub fn render(
    template: &str,
    broker: &Broker,
    spec: &MqttBrokerSpec,
) -> Result<Vec<Value>, String> {
    let filled = template
        .replace("__RELEASE__", &broker.release)
        .replace("__PROJECT__", &broker.project)
        .replace("__NAME__", &broker.name)
        .replace("__MAX_BYTES__", &spec.limits.max_message_bytes.to_string())
        .replace(
            "__PER_SECOND__",
            &spec.limits.messages_per_second.to_string(),
        )
        .replace("__CONNECTIONS__", &spec.limits.max_connections.to_string());
    let hash = hex(&Sha256::digest(filled.as_bytes()));
    let filled = filled.replace("__CONFIG_HASH__", &hash);
    let mut objects = Vec::new();
    for document in serde_yaml_ng::Deserializer::from_str(&filled) {
        let object: Value = serde::Deserialize::deserialize(document)
            .map_err(|err| format!("{TEMPLATE} does not read: {err}"))?;
        if object.is_null() {
            continue;
        }
        let instance = object.pointer(&format!("/metadata/labels/{}", INSTANCE.replace('/', "~1")));
        if instance.and_then(Value::as_str) != Some(broker.release.as_str()) {
            return Err(format!(
                "{TEMPLATE} holds an object not labelled {INSTANCE}={}: {}/{}",
                broker.release,
                object["kind"].as_str().unwrap_or("?"),
                object["metadata"]["name"].as_str().unwrap_or("?"),
            ));
        }
        objects.push(object);
    }
    if objects.is_empty() {
        return Err(format!("{TEMPLATE} holds no object"));
    }
    Ok(objects)
}

/// The kinds a release is made of, read from the template itself: what a retired broker left.
fn template_kinds(template: &str) -> BTreeSet<(String, String)> {
    serde_yaml_ng::Deserializer::from_str(template)
        .filter_map(|document| serde::Deserialize::deserialize(document).ok())
        .filter_map(|object: Value| {
            Some((
                object.get("apiVersion")?.as_str()?.to_owned(),
                object.get("kind")?.as_str()?.to_owned(),
            ))
        })
        .collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The brokers' objects in their namespace, by the Portal's in-cluster identity.
pub struct MqttBrokers {
    kube: KubeClient,
    namespace: String,
}

impl MqttBrokers {
    pub fn new(kube: KubeClient, namespace: String) -> Self {
        Self { kube, namespace }
    }

    /// Applies every broker the platform accepts and, when `retire` holds, removes the objects of
    /// every release no manifest names any more. Answers the failure of each broker that has one,
    /// by `{project}/{name}`, and `*` for one that touched them all.
    pub async fn converge(&self, brokers: &[Broker], retire: bool) -> BTreeMap<String, String> {
        let mut failed = BTreeMap::new();
        let template = match self.kube.get_config_map(&self.namespace, TEMPLATE).await {
            Ok(Some(map)) => map["data"][TEMPLATE_KEY].as_str().map(str::to_owned),
            Ok(None) => None,
            Err(err) => {
                failed.insert("*".to_owned(), format!("reading {TEMPLATE}: {err}"));
                return failed;
            }
        };
        let Some(template) = template else {
            failed.insert(
                "*".to_owned(),
                format!(
                    "{}/{TEMPLATE} has no {TEMPLATE_KEY}: the deployment renders it",
                    self.namespace
                ),
            );
            return failed;
        };
        for broker in brokers {
            let Ok(spec) = &broker.spec else { continue };
            let objects = match render(&template, broker, spec) {
                Ok(objects) => objects,
                Err(err) => {
                    failed.insert(broker.label(), err);
                    continue;
                }
            };
            for object in &objects {
                if let Err(err) = self.kube.apply_mqtt(&self.namespace, object).await {
                    failed.insert(broker.label(), err.to_string());
                    break;
                }
            }
        }
        if !retire {
            return failed;
        }
        // A refused manifest keeps its release: only a broker no manifest names is gone.
        let held: BTreeSet<&str> = brokers.iter().map(|b| b.release.as_str()).collect();
        for (api_version, kind) in &template_kinds(&template) {
            let listed = match self
                .kube
                .list_mqtt(api_version, kind, &self.namespace, SELECTOR)
                .await
            {
                Ok(listed) => listed,
                Err(err) => {
                    failed.insert("*".to_owned(), format!("listing {kind}: {err}"));
                    continue;
                }
            };
            for object in listed {
                let release = object["metadata"]["labels"][INSTANCE]
                    .as_str()
                    .unwrap_or_default();
                let Some(name) = object["metadata"]["name"].as_str() else {
                    continue;
                };
                if held.contains(release) {
                    continue;
                }
                if let Err(err) = self
                    .kube
                    .delete_mqtt(api_version, kind, &self.namespace, name)
                    .await
                {
                    failed.insert("*".to_owned(), format!("removing {kind} {name}: {err}"));
                }
            }
        }
        failed
    }
}

/// The client a broker should have: bearer-only, so it signs in nobody and holds no secret; it is
/// the audience a device's token names (ADR-N-048 §2.7).
pub fn desired(broker: &Broker) -> Value {
    json!({
        "clientId": broker.release,
        "name": format!("MQTT broker {}", broker.label()),
        "protocol": "openid-connect",
        "enabled": true,
        "publicClient": false,
        "bearerOnly": true,
        "standardFlowEnabled": false,
        "implicitFlowEnabled": false,
        "directAccessGrantsEnabled": false,
        "serviceAccountsEnabled": false,
        "attributes": {
            MANAGED_BY: MANAGED_VALUE,
            BROKER_ATTRIBUTE: broker.label(),
        },
    })
}

/// The realm's broker clients, as the reconciler's own client may write them.
pub struct MqttClientSync {
    admin: Admin,
}

impl MqttClientSync {
    /// `None` when the issuer is not a realm URL.
    pub fn new(issuer: &str, client_id: String, auth: crate::config::ClientAuth) -> Option<Self> {
        Some(Self {
            admin: Admin::new(issuer, client_id, auth)?,
        })
    }

    /// Brings every declared broker's client to [`desired`] and deletes a managed broker client
    /// no broker names. A client of that id this wave did not make is left alone and reported.
    pub async fn converge(&self, brokers: &[Broker]) -> Vec<ClientOutcome> {
        let token = match self.admin.token().await {
            Ok(token) => token,
            Err(err) => {
                let mut outcome = ClientOutcome::of("*");
                outcome.error = Some(err);
                return vec![outcome];
            }
        };
        let mut outcomes = Vec::new();
        for broker in brokers {
            outcomes.push(self.converge_one(&token, broker).await);
        }
        let listed = match self
            .admin
            .send(
                &token,
                reqwest::Method::GET,
                "/clients?briefRepresentation=false&max=2000",
                None,
            )
            .await
        {
            Ok(listed) => listed.unwrap_or(Value::Null),
            Err(err) => {
                let mut outcome = ClientOutcome::of("*");
                outcome.error = Some(format!("listing the broker clients: {err}"));
                outcomes.push(outcome);
                return outcomes;
            }
        };
        let wanted: BTreeSet<String> = brokers.iter().map(Broker::label).collect();
        for client in listed.as_array().into_iter().flatten() {
            let Some(owner) = client["attributes"][BROKER_ATTRIBUTE].as_str() else {
                continue;
            };
            if !managed(client) || wanted.contains(owner) {
                continue;
            }
            let mut outcome = ClientOutcome::of(owner);
            match client["id"].as_str() {
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
                    Ok(_) => outcome
                        .drift
                        .push("the broker is gone, so its client was removed".to_owned()),
                    Err(err) => outcome.error = Some(err),
                },
                None => outcome.error = Some("the realm listed a client without an id".to_owned()),
            }
            outcomes.push(outcome);
        }
        outcomes
    }

    async fn converge_one(&self, token: &str, broker: &Broker) -> ClientOutcome {
        let label = broker.label();
        let mut outcome = ClientOutcome::of(&label);
        let want = desired(broker);
        let held = match self.admin.find(token, &broker.release).await {
            Ok(held) => held,
            Err(err) => {
                outcome.error = Some(err);
                return outcome;
            }
        };
        let result = match held {
            None => self
                .admin
                .send(token, reqwest::Method::POST, "/clients", Some(&want))
                .await
                .map(|_| ()),
            Some(client)
                if !managed(&client)
                    || client["attributes"][BROKER_ATTRIBUTE].as_str() != Some(label.as_str()) =>
            {
                Err(format!(
                    "the realm holds a client {} this wave did not create for this broker; it is \
                     left alone and no device token names the broker until it is renamed or \
                     removed (ADR-N-048)",
                    broker.release
                ))
            }
            Some(client) => {
                let found = drift(&want, &client);
                match client["id"].as_str() {
                    _ if found.is_empty() => Ok(()),
                    Some(uuid) => {
                        outcome.drift = found;
                        self.admin
                            .send(
                                token,
                                reqwest::Method::PUT,
                                &format!("/clients/{uuid}"),
                                Some(&want),
                            )
                            .await
                            .map(|_| ())
                    }
                    None => Err(format!(
                        "the realm answered {} without an id",
                        broker.release
                    )),
                }
            }
        };
        if let Err(err) = result {
            outcome.error = Some(err);
        }
        outcome
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resource::{ObjectMeta, ResourceEnvelope, API_VERSION};

    fn envelope(kind: &str, project: &str, name: &str, spec: Value) -> ResourceEnvelope {
        ResourceEnvelope {
            api_version: API_VERSION.to_owned(),
            kind: kind.to_owned(),
            metadata: ObjectMeta::new(name, project),
            spec,
            status: None,
        }
    }

    fn broker_spec(accounts: &[&str], port: Option<u16>) -> Value {
        let mut spec = json!({
            "roles": [{"name": "camera", "serviceAccounts": accounts, "publish": ["cameras/${clientid}/#"]}],
            "limits": {"maxMessageBytes": 2048},
        });
        if let Some(port) = port {
            spec["port"] = json!(port);
        }
        spec
    }

    fn mirror() -> Mirror {
        let mirror = Mirror::new();
        for (project, account) in [
            ("helsinki", "cam-north"),
            ("helsinki", "cam-south"),
            ("espoo", "cam-north"),
        ] {
            mirror.upsert(envelope(
                "ServiceAccount",
                project,
                account,
                json!({ "roles": [] }),
            ));
        }
        mirror.upsert(envelope(
            "MqttBroker",
            "helsinki",
            "cameras",
            broker_spec(&["cam-north"], Some(18830)),
        ));
        mirror.upsert(envelope(
            "MqttBroker",
            "helsinki",
            "doors",
            broker_spec(&["cam-south"], None),
        ));
        mirror.upsert(envelope(
            "MqttBroker",
            "espoo",
            "cameras",
            broker_spec(&["cam-north"], None),
        ));
        mirror
    }

    const TEMPLATE_TEXT: &str = "\
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: __RELEASE__
  namespace: jc-mqtt
  labels:
    app.kubernetes.io/part-of: mqtt-brokers
    app.kubernetes.io/managed-by: joinedcontext-portal
    app.kubernetes.io/instance: __RELEASE__
data:
  rmqtt.toml: |
    listener.tcp.external.max_packet_size = \"__MAX_BYTES__B\"
    listener.tcp.external.max_connections = __CONNECTIONS__
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: __RELEASE__
  namespace: jc-mqtt
  labels:
    app.kubernetes.io/instance: __RELEASE__
spec:
  template:
    metadata:
      labels:
        joinedcontext.com/project: \"__PROJECT__\"
      annotations:
        checksum/config: __CONFIG_HASH__
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: __RELEASE__
  namespace: jc-mqtt
  labels:
    app.kubernetes.io/instance: __RELEASE__
spec:
  dnsNames: [\"__NAME__.__PROJECT__.mqtt.dev.example\"]
";

    #[test]
    fn two_brokers_in_one_project_and_one_in_another_are_three_releases() {
        let brokers = declared(&mirror());
        let releases: Vec<&str> = brokers.iter().map(|b| b.release.as_str()).collect();
        assert_eq!(
            releases,
            [
                "mqtt-espoo-cameras",
                "mqtt-helsinki-cameras",
                "mqtt-helsinki-doors"
            ]
        );
        assert!(brokers.iter().all(|b| b.spec.is_ok()), "{brokers:?}");
        let hosts: BTreeSet<String> = brokers
            .iter()
            .map(|b| {
                let objects =
                    render(TEMPLATE_TEXT, b, b.spec.as_ref().expect("valid")).expect("renders");
                objects[2]["spec"]["dnsNames"][0]
                    .as_str()
                    .expect("a host")
                    .to_owned()
            })
            .collect();
        assert_eq!(hosts.len(), 3, "no two brokers share a host: {hosts:?}");
    }

    #[test]
    fn a_dedicated_port_is_held_once_across_projects_and_the_holder_named() {
        let mirror = mirror();
        mirror.upsert(envelope(
            "MqttBroker",
            "espoo",
            "cameras",
            broker_spec(&["cam-north"], Some(18830)),
        ));
        let brokers = declared(&mirror);
        let espoo = brokers
            .iter()
            .find(|b| b.project == "espoo")
            .expect("espoo");
        let helsinki = brokers
            .iter()
            .find(|b| b.label() == "helsinki/cameras")
            .expect("helsinki");
        // espoo sorts first, so it holds the port and helsinki is refused.
        assert!(espoo.spec.is_ok());
        let refused = helsinki.spec.as_ref().expect_err("refused");
        assert!(
            refused.contains("18830 is already held by espoo/cameras"),
            "{refused}"
        );
    }

    #[test]
    fn a_broker_naming_an_unknown_account_or_breaking_its_kind_is_refused_with_the_reason() {
        let mirror = mirror();
        mirror.upsert(envelope(
            "MqttBroker",
            "helsinki",
            "doors",
            broker_spec(&["cam-west"], None),
        ));
        mirror.upsert(envelope(
            "MqttBroker",
            "espoo",
            "cameras",
            json!({ "roles": [] }),
        ));
        mirror.upsert(envelope(
            "MqttBroker",
            "espoo",
            "typo",
            json!({ "rolez": [] }),
        ));
        let by_label: BTreeMap<String, Result<MqttBrokerSpec, String>> = declared(&mirror)
            .into_iter()
            .map(|b| (b.label(), b.spec))
            .collect();
        assert!(by_label["helsinki/doors"]
            .as_ref()
            .expect_err("refused")
            .contains("`cam-west`"));
        assert!(by_label["espoo/cameras"]
            .as_ref()
            .expect_err("refused")
            .contains("at least one role"));
        assert!(by_label["espoo/typo"]
            .as_ref()
            .expect_err("refused")
            .contains("does not read"));
        assert!(by_label["helsinki/cameras"].is_ok());
    }

    #[test]
    fn the_template_is_filled_and_a_change_of_limits_changes_the_hash() {
        let brokers = declared(&mirror());
        let broker = &brokers[1];
        let mut spec = broker.spec.clone().expect("valid");
        let objects = render(TEMPLATE_TEXT, broker, &spec).expect("renders");
        assert_eq!(objects.len(), 3);
        assert_eq!(objects[0]["metadata"]["name"], "mqtt-helsinki-cameras");
        let toml = objects[0]["data"]["rmqtt.toml"].as_str().expect("toml");
        assert!(
            toml.contains("\"2048B\"") && toml.contains("= 1000"),
            "{toml}"
        );
        assert_eq!(
            objects[1]["spec"]["template"]["metadata"]["labels"]["joinedcontext.com/project"],
            "helsinki"
        );
        let hash =
            objects[1]["spec"]["template"]["metadata"]["annotations"]["checksum/config"].clone();
        assert_eq!(hash.as_str().map(str::len), Some(64));
        assert_eq!(
            render(TEMPLATE_TEXT, broker, &spec).expect("renders")[1],
            objects[1],
            "same input, same hash"
        );
        spec.limits.max_connections = 5;
        let changed = render(TEMPLATE_TEXT, broker, &spec).expect("renders");
        assert_ne!(
            changed[1]["spec"]["template"]["metadata"]["annotations"]["checksum/config"],
            hash
        );
    }

    #[test]
    fn a_template_object_of_another_release_or_none_at_all_is_refused() {
        let brokers = declared(&mirror());
        let spec = brokers[0].spec.clone().expect("valid");
        let foreign = format!("{TEMPLATE_TEXT}---\napiVersion: v1\nkind: Service\nmetadata:\n  name: portal\n  labels: {{}}\n");
        assert!(render(&foreign, &brokers[0], &spec)
            .expect_err("refused")
            .contains("portal"));
        assert!(render("---\n", &brokers[0], &spec)
            .expect_err("refused")
            .contains("no object"));
        assert!(render("a: [", &brokers[0], &spec).is_err());
    }

    #[test]
    fn a_retirement_reads_the_kinds_from_the_template_alone() {
        let kinds: Vec<(String, String)> = template_kinds(TEMPLATE_TEXT).into_iter().collect();
        let want = [
            ("apps/v1", "Deployment"),
            ("cert-manager.io/v1", "Certificate"),
            ("v1", "ConfigMap"),
        ];
        assert_eq!(kinds, want.map(|(v, k)| (v.to_owned(), k.to_owned())));
    }

    #[test]
    fn an_account_gets_the_audience_of_every_broker_of_its_project_naming_it() {
        let mirror = mirror();
        assert_eq!(
            audiences_of(&mirror, "helsinki", "cam-north"),
            ["mqtt-helsinki-cameras"]
        );
        assert_eq!(
            audiences_of(&mirror, "helsinki", "cam-south"),
            ["mqtt-helsinki-doors"]
        );
        assert_eq!(
            audiences_of(&mirror, "espoo", "cam-south"),
            Vec::<String>::new()
        );
    }

    #[test]
    fn the_client_is_bearer_only_with_no_secret_and_no_flow() {
        let broker = &declared(&mirror())[0];
        let want = desired(broker);
        assert_eq!(want["clientId"], "mqtt-espoo-cameras");
        assert_eq!(want["bearerOnly"], true);
        for flow in [
            "standardFlowEnabled",
            "directAccessGrantsEnabled",
            "serviceAccountsEnabled",
            "publicClient",
        ] {
            assert_eq!(want[flow], false, "{flow}");
        }
        assert!(want.get("secret").is_none());
        assert_eq!(want["attributes"][BROKER_ATTRIBUTE], "espoo/cameras");
    }
}
