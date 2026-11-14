# The ledger of record is the dot-t3code-mcp sidecar

Accepted 2026-11-14. Amends [0003](0003-ledger-and-single-slack-writer.md), [0012](0012-ledger-fields-history-and-portfolio.md) and the rollover playbook (`../COORDINATORS.md`). [0004](0004-approval-authority.md), [0015](0015-server-verified-approvals.md) and [0016](0016-no-human-in-the-loop.md) stay in force, with approvals carried on the fork ledger as below.

## Decision

- **The work ledger lives in this repo's sidecar.** It is the `ledger` MCP server from the private dot-t3code-mcp connector, on Omarchy (`ledger_query`, `ledger_upsert`, `ledger_history`), with its own SQLite database. Agents on Omarchy reach it over stdio. Other machines use the tailnet URL with a bearer token (the connector's `docs/sidecar.md`).
- **The fork's ledger is frozen for work state.** After the cutover, status, blockers, next actions, owners and links are written only to the sidecar. The freeze is a rule in the global agent instructions, not new fork code. Reads stay open to recover pre-switch detail.
- **Server-verified approvals stay on the fork ledger until a replacement is decided.** The sidecar has no verified approvals, so [0015](0015-server-verified-approvals.md) keeps working where it is. This is the one write still allowed on T3's ledger: `ledger_upsert` with `approval: { source: … }` (plus `title`, `ownerKind` and `ownerName` if the row is new there). It carries money go-aheads under [0016](0016-no-human-in-the-loop.md), and grants passed from T3 to Jarvis under [0004](0004-approval-authority.md). Use the same key as the sidecar row. Jarvis checks the approval on T3's ledger (`ledger_query` with `approved: true`, or the row's `approval` object), and the work itself is tracked in the sidecar. A replacement, such as a verifier that quotes the dialog through stock `t3_thread_read`, needs Chris's decision first. The only one in use at the switch was on `work/native-computer-use`.
- **Jarvis reaches the ledger by asking a T3 thread.** It does not call T3's ledger tools. Agents on a machine without the `ledger` server do the same.
- **There are no verified approvals in the sidecar.** It refuses `approval` on upsert and the `approved` filter on query. `approvalNote` is free text, including a Jarvis or agent relay, and never counts as approval. A task's authority comes from its intake dialog under [0016](0016-no-human-in-the-loop.md), linked on the row by thread and item id. Money still needs Chris's own fresh go-ahead every time, as a server-verified approval on T3's ledger (above).
- **Fork-only views are retired for sidecar rows.** T3 fills `lastRunId`, `lastRunStatus` and `lastRunAt` only on its own ledger, so they stay `null` in the sidecar. `portfolio_status` reads only T3's ledger, so it shows pre-switch state. Read an owner thread's run state with `t3_thread_read` instead. The completion supervisor already does.
- **Coordinator rollover seeds are stale.** `coordinatorRollover: true` still seeds the fresh session from T3's frozen ledger. After any rollover, the coordinator discards the seeded rows and re-reads its rows from the sidecar (`ledger_query`, then filter by its `ownerThreadId`) before acting. Fixing the seed itself is tracked in the private connector repo.
- **Writes after the cutover are reconciled.** A write that still lands on the fork ledger is replayed into the sidecar by a sweep, and its writer is told to switch.

## Alternatives

- Keep the fork ledger as the source of truth until the fork retires.
- Expose the sidecar on a public endpoint so Jarvis calls it directly.
- Port the fork's server-verified approvals before the switch, or drop them.

## Why

Chris chose "Switch now" on 2026-11-14 (audit thread 7e56b504, item 7368). Moving the ledger is the main step toward retiring the fork, and it is reversible: pointing registrations and the supervisor back at the fork ledger undoes it. Chris's settled choices rule out a public endpoint or tunnel (tailnet-only Tailscale Serve is fine). Jarvis goes through a T3 thread. Ported approvals would need T3's database or a T3 change, which this repo's rules forbid. Keeping them on T3's ledger keeps today's security control unchanged until Chris picks a replacement. The migration is recorded on ledger row `jarvis-t3/fork-exit`.
