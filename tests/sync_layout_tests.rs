//! The mirror of a layout 2 organization: the organization repository and each registered
//! project's own repository, assembled at the entry's ref (T-2642, CC-86, PF-86).

use std::sync::Arc;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use joinedcontext_portal::git::GiteaClient;
use joinedcontext_portal::reconciler::Syncer;
use joinedcontext_portal::store::Mirror;
use serde_json::json;
use wiremock::matchers::{method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

const ORG: &str = "apiVersion: joinedcontext.com/v1alpha1\nkind: Organization\nmetadata:\n  \
                   name: banskabystrica\n  namespace: org\nspec:\n  domain: banskabystrica.sk\n  \
                   locales: [\"sk\"]\n  defaultLocale: sk\n";
const ENTRY: &str = "apiVersion: joinedcontext.com/v1alpha1\nkind: Project\nmetadata:\n  \
                     name: ovzdusie\n  namespace: org\nspec:\n  organizationRef: banskabystrica\n  \
                     repository: { name: ovzdusie }\n  ref: main\n";
const PROJECT: &str = "apiVersion: joinedcontext.com/v1alpha1\nkind: Project\nmetadata:\n  \
                       name: ovzdusie\n  namespace: org\nspec:\n  organizationRef: banskabystrica\n";
const SPACE: &str = "apiVersion: joinedcontext.com/v1alpha1\nkind: ContextSpace\nmetadata:\n  \
                     name: ovzdusie\n  namespace: ovzdusie\nspec:\n  isSandbox: false\n";

/// One repository of the forge at `git_ref`: its tree and each file's contents.
async fn repository(server: &MockServer, repo: &str, git_ref: &str, files: &[(&str, &str)]) {
    let base = format!("/api/v1/repos/test-owner/{repo}");
    let tree: Vec<_> = files
        .iter()
        .map(|(file, _)| json!({ "path": file, "type": "blob", "sha": format!("blob-{file}") }))
        .collect();
    Mock::given(method("GET"))
        .and(path(format!("{base}/git/trees/{git_ref}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "sha": "tree", "truncated": false, "tree": tree
        })))
        .mount(server)
        .await;
    for (file, body) in files {
        Mock::given(method("GET"))
            .and(path(format!("{base}/contents/{file}")))
            .and(query_param("ref", git_ref))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "sha": format!("blob-{file}"), "content": STANDARD.encode(body)
            })))
            .mount(server)
            .await;
    }
}

/// The organization repository `test-repo` of layout 2 at `c0ffee`, registering `ovzdusie`.
async fn organization(server: &MockServer) {
    let base = "/api/v1/repos/test-owner/test-repo";
    Mock::given(method("GET"))
        .and(path(base))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "default_branch": "main" })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path(format!("{base}/branches/main")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "name": "main", "commit": { "id": "c0ffee" }
        })))
        .mount(server)
        .await;
    repository(
        server,
        "test-repo",
        "c0ffee",
        &[
            ("org.yaml", ORG),
            (".jc/layout", "2\n"),
            ("projects/ovzdusie.yaml", ENTRY),
        ],
    )
    .await;
}

fn syncer(server: &MockServer) -> (Syncer, Arc<Mirror>) {
    let client = GiteaClient::new(
        server.uri().parse().expect("url"),
        "test-owner",
        "test-repo",
        "t",
    )
    .expect("client");
    let mirror = Arc::new(Mirror::new());
    (Syncer::new(Arc::new(client), Arc::clone(&mirror)), mirror)
}

/// CC-86: the project's manifests come from its own repository, mounted under its slug, and a
/// resource's source link opens the file in that repository, not in the organization's.
#[tokio::test]
async fn a_project_is_read_from_its_own_repository() {
    let server = MockServer::start().await;
    organization(&server).await;
    repository(
        &server,
        "ovzdusie",
        "main",
        &[
            (".jc/layout", "2\n"),
            ("project.yaml", PROJECT),
            ("spaces/ovzdusie/space.yaml", SPACE),
        ],
    )
    .await;
    let (syncer, mirror) = syncer(&server);
    syncer
        .sync_once()
        .await
        .expect("the organization assembles");

    let space = mirror
        .get("ovzdusie", "ContextSpace", "ovzdusie")
        .expect("the project's space is in the mirror");
    let source = space
        .status
        .as_ref()
        .and_then(|status| status.source_url.clone())
        .expect("a source link");
    // Behind the forge's sign-in, so the path travels encoded in `redirect_to`.
    let decoded = source.replace("%2F", "/");
    assert!(
        decoded.contains("/test-owner/ovzdusie/src/branch/main/spaces/ovzdusie/space.yaml"),
        "{source}"
    );
    assert!(
        mirror.get("org", "Project", "ovzdusie").is_some(),
        "the project is there"
    );
    assert_eq!(
        mirror.repository_of("ovzdusie").as_deref(),
        Some("ovzdusie"),
        "writes to the project go to its own repository (CC-87)"
    );
}

/// CC-86: a project repository that cannot be read leaves that project at its last render and
/// the organization syncs; the project is not unloaded.
#[tokio::test]
async fn an_unreadable_project_keeps_its_last_render() {
    let server = MockServer::start().await;
    organization(&server).await;
    repository(
        &server,
        "ovzdusie",
        "main",
        &[
            (".jc/layout", "2\n"),
            ("project.yaml", PROJECT),
            ("spaces/ovzdusie/space.yaml", SPACE),
        ],
    )
    .await;
    let (syncer, mirror) = syncer(&server);
    syncer.sync_once().await.expect("the first sync");
    assert!(mirror.get("ovzdusie", "ContextSpace", "ovzdusie").is_some());

    server.reset().await;
    organization(&server).await;
    syncer
        .sync_once()
        .await
        .expect("the organization still syncs");
    assert!(
        mirror.get("ovzdusie", "ContextSpace", "ovzdusie").is_some(),
        "the space the last assembly rendered stays"
    );
}
