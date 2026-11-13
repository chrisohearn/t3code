# Reach Jarvis through a T3 inbox and an event

Accepted 2026-11-12. Acknowledge-only mode added 2026-11-13.

## Decision

T3 agents send requests to Jarvis's T3 inbox thread. An event wakes Jarvis, which reads the request and answers in the requesting thread.

The inbox acknowledges each message with a run of its own; that run's result event is the wake signal (0012, 0014). Acknowledge-only mode lets the server write that acknowledgement instead of a model. The coordinator turns it on for the inbox after deploy, once it has verified that Jarvis still wakes.

## Acknowledge-only mode

- **What it does.** Each message to an acknowledge-only thread starts a run as usual. The server, not a provider, completes it with the assistant reply ``Queued: `<first 120 characters of the message, on one line>` `` (`Queued.` for a message with no text). The prefix is neutral because any thread can use the mode. The excerpt is sender text published as agent output, so it sits in a code span, where no link or image renders, and token-like strings are redacted as the update guard redacts them. No provider session opens, no tools run and no tokens are spent. Messages are answered one at a time in queue order.
- **Restarts.** A restart holds every other thread's queue until a person sends a message, to protect interrupted provider work. Acknowledge-only threads have none, so their queue stays unheld and keeps moving after a deploy, and a hold left over from before the mode was turned on is released.
- **Events.** The run emits the lifecycle a provider turn does: `run.created` (queued or starting), `run.updated` starting and running, the assistant message, then `run.updated` completed. Subscriptions see the same `thread.run.result` event with the same source run id, and the relay quotes the same assistant message as its excerpt. It deliberately has no provider turn, no `waiting` step and no end-of-turn checkpoint. A context handoff addressed to the acknowledged run is marked superseded in the same commit, since no provider reads it; handoffs carried forward to a later provider run are left alone.
- **What gets acknowledged.** Every run on the thread, whatever started it. Relay messages are meant for Jarvis, so acknowledging them is right. A restart continuation follows only an interrupted provider turn, which acknowledged runs never have. Idle compaction targets only Claude sessions and never compacts a compaction, so a Claude thread in this mode acknowledges at most one `/compact` per idle spell.
- **Who can change it.** `t3_thread_configure` with `acknowledgeOnly` alone, both to turn it on and to turn it off, needs a full-access caller: a live calling thread in full-access mode, or an MCP client signed in with full access, and not a linked environment's caller. Toggles are applied one at a time, so concurrent toggles for different threads are all kept. Anyone who can edit server settings can also change `acknowledgeOnlyThreadIds` in `settings.json`. Reading the thread's configuration shows the mode.
- **Turning it off.** The next message runs the thread's agent again. The agent's native conversation never saw the acknowledged messages.
- **Known limits.** The thread still needs a configured, enabled provider: starting a queued run resolves the provider adapter, and a disabled instance holds the queue. A queue held by an earlier failed or usage-limited run stays held after the mode is turned on, until the next restart or until someone resumes the queue in the app. A run that finishes in this mode never holds the queue. Turning the mode on does not detach a provider session already attached; it stays attached but receives no turns.

## Alternatives

Type into Jarvis's ChatGPT chat through browser automation, or introduce a separate direct messaging path.

For the acknowledgement: keep a model as acknowledger with acknowledge-only instructions, or coalesce queued messages into one turn. On 2026-11-12 a long-lived acknowledger session that predated its instructions acted on messages meant for Jarvis: it sent 19 messages as Jarvis, wrote the ledger 8 times and used a one-run approval. In the 48 hours before, the 169 acknowledgement runs had a p90 time to reply of 285 s, with bursts of 57 messages an hour. Coalescing would change the one-run-per-message wake that 0014 relies on.

## Why

The inbox keeps requests and replies in T3's durable conversation history and uses the event channel already proven with Jarvis. An inbox acknowledgment means the request was queued, not that Jarvis answered.

A written acknowledgement cannot act on a message, costs nothing and finishes in milliseconds, while the run and its events stay the same.
