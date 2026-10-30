#!/usr/bin/env python3
"""Which images a push builds (T-2485): the paths it changed, one per line on stdin, become the
build matrix of image.yml on stdout. `ALL` (a tag, a dispatch, a range git cannot diff) builds
every image.

- `ui/**` or `sdk/**` builds `portal-ui`: the UI links the SDK (`link:../sdk`).
- Any path outside `ui/` builds the binary: it embeds the SDK's kit, the docs and the migrations.
- The two builder images only when what they carry moved (T-6154): their Dockerfile and lane
  (`builder/`), the SDK (AP-82), the apps' crates and the locks their crate store is fetched from.
- Until the cut-over, `ui/**` also builds the binary: it still embeds the bundle and is what an
  installation without `portal-ui` serves (T-2485). The cut-over sets EMBEDS_UI to False.

    git diff --name-only "$BEFORE" "$GITHUB_SHA" | dev/image-matrix.py owner/repo owner
    python3 dev/image-matrix.py --selftest
"""
import json
import sys


def images(repository: str, owner: str) -> dict[str, dict]:
    return {
        "portal": {"name": "portal", "file": "Dockerfile", "image": f"ghcr.io/{repository}"},
        "portal-ui": {
            "name": "portal-ui",
            "file": "Dockerfile",
            "target": "ui-bundle",
            "image": f"ghcr.io/{repository}-ui",
        },
        "app-builder": {
            "name": "app-builder",
            "file": "builder/Dockerfile",
            "image": f"ghcr.io/{owner}/joinedcontext-app-builder",
        },
        # The rust-1.90 runner of fullstack Apps: the same Dockerfile's `rust` stage (AP-106).
        "app-builder-rust": {
            "name": "app-builder-rust",
            "file": "builder/Dockerfile",
            "target": "rust",
            "image": f"ghcr.io/{owner}/joinedcontext-app-builder-rust",
        },
    }


# The binary embeds ui/dist until every installation reads its pages from `portal-ui` (T-2485).
EMBEDS_UI = True


# What builder/Dockerfile copies besides the Cargo manifests and locks anywhere in the tree.
BUILDER_INPUTS = ("builder/", "sdk/", "apps/")


def wanted(paths: list[str], embeds_ui: bool = EMBEDS_UI) -> list[str]:
    paths = [p.strip() for p in paths if p.strip()]
    if "ALL" in paths:
        return ["portal", "portal-ui", "app-builder", "app-builder-rust"]
    names = []
    if any(p.startswith(("ui/", "sdk/")) for p in paths):
        names.append("portal-ui")
    if any(not p.startswith("ui/") for p in paths):
        names = ["portal", *names]
        if any(p.startswith(BUILDER_INPUTS) or p.rsplit("/", 1)[-1] in ("Cargo.toml", "Cargo.lock") for p in paths):
            names += ["app-builder", "app-builder-rust"]
    elif names and embeds_ui:
        names = ["portal", *names]
    return names


def matrix(paths: list[str], repository: str, owner: str) -> dict:
    known = images(repository, owner)
    return {"include": [known[name] for name in wanted(paths)]}


def selftest() -> None:
    assert wanted(["ui/src/App.tsx", "ui/package.json"]) == ["portal", "portal-ui"]
    assert wanted(["ui/src/App.tsx"], embeds_ui=False) == ["portal-ui"]
    assert wanted(["src/main.rs"]) == ["portal"]
    for path in ("builder/lane.mjs", "apps/air-quality/src/main.rs", "Cargo.lock", "apps/hsl-transport/server/Cargo.toml"):
        assert wanted([path]) == ["portal", "app-builder", "app-builder-rust"], path
    assert wanted(["src/a.rs", "Cargo.lock"]) == ["portal", "app-builder", "app-builder-rust"]
    assert wanted(["sdk/src/sdk/index.ts"]) == ["portal", "portal-ui", "app-builder", "app-builder-rust"]
    assert wanted(["ui/src/a.tsx", "src/b.rs"]) == ["portal", "portal-ui"]
    # A docs-only push builds the binary as before: its public docs are embedded (src/public_docs.rs).
    assert wanted(["public-docs/index.md"]) == ["portal"]
    assert wanted(["ALL"]) == ["portal", "portal-ui", "app-builder", "app-builder-rust"]
    # Nothing changed (an empty merge): nothing to build, and image.yml skips the job.
    assert wanted([]) == [] and wanted(["", "  "]) == []
    # `ui` as a prefix of another folder is not the UI.
    assert wanted(["uikit/x"]) == ["portal"]
    built = matrix(["ui/x"], "o/joinedcontext-portal", "o")["include"][1:]
    assert built == [
        {
            "name": "portal-ui",
            "file": "Dockerfile",
            "target": "ui-bundle",
            "image": "ghcr.io/o/joinedcontext-portal-ui",
        }
    ], built
    print("image-matrix: selftest ok")


def main(argv: list[str]) -> int:
    if argv[1:] == ["--selftest"]:
        selftest()
        return 0
    if len(argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    print(json.dumps(matrix(sys.stdin.read().splitlines(), argv[1], argv[2])))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
