# Restart behaviour: verify, don't build

Accepted 2026-11-12.

## Decision

Verify existing `RestartContinuation` during the audit-owned first forced update
after round-two PRs 23, 24 and 25 are released. Add no drain or updater code.
The guarded-update proposal remains deferred.

## Verification plan

Before the update, record the serving version, continuation setting, and each
active thread's run, provider instance/model, provider turn, pending interactions,
and queued run/message ids in order.

Expected paths: Codex continues its native thread without another prompt;
Claude, Cursor, Grok, OpenCode, Antigravity and Kiro receive the shared continuation
through their adapter. For every provider active at the update, check that an
eligible interrupted run continues once on the same provider/model and queued
messages execute once in order. Inactive providers remain unobserved.

Afterward, record the new serving version, source-to-continuation run links,
resumed and missing runs, duplicates, and intentional eligibility exclusions.
Check interrupted state-changing actions before repeating them. Record actual
gaps under `r2/restart-gap/*`; keep this item open until results arrive.

## Alternatives

Build new draining and resumption machinery, or assume shared orchestration proves
every adapter works.

## Why

Existing recovery already handles restarts. One coordinated observation establishes
which provider paths need repairs without adding an unverified deployment contract.
