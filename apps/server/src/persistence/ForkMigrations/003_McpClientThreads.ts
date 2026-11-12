import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE mcp_client_threads (thread_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, client_label TEXT NOT NULL, created_at TEXT NOT NULL)`;
  yield* sql`CREATE INDEX mcp_client_threads_session ON mcp_client_threads(session_id, thread_id)`;
});
