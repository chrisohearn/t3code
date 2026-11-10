import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE mcp_event_subscriptions (
    id TEXT PRIMARY KEY, principal TEXT NOT NULL REFERENCES auth_sessions(session_id),
    name TEXT NOT NULL, thread_id TEXT NOT NULL, callback_url TEXT NOT NULL, source_url TEXT NOT NULL,
    secret TEXT NOT NULL, previous_secret TEXT, rotation_until INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, active INTEGER NOT NULL, scan_cursor INTEGER NOT NULL,
    ack_cursor INTEGER NOT NULL, truncated INTEGER NOT NULL DEFAULT 0,
    UNIQUE(principal, callback_url, name, thread_id)
  )`;
  yield* sql`CREATE INDEX mcp_event_subscriptions_active ON mcp_event_subscriptions(active, expires_at)`;
  yield* sql`CREATE TABLE mcp_event_deliveries (
    subscription_id TEXT NOT NULL REFERENCES mcp_event_subscriptions(id) ON DELETE CASCADE,
    event_id TEXT NOT NULL, sequence INTEGER NOT NULL, body TEXT NOT NULL,
    acknowledged INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(subscription_id, event_id), UNIQUE(subscription_id, sequence)
  )`;
  yield* sql`CREATE INDEX mcp_event_deliveries_due ON mcp_event_deliveries(acknowledged, next_attempt_at)`;
});
