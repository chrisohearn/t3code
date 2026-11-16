# Continuing a coordinator

Use rollover when a long-running coordinator's provider context is crowded or stale and its remaining work is recorded in the ledger. The ledger of record is the `ledger` server, the sidecar ([0020](decisions/0020-ledger-of-record-is-the-sidecar.md)).

1. Update the coordinator's rows in the sidecar, and its latest result, first.
2. Call `t3_thread_send` with its `threadId`, `coordinatorRollover: true`, `mode: "queue"`, and a short continuation request in `message`. Rollover cannot steer or restart a running turn; queue it at a clean boundary.
3. After the rollover, and before acting, the coordinator re-reads its own rows from the sidecar: it pages `ledger_query` for each of `open`, `blocked` and `waiting_on_human` (limit 100) until `nextCursor` is null, and keeps the rows whose `ownerThreadId` is its thread. It also re-reads, through T3's `ledger_query`, any row that carries an approval, because that work stays whole on T3's ledger (0020). Those two reads are its work list.

The thread keeps its history and identity. Its next turn uses a fresh provider session, seeded with up to 25 unfinished rows that the thread owns and up to 4,000 encoded bytes of its latest assistant result, within an 8 KiB total seed budget. T3 builds that seed from its own ledger, which has been frozen for work state since the switch, so the seeded rows are a pre-switch view. Only rows that carry an approval are current there. Treat the seed as a pointer, not as the work list, and set it aside once step 3 is done. It carries no new approval. `portfolio_status` reads the same frozen ledger, so it is a pre-switch view too; read an owner thread's run state with `t3_thread_read` instead. Neither view is being ported: both go when the fork retires.

Ordinary `freshContext: true` sends clear the provider context without adding a seed; normal sends keep their existing context.

Fetch the MCP resource `t3://jarvis/playbook` when starting or rolling over a coordinator. It serves the vocabulary and decisions in `docs/jarvis` from the running T3 build. `orchestrator_capabilities` returns its URI. A newly merged decision becomes available after that build is released and installed.

The playbook resource belongs to the MCP connection’s environment. Forwarded capabilities omit its URI because resource reads cannot route to a peer.

A linked environment must run a build with coordinator rollover support to seed its owned ledger work. Older peers still receive a fresh-context reset, but cannot add the seed; upgrade the peer before relying on rollover there.
