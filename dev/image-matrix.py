#!/usr/bin/env python3
"""Which images a push builds (T-2485): the paths it changed, one per line on stdin, become the
build matrix of image.yml on stdout. `ALL` (a tag, a dispatch, a range git cannot diff) builds
every image.

- `ui/**` or `sdk/**` builds `portal-ui`: the UI links the SDK (`link:../sdk`).
- Any path outside `ui/` builds the binary and the two builder images, as every push did before:
  the binary embeds the SDK's kit, and the builders carry the SDK of the same commit (AP-82).

A `ui/**`-only push builds the bundle alone and is live in minutes; the binary's 30-minute build
waits for a change that needs it.

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


def wanted(paths: list[str]) -> list[str]:
    paths = [p.strip() for p in paths if p.strip()]
    if "ALL" in paths:
        return ["portal", "portal-ui", "app-builder", "app-builder-rust"]
    names = []
    if any(p.startswith(("ui/", "sdk/")) for p in paths):
        names.append("portal-ui")
    if any(not p.startswith("ui/") for p in paths):
        names = ["portal", *names, "app-builder", "app-builder-rust"]
    return names


def matrix(paths: list[str], repository: str, owner: str) -> dict:
    known = images(repository, owner)
    return {"include": [known[name] for name in wanted(paths)]}


def selftest() -> None:
    assert wanted(["ui/src/App.tsx", "ui/package.json"]) == ["portal-ui"]
    assert wanted(["src/main.rs"]) == ["portal", "app-builder", "app-builder-rust"]
    assert wanted(["sdk/src/sdk/index.ts"]) == ["portal", "portal-ui", "app-builder", "app-builder-rust"]
    assert wanted(["ui/src/a.tsx", "src/b.rs"]) == ["portal", "portal-ui", "app-builder", "app-builder-rust"]
    # A docs-only push builds the binary as before: its public docs are embedded (src/public_docs.rs).
    assert wanted(["public-docs/index.md"]) == ["portal", "app-builder", "app-builder-rust"]
    assert wanted(["ALL"]) == ["portal", "portal-ui", "app-builder", "app-builder-rust"]
    # Nothing changed (an empty merge): nothing to build, and image.yml skips the job.
    assert wanted([]) == [] and wanted(["", "  "]) == []
    # `ui` as a prefix of another folder is not the UI.
    assert wanted(["uikit/x"]) == ["portal", "app-builder", "app-builder-rust"]
    built = matrix(["ui/x"], "o/joinedcontext-portal", "o")["include"]
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
