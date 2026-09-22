#!/bin/sh
# The build lane's one fixed command (AP-80, ADR-N-026): clone the application at its commit,
# test and build it offline, upload the bundle to the artifact store under its digest, and leave
# `{digest, commit, sdkVersion, builtAt}` in the termination log for the reconciler to propose as
# `status.build` (AP-13a, AP-73). The Portal's reconciler (T-2593) sets:
#
#   JC_APP_REPO     https URL of the application's repository on the forge
#   JC_APP_COMMIT   the commit to build, 40 lowercase hex
#   JC_APP_BUILD    node (a Vite project) or none (the tree is the bundle, AP-83)
#   JC_STORE_URL, JC_STORE_BUCKET, JC_STORE_PREFIX (apps/{org}/{project}/{app}), JC_STORE_REGION
#   JC_FORGE_TOKEN  read-only, this one repository; AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
#                   the store's write key for this prefix only (AP-81)
set -eu

fail() { echo "build failed: $*" >&2; exit 1; }
for name in JC_APP_REPO JC_APP_COMMIT JC_APP_BUILD JC_STORE_URL JC_STORE_BUCKET JC_STORE_PREFIX \
  JC_FORGE_TOKEN AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
  eval "[ -n \"\${$name:-}\" ]" || fail "$name is not set"
done
echo "$JC_APP_COMMIT" | grep -Eqx '[0-9a-f]{40}' || fail "JC_APP_COMMIT is not a full commit"
case "$JC_APP_REPO" in https://*|http://*) ;; *) fail "JC_APP_REPO is not an http(s) URL" ;; esac
case "$JC_APP_BUILD" in node|none) ;; *) fail "JC_APP_BUILD is '$JC_APP_BUILD', not node or none" ;; esac
echo "$JC_STORE_PREFIX" | grep -Eqx 'apps/[a-z0-9.-]+/[a-z0-9-]+/[a-z0-9-]+' \
  || fail "JC_STORE_PREFIX is not apps/{org}/{project}/{app}"

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

# The application's own code runs from here on. It gets no forge token and no store key in its
# environment. ponytail: the same uid can still read them from /proc/<lane pid>/environ; what
# bounds that is the key's own prefix and the egress to the forge and store only (AP-81).
untrusted() { env -u JC_FORGE_TOKEN -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY "$@"; }

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
  # The tree at the commit is the bundle, minus the function sources the host never serves.
  git archive "$COMMIT" | tar -x -C "$OUT"
  rm -rf "$OUT/functions"
fi
[ -s "$OUT/index.html" ] || fail "the bundle has no index.html"
echo "== functions"
untrusted node "$LANE/lane.mjs" functions "$APP" "$OUT" || fail "functions/*.ts do not bundle"

node "$LANE/app-integrity.mjs" "$OUT" >/dev/null || fail "cannot compute integrity.json"
DIGEST=$(sha256sum "$OUT/integrity.json" | cut -d' ' -f1)
KEY="$JC_STORE_PREFIX/$DIGEST"

# integrity.json last: a prefix without it is an upload that did not finish, and serves nothing.
echo "== upload $KEY"
upload() {
  printf 'user = "%s:%s"\n' "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY" |
    curl -K - --fail --silent --show-error --retry 3 \
      --aws-sigv4 "aws:amz:${JC_STORE_REGION:-us-east-1}:s3" -H "x-amz-content-sha256: UNSIGNED-PAYLOAD" \
      -T "$OUT/$1" "$JC_STORE_URL/$JC_STORE_BUCKET/$KEY/$1" -o /dev/null || fail "upload of $1 failed"
}
(cd "$OUT" && find . -type f ! -name integrity.json | sed 's|^\./||') | while read -r file; do
  upload "$file"
done
upload integrity.json

SDK=$(cat "$LANE/sdk-version")
RESULT=$(printf '{"digest":"sha256:%s","commit":"%s","sdkVersion":"%s","builtAt":"%s"}' \
  "$DIGEST" "$COMMIT" "$SDK" "$(date -u +%Y-%m-%dT%H:%M:%SZ)")
echo "$RESULT"
if [ -w /dev/termination-log ]; then printf '%s' "$RESULT" > /dev/termination-log; fi
