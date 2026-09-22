#!/bin/sh
# The build step of an application's workflow (AP-80, AP-82, ADR-N-028): clone the application at
# its commit, test and build it offline, and leave in $JC_BUILD_DIR the package the next step
# publishes, `bundle.tar.gz` and `sbom.cdx.json`, and `build.json`, the `status.build` the last
# step proposes (AP-13a, AP-101). `.gitea/workflows/build.yml` of the template sets:
#
#   JC_APP_REPO     https URL of the application's repository on the forge
#   JC_APP_COMMIT   the commit to build, 40 lowercase hex
#   JC_FORGE_TOKEN  the job token; it clones and nothing the application runs ever sees it
#   JC_BUILD_DIR    where the build is left (default /tmp/build)
#
# A repository with `package.json` at its root is a Vite project; one without is its own bundle,
# the `build: {}` shape (AP-83).
set -eu

fail() { echo "build failed: $*" >&2; exit 1; }
for name in JC_APP_REPO JC_APP_COMMIT JC_FORGE_TOKEN; do
  eval "[ -n \"\${$name:-}\" ]" || fail "$name is not set"
done
echo "$JC_APP_COMMIT" | grep -Eqx '[0-9a-f]{40}' || fail "JC_APP_COMMIT is not a full commit"
case "$JC_APP_REPO" in https://*|http://*) ;; *) fail "JC_APP_REPO is not an http(s) URL" ;; esac

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

# The application's own code runs from here on, without the job token in its environment.
# ponytail: the same uid can still read it from /proc/<lane pid>/environ; what bounds that is
# the job token's reach, this repository alone, and the runner's egress (AP-81, ADR-N-028 §5).
untrusted() { env -u JC_FORGE_TOKEN "$@"; }
if [ -f "$APP/package.json" ]; then
  JC_APP_BUILD=node
else
  JC_APP_BUILD=none
fi

# No install step at all: the release's template dependencies are baked in and linked, so no
# package the application names is fetched and no install script it could ship ever runs (AP-82).
cd "$APP"
if [ -f package.json ]; then
  node "$LANE/lane.mjs" deps "$APP" || fail "package.json asks for a package the SDK does not ship"
fi
rm -rf node_modules .jc-functions-entry.ts
# A writable folder of links, not one link: Vite writes its temporary config and cache there.
mkdir node_modules
for entry in "$LANE"/node_modules/* "$LANE"/node_modules/.bin "$LANE"/node_modules/.pnpm; do
  ln -s "$entry" node_modules/
done
BIN=$APP/node_modules/.bin

if [ "$JC_APP_BUILD" = node ]; then
  [ -f package.json ] || fail "a node build needs package.json at the repository root"
  echo "== tests"
  untrusted "$BIN/vitest" run || fail "the interface or function tests fail (SDK-24)"
  echo "== build"
  untrusted "$BIN/tsc" -b || fail "the application does not typecheck"
  untrusted "$BIN/vite" build --outDir "$OUT" --emptyOutDir || fail "vite build failed"
else
  if [ -d functions ]; then
    echo "== function tests"
    untrusted "$BIN/vitest" run --dir functions --passWithNoTests || fail "the function tests fail (SDK-24)"
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
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -C "$OUT" -cf "$WORK/bundle.tar" . \
  && gzip -n "$WORK/bundle.tar" || fail "cannot pack the bundle"
node "$LANE/lane.mjs" sbom "$LANE/node_modules" "$WORK/sbom.cdx.json" || fail "cannot write the SBOM"
DIGEST=$(sha256sum "$WORK/bundle.tar.gz" | cut -d' ' -f1)

SDK=$(cat "$LANE/sdk-version")
printf '{"digest":"sha256:%s","commit":"%s","sdkVersion":"%s","builtAt":"%s"}\n' \
  "$DIGEST" "$COMMIT" "$SDK" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$WORK/build.json"
cat "$WORK/build.json"
