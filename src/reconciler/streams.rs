//! Deploying approved DataSource pipelines as Bento streams on the project runner (T-0646, PL-47).
//!
//! Approved pipelines reading external feeds via `kind: DataSource` are rendered into native Bento
//! stream definitions and applied over the runner's streams REST API. Live state reflects the
//! runner's actual response, never Git alone.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use jc_core::kinds::data_source::{check_class, DataSourceSpec, DataSourceType};
use jc_core::kinds::pipeline::{Compute, ComputeKind, PipelineSource, PipelineSpec, Step};
use jc_core::Condition;
use jcctl::bento::InputContext;
use serde_json::Value;

use crate::store::Mirror;

/// Timeout for requests sent to the runner's streams API.
const RUNNER_TIMEOUT: Duration = Duration::from_secs(30);

/// The first wait after a PUT the runner did not answer, doubled on each further miss up to
/// [`BACKOFF_CEILING`] (T-2891).
const BACKOFF_START: Duration = Duration::from_secs(60);
const BACKOFF_CEILING: Duration = Duration::from_secs(15 * 60);

/// The last PUT of one stream that the runner did not answer: the render it carried, when the
/// next attempt is due, the wait that led there, and what the transport said.
#[derive(Debug, Clone)]
struct Backoff {
    hash: u64,
    until: Instant,
    wait: Duration,
    reason: String,
}

/// Why a pipeline stream cannot be rendered from the manifest specifications.
#[derive(Debug, thiserror::Error)]
pub enum RenderError {
    /// The pipeline has no compute block or its compute kind is not bloblang.
    #[error("pipeline compute is missing or not bloblang")]
    MissingCompute,
    /// The pipeline class does not fit the data source (PL-04, PL-50).
    #[error("pipeline class does not fit data source: {0}")]
    Class(String),
    /// The author's `bento.yaml` is not YAML the runner would read.
    #[error("bento.yaml: {0}")]
    Bento(String),
    /// The author wrote an input and the pipeline names a DataSource too (PL-39).
    #[error("bento.yaml already declares an input, and spec.source.dataSourceRef names another one; keep one of the two")]
    BentoInput,
    /// Serialization between norway and json values failed.
    #[error("json serialization error: {0}")]
    Json(#[from] serde_json::Error),
    /// A custom configuration error.
    #[error("{0}")]
    Custom(String),
}

/// The `bento.yaml` beside each Pipeline manifest, by `(project, pipeline)`: the author's
/// mapping the loader leaves alone (PL-03), read from the staged tree by the sync.
pub type Bentos = HashMap<(String, String), String>;

/// The result of attempting to apply one pipeline stream to the runner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamOutcome {
    /// The runner accepted the stream and is executing it.
    Live,
    /// The pipeline is not eligible for streams mode (e.g. disabled or not a DataSource).
    Skipped(&'static str),
    /// The runner refused the stream, or an error occurred during render or network transport.
    Error(String),
}

/// Deploys and retires streams on project-specific pipeline runners.
pub struct StreamDeployer {
    runner_url: String,
    http: reqwest::Client,
    deployed: Mutex<HashSet<(String, String)>>,
    /// The hash of the config each live stream was last PUT with: an unchanged render is not
    /// sent again, because the runner restarts a stream on every PUT and a periodic pipeline
    /// then emits on every pass instead of every period (PL-45, T-0659).
    rendered: Mutex<HashMap<(String, String), u64>>,
    /// Streams whose last PUT the runner did not answer. Bento restarts a stream on PUT and
    /// waits for it to stop, and a stream blocked delivering data never stops, so every such
    /// PUT costs a whole [`RUNNER_TIMEOUT`]; sending the same render again on every pass kept
    /// a leader tick busy for minutes (T-2891). A changed render is sent at once.
    backoff: Mutex<HashMap<(String, String), Backoff>>,
    /// Where a refused record is posted (the Portal's internal listener, as the runner reaches
    /// it) and the compiled model of each space: with both, every stream into a space that
    /// names a model carries the validation stage (PL-60, PL-61).
    validation: Option<(String, Arc<crate::pipeline_validation::ModelSchemas>)>,
}

/// The rendered config as one number, so two passes can tell an unchanged stream apart.
fn config_hash(config: &Value) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    config.to_string().hash(&mut hasher);
    hasher.finish()
}

impl StreamDeployer {
    /// Creates a new deployer targeting the specified runner URL template (may contain `{project}`).
    pub fn new(runner_url: impl Into<String>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(RUNNER_TIMEOUT)
            .build()
            .unwrap_or_default();
        Self {
            runner_url: runner_url.into(),
            http,
            deployed: Mutex::new(HashSet::new()),
            rendered: Mutex::new(HashMap::new()),
            backoff: Mutex::new(HashMap::new()),
            validation: None,
        }
    }

    /// Validates every record against its space's model before the write (PL-60): `internal`
    /// is the base URL of the Portal's internal listener as the runner reaches it.
    pub fn with_validation(
        mut self,
        internal: impl Into<String>,
        schemas: Arc<crate::pipeline_validation::ModelSchemas>,
    ) -> Self {
        self.validation = Some((internal.into(), schemas));
        self
    }

    /// The compiled models this deployer renders stages from, when it validates.
    pub fn model_schemas(&self) -> Option<&Arc<crate::pipeline_validation::ModelSchemas>> {
        self.validation.as_ref().map(|(_, schemas)| schemas)
    }

    /// Puts the validation stage into one rendered stream when every output writes into the
    /// same space and that space names a model (PL-60). A stream that fans out into spaces of
    /// different models is left without it and says so.
    /// ponytail: one stage per stream; per-output stages are the upgrade when a fan-out needs them.
    fn validated(&self, stream: &mut Value, project: &str, pipeline: &str, spaces: &[String]) {
        let Some((internal, schemas)) = &self.validation else {
            return;
        };
        let Some(space) = spaces.first() else {
            return;
        };
        if spaces.iter().any(|other| other != space) {
            tracing::warn!(
                project,
                pipeline,
                "the outputs write into several spaces; the stream is not validated"
            );
            return;
        }
        let Some(schema) = schemas.get(project, space) else {
            return;
        };
        let sink = format!(
            "{}/internal/pipelines/{project}/{pipeline}/rejected",
            internal.trim_end_matches('/')
        );
        if !crate::pipeline_validation::insert_stage(stream, &schema, &sink) {
            tracing::warn!(
                project,
                pipeline,
                "the stream has no batch split; the stage is not rendered"
            );
        }
    }

    /// Sends the outcome of every batch the stream's write took to the pipeline's log (PL-62).
    fn logged(&self, stream: &mut Value, project: &str, pipeline: &str) {
        let Some((internal, _)) = &self.validation else {
            return;
        };
        let Some(output) = stream.get_mut("output") else {
            return;
        };
        let url = format!(
            "{}/internal/pipelines/{project}/{pipeline}/outcomes",
            internal.trim_end_matches('/')
        );
        *output = crate::pipeline_log::with_outcomes(output.take(), &url);
        crate::pipeline_log::with_passes(stream, &url);
    }

    /// The runner's Prometheus text for one project, or `None` when it does not answer.
    ///
    /// A stream can be Live and still read nothing — a source that refuses the runner's token,
    /// a mapping that throws on every message — and the counters are the only place that shows
    /// (T-0914).
    pub async fn metrics(&self, project: &str) -> Option<String> {
        let runner = self.runner_for(project)?;
        let url = format!("{runner}/metrics");
        let response = self.http.get(&url).send().await.ok()?;
        if !response.status().is_success() {
            return None;
        }
        response.text().await.ok()
    }

    /// The runner's base URL for one project, or nothing when the name is not a project name.
    ///
    /// The template may carry `{project}` in its authority — `http://bento-{project}.streams.svc`
    /// is the natural shape of a runner service per project — so an unchecked name moves the
    /// request to another host, and one carrying `/` moves it outside the project's own path
    /// (T-2298). The check is here as well as at the mirror's door, because either one alone
    /// leaves the other caller open.
    fn runner_for(&self, project: &str) -> Option<String> {
        if !crate::resource::is_dns1123(project) {
            tracing::warn!(project = %project, "the runner is not asked about a name that is not a project");
            return None;
        }
        Some(
            self.runner_url
                .replace("{project}", project)
                .trim_end_matches('/')
                .to_owned(),
        )
    }

    /// Renders and PUTs every eligible Pipeline of `mirror`; returns (namespace, name, outcome).
    pub async fn converge(
        &self,
        mirror: &Mirror,
        bentos: &Bentos,
        refused: &std::collections::BTreeMap<(String, String), String>,
    ) -> Vec<(String, String, StreamOutcome)> {
        let mut outcomes = Vec::new();
        let mut current_live = HashSet::new();

        for ns in mirror.namespaces() {
            // What the runner holds, asked once per project and only when a render is unchanged.
            let mut running: Option<Option<HashMap<String, bool>>> = None;
            // What the project may keep resident (PF-74): the ones beyond its quota are not
            // scheduled at all, and the condition on each says why.
            let beyond = crate::quotas::beyond(mirror, &ns, "residentPipelines");
            let page = mirror.list(&ns, "Pipeline", &crate::store::ListOptions::default());
            for envelope in page.items {
                let name = envelope.metadata.name.clone();
                // A pipeline whose credential did not resolve is not started: a stream that
                // cannot connect fails in the runner's log, where nobody is looking (T-0927).
                if let Some(reason) = refused.get(&(ns.clone(), name.clone())) {
                    outcomes.push((ns.clone(), name, StreamOutcome::Error(reason.clone())));
                    continue;
                }
                if beyond.contains(&name) {
                    outcomes.push((
                        ns.clone(),
                        name,
                        StreamOutcome::Skipped(
                            "the project's resident pipeline quota is used up, so this one is \
                             not scheduled (PF-73, PF-74)",
                        ),
                    ));
                    continue;
                }
                let spec: PipelineSpec = match serde_json::from_value(envelope.spec.clone()) {
                    Ok(s) => s,
                    Err(err) => {
                        outcomes.push((
                            ns.clone(),
                            name,
                            StreamOutcome::Error(format!("invalid pipeline spec: {err}")),
                        ));
                        continue;
                    }
                };

                let first = spec.sources().into_iter().next();
                let ds_ref_name = first
                    .as_ref()
                    .and_then(|s| s.data_source_ref.as_ref())
                    .map(|r| r.name().to_string());

                let ep_ref_name = first
                    .as_ref()
                    .and_then(|s| s.endpoint_ref.as_ref())
                    .map(|r| r.name().to_string());

                if ds_ref_name.is_none() && ep_ref_name.is_none() {
                    outcomes.push((
                        ns.clone(),
                        name,
                        StreamOutcome::Skipped("not a supported stream pipeline"),
                    ));
                    continue;
                }

                if !eligible(&spec) {
                    let reason = if !spec.enabled {
                        "pipeline is disabled"
                    } else if let Some(compute) = first_compute(&spec) {
                        if compute.kind != ComputeKind::Bloblang {
                            "compute is not bloblang"
                        } else {
                            "endpoint pipeline requires bloblang mapping"
                        }
                    } else {
                        "not eligible for streams mode"
                    };
                    outcomes.push((ns.clone(), name, StreamOutcome::Skipped(reason)));
                    continue;
                }

                // What each output's Endpoint writes into: the space segment a mapping reads as
                // `env("JC_SPACE")`, `JC_SPACE_2`, … (PL-57, PF-84).
                let spaces: Vec<String> = spec
                    .outputs()
                    .iter()
                    .map(|output| {
                        let ep_name = output.target_endpoint.local_id();
                        mirror
                            .get(&ns, "Endpoint", ep_name)
                            .and_then(|ep| {
                                ep.spec.get("contextSpaceRef").and_then(|r| {
                                    r.as_str()
                                        .or_else(|| r.get("name").and_then(Value::as_str))
                                        .map(str::to_owned)
                                })
                            })
                            .unwrap_or_default()
                    })
                    .collect();
                let segments: Vec<String> = spaces
                    .iter()
                    .map(|space| crate::spaces::segment(mirror, &ns, space))
                    .collect();
                // And what each source's Endpoint reads out of: the segment a mapping reads as
                // `env("JC_SOURCE_SPACE")`. A pipeline that computes from another space records
                // where its figures came from, and that provenance is a URN the broker parses:
                // with nothing injected the mapping rendered `urn:ngsi-ld:Endpoint:hel.fi:<nil>:<nil>`,
                // every indicator was refused `attribute derivedFrom: object must be a URI`, and
                // the indicator space stayed empty (T-2445). A source that names a DataSource
                // has no space to read, and contributes nothing here.
                let source_segments: Vec<String> = spec
                    .sources()
                    .iter()
                    .filter_map(|source| source.endpoint_ref.as_ref())
                    .map(|reference| {
                        let space = mirror
                            .get(&ns, "Endpoint", reference.name())
                            .and_then(|ep| {
                                ep.spec.get("contextSpaceRef").and_then(|r| {
                                    r.as_str()
                                        .or_else(|| r.get("name").and_then(Value::as_str))
                                        .map(str::to_owned)
                                })
                            })
                            .unwrap_or_default();
                        crate::spaces::segment(mirror, &ns, &space)
                    })
                    .collect();
                // Every output's Endpoint, from the mirror (PL-52, PL-55).
                let slugs: Result<Vec<String>, String> = spec
                    .outputs()
                    .iter()
                    .map(|output| {
                        let ep_name = output.target_endpoint.local_id().to_string();
                        let ep_env = mirror.get(&ns, "Endpoint", &ep_name).ok_or_else(|| {
                            format!("target endpoint {ep_name} is not in the mirror")
                        })?;
                        ep_env
                            .spec
                            .get("slug")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                            .ok_or_else(|| format!("target endpoint {ep_name} has no slug"))
                    })
                    .collect();
                let slugs = match slugs {
                    Ok(slugs) if !slugs.is_empty() => slugs,
                    Ok(_) => {
                        outcomes.push((
                            ns.clone(),
                            name,
                            StreamOutcome::Error(
                                "the pipeline names no target endpoint".to_owned(),
                            ),
                        ));
                        continue;
                    }
                    Err(reason) => {
                        outcomes.push((ns.clone(), name, StreamOutcome::Error(reason)));
                        continue;
                    }
                };

                if is_merged(&spec) {
                    let resolved: Result<Vec<ResolvedSource>, String> = spec
                        .sources()
                        .into_iter()
                        .map(|source| resolve_source(mirror, &ns, source))
                        .collect();
                    let rendered = resolved.and_then(|sources| {
                        render_merged(&spec, &name, &ns, &sources, &slugs)
                            .map_err(|err| err.to_string())
                    });
                    match rendered {
                        Ok(mut stream_json) => {
                            self.validated(&mut stream_json, &ns, &name, &spaces);
                            self.logged(&mut stream_json, &ns, &name);
                            jcctl::bento::inject_space(&mut stream_json, &segments);
                            inject_source_space(&mut stream_json, &source_segments);
                            let outcome = self
                                .apply(&ns, &name, stream_json, &mut running, &mut current_live)
                                .await;
                            outcomes.push((ns.clone(), name, outcome));
                        }
                        Err(reason) => {
                            outcomes.push((ns.clone(), name, StreamOutcome::Error(reason)))
                        }
                    }
                    continue;
                }
                let target_slug = slugs[0].clone();

                let stream_json = if let Some(ds_name) = ds_ref_name {
                    let ds_env = match mirror.get(&ns, "DataSource", &ds_name) {
                        Some(e) => e,
                        None => {
                            outcomes.push((
                                ns.clone(),
                                name,
                                StreamOutcome::Error(format!(
                                    "data source {ds_name} is not in the mirror"
                                )),
                            ));
                            continue;
                        }
                    };

                    let ds_spec: DataSourceSpec = match serde_json::from_value(ds_env.spec.clone())
                    {
                        Ok(s) => s,
                        Err(err) => {
                            outcomes.push((
                                ns.clone(),
                                name,
                                StreamOutcome::Error(format!("invalid data source spec: {err}")),
                            ));
                            continue;
                        }
                    };

                    let bento = bentos.get(&(ns.clone(), name.clone())).map(String::as_str);
                    match render_stream(&spec, &name, &ns, &ds_spec, &ds_name, &target_slug, bento)
                    {
                        Ok(val) => val,
                        Err(err) => {
                            outcomes.push((
                                ns.clone(),
                                name,
                                StreamOutcome::Error(err.to_string()),
                            ));
                            continue;
                        }
                    }
                } else if let Some(source_ep_name) = ep_ref_name {
                    let source_ep_env = match mirror.get(&ns, "Endpoint", &source_ep_name) {
                        Some(e) => e,
                        None => {
                            outcomes.push((
                                ns.clone(),
                                name,
                                StreamOutcome::Error(format!(
                                    "source endpoint {source_ep_name} is not in the mirror"
                                )),
                            ));
                            continue;
                        }
                    };

                    let source_slug = match source_ep_env.spec.get("slug").and_then(Value::as_str) {
                        Some(s) => s,
                        None => {
                            outcomes.push((
                                ns.clone(),
                                name,
                                StreamOutcome::Error(format!(
                                    "source endpoint {source_ep_name} has no slug"
                                )),
                            ));
                            continue;
                        }
                    };

                    let source_is_public = source_ep_env
                        .spec
                        .get("audience")
                        .and_then(Value::as_str)
                        .is_none_or(|audience| audience == "public");

                    match render_endpoint_stream(
                        &spec,
                        &ns,
                        &format!("{ns}/{name}"),
                        source_slug,
                        source_is_public,
                        &target_slug,
                    ) {
                        Ok(val) => val,
                        Err(err) => {
                            outcomes.push((
                                ns.clone(),
                                name,
                                StreamOutcome::Error(err.to_string()),
                            ));
                            continue;
                        }
                    }
                } else {
                    unreachable!();
                };

                let mut stream_json = stream_json;
                self.validated(&mut stream_json, &ns, &name, &spaces);
                self.logged(&mut stream_json, &ns, &name);
                jcctl::bento::inject_space(&mut stream_json, &segments);
                inject_source_space(&mut stream_json, &source_segments);
                let outcome = self
                    .apply(&ns, &name, stream_json, &mut running, &mut current_live)
                    .await;
                outcomes.push((ns.clone(), name, outcome));
            }
        }

        // The sweeps of the pipelines that remove stale entities (PL-64), after every pipeline's
        // own stream, so a sweep's outcome lands on its pipeline after the pipeline's own.
        for ns in mirror.namespaces() {
            let mut running: Option<Option<HashMap<String, bool>>> = None;
            let page = mirror.list(&ns, "Pipeline", &crate::store::ListOptions::default());
            for envelope in page.items {
                let name = envelope.metadata.name;
                let Ok(spec) = serde_json::from_value::<PipelineSpec>(envelope.spec) else {
                    continue;
                };
                let Some(expiry) = spec.expiry.as_ref() else {
                    continue;
                };
                if !spec.enabled || refused.contains_key(&(ns.clone(), name.clone())) {
                    continue;
                }
                let sweep = crate::pipeline_expiry::sweep_name(&name);
                let slug = spec.outputs().first().and_then(|output| {
                    mirror
                        .get(&ns, "Endpoint", output.target_endpoint.local_id())
                        .and_then(|ep| {
                            ep.spec
                                .get("slug")
                                .and_then(Value::as_str)
                                .map(str::to_owned)
                        })
                });
                let stream = slug
                    .as_deref()
                    .map(|slug| crate::pipeline_expiry::render_sweep(&ns, slug, expiry));
                let outcome = match stream {
                    Some(Some(stream)) => {
                        self.apply(&ns, &sweep, stream, &mut running, &mut current_live)
                            .await
                    }
                    // Never read as a window of zero, which deletes everything (PL-64).
                    Some(None) => StreamOutcome::Error(format!(
                        "expiry `{}` over {:?} is not a window of 1h to 365d over one to {} \
                         distinct entity types, so nothing is swept",
                        expiry.after,
                        expiry.types,
                        jc_core::kinds::pipeline::EXPIRY_MAX_TYPES
                    )),
                    None => StreamOutcome::Error(
                        "the target endpoint is not in the mirror or has no slug, so nothing \
                         is swept"
                            .to_owned(),
                    ),
                };
                outcomes.push((ns.clone(), sweep, outcome));
            }
        }

        // Retire streams that were deployed previously but are no longer active or eligible.
        let to_retire: Vec<(String, String)> = {
            let deployed = self.deployed.lock().unwrap_or_else(|p| p.into_inner());
            deployed.difference(&current_live).cloned().collect()
        };
        let mut by_project: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        for (ns, name) in to_retire {
            by_project.entry(ns).or_default().push(name);
        }
        for (project, names) in by_project {
            self.retire(&project, &names).await;
        }

        if let Ok(mut deployed) = self.deployed.lock() {
            *deployed = current_live;
        }

        outcomes
    }

    /// Sends one rendered stream to the runner unless it already runs this exact render, and
    /// records it as live when the runner has it.
    async fn apply(
        &self,
        ns: &str,
        name: &str,
        stream_json: Value,
        running: &mut Option<Option<HashMap<String, bool>>>,
        current_live: &mut HashSet<(String, String)>,
    ) -> StreamOutcome {
        let key = (ns.to_owned(), name.to_owned());
        let hash = config_hash(&stream_json);
        let stored = self
            .rendered
            .lock()
            .map(|rendered| rendered.get(&key).copied())
            .unwrap_or(None);
        let mut unchanged = stored == Some(hash);
        // A runner that restarted holds no streams, so an unchanged render it no longer runs is
        // sent again; a runner that does not answer the list keeps the hash's word. A stream the
        // runner holds but reports inactive is sent again too, unless its input is one that ends
        // by itself: a clock, a broker and a socket never finish, so inactive means that stream
        // died — a source it cannot reach, or an output that refuses its credential — and it is
        // the reconciler counting it as live that left the city's `voda` stream dead across two
        // applies while its render was unchanged (T-2336, PL-18, OPS-27). Sending it again
        // restarts it on the runner, and its output fetches a fresh token as it starts.
        if unchanged {
            if running.is_none() {
                *running = Some(self.running(ns).await);
            }
            unchanged = match running.as_ref().and_then(Option::as_ref) {
                None => true,
                Some(streams) => match streams.get(name) {
                    None => false,
                    Some(true) => true,
                    Some(false) => {
                        let finished = input_ends_by_itself(&stream_json["input"]);
                        if !finished {
                            tracing::warn!(
                                project = %ns,
                                pipeline = %name,
                                "the runner holds this stream but it is not running; sending it \
                                 again"
                            );
                        }
                        finished
                    }
                },
            };
        } else if stored.is_none() {
            // No hash means this Portal has not sent the stream since it started. The runner
            // answers a stream's config exactly as it was sent, so a stream it runs as rendered
            // is adopted rather than PUT again: every restart used to PUT every stream, and a
            // stream the runner cannot stop made each of those PUTs wait out the timeout (T-2891).
            unchanged = self.holds_as_rendered(ns, name, &stream_json).await;
        }
        let outcome = if unchanged {
            StreamOutcome::Live
        } else if let Some(waiting) = self.waiting(&key, hash) {
            waiting
        } else {
            match self.deploy_stream(ns, name, &stream_json).await {
                Ok(outcome) => outcome,
                Err(reason) => self.back_off(key.clone(), hash, reason),
            }
        };
        if outcome == StreamOutcome::Live {
            current_live.insert(key.clone());
            if let Ok(mut rendered) = self.rendered.lock() {
                rendered.insert(key.clone(), hash);
            }
            if let Ok(mut backoff) = self.backoff.lock() {
                backoff.remove(&key);
            }
        }
        outcome
    }

    /// Whether the runner holds `name` with exactly this config and it still runs (or its input
    /// ends by itself, as in [`Self::apply`]). Anything else, the runner not answering included,
    /// is "no": the stream is then sent as before.
    async fn holds_as_rendered(&self, project: &str, name: &str, stream_json: &Value) -> bool {
        let Some(runner) = self.runner_for(project) else {
            return false;
        };
        let Ok(response) = self
            .http
            .get(format!("{runner}/streams/{name}"))
            .send()
            .await
        else {
            return false;
        };
        if !response.status().is_success() {
            return false;
        }
        let Ok(held) = response.json::<Value>().await else {
            return false;
        };
        let alive = held.get("active").and_then(Value::as_bool).unwrap_or(true)
            || input_ends_by_itself(&stream_json["input"]);
        let same = held.get("config") == Some(stream_json);
        if same && alive {
            tracing::info!(
                project = %project,
                pipeline = %name,
                "the runner already runs this stream as rendered; not sent again"
            );
        }
        same && alive
    }

    /// The outcome of a stream whose last PUT of this same render the runner did not answer,
    /// while its wait lasts; `None` when it is due, or when the render changed since.
    fn waiting(&self, key: &(String, String), hash: u64) -> Option<StreamOutcome> {
        let backoff = self.backoff.lock().ok()?;
        let last = backoff.get(key)?;
        let left = last.until.checked_duration_since(Instant::now())?;
        (last.hash == hash).then(|| {
            StreamOutcome::Error(format!(
                "the pipeline runner did not answer the last change of this stream ({}); the \
                 Portal sends it again in {} s",
                last.reason,
                left.as_secs().max(1)
            ))
        })
    }

    /// Records a PUT the runner did not answer and says when the next one goes out: the wait
    /// doubles while the same render keeps missing, and starts over for a new one.
    fn back_off(&self, key: (String, String), hash: u64, reason: String) -> StreamOutcome {
        let wait = self
            .backoff
            .lock()
            .ok()
            .and_then(|backoff| {
                backoff
                    .get(&key)
                    .filter(|last| last.hash == hash)
                    .map(|last| last.wait)
            })
            .map_or(BACKOFF_START, |last| (last * 2).min(BACKOFF_CEILING));
        tracing::warn!(
            project = %key.0,
            pipeline = %key.1,
            wait_secs = wait.as_secs(),
            %reason,
            "the pipeline runner did not answer the stream's PUT; waiting before the next one"
        );
        let said = format!(
            "the pipeline runner did not answer: {reason}; the Portal sends it again in {} s",
            wait.as_secs()
        );
        if let Ok(mut backoff) = self.backoff.lock() {
            backoff.insert(
                key,
                Backoff {
                    hash,
                    until: Instant::now() + wait,
                    wait,
                    reason,
                },
            );
        }
        StreamOutcome::Error(said)
    }

    /// DELETE {runner}/streams/{name} for pipelines that were deployed last run and are gone or disabled now.
    pub async fn retire(&self, project: &str, names: &[String]) {
        let Some(runner) = self.runner_for(project) else {
            return;
        };
        for name in names {
            let url = format!("{runner}/streams/{name}");
            match self.http.delete(&url).send().await {
                Ok(resp) => {
                    if !resp.status().is_success()
                        && resp.status() != reqwest::StatusCode::NOT_FOUND
                    {
                        tracing::warn!(
                            project = %project,
                            pipeline = %name,
                            status = %resp.status(),
                            "failed to delete stream from runner"
                        );
                    }
                }
                Err(err) => {
                    tracing::warn!(
                        project = %project,
                        pipeline = %name,
                        error = %err,
                        "failed to delete stream from runner"
                    );
                }
            }
            if let Ok(mut deployed) = self.deployed.lock() {
                deployed.remove(&(project.to_string(), name.clone()));
            }
            if let Ok(mut rendered) = self.rendered.lock() {
                rendered.remove(&(project.to_string(), name.clone()));
            }
            if let Ok(mut backoff) = self.backoff.lock() {
                backoff.remove(&(project.to_string(), name.clone()));
            }
        }
    }

    /// What the runner holds for one project, each with whether it is still running, or `None`
    /// when it gave no list.
    ///
    /// A body without the `active` flag counts as running, because a runner whose answer this does
    /// not understand must not have all of its streams restarted on every pass.
    async fn running(&self, project: &str) -> Option<HashMap<String, bool>> {
        let runner = self.runner_for(project)?;
        let url = format!("{runner}/streams");
        let response = self.http.get(&url).send().await.ok()?;
        if !response.status().is_success() {
            return None;
        }
        let streams: HashMap<String, Value> = response.json().await.ok()?;
        Some(
            streams
                .into_iter()
                .map(|(name, state)| {
                    let alive = state.get("active").and_then(Value::as_bool).unwrap_or(true);
                    (name, alive)
                })
                .collect(),
        )
    }

    /// PUTs (or, for a stream the runner does not hold, POSTs) one stream: the runner's answer,
    /// or `Err` with what the transport said when the runner did not answer at all.
    async fn deploy_stream(
        &self,
        project: &str,
        name: &str,
        stream_json: &Value,
    ) -> Result<StreamOutcome, String> {
        let Some(runner) = self.runner_for(project) else {
            return Ok(StreamOutcome::Error(format!(
                "`{project}` is not a project name"
            )));
        };
        let url = format!("{runner}/streams/{name}");

        let mut response = self
            .http
            .put(&url)
            .json(stream_json)
            .send()
            .await
            .map_err(|err| err.to_string())?;

        if response.status() == reqwest::StatusCode::NOT_FOUND {
            response = self
                .http
                .post(&url)
                .json(stream_json)
                .send()
                .await
                .map_err(|err| err.to_string())?;
        }

        let status = response.status();
        if status.is_success() {
            Ok(StreamOutcome::Live)
        } else {
            let body = response.text().await.unwrap_or_default();
            let truncated = truncate_body(&body, 500);
            Ok(StreamOutcome::Error(format!(
                "runner answered {status}: {truncated}"
            )))
        }
    }
}

/// Renders a native Bento stream configuration for an approved DataSource pipeline.
///
/// `bento` is the author's `bento.yaml` beside the manifest, used when the pipeline has no
/// inline `compute` (PL-03).
#[allow(clippy::too_many_arguments)]
pub fn render_stream(
    pipeline: &PipelineSpec,
    name: &str,
    project: &str,
    source: &DataSourceSpec,
    source_name: &str,
    slug: &str,
    bento: Option<&str>,
) -> Result<Value, RenderError> {
    let (input, mut processors) = datasource_input(pipeline, name, project, source, source_name)?;

    match (first_compute(pipeline).as_ref(), bento) {
        (Some(compute), _) => {
            if compute.kind != ComputeKind::Bloblang {
                return Err(RenderError::MissingCompute);
            }
            if let Some(bloblang) = compute.bloblang.as_deref().filter(|b| !b.trim().is_empty()) {
                processors.push(serde_json::json!({
                    "mapping": bloblang
                }));
            }
        }
        (None, Some(bento)) => processors.extend(bento_processors(bento)?),
        (None, None) => {}
    }

    processors.extend(batching());

    let output = gateway_output(project, slug);

    // T-1125, PL-24: Bento reports its counters under the component's `label`, so an unlabelled
    // stream can only be read as one total. Labelling the input, the output and each processor
    // by its place is what lets the studio say which node a message stopped at. The labels are
    // the stream's own and never leave it, so they carry no name a caller chose.
    Ok(serde_json::json!({
        "input": labelled(input, "input"),
        "pipeline": {
            "processors": processors
                .into_iter()
                .enumerate()
                .map(|(at, processor)| labelled(processor, &format!("processor_{at}")))
                .collect::<Vec<_>>()
        },
        "output": labelled(output, "output")
    }))
}

/// One Bento component with a `label`, so its counters are attributable (PL-24, T-1125).
///
/// A component that already carries one keeps it: a label the author wrote is theirs, and the
/// metrics they read elsewhere are named by it. Anything that is not a map is returned as it
/// came, because only a map can carry the key.
fn labelled(component: serde_json::Value, label: &str) -> serde_json::Value {
    let mut component = component;
    match component.as_object_mut() {
        Some(fields) if !fields.contains_key("label") => {
            fields.insert("label".to_owned(), serde_json::json!(label));
            component
        }
        _ => component,
    }
}

/// The author's processors from a `bento.yaml`. Its `input` is refused, the DataSource is the
/// input (PL-39); its `output` and everything else at the top level are dropped: every stream
/// writes through the endpoint upsert rendered here (PL-16), never back to a caller (PL-06), and
/// the runner's own resources (rate limits, caches) come from its resources file.
fn bento_processors(bento: &str) -> Result<Vec<Value>, RenderError> {
    let config: Value =
        serde_yaml_ng::from_str(bento).map_err(|e| RenderError::Bento(e.to_string()))?;
    if config.get("input").is_some() {
        return Err(RenderError::BentoInput);
    }
    let processors = config
        .pointer("/pipeline/processors")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    // The author's processors pass the check a manifest's steps pass (PL-16, PL-50, PL-52): a
    // name the platform runs, no refused processor nested inside, no read of the runner's
    // environment. This is where an author's file meets the runner, which holds every
    // project's credentials.
    for processor in &processors {
        jc_core::kinds::pipeline::validate_processor("pipeline.processors", processor)
            .map_err(|e| RenderError::Bento(e.to_string()))?;
    }
    Ok(processors)
}

/// One query component, percent-encoded: the unreserved characters and `:` (every URN is full of
/// them) stay, every other UTF-8 byte becomes `%XX`. The runner reads `${...}` inside a URL as
/// its own interpolation, so `$`, `{`, `}` and `!` must never reach it as written (T-2542).
fn percent_encode(val: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(val.len());
    for b in val.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~' | b':') {
            out.push(char::from(b));
        } else {
            out.push('%');
            out.push(char::from(HEX[usize::from(b >> 4)]));
            out.push(char::from(HEX[usize::from(b & 0x0F)]));
        }
    }
    out
}

/// Builds the Context Gateway entity query URL for an endpoint-sourced pipeline (PL-31).
///
/// Every value is encoded on its own; the commas between ids and between attribute names are
/// the list separators the gateway splits on, so an attribute name that holds one is refused.
pub fn endpoint_source_url(
    source_slug: &str,
    query: &jc_core::kinds::pipeline::SourceQuery,
) -> Result<String, RenderError> {
    fn list<'a>(values: impl Iterator<Item = &'a str>) -> String {
        values.map(percent_encode).collect::<Vec<_>>().join(",")
    }

    let mut params = Vec::new();
    if !query.ids.is_empty() {
        let ids = query
            .ids
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        params.push(format!("id={}", list(ids.iter().map(String::as_str))));
    } else if let Some(entity_type) = &query.entity_type {
        params.push(format!("type={}", percent_encode(entity_type)));
    }

    if let Some(attr) = query.attrs.iter().find(|a| a.contains(',')) {
        return Err(RenderError::Custom(format!(
            "spec.source.query.attrs names {attr:?}, and a comma separates attribute names, so it would be read as two"
        )));
    }
    if !query.attrs.is_empty() {
        params.push(format!(
            "attrs={}",
            list(query.attrs.iter().map(String::as_str))
        ));
    }

    params.push("limit=1000".to_string());

    for (name, value) in [
        ("q", &query.q),
        ("scopeQ", &query.scope_q),
        ("geoQ", &query.geo_q),
    ] {
        if let Some(value) = value.as_deref().filter(|v| !v.is_empty()) {
            params.push(format!("{name}={}", percent_encode(value)));
        }
    }

    let query_str = params.join("&");
    Ok(format!(
        "${{JC_GATEWAY_URL}}/api/endpoint/{source_slug}/ngsi-ld/v1/entities?{query_str}"
    ))
}

/// The runner's shared cache in which an on-change stream keeps the hash of the last page it
/// passed (PL-51); declared beside the runner's other shared resources.
pub const CHANGE_CACHE: &str = "pipeline_changes";
/// How often an on-change stream looks at its source when the pipeline names no period.
const CHANGE_POLL: &str = "10s";
/// The shortest look an on-change stream takes: a period under it is raised to it.
const CHANGE_POLL_FLOOR: Duration = Duration::from_secs(5);

/// `10s`, `2m`, `500ms`, `1h` as a duration; anything else is not one.
fn duration_of(text: &str) -> Option<Duration> {
    let text = text.trim();
    let split = text.find(|c: char| !c.is_ascii_digit())?;
    let (number, unit) = text.split_at(split);
    let number: u64 = number.parse().ok()?;
    match unit {
        "ms" => Some(Duration::from_millis(number)),
        "s" => Some(Duration::from_secs(number)),
        "m" => Some(Duration::from_secs(number * 60)),
        "h" => Some(Duration::from_secs(number * 3600)),
        _ => None,
    }
}

/// The processors that pass a source page on only when a watched value changed since the page
/// the stream last passed (PL-51): the hash of every entity's id and watched values goes to the
/// message's metadata, the last hash comes out of the shared cache (a first run misses it, and
/// `catch` clears that miss), an equal hash drops the page, and a new one is stored before the
/// compute sees the page. Unlike a `dedupe`, a value that returns to an earlier one passes.
fn change_gate(stream_key: &str, watched: &[String]) -> Vec<Value> {
    let values = if watched.is_empty() {
        "e".to_owned()
    } else {
        watched
            .iter()
            .map(|attr| {
                let path = Value::String(format!("{attr}.value")).to_string();
                format!("e.get({path})")
            })
            .collect::<Vec<_>>()
            .join(", ")
    };
    vec![
        serde_json::json!({
            "mutation": format!(
                "meta jc_change = (if this.type() == \"array\" {{ this }} else {{ [this] }}).map_each(e -> [e.id, {values}]).format_json().string().hash(\"xxhash64\").encode(\"hex\")"
            )
        }),
        serde_json::json!({
            "branch": {
                "request_map": "root = \"\"",
                "processors": [{
                    "cache": { "resource": CHANGE_CACHE, "operator": "get", "key": stream_key }
                }],
                "result_map": "meta jc_last = this"
            }
        }),
        serde_json::json!({ "catch": [] }),
        serde_json::json!({ "mutation": "root = if @jc_last == @jc_change { deleted() }" }),
        serde_json::json!({
            "cache": {
                "resource": CHANGE_CACHE,
                "operator": "set",
                "key": stream_key,
                "value": "\"${! @jc_change }\""
            }
        }),
    ]
}

/// Renders a native Bento stream configuration for an endpoint-sourced pipeline (PL-31, PL-45):
/// on its clock, or, with `source.trigger.subscription`, on every change of a watched value
/// (PL-51). `stream_key` names the stream in the runner's shared change cache.
pub fn render_endpoint_stream(
    pipeline: &PipelineSpec,
    project: &str,
    stream_key: &str,
    source_slug: &str,
    source_is_public: bool,
    target_slug: &str,
) -> Result<Value, RenderError> {
    let source = pipeline.sources().into_iter().next();
    let (input, mut processors) = endpoint_input(
        pipeline,
        project,
        source.as_ref(),
        stream_key,
        source_slug,
        source_is_public,
    )?;

    let bloblang = first_compute(pipeline)
        .and_then(|c| c.bloblang)
        .filter(|b| !b.trim().is_empty())
        .ok_or(RenderError::MissingCompute)?;

    processors.push(serde_json::json!({
        "mapping": bloblang
    }));

    processors.extend(batching());

    let output = gateway_output(project, target_slug);

    Ok(serde_json::json!({
        "input": input,
        "pipeline": {
            "processors": processors
        },
        "output": output
    }))
}

/// The first compute step of either shape (PL-54): `v1alpha1`'s `compute`.
fn first_compute(pipeline: &PipelineSpec) -> Option<Compute> {
    pipeline.steps().into_iter().find_map(|step| match step {
        Step::Compute(compute) => Some(compute),
        Step::Processor(_) => None,
    })
}

/// What turns a page into gateway-sized batches: one entity per message, 1000 per request.
///
/// The gateway takes at most 1000 entities per batch operation; a page of 4000 stations goes
/// out as four requests, not one 400.
fn batching() -> Vec<Value> {
    vec![
        serde_json::json!({
            "mapping": "root = if this.type() == \"array\" { this } else { [this] }"
        }),
        serde_json::json!({ "unarchive": { "format": "json_array" } }),
        serde_json::json!({ "split": { "size": 1000 } }),
        serde_json::json!({ "archive": { "format": "json_array" } }),
    ]
}

/// A DataSource's input and the processors that belong to it (PL-47, PL-50): an `http`
/// DataSource polls on a `generate` clock through the `http` processor, because Bento's
/// `http_client` input polls without pause.
fn datasource_input(
    pipeline: &PipelineSpec,
    name: &str,
    project: &str,
    source: &DataSourceSpec,
    source_name: &str,
) -> Result<(Value, Vec<Value>), RenderError> {
    check_class(pipeline, source).map_err(|e| RenderError::Class(e.to_string()))?;

    let context = InputContext {
        source: source_name,
        project,
        pipeline: name,
        pipeline_spec: Some(pipeline),
    };
    let input_yaml = jcctl::bento::input_of(source, &context);
    let input_json: Value = serde_json::to_value(&input_yaml)?;

    let (input, mut processors) = if matches!(source.source_type, DataSourceType::Http) {
        let interval = pipeline.period.as_deref().unwrap_or("60s");
        let http_client = match input_json {
            Value::Object(mut map) => map
                .remove("http_client")
                .unwrap_or_else(|| serde_json::json!({})),
            _ => serde_json::json!({}),
        };
        let p1 = serde_json::json!({
            "try": [{
                "http": http_client
            }]
        });
        let p2 = serde_json::json!({
            "mutation": "root = if errored() { deleted() }"
        });
        // Each tick is one run of the pipeline's log (PL-62).
        let inp = serde_json::json!({
            "generate": {
                "interval": interval,
                "mapping": format!("root = \"\"\n{}", crate::pipeline_log::TICK)
            }
        });
        (inp, vec![p1, p2])
    } else {
        (input_json, Vec::new())
    };

    for p in jcctl::bento::prepended_processors(source) {
        processors.push(serde_json::to_value(&p)?);
    }
    Ok((input, processors))
}

/// An Endpoint source's input and processors (PL-31, PL-51): a clock, the read, and with a
/// subscription trigger the change gate keyed by `stream_key`.
fn endpoint_input(
    pipeline: &PipelineSpec,
    project: &str,
    source: Option<&PipelineSource>,
    stream_key: &str,
    source_slug: &str,
    source_is_public: bool,
) -> Result<(Value, Vec<Value>), RenderError> {
    let query = source
        .and_then(|s| s.query.as_ref())
        .ok_or_else(|| RenderError::Custom("endpoint pipeline missing query".to_string()))?;
    let trigger = source.and_then(|s| s.trigger.as_ref());

    fn non_empty(v: &Option<String>) -> Option<&str> {
        v.as_deref().filter(|s| !s.trim().is_empty())
    }
    let interval = match trigger {
        Some(_) => match non_empty(&pipeline.period) {
            Some(period) => match duration_of(period) {
                Some(d) if d < CHANGE_POLL_FLOOR => {
                    format!("{}s", CHANGE_POLL_FLOOR.as_secs())
                }
                Some(_) => period.to_owned(),
                None => CHANGE_POLL.to_owned(),
            },
            None => CHANGE_POLL.to_owned(),
        },
        None => non_empty(&pipeline.period)
            .or_else(|| non_empty(&pipeline.schedule))
            .unwrap_or("60s")
            .to_owned(),
    };

    // A page the change gate hashes carries the watched attributes, whatever the query names.
    let mut query = query.clone();
    let watched: Vec<String> = match trigger {
        Some(trigger) if !trigger.subscription.watched_attributes.is_empty() => {
            trigger.subscription.watched_attributes.clone()
        }
        Some(_) => query.attrs.clone(),
        None => Vec::new(),
    };
    if !query.attrs.is_empty() {
        for attr in &watched {
            if !query.attrs.contains(attr) {
                query.attrs.push(attr.clone());
            }
        }
    }
    let source_url = endpoint_source_url(source_slug, &query)?;

    let input = serde_json::json!({
        "generate": {
            "interval": interval,
            "mapping": "root = \"\""
        }
    });

    // A public endpoint serves the public grant and expects no credential; the runner's token
    // is minted for the endpoints its ServiceAccount is bound to, and the gateway answers 401
    // to a token whose audience is another endpoint's slug — so sending one where none is
    // wanted is how a Live pipeline reads nothing (EP-27, PL-45, T-0914).
    let mut read = serde_json::json!({
        "url": source_url,
        "verb": "GET",
        "headers": {
            "Accept": "application/json"
        },
        "timeout": "30s"
    });
    if !source_is_public {
        read["oauth2"] = pipeline_oauth2(project);
    }
    let p1 = serde_json::json!({ "try": [{ "http": read }] });
    let p2 = serde_json::json!({
        "mutation": "root = if errored() { deleted() }"
    });

    let mut processors = vec![p1, p2];
    if trigger.is_some() {
        processors.extend(change_gate(stream_key, &watched));
    }
    Ok((input, processors))
}

/// Looks one source up in the mirror: its DataSource, or its Endpoint's slug and audience.
/// Writes each source Endpoint's space segment into the rendered stream (PL-57, PF-84).
///
/// The companion of `jcctl::bento::inject_space`, which does the same for the spaces a pipeline
/// writes. `JC_SOURCE_SPACE` is the first source, `JC_SOURCE_SPACE_2` the second, and a variable
/// with no source behind it is left alone rather than rendered as an empty segment: a mapping
/// then still says `env("JC_SOURCE_SPACE")`, which is a stream the runner refuses out loud,
/// instead of minting a URN with a hole in it that every write is refused for one by one.
fn inject_source_space(value: &mut Value, segments: &[String]) {
    match value {
        Value::String(text) => {
            if !text.contains("JC_SOURCE_SPACE") {
                return;
            }
            // Longest name first, so `JC_SOURCE_SPACE` never rewrites the head of
            // `JC_SOURCE_SPACE_2`.
            for (index, segment) in segments.iter().enumerate().rev() {
                if segment.is_empty() {
                    continue;
                }
                let var = if index == 0 {
                    "JC_SOURCE_SPACE".to_owned()
                } else {
                    format!("JC_SOURCE_SPACE_{}", index + 1)
                };
                *text = text
                    .replace(&format!("env(\"{var}\")"), &format!("\"{segment}\""))
                    .replace(&format!("${{{var}}}"), segment);
            }
        }
        Value::Array(items) => items
            .iter_mut()
            .for_each(|item| inject_source_space(item, segments)),
        Value::Object(map) => map
            .values_mut()
            .for_each(|item| inject_source_space(item, segments)),
        _ => {}
    }
}

fn resolve_source(
    mirror: &Mirror,
    ns: &str,
    source: PipelineSource,
) -> Result<ResolvedSource, String> {
    if let Some(reference) = &source.data_source_ref {
        let ds_name = reference.name().to_owned();
        let ds_env = mirror
            .get(ns, "DataSource", &ds_name)
            .ok_or_else(|| format!("data source {ds_name} is not in the mirror"))?;
        let spec: DataSourceSpec = serde_json::from_value(ds_env.spec.clone())
            .map_err(|err| format!("invalid data source spec: {err}"))?;
        return Ok(ResolvedSource::Data {
            spec: Box::new(spec),
            name: ds_name,
        });
    }
    let ep_name = source
        .endpoint_ref
        .as_ref()
        .map(|r| r.name().to_owned())
        .ok_or_else(|| "a source names neither a DataSource nor an Endpoint".to_owned())?;
    let ep_env = mirror
        .get(ns, "Endpoint", &ep_name)
        .ok_or_else(|| format!("source endpoint {ep_name} is not in the mirror"))?;
    let slug = ep_env
        .spec
        .get("slug")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("source endpoint {ep_name} has no slug"))?
        .to_owned();
    let public = ep_env
        .spec
        .get("audience")
        .and_then(Value::as_str)
        .is_none_or(|audience| audience == "public");
    Ok(ResolvedSource::Endpoint {
        source: Box::new(source),
        slug,
        public,
    })
}

/// One source of a pipeline, resolved from the mirror for [`render_merged`].
pub enum ResolvedSource {
    /// A DataSource of the project, by name.
    Data {
        /// Its spec.
        spec: Box<DataSourceSpec>,
        /// Its name.
        name: String,
    },
    /// An Endpoint read with a query (PL-31).
    Endpoint {
        /// The pipeline's source entry, with its query and trigger.
        source: Box<PipelineSource>,
        /// The endpoint's slug.
        slug: String,
        /// Whether the endpoint serves the public grant (no token sent).
        public: bool,
    },
}

/// Whether a pipeline needs the general renderer (PL-53): more than one source or output, a
/// processor step, or more than one step. Everything else renders through [`render_stream`]
/// or [`render_endpoint_stream`], so a `v1alpha1` pipeline renders the bytes it always did.
pub fn is_merged(spec: &PipelineSpec) -> bool {
    let steps = spec.steps();
    spec.sources().len() > 1
        || spec.outputs().len() > 1
        || steps.len() > 1
        || steps.iter().any(|step| matches!(step, Step::Processor(_)))
}

/// Renders a `v1alpha2` pipeline of several sources, steps or outputs as one stream (PL-53):
/// a `broker` input over the sources, each with the processors its own input needs; the
/// steps in order; the batching; one output, or a `broker` output fanning out to every one.
pub fn render_merged(
    pipeline: &PipelineSpec,
    name: &str,
    project: &str,
    sources: &[ResolvedSource],
    target_slugs: &[String],
) -> Result<Value, RenderError> {
    let mut inputs = Vec::with_capacity(sources.len());
    for (at, source) in sources.iter().enumerate() {
        let (input, processors) = match source {
            ResolvedSource::Data {
                spec,
                name: source_name,
            } => datasource_input(pipeline, name, project, spec, source_name)?,
            ResolvedSource::Endpoint {
                source,
                slug,
                public,
            } => endpoint_input(
                pipeline,
                project,
                Some(source),
                &format!("{project}/{name}#{at}"),
                slug,
                *public,
            )?,
        };
        inputs.push(with_processors(input, processors));
    }
    let input = match inputs.len() {
        0 => {
            return Err(RenderError::Custom(
                "a pipeline reads at least one source".to_owned(),
            ))
        }
        1 => inputs.remove(0),
        _ => serde_json::json!({ "broker": { "inputs": inputs } }),
    };

    let mut processors = Vec::new();
    for step in pipeline.steps() {
        match step {
            Step::Processor(step) => processors.push(serde_json::to_value(&step.processor)?),
            Step::Compute(compute) => {
                if compute.kind != ComputeKind::Bloblang {
                    return Err(RenderError::MissingCompute);
                }
                if let Some(bloblang) = compute.bloblang.filter(|b| !b.trim().is_empty()) {
                    processors.push(serde_json::json!({ "mapping": bloblang }));
                }
            }
        }
    }
    processors.extend(batching());

    let mut outputs: Vec<Value> = target_slugs
        .iter()
        .map(|slug| gateway_output(project, slug))
        .collect();
    let output = match outputs.len() {
        0 => {
            return Err(RenderError::Custom(
                "a pipeline writes through at least one output".to_owned(),
            ))
        }
        1 => outputs.remove(0),
        // Fail fast (PL-53, T-2983): a write that fails after its own retries is nacked back to
        // the input, which replays it to every output, each an idempotent upsert. Plain
        // `fan_out` retries it inside the broker without heeding a stop.
        _ => {
            serde_json::json!({ "broker": { "pattern": "fan_out_fail_fast", "outputs": outputs } })
        }
    };

    Ok(serde_json::json!({
        "input": labelled(input, "input"),
        "pipeline": {
            "processors": processors
                .into_iter()
                .enumerate()
                .map(|(at, processor)| labelled(processor, &format!("processor_{at}")))
                .collect::<Vec<_>>()
        },
        "output": labelled(output, "output")
    }))
}

/// A Bento input with the processors that belong to it alone, as every Bento input carries them.
fn with_processors(input: Value, processors: Vec<Value>) -> Value {
    let mut input = input;
    if let (Some(fields), false) = (input.as_object_mut(), processors.is_empty()) {
        fields.insert("processors".to_owned(), Value::Array(processors));
    }
    input
}

/// Whether a rendered input is one that ends on its own (PL-04, PL-50, T-2336).
///
/// A file, an object store or a `select` reads what is there and finishes, so a stream on one of
/// them is done and not dead when the runner reports it inactive. A clock, a socket and a broker
/// never finish, so an inactive stream on one of those died. A broker of several inputs ends only
/// when every one of them does.
fn input_ends_by_itself(input: &Value) -> bool {
    if let Some(inputs) = input.get("broker").and_then(|b| b.get("inputs")) {
        return inputs
            .as_array()
            .is_some_and(|inputs| !inputs.is_empty() && inputs.iter().all(input_ends_by_itself));
    }
    let Some(kind) = input.as_object().and_then(|fields| {
        fields
            .keys()
            .map(String::as_str)
            .find(|key| !matches!(*key, "label" | "processors"))
    }) else {
        return false;
    };
    // A clock is in the terminating list because a `count` makes it finite; the clock every
    // pipeline here is rendered with has no count, and an unbounded one ticks forever.
    if kind == "generate" {
        return input["generate"]
            .get("count")
            .and_then(Value::as_u64)
            .is_some_and(|count| count > 0);
    }
    jc_core::kinds::bento_inputs::TERMINATING.contains(&kind)
}

/// Checks whether a pipeline is eligible for deployment into the runner as a resident stream.
pub fn eligible(spec: &PipelineSpec) -> bool {
    if !spec.enabled {
        return false;
    }
    let steps = spec.steps();
    // A stream runs Bloblang and runner processors; `mapping`, `wasm` and `container` compute
    // run elsewhere (PL-33).
    if !steps.iter().all(|step| match step {
        Step::Processor(_) => true,
        Step::Compute(c) => c.kind == ComputeKind::Bloblang,
    }) {
        return false;
    }
    let maps = steps.iter().any(|step| match step {
        Step::Processor(_) => true,
        Step::Compute(c) => c.bloblang.as_ref().is_some_and(|b| !b.trim().is_empty()),
    });
    let sources = spec.sources();
    !sources.is_empty()
        && sources.iter().all(|source| {
            source.data_source_ref.is_some()
                || (source.endpoint_ref.is_some() && source.query.is_some() && maps)
        })
}

/// Returns whether `spec` is configured to read an external DataSource.
pub fn is_data_source_pipeline(spec: &PipelineSpec) -> bool {
    spec.sources()
        .iter()
        .any(|source| source.data_source_ref.is_some())
}

/// Returns whether `spec` is configured as a stream pipeline (DataSource or Endpoint-sourced).
pub fn is_stream_pipeline(spec: &PipelineSpec) -> bool {
    spec.sources().iter().any(|source| {
        source.data_source_ref.is_some()
            || (source.endpoint_ref.is_some() && source.query.is_some())
    })
}

/// One `StreamDeployed` condition with the runner's word on why.
pub fn make_condition(
    condition_type: &str,
    status: &str,
    reason: &str,
    message: &str,
) -> Condition {
    Condition {
        r#type: condition_type.to_string(),
        status: status.to_string(),
        reason: Some(reason.to_string()),
        message: Some(message.to_string()),
        last_transition_time: Some(chrono::Utc::now()),
    }
}

fn truncate_body(s: &str, max_len: usize) -> String {
    if s.len() <= max_len {
        s.to_string()
    } else {
        let mut end = max_len;
        while !s.is_char_boundary(end) && end > 0 {
            end -= 1;
        }
        format!("{}...", &s[..end])
    }
}

/// The `ServiceAccount` every project's streams run as. Derived, not configured: a Pipeline
/// names no account, and the seeds declare `pipelines` in each project that has one.
/// ponytail: one account per project; a `spec.serviceAccountRef` on Pipeline is the upgrade.
pub(crate) const PIPELINE_ACCOUNT: &str = "pipelines";

/// The runner environment variable that holds one project's pipeline client secret:
/// `banskabystrica` becomes `JC_CLIENT_SECRET_BANSKABYSTRICA`. A project name is a DNS-1123
/// label, so the only character to translate is the hyphen.
fn client_secret_var(project: &str) -> String {
    let mut name = String::from("JC_CLIENT_SECRET_");
    for ch in project.chars() {
        name.push(if ch.is_ascii_alphanumeric() {
            ch.to_ascii_uppercase()
        } else {
            '_'
        });
    }
    name
}

/// The credential a stream presents, on the read of a private source and on every write: its
/// own project's `pipelines` ServiceAccount (PF-46, AG-52).
///
/// One runner-wide `${JC_CLIENT_ID}` used to stand here, so every stream of every project
/// presented Helsinki's client and the gateway refused each write to another project's endpoint
/// with `token is not bound to this resource` — about 1900 refusals in 45 minutes on dev
/// (T-2384). The client id is `jc_core`'s derived `{project}-{account}` and is an `azp`, not a
/// secret, so it is written into the stream; the secret is never written, the stream names the
/// environment variable the deployment resolves from that client's Secret.
pub(crate) fn pipeline_oauth2(project: &str) -> serde_json::Value {
    serde_json::json!({
        "enabled": true,
        "client_key": jc_core::kinds::service_account::keycloak_client_id(project, PIPELINE_ACCOUNT),
        "client_secret": format!("${{{}}}", client_secret_var(project)),
        "token_url": "${JC_TOKEN_URL}"
    })
}

/// Where every stream writes: the endpoint's batch upsert, as the pipeline's service account.
/// It is the one output a stream has, so no pipeline answers a caller: a client-facing API is
/// the Context Gateway's (PL-06, EP-05).
///
/// An answer no retry can fix (a malformed entity, a batch too large) drops the batch and counts
/// it under the output's label instead of retrying it for good, which stalled the messages behind
/// it and flooded the gateway's log (T-1465). A token, a policy or the gateway can recover, so
/// 401, 403, 429 and 5xx stay retried.
/// ponytail: the whole batch drops with its one bad entity; per-entity 207 handling is the upgrade.
pub(crate) fn gateway_output(project: &str, slug: &str) -> serde_json::Value {
    serde_json::json!({
        "http_client": {
            "url": format!("${{JC_GATEWAY_URL}}/api/endpoint/{slug}/ngsi-ld/v1/entityOperations/upsert?options=update"),
            "verb": "POST",
            "headers": {
                "Content-Type": "application/json"
            },
            "oauth2": pipeline_oauth2(project),
            "timeout": "30s",
            "rate_limit": "pipeline_egress",
            "drop_on": [400, 413, 422]
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resource::{ObjectMeta, ResourceEnvelope, API_VERSION};

    fn helsinki_pipeline_spec() -> PipelineSpec {
        serde_json::from_value(serde_json::json!({
            "class": "auto",
            "period": "60s",
            "source": {
                "dataSourceRef": {
                    "kind": "DataSource",
                    "name": "hsl-citybikes-free"
                }
            },
            "compute": {
                "kind": "bloblang",
                "bloblang": "root = this.data.bikes"
            },
            "targetEndpoint": "urn:ngsi-ld:Endpoint:example.org:helsinki:helsinki-all"
        }))
        .expect("valid PipelineSpec")
    }

    fn helsinki_datasource_spec() -> DataSourceSpec {
        serde_json::from_value(serde_json::json!({
            "type": "http",
            "http": {
                "url": "https://gbfs.theta.fifteen.eu/gbfs/2.2/helsinki/en/station_status.json",
                "timeout": "15s"
            }
        }))
        .expect("valid DataSourceSpec")
    }

    fn helsinki_test_mirror() -> Mirror {
        let mirror = Mirror::new();
        let ds = serde_json::json!({
            "type": "http",
            "http": {
                "url": "https://gbfs.theta.fifteen.eu/gbfs/2.2/helsinki/en/station_status.json",
                "timeout": "15s"
            }
        });
        mirror.upsert(ResourceEnvelope {
            api_version: API_VERSION.to_string(),
            kind: "DataSource".to_string(),
            metadata: ObjectMeta {
                name: "hsl-citybikes-free".to_string(),
                namespace: Some("helsinki".to_string()),
                ..Default::default()
            },
            spec: ds,
            status: None,
        });

        let ep = serde_json::json!({
            "contextSpaceRef": "helsinki",
            "slug": "abc123456789012345678901234",
            "audience": "public",
            "enabledRepresentations": ["ngsi-ld"]
        });
        mirror.upsert(ResourceEnvelope {
            api_version: API_VERSION.to_string(),
            kind: "Endpoint".to_string(),
            metadata: ObjectMeta {
                name: "helsinki-all".to_string(),
                namespace: Some("helsinki".to_string()),
                ..Default::default()
            },
            spec: ep,
            status: None,
        });

        let pipe = serde_json::json!({
            "class": "auto",
            "period": "60s",
            "source": {
                "dataSourceRef": {
                    "kind": "DataSource",
                    "name": "hsl-citybikes-free"
                }
            },
            "compute": {
                "kind": "bloblang",
                "bloblang": "root = this.data.bikes"
            },
            "targetEndpoint": "urn:ngsi-ld:Endpoint:example.org:helsinki:helsinki-all"
        });
        mirror.upsert(ResourceEnvelope {
            api_version: API_VERSION.to_string(),
            kind: "Pipeline".to_string(),
            metadata: ObjectMeta {
                name: "citybikes-free".to_string(),
                namespace: Some("helsinki".to_string()),
                ..Default::default()
            },
            spec: pipe,
            status: None,
        });

        mirror
    }

    /// PF-46, AG-52, T-2384: a stream presents its own project's ServiceAccount, on the write
    /// and on the read of a private source, and never another project's.
    ///
    /// One runner-wide client stood here before, so every Banská Bystrica write carried
    /// Helsinki's token and the gateway refused it with `token is not bound to this resource`.
    /// The client id is an `azp` and is written out; the secret never is — the stream names the
    /// environment variable the deployment resolves from that client's Secret.
    #[test]
    fn a_stream_carries_its_own_projects_client_and_no_other() {
        for (project, client, secret) in [
            (
                "helsinki",
                "helsinki-pipelines",
                "${JC_CLIENT_SECRET_HELSINKI}",
            ),
            (
                "banskabystrica",
                "banskabystrica-pipelines",
                "${JC_CLIENT_SECRET_BANSKABYSTRICA}",
            ),
            ("bbsk", "bbsk-pipelines", "${JC_CLIENT_SECRET_BBSK}"),
            (
                "helsinki-mobility",
                "helsinki-mobility-pipelines",
                "${JC_CLIENT_SECRET_HELSINKI_MOBILITY}",
            ),
        ] {
            // The write of a stream that reads a DataSource.
            let rendered = render_stream(
                &helsinki_pipeline_spec(),
                "citybikes-free",
                project,
                &helsinki_datasource_spec(),
                "hsl-citybikes-free",
                "target_slug_456",
                None,
            )
            .expect("rendered stream");
            let oauth2 = &rendered["output"]["http_client"]["oauth2"];
            assert_eq!(oauth2["client_key"], client, "{project} write");
            assert_eq!(oauth2["client_secret"], secret, "{project} write");
            assert_eq!(oauth2["enabled"], true, "{project} write");

            // The read of a private source endpoint, and the write beside it.
            let rendered = render_endpoint_stream(
                &endpoint_pipeline_spec(Some("AirQualityObserved"), Vec::new(), Some("15m"), None),
                project,
                &format!("{project}/kpi"),
                "source_slug_123",
                false,
                "target_slug_456",
            )
            .expect("rendered endpoint stream");
            let read = &rendered["pipeline"]["processors"][0]["try"][0]["http"]["oauth2"];
            assert_eq!(read["client_key"], client, "{project} read");
            assert_eq!(read["client_secret"], secret, "{project} read");
            assert_eq!(
                rendered["output"]["http_client"]["oauth2"]["client_key"], client,
                "{project} write beside the read"
            );

            // No other project's client and no secret value anywhere in the rendered stream:
            // the runner's own API serves this document back (T-2384).
            let whole = serde_json::to_string(&rendered).expect("serialisable");
            for other in [
                "helsinki-pipelines",
                "banskabystrica-pipelines",
                "bbsk-pipelines",
            ] {
                assert_eq!(
                    other == client,
                    whole.contains(other),
                    "{project} rendered {other}"
                );
            }
            assert!(!whole.contains("JC_CLIENT_ID"), "{whole}");
        }
    }

    #[test]
    fn renders_the_static_stream_shape() {
        let pipeline = helsinki_pipeline_spec();
        let ds = helsinki_datasource_spec();

        let rendered = render_stream(
            &pipeline,
            "citybikes-free",
            "helsinki",
            &ds,
            "hsl-citybikes-free",
            "abc123",
            None,
        )
        .expect("rendered stream");

        assert_eq!(rendered["input"]["generate"]["interval"], "60s");
        assert_eq!(
            rendered["pipeline"]["processors"][0]["try"][0]["http"]["url"],
            "https://gbfs.theta.fifteen.eu/gbfs/2.2/helsinki/en/station_status.json"
        );

        let processors = rendered["pipeline"]["processors"]
            .as_array()
            .expect("processors array");
        assert!(processors
            .iter()
            .any(|p| p.get("mapping").and_then(Value::as_str) == Some("root = this.data.bikes")));
        assert!(processors.iter().any(|p| {
            p.get("mapping").and_then(Value::as_str)
                == Some("root = if this.type() == \"array\" { this } else { [this] }")
        }));
        assert!(processors.iter().any(|p| {
            p.get("unarchive")
                .and_then(|u| u.get("format"))
                .and_then(Value::as_str)
                == Some("json_array")
        }));
        assert!(processors.last().unwrap().get("archive").is_some());
        // A batch operation at the gateway takes 1000 entities at most.
        assert_eq!(
            processors[processors.len() - 2]["split"]["size"],
            1000,
            "the batch is split before it is archived"
        );

        assert_eq!(
            rendered["output"]["http_client"]["url"],
            "${JC_GATEWAY_URL}/api/endpoint/abc123/ngsi-ld/v1/entityOperations/upsert?options=update"
        );
        assert_eq!(
            rendered["output"]["http_client"]["oauth2"]["client_secret"],
            "${JC_CLIENT_SECRET_HELSINKI}"
        );

        let json_str = serde_json::to_string(&rendered).unwrap();
        assert!(!json_str.contains("Authorization"));
    }

    #[test]
    fn a_disabled_or_foreign_pipeline_is_not_eligible() {
        let mut spec = helsinki_pipeline_spec();
        assert!(eligible(&spec));

        spec.enabled = false;
        assert!(!eligible(&spec));

        spec.enabled = true;
        spec.source = None;
        assert!(!eligible(&spec));

        let mut spec2 = helsinki_pipeline_spec();
        spec2.compute.as_mut().unwrap().kind = ComputeKind::Wasm;
        assert!(!eligible(&spec2));
    }

    fn endpoint_pipeline_spec(
        type_name: Option<&str>,
        ids: Vec<jc_core::urn::Urn>,
        period: Option<&str>,
        schedule: Option<&str>,
    ) -> PipelineSpec {
        let mut source_json = serde_json::json!({
            "endpointRef": {
                "kind": "Endpoint",
                "name": "helsinki-all"
            },
            "query": {
                "attrs": ["availableBikeNumber"]
            }
        });
        if let Some(t) = type_name {
            source_json["query"]["type"] = serde_json::json!(t);
        }
        if !ids.is_empty() {
            source_json["query"]["ids"] = serde_json::json!(ids);
        }

        let mut pipe_json = serde_json::json!({
            "class": "scheduled",
            "source": source_json,
            "compute": {
                "kind": "bloblang",
                "bloblang": "root = this"
            },
            "targetEndpoint": "urn:ngsi-ld:Endpoint:example.org:helsinki-kpi:kpi-writer"
        });
        if let Some(p) = period {
            pipe_json["period"] = serde_json::json!(p);
        }
        if let Some(s) = schedule {
            pipe_json["schedule"] = serde_json::json!(s);
        }
        serde_json::from_value(pipe_json).expect("valid endpoint PipelineSpec")
    }

    #[test]
    fn endpoint_source_renders_get_url_with_type_and_attrs() {
        let spec =
            endpoint_pipeline_spec(Some("BikeHireDockingStation"), vec![], Some("15m"), None);
        let rendered = render_endpoint_stream(
            &spec,
            "helsinki",
            "helsinki/kpi",
            "source_slug_123",
            true,
            "target_slug_456",
        )
        .expect("rendered endpoint stream");

        assert_eq!(rendered["input"]["generate"]["interval"], "15m");
        let http = &rendered["pipeline"]["processors"][0]["try"][0]["http"];
        assert_eq!(
            http["url"],
            "${JC_GATEWAY_URL}/api/endpoint/source_slug_123/ngsi-ld/v1/entities?type=BikeHireDockingStation&attrs=availableBikeNumber&limit=1000"
        );
        assert_eq!(http["verb"], "GET");
        assert_eq!(http["headers"]["Accept"], "application/json");
        // A public source is read the way anyone reads it: no token, because the runner's
        // token names the endpoints its ServiceAccount is bound to and the gateway answers a
        // token for another slug 401 (T-0914).
        assert!(http["oauth2"].is_null(), "{http}");
        // The write always carries the project's own identity: nothing is written anonymously,
        // and nothing is written with another project's client (T-2384).
        assert_eq!(
            rendered["output"]["http_client"]["oauth2"]["client_key"],
            "helsinki-pipelines"
        );
        assert_eq!(
            rendered["output"]["http_client"]["url"],
            "${JC_GATEWAY_URL}/api/endpoint/target_slug_456/ngsi-ld/v1/entityOperations/upsert?options=update"
        );
    }

    #[test]
    fn a_source_that_is_not_public_is_read_with_the_runners_own_token() {
        let spec =
            endpoint_pipeline_spec(Some("BikeHireDockingStation"), vec![], Some("15m"), None);
        let rendered = render_endpoint_stream(
            &spec,
            "helsinki",
            "helsinki/kpi",
            "source_slug_123",
            false,
            "target_slug_456",
        )
        .expect("rendered endpoint stream");

        let http = &rendered["pipeline"]["processors"][0]["try"][0]["http"];
        assert_eq!(http["oauth2"]["client_key"], "helsinki-pipelines");
        assert_eq!(http["oauth2"]["token_url"], "${JC_TOKEN_URL}");
    }

    #[test]
    fn a_schedule_is_the_clock_and_no_change_gate_is_rendered() {
        let spec = endpoint_pipeline_spec(
            Some("BikeHireDockingStation"),
            vec![],
            None,
            Some("*/15 * * * *"),
        );
        let rendered =
            render_endpoint_stream(&spec, "helsinki", "helsinki/kpi", "src", true, "dst")
                .expect("render");
        assert_eq!(rendered["input"]["generate"]["interval"], "*/15 * * * *");
        let processors = rendered["pipeline"]["processors"]
            .as_array()
            .expect("processors");
        assert!(processors
            .iter()
            .all(|p| p.get("cache").is_none() && p.get("branch").is_none()));
    }

    #[test]
    fn an_on_change_trigger_renders_the_change_gate_before_the_compute() {
        let mut spec = endpoint_pipeline_spec(Some("BikeHireDockingStation"), vec![], None, None);
        spec.source.as_mut().expect("source").trigger = Some(
            serde_json::from_value(serde_json::json!({
                "subscription": { "type": "BikeHireDockingStation", "watchedAttributes": ["availableBikeNumber", "status"] }
            }))
            .expect("trigger"),
        );
        let rendered =
            render_endpoint_stream(&spec, "helsinki", "helsinki/bikes-kpi", "src", true, "dst")
                .expect("render");

        // No period: the source is looked at every ten seconds, with the watched attributes.
        assert_eq!(rendered["input"]["generate"]["interval"], "10s");
        let processors = rendered["pipeline"]["processors"]
            .as_array()
            .expect("processors");
        assert!(processors[0]["try"][0]["http"]["url"]
            .as_str()
            .expect("url")
            .contains("attrs=availableBikeNumber,status&"));
        let hash = processors[2]["mutation"].as_str().expect("the hash");
        assert!(
            hash.contains(r#"e.get("availableBikeNumber.value"), e.get("status.value")"#),
            "{hash}"
        );
        assert_eq!(
            processors[3]["branch"]["processors"][0]["cache"],
            serde_json::json!({ "resource": CHANGE_CACHE, "operator": "get", "key": "helsinki/bikes-kpi" })
        );
        assert_eq!(processors[4], serde_json::json!({ "catch": [] }));
        assert_eq!(
            processors[5]["mutation"],
            "root = if @jc_last == @jc_change { deleted() }"
        );
        assert_eq!(processors[6]["cache"]["operator"], "set");
        assert_eq!(processors[6]["cache"]["key"], "helsinki/bikes-kpi");
        // The compute comes after the gate.
        assert_eq!(processors[7]["mapping"], "root = this");
    }

    #[test]
    fn an_on_change_period_under_five_seconds_is_raised_and_a_longer_one_kept() {
        let trigger: jc_core::kinds::pipeline::Trigger = serde_json::from_value(
            serde_json::json!({ "subscription": { "type": "BikeHireDockingStation" } }),
        )
        .expect("trigger");
        for (period, interval) in [("1s", "5s"), ("500ms", "5s"), ("30s", "30s"), ("2m", "2m")] {
            let mut spec =
                endpoint_pipeline_spec(Some("BikeHireDockingStation"), vec![], Some(period), None);
            spec.source.as_mut().expect("source").trigger = Some(trigger.clone());
            let rendered =
                render_endpoint_stream(&spec, "helsinki", "k", "src", true, "dst").expect("render");
            assert_eq!(
                rendered["input"]["generate"]["interval"], interval,
                "{period}"
            );
            // No watched attributes named: the query's are watched.
            assert!(rendered["pipeline"]["processors"][2]["mutation"]
                .as_str()
                .expect("hash")
                .contains(r#"e.get("availableBikeNumber.value")"#));
        }
    }

    fn source_query(v: serde_json::Value) -> jc_core::kinds::pipeline::SourceQuery {
        serde_json::from_value(v).expect("source query")
    }

    /// The query parameters of a rendered source URL, decoded the way the gateway reads them.
    fn source_parameters(query: serde_json::Value) -> Vec<(String, String)> {
        let rendered = endpoint_source_url("slug", &source_query(query)).expect("rendered");
        let url = url::Url::parse(&rendered.replace("${JC_GATEWAY_URL}", "http://gw"))
            .expect("the rendered URL parses");
        url.query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect()
    }

    // T-2542, PL-31: a filter value is one parameter value, whatever characters it holds.
    #[test]
    fn endpoint_source_query_values_arrive_as_written() {
        let q = "name==\"a&b=c #d+e%f?g\";refPlace==\"Töölö\"";
        let params = source_parameters(serde_json::json!({
            "type": "Bike",
            "q": q,
            "scopeQ": "/hel+sinki/#",
            "geoQ": "georel=near;maxDistance==100&x=1",
        }));
        assert_eq!(
            params,
            vec![
                ("type".to_string(), "Bike".to_string()),
                ("limit".to_string(), "1000".to_string()),
                ("q".to_string(), q.to_string()),
                ("scopeQ".to_string(), "/hel+sinki/#".to_string()),
                (
                    "geoQ".to_string(),
                    "georel=near;maxDistance==100&x=1".to_string()
                ),
            ]
        );
    }

    // T-2542: the runner reads `${...}` in a URL as its own interpolation, so a value that holds
    // one must leave the renderer as plain escaped text.
    #[test]
    fn endpoint_source_values_carry_no_runner_interpolation() {
        let rendered = endpoint_source_url(
            "slug",
            &source_query(serde_json::json!({
                "type": "Bike",
                "attrs": ["a${!env(\"X\")}"],
                "q": "name==\"${JC_TOKEN}\"",
            })),
        )
        .expect("rendered");
        let tail = rendered.trim_start_matches("${JC_GATEWAY_URL}");
        assert!(!tail.contains("${"), "{rendered}");
        assert!(!tail.contains('!'), "{rendered}");
    }

    // T-2542: every attribute name is encoded on its own; the comma between them stays the
    // separator the gateway splits on.
    #[test]
    fn endpoint_source_attrs_are_encoded_one_by_one() {
        let params = source_parameters(serde_json::json!({
            "type": "Bike",
            "attrs": ["speed&limit=1", "https://example.org/ns#weight"],
        }));
        assert_eq!(
            params[1],
            (
                "attrs".to_string(),
                "speed&limit=1,https://example.org/ns#weight".to_string()
            )
        );
        assert_eq!(params.iter().filter(|(k, _)| k == "limit").count(), 1);
    }

    // T-2542: a comma inside one attribute name would be read as two names, so it is refused.
    #[test]
    fn endpoint_source_refuses_a_comma_inside_an_attribute_name() {
        let err = endpoint_source_url(
            "slug",
            &source_query(serde_json::json!({"type": "Bike", "attrs": ["a,b"]})),
        )
        .expect_err("a comma in a name is refused");
        assert!(err.to_string().contains("\"a,b\""), "{err}");
    }

    #[test]
    fn endpoint_source_ids_renders_id_param() {
        let urn: jc_core::urn::Urn = "urn:ngsi-ld:BikeHireDockingStation:hel.fi:h:station-1"
            .parse()
            .expect("urn");
        let spec = endpoint_pipeline_spec(None, vec![urn], None, Some("*/15 * * * *"));
        let rendered = render_endpoint_stream(
            &spec,
            "helsinki",
            "helsinki/kpi",
            "source_slug_123",
            true,
            "target_slug_456",
        )
        .expect("rendered endpoint stream");

        assert_eq!(rendered["input"]["generate"]["interval"], "*/15 * * * *");
        let http = &rendered["pipeline"]["processors"][0]["try"][0]["http"];
        assert_eq!(
            http["url"],
            "${JC_GATEWAY_URL}/api/endpoint/source_slug_123/ngsi-ld/v1/entities?id=urn:ngsi-ld:BikeHireDockingStation:hel.fi:h:station-1&attrs=availableBikeNumber&limit=1000"
        );
        assert!(!http["url"].as_str().unwrap().contains("type="));
    }

    #[test]
    fn datasource_without_compute_renders_without_error() {
        let mut spec = helsinki_pipeline_spec();
        spec.compute = None;
        let ds = helsinki_datasource_spec();
        let rendered = render_stream(
            &spec,
            "citybikes-free",
            "helsinki",
            &ds,
            "hsl-citybikes-free",
            "abc123",
            None,
        )
        .expect("renders without compute");
        let processors = rendered["pipeline"]["processors"].as_array().unwrap();
        assert!(!processors
            .iter()
            .any(|p| p.get("mapping").and_then(Value::as_str) == Some("root = this.data.bikes")));
    }

    const BENTO: &str = r#"
pipeline:
  processors:
    - mapping: root = this.data.stations
    - unarchive:
        format: json_array
output:
  http_client:
    url: https://somewhere.example/authored
"#;

    #[test]
    fn a_write_no_retry_can_fix_is_dropped_and_one_that_can_recover_is_retried() {
        let output = gateway_output("helsinki", "abc");
        let dropped = output["http_client"]["drop_on"]
            .as_array()
            .expect("drop_on");
        assert_eq!(
            dropped,
            &vec![
                serde_json::json!(400),
                serde_json::json!(413),
                serde_json::json!(422)
            ]
        );
        for recoverable in [401, 403, 429, 500, 502, 503] {
            assert!(
                !dropped.contains(&serde_json::json!(recoverable)),
                "{recoverable} is retried"
            );
        }
    }

    #[test]
    fn datasource_with_a_bento_mapping_renders_its_processors_and_the_endpoint_output() {
        let mut spec = helsinki_pipeline_spec();
        spec.compute = None;
        let ds = helsinki_datasource_spec();
        let rendered = render_stream(
            &spec,
            "citybikes-gbfs",
            "helsinki",
            &ds,
            "hsl-citybikes-gbfs",
            "abc123",
            Some(BENTO),
        )
        .expect("renders from bento.yaml");
        let processors = rendered["pipeline"]["processors"].as_array().unwrap();
        // The HTTP poll and its error guard first, the author's two, then the shared tail.
        assert_eq!(processors[2]["mapping"], "root = this.data.stations");
        assert_eq!(processors[3]["unarchive"]["format"], "json_array");
        assert_eq!(processors.len(), 8);
        let url = rendered["output"]["http_client"]["url"].as_str().unwrap();
        assert!(url.contains("/api/endpoint/abc123/"), "{url}");
        assert!(!url.contains("authored"));
    }

    #[test]
    fn a_bento_with_its_own_input_is_refused_and_broken_yaml_names_itself() {
        let mut spec = helsinki_pipeline_spec();
        spec.compute = None;
        let ds = helsinki_datasource_spec();
        let render =
            |bento: &str| render_stream(&spec, "p", "helsinki", &ds, "src", "abc123", Some(bento));
        assert!(matches!(
            render("input:\n  generate: {}\n").unwrap_err(),
            RenderError::BentoInput
        ));
        assert!(matches!(
            render("pipeline: [\n").unwrap_err(),
            RenderError::Bento(_)
        ));
        // An empty file is an author who has not written the mapping yet: the stream still renders.
        assert!(render("").is_ok());
    }

    /// PL-16, PL-50, PL-52 (T-2557): the author's `bento.yaml` processors pass the same check as a
    /// manifest's steps: a processor the platform does not run, at the top or nested inside
    /// another, or a Bloblang read of the runner's environment, and no stream is rendered.
    #[test]
    fn a_bento_processor_the_platform_refuses_does_not_render() {
        let mut spec = helsinki_pipeline_spec();
        spec.compute = None;
        let ds = helsinki_datasource_spec();
        let render =
            |bento: &str| render_stream(&spec, "p", "helsinki", &ds, "src", "abc123", Some(bento));
        for bento in [
            "pipeline:\n  processors:\n    - command: { name: sh }\n",
            "pipeline:\n  processors:\n    - subprocess: { name: sh }\n",
            "pipeline:\n  processors:\n    - try:\n        - file: { path: /etc/passwd }\n",
            "pipeline:\n  processors:\n    - switch:\n        - processors:\n            - wasm: { module_path: /tmp/x.wasm }\n",
            "pipeline:\n  processors:\n    - no_such_processor: {}\n",
            "pipeline:\n  processors:\n    - mapping: 'root.s = env(\"JC_CLIENT_SECRET\")'\n",
            "pipeline:\n  processors:\n    - branch:\n        processors:\n          - mapping: 'root = env(\"JC_CLIENT_SECRET\")'\n",
        ] {
            let refused = render(bento).expect_err(bento);
            assert!(matches!(refused, RenderError::Bento(_)), "{bento}: {refused:?}");
        }
        // The same names as configuration of an allowed processor are not processors.
        assert!(render("pipeline:\n  processors:\n    - redis: { url: redis://cache:6379, command: get, args_mapping: 'root = [this.id]' }\n").is_ok());
        assert!(render(BENTO).is_ok());
    }

    #[tokio::test]
    async fn missing_source_endpoint_is_error() {
        let mirror = Mirror::new();
        let target_ep = serde_json::json!({
            "contextSpaceRef": "helsinki-kpi",
            "slug": "targetslug1234567890123456",
            "audience": "public",
            "enabledRepresentations": ["ngsi-ld"]
        });
        mirror.upsert(ResourceEnvelope {
            api_version: API_VERSION.to_string(),
            kind: "Endpoint".to_string(),
            metadata: ObjectMeta {
                name: "kpi-writer".to_string(),
                namespace: Some("helsinki".to_string()),
                ..Default::default()
            },
            spec: target_ep,
            status: None,
        });

        let pipe = serde_json::json!({
            "class": "scheduled",
            "source": {
                "endpointRef": {
                    "kind": "Endpoint",
                    "name": "nonexistent-endpoint"
                },
                "query": {
                    "type": "BikeHireDockingStation",
                    "attrs": ["availableBikeNumber"]
                }
            },
            "compute": {
                "kind": "bloblang",
                "bloblang": "root = this"
            },
            "targetEndpoint": "urn:ngsi-ld:Endpoint:example.org:helsinki-kpi:kpi-writer"
        });
        mirror.upsert(ResourceEnvelope {
            api_version: API_VERSION.to_string(),
            kind: "Pipeline".to_string(),
            metadata: ObjectMeta {
                name: "kpi-pipe".to_string(),
                namespace: Some("helsinki".to_string()),
                ..Default::default()
            },
            spec: pipe,
            status: None,
        });

        let deployer = StreamDeployer::new("http://dummy-runner:4195");
        let outcomes = deployer
            .converge(&mirror, &Bentos::new(), &Default::default())
            .await;
        assert_eq!(outcomes.len(), 1);
        match &outcomes[0].2 {
            StreamOutcome::Error(msg) => {
                assert!(msg.contains("source endpoint nonexistent-endpoint is not in the mirror"));
            }
            other => panic!("expected Error, got {other:?}"),
        }
    }

    /// PL-06: a `bento.yaml` cannot turn a pipeline into a request/response service: an input
    /// that serves HTTP is refused, and an output that answers the caller is replaced by the
    /// endpoint write, whatever the author wrote.
    #[test]
    fn a_bento_cannot_serve_or_answer_http_requests() {
        let mut spec = helsinki_pipeline_spec();
        spec.compute = None;
        let ds = helsinki_datasource_spec();
        let render =
            |bento: &str| render_stream(&spec, "p", "helsinki", &ds, "src", "abc123", Some(bento));
        assert!(matches!(
            render("input:\n  http_server:\n    path: /api\n").unwrap_err(),
            RenderError::BentoInput
        ));
        for output in [
            "output:\n  sync_response: {}\n",
            "output:\n  http_server:\n    path: /answer\n",
        ] {
            let rendered = render(&format!(
                "pipeline:\n  processors:\n    - mapping: root = this\n{output}"
            ))
            .expect("renders");
            let written = rendered["output"].as_object().expect("an output");
            assert_eq!(
                written.keys().filter(|k| *k != "label").collect::<Vec<_>>(),
                vec!["http_client"],
                "{output}"
            );
            let url = written["http_client"]["url"].as_str().unwrap_or_default();
            assert!(url.contains("/api/endpoint/abc123/"), "{url}");
            assert!(!rendered.to_string().contains("sync_response"), "{output}");
            assert!(!rendered.to_string().contains("/answer"), "{output}");
        }
    }

    /// PL-64: an expiry the door would refuse never reaches the runner as a sweep; it is said as
    /// the sweep's error, and the pipeline itself still runs.
    #[tokio::test]
    async fn an_expiry_that_does_not_validate_sends_no_sweep() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("PUT"))
            .and(wiremock::matchers::path("/streams/citybikes-free"))
            .respond_with(wiremock::ResponseTemplate::new(200))
            .mount(&server)
            .await;
        let deployer = StreamDeployer::new(server.uri());
        let mirror = helsinki_test_mirror();
        let mut pipeline = mirror
            .get("helsinki", "Pipeline", "citybikes-free")
            .expect("pipeline");
        pipeline.spec["expiry"] = serde_json::json!({ "after": "30m", "types": ["Vehicle"] });
        mirror.upsert(pipeline);

        let outcomes = deployer
            .converge(&mirror, &Bentos::new(), &Default::default())
            .await;
        assert_eq!(
            outcomes[0],
            (
                "helsinki".to_owned(),
                "citybikes-free".to_owned(),
                StreamOutcome::Live
            )
        );
        match &outcomes[1] {
            (_, name, StreamOutcome::Error(said)) => {
                assert_eq!(name, "citybikes-free.expiry");
                assert!(said.contains("`30m`"), "{said}");
            }
            other => panic!("the sweep was not refused: {other:?}"),
        }
        let sent = server.received_requests().await.expect("recorded");
        assert!(
            sent.iter().all(|r| !r.url.path().ends_with(".expiry")),
            "the runner was sent a sweep"
        );
    }

    /// PL-64: a pipeline with expiry gets its sweep beside its own stream; a pipeline without it,
    /// or disabled, gets none, and a sweep whose expiry was removed is retired.
    #[tokio::test]
    async fn an_expiring_pipeline_runs_its_sweep_and_loses_it_with_the_expiry() {
        let server = wiremock::MockServer::start().await;
        for path in ["/streams/citybikes-free", "/streams/citybikes-free.expiry"] {
            wiremock::Mock::given(wiremock::matchers::method("PUT"))
                .and(wiremock::matchers::path(path))
                .respond_with(wiremock::ResponseTemplate::new(200))
                .mount(&server)
                .await;
        }
        wiremock::Mock::given(wiremock::matchers::method("DELETE"))
            .and(wiremock::matchers::path("/streams/citybikes-free.expiry"))
            .respond_with(wiremock::ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;
        let deployer = StreamDeployer::new(server.uri());
        let mirror = helsinki_test_mirror();
        let mut pipeline = mirror
            .get("helsinki", "Pipeline", "citybikes-free")
            .expect("pipeline");
        let plain = pipeline.clone();
        pipeline.spec["expiry"] = serde_json::json!({ "after": "14d", "types": ["Vehicle"] });
        mirror.upsert(pipeline.clone());

        let outcomes = deployer
            .converge(&mirror, &Bentos::new(), &Default::default())
            .await;
        let names: Vec<&str> = outcomes.iter().map(|(_, name, _)| name.as_str()).collect();
        assert_eq!(names, ["citybikes-free", "citybikes-free.expiry"]);
        assert!(outcomes.iter().all(|(_, _, o)| *o == StreamOutcome::Live));
        let sent = server.received_requests().await.expect("recorded");
        let sweep = sent
            .iter()
            .find(|r| {
                r.method.as_str() == "PUT" && r.url.path() == "/streams/citybikes-free.expiry"
            })
            .expect("the sweep was sent");
        let body: Value = serde_json::from_slice(&sweep.body).expect("json");
        assert!(body
            .to_string()
            .contains("/api/endpoint/abc123456789012345678901234/"));

        // Disabled: neither the stream nor its sweep.
        let mut disabled = pipeline.clone();
        disabled.spec["enabled"] = serde_json::json!(false);
        mirror.upsert(disabled);
        let outcomes = deployer
            .converge(&mirror, &Bentos::new(), &Default::default())
            .await;
        assert!(outcomes
            .iter()
            .all(|(_, name, _)| !name.ends_with(".expiry")));

        // Expiry removed: the sweep is retired (the DELETE expectation above).
        mirror.upsert(plain);
        let outcomes = deployer
            .converge(&mirror, &Bentos::new(), &Default::default())
            .await;
        assert!(outcomes
            .iter()
            .all(|(_, name, _)| !name.ends_with(".expiry")));
    }

    #[tokio::test]
    async fn put_success_is_live_and_refusal_is_error() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("PUT"))
            .and(wiremock::matchers::path("/streams/citybikes-free"))
            .respond_with(wiremock::ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let deployer = StreamDeployer::new(server.uri());
        let mirror = helsinki_test_mirror();
        let outcomes = deployer
            .converge(&mirror, &Bentos::new(), &Default::default())
            .await;
        assert_eq!(outcomes.len(), 1);
        assert_eq!(outcomes[0].2, StreamOutcome::Live);

        let server_err = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("PUT"))
            .and(wiremock::matchers::path("/streams/citybikes-free"))
            .respond_with(
                wiremock::ResponseTemplate::new(400).set_body_string("lint error in line 3"),
            )
            .mount(&server_err)
            .await;

        let deployer_err = StreamDeployer::new(server_err.uri());
        let outcomes_err = deployer_err
            .converge(&mirror, &Bentos::new(), &Default::default())
            .await;
        assert_eq!(outcomes_err.len(), 1);
        match &outcomes_err[0].2 {
            StreamOutcome::Error(err) => {
                assert!(err.contains("400") && err.contains("lint error"));
            }
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn the_runner_receives_the_space_segment_where_the_mapping_reads_jc_space() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("PUT"))
            .and(wiremock::matchers::path("/streams/citybikes-free"))
            .respond_with(wiremock::ResponseTemplate::new(200))
            .mount(&server)
            .await;
        let deployer = StreamDeployer::new(server.uri());
        let mirror = helsinki_test_mirror();
        let mut pipeline = mirror
            .get("helsinki", "Pipeline", "citybikes-free")
            .expect("the pipeline");
        pipeline.spec["compute"]["bloblang"] = serde_json::json!(
            "root.id = \"urn:ngsi-ld:X:\" + env(\"JC_ORG_DOMAIN\") + \":\" + env(\"JC_SPACE\") + \":\" + this.id"
        );
        mirror.upsert(pipeline);
        let bentos = Bentos::new();
        let outcomes = deployer
            .converge(&mirror, &bentos, &Default::default())
            .await;
        assert_eq!(outcomes[0].2, StreamOutcome::Live, "{outcomes:?}");
        let sent = server.received_requests().await.expect("recorded");
        // The first request asks whether the runner already holds the stream (T-2891).
        let put = sent
            .iter()
            .find(|request| request.method.as_str() == "PUT")
            .expect("the stream was PUT");
        let body = String::from_utf8_lossy(&put.body).to_string();
        // The space `helsinki` has no manifest here, so it renders `helsinki-helsinki` (PF-84);
        // the domain stays the runner's own variable.
        assert!(body.contains(r#"+ \"helsinki-helsinki\" +"#), "{body}");
        assert!(!body.contains("JC_SPACE"), "{body}");
        assert!(body.contains("JC_ORG_DOMAIN"), "{body}");

        // A pin on the space is what the runner gets instead.
        mirror.upsert(ResourceEnvelope {
            api_version: API_VERSION.to_owned(),
            kind: "ContextSpace".to_owned(),
            metadata: ObjectMeta {
                name: "helsinki".to_owned(),
                namespace: Some("helsinki".to_owned()),
                ..Default::default()
            },
            spec: serde_json::json!({ "urnSegment": "helsinki" }),
            status: None,
        });
        let deployer = StreamDeployer::new(server.uri());
        deployer
            .converge(&mirror, &bentos, &Default::default())
            .await;
        let sent = server.received_requests().await.expect("recorded");
        let body = String::from_utf8_lossy(&sent.last().expect("a second PUT").body).to_string();
        assert!(body.contains(r#"+ \"helsinki\" +"#), "{body}");
    }

    fn air_model(version: &str) -> Arc<crate::pipeline_validation::ModelSchema> {
        Arc::new(crate::pipeline_validation::ModelSchema::compile(
            "helsinki",
            version,
            &serde_json::json!({ "definitions": { "BikeHireDockingStation": {
                "additionalProperties": false,
                "properties": { "id": { "type": "string" }, "name": { "type": "string", "x-ngsi-ld-kind": "Property" } }
            }}}),
            &["BikeHireDockingStation".to_owned()],
            false,
        ))
    }

    /// PL-60, PL-61: a stream into a space that names a model carries the stage and the
    /// rejected sink right before the batch split, with the space written into the id rule; a
    /// new model version is a new render, and a space with no model gets no stage.
    #[tokio::test]
    async fn a_stream_into_a_modelled_space_validates_before_it_splits_into_batches() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("PUT"))
            .and(wiremock::matchers::path("/streams/citybikes-free"))
            .respond_with(wiremock::ResponseTemplate::new(200))
            .mount(&server)
            .await;
        let schemas = Arc::new(crate::pipeline_validation::ModelSchemas::default());
        let deployer = StreamDeployer::new(server.uri())
            .with_validation("http://portal-internal:8081/", Arc::clone(&schemas));
        let mirror = helsinki_test_mirror();
        let bentos = Bentos::new();
        let last = |requests: Vec<wiremock::Request>| -> Value {
            serde_json::from_slice(&requests.last().expect("a PUT").body).expect("json")
        };

        // No model: the stream is what it was.
        deployer
            .converge(&mirror, &bentos, &Default::default())
            .await;
        let plain = last(server.received_requests().await.expect("recorded"));
        assert!(!plain.to_string().contains("json_schema"), "{plain}");

        schemas.replace(HashMap::from([(
            ("helsinki".to_owned(), "helsinki".to_owned()),
            air_model("1.0.0"),
        )]));
        deployer
            .converge(&mirror, &bentos, &Default::default())
            .await;
        let staged = last(server.received_requests().await.expect("recorded"));
        let processors = staged["pipeline"]["processors"]
            .as_array()
            .expect("processors");
        let at = |label: &str| processors.iter().position(|p| p["label"] == label);
        let split = processors
            .iter()
            .position(|p| p.get("split").is_some())
            .expect("the split");
        let (validation, id_rule, rejected) = (
            at("validation").expect("the stage"),
            at("validation_id").expect("the id rule"),
            at("rejected").expect("the sink"),
        );
        assert!(
            validation < id_rule && id_rule < rejected && rejected < split,
            "{processors:?}"
        );
        let text = staged.to_string();
        assert!(
            text.contains(
                "http://portal-internal:8081/internal/pipelines/helsinki/citybikes-free/rejected"
            ),
            "{text}"
        );
        assert!(
            !text.contains("env(\\\"JC_SPACE\\\")"),
            "the space is written in: {text}"
        );
        // The write is unchanged and first; the outcome sink follows it only once it took the
        // batch, and drops rather than retries (PL-62). A failed write goes back to the input
        // rather than round the broker forever, so the stream can always stop (T-2983).
        let outputs = &staged["output"]["broker"]["outputs"];
        assert_eq!(
            staged["output"]["broker"]["pattern"],
            "fan_out_sequential_fail_fast"
        );
        assert_eq!(
            outputs[0]["http_client"]["verb"], "POST",
            "the write is unchanged"
        );
        assert_eq!(outputs[0]["label"], "output");
        assert_eq!(outputs[1]["label"], crate::pipeline_log::SINK_LABEL);
        assert_eq!(outputs[1]["drop_on"]["error"], true);
        assert_eq!(outputs[1]["drop_on"]["output"]["http_client"]["retries"], 0);
        assert_eq!(
            outputs[1]["drop_on"]["output"]["http_client"]["url"],
            "http://portal-internal:8081/internal/pipelines/helsinki/citybikes-free/outcomes"
        );
        assert!(
            staged["input"]["generate"]["mapping"]
                .as_str()
                .is_some_and(|mapping| mapping.contains("meta jc_run")),
            "each tick is a run: {}",
            staged["input"]
        );

        // A changed model is a changed render: the stage the runner gets is the new one.
        let mut changed = (*air_model("1.1.0")).clone();
        changed
            .classes
            .insert("Alert".into(), serde_json::json!({}));
        schemas.replace(HashMap::from([(
            ("helsinki".to_owned(), "helsinki".to_owned()),
            Arc::new(changed),
        )]));
        deployer
            .converge(&mirror, &bentos, &Default::default())
            .await;
        let restaged = last(server.received_requests().await.expect("recorded"));
        assert_ne!(restaged, staged);
        assert!(
            restaged.to_string().contains("this.type == \\\"Alert\\\""),
            "{restaged}"
        );
    }

    #[tokio::test]
    async fn the_runner_receives_the_source_segment_where_the_mapping_reads_jc_source_space() {
        // An indicator pipeline records where its figures came from, as the source Endpoint's
        // URN. Nothing injected `JC_SOURCE_SPACE`, so the mapping reached the runner with the
        // variable still in it, the runner resolved it to nothing, and every indicator was
        // refused `attribute derivedFrom: object must be a URI` one by one while the stream
        // reported a 2xx for the batch. The space it writes stayed empty (T-2445).
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("PUT"))
            .and(wiremock::matchers::path("/streams/kpi-pipe"))
            .respond_with(wiremock::ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let mirror = Mirror::new();
        for (name, space) in [
            ("kpi-writer", "helsinki-kpi"),
            ("helsinki-all", "helsinki-raw"),
        ] {
            mirror.upsert(ResourceEnvelope {
                api_version: API_VERSION.to_string(),
                kind: "Endpoint".to_string(),
                metadata: ObjectMeta {
                    name: name.to_string(),
                    namespace: Some("helsinki".to_string()),
                    ..Default::default()
                },
                spec: serde_json::json!({
                    "contextSpaceRef": space,
                    "slug": "targetslug1234567890123456",
                    "audience": "public",
                    "enabledRepresentations": ["ngsi-ld"]
                }),
                status: None,
            });
        }
        mirror.upsert(ResourceEnvelope {
            api_version: API_VERSION.to_string(),
            kind: "ContextSpace".to_string(),
            metadata: ObjectMeta {
                name: "helsinki-raw".to_string(),
                namespace: Some("helsinki".to_string()),
                ..Default::default()
            },
            spec: serde_json::json!({ "urnSegment": "helsinki-raw" }),
            status: None,
        });
        mirror.upsert(ResourceEnvelope {
            api_version: API_VERSION.to_string(),
            kind: "Pipeline".to_string(),
            metadata: ObjectMeta {
                name: "kpi-pipe".to_string(),
                namespace: Some("helsinki".to_string()),
                ..Default::default()
            },
            spec: serde_json::json!({
                "class": "scheduled",
                "schedule": "7 * * * *",
                "source": {
                    "endpointRef": { "kind": "Endpoint", "name": "helsinki-all" },
                    "query": { "type": "BikeHireDockingStation" }
                },
                "compute": {
                    "kind": "bloblang",
                    "bloblang": "root.derivedFrom = \"urn:ngsi-ld:Endpoint:x:\" + env(\"JC_SOURCE_SPACE\") + \":all\""
                },
                "targetEndpoint": "urn:ngsi-ld:Endpoint:example.org:helsinki-kpi:kpi-writer"
            }),
            status: None,
        });

        let outcomes = StreamDeployer::new(server.uri())
            .converge(&mirror, &Bentos::new(), &Default::default())
            .await;
        assert_eq!(outcomes[0].2, StreamOutcome::Live, "{outcomes:?}");
        let sent = server.received_requests().await.expect("recorded");
        // The first request asks whether the runner already holds the stream (T-2891).
        let put = sent
            .iter()
            .find(|request| request.method.as_str() == "PUT")
            .expect("the stream was PUT");
        let body = String::from_utf8_lossy(&put.body).to_string();
        assert!(body.contains(r#"+ \"helsinki-raw\" +"#), "{body}");
        assert!(!body.contains("JC_SOURCE_SPACE"), "{body}");
    }

    #[tokio::test]
    async fn put_404_falls_back_to_post() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("PUT"))
            .and(wiremock::matchers::path("/streams/citybikes-free"))
            .respond_with(wiremock::ResponseTemplate::new(404))
            .mount(&server)
            .await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/streams/citybikes-free"))
            .respond_with(wiremock::ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let deployer = StreamDeployer::new(server.uri());
        let mirror = helsinki_test_mirror();
        let outcomes = deployer
            .converge(&mirror, &Bentos::new(), &Default::default())
            .await;
        assert_eq!(outcomes.len(), 1);
        assert_eq!(outcomes[0].2, StreamOutcome::Live);
    }

    #[tokio::test]
    async fn a_runner_that_restarted_gets_its_unchanged_streams_again() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("PUT"))
            .and(wiremock::matchers::path("/streams/citybikes-free"))
            .respond_with(wiremock::ResponseTemplate::new(200))
            .expect(2)
            .mount(&server)
            .await;
        // The runner lists the stream after the first PUT, then restarts and lists nothing.
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/streams"))
            .respond_with(
                wiremock::ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "citybikes-free": { "active": true } })),
            )
            .up_to_n_times(1)
            .mount(&server)
            .await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/streams"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .mount(&server)
            .await;

        let deployer = StreamDeployer::new(server.uri());
        let mirror = helsinki_test_mirror();
        // PUT, then left running, then sent again to the empty runner: two PUTs in three passes.
        for _ in 0..3 {
            let outcomes = deployer
                .converge(&mirror, &Bentos::new(), &Default::default())
                .await;
            assert_eq!(outcomes[0].2, StreamOutcome::Live);
        }
    }

    /// A stream the runner holds but no longer runs is dead, not live: it is sent again, which
    /// restarts it and makes its output fetch a fresh token (T-2336, PL-18).
    #[tokio::test]
    async fn a_stream_the_runner_reports_inactive_is_sent_again() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("PUT"))
            .and(wiremock::matchers::path("/streams/citybikes-free"))
            .respond_with(wiremock::ResponseTemplate::new(200))
            .expect(3)
            .mount(&server)
            .await;
        // The runner holds it and says it is not running: its output was refused, over and over.
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/streams"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(
                serde_json::json!({ "citybikes-free": { "active": false, "uptime": 1800.0 } }),
            ))
            .mount(&server)
            .await;

        let deployer = StreamDeployer::new(server.uri());
        let mirror = helsinki_test_mirror();
        // Three passes over an unchanged manifest: three PUTs, because it is dead on every one.
        for _ in 0..3 {
            let outcomes = deployer
                .converge(&mirror, &Bentos::new(), &Default::default())
                .await;
            assert_eq!(outcomes[0].2, StreamOutcome::Live);
        }
    }

    /// What one converge PUT to a runner that accepts everything: the rendered stream as sent.
    async fn rendered_citybikes() -> serde_json::Value {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("PUT"))
            .respond_with(wiremock::ResponseTemplate::new(200))
            .mount(&server)
            .await;
        StreamDeployer::new(server.uri())
            .converge(&helsinki_test_mirror(), &Bentos::new(), &Default::default())
            .await;
        let sent = server.received_requests().await.expect("recorded");
        let put = sent
            .iter()
            .find(|request| request.method.as_str() == "PUT")
            .expect("the stream was PUT");
        serde_json::from_slice(&put.body).expect("a JSON stream")
    }

    /// A runner whose `GET /streams/citybikes-free` answers `held`, and which counts every PUT.
    async fn runner_holding(held: serde_json::Value, puts: u64) -> wiremock::MockServer {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/streams/citybikes-free"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(held))
            .mount(&server)
            .await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/streams"))
            .respond_with(
                wiremock::ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "citybikes-free": { "active": true } })),
            )
            .mount(&server)
            .await;
        wiremock::Mock::given(wiremock::matchers::method("PUT"))
            .respond_with(wiremock::ResponseTemplate::new(200))
            .expect(puts)
            .mount(&server)
            .await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .respond_with(wiremock::ResponseTemplate::new(200))
            .expect(0)
            .mount(&server)
            .await;
        server
    }

    /// T-2891: a Portal that restarted has no hashes, and the runner answers each stream's config
    /// as it was sent. A stream it runs exactly as rendered is adopted, not PUT again, on the first
    /// pass and on the passes after it; one it holds with another config, or holds stopped, is sent.
    #[tokio::test]
    async fn a_restarted_portal_adopts_the_stream_the_runner_runs_as_rendered() {
        let rendered = rendered_citybikes().await;
        let mirror = helsinki_test_mirror();

        let same =
            runner_holding(serde_json::json!({ "active": true, "config": rendered }), 0).await;
        let restarted = StreamDeployer::new(same.uri());
        for _ in 0..2 {
            let outcomes = restarted
                .converge(&mirror, &Bentos::new(), &Default::default())
                .await;
            assert_eq!(outcomes[0].2, StreamOutcome::Live, "{outcomes:?}");
        }

        let mut changed = rendered.clone();
        changed["pipeline"]["processors"] = serde_json::json!([{ "mapping": "root = this" }]);
        for held in [
            serde_json::json!({ "active": true, "config": changed }),
            serde_json::json!({ "active": false, "config": rendered }),
            serde_json::json!({ "active": true }),
        ] {
            let runner = runner_holding(held.clone(), 1).await;
            let outcomes = StreamDeployer::new(runner.uri())
                .converge(&mirror, &Bentos::new(), &Default::default())
                .await;
            assert_eq!(outcomes[0].2, StreamOutcome::Live, "{held}: {outcomes:?}");
        }
    }

    /// T-2891: a PUT the runner does not answer is not sent again on the next pass: the pipeline
    /// says when it will be, and nothing but the adoption check reaches the runner meanwhile. A
    /// changed render is sent at once. The runner here takes each connection and drops it, the
    /// transport failure a PUT that outlives the timeout ends in.
    #[tokio::test]
    async fn a_put_the_runner_does_not_answer_waits_before_it_is_sent_again() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a port");
        let address = listener.local_addr().expect("an address");
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let log = Arc::clone(&seen);
        tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut buffer = [0u8; 16];
                let read = socket.read(&mut buffer).await.unwrap_or(0);
                let head = String::from_utf8_lossy(&buffer[..read]).to_string();
                let verb = head.split(' ').next().unwrap_or_default().to_owned();
                log.lock().expect("the log").push(verb);
                drop(socket);
            }
        });
        let verbs = || seen.lock().expect("the log").clone();
        let puts = || verbs().iter().filter(|verb| verb.as_str() == "PUT").count();

        let deployer = StreamDeployer::new(format!("http://{address}"));
        let mirror = helsinki_test_mirror();
        let first = deployer
            .converge(&mirror, &Bentos::new(), &Default::default())
            .await;
        let StreamOutcome::Error(said) = &first[0].2 else {
            panic!("an unanswered PUT is not live: {first:?}");
        };
        assert!(
            said.contains("did not answer") && said.contains("again in 60 s"),
            "{said}"
        );
        assert_eq!(puts(), 1, "{:?}", verbs());

        let second = deployer
            .converge(&mirror, &Bentos::new(), &Default::default())
            .await;
        let StreamOutcome::Error(said) = &second[0].2 else {
            panic!("a stream waiting to be sent is not live: {second:?}");
        };
        assert!(said.contains("the last change of this stream"), "{said}");
        assert_eq!(puts(), 1, "the waiting stream was PUT again: {:?}", verbs());

        let mut pipeline = mirror
            .get("helsinki", "Pipeline", "citybikes-free")
            .expect("the pipeline");
        pipeline.spec["compute"]["bloblang"] = serde_json::json!("root = this.data.stations");
        mirror.upsert(pipeline);
        let third = deployer
            .converge(&mirror, &Bentos::new(), &Default::default())
            .await;
        assert!(
            matches!(&third[0].2, StreamOutcome::Error(said) if said.contains("again in 60 s")),
            "{third:?}"
        );
        assert_eq!(
            puts(),
            2,
            "a changed render waits for nothing: {:?}",
            verbs()
        );
    }

    /// Which inputs end on their own, because that is what tells a finished stream from a dead one
    /// when the runner reports it inactive (T-2336, PL-50).
    #[test]
    fn an_endless_input_is_told_apart_from_one_that_finishes() {
        for endless in [
            serde_json::json!({ "generate": { "interval": "60s", "mapping": "root = \"\"" } }),
            serde_json::json!({ "generate": { "interval": "60s", "count": 0 } }),
            serde_json::json!({ "mqtt": { "urls": ["tcp://mqtt:1883"] } }),
            serde_json::json!({ "nats": { "urls": ["nats://nats:4222"] } }),
            serde_json::json!({ "kafka": { "addresses": ["kafka:9092"] } }),
            serde_json::json!({ "http_server": {} }),
            serde_json::json!({ "broker": { "inputs": [{ "file": {} }, { "mqtt": {} }] } }),
            // Nothing recognisable is not a licence to let a dead stream lie.
            serde_json::json!({}),
            serde_json::json!({ "label": "input_0" }),
            serde_json::json!({ "broker": { "inputs": [] } }),
            serde_json::json!("not an input"),
        ] {
            assert!(
                !input_ends_by_itself(&endless),
                "{endless} does not end by itself"
            );
        }
        for finite in [
            serde_json::json!({ "file": { "paths": ["/data/stations.json"] } }),
            serde_json::json!({ "csv": { "paths": ["/data/stations.csv"] } }),
            serde_json::json!({ "parquet": { "paths": ["/data/stations.parquet"] } }),
            serde_json::json!({ "aws_s3": { "bucket": "open-data" } }),
            serde_json::json!({ "generate": { "interval": "1s", "count": 3 } }),
            serde_json::json!({ "label": "input_0", "file": { "paths": ["/data/x.json"] } }),
            serde_json::json!({ "broker": { "inputs": [{ "file": {} }, { "csv": {} }] } }),
        ] {
            assert!(input_ends_by_itself(&finite), "{finite} finishes");
        }
    }

    /// The other half of the same rule: a stream that is running is left alone, so a healthy
    /// periodic pipeline is not restarted on every pass and does not emit on every pass (T-0659).
    #[tokio::test]
    async fn a_stream_the_runner_reports_active_is_left_alone() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("PUT"))
            .and(wiremock::matchers::path("/streams/citybikes-free"))
            .respond_with(wiremock::ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/streams"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(
                serde_json::json!({ "citybikes-free": { "active": true, "uptime": 1320.0 } }),
            ))
            .mount(&server)
            .await;

        let deployer = StreamDeployer::new(server.uri());
        let mirror = helsinki_test_mirror();
        for _ in 0..3 {
            let outcomes = deployer
                .converge(&mirror, &Bentos::new(), &Default::default())
                .await;
            assert_eq!(outcomes[0].2, StreamOutcome::Live);
        }
    }

    /// A runner whose answer carries no `active` flag is taken at its word: an unknown body shape
    /// must not restart every stream of a project on every pass.
    #[tokio::test]
    async fn a_listing_without_the_active_flag_is_taken_at_its_word() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("PUT"))
            .and(wiremock::matchers::path("/streams/citybikes-free"))
            .respond_with(wiremock::ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;
        for body in [
            serde_json::json!({ "citybikes-free": {} }),
            serde_json::json!({ "citybikes-free": { "uptime": 1320.0 } }),
            serde_json::json!({ "citybikes-free": { "active": "yes" } }),
        ] {
            wiremock::Mock::given(wiremock::matchers::method("GET"))
                .and(wiremock::matchers::path("/streams"))
                .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(body))
                .up_to_n_times(1)
                .mount(&server)
                .await;
        }

        let deployer = StreamDeployer::new(server.uri());
        let mirror = helsinki_test_mirror();
        for _ in 0..4 {
            let outcomes = deployer
                .converge(&mirror, &Bentos::new(), &Default::default())
                .await;
            assert_eq!(outcomes[0].2, StreamOutcome::Live);
        }
    }

    #[test]
    fn an_http_feed_keeps_a_body_that_is_not_json() {
        let rendered = render_stream(
            &helsinki_pipeline_spec(),
            "p",
            "helsinki",
            &helsinki_datasource_spec(),
            "src",
            "abc123",
            None,
        )
        .expect("renders");
        let processors = rendered["pipeline"]["processors"]
            .as_array()
            .expect("processors");
        // `this` would parse an RSS or CSV body as JSON and fail on every fetch. The label is
        // the reconciler's own, so the counters of this processor are attributable (T-1125).
        assert_eq!(
            processors[1],
            serde_json::json!({
                "label": "processor_1",
                "mutation": "root = if errored() { deleted() }"
            })
        );
    }

    #[tokio::test]
    async fn an_unchanged_render_is_not_put_again_and_a_change_is() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("PUT"))
            .and(wiremock::matchers::path("/streams/citybikes-free"))
            .respond_with(wiremock::ResponseTemplate::new(200))
            .expect(2)
            .mount(&server)
            .await;

        let deployer = StreamDeployer::new(server.uri());
        let mirror = helsinki_test_mirror();
        // Two passes over the same manifests: one PUT.
        for _ in 0..2 {
            let outcomes = deployer
                .converge(&mirror, &Bentos::new(), &Default::default())
                .await;
            assert_eq!(outcomes[0].2, StreamOutcome::Live);
        }
        // A changed period renders differently: the second PUT.
        let mut changed = mirror
            .get("helsinki", "Pipeline", "citybikes-free")
            .expect("the test pipeline");
        changed.spec["period"] = serde_json::json!("120s");
        mirror.upsert(changed);
        let outcomes = deployer
            .converge(&mirror, &Bentos::new(), &Default::default())
            .await;
        assert_eq!(outcomes[0].2, StreamOutcome::Live);
    }

    #[tokio::test]
    async fn retire_deletes_what_disappeared() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("PUT"))
            .and(wiremock::matchers::path("/streams/citybikes-free"))
            .respond_with(wiremock::ResponseTemplate::new(200))
            .mount(&server)
            .await;
        wiremock::Mock::given(wiremock::matchers::method("DELETE"))
            .and(wiremock::matchers::path("/streams/citybikes-free"))
            .respond_with(wiremock::ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;

        let deployer = StreamDeployer::new(server.uri());
        let mirror = helsinki_test_mirror();
        let outcomes = deployer
            .converge(&mirror, &Bentos::new(), &Default::default())
            .await;
        assert_eq!(outcomes[0].2, StreamOutcome::Live);

        let empty_mirror = Mirror::new();
        let outcomes_empty = deployer
            .converge(&empty_mirror, &Bentos::new(), &Default::default())
            .await;
        assert!(outcomes_empty.is_empty());
    }

    #[test]
    fn runner_nats_source_renders_verbatim_and_refuses_scheduled_class() {
        let mut pipe = helsinki_pipeline_spec();
        pipe.class = jc_core::kinds::PipelineClass::Resident;
        pipe.period = None;

        let ds: DataSourceSpec = serde_json::from_value(serde_json::json!({
            "type": "nats",
            "input": {
                "urls": ["nats://nats.helsinki.fi:4222"],
                "subject": "city.bikes.updates"
            }
        }))
        .expect("valid runner DataSourceSpec");

        let rendered = render_stream(
            &pipe,
            "bikes-stream",
            "helsinki",
            &ds,
            "city-nats",
            "abc123456789",
            None,
        )
        .expect("renders nats stream");

        assert_eq!(
            rendered["input"]["nats"]["urls"][0],
            "nats://nats.helsinki.fi:4222"
        );
        assert_eq!(rendered["input"]["nats"]["subject"], "city.bikes.updates");
        assert_eq!(
            rendered["output"]["http_client"]["url"],
            "${JC_GATEWAY_URL}/api/endpoint/abc123456789/ngsi-ld/v1/entityOperations/upsert?options=update"
        );

        let mut sched_pipe = pipe;
        sched_pipe.class = jc_core::kinds::PipelineClass::Scheduled;
        sched_pipe.schedule = Some("*/10 * * * *".to_string());

        let err = render_stream(
            &sched_pipe,
            "bikes-stream",
            "helsinki",
            &ds,
            "city-nats",
            "abc123456789",
            None,
        )
        .unwrap_err();

        assert!(
            matches!(err, RenderError::Class(_)),
            "expected RenderError::Class, got: {err:?}"
        );
    }

    /// T-1125, PL-24: every component of a rendered stream carries a `label`, because Bento
    /// reports its counters under one and an unlabelled stream can only be read as a total.
    #[test]
    fn every_component_of_a_rendered_stream_is_labelled() {
        let rendered = render_stream(
            &helsinki_pipeline_spec(),
            "p",
            "helsinki",
            &helsinki_datasource_spec(),
            "src",
            "abc123",
            None,
        )
        .expect("renders");
        assert_eq!(rendered["input"]["label"], serde_json::json!("input"));
        assert_eq!(rendered["output"]["label"], serde_json::json!("output"));
        for (at, processor) in rendered["pipeline"]["processors"]
            .as_array()
            .expect("processors")
            .iter()
            .enumerate()
        {
            assert_eq!(
                processor["label"],
                serde_json::json!(format!("processor_{at}")),
                "processor {at} carries no label: {processor}"
            );
        }
    }

    /// A label the author wrote is theirs: the metrics they read elsewhere are named by it.
    #[test]
    fn a_label_the_author_wrote_is_kept() {
        let mine = serde_json::json!({ "label": "mine", "mutation": "root = this" });
        assert_eq!(labelled(mine.clone(), "processor_0"), mine);
        // Anything that cannot carry the key comes back as it came.
        assert_eq!(
            labelled(serde_json::json!("plain"), "input"),
            serde_json::json!("plain")
        );
    }
    // --- v1alpha2: sources, steps, outputs (PL-52…PL-54, T-1468) ---

    fn second_shape(spec: serde_json::Value) -> PipelineSpec {
        serde_json::from_value(spec).expect("valid v1alpha2 PipelineSpec")
    }

    #[test]
    fn a_second_version_pipeline_of_one_source_step_and_output_renders_the_first_versions_bytes() {
        let first = helsinki_pipeline_spec();
        let second = second_shape(serde_json::json!({
            "class": "auto",
            "period": "60s",
            "sources": [{ "dataSourceRef": { "kind": "DataSource", "name": "hsl-citybikes-free" } }],
            "steps": [{ "kind": "bloblang", "bloblang": "root = this.data.bikes" }],
            "outputs": [{ "targetEndpoint": "urn:ngsi-ld:Endpoint:example.org:helsinki:helsinki-all" }]
        }));
        assert!(
            !is_merged(&second),
            "one of each takes the first version's renderer"
        );
        let ds = helsinki_datasource_spec();
        let render = |spec: &PipelineSpec| {
            serde_json::to_string(
                &render_stream(
                    spec,
                    "citybikes-free",
                    "helsinki",
                    &ds,
                    "hsl-citybikes-free",
                    "slug1",
                    None,
                )
                .expect("renders"),
            )
            .expect("serializes")
        };
        assert_eq!(render(&first), render(&second));
    }

    #[test]
    fn two_sources_merge_through_a_broker_and_two_outputs_fan_out() {
        let spec = second_shape(serde_json::json!({
            "class": "resident",
            "period": "30s",
            "sources": [
                { "dataSourceRef": { "kind": "DataSource", "name": "gbfs" } },
                { "endpointRef": { "kind": "Endpoint", "name": "legacy" },
                  "query": { "type": "BikeHireDockingStation" } }
            ],
            "steps": [
                { "kind": "bloblang", "bloblang": "root = this" },
                { "processor": { "dedupe": { "cache": "pipeline_changes", "key": "${! json(\"id\") }" } } }
            ],
            "outputs": [
                { "targetEndpoint": "urn:ngsi-ld:Endpoint:example.org:helsinki:ops" },
                { "targetEndpoint": "urn:ngsi-ld:Endpoint:example.org:helsinki-kpi:kpi" }
            ]
        }));
        assert!(is_merged(&spec));
        assert!(eligible(&spec));
        let sources = vec![
            ResolvedSource::Data {
                spec: Box::new(helsinki_datasource_spec()),
                name: "gbfs".to_owned(),
            },
            ResolvedSource::Endpoint {
                source: Box::new(spec.sources()[1].clone()),
                slug: "legacyslug".to_owned(),
                public: false,
            },
        ];
        let stream = render_merged(
            &spec,
            "bikes-merged",
            "helsinki",
            &sources,
            &["opsslug".to_owned(), "kpislug".to_owned()],
        )
        .expect("renders");

        let inputs = stream["input"]["broker"]["inputs"]
            .as_array()
            .expect("a broker input");
        assert_eq!(inputs.len(), 2);
        // Each input carries the processors its own input needs, the http poll among them.
        assert!(inputs[0]["generate"].is_object());
        assert!(inputs[0]["processors"][0]["try"][0]["http"]["url"]
            .as_str()
            .is_some_and(|url| url.contains("gbfs")));
        let read = &inputs[1]["processors"][0]["try"][0]["http"];
        assert!(read["url"]
            .as_str()
            .is_some_and(|url| url.contains("/api/endpoint/legacyslug/")));
        assert_eq!(
            read["oauth2"]["enabled"], true,
            "a non-public source is read with the runner's token"
        );

        let processors = stream["pipeline"]["processors"]
            .as_array()
            .expect("processors");
        assert_eq!(processors[0]["mapping"], "root = this");
        assert_eq!(processors[1]["dedupe"]["cache"], "pipeline_changes");
        assert_eq!(
            processors[1]["label"], "processor_1",
            "every step is labelled by its index"
        );
        assert!(processors[2]["mapping"]
            .as_str()
            .is_some_and(|m| m.contains("array")));

        // A failed write goes back to the input rather than round the broker forever (T-2983).
        let output = &stream["output"]["broker"];
        assert_eq!(output["pattern"], "fan_out_fail_fast");
        let outputs = output["outputs"].as_array().expect("outputs");
        assert_eq!(outputs.len(), 2);
        assert!(outputs[1]["http_client"]["url"]
            .as_str()
            .is_some_and(|url| url.contains("/api/endpoint/kpislug/")));
    }

    #[test]
    fn a_processor_step_alone_renders_without_a_broker() {
        let spec = second_shape(serde_json::json!({
            "class": "resident",
            "period": "30s",
            "sources": [{ "dataSourceRef": { "kind": "DataSource", "name": "gbfs" } }],
            "steps": [{ "processor": { "log": { "message": "seen" } } }],
            "outputs": [{ "targetEndpoint": "urn:ngsi-ld:Endpoint:example.org:helsinki:ops" }]
        }));
        assert!(
            is_merged(&spec),
            "a processor step takes the general renderer"
        );
        let stream = render_merged(
            &spec,
            "logged",
            "helsinki",
            &[ResolvedSource::Data {
                spec: Box::new(helsinki_datasource_spec()),
                name: "gbfs".to_owned(),
            }],
            &["opsslug".to_owned()],
        )
        .expect("renders");
        assert!(stream["input"]["broker"].is_null());
        assert!(stream["input"]["generate"].is_object());
        assert!(stream["output"]["http_client"].is_object());
        assert_eq!(
            stream["pipeline"]["processors"][0]["log"]["message"],
            "seen"
        );
    }

    #[test]
    fn a_merged_pipeline_with_a_compute_the_stream_cannot_run_is_refused_and_not_eligible() {
        let spec = second_shape(serde_json::json!({
            "class": "resident",
            "sources": [{ "dataSourceRef": { "kind": "DataSource", "name": "gbfs" } }],
            "steps": [
                { "kind": "mapping", "mappingRef": { "kind": "Mapping", "name": "m" } },
                { "processor": { "log": { "message": "x" } } }
            ],
            "outputs": [{ "targetEndpoint": "urn:ngsi-ld:Endpoint:example.org:helsinki:ops" }]
        }));
        assert!(!eligible(&spec));
        let refused = render_merged(
            &spec,
            "p",
            "helsinki",
            &[ResolvedSource::Data {
                spec: Box::new(helsinki_datasource_spec()),
                name: "gbfs".to_owned(),
            }],
            &["opsslug".to_owned()],
        );
        assert!(matches!(refused, Err(RenderError::MissingCompute)));
        let none = render_merged(&spec, "p", "helsinki", &[], &["opsslug".to_owned()]);
        assert!(matches!(none, Err(RenderError::Custom(_))));
    }

    #[tokio::test]
    async fn the_reconciler_resolves_every_source_and_output_from_the_mirror() {
        let mirror = helsinki_test_mirror();
        let pipe = serde_json::json!({
            "class": "auto",
            "period": "60s",
            "sources": [
                { "dataSourceRef": { "kind": "DataSource", "name": "hsl-citybikes-free" } },
                { "dataSourceRef": { "kind": "DataSource", "name": "hsl-citybikes-free" } }
            ],
            "steps": [{ "kind": "bloblang", "bloblang": "root = this" }],
            "outputs": [
                { "targetEndpoint": "urn:ngsi-ld:Endpoint:example.org:helsinki:helsinki-all" },
                { "targetEndpoint": "urn:ngsi-ld:Endpoint:example.org:helsinki:not-there" }
            ]
        });
        mirror.upsert(ResourceEnvelope {
            api_version: jc_core::API_VERSION_V1ALPHA2.to_string(),
            kind: "Pipeline".to_string(),
            metadata: ObjectMeta {
                name: "merged".to_string(),
                namespace: Some("helsinki".to_string()),
                ..Default::default()
            },
            spec: pipe,
            status: None,
        });
        let deployer = StreamDeployer::new("http://dummy-runner:4195");
        let outcomes = deployer
            .converge(&mirror, &Bentos::new(), &Default::default())
            .await;
        let merged = outcomes
            .iter()
            .find(|(_, name, _)| name == "merged")
            .expect("the merged pipeline is reconciled");
        match &merged.2 {
            StreamOutcome::Error(msg) => assert!(
                msg.contains("target endpoint not-there is not in the mirror"),
                "{msg}"
            ),
            other => panic!("expected the missing output named, got {other:?}"),
        }
    }
}
