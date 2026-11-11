import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE work_ledger (
    work_key TEXT PRIMARY KEY, title TEXT NOT NULL, owner_kind TEXT NOT NULL,
    owner_name TEXT NOT NULL, owner_thread_id TEXT, status TEXT NOT NULL,
    blocker TEXT, next_action TEXT, approval_note TEXT, links_json TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL
  )`;
});
