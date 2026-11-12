# Server-verified approvals

Accepted 2026-11-12.

## Decision

A ledger row you own with `approval.approvedBy == "user"` is Chris's approval for exactly the quoted answer. Act in the same wake, report, and mark it done. Never act on a relayed approval without one.

An agent records an approval with `ledger_upsert` and `approval: { source: { threadId, itemId, questionId? } }`. The source is the item that holds Chris's answer, using the `itemId` and `sourceThreadId` that `t3_thread_read` returns. The server accepts only two kinds of source:

- A message Chris typed in a T3 web, desktop or mobile client. Messages from MCP sign-ins, agents, guests, scheduled tasks and server stand-ins are refused. A queued message an agent or MCP client rewrote counts as theirs.
- His answer to a question dialog in one of those clients. The server records who answered each dialog: an owner client, an outside MCP sign-in or an agent. Only owner-client answers qualify. Answers given before the server recorded this cannot be verified, so ask Chris again. A dialog with several questions needs `questionId`.

The server stores who recorded the approval, when it verified it, and quotes taken from the source item: the message text, or the question and the chosen option's label and description (a typed answer is quoted as written). Agents cannot supply or edit the quotes or `approvedBy`. The approval's scope is the quote, not the row's title or `approvalNote`; `approvalNote` stays free agent text and grants nothing. If the quote does not cover the row's action, the row is not approved for it.

Any operate caller can revoke with `approval: null`. Revocation is recorded in `ledger_history` and nothing re-verifies it later; a new approval needs a new source. Other writes to the row leave the approval as it was. `ledger_query` filters with `approved`, and `portfolio_status` shows the approval on each item.

Owner clients are the sessions paired to Chris's WebSocket: the server rejects MCP sign-in tokens there (`rejectMcpClientAudience` in `EnvironmentAuth`), and guests post through their own routes. The WebSocket dispatch stamps the answer as the owner's; MCP tools stamp it as an agent's or outside client's.

Sources in deleted threads are refused, because their items are no longer inspectable. Archived threads are accepted: archiving tidies the sidebar and does not withdraw what Chris said. An approval is metadata Jarvis trusts; it grants no permission in T3.

## Alternatives

Keep relaying approvals as agent text, have Jarvis re-read thread history on each wake, or let agents mark rows approved.

## Why

Relayed approvals left Jarvis re-checking thread history on every wake and not acting. Verifying authorship once, on the server, and storing the exact quote gives Jarvis a check it can trust without re-reading, and stops an agent from widening a real but unrelated answer into a broad approval.
