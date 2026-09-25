#!/usr/bin/env bash
# T-2734: the hourly live sweep, started by the cluster batch after dev-smoke (TS-01, TS-26).
#
#   PORTAL_URL=… PORTAL_PASSWORD=… APPROVER_PASSWORD=… VIEWER_PASSWORD=… EDITOR_PASSWORD=… \
#     PROPOSER_CLIENT_SECRET=… \
#     TASKS_DIR=/workspace/tasks ui/e2e/live/sweep.sh
#
# Runs every live journey and the page walker, except what spends the assistant's model: the
# specs that build or integrate by conversation, and every test whose title names the assistant
# (those run in the nightly eval batch, T-2733, within the daily budget). The Playwright report
# becomes a summary (scripts/sweep-summary.ts: one result per test, passwords and tokens taken
# out), and with TASKS_DIR set, `tasks/file-failures` turns each new failure into a task and
# leaves a known one on its task. Exits with Playwright's status, so the batch sees red as red.
set -uo pipefail
ui=$(cd "$(dirname "$0")/../.." && pwd)
out=${SWEEP_OUT:-$ui/test-results/sweep}
mkdir -p "$out"
cd "$ui" || exit 2

# The model-spending specs, by file: each of their tests is a conversation with the model.
spending='/(assistant-paths|assistant-evals|app-generated-full|build-samples|readiness-app)\.spec\.ts$'
mapfile -t specs < <(ls e2e/live/*.spec.ts | grep -vE "$spending")

PLAYWRIGHT_JSON_OUTPUT_NAME="$out/report.json" npx playwright test \
  --config playwright.live.config.ts --reporter=list,json \
  --grep-invert '\bassistant\b' "${specs[@]}"
status=$?

if [ ! -s "$out/report.json" ]; then
  echo "sweep: Playwright wrote no report (status $status); nothing to summarise" >&2
  exit "${status:-2}"
fi
node scripts/sweep-summary.ts "$out/report.json" > "$out/summary.json" || exit 2
echo "sweep: $(grep -c '"verdict": "pass"' "$out/summary.json") passed, $(grep -cE '"verdict": "(fail|error)"' "$out/summary.json") failed; summary $out/summary.json"
if [ -n "${TASKS_DIR:-}" ]; then
  "$TASKS_DIR/file-failures" "$out/summary.json" || exit 2
fi
exit "$status"
