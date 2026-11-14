# Continuing a coordinator

Use rollover when a long-running coordinator's provider context is crowded or stale and its remaining work is recorded in the ledger. Update its ledger rows and latest result first, then call `t3_thread_send` with its `threadId`, `coordinatorRollover: true`, `mode: "queue"`, and a short continuation request in `message`.

The thread keeps its history and identity. Its next turn uses a fresh provider session, seeded with up to 25 unfinished ledger rows whose `ownerThreadId` matches that thread and up to 4,000 encoded bytes of its latest assistant result, within an 8 KiB total seed budget. The seed includes titles, blockers and next actions; it carries no new approval. Re-read the ledger to recover longer fields or additional rows. Ordinary `freshContext: true` sends clear the provider context without adding a seed; normal sends keep their existing context. Rollover cannot steer or restart a running turn; queue it at a clean boundary.

**Since 2026-11-14 ([0020](decisions/0020-ledger-of-record-is-the-sidecar.md)) the seed is stale.** It still comes from T3's frozen ledger, while the ledger of record is the `ledger` server (the sidecar). Before a rollover, update the rows in the sidecar. After it, the coordinator re-reads its own rows from the sidecar before acting: page `ledger_query` for each unfinished status until `nextCursor` is null, and filter by `ownerThreadId`. Only then does it set the seeded rows aside.

Fetch the MCP resource `t3://jarvis/playbook` when starting or rolling over a coordinator. It serves the vocabulary and decisions in `docs/jarvis` from the running T3 build. `orchestrator_capabilities` returns its URI. A newly merged decision becomes available after that build is released and installed.

The playbook resource belongs to the MCP connection’s environment. Forwarded capabilities omit its URI because resource reads cannot route to a peer.

A linked environment must run a build with coordinator rollover support to seed its owned ledger work. Older peers still receive a fresh-context reset, but cannot add the seed; upgrade the peer before relying on rollover there.
