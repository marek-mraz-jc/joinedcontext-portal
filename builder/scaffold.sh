#!/bin/sh
# builder/scaffold.sh <ui|ui-rust> <new-dir>: a fresh application of one shape as its first commit
# holds it (AP-126, AP-128): the `ui` template at the root; or the `ui-rust` template with the
# `ui` template in ui/. The files are the repository's own (tracked or new, never build output),
# without the template's lockfile, which is the runner image's. A git repository of one commit,
# for `build-app --tree`.
set -eu
shape=${1:-}
out=${2:-}
usage() { echo "usage: scaffold.sh ui|ui-rust <new-dir>" >&2; exit 2; }
[ -n "$out" ] && [ ! -e "$out" ] || usage
root=$(cd "$(dirname "$0")/.." && pwd)

# The files of one template folder into a directory.
copy() {
  mkdir -p "$2"
  git -C "$root" ls-files -z -co --exclude-standard -- "$1" \
    | tar -C "$root" --null -T - -cf - \
    | tar -x -C "$2" --strip-components="$(printf '%s' "$1" | awk -F/ '{print NF}')"
}

case "$shape" in
  ui)
    copy sdk/template "$out"
    rm -f "$out/pnpm-lock.yaml"
    ;;
  ui-rust)
    copy sdk/template-fullstack "$out"
    copy sdk/template "$out/ui"
    # One workflow per repository, the ui-rust one; the lockfile is the runner image's.
    rm -rf "$out/ui/.gitea" "$out/ui/pnpm-lock.yaml"
    ;;
  *) usage ;;
esac

git -C "$out" init -q -b main
git -C "$out" add -A
git -C "$out" -c user.name=scaffold -c user.email=scaffold@joinedcontext.invalid commit -q -m "scaffold $shape"
echo "$shape app in $out at $(git -C "$out" rev-parse HEAD)"
