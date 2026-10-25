#!/bin/sh
# Which ci.yml jobs a change needs (T-4985). Prints rust=, ui=, apps= and gallery= as true/false for
# $GITHUB_OUTPUT, from the paths changed between <base> and HEAD (or read on stdin, one per line).
# No base, a line `*`, or ci.yml itself runs everything; gitleaks runs on every push and main's
# base (its last green commit, T-4696) is decided in ci.yml.
#
#   sh scripts/ci/changes.sh "$base"
#   git diff --name-only "$base" HEAD | sh scripts/ci/changes.sh -
#   sh scripts/ci/changes.sh --selftest
#
# rust runs for every path except ui/, docs/ and the top-level *.md, so a new folder is covered
# by default. A ui/ file still runs it when the Rust the fast lane compiles or tests names it
# (ui/openapi.json): the lane's unit tests read sdk/, apps/ and ui/ files. The other way round,
# the UI suite reads a few files outside ui/ and sdk/: the help clips' script, public-docs/, the
# Rust fixtures, and the activity kinds the server writes (src/**/*.rs, see kinds_added).
# gallery runs the component-gallery baselines (T-5575) when a shared component, the styles they
# draw with, the gallery page, its spec or baselines, or the SDK sources the UI links change.
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
# Exit 0 when the fast lane's Rust names the ui/ file $1 or one of its folders, as a whole
# string literal ("ui/openapi.json", "ui/src/locales").
rust_reads() {
  p=$1 pats=""
  while case $p in ui/*/*) true ;; *) false ;; esac; do
    pats="$pats$p\"
"
    p=${p%/*}
  done
  pats="$pats$p\""
  # What the rust job compiles and tests: the crate (--lib --bins) and the integration tests it
  # names. Keep this list in step with the job's `cargo test` lines.
  (cd "$ROOT" && printf '%s\n' "$pats" |
    grep -rqF -f - src build.rs tests/openapi_tests.rs tests/route_coverage_tests.rs \
      tests/authz_matrix_tests.rs tests/problem_types_tests.rs tests/gitea_client_tests.rs)
}

classify() {
  rust=false ui=false apps=false gallery=false
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case $f in
      '*' | .github/workflows/ci.yml) everything ;;
    esac
    case $f in
      ui/* | sdk/* | scripts/bundle-budget* | public-docs/* | tests/fixtures/*) ui=true ;;
    esac
    case $f in
      apps/* | sdk/* | builder/* | scripts/*) apps=true ;;
    esac
    case $f in
      ui/src/components/* | ui/src/tokens.css | ui/src/index.css | ui/src/fonts.css | \
        ui/src/pages/gallery/* | ui/e2e/gallery.spec.ts* | ui/playwright.config.ts | \
        ui/package.json | ui/pnpm-lock.yaml | sdk/src/*) gallery=true ;;
    esac
    case $f in
      docs/*) ;;
      ui/*) if rust_reads "$f"; then rust=true; fi ;;
      */*) rust=true ;;
      *.md) ;;
      *) rust=true ;;
    esac
  done
}

# Exit 0 when the Rust between $1 and HEAD adds a line ui/tests/activity_kinds.test.ts collects
# as an activity kind, which the UI must then label.
KIND_LINE='^\+.*(kind: "[a-z]+[.-]|record\(|let kind = ")'
kinds_added() {
  git -C "$ROOT" diff -U0 "$1" HEAD -- 'src/*.rs' | grep -qE "$KIND_LINE"
}

report() {
  printf 'rust=%s\nui=%s\napps=%s\ngallery=%s\n' "$rust" "$ui" "$apps" "$gallery"
}

selftest() {
  check() {
    got=$(printf '%b' "$2" | { classify; report; } | tr '\n' ' ')
    [ "$got" = "$3" ] || { echo "changes selftest: $1: got '$got', want '$3'" >&2; exit 1; }
  }
  check "a page outside the gallery" 'ui/src/pages/apps/AppTemplates.tsx\n' "rust=false ui=true apps=false gallery=false "
  check "the colour tokens" 'ui/src/tokens.css\n' "rust=false ui=true apps=false gallery=true "
  check "a gallery baseline" 'ui/e2e/gallery.spec.ts-snapshots/gallery-dark-gallery-linux.png\n' "rust=false ui=true apps=false gallery=true "
  check "ui only" 'ui/src/components/Foo.tsx\n' "rust=false ui=true apps=false gallery=true "
  check "committed OpenAPI spec" 'ui/openapi.json\n' "rust=true ui=true apps=false gallery=false "
  check "read by a ci-full test only" 'ui/src/pages/apps/AppGenerator.tsx\n' "rust=false ui=true apps=false gallery=false "
  check "a locale the problem-types test reads" 'ui/src/locales/sk.json\n' "rust=true ui=true apps=false gallery=false "
  check "src only" 'src/main.rs\nmigrations/0001.sql\n' "rust=true ui=false apps=false gallery=false "
  check "a fixture the UI suite reads" 'tests/fixtures/bus-expires.blobl\n' "rust=true ui=true apps=false gallery=false "
  check "lock" 'Cargo.lock\n' "rust=true ui=false apps=false gallery=false "
  check "apps only" 'apps/air-quality/ui/src/App.tsx\n' "rust=true ui=false apps=true gallery=false "
  check "sdk" 'sdk/src/sdk/index.ts\n' "rust=true ui=true apps=true gallery=true "
  check "docs only" 'docs/analysis/x.md\nREADME.md\n' "rust=false ui=false apps=false gallery=false "
  check "nested md is not docs" 'src/agents/server_section.md\n' "rust=true ui=false apps=false gallery=false "
  check "unknown folder runs rust" 'newdir/x.txt\n' "rust=true ui=false apps=false gallery=false "
  check "the workflow" '.github/workflows/ci.yml\n' "rust=true ui=true apps=true gallery=true "
  check "another workflow" '.github/workflows/image.yml\n' "rust=true ui=false apps=false gallery=false "
  check "no base" '*\n' "rust=true ui=true apps=true gallery=true "
  check "nothing" '' "rust=false ui=false apps=false gallery=false "
  printf '+        kind: "app.shared".to_owned(),\n' | grep -qE "$KIND_LINE" ||
    { echo "changes selftest: an added activity kind is not seen" >&2; exit 1; }
  ! printf '+    let kinds = 3;\n-        kind: "a.b".to_owned(),\n' | grep -qE "$KIND_LINE" ||
    { echo "changes selftest: a removed kind or plain code runs the UI suite" >&2; exit 1; }
  echo "changes selftest: ok"
}

everything() {
  rust=true ui=true apps=true gallery=true
}

case ${1:-} in
  --selftest) selftest ;;
  -) classify; report ;;
  "") everything; report ;;
  *)
    if paths=$(git -C "$ROOT" diff --name-only "$1" HEAD 2>/dev/null); then
      classify <<EOF
$paths
EOF
      if [ "$ui" = false ] && kinds_added "$1"; then ui=true; fi
    else
      # A base the shallow clone does not hold is no base either.
      everything
    fi
    report
    ;;
esac
