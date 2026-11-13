#!/usr/bin/env bash
# Tests upstream-stable-tag.sh against throwaway local repositories; no network, gh is stubbed.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/bin"
printf '#!/bin/sh\ncat "$GH_FIXTURE"\n' >"$tmp/bin/gh"
chmod +x "$tmp/bin/gh"
export PATH="$tmp/bin:$PATH" GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
# shellcheck source=upstream-stable-tag.sh
source "$here/upstream-stable-tag.sh"

fail=0
check() { [[ "$2" == "$3" ]] && echo "ok   $1" || { echo "FAIL $1: got '$2', want '$3'"; fail=1; }; }

# Tag selection: skips drafts, prereleases and odd names; newest by version, not by date.
export GH_FIXTURE=$tmp/releases.json
cat >"$GH_FIXTURE" <<'JSON'
[{"tag_name":"v0.2.0-nightly.20261113.1","draft":false,"prerelease":true},
 {"tag_name":"v0.1.10","draft":false,"prerelease":false},
 {"tag_name":"v0.1.9","draft":false,"prerelease":false},
 {"tag_name":"v0.3.0","draft":true,"prerelease":false},
 {"tag_name":"v0.2.0-rc.1","draft":false,"prerelease":false},
 {"tag_name":"v0.2.0","draft":false,"prerelease":true}]
JSON
check "newest stable by version" "$(upstream_stable_tag)" v0.1.10
echo '[{"tag_name":"v0.2.0","draft":false,"prerelease":true}]' >"$GH_FIXTURE"
check "no stable tag prints nothing" "$(upstream_stable_tag)" ""
echo '[]' >"$GH_FIXTURE"
check "no releases prints nothing" "$(upstream_stable_tag)" ""

# Decisions. main: A-B-C-D-E; the fork merged C. Tags are commits on main or on a side branch.
r=$tmp/repo
git init -q -b main "$r"
c() { git -C "$r" commit -q --allow-empty -m "$1"; git -C "$r" rev-parse HEAD; }
A=$(c A); B=$(c B); C=$(c C); D=$(c D); E=$(c E)
git -C "$r" branch integration "$C"
git -C "$r" checkout -q integration
c fork >/dev/null
git -C "$r" checkout -q --detach "$A"
S=$(c side)   # a tag that does not contain the base C and is not contained in integration
d() { stable_decision "$r" integration "$1" main; }
check "tag contained in integration" "$(d "$B")" release-only
check "tag newer and containing base" "$(d "$D")" merge
check "tag older than base (not contained)" "$(d "$S")" "wait $C"

# upstream-sync.sh's helper-loading block, run from a directory with no sibling helper.
block=$(sed -n '/^# helper-load begin/,/^# helper-load end/p' "$here/upstream-sync.sh")
[[ -n "$block" ]] || { echo "FAIL helper-load block not found"; exit 1; }
cache=$tmp/cache; mkdir "$cache" "$tmp/copy"
git -C "$r" checkout -q integration
mkdir -p "$r/scripts/fork"; cp "$here/upstream-stable-tag.sh" "$r/scripts/fork/"
git -C "$r" add scripts; git -C "$r" commit -q -m helper
git -C "$r" update-ref refs/remotes/origin/integration integration
{ printf 'set -euo pipefail\nlog() { echo "$*" >&2; }\ncache=%q SOURCE=%q BRANCH=integration\n' "$cache" "$r"
  printf '%s\n' "$block"; echo 'type -t stable_decision upstream_stable_tag'; } >"$tmp/copy/block.sh"
check "git-show fallback loads the helper" "$(bash "$tmp/copy/block.sh" 2>&1 | tr '\n' ' ')" "function function "
check "temp helper removed" "$(ls "$cache")" ""
cp "$here/upstream-stable-tag.sh" "$tmp/copy/"
check "sibling helper preferred" "$(bash "$tmp/copy/block.sh" 2>&1 | tr '\n' ' ')" "function function "
rm "$tmp/copy/upstream-stable-tag.sh"; git -C "$r" update-ref refs/remotes/origin/integration "$C"
set +e; out=$(bash "$tmp/copy/block.sh" 2>&1); rc=$?; set -e
check "neither source: exit 2" "$rc" 2
check "neither source: logs why" "${out:0:29}" "cannot load upstream-stable-t"

# Release-only runs never attempt an upstream merge, whatever upstream_sha holds (empty, older, contained).
mblock=$(sed -n '/^# merge-step begin/,/^# merge-step end/p' "$here/upstream-sync.sh")
[[ -n "$mblock" ]] || { echo "FAIL merge-step block not found"; exit 1; }
run_merge_step() { # <release_only> <upstream_sha>; prints the git calls the block made
  : >"$tmp/calls"
  ( git() { echo "$*" >>"$tmp/calls"; return 1; }
    log() { :; }
    release_only=$1 upstream_sha=$2 logs=$tmp budget=b upstream_name=n
    eval "$mblock" ) >/dev/null 2>&1 || true
  cat "$tmp/calls"
}
for sha in "" "$S" "$B"; do
  check "release-only, upstream_sha='${sha:0:7}': no git merge attempted" "$(run_merge_step 1 "$sha")" ""
done
check "merge mode does try git (control)" "$(run_merge_step 0 "$B" | head -1)" "merge-base --is-ancestor $B HEAD"
exit $fail
