# Jarvis relays authority and answers individual prompts

Accepted 2026-11-12. Amended 2026-11-13 by [0016](0016-no-human-in-the-loop.md): for a task with intake answers, those answers authorize its sensitive actions, and only spending money still needs Chris's fresh go-ahead.

## Decision

Jarvis retains full access and may relay Chris's approval from any channel. Requests from T3 agents count as Chris's requests for routine work, with sensitive actions still checked with Chris. An agent request is never itself Chris's approval, and a T3 agent passes Chris's approval to Jarvis only as a [server-verified ledger approval](0015-server-verified-approvals.md). Jarvis may answer approval prompts on any T3 thread, with every answer logged. Standing always-allow grants remain in the T3 app.

## Alternatives

Require Chris to repeat approvals in T3, restrict Jarvis to least privilege, or let outside assistants create standing grants.

## Why

The chosen boundary lets work proceed across channels while retaining a record of individual answers and keeping durable grants in the app. The November 12 prompt rule extends the November 11 authority decision.
