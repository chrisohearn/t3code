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
  yield* sql`CREATE TABLE mcp_event_inboxes (
    principal TEXT PRIMARY KEY REFERENCES auth_sessions(session_id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL, runtime_mode TEXT NOT NULL, interaction_mode TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE mcp_event_relay_bindings (
    id TEXT PRIMARY KEY, principal TEXT NOT NULL REFERENCES auth_sessions(session_id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL, inbox_thread_id TEXT NOT NULL, run_id TEXT NOT NULL,
    events TEXT NOT NULL, ledger_key TEXT, runtime_mode TEXT NOT NULL, interaction_mode TEXT NOT NULL,
    scan_cursor INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_error TEXT
  )`;
  yield* sql`CREATE TABLE mcp_event_relay_outbox (
    id TEXT PRIMARY KEY, principal TEXT NOT NULL REFERENCES auth_sessions(session_id) ON DELETE CASCADE,
    source_key TEXT NOT NULL, source_thread_id TEXT NOT NULL, inbox_thread_id TEXT NOT NULL,
    message_id TEXT NOT NULL UNIQUE, client_request_id TEXT NOT NULL UNIQUE,
    runtime_mode TEXT NOT NULL, interaction_mode TEXT NOT NULL, body TEXT NOT NULL,
    alert INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
    last_error TEXT, UNIQUE(principal, inbox_thread_id, source_key)
  )`;
  yield* sql`CREATE INDEX mcp_event_relay_due ON mcp_event_relay_outbox(status, next_attempt_at)`;
  yield* sql`CREATE TABLE mcp_event_relay_alerts (
    principal TEXT NOT NULL REFERENCES auth_sessions(session_id) ON DELETE CASCADE,
    source_key TEXT NOT NULL, day INTEGER NOT NULL, PRIMARY KEY(principal, source_key, day)
  )`;
});
