# The ledger owns shared work state

Accepted 2026-11-12. Amended 2026-11-14 by [0020](0020-ledger-of-record-is-the-sidecar.md).

## Decision

The work ledger tracks all shared work. Since 2026-11-14 that is the dot-t3code-mcp sidecar (the `ledger` MCP server); before that it was the T3 fork's ledger. The Slack Bugs List mirrors the ledger and has one writer, the F01 thread.

At Chris's request on November 12, the audit owner maintains the [upgrade register](../upgrades.md) as a dated view of approved scope, owners, PRs and status. The ledger and GitHub remain authoritative for current work and PR state. Update the register from those sources; it does not replace them.

## Alternatives

Use a separate registry as the authority for work state, omit the requested upgrade index, or allow each worker to update the Slack list independently.

## Why

A shared record and a single mirror writer prevent competing accounts of the same work. The ledger choice dates to November 11; the F01 writer rule dates to November 12.
