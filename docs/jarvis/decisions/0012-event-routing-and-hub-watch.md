# Event routing and hub watch

Accepted 2026-11-12.

## Decision

Each outside sign-in can pin an active explicit watch with `event_hub_set`.
`notify.via` overrides that pin for one call. Without a pin, notify uses the
newest-created active explicit `thread.run.result` subscription. A pinned watch
that becomes unavailable produces an unavailable result until the pin is cleared
or changed. Notify reports its source subscription and routing reason.

Notify-derived subscriptions cannot become hubs. For legacy rows, the first row
by SQLite creation order in each sign-in and callback group is explicit; later
rows are derived copies. Backfill preserves existing inbox watches without a new
ChatGPT subscription. Refresh and ACK renewal do not change creation order.

## Alternatives

Choose the latest refresh, choose the oldest explicit watch, or require a new
explicit subscription after upgrading.

## Why

Each ChatGPT subscription creates a watch. Re-subscribing creates duplicates;
refresh order moves results between unrelated watches; the oldest watch may
belong to an old task. A durable pin selects the existing inbox watch and lets
Jarvis remove duplicates by native subscription id.
