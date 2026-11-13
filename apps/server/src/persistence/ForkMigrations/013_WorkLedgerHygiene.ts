import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE work_ledger ADD COLUMN handoff_args_json TEXT
    CHECK (handoff_args_json IS NULL OR (json_valid(handoff_args_json) AND length(CAST(handoff_args_json AS BLOB)) <= 4096))`;
  yield* sql`ALTER TABLE work_ledger_history ADD COLUMN changed_by_client_json TEXT`;
});
