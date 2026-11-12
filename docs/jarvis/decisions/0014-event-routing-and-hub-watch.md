# Event routing and hub watch

Accepted 2026-11-12. The hub is a pinned inbox thread, not a shared webhook callback.

## Decision

Notify registers a durable binding from the authenticated principal and source run
to an explicitly pinned inbox. An outbox worker sends a bounded message through
the normal queued-send service. Stable event-derived request, command, and message
ids make retries reuse the same durable receipt. Run outcomes are coalesced into
one inbox message. Persisted outbox message ids identify relay-generated inbox
runs and prevent loops. The inbox keeps its run-per-message acknowledger.

The pin grants no new authority. Binding and dispatch validate the outside sign-in,
source read access, inbox write access, and the caller's mode limits. Clearing or
changing the pin prevents pending sends to the old inbox. No pin means no relay;
there is no callback-order fallback. Failure counts are independent of webhook
ACKs. Exhaustion alerts use the inbox and a durable daily deduplication key.

Existing explicit event subscriptions retain their exact name and thread filters.
No helper subscriptions are created. Legacy notify copies remain available for
inspection and native-id unsubscribe after release. The migration recovers origin
by treating the earliest row in each principal and callback group as explicit and
later rows as derived. It preserves migration 6's legacy renewal grants.

## Why

ChatGPT owns the canonical subscription list. The [OpenAI MCP Events guide](https://developers.openai.com/plugins/build/mcp-events#send-an-event)
requires the subscription id returned by `events/subscribe`, the subscribed event
name, and data matching the event's payload schema. The [draft's subscription identity](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md#subscription-identity)
also includes immutable filter arguments. Its [webhook delivery rules](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md#webhook-event-delivery)
use the header id to select the secret before parsing the body. A webhook 2xx
acknowledges receipt, not a ChatGPT watch run.

Copying an explicit watch's callback into a derived subscription has not proven a
Jarvis wake. Reusing the explicit id with another thread's result would change
that subscription's meaning. Sending `thread.message` on a `thread.run.result`
watch would violate the event-name requirement. Both callback-routing designs are
rejected. The webhook payload schema stays unchanged.

## Tradeoff and acceptance

The inbox relay adds a queued run and a stored message. It uses the existing wake
path with a genuine inbox run, its registered subscription id, event name, and
thread filter. Posted-message forwarding is outside this round; the inbox must not
switch to post-only acknowledgements.

Acceptance requires a live check after the coordinated round-three update:
Jarvis pins its existing inbox, launches a scratch run with notify, and reports
the source run id after the relay message wakes it. Unit tests and webhook ACKs
do not establish that acceptance.
