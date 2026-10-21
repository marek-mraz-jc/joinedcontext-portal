#!/usr/bin/env bash
# T-4950: walk dev after each portal rollout, without a hand step (UI-01, UI-16, TS-26).
#
#   TASKS_DIR=/workspace/tasks ui/e2e/live/rollout-walk.sh        (host cron every 5 min, or the
#                                                                  deployer right after dev-apply)
#
# Reads the commit dev serves (GET /api/v1/version, public); when no walk of that commit exists
# yet under $WALK_EVIDENCE/<sha>/, it walks dev with the walker of that same commit (a detached
# worktree, so the rules match the UI they judge): steward and viewer, 1440 and 400 px, English,
# within WALK_CAP seconds (900). Then every live journey through sweep.sh (SWEEP_CAP, 3600 s;
# WALK_JOURNEYS=0 skips them). The walker's findings become scripts/walker-summary.ts's summary,
# and with TASKS_DIR set `tasks/file-failures` files one task per new finding (deduplicated on
# rule + route + label against open tasks) and closes the ones that are gone; each names the
# portal tasks merged since the last clean walk. One walk at a time (flock); the last WALK_KEEP
# (20) walks are kept. Exit 0 also when nothing was new; 1 when the walk did not run (retried on
# the next tick); 2 when it cannot start.
#
# The demo steward's and viewer's passwords come from DEMO_USERS (the secrets mount, `user
# password` per line) into the environment only: never onto a command line, a log or the
# evidence; screenshots mask password fields and token-shaped text (shoot.ts secretMasks).
set -uo pipefail
ui=$(cd "$(dirname "$0")/../.." && pwd)
repo=$(cd "$ui/.." && pwd)
export PORTAL_URL=${PORTAL_URL:-https://portal.dev.joinedcontext.com}
evidence=${WALK_EVIDENCE:-/workspace/evidence/walker}
users=${DEMO_USERS:-/workspace/.secrets/demo-users.txt}
cap=${WALK_CAP:-900}
keep=${WALK_KEEP:-20}
mkdir -p "$evidence"

exec 9>"$evidence/.lock"
flock -n 9 || { echo "rollout-walk: a walk is running already"; exit 0; }

sha=$(curl -fsS -m 20 "$PORTAL_URL/api/v1/version" | jq -r '.portal.commit // empty') || sha=
[[ $sha =~ ^[0-9a-f]{40}$ ]] || { echo "rollout-walk: $PORTAL_URL/api/v1/version named no commit" >&2; exit 2; }
dir=$evidence/$sha
[ -e "$dir/summary.json" ] && { echo "rollout-walk: $sha walked already ($dir)"; exit 0; }

PORTAL_PASSWORD=$(awk '$1=="demo.steward@hel.fi"{print $2}' "$users")
VIEWER_PASSWORD=$(awk '$1=="demo.viewer@hel.fi"{print $2}' "$users")
export PORTAL_PASSWORD VIEWER_PASSWORD
if [ -z "$PORTAL_PASSWORD" ] || [ -z "$VIEWER_PASSWORD" ]; then echo "rollout-walk: no steward or viewer password in $users" >&2; exit 2; fi

git -C "$repo" fetch -q origin || { echo "rollout-walk: git fetch failed" >&2; exit 2; }
work=$(mktemp -d)
trap 'git -C "$repo" worktree remove --force "${work:?}/portal" >/dev/null 2>&1; rm -rf "${work:?}"' EXIT
git -C "$repo" worktree add -q --detach "$work/portal" "$sha" || { echo "rollout-walk: $sha is not in $repo" >&2; exit 2; }
mkdir -p "$dir"
run=$(date -u +%Y-%m-%dT%H:%MZ)
echo "rollout-walk: walking portal $sha on $PORTAL_URL ($run)"
# The steward and the viewer walk side by side, the viewer 30 s later so the two Keycloak sign-ins
# do not meet; each walk has the whole cap.
walk() {
  WALK_WIDTHS=1440,400 WALK_LANGS=en WALK_REPORT_DIR="$dir" timeout --kill-after=30 "$cap" \
    npx playwright test --config playwright.live.config.ts e2e/live/walker.spec.ts --grep "for the $1\$" \
    --reporter=list --trace off --output "$dir/pages-$1" >"$dir/walk-$1.log" 2>&1
}
(
  cd "$work/portal/ui" || exit 2
  pnpm install --frozen-lockfile --prefer-offline >"$dir/install.log" 2>&1 || exit 2
  # A walker older than T-4950 writes its report only beside the UX shots.
  grep -q WALK_REPORT_DIR e2e/live/walker.spec.ts || export SHOTS_DIR="$dir"
  walk steward &
  sleep 30
  walk viewer
  wait
)
echo "rollout-walk: walks done (logs $dir/walk-steward.log, $dir/walk-viewer.log)"

# No report from either person: the walk did not run (Keycloak, the Portal, the cap); the next
# tick tries this commit again, three times at most, then files what it has.
if [ ! -s "$dir/walker-steward.json" ] && [ ! -s "$dir/walker-viewer.json" ]; then
  tries=$(( $(cat "$dir/tries" 2>/dev/null || echo 0) + 1 )); echo "$tries" >"$dir/tries"
  [ "$tries" -lt 3 ] && { echo "rollout-walk: no walker report (try $tries of 3), see $dir/walk-*.log" >&2; exit 1; }
fi

# The journeys sign in as the approver and the editor too, whose passwords live in the cluster:
# the deployer's apply step exports them; without them only the walk runs.
if [ -n "${APPROVER_PASSWORD:-}" ] && [ -n "${EDITOR_PASSWORD:-}" ] && [ "${WALK_JOURNEYS:-1}" = 1 ]; then
  (cd "$work/portal/ui" && env -u TASKS_DIR SWEEP_OUT="$dir/sweep" timeout --kill-after=30 "${SWEEP_CAP:-3600}" e2e/live/sweep.sh) >"$dir/sweep.log" 2>&1
  echo "rollout-walk: journeys exited $? (summary $dir/sweep/summary.json)"
else
  echo "rollout-walk: journeys skipped (no APPROVER_PASSWORD/EDITOR_PASSWORD, or WALK_JOURNEYS=0)"
fi

# The portal tasks merged since the last walk that found nothing: one of them likely brought it.
merged=
if [ -s "$evidence/last-clean" ] && git -C "$repo" cat-file -e "$(cat "$evidence/last-clean")^{commit}" 2>/dev/null; then
  merged=$(git -C "$repo" log --format='%s %b' "$(cat "$evidence/last-clean")..$sha" | grep -oE 'T-[0-9]{4,5}' | sort -u | paste -sd, -)
fi
if ! node "$ui/scripts/walker-summary.ts" "$dir" "$run $sha" --previous "$evidence/last-summary.json" --merged "$merged" >"$dir/summary.json.part"; then
  echo "rollout-walk: no summary" >&2; exit 2
fi
mv "$dir/summary.json.part" "$dir/summary.json"
cp "$dir/summary.json" "$evidence/last-summary.json"
if ! jq -e '[.results[] | select(.verdict != "pass")] | length > 0' "$dir/summary.json" >/dev/null; then
  echo "$sha" >"$evidence/last-clean"
fi
# --commit: a finding whose finished task merged after $sha waits for the deploy instead of a duplicate (T-5008).
if [ -n "${TASKS_DIR:-}" ]; then
  "$TASKS_DIR/file-failures" "$dir/summary.json" --commit="$sha" --git="$repo" | tee "$dir/filed.log"
  [ -s "$dir/sweep/summary.json" ] && "$TASKS_DIR/file-failures" "$dir/sweep/summary.json" --commit="$sha" --git="$repo" | tee -a "$dir/filed.log"
fi

# Keep the newest walks only; each holds a few hundred screenshots.
find "$evidence" -mindepth 1 -maxdepth 1 -type d -regextype posix-extended -regex '.*/[0-9a-f]{40}' -printf '%T@ %p\n' \
  | sort -rn | tail -n +"$((keep + 1))" | cut -d' ' -f2- | while read -r old; do rm -rf "${old:?}"; done
echo "rollout-walk: done, evidence $dir"
