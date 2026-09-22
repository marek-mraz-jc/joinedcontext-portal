//! Every reference app in the repository is a manifest the reconciler can actually read
//! (T-0310, AP-34, AP-37, AP-39).
//!
//! The app crates deliberately do not depend on `jc-core`: an app has to build and run
//! outside this platform. That leaves nothing checking that `apps/*/app.yaml` still parses
//! after a change to the kind, which is exactly the kind of drift that is found on a cluster
//! instead of in CI. The Portal already owns the reconciler and the contract, so the check
//! lives here.

use jc_core::kinds::App;

/// Reads every `apps/*/app.yaml` beside the Portal, in path order so a failure names the same
/// app on every machine.
fn reference_apps() -> Vec<(String, String)> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("apps");
    let mut found: Vec<_> = std::fs::read_dir(&root)
        .expect("the apps folder exists")
        .filter_map(Result::ok)
        .map(|entry| entry.path().join("app.yaml"))
        .filter(|manifest| manifest.is_file())
        .map(|manifest| {
            let name = manifest
                .parent()
                .and_then(|dir| dir.file_name())
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            (
                name,
                std::fs::read_to_string(&manifest).expect("a readable manifest"),
            )
        })
        .collect();
    found.sort();
    found
}

#[test]
fn every_reference_app_manifest_parses_as_the_kind_the_reconciler_reads() {
    let apps = reference_apps();
    assert!(!apps.is_empty(), "no apps/*/app.yaml found");
    for (name, yaml) in apps {
        let app: App = serde_yaml_ng::from_str(&yaml)
            .unwrap_or_else(|error| panic!("apps/{name}/app.yaml does not parse: {error}"));
        assert_eq!(app.metadata.name, name, "the folder names the app");
        assert!(
            !app.spec.data_needs.is_empty(),
            "apps/{name} declares no data needs, so it has nothing to reach (AP-04)"
        );
    }
}

/// AP-35. The annotations are an agent's attribution; hand-written source claiming them would
/// make the provenance trail say something untrue.
#[test]
fn a_hand_written_app_claims_no_agent_attribution() {
    for (name, yaml) in reference_apps() {
        let app: App = serde_yaml_ng::from_str(&yaml).expect("a manifest");
        for annotation in [
            "joinedcontext.com/generated-by",
            "joinedcontext.com/prompt-digest",
        ] {
            assert!(
                !app.metadata.annotations.contains_key(annotation),
                "apps/{name} claims {annotation} but is written by hand"
            );
        }
    }
}

/// AP-39. A write is the one thing that puts an app's publication in the red lane, so the
/// list of apps that can write is worth stating out loud rather than discovering later.
///
/// Three apps write, and each one writes the same single attribute: the steward's note, which is
/// the one attribute of its model that no pipeline overwrites (AP-62, T-2434). Any other app
/// declaring a write fails this test until somebody adds it here on purpose.
#[test]
fn only_the_note_is_ever_written_and_only_by_the_apps_named_here() {
    let writes = [
        "createEntity",
        "updateEntity",
        "updateAttrs",
        "appendAttrs",
        "deleteAttrs",
        "deleteEntity",
        "mergeEntity",
        "replaceEntity",
        "replaceAttrs",
    ];
    for (name, yaml) in reference_apps() {
        let app: App = serde_yaml_ng::from_str(&yaml).expect("a manifest");
        let writing: Vec<_> = app
            .spec
            .data_needs
            .iter()
            .flat_map(|need| need.operations.iter())
            .map(|operation| operation.as_str())
            .filter(|operation| writes.contains(operation))
            .collect();
        match name.as_str() {
            "air-quality" | "banskabystrica-zaznamy" | "bbsk-zaznamy" => {
                assert_eq!(writing, vec!["updateAttrs"], "{name} writes one way only");
                let attrs: Vec<_> = app
                    .spec
                    .data_needs
                    .iter()
                    .flat_map(|need| need.attrs.iter())
                    .collect();
                assert!(
                    attrs.iter().any(|attr| *attr == "stewardNote"),
                    "the note attribute has to be in the grant"
                );
            }
            other => assert!(
                writing.is_empty(),
                "apps/{other} declares writes {writing:?}; add it to this test on purpose"
            ),
        }
    }
}

/// T-2437. The city's records and the region's are one screen published twice: the same `ui/src`,
/// byte for byte, and two manifests. Copied rather than shared because a published App belongs to
/// one project and one space, and this repository binds one app name to one folder — so this is
/// what stops the two copies drifting apart, the way the seed holds its two copies of one model.
#[test]
fn the_two_record_grids_are_the_same_screen_published_twice() {
    let apps = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("apps");
    let city = apps.join("banskabystrica-zaznamy/ui/src");
    let region = apps.join("bbsk-zaznamy/ui/src");

    fn files(root: &std::path::Path) -> Vec<(String, Vec<u8>)> {
        let mut found = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir)
                .expect("a readable directory")
                .flatten()
            {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else {
                    let name = path
                        .strip_prefix(root)
                        .expect("inside the root")
                        .to_string_lossy()
                        .into_owned();
                    found.push((name, std::fs::read(&path).expect("a readable file")));
                }
            }
        }
        found.sort();
        found
    }

    let one = files(&city);
    let other = files(&region);
    assert!(!one.is_empty(), "the city's grid has no source");
    assert_eq!(
        one.iter().map(|(name, _)| name).collect::<Vec<_>>(),
        other.iter().map(|(name, _)| name).collect::<Vec<_>>(),
        "the two grids hold different files"
    );
    for ((name, left), (_, right)) in one.iter().zip(other.iter()) {
        assert_eq!(
            left, right,
            "apps/*/ui/src/{name} differs between the two grids"
        );
    }
}

/// AP-01. A `static` app has no crate, and cargo's `apps/*` glob refuses a member directory
/// without a `Cargo.toml` rather than skipping it, so every one of them is excluded by name in
/// the workspace manifest. Forgetting that is a workspace that does not load at all.
#[test]
fn every_static_app_is_excluded_from_the_cargo_workspace() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let manifest =
        std::fs::read_to_string(root.join("Cargo.toml")).expect("the workspace manifest");
    for (name, yaml) in reference_apps() {
        let app: App = serde_yaml_ng::from_str(&yaml).expect("a manifest");
        let has_crate = root.join("apps").join(&name).join("Cargo.toml").is_file();
        if has_crate {
            continue;
        }
        assert!(
            manifest.contains(&format!("\"apps/{name}\"")),
            "apps/{name} has no Cargo.toml; name it in the workspace `exclude` list ({:?})",
            app.spec.class
        );
    }
}

/// AP-75, AP-80, AP-87 (T-2596). An application kept in its own repository names that repository
/// and not a folder, and its tree is what the build lane builds: `package.json` and `index.html`
/// at the root for a Vite project, no `ui/` below it.
#[test]
fn an_app_in_its_own_repository_names_it_and_keeps_the_shape_the_lane_builds() {
    let apps = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("apps");
    let mut seen = 0;
    for (name, yaml) in reference_apps() {
        let dir = apps.join(&name);
        if !dir.join("package.json").is_file() {
            continue;
        }
        seen += 1;
        let app: App = serde_yaml_ng::from_str(&yaml).expect("a manifest");
        let namespace = app.metadata.namespace.clone().unwrap_or_default();
        let git = app.spec.source.git.as_ref().unwrap_or_else(|| {
            panic!("apps/{name} sits at its repository's root but names no spec.source.git")
        });
        assert!(
            app.spec.source.path.is_none(),
            "apps/{name} names a folder as well (AP-87)"
        );
        assert!(
            git.url.starts_with("https://")
                && git.url.ends_with(&format!("/{namespace}_{name}.git")),
            "apps/{name} names {} instead of its own repository {namespace}_{name} (AP-75)",
            git.url
        );
        assert!(
            git.path.is_none(),
            "apps/{name} is the whole repository, not a folder of it"
        );
        assert!(
            dir.join("index.html").is_file(),
            "apps/{name} has no index.html at its root"
        );
        assert!(
            !dir.join("ui").exists(),
            "apps/{name} keeps the old ui/ folder beside its root"
        );
    }
    assert!(
        seen > 0,
        "no application in its own repository layout under apps/"
    );
}

/// AP-87. `joinedcontext.com/shipped-with: portal` lets a published static App name no
/// repository because the Portal image carries its bundle; the mark is true exactly for the
/// apps the Dockerfile builds into `/srv/apps`, so a mark without a bundle or a bundle without
/// its mark is found here, not as a 404 or a refused proposal on a cluster.
#[test]
fn the_shipped_mark_is_on_exactly_the_bundles_the_image_builds() {
    use jc_core::kinds::app::SHIPPED_WITH_ANNOTATION;
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let dockerfile = std::fs::read_to_string(root.join("Dockerfile")).expect("the Dockerfile");
    for (name, yaml) in reference_apps() {
        let app: App = serde_yaml_ng::from_str(&yaml).expect("a manifest");
        let marked = app
            .metadata
            .annotations
            .get(SHIPPED_WITH_ANNOTATION)
            .is_some_and(|value| value == "portal");
        let built = dockerfile.contains(&format!("/srv/apps/{name} "))
            || dockerfile.contains(&format!("/srv/apps/{name}\n"));
        assert_eq!(
            marked, built,
            "apps/{name}: the shipped mark says {marked}, the Dockerfile builds it: {built}"
        );
    }
}

/// AP-83, AP-01, AP-75. The plain-HTML sample is what T-2599 pushes to its own repository
/// unchanged: a static App with no build step, whose folder is the bundle (`index.html` at its
/// root, no toolchain file), and whose manifest passes the validation `jcctl validate` runs.
#[test]
fn the_plain_html_sample_is_its_own_bundle_and_a_valid_published_app() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("apps/helsinki-events");
    let (_, yaml) = reference_apps()
        .into_iter()
        .find(|(name, _)| name == "helsinki-events")
        .expect("apps/helsinki-events/app.yaml");
    match jc_core::registry::validate_yaml("App", &yaml) {
        Some(Ok(_)) => {}
        other => panic!("jcctl validate refuses apps/helsinki-events: {other:?}"),
    }
    let app: App = serde_yaml_ng::from_str(&yaml).expect("a manifest");
    assert_eq!(app.spec.class, jc_core::AppClass::Static);
    assert!(app.spec.build.0.is_empty(), "no build step (AP-83)");
    assert!(
        app.spec.source.git.is_some(),
        "published from its own repository (AP-87)"
    );
    assert!(root.join("index.html").is_file(), "index.html at the root");
    for toolchain in ["package.json", "Cargo.toml", "vite.config.ts"] {
        assert!(
            !root.join(toolchain).exists(),
            "{toolchain} in a folder that is served as it is"
        );
    }
}

/// AP-100. A reference application that lives in its own repository builds itself there, with the
/// workflow the Portal writes into every generated one: the same bytes as the template's, so the
/// sample on dev and a generated application build the same way (T-2609).
#[test]
fn every_reference_app_in_its_own_repository_carries_the_templates_workflow() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let template = std::fs::read_to_string(root.join("sdk/template/.gitea/workflows/build.yml"))
        .expect("the template's workflow");
    let mut seen = 0;
    for (name, yaml) in reference_apps() {
        let app: App = serde_yaml_ng::from_str(&yaml).expect("a manifest");
        if app.spec.source.git.is_none() {
            continue;
        }
        seen += 1;
        let workflow = root.join("apps").join(&name).join(".gitea/workflows/build.yml");
        assert_eq!(
            std::fs::read_to_string(&workflow).ok().as_deref(),
            Some(template.as_str()),
            "apps/{name} names spec.source.git, so it carries the template's build.yml"
        );
    }
    assert!(seen > 0, "no reference app lives in its own repository");
}
