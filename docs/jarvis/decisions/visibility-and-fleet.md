# Visibility and fleet

Accepted 2026-11-12.

## Decision

Jarvis reaches the Mac and Windows VM through Omarchy's existing T3 peer links, using `environmentId` forwarding through its one connector. Keep the current pairing and access boundaries. Read-only forwarding from an outside sign-in was verified against both linked machines on November 12; no new pairing or grant was needed.

MCP visibility records caller/session identity, tool, start time, duration, encoded argument/result byte counts and an error class. Retain up to 14 days and 100,000 calls, without request or response bodies. Outside sign-ins see usage for their own sign-in. Different accounts can share a client ID, so it cannot establish a private boundary across sign-ins.

With `t3_thread_send` and `coordinatorRollover: true`, coordinators can roll into fresh provider sessions in the same thread, carrying a short seed from their owned unfinished ledger work and latest result. Use this when context is crowded or stale, after updating the ledger. The seed is context, not approval. Plain `freshContext: true` retains its clean-reset behavior and adds no seed. Serve the playbook from the running build through `t3://jarvis/playbook` so outside assistants can refresh their rules.

## Forwarding verification

Read-only calls from an outside sign-in reached both linked environments on November 12, 2026. No forwarding fix or access change was required. The [retained verification transcript](https://github.com/chrisohearn/t3code/pull/30#issuecomment-6817608194) records the exact calls, UTC start and completion times, and results for the audit. Deployment identifiers are evidence for that installation, not reusable targets; discover current targets with `t3_environment_links`.

## Alternatives

Separate machine connectors, unrestricted client-wide usage, or copies of the playbook maintained in outside assistants.

## Why

One entry point keeps fleet access on the existing peer-link path. Metadata makes cost and failures visible without retaining sensitive payloads. Sign-in isolation preserves the shared-client boundary, and bounded rollover seeds retain current ownership without replaying an entire conversation.
