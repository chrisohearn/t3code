import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE mcp_bridge_status (principal TEXT PRIMARY KEY, last_success_at INTEGER, exhausted_retries INTEGER NOT NULL DEFAULT 0)`;
  yield* sql`CREATE TABLE mcp_event_subscription_activity (subscription_id TEXT PRIMARY KEY REFERENCES mcp_event_subscriptions(id) ON DELETE CASCADE, refreshed_at INTEGER NOT NULL)`;
});
