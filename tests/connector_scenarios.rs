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
use joinedcontext_portal::resource::{ObjectMeta, ResourceEnvelope, ResourceKey, API_VERSION};
use joinedcontext_portal::server;
use joinedcontext_portal::state::AppState;
use joinedcontext_portal::store::Mirror;

#[path = "connector_scenarios/forge.rs"]
mod forge;
#[path = "connector_scenarios/model.rs"]
mod model;

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
    "T-5975", "T-5976", "T-5977", "T-5978", "T-5979", "T-5980", "T-5986", "T-5994", "T-5995",
    "T-5996", "T-5997", "T-5998",
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
    // The data itself: a steward's pipeline writes only into a space whose entities the steward
    // reads (PL-94).
    "Entity",
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
    /// A Portal REST call instead of an MCP one (`/api/v1` + path); `{connector}` stands for the
    /// connector this scenario created last.
    #[serde(default)]
    rest: Option<Rest>,
    /// `connector`: the MCP request goes to that connector's `/c/{id}` with a token for its address.
    #[serde(default)]
    via: Option<String>,
    /// The OAuth client the token is obtained by, when not `mcp-local`.
    #[serde(default)]
    client: Option<String>,
    /// A fixture change instead of a request: the persona loses their binding in the project, as
    /// a merged RoleBinding change leaves it.
    #[serde(default)]
    unbind: Option<String>,
    /// A member of the answer's `structuredContent` the later steps read as `{member}`, e.g.
    /// `planId` for the apply after a plan (T-5956).
    #[serde(default)]
    keep: Option<String>,
    /// A fixture change instead of a request: `Kind/name` of the step's project is edited
    /// behind the connector's back, as another person's merged change leaves it.
    #[serde(default)]
    touch: Option<String>,
    /// The call asks its Yellow-lane question first (AG-63): the person accepts it on the Portal
    /// page, recorded here in the question store the page writes, and the client sends the call
    /// again naming it (T-5997).
    #[serde(default)]
    accepted: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Rest {
    method: String,
    path: String,
    #[serde(default)]
    body: Value,
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
    slug_named(project, "counters")
}

/// The slug of the project's citizen reports Endpoint.
fn reports_slug_of(project: &str) -> String {
    slug_named(project, "reports")
}

fn slug_named(project: &str, what: &str) -> String {
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
    format!("{tail}{what}zzzzzzzzzzzzzzzzzz")
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
            "enabledRepresentations": ["ngsi-ld"]
        }),
    ));
    // Citizen reports whose model marks contactEmail personal (AG-158, S-55); a view without
    // history, so a temporal read of it is the "serves no history" refusal (S-04).
    mirror.upsert(envelope(
        "DataModel",
        "reports",
        project,
        json!({ "contextSpaceRef": "doprava", "linkml": "./reports.linkml.yaml" }),
    ));
    mirror.upsert(envelope(
        "Endpoint",
        &format!("{project}-reports"),
        project,
        json!({
            "slug": reports_slug_of(project),
            "contextSpaceRef": "doprava",
            "audience": "restricted",
            "title": format!("Citizen reports of {project}"),
            "entityTypes": ["PotholeReport"],
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
    // A change an apply opens: a merge request over the branch the forge below holds (T-5956).
    Mock::given(method("POST"))
        .and(path(format!("{REPO}/pulls")))
        .respond_with(ResponseTemplate::new(201).set_body_json(json!({
            "number": 77, "html_url": "https://gitea.example.sk/pulls/77", "state": "open",
            "mergeable": true, "merged": false
        })))
        .mount(server)
        .await;
    // Branches, trees and files with memory (T-5997): what an apply commits into a workspace is
    // what its comparison and bring-back read, and main holds S-45's space for its export.
    let repo = forge::Repo::new(REPO);
    repo.seed(
        "main",
        "projects/t-scn-45/spaces/doprava/space.yaml",
        &space.replace("t-scn-42", "t-scn-45"),
    );
    Mock::given(wiremock::matchers::path_regex(format!(
        "^{REPO}/(branches|contents|git/trees)(/.*)?$"
    )))
    .respond_with(repo)
    .with_priority(9)
    .mount(server)
    .await;
}

/// One LinkML text for every model of the fixture: the forge serves it at each model's path.
const MODELS_LINKML: &str = concat!(
    "id: https://example.sk/scenarios\n",
    "name: scenarios\n",
    "classes:\n",
    "  BikeCounter:\n",
    "    slots: [id, type, name, count, location]\n",
    "  PotholeReport:\n",
    "    slots: [id, type, description, contactEmail]\n",
    "slots:\n",
    "  contactEmail:\n",
    "    annotations: { personalData: true }\n",
);

/// The token the realm hands the Portal for a data read (RFC 8693): the gateway mocks answer it
/// alone, so a read with the Portal's own token, or with none, finds nothing.
const EXCHANGED: &str = "scn-exchanged-for-the-endpoint";

/// The realm's token exchange and the gateway's NGSI-LD reads of the fixture's Endpoints.
async fn data_plane(server: &MockServer) {
    use wiremock::matchers::{body_string_contains, header, path_regex, query_param};
    Mock::given(method("POST"))
        .and(path(format!("{REALM_PATH}/protocol/openid-connect/token")))
        .and(body_string_contains("token-exchange"))
        .and(body_string_contains("subject_token=ey"))
        .and(body_string_contains("scope=endpoint%3A"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "access_token": EXCHANGED, "token_type": "Bearer", "expires_in": 300,
            "issued_token_type": "urn:ietf:params:oauth:token-type:access_token"
        })))
        .mount(server)
        .await;
    let bearer = format!("Bearer {EXCHANGED}");
    let counter = |id: &str, count: u64, lon: f64, lat: f64| {
        json!({ "id": format!("urn:ngsi-ld:BikeCounter:{id}"), "type": "BikeCounter",
                "count": { "type": "Property", "value": count, "observedAt": "2026-10-27T10:00:00Z" },
                "location": { "type": "GeoProperty",
                              "value": { "type": "Point", "coordinates": [lon, lat] } } })
    };
    let counters = "^/api/endpoint/[a-z2-7]+counterszz+/ngsi-ld/v1";
    for (matcher, answer) in [
        (
            query_param("georel", "near;maxDistance==500"),
            json!([counter("snp", 42, 19.1462, 48.7361)]),
        ),
        (
            query_param("type", "BikeCounter"),
            json!([
                counter("snp", 42, 19.1462, 48.7361),
                counter("hron", 7, 19.13, 48.73)
            ]),
        ),
    ] {
        Mock::given(method("GET"))
            .and(path_regex(format!("{counters}/entities$")))
            .and(header("authorization", bearer.as_str()))
            .and(matcher)
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header(
                        "NGSILD-Results-Count",
                        answer.as_array().map_or(0, Vec::len).to_string().as_str(),
                    )
                    .set_body_json(answer),
            )
            .mount(server)
            .await;
    }
    Mock::given(method("GET"))
        .and(path_regex(format!("{counters}/temporal/entities$")))
        .and(header("authorization", bearer.as_str()))
        .and(query_param("aggrMethods", "avg"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([{
            "id": "urn:ngsi-ld:BikeCounter:snp", "type": "BikeCounter",
            "count": { "type": "Property", "avg": [[21.5, "2026-10-27T10:00:00Z", "2026-10-27T11:00:00Z"]] }
        }])))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path_regex(
            "^/api/endpoint/[a-z2-7]+reportszz+/ngsi-ld/v1/entities$",
        ))
        .and(header("authorization", bearer.as_str()))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([{
            "id": "urn:ngsi-ld:PotholeReport:1", "type": "PotholeReport",
            "description": { "type": "Property", "value": "Hlboká jama pri zastávke" },
            "contactEmail": { "type": "Property", "value": "jana@example.org" }
        }])))
        .mount(server)
        .await;
    use base64::Engine;
    Mock::given(method("GET"))
        .and(path_regex(
            r"^/api/v1/repos/test-owner/test-repo/contents/.*\.linkml\.yaml$",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "sha": "blob-models",
            "content": base64::engine::general_purpose::STANDARD.encode(MODELS_LINKML)
        })))
        .mount(server)
        .await;
}

struct Harness {
    app: axum::Router,
    issuer: String,
    signer: EncodingKey,
    mirror: std::sync::Arc<Mirror>,
    /// The Portal's state, for what a person decides on a Portal page with their session.
    state: AppState,
    /// The connector the running scenario created last.
    connector: std::sync::Mutex<Option<String>>,
    /// What `keep` steps remembered, by member name.
    kept: std::sync::Mutex<BTreeMap<String, String>>,
    /// The forge, CSV source and identity provider; the model lane counts the forge writes.
    server: &'static MockServer,
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
        data_plane(server).await;
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
        config.gateway_url = Some(server.uri());

        let mirror = std::sync::Arc::new(Mirror::new());
        let names: Vec<String> = (1..=projects).map(project_of).collect();
        for project in names.iter().map(String::as_str).chain([OTHER]) {
            seed_project(&mirror, project, &csv_url);
        }
        bind_personas(&mirror, &names);
        let state = AppState::from_config(config)
            .await
            .expect("state")
            .with_mirror(mirror.clone())
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
            app: server::app(state.clone()),
            issuer,
            signer,
            mirror,
            state,
            connector: std::sync::Mutex::default(),
            kept: std::sync::Mutex::default(),
            server,
        }
    }

    /// The persona's token, as the connector client obtains it; `None` for anonymous.
    fn token(&self, persona: &str) -> Option<String> {
        self.token_for(persona, AUDIENCE, CLIENT)
    }

    /// The persona's token for `audience`, obtained by `client`.
    fn token_for(&self, persona: &str, audience: &str, client: &str) -> Option<String> {
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
            "aud": audience,
            "azp": client,
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
        let token = self.token(persona);
        self.send("POST", "/api/v1/mcp", token, Some(body)).await
    }

    /// One HTTP request with an optional bearer: the status and the body.
    async fn send(
        &self,
        method: &str,
        uri: &str,
        token: Option<String>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(token) = token {
            request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        let response = self
            .app
            .clone()
            .oneshot(
                request
                    .body(body.map_or_else(Body::empty, |b| Body::from(b.to_string())))
                    .expect("request"),
            )
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
        let connector = self
            .connector
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
            .unwrap_or_default();
        let in7days = (chrono::Utc::now() + chrono::Duration::days(7)).to_rfc3339();
        let kept = self.kept.lock().unwrap_or_else(|p| p.into_inner()).clone();
        let fill = |text: &str| {
            let mut text = text
                .replace("{project}", project)
                .replace("{connector}", &connector)
                .replace("{in7days}", &in7days);
            for (member, value) in &kept {
                text = text.replace(&format!("{{{member}}}"), value);
            }
            text
        };
        if let Some(target) = &step.touch {
            let (kind, name) = target
                .split_once('/')
                .ok_or_else(|| format!("touch `{target}` is not Kind/name"))?;
            let mut envelope = self
                .mirror
                .get(project, kind, &fill(name))
                .ok_or_else(|| format!("touch: no {target} in {project}"))?;
            envelope
                .metadata
                .labels
                .insert("edited-by".to_owned(), "another-person".to_owned());
            self.mirror.upsert(envelope);
            return Ok(());
        }
        if let Some(who) = &step.unbind {
            let key = ResourceKey {
                namespace: ORG_NAMESPACE.to_owned(),
                kind: "RoleBinding".to_owned(),
                name: format!("scn-{who}-{project}"),
            };
            return match self.mirror.remove(&key) {
                Some(_) => Ok(()),
                None => Err(format!("unbind: {who} holds no binding in {project}")),
            };
        }
        if let Some(rest) = &step.rest {
            let body = serde_json::from_str::<Value>(&fill(&rest.body.to_string()))
                .map_err(|e| format!("rest body: {e}"))?;
            let uri = format!("/api/v1{}", fill(&rest.path));
            // A person manages connectors in the Portal, whose own client obtains the token; an
            // MCP client's token is refused on these routes (AG-151).
            let token = self.token_for(
                persona,
                AUDIENCE,
                step.client.as_deref().unwrap_or(AUDIENCE),
            );
            let (status, answer) = self
                .send(&rest.method, &uri, token, (!body.is_null()).then_some(body))
                .await;
            if status == StatusCode::CREATED {
                if let Some(id) = answer["id"].as_str() {
                    *self.connector.lock().unwrap_or_else(|p| p.into_inner()) = Some(id.to_owned());
                }
            }
            let what = format!("{} {uri}", rest.method);
            return judged(
                step,
                &what,
                persona,
                project,
                status.is_client_error(),
                &answer.to_string(),
                &fill,
            );
        }
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
        let (status, answer) = match step.via.as_deref() {
            None if step.accepted => {
                let (_, asked) = self.rpc(persona, body.clone()).await;
                let id = asked["result"]["structuredContent"]["elicitation"]["elicitationId"]
                    .as_str()
                    .ok_or_else(|| format!("accepted: no question asked in {asked}"))?;
                self.state
                    .mcp_elicitations
                    .decide(
                        &format!("sub-scn-{persona}"),
                        project,
                        id,
                        joinedcontext_portal::mcp::elicitation::ElicitationDecision::Accept,
                    )
                    .ok_or_else(|| format!("accepted: question {id} is not open"))?;
                let mut again = body;
                again["params"]["elicitation"] = json!({ "elicitationId": id });
                self.rpc(persona, again).await
            }
            None => self.rpc(persona, body).await,
            Some("connector") => {
                let address = format!("https://portal.test/c/{connector}");
                let client = step.client.as_deref().unwrap_or(CLIENT);
                let token = self.token_for(persona, &address, client);
                self.send("POST", &format!("/c/{connector}"), token, Some(body))
                    .await
            }
            Some(other) => return Err(format!("via `{other}` is not connector")),
        };
        let refused = match status {
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => true,
            StatusCode::NOT_FOUND if step.via.is_some() => true,
            StatusCode::OK => {
                answer["result"]["isError"] == json!(true) || !answer["error"].is_null()
            }
            other => return Err(format!("the door answered {other}: {answer}")),
        };
        if let Some(member) = &step.keep {
            let value = answer["result"]["structuredContent"][member.as_str()]
                .as_str()
                .ok_or_else(|| format!("keep: no {member} in {answer}"))?;
            self.kept
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(member.clone(), escaped(value));
        }
        let what = step.call.as_deref().unwrap_or("tools/list");
        // A tools/list step judges tool names, a call the whole answer.
        let text = if step.call.is_none() && !refused {
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
        judged(step, what, persona, project, refused, &text, &fill)
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

/// A kept value as it stands inside a JSON string: the later steps fill it into their args'
/// JSON text, and a bundle's newlines and quotes stay one string there.
fn escaped(value: &str) -> String {
    let quoted = Value::from(value).to_string();
    quoted[1..quoted.len() - 1].to_owned()
}

/// Whether one answer holds what its step asks: the refusal, and the texts present and absent.
fn judged(
    step: &Step,
    what: &str,
    persona: &str,
    project: &str,
    refused: bool,
    text: &str,
    fill: &dyn Fn(&str) -> String,
) -> Result<(), String> {
    if refused != step.refused {
        return Err(format!(
            "{what} as {persona} in {project}: refused={refused}, want {}: {text}",
            step.refused
        ));
    }
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

/// The connector door's refusals in API/14 §3 order, and the management routes' own (T-5950).
#[tokio::test]
async fn the_connector_door_refuses_in_order_and_audits_without_secrets() {
    let harness = Harness::start(1).await;
    let own = project_of(1);
    let expires = (chrono::Utc::now() + chrono::Duration::days(7)).to_rfc3339();
    let ask = |name: &str| {
        json!({ "name": name, "segments": ["data-read"],
                "scope": [{ "project": own, "access": "read" }], "expiresAt": expires })
    };
    let portal = |persona: &str| harness.token_for(persona, AUDIENCE, AUDIENCE);
    let (status, a) = harness
        .send(
            "POST",
            "/api/v1/connectors",
            portal("viewer"),
            Some(ask("a")),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{a}");
    let (_, b) = harness
        .send(
            "POST",
            "/api/v1/connectors",
            portal("viewer"),
            Some(ask("b")),
        )
        .await;
    let (a, b) = (a["id"].as_str().expect("id"), b["id"].as_str().expect("id"));
    let door = |id: &str| format!("/c/{id}");
    let address = |id: &str| format!("https://portal.test/c/{id}");
    let list = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {} });

    // An MCP client's token creates no connector (AG-151), and neither does a dry run of one.
    let mcp = harness.token("viewer");
    let (status, _) = harness
        .send("POST", "/api/v1/connectors", mcp.clone(), Some(ask("c")))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, body) = harness
        .send(
            "POST",
            "/api/v1/connectors?dryRun=All",
            portal("viewer"),
            Some(ask("c")),
        )
        .await;
    assert_eq!((status, &body), (StatusCode::OK, &json!({ "valid": true })));

    // No bearer: 401 naming the connector's own metadata.
    let response = harness
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(door(a))
                .body(Body::from(list.to_string()))
                .expect("request"),
        )
        .await
        .expect("answer");
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let challenge = response.headers()[header::WWW_AUTHENTICATE]
        .to_str()
        .expect("text");
    assert!(
        challenge.contains(&format!(
            "{}/.well-known/oauth-protected-resource",
            address(a)
        )),
        "{challenge}"
    );
    let (status, meta) = harness
        .send(
            "GET",
            &format!("{}/.well-known/oauth-protected-resource", door(a)),
            None,
            None,
        )
        .await;
    assert_eq!(
        (status, meta["resource"].as_str()),
        (StatusCode::OK, Some(address(a).as_str()))
    );

    // A Portal token, and a token for connector b, are no tokens for connector a.
    for token in [
        portal("viewer"),
        mcp.clone(),
        harness.token_for("viewer", &address(b), CLIENT),
    ] {
        let (status, _) = harness
            .send("POST", &door(a), token, Some(list.clone()))
            .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
    // A connector's token is no token for the management routes either.
    let token_a = harness.token_for("viewer", &address(a), CLIENT);
    let (status, _) = harness
        .send("GET", "/api/v1/connectors", token_a.clone(), None)
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // Another person's token for a's address gets the answer of an id that does not exist.
    let unknown = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
    let (status, other) = harness
        .send(
            "POST",
            &door(a),
            harness.token_for("steward", &address(a), CLIENT),
            Some(list.clone()),
        )
        .await;
    let (status_unknown, none) = harness
        .send(
            "POST",
            &door(unknown),
            harness.token_for("viewer", &address(unknown), CLIENT),
            Some(list.clone()),
        )
        .await;
    assert_eq!((status, &other), (StatusCode::NOT_FOUND, &none));
    assert_eq!(status_unknown, StatusCode::NOT_FOUND);

    // Resources and prompts read past the scope check: a connector serves tools only.
    let read = json!({ "jsonrpc": "2.0", "id": 2, "method": "resources/read",
                       "params": { "uri": format!("jc://{own}/endpoints/{own}-counters") } });
    let (status, answer) = harness
        .send("POST", &door(a), token_a.clone(), Some(read))
        .await;
    assert_eq!(
        (status, answer["error"]["code"].as_i64()),
        (StatusCode::OK, Some(-32601))
    );
    let (status, answer) = harness
        .send("POST", &door(a), token_a.clone(), Some(list.clone()))
        .await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert!(answer.to_string().contains("jc_resource_list"), "{answer}");

    // The audit names who, which client, what and the verdict; never the token.
    let (status, calls) = harness
        .send(
            "GET",
            &format!("/api/v1/connectors/{a}/activity"),
            portal("viewer"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let text = calls.to_string();
    for want in [
        "refused: not the owner",
        "sub-scn-steward",
        "refused: method",
        "\"tool\":\"tools/list\"",
        "allowed",
    ] {
        assert!(text.contains(want), "{want} missing from {text}");
    }
    let token_text = token_a.expect("token");
    assert!(
        !text.contains(&token_text) && !text.contains("eyJ"),
        "{text}"
    );
    // The activity of another person's connector is the same 404.
    let (status, _) = harness
        .send(
            "GET",
            &format!("/api/v1/connectors/{a}/activity"),
            portal("steward"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = harness
        .send(
            "DELETE",
            &format!("/api/v1/connectors/{a}"),
            portal("steward"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, mine) = harness
        .send("GET", "/api/v1/connectors", portal("viewer"), None)
        .await;
    assert_eq!(
        (status, mine["items"].as_array().map(Vec::len)),
        (StatusCode::OK, Some(2))
    );
}

/// The "My connectors" tree lists only what the person reads, and create asks again per item
/// (T-5951): a reader bound to one space sees that space's objects, and naming another space's
/// Endpoint is refused with the field named, the same answer as an Endpoint that is not there.
#[tokio::test]
async fn the_connector_tree_lists_only_what_the_person_reads_and_create_asks_again() {
    let harness = Harness::start(1).await;
    let own = project_of(1);
    harness
        .mirror
        .upsert(envelope("ContextSpace", "lot-tree", &own, json!({})));
    harness.mirror.upsert(envelope(
        "Endpoint",
        "lot-tree-cars",
        &own,
        json!({ "contextSpaceRef": "lot-tree", "audience": "project" }),
    ));
    harness.mirror.upsert(envelope(
        "Pipeline",
        "lot-tree-load",
        &own,
        json!({ "contextSpaceRef": "lot-tree" }),
    ));
    let key = ResourceKey {
        namespace: ORG_NAMESPACE.to_owned(),
        kind: "RoleBinding".to_owned(),
        name: format!("scn-viewer-{own}"),
    };
    harness.mirror.remove(&key).expect("viewer binding");
    harness.mirror.upsert(envelope(
        "RoleBinding",
        "scn-viewer-lot-tree",
        ORG_NAMESPACE,
        json!({ "subjects": [{ "user": user_of("viewer") }], "role": "scn-viewer",
                "scope": { "contextSpace": "lot-tree" } }),
    ));
    let portal = harness.token_for("viewer", AUDIENCE, AUDIENCE);

    let (status, options) = harness
        .send("GET", "/api/v1/connectors/options", portal.clone(), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{options}");
    assert_eq!(
        options["projects"],
        json!([{ "project": own, "spaces": ["lot-tree"], "endpoints": ["lot-tree-cars"],
                 "pipelines": ["lot-tree-load"] }])
    );
    assert_eq!(
        options["ceiling"],
        json!({ "segments": ["data-read"], "writes": false, "maxDays": 30 })
    );
    assert_eq!(options["segments"].as_array().map(Vec::len), Some(8));
    assert_eq!(
        options["clients"][2],
        json!({ "id": "mcp-local", "isBoundary": false })
    );

    let expires = (chrono::Utc::now() + chrono::Duration::days(7)).to_rfc3339();
    let ask = |endpoint: &str| {
        json!({ "name": "tree", "segments": ["data-read"], "expiresAt": expires,
                "scope": [{ "project": own, "endpoint": endpoint, "access": "read" }] })
    };
    let mut refusals = Vec::new();
    for endpoint in [format!("{own}-counters"), "no-such-endpoint".to_owned()] {
        let (status, body) = harness
            .send(
                "POST",
                "/api/v1/connectors",
                portal.clone(),
                Some(ask(&endpoint)),
            )
            .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert_eq!(
            body["errors"][0]["path"],
            json!("scope[0].endpoint"),
            "{body}"
        );
        refusals.push(body["detail"].as_str().map(|d| d.replace(&endpoint, "_")));
    }
    assert_eq!(
        refusals[0], refusals[1],
        "an unreadable Endpoint reads like a missing one"
    );
    let (status, body) = harness
        .send(
            "POST",
            "/api/v1/connectors",
            portal.clone(),
            Some(ask("lot-tree-cars")),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let id = body["id"].as_str().expect("id").to_owned();
    let door = format!("/api/v1/connectors/{id}");

    // An edit is checked as a create is: another space's Endpoint is refused naming the field,
    // a whole project the owner reads and a later expiry pass; the name stays.
    let (status, refused) = harness
        .send(
            "PATCH",
            &door,
            portal.clone(),
            Some(json!({ "scope": [{ "project": own, "endpoint": format!("{own}-counters"), "access": "read" }] })),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{refused}");
    assert_eq!(refused["errors"][0]["path"], json!("scope[0].endpoint"));
    let (status, refused) = harness
        .send(
            "PATCH",
            &door,
            portal.clone(),
            Some(json!({ "segments": ["admin"] })),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
    let (status, refused) = harness
        .send(
            "PATCH",
            &door,
            portal.clone(),
            Some(json!({ "name": "renamed" })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
    let later = (chrono::Utc::now() + chrono::Duration::days(20)).to_rfc3339();
    let (status, edited) = harness
        .send(
            "PATCH",
            &door,
            portal.clone(),
            Some(json!({ "scope": [{ "project": own, "access": "read" }], "expiresAt": later })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{edited}");
    assert_eq!(
        (&edited["name"], &edited["scope"]),
        (
            &json!("tree"),
            &json!([{ "project": own, "access": "read" }])
        )
    );
    // Another person's connector is the same 404 as none; a revoked one is not edited.
    let (status, _) = harness
        .send(
            "PATCH",
            &door,
            harness.token_for("steward", AUDIENCE, AUDIENCE),
            Some(json!({ "writes": false })),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = harness.send("DELETE", &door, portal.clone(), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = harness
        .send(
            "PATCH",
            &door,
            portal.clone(),
            Some(json!({ "writes": false })),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // No session: 401.
    let (status, _) = harness
        .send("GET", "/api/v1/connectors/options", None, None)
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

/// T-5956, AG-149: an apply takes only its own plan, once, with the base it was planned on; and it
/// opens a change request a person approves, never an approval.
#[tokio::test]
async fn an_apply_takes_only_its_own_unchanged_plan_and_never_approves() {
    let harness = Harness::start(1).await;
    let own = project_of(1);
    let scenario = |script: Value| -> Scenario {
        serde_json::from_value(json!({
            "id": "S-00", "segment": "context", "as": "steward", "says": "selftest",
            "expect": "selftest", "deny": "selftest", "script": script
        }))
        .expect("scenario")
    };
    let plan = json!({ "proves": "expect", "call": "jc_change_plan", "keep": "planId",
        "args": { "changes": [{ "op": "patch", "kind": "ContextSpace", "name": "doprava",
                                "patch": { "spec": { "isSandbox": false } } }] },
        "contains": ["\"planId\"", "spec.isSandbox"] });
    let apply = |extra: Value| {
        let mut step = json!({ "proves": "deny", "call": "jc_change_apply",
                               "args": { "planId": "{planId}" } });
        for (k, v) in extra.as_object().expect("object") {
            step[k] = v.clone();
        }
        step
    };
    // The base moved between plan and apply: 409, nothing opened.
    let moved = json!([
        plan,
        { "proves": "deny", "touch": "ContextSpace/doprava" },
        apply(json!({ "refused": true, "contains": ["\"status\":409", "ContextSpace doprava changed"] }))
    ]);
    assert_eq!(harness.run(&scenario(moved), &own).await, Ok(()));
    // Planned by the steward, applied by another person: not there for them, and still there
    // for the steward, who applies it once.
    let other = json!([
        plan,
        apply(json!({ "as": "project-admin", "refused": true, "contains": ["is not there"] })),
        apply(
            json!({ "proves": "expect", "contains": ["changeRequests", "pulls/77"],
                      "absent": ["\"merged\"", "\"phase\":\"approved\""] })
        ),
        apply(json!({ "refused": true, "contains": ["is not there"] }))
    ]);
    assert_eq!(harness.run(&scenario(other), &own).await, Ok(()));
    // A plan for another project's object is refused before any check runs.
    let elsewhere = json!([
        { "proves": "expect", "call": "jc_change_plan", "project": "other", "refused": true,
          "args": { "changes": [{ "op": "patch", "kind": "ContextSpace", "name": "doprava",
                                  "patch": { "spec": { "isSandbox": false } } }] } },
        { "proves": "deny", "call": "jc_change_plan", "refused": true,
          "args": { "changes": [{ "op": "create", "kind": "ContextSpace", "name": "doprava",
                                  "manifest": { "kind": "ContextSpace" } }] },
          "contains": ["/changes/0/op"] }
    ]);
    assert_eq!(harness.run(&scenario(elsewhere), &own).await, Ok(()));
}

/// A flood of one connector stops at its own minute; a person's connectors together stop at the
/// person's (T-5968). Each refusal is a 429 problem+json with `Retry-After`, audited, and the
/// connector shows its limits.
#[tokio::test]
async fn a_flood_hits_429_at_the_connector_and_then_the_person_limit() {
    let harness = Harness::start(1).await;
    let own = project_of(1);
    let expires = (chrono::Utc::now() + chrono::Duration::days(7)).to_rfc3339();
    let portal = harness.token_for("viewer", AUDIENCE, AUDIENCE);
    let mut ids = Vec::new();
    for name in ["a", "b", "c"] {
        let ask = json!({ "name": name, "segments": ["data-read"],
                          "scope": [{ "project": own, "access": "read" }], "expiresAt": expires });
        let (status, made) = harness
            .send("POST", "/api/v1/connectors", portal.clone(), Some(ask))
            .await;
        assert_eq!(status, StatusCode::CREATED, "{made}");
        assert_eq!(
            made["limits"],
            json!({ "callsPerMinute": 60, "parallelCalls": 4, "resultBytes": 1_048_576 })
        );
        ids.push(made["id"].as_str().expect("id").to_owned());
    }
    let ping = json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" });
    let call = |id: &str| {
        let token = harness
            .token_for("viewer", &format!("https://portal.test/c/{id}"), CLIENT)
            .expect("token");
        harness.app.clone().oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/c/{id}"))
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(ping.to_string()))
                .expect("request"),
        )
    };
    let refusal = |response: axum::response::Response| async move {
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        let body: Value = serde_json::from_slice(&bytes).expect("json");
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
        assert_eq!(headers[header::CONTENT_TYPE], "application/problem+json");
        let wait: i64 = headers[header::RETRY_AFTER]
            .to_str()
            .expect("text")
            .parse()
            .expect("seconds");
        assert!((1..=60).contains(&wait), "{wait}");
        body["detail"].as_str().expect("detail").to_owned()
    };
    for (index, id) in ids.iter().take(2).enumerate() {
        for n in 0..60 {
            let response = call(id).await.expect("answer");
            assert_eq!(response.status(), StatusCode::OK, "{id} call {n}");
        }
        let detail = refusal(call(id).await.expect("answer")).await;
        if index == 0 {
            assert!(detail.contains("this connector made 60 calls"), "{detail}");
        } else {
            // b's 61st is past both: the person's shared minute is named first.
            assert!(detail.contains("over all your connectors"), "{detail}");
        }
    }
    // a and b spent the person's 120: c, never called, is refused at its first call.
    let detail = refusal(call(&ids[2]).await.expect("answer")).await;
    assert!(detail.contains("120 MCP calls"), "{detail}");
    let (status, calls) = harness
        .send(
            "GET",
            &format!("/api/v1/connectors/{}/activity", ids[2]),
            portal,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(calls.to_string().contains("refused: rate limit"), "{calls}");
}
