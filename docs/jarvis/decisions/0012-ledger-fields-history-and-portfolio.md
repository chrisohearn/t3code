# Ledger fields, history and portfolio

Accepted 2026-11-12.

## Decision

The ledger separates a work item's status from its reason for waiting. External waits depend on a vendor or another party. Natural waits depend on a real event. Decision waits need Chris's answer. Existing blocker prefixes become wait reasons during migration. A due check means the recorded next check time has arrived. It does not start work.

Every material upsert retains its caller, time, and changed values. An unchanged upsert writes neither a row nor history and preserves its last editor and timestamp. History retains the server-recorded sender record from [0013](0013-server-recorded-message-senders.md) for new MCP edits; old entries remain unattributed. A run started with a client request id equal to a work item's key records its terminal outcome on that item without changing the item's status. Finishing a run does not prove that the work is done.

Omitted fields stay unchanged; explicit null clears nullable fields. `links` still replaces the list, while `addLinks` and `removeLinks` apply normalized set changes; removals win. Removing a URL also matches its Markdown link form. The resulting list cannot exceed 100 links. `handoffArgs` retains exact tool-call arguments as JSON bounded to 4096 UTF-8 bytes, not instructions or approval; never store secrets there. Changing it withdraws an existing approval. A blocked row without a wait reason defaults to decision and warns. When an upsert touches status, wait reason or blocker, contradictory `BLOCKED_TECH` or `WAIT_DECISION` prefixes with external/natural reasons warn without refusing the update.

An owner thread belongs to the ledger's environment. JSON null clears it; ID inputs refuse the literal string "null", ignoring surrounding whitespace and case. Older rows with that string remain readable so an explicit null can repair them. Jarvis-owned work need not have an owner thread; the Jarvis inbox is not its worker. References to other environments retain their scope as links.

The portfolio joins open work with each owner thread's latest run, pending requests, and a short result excerpt. A worker with no run for over 24 hours is flagged for attention. It also counts open-to-blocked and blocked-to-open transitions in the last 24 hours, flagging more than three as flapping, including work without an owner thread. Neither flag establishes failure or authorizes a restart. The web panel reads the same ledger and provides no editing controls.

## Alternatives

Keep wait prefixes in free text, infer completion from a successful run, or make the portfolio a second source of work state.

## Why

Structured waits keep vendor delays and real-world events out of Chris's decision queue. History makes coordination changes traceable. Run metadata and the portfolio show activity while leaving business completion with the work item's owner.
