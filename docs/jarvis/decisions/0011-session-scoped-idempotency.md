# Keep idempotency scoped to each sign-in

Accepted 2026-11-11.

## Decision

Do not carry request idempotency across sign-ins by client id.

## Alternatives

Deduplicate requests across renewed sign-ins using the client identity.

## Why

Two ChatGPT accounts share one client id, so client-wide deduplication could conflate independent callers. The convenience of retrying an old key does not justify that identity ambiguity.
