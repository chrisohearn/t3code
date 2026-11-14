# The ledger of record is the dot-t3code-mcp sidecar

Accepted 2026-11-14. Amends [0003](0003-ledger-and-single-slack-writer.md) and [0015](0015-server-verified-approvals.md).

## Decision

- **The work ledger lives in this repo's sidecar.** It is the `ledger` MCP server from the private dot-t3code-mcp connector, on Omarchy (`ledger_query`, `ledger_upsert`, `ledger_history`), with its own SQLite database. Agents on Omarchy reach it over stdio. Other machines use the tailnet URL with a bearer token (the connector's `docs/sidecar.md`).
- **The fork's ledger is a frozen, read-only fallback.** Nobody writes to T3's `ledger_*` tools after the cutover. The freeze is a rule in the global agent instructions, not new fork code. Reads stay open to recover pre-switch detail. The fork's server-verified `approval` objects stay readable there.
- **Jarvis reaches the ledger by asking a T3 thread.** It does not call T3's ledger tools. Agents on a machine without the `ledger` server do the same.
- **There are no verified approvals in the sidecar.** It refuses `approval` on upsert and the `approved` filter on query. `approvalNote` is free text, including a Jarvis or agent relay, and never counts as approval. A task's authority comes from its intake dialog under [0016](0016-no-human-in-the-loop.md), linked on the row by thread and item id. Money still needs Chris's own fresh go-ahead every time.
- **Writes after the cutover are reconciled.** A write that still lands on the fork ledger is replayed into the sidecar by a sweep, and its writer is told to switch.

## Alternatives

- Keep the fork ledger as the source of truth until the fork retires.
- Expose the sidecar on a public endpoint so Jarvis calls it directly.
- Port the fork's server-verified approvals before the switch.

## Why

Chris chose "Switch now" on 2026-11-14 (audit thread 7e56b504, item 7368). Moving the ledger is the main step toward retiring the fork, and it is reversible: pointing registrations and the supervisor back at the fork ledger undoes it. Chris's settled choices rule out a public endpoint or tunnel (tailnet-only Tailscale Serve is fine). Jarvis goes through a T3 thread. Ported approvals would need T3's database or a T3 change, which this repo's rules forbid. The migration is recorded on ledger row `jarvis-t3/fork-exit`.
