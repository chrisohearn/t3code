import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE mcp_event_relay_bindings RENAME TO mcp_event_relay_bindings_legacy`;
  yield* sql`CREATE TABLE mcp_event_relay_bindings (
    id TEXT PRIMARY KEY, principal TEXT NOT NULL REFERENCES auth_sessions(session_id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL, inbox_thread_id TEXT NOT NULL, run_id TEXT NOT NULL,
    events TEXT NOT NULL, ledger_key TEXT, runtime_mode TEXT NOT NULL, interaction_mode TEXT NOT NULL,
    scan_cursor INTEGER NOT NULL, expires_at INTEGER, last_error TEXT, closed_at INTEGER
  )`;
  yield* sql`INSERT INTO mcp_event_relay_bindings
    SELECT id, principal, thread_id, inbox_thread_id, run_id, events, ledger_key, runtime_mode,
      interaction_mode, scan_cursor, NULLIF(expires_at, 0), last_error,
      CASE WHEN expires_at = 0 THEN CAST(strftime('%s', 'now') AS INTEGER) * 1000 ELSE NULL END
    FROM mcp_event_relay_bindings_legacy`;
  yield* sql`DROP TABLE mcp_event_relay_bindings_legacy`;
  yield* sql`ALTER TABLE mcp_event_relay_alerts ADD COLUMN reason TEXT NOT NULL DEFAULT 'delivery_failed'`;
});
