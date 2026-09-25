//! A build pod per App (AP-130, AP-131, T-2794).
//!
//! One pass runs against a stub that answers as both the forge and the API server, so what is
//! asserted is what leaves the Portal: a registration token of the App's own repository, a Job
//! and a claim named after the App, the token in a Secret its Job owns, nothing for a job that
//! is not an App's build, and no cache left behind by an App that is gone.

use joinedcontext_portal::apps::build_pods::{dispatch_once, Settings};
use joinedcontext_portal::apps::kube::KubeClient;
use joinedcontext_portal::git::GiteaClient;
use joinedcontext_portal::resource::{ObjectMeta, ResourceEnvelope, API_VERSION};
use joinedcontext_portal::store::Mirror;
use serde_json::{json, Value};
use wiremock::matchers::{method, path, query_param};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

const NS: &str = "dev";
const REGISTRATION: &str = "repository-scoped-registration-token";

fn settings() -> Settings {
    Settings {
        namespace: NS.into(),
        forge: "http://gitea-http.dev.svc.cluster.local:3000".into(),
        node_image: "r.example.org/builder@sha256:aa".into(),
        rust_image: "r.example.org/builder-rust@sha256:bb".into(),
        cache_size: "1Gi".into(),
    }
}

fn mirror(apps: &[(&str, &str)]) -> Mirror {
    let mirror = Mirror::new();
    for (project, app) in apps {
        mirror.upsert(ResourceEnvelope {
            api_version: API_VERSION.to_owned(),
            kind: "App".into(),
            metadata: ObjectMeta::new(*app, *project),
            spec: json!({ "kind": "static" }),
            status: None,
        });
    }
    mirror
}

fn clients(server: &MockServer) -> (KubeClient, GiteaClient) {
    let kube = KubeClient::with_token(&server.uri(), "portal-sa-token").expect("a kube client");
    let forge = GiteaClient::new(
        server.uri().parse().expect("a url"),
        "joinedcontext",
        "configuration",
        "forge-token",
    )
    .expect("a forge client");
    (kube, forge)
}

fn queued(jobs: Value) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(json!({ "total_count": 1, "jobs": jobs }))
}

fn job(id: u64, repo: &str, label: &str) -> Value {
    json!({
        "id": id,
        "labels": [label],
        "status": "queued",
        "url": format!("http://gitea-http.dev.svc.cluster.local:3000/api/v1/repos/joinedcontext/{repo}/actions/jobs/{id}"),
    })
}

async fn no_claims(server: &MockServer) {
    Mock::given(method("GET"))
        .and(path(format!(
            "/api/v1/namespaces/{NS}/persistentvolumeclaims"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "items": [] })))
        .mount(server)
        .await;
}

fn body(request: &Request) -> Value {
    serde_json::from_slice(&request.body).expect("a JSON body")
}

#[tokio::test]
async fn a_queued_app_build_gets_one_pod_its_own_cache_and_its_repositorys_token() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/orgs/joinedcontext/actions/jobs"))
        .and(query_param("status", "queued"))
        .respond_with(queued(json!([job(42, "helsinki_bikes", "app-build-node")])))
        .mount(&server)
        .await;
    // The first read finds no Job; the one after the apply finds it with its uid.
    Mock::given(method("GET"))
        .and(path(format!(
            "/apis/batch/v1/namespaces/{NS}/jobs/build-bikes-42"
        )))
        .respond_with(ResponseTemplate::new(404))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path(format!(
            "/apis/batch/v1/namespaces/{NS}/jobs/build-bikes-42"
        )))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(
                json!({ "metadata": { "name": "build-bikes-42", "uid": "0f6c-uid" } }),
            ),
        )
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path(
            "/api/v1/repos/joinedcontext/helsinki_bikes/actions/runners/registration-token",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "token": REGISTRATION })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("PATCH"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .mount(&server)
        .await;
    no_claims(&server).await;

    let (kube, forge) = clients(&server);
    let pass = dispatch_once(
        &kube,
        &forge,
        &mirror(&[("helsinki", "bikes")]),
        &settings(),
    )
    .await
    .expect("the pass");
    assert_eq!(pass.started, ["build-bikes-42"]);

    let requests = server.received_requests().await.expect("recorded");
    let applied: Vec<(String, Value)> = requests
        .iter()
        .filter(|r| r.method.as_str() == "PATCH")
        .map(|r| (r.url.path().to_owned(), body(r)))
        .collect();
    let paths: Vec<&str> = applied.iter().map(|(p, _)| p.as_str()).collect();
    assert_eq!(
        paths,
        [
            "/api/v1/namespaces/dev/persistentvolumeclaims/build-cache-bikes",
            "/apis/batch/v1/namespaces/dev/jobs/build-bikes-42",
            "/api/v1/namespaces/dev/secrets/build-bikes-42",
        ],
        "the claim and the Job first, the token last and owned by the Job"
    );
    let pod = &applied[1].1["spec"]["template"]["spec"];
    assert_eq!(
        pod["containers"][0]["image"],
        "r.example.org/builder@sha256:aa"
    );
    assert_eq!(
        pod["volumes"][4]["persistentVolumeClaim"]["claimName"],
        "build-cache-bikes"
    );
    assert!(
        !applied[1].1.to_string().contains(REGISTRATION),
        "the Job carries no token, only the name of its Secret"
    );
    let secret = &applied[2].1;
    assert_eq!(secret["stringData"]["token"], REGISTRATION);
    assert_eq!(secret["metadata"]["ownerReferences"][0]["uid"], "0f6c-uid");
}

#[tokio::test]
async fn a_job_that_is_not_an_apps_build_gets_nothing() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/orgs/joinedcontext/actions/jobs"))
        .respond_with(queued(json!([
            // The propose job stays on the shared runner.
            job(1, "helsinki_bikes", "node-22"),
            // A repository that looks like an App's and is none.
            job(2, "helsinki_ghost", "app-build-node"),
            // Another organization's repository.
            json!({ "id": 3, "labels": ["app-build-node"], "url": "http://f/api/v1/repos/other/helsinki_bikes/actions/jobs/3" }),
        ])))
        .mount(&server)
        .await;
    no_claims(&server).await;

    let (kube, forge) = clients(&server);
    let pass = dispatch_once(
        &kube,
        &forge,
        &mirror(&[("helsinki", "bikes")]),
        &settings(),
    )
    .await
    .expect("the pass");
    assert!(pass.started.is_empty());
    let requests = server.received_requests().await.expect("recorded");
    assert!(
        requests.iter().all(|r| r.method.as_str() == "GET"),
        "no token minted, nothing applied: {:?}",
        requests.iter().map(|r| r.url.path()).collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn a_job_left_without_its_token_is_removed_with_its_pods_for_the_next_pass() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/orgs/joinedcontext/actions/jobs"))
        .respond_with(queued(json!([job(42, "helsinki_bikes", "app-build-rust")])))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path(format!(
            "/apis/batch/v1/namespaces/{NS}/jobs/build-bikes-42"
        )))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({ "metadata": { "uid": "u" } })),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path(format!(
            "/api/v1/namespaces/{NS}/secrets/build-bikes-42"
        )))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;
    Mock::given(method("DELETE"))
        .and(path(format!(
            "/apis/batch/v1/namespaces/{NS}/jobs/build-bikes-42"
        )))
        .and(query_param("propagationPolicy", "Background"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .expect(1)
        .mount(&server)
        .await;
    no_claims(&server).await;

    let (kube, forge) = clients(&server);
    let pass = dispatch_once(
        &kube,
        &forge,
        &mirror(&[("helsinki", "bikes")]),
        &settings(),
    )
    .await
    .expect("the pass");
    assert!(
        pass.started.is_empty(),
        "started on the next pass, not this one"
    );
}

#[tokio::test]
async fn a_retired_apps_cache_goes_and_a_live_apps_stays() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/orgs/joinedcontext/actions/jobs"))
        .respond_with(queued(json!([])))
        .mount(&server)
        .await;
    let claim = |app: &str| {
        json!({ "metadata": {
            "name": format!("build-cache-{app}"),
            "labels": { "joinedcontext.com/build-app": app, "app.kubernetes.io/component": "build-pod" }
        }})
    };
    Mock::given(method("GET"))
        .and(path(format!(
            "/api/v1/namespaces/{NS}/persistentvolumeclaims"
        )))
        .and(query_param(
            "labelSelector",
            "app.kubernetes.io/component=build-pod,joinedcontext.com/build-app",
        ))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(
                json!({ "items": [claim("bikes"), claim("retired"), claim("old")] }),
            ),
        )
        .mount(&server)
        .await;
    Mock::given(method("DELETE"))
        .and(path(format!(
            "/api/v1/namespaces/{NS}/persistentvolumeclaims/build-cache-retired"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .expect(1)
        .mount(&server)
        .await;
    // An App the mirror still holds as `retired` loses its cache as one that is gone does.
    Mock::given(method("DELETE"))
        .and(path(format!(
            "/api/v1/namespaces/{NS}/persistentvolumeclaims/build-cache-old"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .expect(1)
        .mount(&server)
        .await;

    let (kube, forge) = clients(&server);
    let apps = mirror(&[("helsinki", "bikes")]);
    apps.upsert(ResourceEnvelope {
        api_version: API_VERSION.to_owned(),
        kind: "App".into(),
        metadata: ObjectMeta::new("old", "helsinki"),
        spec: json!({ "kind": "static", "lifecycle": "retired" }),
        status: None,
    });
    let pass = dispatch_once(&kube, &forge, &apps, &settings())
        .await
        .expect("the pass");
    assert_eq!(pass.removed, ["build-cache-retired", "build-cache-old"]);

    // A mirror that holds no App yet deletes nothing: a restart never empties the caches.
    let empty = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/orgs/joinedcontext/actions/jobs"))
        .respond_with(queued(json!([])))
        .mount(&empty)
        .await;
    let (kube, forge) = clients(&empty);
    let pass = dispatch_once(&kube, &forge, &mirror(&[]), &settings())
        .await
        .expect("the pass");
    assert!(pass.removed.is_empty());
    let requests = empty.received_requests().await.expect("recorded");
    assert_eq!(requests.len(), 1, "only the queue was read");
}
