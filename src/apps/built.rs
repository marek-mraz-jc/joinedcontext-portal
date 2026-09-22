//! A build the lane proposes, checked against the forge and published by the Portal (AP-101,
//! AP-104, ADR-N-028).
//!
//! The lane's token may propose `status.build` and nothing else (AP-73). These checks bound what
//! that proposal can say: the commit is the head of the default branch of the App's own
//! repository, that repository holds an artifact `bundle-{commit}` of a run of that commit, and
//! its bytes hash to the digest. Only then does the Portal write the generic package
//! `app-{name}`, version `{commit}`, with its own token: no credential that writes a package is
//! ever on the runner (AP-101).

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::agents::repository;
use crate::error::ApiError;
use crate::git::{Artifact, GitError, GiteaClient};

/// The largest bundle the Portal downloads and publishes.
/// ponytail: one fixed bound for every application; a setting when one needs more.
pub const MAX_BUNDLE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_SBOM_BYTES: u64 = 16 * 1024 * 1024;

/// The package an App's builds are published as (AP-101).
pub fn package(name: &str) -> String {
    format!("app-{name}")
}

fn sha256(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

/// Checks the `build` an App's lane proposes (`status.build`) and publishes it, or says which
/// check failed; nothing is published before every check has passed (AP-104).
pub async fn check_and_publish(
    gitea: &GiteaClient,
    project: &str,
    name: &str,
    spec: &Value,
    build: &Value,
) -> Result<(), ApiError> {
    let field = |key: &str| build.get(key).and_then(Value::as_str).unwrap_or_default();
    let (digest, commit) = (field("digest"), field("commit"));
    if spec.pointer("/source/git").is_none_or(Value::is_null) {
        return Err(ApiError::BadRequest(format!(
            "status.build of App '{name}' is checked against the App's own repository on the \
             forge, and it names no spec.source.git (AP-100, AP-104)"
        )));
    }
    let repo = gitea.for_repository(repository::name(project, name));
    let at = format!("{}/{}", repo.owner, repo.repo);
    let forge = |err: GitError| {
        ApiError::Unavailable(format!(
            "the forge could not check the build of App '{name}' in {at}: {err}"
        ))
    };

    let branch = repo.default_branch().await.map_err(forge)?;
    let head = repo.branch_head(&branch).await.map_err(forge)?;
    if head != commit {
        return Err(ApiError::Conflict(format!(
            "status.build names commit {commit}, but the head of {branch} in {at} is {head}: \
             only the newest commit of the default branch is published (AP-104)"
        )));
    }

    let bundle = newest_of(&repo, &format!("bundle-{commit}"), commit, None)
        .await
        .map_err(forge)?
        .ok_or_else(|| {
            ApiError::BadRequest(format!(
                "{at} holds no artifact bundle-{commit} from a run of commit {commit} (AP-104)"
            ))
        })?;
    if bundle.size > MAX_BUNDLE_BYTES {
        return Err(ApiError::BadRequest(format!(
            "artifact bundle-{commit} of {at} is {} bytes, more than the {MAX_BUNDLE_BYTES} a \
             bundle may be",
            bundle.size
        )));
    }
    let bytes = repo
        .download_artifact(bundle.id, MAX_BUNDLE_BYTES)
        .await
        .map_err(forge)?;
    let hashed = sha256(&bytes);
    if hashed != digest {
        return Err(ApiError::BadRequest(format!(
            "artifact bundle-{commit} of {at} hashes to {hashed}, not the digest {digest} \
             status.build names (AP-104)"
        )));
    }
    let sbom = newest_of(&repo, &format!("sbom-{commit}"), commit, Some(bundle.run))
        .await
        .map_err(forge)?
        .ok_or_else(|| {
            ApiError::BadRequest(format!(
                "{at} holds no artifact sbom-{commit} from the run that uploaded the bundle \
                 (AP-101, AP-104)"
            ))
        })?;
    let sbom = repo
        .download_artifact(sbom.id, MAX_SBOM_BYTES)
        .await
        .map_err(forge)?;

    let package = package(name);
    for (file, bytes) in [("bundle.tar.gz", bytes), ("sbom.cdx.json", sbom)] {
        publish_once(gitea, &package, commit, file, bytes)
            .await
            .map_err(|err| match err {
                GitError::Conflict(message) => ApiError::Conflict(message),
                other => forge(other),
            })?;
    }
    Ok(())
}

/// The newest artifact `name` a run of `commit` uploaded, from run `run` when one is named.
async fn newest_of(
    repo: &GiteaClient,
    name: &str,
    commit: &str,
    run: Option<u64>,
) -> Result<Option<Artifact>, GitError> {
    Ok(repo
        .artifacts_named(name)
        .await?
        .into_iter()
        .filter(|artifact| artifact.commit == commit && run.is_none_or(|run| artifact.run == run))
        .max_by_key(|artifact| artifact.id))
}

/// Writes one file of the package version. The registry never replaces a file: one already
/// there with the same bytes is the same build published again (a rebuild of the same commit is
/// reproducible, AP-101), and one with other bytes is refused.
async fn publish_once(
    gitea: &GiteaClient,
    package: &str,
    version: &str,
    file: &str,
    bytes: Vec<u8>,
) -> Result<(), GitError> {
    let limit = bytes.len() as u64;
    let expected = sha256(&bytes);
    match gitea.put_generic_file(package, version, file, bytes).await {
        Err(GitError::Conflict(_)) => {
            let held = gitea
                .get_generic_file(package, version, file, limit)
                .await
                .map(|held| sha256(&held));
            match held {
                Ok(held) if held == expected => Ok(()),
                Ok(_) => Err(GitError::Conflict(format!(
                    "package {package} version {version} already holds a different {file}, and \
                     the registry never replaces a file (AP-101)"
                ))),
                Err(other) => Err(other),
            }
        }
        other => other,
    }
}
