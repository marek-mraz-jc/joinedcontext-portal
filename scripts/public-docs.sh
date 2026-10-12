#!/usr/bin/env bash
# The public part of the documentation (T-4063): the API chapter and the User Guide, which the
# Portal serves at /docs/{chapter}/{page} to anyone, signed in or not. Bundled at build time from
# a pinned docs commit, like ui/src/generated/guideSections.json: no runtime fetch, and the words
# match this Portal's version. No other chapter is copied, so none can be served.
#
#   scripts/public-docs.sh <docs-clone> <commit>   rewrites public-docs/
#
# The docs repository is private, so CI does not re-derive the folder; a person moves the pin by
# running this against a newer docs commit and committing the result.
set -euo pipefail
[ $# -eq 2 ] || { echo "usage: $0 <docs-clone> <commit>" >&2; exit 64; }
clone=$1
commit=$(git -C "$clone" rev-parse --verify "$2^{commit}")
out="$(cd "$(dirname "$0")/.." && pwd)/public-docs"
rm -rf "${out:?}"
for chapter in API User-Guide; do
	mkdir -p "$out/$chapter"
	git -C "$clone" ls-tree --name-only "$commit" "$chapter/" | grep '\.md$' | while read -r file; do
		git -C "$clone" show "$commit:$file" >"$out/$file"
	done
done
echo "$commit" >"$out/COMMIT"
