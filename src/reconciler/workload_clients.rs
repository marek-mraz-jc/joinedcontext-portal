//! The Keycloak client of every `ServiceAccount` bound to a cluster workload (PF-47, T-1513).
//!
//! An account with `spec.workload.kubernetes: { namespace, serviceAccount }` gets its derived
//! client `{project}-{name}` with federated client authentication: Keycloak accepts the pod's
//! projected Kubernetes ServiceAccount token as the client assertion, through the realm's
//! identity provider `kubernetes`, for that one subject. No secret opens it and none is read
//! here: Keycloak generates one for every confidential client, and with this authenticator a
//! `client_secret` request is refused.
//!
//! The client grants `client_credentials` only. Its audience mappers name the slug of every
//! Endpoint of the project on a space one of the account's roles scopes, and the Portal's own
//! audience when one of its roles names a `Role` (Architecture/12 §2a), so the token opens the
//! doors the roles are for and no other.
//!
//! This wave is the only writer of such a client, as the App wave is of an App's: the client
//! carries `managed-by: joinedcontext` and the account it belongs to, a change made in the
//! console is written back and reported, and a managed client whose account is gone or no longer
//! bound to a workload is deleted. A client of that id without the attribute belongs to whoever
//! made it (the platform's own clients of `keycloak-clients.yaml`, say) and is never written or
//! removed; the account is reported instead.

use std::collections::{BTreeMap, BTreeSet};

use jc_core::kinds::service_account::{keycloak_client_id, KubernetesBinding};
use jc_core::kinds::ServiceAccountSpec;
use serde_json::{json, Value};

use super::app_clients::{audience_mapper, drift, managed, Admin, ClientOutcome};
use super::groups::{MANAGED_BY, MANAGED_VALUE};
use crate::store::{ListOptions, Mirror};

/// The client attribute naming the account a managed workload client belongs to,
/// `{project}/{name}`.
pub const ACCOUNT_ATTRIBUTE: &str = "joinedcontext.serviceaccount";

/// The alias of the realm's Kubernetes identity provider the clients trust (PF-47).
pub const IDENTITY_PROVIDER: &str = "kubernetes";

/// The subject a pod's projected token carries for a Kubernetes ServiceAccount.
pub fn subject(binding: &KubernetesBinding) -> String {
    format!(
        "system:serviceaccount:{}:{}",
        binding.namespace, binding.service_account
    )
}

/// The client a workload-bound account should have, as Keycloak's representation (PF-47).
pub fn desired(project: &str, name: &str, binding: &KubernetesBinding) -> Value {
    json!({
        "clientId": keycloak_client_id(project, name),
        "name": format!("ServiceAccount {project}/{name}"),
        "protocol": "openid-connect",
        "enabled": true,
        "publicClient": false,
        "bearerOnly": false,
        "standardFlowEnabled": false,
        "implicitFlowEnabled": false,
        "directAccessGrantsEnabled": false,
        "serviceAccountsEnabled": true,
        "clientAuthenticatorType": "federated-jwt",
        "attributes": {
            "jwt.credential.issuer": IDENTITY_PROVIDER,
            "jwt.credential.sub": subject(binding),
            "oauth2.device.authorization.grant.enabled": "false",
            MANAGED_BY: MANAGED_VALUE,
            ACCOUNT_ATTRIBUTE: format!("{project}/{name}"),
        },
    })
}

/// The audiences an account's token carries (PF-47): the slug of every Endpoint of `project` on
/// a space one of its roles scopes, and `portal` when it acts on the Portal. Sorted, no repeats.
pub fn audiences(
    mirror: &Mirror,
    project: &str,
    spec: &ServiceAccountSpec,
    portal: &str,
) -> Vec<String> {
    let spaces: BTreeSet<&str> = spec
        .roles
        .iter()
        .filter_map(|granted| granted.scope.context_space.as_deref())
        .collect();
    let mut found: BTreeSet<String> = mirror
        .list(project, "Endpoint", &ListOptions::default())
        .items
        .into_iter()
        .filter(|endpoint| {
            endpoint
                .spec
                .get("contextSpaceRef")
                .and_then(Value::as_str)
                .is_some_and(|space| spaces.contains(space))
        })
        .filter_map(|endpoint| {
            endpoint
                .spec
                .get("slug")
                .and_then(Value::as_str)
                .filter(|slug| !slug.is_empty())
                .map(str::to_owned)
        })
        .collect();
    if crate::permissions::account_holds_portal_role(mirror, spec) {
        found.insert(portal.to_owned());
    }
    found.into_iter().collect()
}

/// One account bound to a workload, as this wave needs it.
#[derive(Debug, Clone)]
struct BoundAccount {
    project: String,
    name: String,
    spec: ServiceAccountSpec,
    binding: KubernetesBinding,
}

impl BoundAccount {
    fn label(&self) -> String {
        format!("{}/{}", self.project, self.name)
    }
}

/// The accounts of the mirror that name a workload, sorted so a run is deterministic. One that
/// does not parse binds nothing: `validate` is what reports it.
fn bound(mirror: &Mirror) -> Vec<BoundAccount> {
    let mut accounts: Vec<BoundAccount> = mirror
        .namespaces()
        .into_iter()
        .flat_map(|project| {
            mirror
                .list(&project, "ServiceAccount", &ListOptions::default())
                .items
                .into_iter()
                .filter_map(move |envelope| {
                    let spec: ServiceAccountSpec = serde_json::from_value(envelope.spec).ok()?;
                    let binding = spec.workload.as_ref()?.kubernetes.clone();
                    Some(BoundAccount {
                        project: project.clone(),
                        name: envelope.metadata.name,
                        spec,
                        binding,
                    })
                })
        })
        .collect();
    accounts.sort_by(|a, b| (&a.project, &a.name).cmp(&(&b.project, &b.name)));
    accounts
}

/// Every Pipeline's own account, derived as the gateway derives it (PL-19): bound to its own
/// Kubernetes ServiceAccount in the runner's `namespace`, its roles the spaces its outputs and
/// Endpoint source touch, so its client's audiences are those spaces' Endpoints.
fn pipeline_accounts(mirror: &Mirror, namespace: &str) -> Vec<BoundAccount> {
    let mut accounts = Vec::new();
    for project in mirror.namespaces() {
        let space_of = |endpoint: &str| {
            mirror
                .get(&project, "Endpoint", endpoint)
                .and_then(|envelope| {
                    let reference = envelope.spec.get("contextSpaceRef")?;
                    reference
                        .as_str()
                        .or_else(|| reference.get("name").and_then(Value::as_str))
                        .map(str::to_owned)
                })
        };
        for envelope in mirror
            .list(&project, "Pipeline", &ListOptions::default())
            .items
        {
            let Ok(spec) = serde_json::from_value::<jc_core::kinds::PipelineSpec>(envelope.spec)
            else {
                continue;
            };
            let derived = jc_core::kinds::pipeline_identity::derive(
                &project,
                &envelope.metadata.name,
                &spec,
                namespace,
                // Only the account is read here; its Policies are the gateway's, assigned there.
                "",
                space_of,
            );
            let Some(binding) = derived
                .account
                .workload
                .as_ref()
                .map(|w| w.kubernetes.clone())
            else {
                continue;
            };
            accounts.push(BoundAccount {
                project: project.clone(),
                name: derived.name,
                spec: derived.account,
                binding,
            });
        }
    }
    accounts.sort_by(|a, b| (&a.project, &a.name).cmp(&(&b.project, &b.name)));
    accounts
}

/// The label every Kubernetes ServiceAccount of a Pipeline's account carries, so a run finds the
/// ones it made and nothing else (PL-19, T-1508).
pub const PIPELINE_IDENTITY_LABEL: &str = "joinedcontext.com/pipeline-identity";

/// The Kubernetes ServiceAccount of every Pipeline's own account in `namespace`: no pod mounts
/// it, the token service mints its tokens (Architecture/12 §3), so its own token is never
/// automounted anywhere.
pub fn pipeline_service_accounts(mirror: &Mirror, namespace: &str) -> Vec<Value> {
    pipeline_accounts(mirror, namespace)
        .into_iter()
        .map(|account| {
            json!({
                "apiVersion": "v1",
                "kind": "ServiceAccount",
                "metadata": {
                    "name": account.binding.service_account,
                    "namespace": account.binding.namespace,
                    "labels": {
                        PIPELINE_IDENTITY_LABEL: "true",
                        "app.kubernetes.io/managed-by": "joinedcontext-portal",
                    },
                    "annotations": { ACCOUNT_ATTRIBUTE: account.label() },
                },
                "automountServiceAccountToken": false,
            })
        })
        .collect()
}

/// Brings the pipelines' Kubernetes ServiceAccounts in `namespace` to the mirror's Pipelines:
/// applies each, deletes a labelled one no Pipeline names any more, and answers what failed. A
/// ServiceAccount without the label, or not named `pl-…`, is never touched.
pub async fn converge_pipeline_service_accounts(
    kube: &crate::apps::kube::KubeClient,
    mirror: &Mirror,
    namespace: &str,
) -> Vec<String> {
    let wanted = pipeline_service_accounts(mirror, namespace);
    let mut failed = Vec::new();
    for account in &wanted {
        if let Err(err) = kube.apply(account).await {
            failed.push(format!("{}: {err}", account["metadata"]["name"]));
        }
    }
    let names: BTreeSet<&str> = wanted
        .iter()
        .filter_map(|a| a["metadata"]["name"].as_str())
        .collect();
    let listed = match kube
        .list(
            "v1",
            "ServiceAccount",
            namespace,
            &format!("{PIPELINE_IDENTITY_LABEL}=true"),
        )
        .await
    {
        Ok(listed) => listed,
        Err(err) => {
            failed.push(format!("listing {namespace}: {err}"));
            return failed;
        }
    };
    for stale in listed
        .iter()
        .filter_map(|a| a["metadata"]["name"].as_str())
        .filter(|name| jc_core::kinds::pipeline_identity::is_derived(name) && !names.contains(name))
    {
        if let Err(err) = kube.delete("v1", "ServiceAccount", namespace, stale).await {
            failed.push(format!("{stale}: {err}"));
        }
    }
    failed
}

/// The accounts that may not have a client this run, with the reason: Keycloak finds a federated
/// client by the assertion's subject, so one Kubernetes ServiceAccount opens one account at most.
/// When several bind the same subject, the one whose managed client already holds it keeps it and
/// the others are refused; when none does yet, all of them are, so a later binding can never take
/// a subject from the account that had it first.
fn contested(accounts: &[BoundAccount], listed: &Value) -> BTreeMap<String, String> {
    let mut by_subject: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for account in accounts {
        by_subject
            .entry(subject(&account.binding))
            .or_default()
            .push(account.label());
    }
    let holder_of = |subject: &str| {
        listed.as_array().into_iter().flatten().find_map(|client| {
            let attributes = client.get("attributes")?;
            (managed(client)
                && attributes.get("jwt.credential.sub").and_then(Value::as_str) == Some(subject))
            .then(|| {
                attributes
                    .get(ACCOUNT_ATTRIBUTE)?
                    .as_str()
                    .map(str::to_owned)
            })
            .flatten()
        })
    };
    let mut refused = BTreeMap::new();
    for (subject, labels) in by_subject.into_iter().filter(|(_, l)| l.len() > 1) {
        let holder = holder_of(&subject).filter(|holder| labels.contains(holder));
        for label in labels
            .iter()
            .filter(|label| Some(*label) != holder.as_ref())
        {
            let others: Vec<&str> = labels
                .iter()
                .filter(|other| *other != label)
                .map(String::as_str)
                .collect();
            refused.insert(
                label.clone(),
                match &holder {
                    Some(holder) => format!(
                        "{subject} already opens the client of {holder}; one Kubernetes \
                         ServiceAccount opens one account, so this binding gets no client (PF-47)"
                    ),
                    None => format!(
                        "{subject} is bound by {} as well; one Kubernetes ServiceAccount opens \
                         one account, so none of them gets a client until one binding is left \
                         (PF-47)",
                        others.join(", ")
                    ),
                },
            );
        }
    }
    refused
}

/// The realm's workload clients, as the reconciler's own client may write them.
pub struct WorkloadClientSync {
    admin: Admin,
    /// The Portal's own audience, `portal-api`: what a token needs to act on the Portal.
    portal: String,
    /// The pipeline runner's namespace, when every Pipeline's own account gets its client too
    /// (PL-19); `None` leaves pipelines to their project's `pipelines` account.
    pipelines: Option<String>,
}

impl WorkloadClientSync {
    /// `None` when the issuer is not a realm URL. The login client is the Portal's audience as
    /// well as the identity that writes the clients.
    pub fn new(issuer: &str, client_id: String, client_secret: String) -> Option<Self> {
        Some(Self {
            portal: client_id.clone(),
            admin: Admin::new(issuer, client_id, client_secret)?,
            pipelines: None,
        })
    }

    /// Gives every Pipeline's own account its federated client, bound to its Kubernetes
    /// ServiceAccount in the runner's namespace `namespace` (PL-19, T-1508).
    pub fn with_pipelines(mut self, namespace: String) -> Self {
        self.pipelines = Some(namespace);
        self
    }

    /// Brings every bound account's client to what [`desired`] and [`audiences`] say, deletes the
    /// managed workload clients no bound account names, and answers one outcome per account
    /// touched (`*` for a failure before any was looked at).
    pub async fn converge(&self, mirror: &Mirror) -> Vec<ClientOutcome> {
        let mut outcomes = Vec::new();
        let token = match self.admin.token().await {
            Ok(token) => token,
            Err(err) => {
                let mut outcome = ClientOutcome::of("*");
                outcome.error = Some(err);
                return vec![outcome];
            }
        };

        // The realm's clients first: who already holds a subject decides a contested one.
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
                outcome.error = Some(format!("listing the workload clients: {err}"));
                return vec![outcome];
            }
        };

        let mut accounts = bound(mirror);
        if let Some(namespace) = &self.pipelines {
            accounts.extend(pipeline_accounts(mirror, namespace));
        }
        let wanted: BTreeSet<String> = accounts.iter().map(BoundAccount::label).collect();
        let refused = contested(&accounts, &listed);
        for account in &accounts {
            if let Some(reason) = refused.get(&account.label()) {
                let mut outcome = ClientOutcome::of(&account.label());
                outcome.error = Some(reason.clone());
                outcomes.push(outcome);
                continue;
            }
            let audiences = audiences(mirror, &account.project, &account.spec, &self.portal);
            outcomes.push(self.converge_one(&token, account, &audiences).await);
        }

        // A managed workload client no bound account names is this wave's to remove (PF-47).
        for client in listed.as_array().into_iter().flatten() {
            let Some(account) = client
                .get("attributes")
                .and_then(|a| a.get(ACCOUNT_ATTRIBUTE))
                .and_then(Value::as_str)
            else {
                continue;
            };
            if !managed(client) || wanted.contains(account) {
                continue;
            }
            let mut outcome = ClientOutcome::of(account);
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
                        "the account is gone or no longer bound to a workload, so its client was removed"
                            .to_owned(),
                    ),
                    Err(err) => outcome.error = Some(err),
                },
                None => outcome.error = Some("the realm listed a client without an id".to_owned()),
            }
            outcomes.push(outcome);
        }
        outcomes
    }

    async fn converge_one(
        &self,
        token: &str,
        account: &BoundAccount,
        audiences: &[String],
    ) -> ClientOutcome {
        let mut outcome = ClientOutcome::of(&account.label());
        let id = keycloak_client_id(&account.project, &account.name);
        let want = desired(&account.project, &account.name, &account.binding);

        let held = match self.admin.find(token, &id).await {
            Ok(held) => held,
            Err(err) => {
                outcome.error = Some(err);
                return outcome;
            }
        };
        let owner = held
            .as_ref()
            .and_then(|client| client.get("attributes"))
            .and_then(|a| a.get(ACCOUNT_ATTRIBUTE))
            .and_then(Value::as_str);
        let uuid = match held.as_ref() {
            Some(client) if !managed(client) || owner != Some(account.label().as_str()) => {
                outcome.error = Some(format!(
                    "the realm holds a client {id} this wave did not create for this account; it \
                     is left alone and the workload has no identity until it is renamed or \
                     removed (PF-47)"
                ));
                return outcome;
            }
            Some(client) => {
                let Some(uuid) = client.get("id").and_then(Value::as_str).map(str::to_owned) else {
                    outcome.error = Some(format!("the realm answered {id} without an id"));
                    return outcome;
                };
                let found = drift(&want, client);
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
                        return outcome;
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
                    return outcome;
                }
                match self.admin.find(token, &id).await {
                    Ok(Some(client)) => match client.get("id").and_then(Value::as_str) {
                        Some(uuid) => uuid.to_owned(),
                        None => {
                            outcome.error = Some(format!("the realm answered {id} without an id"));
                            return outcome;
                        }
                    },
                    Ok(None) => {
                        outcome.error = Some(format!("{id} was created and cannot be read back"));
                        return outcome;
                    }
                    Err(err) => {
                        outcome.error = Some(err);
                        return outcome;
                    }
                }
            }
        };
        if let Err(err) = self
            .admin
            .converge_mappers(
                token,
                &uuid,
                &audiences
                    .iter()
                    .map(|a| audience_mapper(a))
                    .collect::<Vec<_>>(),
                "the account",
                &mut outcome,
            )
            .await
        {
            outcome.error = Some(format!("audiences of {id}: {err}"));
        }
        outcome
    }
}
