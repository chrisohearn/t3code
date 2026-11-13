#!/usr/bin/env bash
# Regenerates .github/workflows/fork-integration-ci.yml: upstream's ci.yml (every job unchanged) triggered by
# pushes to the fork's integration branch instead of main. ci.yml stays untouched, so upstream merges stay cheap.
#
#   scripts/fork/sync-integration-ci.sh           rewrite the generated workflow
#   scripts/fork/sync-integration-ci.sh --check   exit 1 if it is out of date with ci.yml
#
# Run it after an upstream merge that changes ci.yml. The workflow runs --check itself and warns on drift.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
src=.github/workflows/ci.yml
out=.github/workflows/fork-integration-ci.yml
branch=integration/mcp-events-20261109

generate() {
  cat <<HEADER
# Generated from ci.yml by scripts/fork/sync-integration-ci.sh. Do not edit by hand.
# Post-merge CI: ci.yml only runs on pushes to main, which this fork never pushes to.
name: Fork integration CI

on:
  push:
    branches:
      - $branch

permissions:
  contents: read

concurrency:
  group: fork-integration-ci-\${{ github.sha }}
  cancel-in-progress: false

HEADER
  echo "jobs:"
  cat <<'DRIFT'
  # Informational: never fails the run and is not in `Check`'s needs.
  generated_workflow_current:
    name: Generated workflow is current
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    steps:
      - name: Checkout
        uses: actions/checkout@v6
        with:
          sparse-checkout: |
            /.github/workflows
            /scripts/fork
          sparse-checkout-cone-mode: false

      - name: Compare with ci.yml
        run: scripts/fork/sync-integration-ci.sh --check || echo "::warning::fork-integration-ci.yml is stale against ci.yml. Run scripts/fork/sync-integration-ci.sh."

DRIFT
  sed -n '/^jobs:$/,$p' "$src" | tail -n +2
}

if [[ "${1:-}" == "--check" ]]; then
  generate | diff -u "$out" - >&2 || { echo "$out is out of date: run scripts/fork/sync-integration-ci.sh" >&2; exit 1; }
else
  generate >"$out"
fi
