import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE work_ledger ADD COLUMN approval_json TEXT`;
  // One answer backs one row.
  yield* sql`CREATE UNIQUE INDEX work_ledger_approval_source_idx ON work_ledger (
    json_extract(approval_json, '$.sourceThreadId'),
    json_extract(approval_json, '$.sourceItemId'),
    json_extract(approval_json, '$.questionId')
  ) WHERE approval_json IS NOT NULL`;
  yield* sql`CREATE TABLE work_ledger_revoked_approvals (
    work_key TEXT NOT NULL, source_thread_id TEXT NOT NULL, source_item_id TEXT NOT NULL,
    question_id TEXT NOT NULL, revoked_at TEXT NOT NULL, revoked_by TEXT NOT NULL,
    PRIMARY KEY (work_key, source_thread_id, source_item_id, question_id)
  )`;
  // Rolling back the run that held the answer withdraws it, in the projection transaction.
  for (const operation of ["INSERT", "UPDATE"] as const) {
    yield* sql.unsafe(`CREATE TRIGGER work_ledger_approval_rollback_${operation.toLowerCase()}
      AFTER ${operation} ON orchestration_v2_projection_runs
      WHEN NEW.status = 'rolled_back'
      BEGIN
        INSERT OR IGNORE INTO work_ledger_revoked_approvals
          SELECT work_key, json_extract(approval_json, '$.sourceThreadId'),
            json_extract(approval_json, '$.sourceItemId'), json_extract(approval_json, '$.questionId'),
            COALESCE(NEW.completed_at, NEW.requested_at), 'server:rollback'
          FROM work_ledger WHERE json_extract(approval_json, '$.sourceRunId') = NEW.run_id;
        INSERT INTO work_ledger_history (work_key, changed_at, changed_by, changes_json)
          SELECT work_key, COALESCE(NEW.completed_at, NEW.requested_at), 'server:rollback',
            json_object('approval', json_object('before', json(approval_json), 'after', json('null')))
          FROM work_ledger WHERE json_extract(approval_json, '$.sourceRunId') = NEW.run_id;
        UPDATE work_ledger SET approval_json = NULL,
          updated_at = MAX(updated_at, COALESCE(NEW.completed_at, NEW.requested_at))
        WHERE json_extract(approval_json, '$.sourceRunId') = NEW.run_id;
      END`);
  }
});
