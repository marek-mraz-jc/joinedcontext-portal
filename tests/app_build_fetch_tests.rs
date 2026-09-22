//! AP-102: every replica fetches the build `status.build` names from the package registry, checks
//! its SHA-256 before a byte is unpacked, and serves it from `{apps_cache_dir}/{name}/{hex}/`;
//! a package that does not match the digest installs nothing, and the previous bundle keeps
//! serving (AP-72).

mod common;

use sha2::{Digest, Sha256};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use joinedcontext_portal::apps::fetch::fetch_missing;
use joinedcontext_portal::git::GiteaClient;
use joinedcontext_portal::store::Mirror;

const COMMIT: &str = "8c56954a1f0e3d2c1b0a99887766554433221100";
const BUNDLE: &str = "/api/packages/test-owner/generic/app-air-quality/8c56954a1f0e3d2c1b0a99887766554433221100/bundle.tar.gz";

/// `bundle.tar.gz` as the lane packs it: `tar -C bundle -cf - .`, gzipped.
fn bundle(index: &[u8]) -> Vec<u8> {
    let mut builder = tar::Builder::new(Vec::new());
    let mut header = tar::Header::new_gnu();
    header.set_size(index.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();
    builder
        .append_data(&mut header, "./index.html", index)
        .expect("tar entry");
    let tar = builder.into_inner().expect("tar");
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    std::io::Write::write_all(&mut gz, &tar).expect("gzip");
    gz.finish().expect("gzip")
}

fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

/// A mirror holding the App `air-quality` whose lane wrote back `digest` at `COMMIT`.
fn mirror_naming(digest: &str) -> Mirror {
    let mirror = Mirror::new();
    let mut app = common::envelope(
        "App",
        "air-quality",
        "ovzdusie",
        serde_json::json!({ "kind": "static" }),
    );
    app.status = Some(joinedcontext_portal::resource::Status {
        phase: joinedcontext_portal::resource::Phase::Live,
        observed_revision: None,
        source_url: None,
        conditions: Vec::new(),
        build: Some(jc_core::Build {
            digest: digest.to_owned(),
            commit: COMMIT.to_owned(),
            sdk_version: "0.4.1".to_owned(),
            built_at: chrono::Utc::now(),
        }),
        domain_verification: None,
    });
    mirror.upsert(app);
    mirror
}

async fn forge_holding(bytes: Vec<u8>) -> (MockServer, GiteaClient) {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(BUNDLE))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(bytes))
        .expect(1)
        .mount(&server)
        .await;
    let client = GiteaClient::new(
        url::Url::parse(&server.uri()).expect("forge url"),
        "test-owner",
        "configuration",
        "portal-read-token",
    )
    .expect("client");
    (server, client)
}

/// AP-102: the named build is fetched once and unpacked under its digest.
#[tokio::test]
async fn a_replica_fetches_the_build_the_manifest_names_under_its_digest() {
    let bytes = bundle(b"<!doctype html><title>air quality</title>");
    let named = digest(&bytes);
    let (_forge, client) = forge_holding(bytes).await;
    let cache = tempdir::Dir::new("fetch-named");

    fetch_missing(&client, cache.path(), &mirror_naming(&named)).await;

    let dir = cache
        .path()
        .join("air-quality")
        .join(named.trim_start_matches("sha256:"));
    assert_eq!(
        std::fs::read(dir.join("index.html")).expect("the fetched index"),
        b"<!doctype html><title>air quality</title>"
    );
    // Held now: the next sync asks the forge for nothing (`expect(1)` above).
    fetch_missing(&client, cache.path(), &mirror_naming(&named)).await;
}

/// AP-72, AP-102: a package whose bytes do not hash to the digest installs nothing.
#[tokio::test]
async fn a_package_that_does_not_match_the_digest_installs_nothing() {
    let named = digest(b"what the lane said it built");
    let (_forge, client) = forge_holding(bundle(b"<html>something else</html>")).await;
    let cache = tempdir::Dir::new("fetch-mismatch");

    fetch_missing(&client, cache.path(), &mirror_naming(&named)).await;

    let app = cache.path().join("air-quality");
    let held: Vec<_> = std::fs::read_dir(&app)
        .map(|entries| entries.flatten().map(|entry| entry.file_name()).collect())
        .unwrap_or_default();
    assert!(held.is_empty(), "nothing was unpacked: {held:?}");
}

mod tempdir {
    /// A directory of this test process, removed when it goes out of scope.
    pub struct Dir(std::path::PathBuf);

    impl Dir {
        pub fn new(test: &str) -> Self {
            let path = std::env::temp_dir().join(format!("jc-{test}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).expect("scratch directory");
            Self(path)
        }

        pub fn path(&self) -> &std::path::Path {
            &self.0
        }
    }

    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}
