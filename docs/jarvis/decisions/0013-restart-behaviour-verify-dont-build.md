# Restart behaviour: verify, don't build

Accepted 2026-11-12.

## Decision

Verify existing recovery during the audit-owned update. Add no draining or updater
code. Observe active providers; leave inactive providers unverified.

## Results

Forced update: 2026-11-12 07:36:00 UTC, to
`0.1.10-preview.20261112.3`. Updater exited zero; serving at 07:37:22;
T3 Connect HTTP 200 at 07:37:57. Fork migrations 5/6 applied at 07:36:23.

Baseline: eight running runs and 59 queued messages, all with native references.

| Provider       | Running | Continued exactly once |
| -------------- | ------- | ---------------------- |
| Claude         | 2       | 2                      |
| Codex Revotech | 4       | 4                      |
| Codex Pro      | 2       | 1                      |

No duplicate continuations. At 07:47:57, original queued messages were
21 completed, two running and 36 queued; none ran twice. Cursor, Grok, OpenCode,
Antigravity and Kiro were unobserved.

Codex Pro run 457 had a continuation prepared before shutdown cancellation.
Automatic settlement at 07:36:24 preceded effect completion at 07:36:25;
settlement blocks continuation. Audit manually resumed run 458. Track the open
race under `r2/restart-gap/codex-pro-run-not-resumed` and [#42](https://github.com/chrisohearn/t3code/issues/42).
Verification is complete; repair remains open.

## Alternatives and why

Building new recovery or assuming adapter parity would hide gaps.
Evidence: audit snapshots and durable event/outbox history.
