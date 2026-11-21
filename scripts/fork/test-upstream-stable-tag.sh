#!/usr/bin/env bash
# Tests upstream-stable-tag.sh against throwaway local repositories; no network, gh is stubbed.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/bin"
# The stub only answers a paginated, slurped request (the fixture is a list of pages).
printf '#!/bin/sh\ncase "$*" in *--paginate*--slurp*) cat "$GH_FIXTURE" ;; *) echo "gh stub: unpaginated request" >&2; exit 1 ;; esac\n' >"$tmp/bin/gh"
chmod +x "$tmp/bin/gh"
export PATH="$tmp/bin:$PATH" GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
# shellcheck source=upstream-stable-tag.sh
source "$here/upstream-stable-tag.sh"

fail=0
check() { [[ "$2" == "$3" ]] && echo "ok   $1" || { echo "FAIL $1: got '$2', want '$3'"; fail=1; }; }

# Tag selection: skips drafts, prereleases and odd names; newest by version, not by date.
export GH_FIXTURE=$tmp/releases.json
cat >"$GH_FIXTURE" <<'JSON'
[[{"tag_name":"v0.2.0-nightly.20261113.1","draft":false,"prerelease":true},
 {"tag_name":"v0.1.10","draft":false,"prerelease":false},
 {"tag_name":"v0.1.9","draft":false,"prerelease":false},
 {"tag_name":"v0.3.0","draft":true,"prerelease":false},
 {"tag_name":"v0.2.0-rc.1","draft":false,"prerelease":false},
 {"tag_name":"v0.2.0","draft":false,"prerelease":true}]]
JSON
check "newest stable by version" "$(upstream_stable_tag)" v0.1.10
echo '[[{"tag_name":"v0.2.0","draft":false,"prerelease":true}]]' >"$GH_FIXTURE"
check "no stable tag prints nothing" "$(upstream_stable_tag)" ""
echo '[[]]' >"$GH_FIXTURE"
check "no releases prints nothing" "$(upstream_stable_tag)" ""
# More than 100 prereleases (two full pages) before the stable tag: it must still be found.
python3 -I - >"$GH_FIXTURE" <<'PY'
import json
pre = lambda i: {"tag_name": f"v0.2.0-nightly.20261113.{i}", "draft": False, "prerelease": True}
print(json.dumps([[pre(i) for i in range(100)], [pre(i) for i in range(100, 200)],
                  [{"tag_name": "v0.1.9", "draft": False, "prerelease": False}]]))
PY
check "stable tag found past 200 prereleases" "$(upstream_stable_tag)" v0.1.9

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

# Conflict handling must update the issue with this exact title, not an unrelated
# issue that happens to share the upstream-sync label.
issue_block=$(sed -n '/matching-issue begin/,/matching-issue end/p' "$here/upstream-sync.sh")
[[ -n "$issue_block" ]] || { echo "FAIL matching-issue block not found"; exit 1; }
cat >"$tmp/issues.json" <<'JSON'
[
  {"number":149,"title":"Upstream sync conflict: v0.1.10"},
  {"number":150,"title":"Upstream sync conflict: v0.1.11"}
]
JSON
find_issue() {
  ( FORK=chrisohearn/t3code GH_ISSUES=$1
    gh() { cat "$GH_ISSUES"; }
    eval "$issue_block"
    find_open_conflict_issue "Upstream sync conflict: v0.1.11" )
}
check "conflict issue lookup matches the exact title" "$(find_issue "$tmp/issues.json")" 150
cat >"$tmp/issues.json" <<'JSON'
[{"number":149,"title":"Upstream sync conflict: v0.1.10"}]
JSON
check "conflict issue lookup ignores unrelated labeled issues" "$(find_issue "$tmp/issues.json")" ""

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

# Stable mode refuses an open sync PR that carries upstream beyond the selected tag (exit 4, no merge).
gblock=$(sed -n '/open-pr-guard begin/,/open-pr-guard end/p' "$here/upstream-sync.sh")
[[ -n "$gblock" ]] || { echo "FAIL open-pr-guard block not found"; exit 1; }
git -C "$r" update-ref refs/remotes/upstream/main main
run_guard() { # <pr-head> <tag-sha> <stable_tag> [dry_run]; prints "rc=N comments=N worktree=kept|removed"
  local wt=$tmp/guard-wt
  git -C "$r" worktree add -q --detach "$wt" "$1"
  : >"$tmp/gh-calls"
  set +e
  ( gh() { echo "$*" >>"$tmp/gh-calls"; }
    log() { :; }
    UPSTREAM_TRACK=stable SOURCE=$r wt=$wt pr_number=7 FORK=f upstream_sha=$2 stable_tag=$3 dry_run=${4:-}
    eval "$gblock"; exit 0 ) >/dev/null 2>&1
  local rc=$?
  set -e
  local kept=removed; [[ -d "$wt" ]] && kept=kept
  echo "rc=$rc comments=$(wc -l <"$tmp/gh-calls" | tr -d ' ') worktree=$kept"
  git -C "$r" worktree remove --force "$wt" 2>/dev/null || true
}
check "open PR within the tag continues" "$(run_guard "$D" "$E" v1)" "rc=0 comments=0 worktree=kept"
check "open PR beyond the tag: exit 4, comment, worktree removed" "$(run_guard "$E" "$D" v1)" "rc=4 comments=1 worktree=removed"
check "open PR beyond the tag, dry run: no comment" "$(run_guard "$E" "$D" v1 1)" "rc=4 comments=0 worktree=removed"
check "open PR with no stable tag is refused" "$(run_guard "$D" "" "")" "rc=4 comments=1 worktree=removed"

# Every publication path carries the local memories_v2 compatibility note.
release_repo="$tmp/release-repo"
release_remote="$tmp/release-origin.git"
git init -q --bare -b integration "$release_remote"
git init -q -b integration "$release_repo"
git -C "$release_repo" config user.name t
git -C "$release_repo" config user.email t@t
printf 'release tree\n' >"$release_repo/tree.txt"
mkdir -p "$release_repo/scripts/fork"
printf 'older publisher\n' >"$release_repo/scripts/fork/publish-release.sh"
git -C "$release_repo" add tree.txt scripts/fork/publish-release.sh
git -C "$release_repo" commit -q -m previous-release
git -C "$release_repo" remote add origin "$release_remote"
git -C "$release_repo" tag v0.1.10-preview.20261119.1
printf '%s\n' 'CODEX_SHADOW_COMPATIBILITY_RELEASE_NOTE_V1' >"$release_repo/scripts/fork/publish-release.sh"
git -C "$release_repo" add scripts/fork/publish-release.sh
git -C "$release_repo" commit -q -m add-shadow-compatibility-note
git -C "$release_repo" push -q -u origin integration
git -C "$release_repo" fetch -q origin
release_commit=$(git -C "$release_repo" rev-parse HEAD)
release_version=0.1.10-preview.20261119.2
release_artifacts="$tmp/release/artifacts"
mkdir -p "$release_artifacts" "$tmp/release-bin"
printf 'build %s\n' "$release_commit" >"$tmp/release/build.txt"
printf 'archive\n' >"$release_artifacts/t3-$release_version-linux-x64.tar.gz"
(cd "$release_artifacts" && sha256sum "t3-$release_version-linux-x64.tar.gz" >SHA256SUMS)
cat >"$tmp/release-bin/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == release && "${2:-}" == create ]]; then
  shift 2
  while (($#)); do
    if [[ "$1" == --notes ]]; then
      shift
      printf '%s' "$1" >"$GH_NOTES"
      exit 0
    fi
    shift
  done
  exit 1
fi
if [[ "${1:-}" == release && "${2:-}" == view ]]; then
  echo '{"isPrerelease":true,"assets":[]}'
  exit 0
fi
exit 1
SH
chmod +x "$tmp/release-bin/gh"
(
  cd "$release_repo"
  GH_NOTES="$tmp/release-notes" T3_FORK_REPO=test/fork T3_FORK_BRANCH=integration \
    PATH="$tmp/release-bin:$PATH" bash "$here/publish-release.sh" "$release_version" \
      "$release_artifacts" "$release_commit" 'Upstream sync test note.'
)
if grep -Fq 'Upstream sync test note.' "$tmp/release-notes" &&
  grep -Fq 'Codex shadow compatibility:' "$tmp/release-notes"; then
  echo 'ok   first release includes the Codex shadow compatibility note'
else
  echo 'FAIL first release omits the Codex shadow compatibility note'
  fail=1
fi

git -C "$release_repo" tag v0.1.10-preview.20261119.2 "$release_commit"
printf 'next release tree\n' >>"$release_repo/tree.txt"
git -C "$release_repo" add tree.txt
git -C "$release_repo" commit -q -m later-release
git -C "$release_repo" push -q origin integration
next_commit=$(git -C "$release_repo" rev-parse HEAD)
next_version=0.1.10-preview.20261119.3
next_artifacts="$tmp/release-next/artifacts"
mkdir -p "$next_artifacts"
printf 'build %s\n' "$next_commit" >"$tmp/release-next/build.txt"
printf 'archive\n' >"$next_artifacts/t3-$next_version-linux-x64.tar.gz"
(cd "$next_artifacts" && sha256sum "t3-$next_version-linux-x64.tar.gz" >SHA256SUMS)
(
  cd "$release_repo"
  GH_NOTES="$tmp/next-release-notes" T3_FORK_REPO=test/fork T3_FORK_BRANCH=integration \
    PATH="$tmp/release-bin:$PATH" bash "$here/publish-release.sh" "$next_version" \
      "$next_artifacts" "$next_commit" 'Later upstream sync note.'
)
if grep -Fq 'Later upstream sync note.' "$tmp/next-release-notes" &&
  ! grep -Fq 'Codex shadow compatibility:' "$tmp/next-release-notes"; then
  echo 'ok   later release retires the Codex shadow compatibility note'
else
  echo 'FAIL later release repeated the Codex shadow compatibility note'
  fail=1
fi
exit $fail
