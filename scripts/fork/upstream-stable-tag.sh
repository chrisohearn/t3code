#!/usr/bin/env bash
# Stable-tag selection for upstream-sync.sh. Run it to print the newest upstream release tag that is
# neither a prerelease nor a draft and looks like vX.Y.Z (sorted by version, not date); it prints
# nothing and exits 0 when there is none. Source it to get stable_decision.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then set -euo pipefail; fi

upstream_stable_tag() {
  # Every page: upstream publishes many nightly prereleases, so the newest stable can be pages deep.
  gh api --paginate --slurp "repos/${T3_UPSTREAM_REPO:-pingdotgg/t3code}/releases?per_page=100" | python3 -I -c '
import json, re, sys
tags = [r["tag_name"] for page in json.load(sys.stdin) for r in page
        if not r["draft"] and not r["prerelease"] and re.fullmatch(r"v\d+\.\d+\.\d+", r["tag_name"])]
if tags:
    print(max(tags, key=lambda t: tuple(map(int, t[1:].split(".")))))'
}

# stable_decision <repo> <integration-ref> <tag-commit> <upstream-main-ref>
# Prints "release-only" when the integration branch already contains the tag, "wait <base>" when
# the tag does not contain the branch's upstream merge-base (the fork is ahead of stable), else "merge".
stable_decision() {
  local repo=$1 branch=$2 tag_sha=$3 main=$4 base
  if git -C "$repo" merge-base --is-ancestor "$tag_sha" "$branch"; then
    echo release-only
    return
  fi
  base=$(git -C "$repo" merge-base "$branch" "$main")
  if git -C "$repo" merge-base --is-ancestor "$base" "$tag_sha"; then
    echo merge
  else
    echo "wait $base"
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then upstream_stable_tag; fi
