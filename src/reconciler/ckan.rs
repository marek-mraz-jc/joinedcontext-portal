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
//! - **Only what the platform published is ever withdrawn.** A dataset somebody created in
//!   CKAN by hand, or a harvest wrote, is not this reconciler's to delete, so a withdrawal needs
//!   the Endpoint that declared it to have been there a run ago, exactly as the subscription wave
//!   decides its deletions (CC-19), or the dataset to carry jcctl's own `generated_by` mark in an
//!   organization the current Endpoints publish into (T-4461).
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
use jcctl::publish::ckan::{CkanApi, Measurements, Outcome, Settings};
use jcctl::publish::ckan_http::HttpCkan;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

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
        /// The record lists a model without its LinkML artifact, so the dataset links the
        /// schema index for it (EP-68).
        no_linkml: bool,
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
    /// Where the measurements of a dataset's data come from: the daily run's freshness and the
    /// gateway's checks (DM-95). `None` publishes without measurements.
    quality: Option<(
        Arc<crate::quality::Store>,
        Arc<crate::quality_checks::Readings>,
    )>,
    /// What the log last said of each `(project, endpoint)`, so an outcome is logged when it
    /// changes and not once a sync (T-4065).
    said: Arc<Mutex<HashMap<(String, String), String>>>,
}

impl CkanSync {
    /// A wave publishing endpoints that answer on `host`.
    pub fn new(host: impl Into<String>) -> Self {
        Self {
            settings: Settings::new(host),
            age_key_file: None,
            quality: None,
            said: Arc::default(),
        }
    }

    /// Publishes each dataset with the pass rate and the freshness of its space (DM-95).
    pub fn with_quality(
        mut self,
        daily: Arc<crate::quality::Store>,
        checks: Arc<crate::quality_checks::Readings>,
    ) -> Self {
        self.quality = Some((daily, checks));
        self
    }

    /// What was measured of the space an Endpoint serves: the daily run by the space's name, the
    /// gateway's counters by its tenant segment, which is how the gateway labels them.
    pub fn measured(&self, repo: &Repository, target: &Target) -> Measurements {
        let Some((daily, checks)) = &self.quality else {
            return Measurements::default();
        };
        let project = target.id.namespace.as_deref().unwrap_or_default();
        let Some(space) = target
            .manifest
            .spec
            .get("contextSpaceRef")
            .and_then(crate::resource::reference_name)
        else {
            return Measurements::default();
        };
        measurements(
            daily.get(project, space).as_ref(),
            &checks.report(&repo.space_segment(project, space), &[]),
        )
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

    /// Where the installation's documentation lives, so a usage text links its page (EP-108).
    pub fn documented_at(mut self, base: impl Into<String>) -> Self {
        self.settings = self.settings.clone().documented_at(base);
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
        let mut unread = false;
        for project in projects(repo) {
            match publisher::targets(repo, &project) {
                Ok(targets) => wanted.extend(targets),
                // A project whose publication does not read is one project's problem: the
                // Endpoint names an instance that is not there, or a spec that does not parse.
                Err(err) => {
                    unread = true;
                    reports.push(Report::failed(&project, "", err.to_string()));
                }
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

        // Per catalogue and organization, the datasets the current Endpoints publish there: what
        // the sweep keeps (T-4461).
        let mut sweeps: BTreeMap<(String, String), (Target, BTreeSet<String>)> = BTreeMap::new();
        for target in &wanted {
            let Some(organization) = target
                .publication
                .organization
                .clone()
                .or_else(|| target.instance.organization_default.clone())
            else {
                continue;
            };
            let key = (target.instance.base_url().to_owned(), organization);
            sweeps
                .entry(key)
                .or_insert_with(|| (target.clone(), BTreeSet::new()))
                .1
                .insert(target.dataset_name().to_owned());
        }

        for target in wanted {
            let measured = self.measured(repo, &target);
            reports.push(self.one(&target, false, repository, measured).await);
        }
        for target in withdrawn(previous, &published) {
            let measured = Measurements::default();
            reports.push(self.one(&target, true, repository, measured).await);
        }
        // A project whose publications did not read keeps its datasets out of `kept`, and a
        // shared organization would lose them: no sweep in such a pass.
        if unread {
            sweeps.clear();
        }
        for ((_, organization), (target, kept)) in sweeps {
            reports.extend(self.sweep(&target, organization, kept, repository).await);
        }
        self.log(&reports);
        reports
    }

    /// One log line per Endpoint whose outcome changed since the last run, and one per write:
    /// the catalogue's state was told only to the activity feed, so a dataset that failed every
    /// sync for hours said so nowhere an operator reads (T-4065). A reason is the publisher's
    /// own sentence, which never carries the token (EP-67).
    /// Returns the lines it logged.
    pub fn log(&self, reports: &[Report]) -> Vec<String> {
        let mut logged = Vec::new();
        let Ok(mut said) = self.said.lock() else {
            return logged;
        };
        for report in reports {
            let (line, wrote) = match &report.publication {
                Publication::Published { outcome, rows, .. } => (
                    match rows {
                        Some(rows) => format!("{} (sheet of {rows} rows)", outcome_word(*outcome)),
                        None => outcome_word(*outcome).to_owned(),
                    },
                    matches!(outcome, Outcome::Created | Outcome::Updated),
                ),
                Publication::Withdrawn { .. } => ("withdrawn".to_owned(), true),
                Publication::Failed(reason) => (format!("failed: {reason}"), false),
            };
            let key = (report.project.clone(), report.endpoint.clone());
            if !wrote && said.get(&key) == Some(&line) {
                continue;
            }
            let dataset = match &report.publication {
                Publication::Published { dataset, .. } | Publication::Withdrawn { dataset } => {
                    dataset.as_str()
                }
                Publication::Failed(_) => "",
            };
            if matches!(report.publication, Publication::Failed(_)) {
                tracing::warn!(project = %report.project, endpoint = %report.endpoint, outcome = %line, "catalogue");
            } else {
                tracing::info!(project = %report.project, endpoint = %report.endpoint, %dataset, outcome = %line, "catalogue");
            }
            logged.push(format!("{}/{}: {line}", report.project, report.endpoint));
            said.insert(key, line);
        }
        logged
    }

    /// One Endpoint: resolve the token, then publish or withdraw on a blocking thread.
    async fn one(
        &self,
        target: &Target,
        withdraw: bool,
        repository: &Path,
        measured: Measurements,
    ) -> Report {
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
            publish_one(&mut api, &target, &settings, &measured)
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

    /// Withdraws the datasets this platform published into `organization` that no current
    /// Endpoint publishes (T-4461): the withdrawal from the previous mirror misses an Endpoint
    /// removed in the same apply that restarted the Portal, because no mirror it holds ever had
    /// it. `target` is any current publication there, for the catalogue and its token.
    async fn sweep(
        &self,
        target: &Target,
        organization: String,
        kept: BTreeSet<String>,
        repository: &Path,
    ) -> Vec<Report> {
        let project = target.id.namespace.clone().unwrap_or_default();
        let target = target.clone();
        let repository = repository.to_path_buf();
        let age_key_file = self.age_key_file.clone();
        let work = tokio::task::spawn_blocking(move || {
            let source = publisher::TokenSource {
                env: None,
                age_key_file: age_key_file.as_deref(),
            };
            let token = publisher::token(&target.instance, &repository, source)
                .map_err(|err| err.to_string())?;
            let mut api =
                HttpCkan::new(target.instance.base_url(), token).map_err(|err| err.to_string())?;
            sweep_with(&mut api, &organization, &kept)
        })
        .await;
        match work {
            Ok(Ok(reports)) => reports
                .into_iter()
                .map(|(dataset, publication)| Report {
                    project: project.clone(),
                    endpoint: dataset,
                    publication,
                })
                .collect(),
            Ok(Err(reason)) => vec![Report::failed(&project, "", reason)],
            Err(err) => vec![Report::failed(
                &project,
                "",
                format!("the catalogue sweep did not finish: {err}"),
            )],
        }
    }
}

/// The page `package_search` is read in.
const SEARCH_ROWS: usize = 500;

/// Finds and withdraws, through an open catalogue connection, every dataset in `organization`
/// that carries the platform's own `generated_by` mark and is not in `kept`. A dataset without
/// the mark (a harvest's, one made by hand) is never touched. One outcome per dataset, by name.
pub fn sweep_with(
    api: &mut impl CkanApi,
    organization: &str,
    kept: &BTreeSet<String>,
) -> Result<Vec<(String, Publication)>, String> {
    let mut stray = Vec::new();
    let mut start = 0;
    loop {
        let page = api
            .action(
                "package_search",
                &serde_json::json!({
                    "fq": format!("organization:\"{organization}\""),
                    "include_private": true,
                    "rows": SEARCH_ROWS,
                    "start": start,
                }),
            )
            .map_err(|err| err.to_string())?;
        let results = page["results"].as_array().cloned().unwrap_or_default();
        for dataset in &results {
            let ours = dataset["extras"].as_array().is_some_and(|extras| {
                extras.iter().any(|extra| {
                    extra["key"] == "generated_by"
                        && extra["value"] == jcctl::publish::ckan::GENERATOR
                })
            });
            match dataset["name"].as_str() {
                Some(name) if ours && !kept.contains(name) => stray.push(name.to_owned()),
                _ => {}
            }
        }
        start += results.len();
        let total = page["count"].as_u64().unwrap_or(0) as usize;
        if results.is_empty() || start >= total {
            break;
        }
    }
    stray
        .into_iter()
        .map(|name| {
            jcctl::publish::ckan::withdraw(api, &name)
                .map(|_| {
                    let publication = Publication::Withdrawn {
                        dataset: name.clone(),
                    };
                    (name, publication)
                })
                .map_err(|err| err.to_string())
        })
        .collect()
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
    measured: &Measurements,
) -> Result<Publication, String> {
    let record = publisher::record(target, settings).map_err(|err| err.to_string())?;
    let record = jcctl::publish::ckan::measured(&record, measured);
    match publisher::rows(target, settings) {
        Ok(rows) => publish_with(api, target, &record, rows.as_ref(), settings),
        Err(err) => publish_without_rows(api, target, &record, &err.to_string(), settings),
    }
}

/// The dataset brought to its record when the sheet's rows did not read, and a failure that
/// says so: the rows were read first and their failure skipped the dataset too, so
/// helsinki-transport kept the resources of 05:28 while its Endpoint gained `/ws` (T-4065).
/// The sheet keeps what it holds until a run reads the rows again.
pub fn publish_without_rows(
    api: &mut impl CkanApi,
    target: &Target,
    record: &serde_json::Value,
    unread: &str,
    settings: &Settings,
) -> Result<Publication, String> {
    let mut dataset_only = target.clone();
    dataset_only.publication.datastore = None;
    let outcome = match publish_with(api, &dataset_only, record, None, settings)? {
        Publication::Published { outcome, .. } => outcome_word(outcome),
        _ => "not published",
    };
    Err(format!(
        "the dataset is {outcome}, its sheet was not refreshed: {unread}"
    ))
}

/// The word a log line and a failure say for what happened to a dataset.
fn outcome_word(outcome: Outcome) -> &'static str {
    match outcome {
        Outcome::Created => "created",
        Outcome::Updated => "updated",
        Outcome::Unchanged => "unchanged",
        Outcome::NotPublished => "not published",
        Outcome::Withdrawn => "withdrawn",
    }
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
        no_linkml: line.no_linkml,
    })
}

/// The pass rate over seven days of every rule of the space, to a hundredth, and the age of
/// its newest data when the daily run read it (DM-95). Both are steady between two readings, so
/// an unchanged dataset is not written again every sync (CC-18).
pub fn measurements(
    daily: Option<&crate::quality::SpaceQuality>,
    checks: &crate::quality_checks::SpaceChecks,
) -> Measurements {
    let (pass, all) = checks.rules.iter().fold((0, 0), |(pass, all), rule| {
        let week = &rule.week;
        (
            pass + week.pass,
            all + week.pass + week.reject + week.flag + week.quarantine,
        )
    });
    let freshness_seconds = daily.and_then(|report| {
        let newest = report.types.iter().filter_map(|kind| kind.newest).max()?;
        Some((report.observed_at - newest).num_seconds().max(0))
    });
    Measurements {
        pass_rate: (all > 0).then(|| (pass as f64 / all as f64 * 100.0).round() / 100.0),
        freshness_seconds,
    }
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
/// published is never deleted by it. A withdrawal that happens while the Portal is down is not
/// seen here; [`sweep_with`] finds it in the catalogue by the platform's own `generated_by` mark.
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
