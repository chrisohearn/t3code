import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE mcp_approval_answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT, request_id TEXT NOT NULL, answer_json TEXT NOT NULL,
    outcome TEXT NOT NULL DEFAULT 'answered' CHECK (outcome IN ('answered', 'refused'))
  )`;
  yield* sql`CREATE UNIQUE INDEX mcp_approval_answer_once
    ON mcp_approval_answers (thread_id, request_id) WHERE outcome = 'answered'`;
});
