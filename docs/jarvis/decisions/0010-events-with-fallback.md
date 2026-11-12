# Use events with the existing two-hour fallback

Accepted 2026-11-12.

## Decision

Events are the primary wake-up mechanism. Keep the existing two-hour fallback and drop adaptive scheduler backoff. Use the existing T3 Connect connection for outside access.

## Alternatives

Poll with adaptive backoff, add a new tunnel, or rely exclusively on events.

## Why

Events already worked end to end on November 11. The existing fallback covers missed notifications without another scheduling mechanism or tunnel.
