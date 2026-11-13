# Agent sends respect snoozes; busy threads take scheduled model changes

Accepted 2026-11-13. Number provisional until merge.

## Decision

**Snoozes.** A snooze is a person's dated hold.

- `t3_thread_send`, `t3_thread_post` and `t3_thread_send_attachments` leave a snoozed thread snoozed by default (`respectSnooze` defaults to true).
- A send's turn is queued and held until the snooze ends or someone wakes the thread, and the server then resumes the queue. A post is only recorded.
- Both results return `snoozedUntil` and a warning.
- `respectSnooze: false` wakes the thread, as every send did before.
- A thread that counts as awake (a pending request, a guest message, an error), or has never run, gets the message at once, and its dated hold stays stored.
- Messages a person sends from the app still end the snooze, and so does a send to a thread the server snoozed until a usage limit resets.

**Scheduled model changes.** `t3_thread_configure` with `modelSelection` and `applyAt: "next_turn"` works on a busy thread instead of being refused.

- The thread starts its next turn with the new model or options.
- Messages already queued start with it too, unless their sender named a model.
- The change stays pending until a message on the default model starts with it, after everything queued before it.
- Reading the configuration shows the pending change, and scheduling the current model cancels it.
- Switching provider instance and changing `runtimeMode` still need an idle thread.

## Why

On 2026-11-13 a worker's handoff woke two threads that were snoozed until 11-18 and 11-24, and nobody had released those holds. Agents send for many reasons (relays, handoffs, nudges), and none of them should end a person's hold without saying so. The explicit override and the warning keep the old behaviour one argument away.

The Jarvis inbox always has a run going. Every effort change to it was refused as busy: five times on 2026-11-12. A change that did apply on a busy thread was also undone, because queued messages carry the model they were queued with.

## Costs

- An agent waiting on a snoozed thread now waits until it wakes.
- Repeated sends to a snoozed thread each queue a held turn, and all of them run at wake. The supervisor skips snoozed threads.
- At a scheduled change's boundary, a replaced session that still runs background work holds the queue, which only the app can resume. This was already true for a model picked ahead of a queued message.
