# Restart behaviour: verify, don't build

Accepted 2026-11-12.

## Decision

Verify existing recovery during audit-owned updates. Add no draining or updater code.

## Results

First update: 2026-11-12 07:36 UTC, to `0.1.10-preview.20261112.3`.
Exit zero; serving 07:37:22; Connect HTTP 200 07:37:57; migrations 5/6 applied 07:36:23.

`continueThreadsAfterServerUpdate` was unset; default is true. No pending approval,
secret or auth requests. Baseline: eight running, 59 queued; all had native references.

| Provider       | Running | Continued once |
| -------------- | ------- | -------------- |
| Claude         | 2       | 2              |
| Codex Revotech | 4       | 4              |
| Codex Pro      | 2       | 1              |

All seven retained provider instance, model/options and provider thread, with a
visible restart notice. Code path: native empty input for five Codex continuations;
shared prompts for both Claude, one including cancelled-background-work notes.

No duplicates. At 07:47:57, queued-origin runs: 21 completed, two running, 36 queued.
Cursor, Grok, OpenCode, Antigravity and Kiro were unobserved.

Codex Pro's thread auto-settled after run 457's shutdown cancellation, before its
prepared continuation completed. Audit resumed run 458. Gap:
`r2/restart-gap/codex-pro-run-not-resumed`, [#42](https://github.com/chrisohearn/t3code/issues/42).
Verification complete; repair open.

## Alternatives and why

Build new recovery instead. Observation avoids untested changes.
