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
  // An answer approves once: whatever retires its approval retires the answer.
  yield* sql`CREATE TABLE work_ledger_revoked_approvals (
    source_thread_id TEXT NOT NULL, source_item_id TEXT NOT NULL, question_id TEXT NOT NULL,
    work_key TEXT NOT NULL, revoked_at TEXT NOT NULL, revoked_by TEXT NOT NULL,
    PRIMARY KEY (source_thread_id, source_item_id, question_id)
  )`;
  // Withdraw approvals whose source goes away, in the projection transaction.
  const withdraw = (name: string, event: string, when: string, match: string, at: string) =>
    sql.unsafe(`CREATE TRIGGER ${name} ${event} WHEN ${when}
      BEGIN
        INSERT OR IGNORE INTO work_ledger_revoked_approvals
          SELECT json_extract(approval_json, '$.sourceThreadId'),
            json_extract(approval_json, '$.sourceItemId'), json_extract(approval_json, '$.questionId'),
            work_key, ${at}, 'server:${name}'
          FROM work_ledger WHERE ${match};
        INSERT INTO work_ledger_history (work_key, changed_at, changed_by, changes_json)
          SELECT work_key, ${at}, 'server:${name}',
            json_object('approval', json_object('before', json(approval_json), 'after', json('null')))
          FROM work_ledger WHERE ${match};
        UPDATE work_ledger SET approval_json = NULL, updated_at = MAX(updated_at, ${at})
        WHERE ${match};
      END`);
  const runMatch = "json_extract(approval_json, '$.sourceRunId') = NEW.run_id";
  const runAt = "COALESCE(NEW.completed_at, NEW.requested_at)";
  for (const operation of ["INSERT", "UPDATE"] as const)
    yield* withdraw(
      `work_ledger_approval_rollback_${operation.toLowerCase()}`,
      `AFTER ${operation} ON orchestration_v2_projection_runs`,
      "NEW.status = 'rolled_back'",
      runMatch,
      runAt,
    );
  yield* withdraw(
    "work_ledger_approval_thread_deleted",
    "AFTER UPDATE OF deleted_at ON orchestration_v2_projection_threads",
    "NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL",
    "json_extract(approval_json, '$.sourceThreadId') = NEW.thread_id",
    "NEW.deleted_at",
  );
  yield* withdraw(
    "work_ledger_approval_thread_purged",
    "AFTER DELETE ON orchestration_v2_projection_threads",
    "1",
    "json_extract(approval_json, '$.sourceThreadId') = OLD.thread_id",
    "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
  );
});
