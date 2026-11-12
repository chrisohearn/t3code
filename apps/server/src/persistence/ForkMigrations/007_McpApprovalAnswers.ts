import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE mcp_approval_answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL, request_id TEXT NOT NULL, answer_json TEXT NOT NULL,
    UNIQUE(thread_id, request_id)
  )`;
});
