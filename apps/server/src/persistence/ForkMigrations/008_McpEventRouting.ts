import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE mcp_event_subscription_routing (
    subscription_id TEXT PRIMARY KEY REFERENCES mcp_event_subscriptions(id) ON DELETE CASCADE,
    created_order INTEGER NOT NULL, notify_derived INTEGER NOT NULL
  )`;
  yield* sql`INSERT INTO mcp_event_subscription_routing (subscription_id, created_order, notify_derived)
    SELECT s.id, s.rowid, CASE WHEN s.rowid = (
      SELECT MIN(first.rowid) FROM mcp_event_subscriptions AS first
      WHERE first.principal = s.principal AND first.callback_url = s.callback_url
    ) THEN 0 ELSE 1 END FROM mcp_event_subscriptions AS s`;
  yield* sql`CREATE TABLE mcp_event_hubs (
    principal TEXT PRIMARY KEY REFERENCES auth_sessions(session_id) ON DELETE CASCADE,
    subscription_id TEXT NOT NULL REFERENCES mcp_event_subscriptions(id) ON DELETE CASCADE
  )`;
  yield* sql`CREATE TABLE mcp_event_run_context (
    principal TEXT NOT NULL REFERENCES auth_sessions(session_id) ON DELETE CASCADE,
    message_id TEXT NOT NULL, client_request_id TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY(principal, message_id)
  )`;
  yield* sql`CREATE TABLE mcp_event_observations (
    subscription_id TEXT NOT NULL REFERENCES mcp_event_subscriptions(id) ON DELETE CASCADE,
    event_id TEXT NOT NULL, sequence INTEGER NOT NULL, PRIMARY KEY(subscription_id, event_id)
  )`;
  yield* sql`CREATE TABLE mcp_event_exhaustion_alerts (
    subscription_id TEXT PRIMARY KEY REFERENCES mcp_event_subscriptions(id) ON DELETE CASCADE,
    day INTEGER NOT NULL
  )`;
});
