# Ledger fields, history and portfolio

Accepted 2026-11-12.

## Decision

The ledger separates a work item's status from its reason for waiting. External waits depend on a vendor or another party. Natural waits depend on a real event. Decision waits need Chris's answer. Existing blocker prefixes become wait reasons during migration. A due check means the recorded next check time has arrived. It does not start work.

Every upsert retains its caller, time, and changed values. A run started with a client request id equal to a work item's key records its terminal outcome on that item without changing the item's status. Finishing a run does not prove that the work is done.

An owner thread belongs to the ledger's environment. References to other environments retain their scope as links.

The portfolio joins open work with each owner thread's latest run, pending requests, and a short result excerpt. A worker with no run for over 24 hours is flagged for attention. That flag does not establish failure or authorize a restart. The web panel reads the same ledger and provides no editing controls.

## Alternatives

Keep wait prefixes in free text, infer completion from a successful run, or make the portfolio a second source of work state.

## Why

Structured waits keep vendor delays and real-world events out of Chris's decision queue. History makes coordination changes traceable. Run metadata and the portfolio show activity while leaving business completion with the work item's owner.
