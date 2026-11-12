# Restart behaviour: verify, don't build

Accepted 2026-11-12.

## Decision

Keep existing recovery. Refuse manual/automatic settlement during active runs or
prepared/pending restart continuations. Settle afterwards only if eligible.
No draining or updater changes.

## Results

Update: 2026-11-12 07:36 UTC, to `0.1.10-preview.20261112.3`.
Exit zero; serving 07:37:22; Connect HTTP 200 07:37:57.

`continueThreadsAfterServerUpdate` was unset (default true). No pending approval,
secret or auth requests. Baseline: eight running, 59 queued, all with native references.

Continued once: Claude 2/2, Codex Revotech 4/4, Codex Pro 1/2.
Seven retained provider, model/options, provider thread and restart notices.
Codex used native empty input; Claude used shared prompts, one with lost-work notes.

Queued group, zero duplicates:

- 07:41:33: 5 completed + 1 running + 53 queued.
- 07:47:57: 21 completed + 2 running + 36 queued.

Later completion/order remains unverified. Cursor, Grok, OpenCode, Antigravity and
Kiro were unobserved.

Recovery prepared Codex Pro's continuation, shutdown cancelled its run, then
auto-settle settled the thread before the effect ran. Recovery correctly skipped
the settled thread ([#42](https://github.com/chrisohearn/t3code/issues/42)). Audit resumed it manually. Upgrade 30 blocks this race.

## Alternatives and why

Deferred settlement risks stale requests settling newer work; refusal is explicit.
