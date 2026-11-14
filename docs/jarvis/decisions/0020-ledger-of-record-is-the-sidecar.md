# The ledger of record is the dot-t3code-mcp sidecar

Accepted 2026-11-14. Amends [0003](0003-ledger-and-single-slack-writer.md), [0012](0012-ledger-fields-history-and-portfolio.md) and the rollover playbook (`../COORDINATORS.md`). [0004](0004-approval-authority.md), [0015](0015-server-verified-approvals.md) and [0016](0016-no-human-in-the-loop.md) stay in force, with approvals carried on the fork ledger as below.

## Decision

- **The work ledger lives in this repo's sidecar.** It is the `ledger` MCP server from the private dot-t3code-mcp connector, on Omarchy (`ledger_query`, `ledger_upsert`, `ledger_history`), with its own SQLite database. Agents on Omarchy reach it over stdio. Other machines use the tailnet URL with a bearer token (the connector's `docs/sidecar.md`).
- **The fork's ledger is frozen for work state**, with one exception (next bullet). After the cutover, status, blockers, next actions, owners and links are written only to the sidecar. The freeze is a rule in the global agent instructions, not new fork code. Reads stay open to recover pre-switch detail.
- **Work that needs a server-verified approval stays whole on T3's ledger for now.** That means a money go-ahead under [0016](0016-no-human-in-the-loop.md), or a grant passed from T3 to Jarvis under [0004](0004-approval-authority.md). Such an item is not migrated: its work state and its approval live together on one T3 row, so [0015](0015-server-verified-approvals.md) applies exactly as written. T3 withdraws the approval itself when the row changes, finishes or is revoked, and an answer is used once. If a sidecar row exists for the same key, its nextAction points at the T3 row and its work state is not edited in both places. These rows are exempt from the freeze and from the reconciliation sweep. Any sidecar-native replacement needs Chris's decision first (tracked in the private connector repo).
- **Jarvis reaches the ledger by asking a T3 thread.** It does not call T3's ledger tools. Agents on a machine without the `ledger` server do the same.
- **There are no verified approvals in the sidecar.** It refuses `approval` on upsert and the `approved` filter on query. `approvalNote` is free text, including a Jarvis or agent relay, and never counts as approval. A task's authority comes from its intake dialog under [0016](0016-no-human-in-the-loop.md), linked on the row by thread and item id. Money still needs Chris's own fresh go-ahead every time, through the T3-ledger exception above.
- **Fork-only views are retired for sidecar rows.** T3 fills `lastRunId`, `lastRunStatus` and `lastRunAt` only on its own ledger, so they stay `null` in the sidecar. `portfolio_status` reads only T3's ledger, so it shows pre-switch state. Read an owner thread's run state with `t3_thread_read` instead. The completion supervisor already does.
- **Coordinator rollover seeds are stale.** `coordinatorRollover: true` still seeds the fresh session from T3's frozen ledger. After any rollover, the coordinator re-reads its rows from the sidecar before acting. `ledger_query` has no `ownerThreadId` filter, so it pages each of `open`, `blocked` and `waiting_on_human` (limit 100) until `nextCursor` is null, then filters by its `ownerThreadId`. It also re-reads, through T3's `ledger_query`, any seeded row that carries an approval (those stay on T3's ledger). Only after both reads does it set the seeded rows aside. Fixing the seed itself is tracked in the private connector repo.
- **Writes after the cutover are reconciled.** A work-state write that still lands on T3's ledger is replayed into the sidecar by a sweep, and its writer is told to switch. Rows that carry or once carried a server-verified approval are skipped, because they are the exception above.

## Alternatives

- Keep the fork ledger as the source of truth until the fork retires.
- Expose the sidecar on a public endpoint so Jarvis calls it directly.
- Port the fork's server-verified approvals before the switch, or drop them.

## Why

Chris chose "Switch now" on 2026-11-14 (audit thread 7e56b504, item 7368). Moving the ledger is the main step toward retiring the fork, and it is reversible: copy sidecar changes made since the cutover back to T3's ledger, then point registrations and the supervisor back at it (`docs/sidecar.md`, "Rollback"). Chris's settled choices rule out a public endpoint or tunnel (tailnet-only Tailscale Serve is fine). Jarvis goes through a T3 thread. Ported approvals would need T3's database or a T3 change, which this repo's rules forbid. Keeping approval-bearing work whole on T3's ledger keeps today's control unchanged, with no new rules, until Chris picks a replacement. The migration is recorded on ledger row `jarvis-t3/fork-exit`.
