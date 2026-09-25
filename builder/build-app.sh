#!/bin/sh
# The build step of an application's workflow (AP-80, AP-82, ADR-N-028): clone the application at
# its commit, test and build it offline, and leave in $JC_BUILD_DIR what the next step uploads as
# the run's artifacts, `bundle.tar.gz` and `sbom.cdx.json`, and `build.json`, the `status.build`
# the `propose` job sends (AP-13a, AP-101, AP-104). `.gitea/workflows/build.yml` of the template sets:
#
#   JC_APP_REPO     https URL of the application's repository on the forge
#   JC_APP_COMMIT   the commit to build, 40 lowercase hex
#   JC_FORGE_TOKEN  the job token; it clones and nothing the application runs ever sees it
#   JC_BUILD_DIR    where the build is left (default /tmp/build)
#
# A repository with `package.json` at its root is a Vite project; one without is its own bundle,
# the `build: {}` shape (AP-83). One with `Cargo.toml` at its root is a `fullstack` App, built on
# the rust-1.90 runner into an image instead (AP-105).
set -eu

fail() { echo "build failed: $*" >&2; exit 1; }
if [ "${1:-}" = "--tree" ]; then
  # `build-app --tree <dir>`: CI's scaffold check (AP-128) builds a repository on disk exactly as a
  # forge commit is built, fetched over file:// with no token. The workflow never passes it.
  [ -d "${2:-}/.git" ] || fail "--tree needs a git repository"
  JC_APP_REPO="file://$(cd "$2" && pwd)"
  JC_APP_COMMIT=$(git -C "$2" rev-parse HEAD) || fail "cannot read the head of $2"
  JC_FORGE_TOKEN=none
else
  for name in JC_APP_REPO JC_APP_COMMIT JC_FORGE_TOKEN; do
    eval "[ -n \"\${$name:-}\" ]" || fail "$name is not set"
  done
  case "$JC_APP_REPO" in https://*|http://*) ;; *) fail "JC_APP_REPO is not an http(s) URL" ;; esac
fi
echo "$JC_APP_COMMIT" | grep -Eqx '[0-9a-f]{40}' || fail "JC_APP_COMMIT is not a full commit"

LANE=/opt/template
WORK=${JC_BUILD_DIR:-/tmp/build}
APP=$WORK/app
OUT=$WORK/bundle
rm -rf "$APP" "$OUT" && mkdir -p "$APP" "$OUT"
export HOME=$WORK CI=true

# The token travels as a header, never in the URL git would print or store.
git -C "$APP" init -q
git -C "$APP" -c http.extraheader="Authorization: token $JC_FORGE_TOKEN" \
  fetch -q --depth 1 "$JC_APP_REPO" "$JC_APP_COMMIT" || fail "cannot fetch $JC_APP_COMMIT from $JC_APP_REPO"
git -C "$APP" -c advice.detachedHead=false checkout -q FETCH_HEAD
COMMIT=$(git -C "$APP" rev-parse HEAD)
[ "$COMMIT" = "$JC_APP_COMMIT" ] || fail "the forge answered $COMMIT for $JC_APP_COMMIT"

# The application's own code runs from here on, without the job and runtime tokens in its environment.
# ponytail: the same uid can still read it from /proc/<lane pid>/environ; what bounds that is
# the job token's reach, this repository alone, and the runner's egress (AP-81, ADR-N-028 §5).
untrusted() { env -u JC_FORGE_TOKEN -u ACTIONS_RUNTIME_TOKEN -u ACTIONS_ID_TOKEN_REQUEST_TOKEN "$@"; }
if [ -f "$APP/package.json" ]; then
  JC_APP_BUILD=node
else
  JC_APP_BUILD=none
fi

# No install step at all: the release's template dependencies are baked in and linked, so no
# package the application names is fetched and no install script it could ship ever runs (AP-82).
link_template() {
  if [ -f "$1/package.json" ]; then
    node "$LANE/lane.mjs" deps "$1" || fail "package.json asks for a package the SDK does not ship"
  fi
  rm -rf "$1/node_modules" "$1/.jc-functions-entry.ts" "$1/.jc-vitest.config.mjs"
  # A writable folder of links, not one link: Vite writes its temporary config and cache there.
  mkdir "$1/node_modules"
  for entry in "$LANE"/node_modules/* "$LANE"/node_modules/.bin "$LANE"/node_modules/.pnpm; do
    ln -s "$entry" "$1/node_modules/"
  done
}
SDK=$(cat "$LANE/sdk-version")
built() {
  printf '{"digest":"%s","commit":"%s","sdkVersion":"%s","builtAt":"%s"}\n' \
    "$1" "$COMMIT" "$SDK" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$WORK/build.json"
  cat "$WORK/build.json"
}
pack() { tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -C "$1" -cf "$2" .; }
rm -f "$WORK/image.tar"

# A fullstack App (AP-105): the interface in ui/, then the binary that embeds it, then an image of
# that binary alone. Nothing is fetched: the crates come from the store the runner image carries.
if [ -f "$APP/Cargo.toml" ]; then
  [ -d /opt/cargo/registry ] || fail "a fullstack App builds on the rust-1.90 runner, and this runner carries no crate store"
  [ -f "$APP/ui/package.json" ] || fail "a fullstack App keeps its interface in ui/ with a package.json"
  link_template "$APP/ui"
  cd "$APP/ui"
  echo "== interface tests"
  TESTS=$(node "$LANE/lane.mjs" vitest-config "$APP/ui") || fail "cannot write the test config"
  untrusted node_modules/.bin/vitest run --config "$TESTS" || fail "the interface tests fail"
  echo "== interface"
  untrusted node_modules/.bin/tsc -b || fail "the interface does not typecheck"
  untrusted node_modules/.bin/vite build || fail "vite build failed"
  cd "$APP"
  # Cargo's home is this job's: the index and the .crate files are the image's, read-only, and
  # every source is unpacked here and checked against the lock, so no build leaves a crate
  # changed for the next one on this runner (AP-81, AP-106).
  export CARGO_HOME="$WORK/cargo" CARGO_TARGET_DIR="$WORK/target" CARGO_NET_OFFLINE=true
  rm -rf "$CARGO_HOME" "$CARGO_TARGET_DIR" && mkdir -p "$CARGO_HOME/registry"
  ln -s /opt/cargo/registry/index /opt/cargo/registry/cache "$CARGO_HOME/registry/"
  # The dependencies the image precompiled from the reference apps' locks, copied, never linked:
  # only this App's own crate and what its lock does not share are compiled (AP-106, T-2794).
  node "$LANE/lane.mjs" seed /opt/cargo/target-seed "$CARGO_TARGET_DIR"
  echo "== backend tests"
  untrusted cargo test --offline --locked || fail "cargo test failed (a crate outside the runner's store fails here too)"
  echo "== backend"
  untrusted cargo build --release --offline --locked --target x86_64-unknown-linux-musl || fail "cargo build failed"
  NAME=$(cargo metadata --offline --no-deps --format-version 1 | node -e '
    const meta = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const root = meta.packages.find((p) => p.manifest_path === process.argv[1]);
    const bins = (root?.targets ?? []).filter((t) => t.kind.includes("bin"));
    if (bins.length !== 1) { console.error(`Cargo.toml names ${bins.length} binaries; a fullstack App is one`); process.exit(1); }
    console.log(bins[0].name);' "$APP/Cargo.toml") || fail "cannot tell which binary is the App"
  echo "== image"
  rm -rf "$WORK/rootfs" "$WORK/layout" && mkdir -p "$WORK/rootfs"
  install -m 0755 "$CARGO_TARGET_DIR/x86_64-unknown-linux-musl/release/$NAME" "$WORK/rootfs/app"
  pack "$WORK/rootfs" "$WORK/layer.tar" || fail "cannot pack the layer"
  DIGEST=$(node "$LANE/lane.mjs" image "$WORK/layer.tar" "$WORK/layout") || fail "cannot write the image"
  pack "$WORK/layout" "$WORK/image.tar" || fail "cannot pack the image"
  node "$LANE/lane.mjs" sbom "$LANE/node_modules" "$WORK/sbom.cdx.json" "$APP/Cargo.lock" || fail "cannot write the SBOM"
  built "$DIGEST"
  exit 0
fi

cd "$APP"
link_template "$APP"
BIN=$APP/node_modules/.bin
# The app's own vitest config with the packed SDK inlined, which the linked store needs (T-2649).
TESTS=$(node "$LANE/lane.mjs" vitest-config "$APP") || fail "cannot write the test config"

if [ "$JC_APP_BUILD" = node ]; then
  [ -f package.json ] || fail "a node build needs package.json at the repository root"
  echo "== tests"
  untrusted "$BIN/vitest" run --config "$TESTS" || fail "the interface or function tests fail (SDK-24)"
  echo "== build"
  untrusted "$BIN/tsc" -b || fail "the application does not typecheck"
  untrusted "$BIN/vite" build --outDir "$OUT" --emptyOutDir || fail "vite build failed"
else
  if [ -d functions ]; then
    echo "== function tests"
    untrusted "$BIN/vitest" run --config "$TESTS" --dir functions --passWithNoTests || fail "the function tests fail (SDK-24)"
  fi
  # The tree at the commit is the bundle, minus the function sources and the workflow, which
  # the host never serves.
  git archive -o "$WORK/tree.tar" "$COMMIT" || fail "cannot read the tree of $COMMIT"
  tar -x -C "$OUT" -f "$WORK/tree.tar" && rm -f "$WORK/tree.tar"
  rm -rf "$OUT/functions" "$OUT/.gitea"
fi
[ -s "$OUT/index.html" ] || fail "the bundle has no index.html"
echo "== functions"
untrusted node "$LANE/lane.mjs" functions "$APP" "$OUT" || fail "functions/*.ts do not bundle"

node "$LANE/app-integrity.mjs" "$OUT" >/dev/null || fail "cannot compute integrity.json"

# One file per build, the same bytes for the same tree: sorted, no owners, no times (AP-101).
echo "== package"
rm -f "$WORK/bundle.tar" "$WORK/bundle.tar.gz"
pack "$OUT" "$WORK/bundle.tar" && gzip -n "$WORK/bundle.tar" || fail "cannot pack the bundle"
node "$LANE/lane.mjs" sbom "$LANE/node_modules" "$WORK/sbom.cdx.json" || fail "cannot write the SBOM"
built "sha256:$(sha256sum "$WORK/bundle.tar.gz" | cut -d' ' -f1)"
