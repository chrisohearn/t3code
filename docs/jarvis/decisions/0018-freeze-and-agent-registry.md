# Freeze a thread and list the agents

Accepted 2026-11-13. Builds on [0013](0013-server-recorded-message-senders.md), [0015](0015-server-verified-approvals.md) and the MCP visibility record in [visibility-and-fleet](visibility-and-fleet.md).

## Decision

**Freeze.** `t3_thread_organize` takes `freeze` (with a `reason`) and `unfreeze`.

- Freeze records a marker on the thread (`frozen`: time, who, reason), then does what `t3_thread_interrupt` with `stop` already does: interrupt the run, hold the queue, stop delegated tasks. `t3_thread_read` returns the marker and clients show it. "Who" comes from the authenticated caller, never from an argument: the outside sign-in's label and session prefix, or the calling thread.
- The marker is set and lifted only through the gated action. It runs the same caller checks as interrupt (write access to the target within the caller's mode limits, and a live calling thread) and passes a `ThreadFreezeGate` to the orchestrator. A raw `thread.metadata.update` carrying `frozen`, from any WebSocket session including a bot session, is refused, so nobody can clear a marker or fake who set it.
- A frozen thread starts nothing. Queued messages stay and stay held. A new send from an agent, scheduled task, webhook, notification, delegated result or restart-mode send is queued held, behind the last executed run, or with no provider thread yet when the thread never ran. A scheduled task that fires again while its earlier copy is held adds nothing. Idle compaction is dropped. Starting a queued run is refused while the marker is set.
- Unfreeze is one `queue.resume` that lifts the marker and releases the queue together. A refused resume (a usage limit, say) changes nothing, so the call can be repeated. The thread records who lifted it (`unfrozen`) until its next freeze.
- Who may lift it: the operator's paired owner client, by sending or pressing Resume (the transport's command actor `owner_client`, which a client cannot claim; a `t3 auth session` bot is not one), or another thread or sign-in through `unfreeze`. A frozen thread cannot unfreeze itself and a delegate cannot unfreeze its parent. A thread may freeze itself; only its coordinator or the operator can then lift it. The upstream desktop app has no frozen indicator, so its owner needs the way out through a send.
- `freshContext` on unfreeze makes the next message that starts a run use a fresh provider context. It is refused while messages are queued, because they would start first on the old context; cancel them with `t3_queue`.

**Registry.** `agent_registry` lists the agents that called this server in the last 14 days, from `mcp_request_log`, sign-ins, threads and scheduled tasks. Each row has kind (`outside_client`, `linked_agent`, `local_thread`, `scheduled_task`, `delegate`), label, session prefix, last tool and time, calls and runs in 24 hours, and whether the thread is frozen. A small `mcp_agent_summary` table (one row per caller, kept by the request log) gives the pages, so a page never aggregates the log. The cursor is a log row number and names no agent.

- Each call records its MCP connection: a digest of the `Mcp-Session-Id` the transport assigns at initialize and the client echoes. A sign-in whose calls arrive on two or more connections active in overlapping time is `shared, unattributable`: several agents act through it at once, so its calls cannot be tied to one. Parallel calls on one session count once; a sequential reconnect does not overlap. Calls logged before migration 013 have no connection, so the flag fills in after the update.
- Full-access sign-ins and thread callers see every agent; other sign-ins see only their own row. Session prefixes only, no ids, secrets or bodies.

## Alternatives

- A new `thread.freeze` command and event: touches every command and event switch for no gain over the existing `thread.metadata.update` event.
- Freeze state in a fork table: simpler to merge, but clients would not see it without a new feed.
- Refuse sends to a frozen thread: loses delegated results and scheduled runs; held queueing keeps them.
- Count the threads a sign-in reaches as sharing: it flagged a coordinator that drives many threads and missed the shared Codex sign-in. The MCP client id the transport gives each request does not name a connection either, so it is not the key.

## Why

Containing one misbehaving inbox agent took four calls, because a send in restart mode did not interrupt the running turn and the queue had to be reordered first. Nobody could tell which agent was acting: its messages came through a Codex sign-in that several agents share. One call now stops the thread durably and records who did it, and the registry shows which sign-ins several agents share, so a containment can name its target.

## Limits

A full-access agent on the host can still send a bot WebSocket session's `queue.resume`, which an agent cannot lift a freeze with, but it can run the gated tool as itself; 0015 records the same residual for approvals. `queued-message.promote-to-steer` is not gated: it needs an active run, and freeze stops it.
