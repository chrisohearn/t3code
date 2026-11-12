# Visibility and fleet

Accepted 2026-11-12.

## Decision

Jarvis reaches the Mac and Windows VM through Omarchy's existing T3 peer links, using `environmentId` forwarding through its one connector. Keep the current pairing and access boundaries. Read-only forwarding from an outside sign-in was verified against both linked machines on November 12; no new pairing or grant was needed.

MCP visibility records caller/session identity, tool, start time, duration, encoded argument/result byte counts and an error class. Retain up to 14 days and 100,000 calls, without request or response bodies. Outside sign-ins see usage for their own sign-in. Different accounts can share a client ID, so it cannot establish a private boundary across sign-ins.

With `t3_thread_send` and `coordinatorRollover: true`, coordinators can roll into fresh provider sessions in the same thread, carrying a short seed from their owned unfinished ledger work and latest result. Use this when context is crowded or stale, after updating the ledger. The seed is context, not approval. Plain `freshContext: true` retains its clean-reset behavior and adds no seed. Serve the playbook from the running build through `t3://jarvis/playbook` so outside assistants can refresh their rules.

## Forwarding verification

The visibility worker used the outside-sign-in `t3_omarchy` connector on
2026-11-12. The retained thread activity records these UTC start and completion
times:

| Call                                                                                                    | Started (UTC) | Completed (UTC) | Result                                                                                   |
| ------------------------------------------------------------------------------------------------------- | ------------- | --------------- | ---------------------------------------------------------------------------------------- |
| `t3_environment_links({})`                                                                              | 06:11:20.719  | 06:11:20.883    | Mac and Windows peers both reachable.                                                    |
| `t3_thread_list({"environmentId":"f1df40cc-9f3d-4c89-a1bd-590cb5335979","allProjects":true,"limit":1})` | 06:11:29.939  | 06:11:30.020    | Mac returned one remote thread.                                                          |
| `t3_thread_list({"environmentId":"4139168b-9272-4491-a953-aac872235af8","allProjects":true,"limit":1})` | 06:11:30.021  | 06:11:30.263    | Windows returned one remote thread.                                                      |
| `bridge_status({})`                                                                                     | 06:11:40.185  | 06:11:40.201    | Outside sign-in had 29.575 days remaining; both forwarded calls recorded without errors. |

Both thread-list responses had `currentThreadId: null`. The connector was an
outside sign-in, rather than the worker's provider-thread credentials. The Mac
peer was labelled “Chris’s MacBook Pro” and Windows “REVO-VM-008”. No pairing,
grant or credential changed. This proves read-only forwarding through the
existing Omarchy connector to both peers.

## Alternatives

Separate machine connectors, unrestricted client-wide usage, or copies of the playbook maintained in outside assistants.

## Why

One entry point keeps fleet access on the existing peer-link path. Metadata makes cost and failures visible without retaining sensitive payloads. Sign-in isolation preserves the shared-client boundary, and bounded rollover seeds retain current ownership without replaying an entire conversation.
