#!/bin/sh
# The UI tests a change reaches (T-6153), for ci.yml's ui job when scripts/ci/changes.sh says
# ui_scope=related: the tests that import a file the change touched (vitest related), the changed
# test files, and every test that reads the tree itself (the gate inventories, the locale and
# control registries), which no import graph names. A deleted or renamed file runs the whole
# suite: what imported it is no longer in any graph. ci-full runs the whole suite every day.
#
#   sh scripts/ci/ui-related.sh <base>       run them (from any directory, ui/ installed)
#   sh scripts/ci/ui-related.sh --list <base> print the vitest arguments only
#   sh scripts/ci/ui-related.sh --selftest
set -eu
UI=$(cd "$(dirname "$0")/../../ui" && pwd)
# A test reads the tree when it opens files itself rather than importing them.
TREE='node:fs|from "fs"|readFileSync|readdirSync|existsSync|globSync|import\.meta\.glob|child_process|\?raw'

# The vitest arguments for the paths (relative to ui/) on stdin: `all` for the whole suite, or
# one file per line.
args() {
  files=$(sed '/^$/d')
  printf '%s\n' "$files" | grep -qvE '^(src|tests|e2e)/' && [ -n "$files" ] && { echo all; return; }
  {
    printf '%s\n' "$files" | grep -E '^(src|tests)/' || true
    grep -rlE "$TREE" --include='*.test.ts' --include='*.test.tsx' src tests
  } | sort -u
}

selftest() {
  cd "$UI"
  got=$(printf 'src/i18n.ts\ntests/foo.test.ts\ne2e/models.spec.ts\n' | args)
  printf '%s\n' "$got" | grep -qx 'src/i18n.ts' || { echo "ui-related selftest: a changed source is not passed" >&2; exit 1; }
  printf '%s\n' "$got" | grep -qx 'tests/foo.test.ts' || { echo "ui-related selftest: a changed test is not passed" >&2; exit 1; }
  printf '%s\n' "$got" | grep -qx 'tests/gate_routes.test.ts' || { echo "ui-related selftest: a tree-reading gate is missed" >&2; exit 1; }
  ! printf '%s\n' "$got" | grep -q '^e2e/' || { echo "ui-related selftest: a journey went to vitest" >&2; exit 1; }
  [ "$(printf 'src/a.ts\npackage.json\n' | args)" = all ] || { echo "ui-related selftest: a file outside src/tests/e2e did not run all" >&2; exit 1; }
  [ "$(printf '' | args | grep -c '^tests/gate_')" -ge 6 ] || { echo "ui-related selftest: no change still runs the gates" >&2; exit 1; }
  echo "ui-related selftest: ok"
}

list() {
  cd "$UI"
  # Deleted and renamed paths (git diff --name-status letters D and R) run the whole suite.
  if git diff --name-status "$1" HEAD -- . | grep -qE '^[DR]'; then echo all; return; fi
  git diff --name-only --relative "$1" HEAD -- . | args
}

case ${1:-} in
  --selftest) selftest ;;
  --list) list "$2" ;;
  "") echo "usage: ui-related.sh [--list] <base> | --selftest" >&2; exit 2 ;;
  *)
    picked=$(list "$1")
    cd "$UI"
    if [ "$picked" = all ]; then exec pnpm vitest run; fi
    echo "$picked" | sed 's/^/vitest related: /'
    printf '%s\n' "$picked" | xargs pnpm vitest related --run --passWithNoTests
    ;;
esac
