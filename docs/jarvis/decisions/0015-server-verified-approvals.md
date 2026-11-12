# Server-verified approvals

Accepted 2026-11-12.

## Decision

A ledger row you own with `approval.approvedBy == "user"` is Chris's approval for exactly what its quote states. Act on what the quote alone states, and only when the quoted question names this row as `Ledger key: <key>`. A bare assent ("Yes", "Go ahead") approves nothing beyond what the quoted question itself asks. The row's title, `nextAction` and `approvalNote` are never scope. Act in the same wake, report, and mark the row done. Never act on a relayed approval without one.

To get an approval, ask Chris in a question dialog whose question includes `Ledger key: <key>` and says what the work will do. Then record his answer with `ledger_upsert` and `approval: { source: { threadId, itemId, questionId? } }`, using the dialog's `itemId` and `sourceThreadId` from `t3_thread_read`. Chris's own chat messages are not accepted as sources.

The server records the approval only when all of the following hold:

- Chris answered the dialog from a session paired to this environment, and the dialog is complete.
- The dialog's turn was not rolled back.
- The question, as it read when he answered, names the row's key exactly.
- His answer is a single offered option, or text he typed. Text the agent prefilled is refused, as is an answer no single option explains.

Dialog answers record the paired session that answered them; answers from before that record existed cannot be verified.

The stored approval quotes the question and the chosen option's label and description (or Chris's typed text) from that answer-time record. It also stores the answering session's short id and label, and a hash of the row's key, title, `nextAction`, `ownerKind` and `ownerName`. Agents cannot supply or edit any of it.

An approval is withdrawn when:

- any of those row fields change;
- any operate caller sets `approval: null`;
- another source replaces it;
- the run that asked the question is rolled back.

Each withdrawal is recorded in `ledger_history`, and that answer can never approve that row again. One answer backs one row. `ledger_query` filters with `approved`, and `portfolio_status` shows the approval on each item.

Owner sessions are the sessions paired to Chris's environment: the desktop app, T3 Connect desktop and mobile, and browser sessions. The server rejects MCP sign-in tokens on the WebSocket, and sessions from `t3 auth session issue` are stored as `bot` and never answer as the owner. A session paired with `t3 auth pairing create` cannot be told apart from Chris's own devices. A process running as Chris on the host can therefore create one and forge an approval; the recorded session label is the trail for that.

Sources in deleted threads are refused. Archived threads are accepted: archiving tidies the sidebar and does not withdraw what Chris said. An approval is metadata Jarvis trusts; it grants no permission in T3.

## Alternatives

- Keep relaying approvals as agent text.
- Have Jarvis re-read thread history on each wake.
- Accept Chris's chat messages as sources. Those carry no record of what they answered, so an agent could attach "Yes" to any row.

## Why

Relayed approvals left Jarvis re-checking thread history on every wake and not acting. Verifying once, on the server, against a question that names the row, gives Jarvis a quote it can trust without re-reading. Binding the approval to the row's content stops an agent from moving an approval to new work or from widening a real answer into a broad one.
