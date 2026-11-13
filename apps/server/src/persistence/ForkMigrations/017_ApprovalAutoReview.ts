import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE thread_approval_auto_review (
    thread_id TEXT PRIMARY KEY NOT NULL, selection_json TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE approval_auto_review_claims (
    thread_id TEXT NOT NULL, request_id TEXT NOT NULL,
    PRIMARY KEY (thread_id, request_id)
  )`;
});
