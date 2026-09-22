#!/bin/sh
# The publish step of an application's workflow (AP-101, ADR-N-028): the build `build-app` left in
# $JC_BUILD_DIR becomes the generic package `app-{name}`, version `{commit}`, of the organization,
# written with this repository's job token and no other credential. `build.yml` sets:
#
#   JC_FORGE_URL    the forge in-cluster, as the runner sets it for every job; JC_OWNER the organization, JC_REPOSITORY owner/{project}_{app}
#   JC_APP_COMMIT   the commit that was built
#   JC_FORGE_TOKEN  the job token
set -eu

fail() { echo "publish failed: $*" >&2; exit 1; }
for name in JC_FORGE_URL JC_OWNER JC_REPOSITORY JC_APP_COMMIT JC_FORGE_TOKEN; do
  eval "[ -n \"\${$name:-}\" ]" || fail "$name is not set"
done
WORK=${JC_BUILD_DIR:-/tmp/build}
APP=$(node /opt/template/lane.mjs app "$JC_REPOSITORY") || fail "$JC_REPOSITORY is not {project}_{app}"
APP=${APP#* }
BASE="$JC_FORGE_URL/api/packages/$JC_OWNER/generic/app-$APP/$JC_APP_COMMIT"

# The token travels in a config on stdin, never on a command line another process could read.
forge() {
  printf 'header = "Authorization: token %s"\n' "$JC_FORGE_TOKEN" | curl -K - --silent --show-error "$@"
}
for file in bundle.tar.gz sbom.cdx.json; do
  [ -s "$WORK/$file" ] || fail "the build left no $file"
  status=$(forge -o /dev/null -w '%{http_code}' -X PUT --upload-file "$WORK/$file" "$BASE/$file")
  if [ "$status" = 409 ]; then
    # A rebuild of the same commit: the version holds the earlier upload, which is replaced. The
    # host keeps serving the copy it verified until the new status.build names another digest.
    forge --fail -o /dev/null -X DELETE "$BASE/$file" || fail "cannot replace $file of app-$APP $JC_APP_COMMIT"
    status=$(forge -o /dev/null -w '%{http_code}' -X PUT --upload-file "$WORK/$file" "$BASE/$file")
  fi
  case "$status" in 2??) echo "published app-$APP $JC_APP_COMMIT $file" ;; *) fail "the registry answered $status for $file" ;; esac
done
