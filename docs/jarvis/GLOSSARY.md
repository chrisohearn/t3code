# Jarvis and T3

Terms for the work Chris shares between Jarvis, Vision, and T3.

## Language

**Jarvis**:
Chris's ChatGPT chief of staff and the coordinator of work shared with T3.

**Vision**:
A worker directed by Jarvis through Slack.

**dot**:
A named ChatGPT assistant, such as Jarvis or Vision.

**T3 Omarchy plugin**:
The connection through which an outside assistant works with T3 on Omarchy.

**work ledger**:
The shared record of work, its owners, progress, blockers, and next actions. Since 2026-11-14 it is kept in the dot-t3code-mcp sidecar (the `ledger` MCP server). T3's own ledger is frozen for work state, except work that needs a server-verified approval, which stays whole there ([0020](decisions/0020-ledger-of-record-is-the-sidecar.md)).

**work item**:
One outcome tracked in the work ledger under a stable key.

**inbox**:
The T3 thread where agents leave requests for Jarvis.

**acknowledge-only mode**:
A thread setting under which T3 answers each message with a fixed acknowledgement instead of running an agent. The run still ends normally, so its result still wakes Jarvis.

**event subscription**:
An arrangement to receive notice when a selected kind of change happens in T3.

**notify**:
A request to relay a source run's events as messages to the caller's pinned inbox.

**coordinator thread**:
A conversation that directs work across worker threads and follows their outcomes.

**worker thread**:
A T3 conversation responsible for a bounded piece of work and its verified result.

**fork release**:
A published build of Chris's personal T3 fork that includes his changes and upstream updates.

**guarded update**:
A service update that checks the fork release, waits for a suitable time, and restores a healthy build if the new build fails.

**intake grill**:
The one set of questions an agent asks Chris before a task starts. His answers authorize the sensitive actions they spell out, except spending money, which always needs his fresh go-ahead.

**completion supervisor**:
The scheduled task that re-drives idle ledger work every 30 minutes and posts a digest to Jarvis's inbox.

**frozen thread**:
A thread an operator has stopped and held: its run is interrupted, its queue and delegates are held, and it starts nothing until it is unfrozen or its owner acts.

**shared, unattributable**:
A sign-in whose calls arrive on overlapping MCP sessions, so several agents are acting through it at once and its calls cannot be tied to one.
