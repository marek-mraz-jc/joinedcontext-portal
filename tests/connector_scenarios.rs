//! The 50 connector scenarios, scripted through the Portal MCP door (T-5947, GOAL-connectors).
//!
//! `tests/connector_scenarios/scenarios.yaml` is the catalogue: each job a person does through an
//! AI connector, with what must hold (`expect`) and what must be refused (`deny`). A scenario's
//! `script` is the tool calls that prove both, made here without a model: each step signs a token
//! for the scenario's persona, sends one JSON-RPC request to `/api/v1/mcp` and checks the answer.
//!
//! `tests/connector_scenarios/red.txt` is the ratchet: every scenario that cannot pass yet, with
//! the task that turns it green. The run fails when an unlisted scenario fails, and when a listed
//! one passes: its line leaves the file in the branch that greens it.
//!
//! Each scenario gets its own project `t-scn-NN` (a space, a DataModel, an Endpoint and a CSV
//! DataSource served on `http://localhost`) and every persona is bound to it alone; project
//! `t-scn-other` belongs to nobody, so a step aimed at it is the cross-project deny. The fixtures
//! live in the run's in-memory mirror and mock servers and end with the test process.

use std::collections::{BTreeMap, BTreeSet};

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use http_body_util::BodyExt;
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use p256::pkcs8::EncodePrivateKey;
use serde::Deserialize;
use serde_json::{json, Value};
use tower::ServiceExt;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use joinedcontext_portal::config::Config;
use joinedcontext_portal::permissions::ORG_NAMESPACE;
use joinedcontext_portal::resource::{ObjectMeta, ResourceEnvelope, API_VERSION};
use joinedcontext_portal::server;
use joinedcontext_portal::state::AppState;
use joinedcontext_portal::store::Mirror;

const CATALOGUE: &str = include_str!("connector_scenarios/scenarios.yaml");
const RED: &str = include_str!("connector_scenarios/red.txt");
const REALM_PATH: &str = "/realms/banskabystrica";
const AUDIENCE: &str = "joinedcontext-portal";
const KID: &str = "key-scenarios";
/// The connector client the persona's token is obtained by (CONNECTOR_CLIENTS).
const CLIENT: &str = "mcp-local";
const OTHER: &str = "t-scn-other";
/// The tasks of group `connectors` (GOAL-connectors.md): a red line names one of them. A task the
/// group adds later joins this list in the branch that files it.
const CONNECTOR_TASKS: &[&str] = &[
    "T-5946", "T-5948", "T-5949", "T-5950", "T-5951", "T-5952", "T-5953", "T-5954", "T-5955",
    "T-5956", "T-5957", "T-5958", "T-5959", "T-5960", "T-5961", "T-5962", "T-5964", "T-5965",
    "T-5966", "T-5967", "T-5968", "T-5969", "T-5970", "T-5971", "T-5972", "T-5973", "T-5974",
    "T-5975", "T-5976", "T-5977", "T-5978", "T-5979", "T-5980",
];
/// The kinds a persona's role names; `kinds: ["*"]` would match only the `*` kind.
const KINDS: &[&str] = &[
    "ContextSpace",
    "Endpoint",
    "Pipeline",
    "Policy",
    "DataSource",
    "DataModel",
    "App",
    "Role",
    "RoleBinding",
    "ServiceAccount",
    "SyncSource",
    "Project",
    "Workspace",
];
const PERSONAS: &[&str] = &[
    "viewer",
    "steward",
    "project-admin",
    "org-admin",
    "approver",
    "anonymous",
];
const COUNTERS_CSV: &str = "id,name,count,observedAt\nc1,Most SNP,42,2026-10-27T10:00:00Z\n";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Scenario {
    id: String,
    segment: String,
    #[serde(rename = "as")]
    persona: String,
    says: String,
    expect: String,
    deny: String,
    #[serde(default)]
    script: Vec<Step>,
}

/// One MCP request and what its answer must hold.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Step {
    /// `expect` or `deny`: which half of the scenario this step proves.
    proves: Proves,
    /// The persona, when not the scenario's own.
    #[serde(default, rename = "as")]
    persona: Option<String>,
    /// A tool to call; without one the step is `tools/list`.
    #[serde(default)]
    call: Option<String>,
    #[serde(default)]
    args: Value,
    /// `own` (the scenario's project, the default) or `other` (`t-scn-other`).
    #[serde(default)]
    project: Option<String>,
    /// Whether the answer must be a refusal: `isError` on a call, an HTTP 401/403 at the door.
    #[serde(default)]
    refused: bool,
    /// Texts the answer must carry, `{project}` standing for the step's project.
    #[serde(default)]
    contains: Vec<String>,
    /// Texts the answer must not carry.
    #[serde(default)]
    absent: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Proves {
    Expect,
    Deny,
}

fn catalogue() -> Vec<Scenario> {
    serde_norway::from_str(CATALOGUE).expect("scenarios.yaml parses")
}

/// `S-nn -> (task, reason)` from red.txt.
fn red_list() -> BTreeMap<String, (String, String)> {
    let mut red = BTreeMap::new();
    for line in RED.lines().map(str::trim) {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.splitn(3, ' ');
        let (id, task, reason) = (
            parts.next().unwrap_or_default(),
            parts.next().unwrap_or_default(),
            parts.next().unwrap_or_default().trim(),
        );
        assert!(
            CONNECTOR_TASKS.contains(&task),
            "red.txt: {line}: {task} is no task of group connectors"
        );
        assert!(!reason.is_empty(), "red.txt: {line}: a red line says why");
        assert!(
            red.insert(id.to_owned(), (task.to_owned(), reason.to_owned()))
                .is_none(),
            "red.txt: {id} twice"
        );
    }
    red
}

fn project_of(n: usize) -> String {
    format!("t-scn-{n:02}")
}

fn envelope(kind: &str, name: &str, namespace: &str, spec: Value) -> ResourceEnvelope {
    ResourceEnvelope {
        api_version: API_VERSION.to_owned(),
        kind: kind.to_owned(),
        metadata: ObjectMeta::new(name, namespace),
        spec,
        status: None,
    }
}

/// A base32 slug (a-z, 2-7) of 26 characters or more, unique per project (EP-03).
fn slug_of(project: &str) -> String {
    let tail: String = project
        .chars()
        .map(|c| match c {
            '0' => 'a',
            '1' => 'b',
            '8' => 'c',
            '9' => 'd',
            '-' => 'x',
            other => other,
        })
        .collect();
    format!("{tail}counterszzzzzzzzzzzzzzzzzz")
}

/// One project's fixture: a space, a model, a public Endpoint, a CSV DataSource.
fn seed_project(mirror: &Mirror, project: &str, csv_url: &str) {
    mirror.upsert(envelope(
        "ContextSpace",
        "doprava",
        project,
        json!({ "isSandbox": true }),
    ));
    mirror.upsert(envelope(
        "DataModel",
        "bike-counter",
        project,
        json!({ "contextSpaceRef": "doprava", "linkml": "./bike-counter.linkml.yaml" }),
    ));
    mirror.upsert(envelope(
        "Endpoint",
        &format!("{project}-counters"),
        project,
        json!({
            "slug": slug_of(project),
            "contextSpaceRef": "doprava",
            "audience": "public",
            "title": format!("Bike counters of {project}"),
            "entityTypes": ["BikeCounter"],
            "enabledRepresentations": ["ngsi-ld"]
        }),
    ));
    mirror.upsert(envelope(
        "DataSource",
        "counters-csv",
        project,
        json!({ "contextSpaceRef": "doprava", "http": { "url": csv_url } }),
    ));
}

/// Roles per persona, and a binding of each persona to every scenario project but `t-scn-other`.
fn bind_personas(mirror: &Mirror, projects: &[String]) {
    let kinds = json!(KINDS);
    for (role, verbs) in [
        ("scn-viewer", json!(["read"])),
        ("scn-steward", json!(["read", "propose"])),
        (
            "scn-project-admin",
            json!(["read", "propose", "approve", "delete"]),
        ),
        ("scn-approver", json!(["read", "approve"])),
    ] {
        mirror.upsert(envelope(
            "Role",
            role,
            ORG_NAMESPACE,
            json!({ "rules": [{ "kinds": kinds, "verbs": verbs }] }),
        ));
    }
    for persona in ["viewer", "steward", "project-admin", "approver"] {
        for project in projects {
            mirror.upsert(envelope(
                "RoleBinding",
                &format!("scn-{persona}-{project}"),
                ORG_NAMESPACE,
                json!({
                    "subjects": [{ "user": user_of(persona) }],
                    "role": format!("scn-{persona}"),
                    "scope": { "project": project }
                }),
            ));
        }
    }
}

fn user_of(persona: &str) -> String {
    format!("scn.{persona}@hel.fi")
}

/// The forge, on the realm's server: change 42 waits for approval in project `t-scn-42`, the
/// project of S-42 and S-44.
async fn forge(server: &MockServer) {
    const REPO: &str = "/api/v1/repos/test-owner/test-repo";
    const FILE: &str = "projects/t-scn-42/spaces/doprava/space.yaml";
    const BRANCH: &str = "portal/update-contextspace-doprava-42";
    let pull = json!({
        "number": 42,
        "html_url": "https://gitea.example.sk/pulls/42",
        "state": "open",
        "title": "update ContextSpace doprava",
        "head": { "ref": BRANCH },
        "base": { "ref": "main" },
        "created_at": "2026-10-27T09:14:22Z",
        "user": { "login": "scn.steward", "full_name": "Scenario Steward" },
        "mergeable": true,
        "merged": false
    });
    let space = concat!(
        "apiVersion: joinedcontext.com/v1alpha1\n",
        "kind: ContextSpace\n",
        "metadata:\n",
        "  name: doprava\n",
        "  namespace: t-scn-42\n",
        "spec:\n",
        "  isSandbox: true\n",
    );
    use base64::Engine;
    for (route, body) in [
        (REPO.to_owned(), json!({ "default_branch": "main" })),
        (format!("{REPO}/pulls"), json!([pull.clone()])),
        (format!("{REPO}/pulls/42"), pull),
        (
            format!("{REPO}/pulls/42/files"),
            json!([{ "filename": FILE, "status": "modified" }]),
        ),
        (
            format!("{REPO}/contents/{FILE}"),
            json!({ "sha": "blob-42",
                    "content": base64::engine::general_purpose::STANDARD.encode(space) }),
        ),
    ] {
        Mock::given(method("GET"))
            .and(path(route))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(server)
            .await;
    }
}

struct Harness {
    app: axum::Router,
    issuer: String,
    signer: EncodingKey,
}

impl Harness {
    async fn start(projects: usize) -> Self {
        // Leaked: the router's JWKS cache and the DataSource URLs point at this server for as
        // long as the test binary runs; a dropped one goes back to wiremock's pool.
        let server: &'static MockServer = Box::leak(Box::new(MockServer::start().await));
        let issuer = format!("{}{REALM_PATH}", server.uri().trim_end_matches('/'));
        let secret = p256::SecretKey::random(&mut rand_core::OsRng);
        let der = secret.to_pkcs8_der().expect("der");
        let signer = EncodingKey::from_ec_der(der.as_bytes());
        let mut jwk: Value =
            serde_json::from_str(&secret.public_key().to_jwk_string()).expect("jwk");
        jwk["kid"] = json!(KID);
        jwk["alg"] = json!("ES256");
        jwk["use"] = json!("sig");
        Mock::given(method("GET"))
            .and(path(format!(
                "{REALM_PATH}/.well-known/openid-configuration"
            )))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "issuer": issuer,
                "authorization_endpoint": format!("{issuer}/protocol/openid-connect/auth"),
                "token_endpoint": format!("{issuer}/protocol/openid-connect/token"),
                "jwks_uri": format!("{issuer}/protocol/openid-connect/certs"),
                "end_session_endpoint": format!("{issuer}/protocol/openid-connect/logout"),
                "response_types_supported": ["code"],
                "subject_types_supported": ["public"],
                "id_token_signing_alg_values_supported": ["ES256"]
            })))
            .mount(server)
            .await;
        Mock::given(method("GET"))
            .and(path(format!("{REALM_PATH}/protocol/openid-connect/certs")))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "keys": [jwk] })))
            .mount(server)
            .await;
        // The CSV source, as a city's open data portal serves it; `localhost`, since the
        // outbound guard refuses 127.0.0.1 (T-5335).
        Mock::given(method("GET"))
            .and(path("/counters.csv"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/csv")
                    .set_body_string(COUNTERS_CSV),
            )
            .mount(server)
            .await;
        forge(server).await;
        let csv_url = format!("http://localhost:{}/counters.csv", server.address().port());

        let mut config = Config::from_vars(|k| match k {
            "JC_OIDC_ISSUER" => Some(issuer.clone()),
            "JC_OIDC_CLIENT_ID" => Some(AUDIENCE.to_owned()),
            "JC_OIDC_CLIENT_SECRET" => Some("secret".to_owned()),
            "JC_PORTAL_COOKIE_KEY" => Some("k".repeat(64)),
            _ => None,
        })
        .expect("config");
        config.public_base_url = "https://portal.test".parse().expect("url");

        let mirror = std::sync::Arc::new(Mirror::new());
        let names: Vec<String> = (1..=projects).map(project_of).collect();
        for project in names.iter().map(String::as_str).chain([OTHER]) {
            seed_project(&mirror, project, &csv_url);
        }
        bind_personas(&mirror, &names);
        let state = AppState::from_config(config)
            .await
            .expect("state")
            .with_mirror(mirror)
            .with_gitea(std::sync::Arc::new(
                joinedcontext_portal::git::GiteaClient::new(
                    server.uri().parse().expect("mock url"),
                    "test-owner",
                    "test-repo",
                    "token-scenarios",
                )
                .expect("gitea client"),
            ));
        Self {
            app: server::app(state),
            issuer,
            signer,
        }
    }

    /// The persona's token, as the connector client obtains it; `None` for anonymous.
    fn token(&self, persona: &str) -> Option<String> {
        assert!(PERSONAS.contains(&persona), "unknown persona {persona}");
        if persona == "anonymous" {
            return None;
        }
        let now = joinedcontext_portal::auth::session::now_unix();
        let (roles, groups): (&[&str], &[&str]) = match persona {
            "approver" => (&["portal-approver"], &[]),
            // The bootstrap group (Config::DEFAULT_BOOTSTRAP_ADMINS) administers the organization.
            "org-admin" => (&[], &["platform-admins"]),
            _ => (&[], &[]),
        };
        let user = user_of(persona);
        let claims = json!({
            "iss": self.issuer,
            "aud": AUDIENCE,
            "azp": CLIENT,
            "sub": format!("sub-scn-{persona}"),
            "preferred_username": user,
            "email": user,
            "email_verified": true,
            "realm_access": { "roles": roles },
            "groups": groups,
            "exp": now + 600,
            "iat": now,
        });
        let mut header = Header::new(Algorithm::ES256);
        header.kid = Some(KID.to_owned());
        Some(encode(&header, &claims, &self.signer).expect("sign"))
    }

    /// One JSON-RPC request through the MCP door: the HTTP status and the body.
    async fn rpc(&self, persona: &str, body: Value) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method("POST")
            .uri("/api/v1/mcp")
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(token) = self.token(persona) {
            request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        let response = self
            .app
            .clone()
            .oneshot(request.body(Body::from(body.to_string())).expect("request"))
            .await
            .expect("the router answers");
        let status = response.status();
        let bytes = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        (
            status,
            serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned())),
        )
    }

    /// Runs one step; `Err` says what did not hold.
    async fn step(&self, scenario: &Scenario, own: &str, step: &Step) -> Result<(), String> {
        let persona = step.persona.as_deref().unwrap_or(&scenario.persona);
        let project = match step.project.as_deref() {
            None | Some("own") => own,
            Some("other") => OTHER,
            Some(other) => return Err(format!("project `{other}` is neither own nor other")),
        };
        let fill = |text: &str| text.replace("{project}", project);
        let args = serde_json::from_str::<Value>(&fill(&step.args.to_string()))
            .map_err(|e| format!("args: {e}"))?;
        let body = match &step.call {
            Some(tool) => {
                let mut arguments = if args.is_null() { json!({}) } else { args };
                arguments["project"] = json!(project);
                json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                        "params": { "name": tool, "arguments": arguments } })
            }
            None => json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list",
                            "params": { "project": project } }),
        };
        let (status, answer) = self.rpc(persona, body).await;
        let refused = match status {
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => true,
            StatusCode::OK => {
                answer["result"]["isError"] == json!(true) || !answer["error"].is_null()
            }
            other => return Err(format!("the door answered {other}: {answer}")),
        };
        let what = step.call.as_deref().unwrap_or("tools/list");
        if refused != step.refused {
            return Err(format!(
                "{what} as {persona} in {project}: refused={refused}, want {}: {answer}",
                step.refused
            ));
        }
        // A tools/list step judges tool names, a call the whole answer.
        let text = if step.call.is_none() {
            answer["result"]["tools"]
                .as_array()
                .map(|tools| {
                    tools
                        .iter()
                        .filter_map(|t| t["name"].as_str())
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .unwrap_or_default()
        } else {
            answer.to_string()
        };
        for want in step.contains.iter().map(|t| fill(t)) {
            if !text.contains(&want) {
                return Err(format!("{what} as {persona}: `{want}` missing from {text}"));
            }
        }
        for unwanted in step.absent.iter().map(|t| fill(t)) {
            if text.contains(&unwanted) {
                return Err(format!("{what} as {persona}: `{unwanted}` in {text}"));
            }
        }
        Ok(())
    }

    /// Runs a scenario's script. A scenario passes only with an expect step, and a deny step
    /// unless its `deny` is `none`: expect AND deny hold, or it is not green.
    async fn run(&self, scenario: &Scenario, own: &str) -> Result<(), String> {
        let has = |p: Proves| scenario.script.iter().any(|s| s.proves == p);
        if !has(Proves::Expect) {
            return Err("no expect step scripted".into());
        }
        if scenario.deny != "none" && !has(Proves::Deny) {
            return Err("no deny step scripted".into());
        }
        for step in &scenario.script {
            self.step(scenario, own, step).await?;
        }
        Ok(())
    }
}

#[test]
fn the_catalogue_holds_the_connector_scenarios_well_formed() {
    let scenarios = catalogue();
    // S-01..S-50 of the owner's order and S-51..S-55 added with T-5971..T-5976; the UI
    // scenarios S-56.. are browser journeys of the user agent (T-5981), not MCP calls.
    assert_eq!(scenarios.len(), 55);
    for (n, s) in scenarios.iter().enumerate() {
        assert_eq!(
            s.id,
            format!("S-{:02}", n + 1),
            "ids run S-01..S-50 in order"
        );
        assert!(PERSONAS.contains(&s.persona.as_str()), "{}: persona", s.id);
        assert!(
            !s.segment.is_empty() && !s.says.is_empty() && !s.expect.is_empty(),
            "{}",
            s.id
        );
        for step in &s.script {
            if let Some(persona) = &step.persona {
                assert!(PERSONAS.contains(&persona.as_str()), "{}: persona", s.id);
            }
        }
    }
    let red = red_list();
    let ids: BTreeSet<&str> = scenarios.iter().map(|s| s.id.as_str()).collect();
    for id in red.keys() {
        assert!(ids.contains(id.as_str()), "red.txt names unknown {id}");
    }
}

#[tokio::test]
async fn every_scenario_is_green_or_listed_red_with_its_task() {
    let scenarios = catalogue();
    let red = red_list();
    let harness = Harness::start(scenarios.len()).await;
    let mut green = Vec::new();
    let mut wrong = Vec::new();
    for (n, scenario) in scenarios.iter().enumerate() {
        let own = project_of(n + 1);
        let outcome = harness.run(scenario, &own).await;
        match (outcome, red.get(&scenario.id)) {
            (Ok(()), None) => green.push(scenario.id.as_str()),
            (Err(_), Some(_)) => {}
            (Ok(()), Some((task, _))) => wrong.push(format!(
                "{} passes: remove its red.txt line ({task})",
                scenario.id
            )),
            (Err(why), None) => wrong.push(format!(
                "{} fails and is not in red.txt: {why}",
                scenario.id
            )),
        }
    }
    println!(
        "connector scenarios: {} green, {} red: green {}",
        green.len(),
        red.len(),
        green.join(" ")
    );
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

/// The harness judges: an expect that does not hold fails, and so does a deny the door allows.
#[tokio::test]
async fn a_broken_expect_and_an_allowed_deny_both_fail() {
    let harness = Harness::start(1).await;
    let own = project_of(1);
    let scenario = |script: Value| -> Scenario {
        serde_json::from_value(json!({
            "id": "S-00", "segment": "data-read", "as": "viewer", "says": "selftest",
            "expect": "selftest", "deny": "selftest", "script": script
        }))
        .expect("scenario")
    };
    let list = json!({ "proves": "expect", "call": "jc_resource_list",
                       "args": { "kind": "Endpoint" }, "contains": ["{project}-counters"] });
    let refused_other = json!({ "proves": "deny", "call": "jc_resource_list", "project": "other",
                                "args": { "kind": "Endpoint" }, "refused": true });
    // Sound: the viewer lists their project's Endpoint and is refused another project's.
    assert_eq!(
        harness
            .run(&scenario(json!([list, refused_other])), &own)
            .await,
        Ok(())
    );
    // A broken expect: a text the answer does not carry.
    let mut broken = list.clone();
    broken["contains"] = json!(["no-such-endpoint"]);
    let err = harness
        .run(&scenario(json!([broken, refused_other])), &own)
        .await
        .expect_err("a broken expect fails");
    assert!(err.contains("no-such-endpoint"), "{err}");
    // A deny the door allows: the viewer's own project is no refusal.
    let mut allowed = refused_other.clone();
    allowed["project"] = json!("own");
    let err = harness
        .run(&scenario(json!([list, allowed])), &own)
        .await
        .expect_err("an allowed deny fails");
    assert!(err.contains("refused=false"), "{err}");
    // A scenario with a deny line and no deny step is not green.
    let err = harness
        .run(&scenario(json!([list])), &own)
        .await
        .expect_err("a deny line needs its step");
    assert!(err.contains("no deny step"), "{err}");
}
