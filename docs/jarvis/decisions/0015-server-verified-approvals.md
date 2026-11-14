# Server-verified approvals

Accepted 2026-11-12. [0016](0016-no-human-in-the-loop.md) adds how intake answers authorize a task; this mechanism still carries every approval from T3 to Jarvis and every money go-ahead.

**Since 2026-11-14 ([0020](0020-ledger-of-record-is-the-sidecar.md)):** work state lives in the dot-t3code-mcp sidecar, which has no verified approvals. This mechanism stays in force on T3's own ledger. Recording an `approval` there, and retiring it with `approval: null`, are the only writes still allowed on it. Use the same key as the sidecar row. Retire it **before** acting and confirm the readback, then act once; this replaces "act, then mark done" below. Only the row's owner thread acts on it. Marking the sidecar row done does not retire the approval.

## Decision

A ledger row you own with `approval.approvedBy == "user"` is Chris's approval, used once, for exactly what its quote states.

- Act only on an action the quoted question itself spells out, with its object and amount, and that the quoted answer accepts.
- The quoted question must name this row on a line of its own: `Ledger key: <key>`.
- References such as "the linked PR", "the next action", "as above" or "this row" approve nothing.
- The row's title, `nextAction` and `approvalNote` are never scope.
- If the question and the row disagree, do nothing and ask Chris.

Act in the same wake, report, and mark the row done. Marking it done or cancelled retires the approval. Never act on a relayed approval without one.

### Getting an approval

Ask Chris in a question dialog. The question must say the action, its object and amount in plain text (write amounts as `5000 USD`), with `Ledger key: <key>` alone on its own line. Keep it to 12 lines and 600 characters. The question and the option labels and descriptions may not contain `[`, `]`, `\`, `<`, `&` or `$`, tabs, or invisible, blank-rendering or control characters; the server refuses them rather than parse markdown that could hide text. Chris's typed answers only need to be visible.

Then record his answer with `ledger_upsert` and `approval: { source: { threadId, itemId, questionId? } }`, using the dialog's `itemId` and `sourceThreadId` from `t3_thread_read`. Chris's chat messages are not sources.

### What the server checks

The server records the approval only when:

- Chris answered the dialog from a session paired to this environment, within the last 24 hours;
- the dialog is complete, and its turn was not rolled back;
- the question, as it read when he answered, names exactly this row's key on its own line and passes the checks above;
- his answer is a single offered option, or text he typed. Prefilled, blank and unmatched answers are refused.

The stored approval quotes the question and the chosen option's label and description (or Chris's typed text) from that answer-time record. It also stores the answering session's short id and label, and a hash of the row's key, title, `nextAction`, owner, owner thread, blocker, links and `approvalNote`. Agents cannot supply or edit any of it.

### Withdrawal

An approval is withdrawn when:

- any of those row fields change;
- the row is marked done or cancelled;
- any operate caller sets `approval: null`;
- another answer replaces it;
- the run that asked the question is rolled back;
- the thread that holds the answer is deleted.

Each withdrawal is recorded in `ledger_history`, and that answer can never approve anything again. One answer backs one row. `ledger_query` filters with `approved`, and `portfolio_status` shows the approval on each item.

### Limits

These checks stop callers that only have MCP access: outside sign-ins, linked environments, and agents limited to T3's tools. They do not stop a full-access agent on the host, because such an agent runs as Chris. It can:

- write a forged answer or approval straight into the database;
- create a pairing session with `t3 auth pairing create` and answer as Chris's device.

The recorded session label is chosen by the client; only the short session id identifies a session. Sessions from `t3 auth session issue` are stored as `bot` and never answer as the owner. Device-signed answers that Jarvis verifies off the host are the planned remedy.

An approval is metadata Jarvis trusts; it grants no permission in T3.

## Alternatives

- Keep relaying approvals as agent text.
- Have Jarvis re-read thread history on each wake.
- Accept Chris's chat messages as sources. Those carry no record of what they answered, so an agent could attach "Yes" to any row.

## Why

Relayed approvals left Jarvis re-checking thread history on every wake and not acting. Verifying once, on the server, against a question that names the row and shows its whole text, gives Jarvis a quote it can trust without re-reading. Binding the approval to the row and using it once stops an agent from moving it to new work, widening it, or replaying it.
