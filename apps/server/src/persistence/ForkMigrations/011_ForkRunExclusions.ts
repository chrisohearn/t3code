import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE fork_run_exclusions (
    thread_id TEXT PRIMARY KEY REFERENCES orchestration_v2_projection_threads(thread_id) ON DELETE CASCADE,
    run_ids_json TEXT NOT NULL
  )`;
  // Retained events disambiguate equal timestamps for forks made before this snapshot existed.
  yield* sql`INSERT INTO fork_run_exclusions (thread_id, run_ids_json)
    SELECT fork.thread_id, (
      SELECT json_group_array(run.run_id)
      FROM orchestration_v2_projection_runs AS run
      WHERE run.thread_id = json_extract(fork.payload_json, '$.forkedFrom.threadId')
        AND run.status = 'rolled_back'
        AND (julianday(run.completed_at) < julianday(fork.created_at)
          OR (julianday(run.completed_at) = julianday(fork.created_at)
            AND (SELECT MIN(sequence) FROM orchestration_events
              WHERE aggregate_kind = 'thread' AND stream_id = run.thread_id
                AND event_type = 'run.updated'
                AND json_extract(payload_json, '$.id') = run.run_id
                AND json_extract(payload_json, '$.status') = 'rolled_back')
              < (SELECT MIN(sequence) FROM orchestration_events
                WHERE aggregate_kind = 'thread' AND stream_id = fork.thread_id
                  AND event_type = 'thread.created')))
    ) FROM orchestration_v2_projection_threads AS fork
    WHERE json_extract(fork.payload_json, '$.forkedFrom.type') = 'run'`;
});
