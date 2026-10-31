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
# The host cron's outer timeout (supervisor/tools/walker-cron.sh) only catches a hung script: every
# step below has its own cap. --budget prints the sum, so the cron's limit follows this file: the
# steward walk, then the viewer walk (WALK_CAP + 30 s kill grace each), the journeys (SWEEP_CAP +
# 30 s) and 600 s for install, worktree and summary (T-5161: a flat 1200 s killed the viewer walk).
if [ "${1:-}" = --budget ]; then echo $(( 2 * (cap + 30) + ${SWEEP_CAP:-3600} + 30 + 600 )); exit 0; fi
mkdir -p "$evidence"

exec 9>"$evidence/.lock"
flock -n 9 || { echo "rollout-walk: a walk is running already"; exit 0; }

sha=$(curl -fsS -m 20 "$PORTAL_URL/api/v1/version" | jq -r '.portal.commit // empty') || sha=
[[ $sha =~ ^[0-9a-f]{40}$ ]] || { echo "rollout-walk: $PORTAL_URL/api/v1/version named no commit" >&2; exit 2; }
dir=$evidence/$sha
[ -e "$dir/summary.json" ] && { echo "rollout-walk: $sha walked already ($dir)"; exit 0; }

# T-6076: /api/v1/version names the new commit as soon as its pod is ready, while the old pod still
# drains and the dev sync goes on; the walks that started then met the edge's 502 on their first
# loads (T-6065 13:17Z, T-6076 16:31Z, both fine on retry). A commit is walked once dev has served
# it for WALK_SETTLE_S (300 s, one more cron tick), so the walk judges the Portal people get.
settle=${WALK_SETTLE_S:-300}
now=$(date +%s)
seen_sha='' seen_at=''
read -r seen_sha seen_at <"$evidence/first-seen" 2>/dev/null
if [ "$seen_sha" != "$sha" ] || ! [[ $seen_at =~ ^[0-9]+$ ]]; then seen_at=$now; echo "$sha $now" >"$evidence/first-seen"; fi
if [ $(( now - seen_at )) -lt "$settle" ]; then
  echo "rollout-walk: dev has served $sha for $(( now - seen_at )) s, under $settle s: walk of $sha deferred until the rollout settles" >&2
  exit 1
fi

# T-5993: Chromium makes its renderers the kernel OOM killer's first victims, so on a host short of
# memory (workers linking ~6 GB test binaries beside the walk) every try of a commit met "Page
# crashed" within the same 15 minutes and filed "wrote no report" for a Portal that was fine. Under
# WALK_MIN_AVAILABLE_MIB the walk waits for a later tick, at most WALK_DEFER_MAX ticks (12, an hour at
# the cron's 5 min), then walks anyway, so a host that stays short still gets its walk and its report.
min_free=${WALK_MIN_AVAILABLE_MIB:-6144}
available=$(awk '$1=="MemAvailable:"{print int($2/1024)}' "${WALK_MEMINFO:-/proc/meminfo}" 2>/dev/null)
deferred=$(cat "$evidence/deferred" 2>/dev/null || echo 0)
if [[ $available =~ ^[0-9]+$ ]] && [ "$available" -lt "$min_free" ] && [ "$deferred" -lt "${WALK_DEFER_MAX:-12}" ]; then
  echo "$(( deferred + 1 ))" >"$evidence/deferred"
  echo "rollout-walk: host has $available MiB available, under $min_free: walk of $sha deferred ($(( deferred + 1 )) of ${WALK_DEFER_MAX:-12})" >&2
  exit 1
fi
rm -f "$evidence/deferred"

PORTAL_PASSWORD=$(awk '$1=="demo.steward@hel.fi"{print $2}' "$users")
VIEWER_PASSWORD=$(awk '$1=="demo.viewer@hel.fi"{print $2}' "$users")
# The steward signs in with TOTP (deployment T-5120): its seed is a third column of the users file or,
# without one, Secret keycloak-user-demo-steward, key totp, read through the dev kubeconfig.
PORTAL_TOTP=$(awk '$1=="demo.steward@hel.fi"{print $3}' "$users")
kubeconfig=${WALK_KUBECONFIG:-/workspace/.secrets/kubeconfig-dev.yaml}
if [ -z "$PORTAL_TOTP" ] && [ -r "$kubeconfig" ]; then
  PORTAL_TOTP=$(KUBECONFIG=$kubeconfig kubectl get secret keycloak-user-demo-steward -n "${WALK_NAMESPACE:-dev}" \
    -o jsonpath='{.data.totp}' 2>/dev/null | base64 -d 2>/dev/null || true)
fi
export PORTAL_PASSWORD VIEWER_PASSWORD PORTAL_TOTP
if [ -z "$PORTAL_PASSWORD" ] || [ -z "$VIEWER_PASSWORD" ]; then echo "rollout-walk: no steward or viewer password in $users" >&2; exit 2; fi

git -C "$repo" fetch -q origin || { echo "rollout-walk: git fetch failed" >&2; exit 2; }
work=$(mktemp -d)
trap 'git -C "$repo" worktree remove --force "${work:?}/portal" >/dev/null 2>&1; rm -rf "${work:?}"' EXIT
git -C "$repo" worktree add -q --detach "$work/portal" "$sha" || { echo "rollout-walk: $sha is not in $repo" >&2; exit 2; }
mkdir -p "$dir"
# dev's last apply as the jc-release ConfigMap records it (deployment commit and appliedAt); empty
# without a readable kubeconfig.
release() {
  [ -r "$kubeconfig" ] && KUBECONFIG=$kubeconfig kubectl get configmap jc-release -n "${WALK_NAMESPACE:-dev}" \
    -o jsonpath='{.data.commit} {.data.appliedAt}' 2>/dev/null
}
release_before=$(release) || release_before=
run=$(date -u +%Y-%m-%dT%H:%MZ)
echo "rollout-walk: walking portal $sha on $PORTAL_URL ($run)"
# The steward walks, then the viewer, each with the whole cap. Side by side they shared one address
# at the edge (300 requests a minute, portal-ui limit-count): the steward's walk used the minute up
# and every load of the viewer's shell met 429 on its chunks, so the viewer wrote no report (T-5068).
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
  walk steward
  walk viewer
)
echo "rollout-walk: walks done (logs $dir/walk-steward.log, $dir/walk-viewer.log)"

# T-6174, T-6179: the settle gate covers a rollout before the walk, not an apply during it. The
# 06:55Z walk of 8ee371d met the Portal's 503 when the next apply rolled it to d8f3d24 (T-6174); the
# 07:25Z walk of d8f3d24 met 8 /api reads answering 502 at 07:31:48Z while the deployer applied
# deployment 6215c731 (jc-release appliedAt 07:29:59Z), the Portal commit unchanged (T-6179); both
# fine on retry. When dev names another Portal commit or another jc-release after the walk, its
# findings judge dev mid-apply: nothing is filed, and the next tick walks again once dev has
# settled. A read that fails is no proof of an apply, so that walk is judged as usual.
after=$(curl -fsS -m 20 "$PORTAL_URL/api/v1/version" | jq -r '.portal.commit // empty' 2>/dev/null) || after=
release_after=$(release) || release_after=
moved=
if [[ $after =~ ^[0-9a-f]{40}$ ]] && [ "$after" != "$sha" ]; then
  moved="dev moved from $sha to $after during the walk"
elif [ -n "$release_before" ] && [ -n "$release_after" ] && [ "$release_after" != "$release_before" ]; then
  moved="dev was applied during the walk (jc-release $release_before, then $release_after)"
fi
if [ -n "$moved" ]; then
  echo "$sha $(date +%s)" >"$evidence/first-seen"
  echo "rollout-walk: $moved: its findings are not filed, dev is walked again once it has settled" >&2
  exit 1
fi

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
