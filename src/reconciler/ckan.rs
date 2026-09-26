//! The open-data catalogue, brought to what the repository declares (EP-62…EP-67, T-2405).
//!
//! The publisher itself is `jcctl::publish::ckan`: it builds the dataset from the Endpoint's own
//! DCAT-AP record, the resources from the representations it enables, and the optional sheet from
//! its tabular answer. Until now nothing drove it inside the platform, so a dataset appeared when
//! somebody ran `jcctl publish ckan` from a shell and a withdrawn publication stayed in the
//! catalogue until somebody noticed. EP-62 asks the reconciler to do it, which is this wave.
//!
//! Three rules, each from what goes wrong without it:
//!
//! - **The token is resolved per run and never held.** It comes from the instance's `apiTokenRef`
//!   the way the publisher's own command resolves it — the variable the reference names, else the
//!   repository's encrypted secrets under this Portal's age identity — lives in the HTTP client for
//!   the length of one publication, and is in no outcome, no status and no log line (EP-67, CC-06).
//! - **Only what the previous run published is ever withdrawn.** A dataset somebody created in
//!   CKAN by hand is not this reconciler's to delete, so a withdrawal needs the Endpoint that
//!   declared it to have been there a run ago, exactly as the subscription wave decides its
//!   deletions (CC-19).
//! - **One Endpoint's failure is not the run's.** A catalogue that is down, a record the gateway
//!   will not serve, a reference that does not resolve: each is one outcome with its reason, and
//!   the next Endpoint is still published.
//!
//! Everything CKAN is spoken to through `jcctl`'s blocking client, so each publication runs on a
//! blocking thread: dropping a blocking `reqwest` client inside the reconciler's runtime panics.

use crate::store::Mirror;
use jc_core::kinds::ckan::CkanInstanceSpec;
use jc_core::kinds::EndpointSpec;
use jcctl::commands::publish_ckan::{self as publisher, Target};
use jcctl::loader::{RawManifest, RawMetadata, Repository, ResourceId};
use jcctl::publish::ckan::{CkanApi, Outcome, Settings};
use jcctl::publish::ckan_http::HttpCkan;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// What one run did with one Endpoint's publication.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Publication {
    /// The dataset is what the Endpoint describes; `rows` is what the sheet holds, if any.
    Published {
        /// The dataset name in CKAN.
        dataset: String,
        /// What happened to the dataset itself.
        outcome: Outcome,
        /// Rows written into the sheet, `None` when the Endpoint declares none.
        rows: Option<usize>,
    },
    /// The Endpoint stopped declaring a publication, or is gone, and the dataset went with it.
    Withdrawn {
        /// The dataset that was removed from the catalogue.
        dataset: String,
    },
    /// Nothing was written, and why. Never carries a credential (EP-67).
    Failed(String),
}

/// One line of a run: which Endpoint of which project, and what happened to its dataset.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
    /// The project the Endpoint belongs to.
    pub project: String,
    /// The Endpoint's name.
    pub endpoint: String,
    /// What happened.
    pub publication: Publication,
}

impl Report {
    fn failed(project: &str, endpoint: &str, reason: impl Into<String>) -> Self {
        Self {
            project: project.to_owned(),
            endpoint: endpoint.to_owned(),
            publication: Publication::Failed(reason.into()),
        }
    }
}

/// The catalogue wave of one Portal: where the endpoints answer, and what to call an organization
/// it has to create.
#[derive(Debug, Clone)]
pub struct CkanSync {
    settings: Settings,
    /// The age identity that decrypts the repository's secrets, which is how the instance's
    /// `apiTokenRef` is resolved (EP-67). `None` leaves the token to the variable the reference
    /// names, which is how a Job carries it.
    age_key_file: Option<PathBuf>,
}

impl CkanSync {
    /// A wave publishing endpoints that answer on `host`.
    pub fn new(host: impl Into<String>) -> Self {
        Self {
            settings: Settings::new(host),
            age_key_file: None,
        }
    }

    /// The age identity of this Portal's SOPS backend, so an `apiTokenRef` that lives in the
    /// repository's encrypted secrets resolves (EP-67).
    pub fn with_age_key_file(mut self, path: Option<PathBuf>) -> Self {
        self.age_key_file = path;
        self
    }

    /// The title an organization this run creates is given, from the installation's branding.
    pub fn titled(mut self, title: impl Into<String>) -> Self {
        self.settings = self.settings.clone().titled(title);
        self
    }

    /// Brings every project's catalogue to what the repository declares.
    ///
    /// `repository` is the staged tree of this sync, which is both what `repo` was loaded from and
    /// where a SOPS `secretRef` reads. `previous` is the mirror as it stood before this sync, which
    /// is what says whose dataset may be withdrawn.
    ///
    /// Returns one report per Endpoint this run touched. An Endpoint that declares no publication
    /// and declared none before is not a line: a run over a repository that publishes nothing
    /// reports nothing.
    pub async fn converge(
        &self,
        repo: &Repository,
        previous: &Mirror,
        repository: &Path,
    ) -> Vec<Report> {
        let mut reports = Vec::new();
        let mut wanted: Vec<Target> = Vec::new();
        for project in projects(repo) {
            match publisher::targets(repo, &project) {
                Ok(targets) => wanted.extend(targets),
                // A project whose publication does not read is one project's problem: the
                // Endpoint names an instance that is not there, or a spec that does not parse.
                Err(err) => reports.push(Report::failed(&project, "", err.to_string())),
            }
        }

        let published: BTreeSet<(String, String)> = wanted
            .iter()
            .map(|target| {
                (
                    target.id.namespace.clone().unwrap_or_default(),
                    target.id.name.clone(),
                )
            })
            .collect();

        for target in wanted {
            reports.push(self.one(&target, false, repository).await);
        }
        for target in withdrawn(previous, &published) {
            reports.push(self.one(&target, true, repository).await);
        }
        reports
    }

    /// One Endpoint: resolve the token, then publish or withdraw on a blocking thread.
    async fn one(&self, target: &Target, withdraw: bool, repository: &Path) -> Report {
        let project = target.id.namespace.clone().unwrap_or_default();
        let endpoint = target.id.name.clone();
        let settings = self.settings.clone();
        let target = target.clone();
        let repository = repository.to_path_buf();
        let age_key_file = self.age_key_file.clone();
        // Resolving the token, opening the socket and reading the gateway are all blocking, and
        // dropping a blocking client inside this runtime panics, so the whole publication of one
        // Endpoint happens on a blocking thread.
        let work = tokio::task::spawn_blocking(move || {
            let source = publisher::TokenSource {
                env: None,
                age_key_file: age_key_file.as_deref(),
            };
            let token = publisher::token(&target.instance, &repository, source)
                .map_err(|err| err.to_string())?;
            let mut api =
                HttpCkan::new(target.instance.base_url(), token).map_err(|err| err.to_string())?;
            if withdraw {
                return withdraw_one(&mut api, &target);
            }
            publish_one(&mut api, &target, &settings)
        })
        .await;

        match work {
            Ok(Ok(publication)) => Report {
                project,
                endpoint,
                publication,
            },
            Ok(Err(reason)) => Report::failed(&project, &endpoint, reason),
            Err(err) => Report::failed(
                &project,
                &endpoint,
                format!("the publication did not finish: {err}"),
            ),
        }
    }
}

/// Publishes one Endpoint through an open catalogue connection.
///
/// The record and the rows are read from the gateway as an ordinary consumer, which is what keeps
/// a dataset to what the Endpoint's policy set already allows (EP-66). Blocking: both reads and
/// every catalogue call open a socket.
pub fn publish_one(
    api: &mut impl CkanApi,
    target: &Target,
    settings: &Settings,
) -> Result<Publication, String> {
    let record = publisher::record(target, settings).map_err(|err| err.to_string())?;
    let rows = publisher::rows(target, settings).map_err(|err| err.to_string())?;
    publish_with(api, target, &record, rows.as_ref(), settings)
}

/// The catalogue half of a publication: the dataset and the sheet, from a record already read.
///
/// Split from [`publish_one`] so what a run writes into the catalogue can be asserted without a
/// gateway to read from and without a catalogue to write to.
pub fn publish_with(
    api: &mut impl CkanApi,
    target: &Target,
    record: &serde_json::Value,
    rows: Option<&publisher::Rows>,
    settings: &Settings,
) -> Result<Publication, String> {
    let line = publisher::publish_one(api, target, record, rows, settings)
        .map_err(|err| err.to_string())?;
    Ok(Publication::Published {
        dataset: line.dataset,
        outcome: line.outcome,
        rows: line.mirror.map(|mirror| mirror.rows),
    })
}

/// Withdraws one Endpoint's dataset, and its sheet with it (EP-62, CC-19).
pub fn withdraw_one(api: &mut impl CkanApi, target: &Target) -> Result<Publication, String> {
    let line = publisher::withdraw_one(api, target).map_err(|err| err.to_string())?;
    Ok(Publication::Withdrawn {
        dataset: line.dataset,
    })
}

/// The projects of a repository, as the loader files them.
fn projects(repo: &Repository) -> BTreeSet<String> {
    repo.iter()
        .filter_map(|(id, _)| id.namespace.clone())
        .filter(|namespace| namespace != crate::api::blueprints::ORG_NAMESPACE)
        .collect()
}

/// The publications the previous run had and this one does not: an Endpoint whose `publish.ckan`
/// block was withdrawn, and an Endpoint that is gone altogether (CC-19).
///
/// `published` is what this run publishes, as `(project, endpoint)`.
///
/// Read from the previous mirror rather than from CKAN, so a dataset this reconciler never
/// published is never deleted by it. A withdrawal that happens while the Portal is down is
/// therefore not seen by the run after it: the durable sweep over the catalogue's own
/// `generated_by` datasets needs a search call the pinned publisher does not carry yet, and is a
/// task of its own.
pub fn withdrawn(previous: &Mirror, published: &BTreeSet<(String, String)>) -> Vec<Target> {
    let mut gone = Vec::new();
    for envelope in previous.matching(|env| env.kind == "Endpoint") {
        let project = envelope.metadata.namespace.clone().unwrap_or_default();
        let name = envelope.metadata.name.clone();
        if published.contains(&(project.clone(), name.clone())) {
            continue;
        }
        let Ok(spec) = serde_json::from_value::<EndpointSpec>(envelope.spec.clone()) else {
            continue;
        };
        let Some(publication) = spec.publish.as_ref().and_then(|p| p.ckan.clone()) else {
            continue;
        };
        let instance_name = publication.instance_ref.name().to_owned();
        let Some(instance) = previous
            .get(&project, "CkanInstance", &instance_name)
            .and_then(|env| serde_json::from_value::<CkanInstanceSpec>(env.spec).ok())
        else {
            // The catalogue manifest went with the Endpoint. Nothing can be reached without the
            // instance's URL and token reference, and inventing either would be worse than
            // leaving the dataset to the sweep.
            tracing::warn!(
                project = %project,
                endpoint = %name,
                instance = %instance_name,
                "the endpoint and its catalogue were both removed; the dataset stays until the \
                 catalogue is declared again"
            );
            continue;
        };
        gone.push(Target {
            id: ResourceId {
                group: "joinedcontext.com".to_owned(),
                kind: "Endpoint".to_owned(),
                namespace: Some(project),
                name: name.clone(),
            },
            manifest: RawManifest {
                api_version: envelope.api_version.clone(),
                kind: envelope.kind.clone(),
                metadata: RawMetadata {
                    name,
                    namespace: envelope.metadata.namespace.clone(),
                    rest: serde_json::Map::new(),
                },
                spec: envelope.spec.clone(),
                status: None,
            },
            slug: spec.slug.as_str().to_owned(),
            publication,
            instance_name,
            instance,
            // A withdrawal deletes by name: no title is written and no organization created.
            language: None,
            instance_title: None,
        });
    }
    gone
}
