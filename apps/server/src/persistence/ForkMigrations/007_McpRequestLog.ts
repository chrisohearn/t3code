import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE mcp_request_log (
    id INTEGER PRIMARY KEY, client TEXT NOT NULL, session TEXT NOT NULL, tool TEXT NOT NULL,
    started_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
    request_bytes INTEGER NOT NULL, response_bytes INTEGER NOT NULL, error_class TEXT
  )`;
  yield* sql`CREATE INDEX mcp_request_log_started ON mcp_request_log(started_at)`;
  yield* sql`CREATE INDEX mcp_request_log_client_started ON mcp_request_log(client, started_at)`;
});
