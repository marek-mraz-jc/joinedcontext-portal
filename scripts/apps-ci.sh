#!/bin/sh
# The Apps' builds, tests and coverage gate (T-3373), from the repository root:
#
#   sh scripts/apps-ci.sh wasm   # the react-rust-wasm example and the Apps with a wasm/ crate
#   sh scripts/apps-ci.sh ui     # the reference apps/*/ui, the Apps in their own repository, the
#                                # rust-wasm-server example's interface
#   sh scripts/apps-ci.sh touched <path>   # exit 0 when the change touches <path>
#
# The fast lane (ci.yml) runs only what a change touched: an App when a file under apps/<name>/
# changed, everything when the SDK, the build lane's builder/ or the gate itself changed, or when
# the change cannot be told (no base). `APPS_ALL=1` runs everything (ci-full). The base is the
# branch's fork from main, or the commit before on main; `APPS_BASE` names another.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
RUN="$ROOT/scripts/app-coverage-run.sh"
cd "$ROOT"

# Files whose change can move every App's result.
EVERYTHING='^(sdk/|builder/|scripts/app-coverage-|scripts/apps-ci\.sh$|apps/coverage-thresholds\.json$|\.github/workflows/ci\.yml$)'

changed_files() {
  base=${APPS_BASE:-}
  if [ -z "$base" ]; then
    git fetch -q --depth=100 origin main 2>/dev/null || true
    base=$(git merge-base HEAD origin/main 2>/dev/null || true)
    [ "$base" = "$(git rev-parse HEAD)" ] && base=$(git rev-parse -q --verify HEAD~1 2>/dev/null || true)
  fi
  # No base to compare with: say so, and everything runs.
  [ -n "$base" ] || { echo "*"; return; }
  # A base the shallow clone does not hold is no base either.
  git diff --name-only "$base" HEAD 2>/dev/null || echo "*"
}

CHANGED=""
touched() {
  [ "${APPS_ALL:-}" = "1" ] && return 0
  [ -n "$CHANGED" ] || CHANGED=$(changed_files)
  [ "$CHANGED" = "*" ] && return 0
  printf '%s\n' "$CHANGED" | grep -Eq "$EVERYTHING" && return 0
  printf '%s\n' "$CHANGED" | grep -q "^${1%/}/"
}

skip() {
  echo "apps-ci: $1 untouched by this change, left to ci-full"
}

wasm() {
  if touched sdk/examples/react-rust-wasm; then
    work=$(mktemp -d)
    cp -r sdk/examples/react-rust-wasm/. "$work"
    cargo fetch --locked --manifest-path "$work/wasm/Cargo.toml"
    JC_CRATE_STORE="$HOME/.cargo/registry" sh builder/build-wasm.sh "$work" "$(mktemp -d)"
    (cd "$work" && npm pkg set "dependencies.@joinedcontext/sdk=link:$ROOT/sdk" \
      && pnpm install --no-frozen-lockfile \
      && sh "$RUN" react-rust-wasm --rust && pnpm build \
      && pnpm exec playwright install --with-deps --only-shell chromium \
      && pnpm exec playwright test)
  else
    skip react-rust-wasm
  fi
  for app in apps/*/; do
    [ -f "$app/wasm/Cargo.toml" ] && [ -f "$app/package.json" ] || continue
    touched "$app" || { skip "$app"; continue; }
    work=$(mktemp -d)
    cp -r "$app". "$work"
    cargo fetch --locked --manifest-path "$work/wasm/Cargo.toml"
    JC_CRATE_STORE="$HOME/.cargo/registry" sh builder/build-wasm.sh "$work" "$(mktemp -d)"
    (cd "$work" && npm pkg set "dependencies.@joinedcontext/sdk=link:$ROOT/sdk" \
      && pnpm install --no-frozen-lockfile && pnpm typecheck \
      && sh "$RUN" "$(basename "$app")" --rust && pnpm build \
      && pnpm exec playwright install --with-deps --only-shell chromium \
      && pnpm exec playwright test)
  done
}

ui() {
  # The reference apps of AP-34 carry their own bundle and no lockfile: the SDK name is pointed at
  # this checkout, and the manifests and lockfiles are put back after (the lane test reads them).
  for app in apps/*/ui; do
    [ -f "$app/package.json" ] || continue
    touched "$(dirname "$app")" || { skip "$app"; continue; }
    (cd "$app" && if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; else
      npm pkg set "dependencies.@joinedcontext/sdk=link:$ROOT/sdk" \
      && pnpm install --no-frozen-lockfile; fi && pnpm typecheck \
      && sh "$RUN" "$(basename "$(dirname "$app")")" && pnpm build)
  done
  git checkout -- apps && git clean -fq -- apps
  # An App in its own forge repository sits at the root of apps/<name>/ (AP-75): tested as that
  # tree copied out, the SDK pointed at this checkout. One with a wasm/ crate is the wasm mode's.
  for app in apps/*/; do
    [ -f "$app/package.json" ] || continue
    [ -f "$app/wasm/Cargo.toml" ] && continue
    touched "$app" || { skip "$app"; continue; }
    work=$(mktemp -d)
    cp -r "$app". "$work"
    (cd "$work" && npm pkg set "dependencies.@joinedcontext/sdk=link:$ROOT/sdk" \
      && pnpm install --no-frozen-lockfile && pnpm typecheck \
      && sh "$RUN" "$(basename "$app")" && pnpm build)
  done
  # The plain-HTML example has no build and no package manager (AP-83): its tests run in a copy
  # given a throwaway package.json with the SDK's own vitest and jsdom.
  if touched sdk/examples/plain-html-events; then
    work=$(mktemp -d)
    cp -r sdk/examples/plain-html-events/. "$work"
    vitest=$(node -p "require('$ROOT/sdk/node_modules/vitest/package.json').version")
    jsdom=$(node -p "require('$ROOT/sdk/node_modules/jsdom/package.json').version")
    (cd "$work" && cp test/vitest.config.mjs vitest.config.mjs \
      && printf '{ "name": "plain-html-events-tests", "private": true, "type": "module" }\n' > package.json \
      && pnpm add --save-dev "vitest@$vitest" "jsdom@$jsdom" "@joinedcontext/sdk@link:$ROOT/sdk" >/dev/null \
      && sh "$RUN" plain-html-events)
  else
    skip plain-html-events
  fi
  if touched sdk/examples/rust-wasm-server; then
    work=$(mktemp -d)
    cp -r sdk/examples/rust-wasm-server/. "$work"
    (cd "$work" && npm pkg set "devDependencies.@joinedcontext/sdk=link:$ROOT/sdk" \
      && pnpm install --no-frozen-lockfile && sh "$RUN" rust-wasm-server && pnpm build)
  else
    skip rust-wasm-server
  fi
}

case "${1:-}" in
  wasm) wasm ;;
  ui) ui ;;
  touched) touched "${2:?usage: apps-ci.sh touched <path>}" ;;
  *) echo "usage: apps-ci.sh wasm|ui|touched <path>" >&2; exit 2 ;;
esac
