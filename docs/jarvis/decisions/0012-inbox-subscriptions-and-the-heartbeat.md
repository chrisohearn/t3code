# Inbox subscriptions and the heartbeat

Accepted 2026-11-12.

## Decision

Keep the twelve-hour inbox heartbeat. Each acknowledged delivery renews an explicit
subscription for its granted lifetime, bounded by the current sign-in expiry.
Failed deliveries do not renew it. Legacy notify-only watches retain their existing grants.
New notify calls use the [inbox relay](0014-event-routing-and-hub-watch.md).
Existing watches adopt rolling renewal because their creation path was not recorded.
Client refreshes and signing-secret rotation remain supported.

## Alternatives

Rely on ChatGPT to refresh its watch, or grant thirty days despite a shorter finite
client request.

## Why

Chris and Jarvis observed that enabling a watch did not renew it, while subscribing
again created another callback. The fork defaults to one day and caps grants at
seven days. The MCP Events draft recommends finite grants no longer than requested,
with a minimum-TTL floor as its stated exception. Renewing on delivery preserves
the granted lifetime; the heartbeat supplies activity before an idle watch lapses.
The heartbeat cannot be deleted on this evidence.
