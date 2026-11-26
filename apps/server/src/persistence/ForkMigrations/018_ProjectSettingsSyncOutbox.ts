import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE orchestration_command_receipts
    ADD COLUMN project_settings_sync_json TEXT
  `;
});
