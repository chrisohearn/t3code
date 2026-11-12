# Reach Jarvis through a T3 inbox and an event

Accepted 2026-11-12.

## Decision

T3 agents send requests to Jarvis's T3 inbox thread. An event wakes Jarvis, which reads the request and answers in the requesting thread.

## Alternatives

Type into Jarvis's ChatGPT chat through browser automation, or introduce a separate direct messaging path.

## Why

The inbox keeps requests and replies in T3's durable conversation history and uses the event channel already proven with Jarvis. An inbox acknowledgment means the request was queued, not that Jarvis answered.
