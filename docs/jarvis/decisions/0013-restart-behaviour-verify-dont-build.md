# Restart behaviour: verify, don't build

Accepted 2026-11-12.

## Decision

Verify existing recovery. Refuse manual and automatic settlement while a run or
restart continuation is active; retry after completion. Add no draining or updater code.

## Results

Update: 2026-11-12 07:36 UTC, to `0.1.10-preview.20261112.3`.
Exit zero; serving 07:37:22; Connect HTTP 200 07:37:57.

`continueThreadsAfterServerUpdate` was unset (default true). No pending approval,
secret or auth requests. Baseline: eight running, 59 queued, all with native references.

| Provider       | Running | Continued once |
| -------------- | ------- | -------------- |
| Claude         | 2       | 2              |
| Codex Revotech | 4       | 4              |
| Codex Pro      | 2       | 1              |

Seven retained provider, model/options, provider thread and restart notices.
Code path: Codex native empty input; Claude shared prompts, one with lost-work notes.

By 07:47:57, no duplicates; queued-origin runs: 21 completed, two running, 36 queued.
Later completion/order remains unverified. Cursor, Grok, OpenCode, Antigravity and
Kiro were unobserved.

Shutdown cancellation made Codex Pro's thread look idle; auto-settle blocked its
prepared continuation ([#42](https://github.com/chrisohearn/t3code/issues/42)). Audit resumed it manually. Upgrade 30 protects pending
restart work at settlement admission.

## Alternatives and why

Defer settlement until completion. Refusal prevents stale requests settling newer work.
