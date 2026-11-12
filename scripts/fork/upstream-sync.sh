#!/usr/bin/env bash
# Daily upstream sync for the fork: merges pingdotgg/t3code main into the integration branch,
# checks the result, and publishes a fork preview release when everything passes. Publishing is
# deploying: the host's update guard installs the newest fork release when no threads run.
#
#   scripts/fork/upstream-sync.sh [--dry-run]
#
# Exit codes (the scheduled agent acts on them; see FORK.md):
#   0  nothing to do, or merged and released (an open sync/upstream-* PR is re-checked first)
#   3  merge conflict: an issue labelled upstream-sync (or a comment on the open sync PR)
#   4  checks, build or preflight failed: the merge is in an open PR, nothing published
#   2  environment problem (missing tool, dirty source checkout)
set -euo pipefail

FORK=${T3_FORK_REPO:-chrisohearn/t3code}
BRANCH=${T3_FORK_BRANCH:-integration/mcp-events-20261109}
UPSTREAM_URL=https://github.com/pingdotgg/t3code.git
SOURCE=${T3_FORK_SOURCE:-$HOME/.t3/sources/t3code-ownership-personal-fork-20261110}
WORKTREES=${T3_FORK_WORKTREES:-$HOME/.t3/worktrees/t3code-ownership-personal-fork-20261110}
LIVE_DB=${T3_LIVE_DB:-$HOME/.t3/userdata/statev2.sqlite}
dry_run=${1:-}

for tool in git gh docker python3 curl flock; do
  command -v "$tool" >/dev/null || { echo "missing $tool" >&2; exit 2; }
done
log() { printf '[upstream-sync] %s\n' "$*" >&2; }
cache=${XDG_CACHE_HOME:-$HOME/.cache}/t3-fork-release
mkdir -p "$cache/logs"
exec 9>"$cache/upstream-sync.lock"
flock -n 9 || { log "another sync is running"; exit 0; }

git -C "$SOURCE" remote get-url upstream >/dev/null 2>&1 ||
  git -C "$SOURCE" remote add upstream "$UPSTREAM_URL"
git -C "$SOURCE" fetch -q origin
git -C "$SOURCE" fetch -q --no-tags upstream main
upstream_sha=$(git -C "$SOURCE" rev-parse upstream/main)
release_only=0
if git -C "$SOURCE" merge-base --is-ancestor "$upstream_sha" "origin/$BRANCH"; then
  latest_tag=$(gh api "repos/$FORK/releases?per_page=100" --jq '
    .[] | select(.draft | not)
    | select(.tag_name | test("^v[0-9]+\\.[0-9]+\\.[0-9]+-preview\\.[0-9]{8}\\.[0-9]+$"))
    | . as $release
    | select(any(.assets[]; .name == "SHA256SUMS"))
    | select(any(.assets[]; .name == ("t3-" + ($release.tag_name | ltrimstr("v")) + "-linux-x64.tar.gz")))
    | .tag_name' | sort -V | tail -1)
  if [[ -n "$latest_tag" ]]; then
    git -C "$SOURCE" fetch -q origin "refs/tags/$latest_tag:refs/tags/$latest_tag"
    if [[ "$(git -C "$SOURCE" rev-parse "$latest_tag^{tree}")" == \
          "$(git -C "$SOURCE" rev-parse "origin/$BRANCH^{tree}")" ]]; then
      log "integration already contains upstream ${upstream_sha:0:10} and is published"
      exit 0
    fi
  fi
  release_only=1
  log "integration contains upstream but is unpublished; retrying release"
fi
behind=$(git -C "$SOURCE" rev-list --count "origin/$BRANCH..$upstream_sha")

# An open sync PR (one a failed run opened, or an agent's conflict fix) is re-checked and, when
# it passes, merged and released. Otherwise start a new sync branch from the integration branch.
open_pr=""
if [[ "$release_only" == 0 ]]; then
  open_pr=$(gh pr list -R "$FORK" --base "$BRANCH" --state open --json number,headRefName \
    --jq '[.[] | select(.headRefName | startswith("sync/upstream-"))][0] // empty | "\(.number) \(.headRefName)"')
fi
stamp=$(date -u +%Y%m%d-%H%M)
wt="$WORKTREES/upstream-sync-$stamp"
if [[ -n "$open_pr" ]]; then
  read -r pr_number sync_branch <<<"$open_pr"
  git -C "$SOURCE" fetch -q origin "$sync_branch"
  git -C "$SOURCE" worktree add -q -B "$sync_branch" "$wt" "origin/$sync_branch"
  # Finish this candidate before incorporating newer upstream commits and resetting its CI.
  upstream_sha=$(git -C "$wt" merge-base HEAD upstream/main)
  behind=$(git -C "$SOURCE" rev-list --count "origin/$BRANCH..$upstream_sha")
  log "re-checking open sync PR #$pr_number ($sync_branch)"
else
  pr_number=""
  sync_branch="sync/upstream-$stamp"
  git -C "$SOURCE" worktree add -q -b "$sync_branch" "$wt" "origin/$BRANCH"
fi
cleanup() { [[ -n "${keep_worktree:-}" ]] || git -C "$SOURCE" worktree remove --force "$wt" 2>/dev/null || true; }
trap cleanup EXIT
cd "$wt"
logs=$(mktemp -d -p "$cache/logs" "$stamp-XXXX")
log "merging upstream ${upstream_sha:0:10} ($behind commits) on $sync_branch; logs in $logs"

# Keep the PR mergeable when the integration branch moved since it was opened.
if [[ -n "$pr_number" ]] && ! git merge-base --is-ancestor "origin/$BRANCH" HEAD; then
  git merge -q --no-edit "origin/$BRANCH" >"$logs/base-merge.log" 2>&1 || {
    git merge --abort
    [[ -n "$dry_run" ]] || gh pr comment "$pr_number" -R "$FORK" \
      --body "The daily sync could not merge the latest \`$BRANCH\` into this branch (conflict). Resolve it here; nothing was released."
    exit 3
  }
fi

budget=apps/server/src/provider/agentContextBudget.json
if git merge-base --is-ancestor "$upstream_sha" HEAD; then
  log "branch already contains upstream ${upstream_sha:0:10}"
elif ! git -c merge.conflictstyle=zdiff3 merge -q --no-edit \
  -m "Merge upstream main (${upstream_sha:0:10}) into $BRANCH" "$upstream_sha" >"$logs/merge.log" 2>&1; then
  # The context budget is measured output; take upstream's and re-measure below.
  if git diff --name-only --diff-filter=U | grep -qx "$budget"; then
    git checkout --theirs -- "$budget" && git add "$budget"
  fi
  conflicts=$(git diff --name-only --diff-filter=U)
  if [[ -n "$conflicts" ]]; then
    git merge --abort
    title="Upstream sync conflict: upstream ${upstream_sha:0:10}"
    body=$(printf 'The daily upstream sync could not merge `pingdotgg/t3code` main (%s, %s commits) into `%s`.\n\nConflicting files:\n%s\n\nResolve it in a worktree from fresh `origin/%s`, following FORK.md (fork migrations stay in `ForkMigrations/`), then open a PR into `%s` from a `sync/upstream-*` branch. The next sync run checks, merges and releases it.\n' \
      "$upstream_sha" "$behind" "$BRANCH" "$(printf -- '- `%s`\n' $conflicts)" "$BRANCH" "$BRANCH")
    gh label create upstream-sync -R "$FORK" --color FBCA04 --description "Daily upstream sync" 2>/dev/null || true
    existing=$(gh issue list -R "$FORK" --label upstream-sync --state open --json number --jq '.[0].number // empty')
    if [[ -n "$dry_run" ]]; then
      log "dry run: would open or update an issue: $title"
    elif [[ -n "$pr_number" ]]; then
      gh pr comment "$pr_number" -R "$FORK" --body "$body" >/dev/null
      log "conflict; commented on sync PR #$pr_number"
    elif [[ -n "$existing" ]]; then
      gh issue comment "$existing" -R "$FORK" --body "$body" >/dev/null
      gh issue edit "$existing" -R "$FORK" --title "$title" >/dev/null
      log "conflict; updated issue #$existing"
    else
      gh issue create -R "$FORK" --label upstream-sync --title "$title" --body "$body"
    fi
    printf '%s\n' $conflicts >&2
    exit 3
  fi
  git commit -q --no-edit
fi

fail() {
  local reason=$1
  log "FAILED: $reason"
  if [[ -n "$dry_run" ]]; then keep_worktree=1; log "dry run: worktree kept at $wt"; exit 4; fi
  git push -q -u origin "$sync_branch"
  local body
  body=$(printf 'Daily upstream sync: merges `pingdotgg/t3code` main (%s, %s commits) into `%s`.\n\n**Not released: %s.**\n\nLast lines of the failing step:\n\n```\n%s\n```\n\nFix it on this branch; the next sync run re-checks, merges and releases it.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n' \
    "$upstream_sha" "$behind" "$BRANCH" "$reason" "$(tail -40 "$logs/$2" 2>/dev/null)")
  if [[ -n "$pr_number" ]]; then
    gh pr comment "$pr_number" -R "$FORK" --body "$body" >/dev/null
  else
    gh pr create -R "$FORK" --base "$BRANCH" --head "$sync_branch" \
      --title "Merge upstream main (${upstream_sha:0:10}) — needs attention" --body "$body"
  fi
  exit 4
}

# The pinned Node, as CI uses, and the pinned pnpm, installed into the cache.
source scripts/fork/node.sh
node_bin=$(fork_node_bin "$cache") || fail "could not fetch the pinned Node" merge.log
export PATH="$node_bin:$wt/node_modules/.bin:$PATH"
# Checks run beside the live service; keep them polite.
renice -n 10 $$ >/dev/null
pm=$(python3 -I -c 'import json; print(json.load(open("package.json"))["packageManager"])')
pm_prefix="$cache/${pm//@/-}"
[[ -x "$pm_prefix/bin/pnpm" ]] || npm install -g --prefix "$pm_prefix" "$pm" >"$logs/install.log" 2>&1 ||
  fail "could not install $pm" install.log
export PATH="$pm_prefix/bin:$PATH"
pnpm install --frozen-lockfile >>"$logs/install.log" 2>&1 || fail "dependency install failed" install.log

# Re-measure the agent context budget when the merge changed tool text.
if ! (cd apps/server && vp test run src/provider/AgentContextBudget.test.ts) >"$logs/budget.log" 2>&1; then
  python3 -I - "$budget" "$logs/budget.log" <<'PY'
import json, re, sys
path, log = sys.argv[1], open(sys.argv[2]).read()
measured = {k: int(v) for k, v in re.findall(r'^\+\s+"(\w+)": (\d+),?$', log, re.M)}
data = json.load(open(path))
data.update({k: v for k, v in measured.items() if k in data})
open(path, "w").write(json.dumps(data, indent=2) + "\n")
PY
  (cd apps/server && vp test run src/provider/AgentContextBudget.test.ts) >"$logs/budget.log" 2>&1 ||
    fail "agent context budget test" budget.log
  git commit -q -am "chore(server): re-measure the agent context budget after the upstream merge"
fi

vp fmt --check >"$logs/fmt.log" 2>&1 || fail "format check" fmt.log
vp lint --report-unused-disable-directives >"$logs/lint.log" 2>&1 || fail "lint" lint.log
vp run typecheck >"$logs/typecheck.log" 2>&1 || fail "typecheck" typecheck.log

# Do not publish a failing candidate, even when the same test fails on the base.
(cd apps/server && vp test run --maxWorkers=50% --reporter=json --outputFile="$logs/server-tests.json") \
  >"$logs/server-tests.log" 2>&1 || fail "server tests" server-tests.log

day=$(date -u +%Y%m%d)
# Match upstream's nightly train: the checked-in stable package previews the next patch.
base_version=$(node scripts/resolve-nightly-release.ts --channel preview --date "$day" \
  --run-number 1 --sha "$(git rev-parse HEAD)" | sed -n 's/^base_version=//p')
[[ "$base_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "could not resolve the upstream nightly core" install.log
n=$(gh release list -R "$FORK" --limit 100 --json tagName --jq \
  "[.[] | select(.tagName | startswith(\"v$base_version-preview.$day.\"))] | length")
version="$base_version-preview.$day.$((n + 1))"
# The guard installs the newest release by `sort -V`; refuse a version that would not be newest.
latest=$(gh release list -R "$FORK" --limit 100 --json tagName,isDraft --jq '
  .[] | select(.isDraft | not) | .tagName
  | select(test("^v[0-9]+\\.[0-9]+\\.[0-9]+(-(preview|nightly)\\.[0-9]{8}\\.[0-9]+)?$"))' |
  sed 's/^v//' | sort -V | tail -1)
[[ "$(printf '%s\n%s\n' "$latest" "$version" | sort -V | tail -1)" == "$version" ]] ||
  fail "version $version would not sort above $latest" install.log

artifacts=$(scripts/fork/build-release.sh "$version" 2>"$logs/build.log" | tail -1) ||
  fail "release build or smoke test" build.log

# The exact check the launcher runs before switching builds, read-only, on the live database.
tmp_cli=$(mktemp -d -p "$logs")
tar -xzf "$artifacts/t3-$version-linux-x64.tar.gz" -C "$tmp_cli"
cli=$(find "$tmp_cli" -type f -name t3 -perm -u+x | head -1)
for protocol in 3 4; do
  "$cli" __service-preflight --database-path "$LIVE_DB" --launcher-protocol "$protocol" \
    >"$logs/preflight-$protocol.json" 2>&1 || true
  grep -q '"status":"ready"' "$logs/preflight-$protocol.json" ||
    fail "service preflight on the live database (launcher protocol $protocol)" "preflight-$protocol.json"
done

if [[ -n "$dry_run" ]]; then
  keep_worktree=1
  log "dry run: would prepare $sync_branch and publish $version from $artifacts (worktree kept at $wt)"
  exit 0
fi

if [[ "$release_only" == 1 ]]; then
  release_target=$(git rev-parse HEAD)
  scripts/fork/publish-release.sh "$version" "$artifacts" "$release_target" \
    "Publish the verified integration tree after an earlier publication did not finish."
  log "released previously merged integration $release_target as v$version"
  exit 0
fi

git push -q -u origin "$sync_branch"
summary=$(printf 'Daily upstream sync: merges `pingdotgg/t3code` main (%s, %s commits) into `%s`.\n\nFormat, lint, typecheck, server tests, the container release build with its smoke test, and the service preflight against the live database passed. Prepared release candidate `v%s`; publication follows a successful merge.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n' \
  "$upstream_sha" "$behind" "$BRANCH" "$version")
if [[ -n "$pr_number" ]]; then
  pr_url=$(gh pr view "$pr_number" -R "$FORK" --json url --jq .url)
  gh pr comment "$pr_number" -R "$FORK" --body "$summary" >/dev/null
else
  pr_url=$(gh pr create -R "$FORK" --base "$BRANCH" --head "$sync_branch" \
    --title "Merge upstream main (${upstream_sha:0:10})" --body "$summary")
fi
# Observe once, then let the next scheduled run resume this PR; never merge while CI is pending.
checks=$(gh pr checks "$pr_url" -R "$FORK" --json name,bucket) || {
  log "hosted checks are pending or failing for $pr_url; nothing released"
  exit 4
}
python3 -I -c 'import json,sys; c=json.load(sys.stdin); sys.exit(0 if c and all(x["bucket"] in ("pass", "skipping") for x in c) else 1)' \
  <<<"$checks" || { log "hosted checks have not all passed for $pr_url; nothing released"; exit 4; }
# The synchronous API refuses pending checks instead of silently enabling auto-merge.
merge_commit=$(gh api --method PUT "repos/$FORK/pulls/${pr_url##*/}/merge" \
  -f merge_method=merge -f sha="$(git rev-parse HEAD)" \
  --jq 'if .merged then .sha else error(.message) end') || {
  log "merge has not completed for $pr_url; nothing released"
  exit 4
}
git -C "$SOURCE" fetch -q origin
scripts/fork/publish-release.sh "$version" "$artifacts" "$merge_commit" \
  "Upstream sync: pingdotgg/t3code main ${upstream_sha:0:10} merged into $BRANCH ($pr_url)."
log "released v$version from $merge_commit"
