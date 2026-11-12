# Continuing a coordinator

Use rollover when a long-running coordinator's provider context is crowded or stale and its remaining work is recorded in the ledger. Update its ledger rows and latest result first, then call `t3_thread_send` with its `threadId`, `coordinatorRollover: true`, `mode: "queue"`, and a short continuation request in `message`.

The thread keeps its history and identity. Its next turn uses a fresh provider session, seeded with up to 25 unfinished ledger rows whose `ownerThreadId` matches that thread and up to 4,000 characters of its latest assistant result. The seed includes titles, blockers and next actions; it carries no new approval. Re-read the ledger to recover longer fields or additional rows. Ordinary `freshContext: true` sends clear the provider context without adding a seed; normal sends keep their existing context. Rollover cannot steer or restart a running turn; queue it at a clean boundary.

Fetch the MCP resource `t3://jarvis/playbook` when starting or rolling over a coordinator. It serves the vocabulary and decisions in `docs/jarvis` from the running T3 build. `orchestrator_capabilities` returns its URI. A newly merged decision becomes available after that build is released and installed.
