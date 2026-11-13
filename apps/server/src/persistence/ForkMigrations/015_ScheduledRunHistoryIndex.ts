import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // list_scheduled_tasks and bridge_status read the last 7 days of failed and cancelled runs.
  yield* sql`CREATE INDEX IF NOT EXISTS fork_runs_failed_recent_idx
    ON orchestration_v2_projection_runs(requested_at)
    WHERE status IN ('failed', 'cancelled')`;
});
