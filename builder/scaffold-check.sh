#!/bin/sh
# builder/scaffold-check.sh <dir>: inside a runner image, with no network (AP-127, AP-128). Builds
# the scaffolded app in <dir> the way the lane builds a commit (`build-app --tree`), then changes
# one file and builds again the way a developer does; fails when the first build takes more than
# JC_FIRST_BUILD_BUDGET seconds (120) or the rebuild more than JC_REBUILD_BUDGET (30).
set -eu
first_budget=${JC_FIRST_BUILD_BUDGET:-120}
rebuild_budget=${JC_REBUILD_BUDGET:-30}
fail() { echo "scaffold check failed: $*" >&2; exit 1; }
[ -d "${1:-}/.git" ] || fail "usage: scaffold-check.sh <scaffolded git repository>"

# Its own copy: git refuses a repository another uid owns, and the mount is read-only.
tree=/tmp/scaffold
rm -rf "$tree" && cp -R "$1" "$tree"
export JC_BUILD_DIR=/tmp/build
start=$(date +%s)
build-app --tree "$tree"
first=$(($(date +%s) - start))

app=$JC_BUILD_DIR/app
start=$(date +%s)
if [ -f "$app/Cargo.toml" ]; then
  # The backend's one file, compiled on the target the first build left, as `cargo build` does.
  printf '\n/// Edited by the scaffold check.\npub const EDITED: bool = true;\n' >> "$app/src/lib.rs"
  (cd "$app" && CARGO_HOME=$JC_BUILD_DIR/cargo CARGO_TARGET_DIR=$JC_BUILD_DIR/target CARGO_NET_OFFLINE=true \
    cargo build --release --offline --locked --target x86_64-unknown-linux-musl) || fail "the rebuild failed"
else
  printf '\nexport const edited = true;\n' >> "$app/src/App.tsx"
  (cd "$app" && node_modules/.bin/vite build --outDir "$JC_BUILD_DIR/rebuild" --emptyOutDir) || fail "the rebuild failed"
fi
rebuild=$(($(date +%s) - start))

echo "first build ${first}s (budget ${first_budget}s), one-file rebuild ${rebuild}s (budget ${rebuild_budget}s)"
[ "$first" -le "$first_budget" ] || fail "the first build took ${first}s, over ${first_budget}s"
[ "$rebuild" -le "$rebuild_budget" ] || fail "the one-file rebuild took ${rebuild}s, over ${rebuild_budget}s"
