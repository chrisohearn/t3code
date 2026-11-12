#!/usr/bin/env bash
# Publishes a fork release from build-release.sh output. The target commit must have the tree the
# archive was built from (for a PR build, its merge commit on the integration branch).
#
#   scripts/fork/publish-release.sh <version> <artifacts-dir> <target-commit> <notes>
#
# Publishing is deploying: the host's update guard installs the newest fork release when idle.
set -euo pipefail

version=${1:?version}; artifacts=${2:?artifacts dir}; target=${3:?target commit}; notes=${4:?notes}
repo_slug=${T3_FORK_REPO:-chrisohearn/t3code}
archive="t3-$version-linux-x64.tar.gz"
built=$(cut -d' ' -f2 "$artifacts/../build.txt")
[[ "$(git rev-parse "$built^{tree}")" == "$(git rev-parse "$target^{tree}")" ]] ||
  { echo "target $target does not have the tree that was built ($built)" >&2; exit 1; }
git merge-base --is-ancestor "$target" "origin/${T3_FORK_BRANCH:-integration/mcp-events-20261109}" ||
  { echo "target $target is not on the pushed integration branch" >&2; exit 1; }
(cd "$artifacts" && [[ "$(cat SHA256SUMS)" == *"  $archive" ]] && sha256sum -c SHA256SUMS)
gh release create "v$version" -R "$repo_slug" --target "$(git rev-parse "$target")" --prerelease \
  --title "v$version" --notes "$notes" "$artifacts/$archive" "$artifacts/SHA256SUMS"
gh release view "v$version" -R "$repo_slug" --json assets,isPrerelease --jq '{isPrerelease, assets: [.assets[].name]}'
