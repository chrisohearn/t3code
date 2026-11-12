import { formatThreadLink, parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

const linksCodec = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeLinks = Schema.decodeUnknownEffect(linksCodec);
const encodeLinks = Schema.encodeEffect(linksCodec);

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE work_ledger ADD COLUMN wait_reason TEXT`;
  yield* sql`ALTER TABLE work_ledger ADD COLUMN next_check_at TEXT`;
  yield* sql`ALTER TABLE work_ledger ADD COLUMN last_run_id TEXT`;
  yield* sql`ALTER TABLE work_ledger ADD COLUMN last_run_status TEXT`;
  yield* sql`ALTER TABLE work_ledger ADD COLUMN last_run_at TEXT`;
  yield* sql`UPDATE work_ledger SET wait_reason = CASE
    WHEN blocker GLOB 'WAIT_EXTERNAL*' THEN 'external'
    WHEN blocker GLOB 'WAIT_NATURAL*' THEN 'natural'
    WHEN blocker GLOB 'NEEDS_DECISION*' THEN 'decision' ELSE NULL END`;
  const owners = yield* sql<{ work_key: string; owner_thread_id: string; links_json: string }>`
    SELECT work_key, owner_thread_id, links_json FROM work_ledger WHERE owner_thread_id IS NOT NULL
  `;
  for (const owner of owners) {
    const ref = parseThreadLinkHref(owner.owner_thread_id);
    if (ref === null) continue;
    if (ref.environmentId === null) {
      yield* sql`UPDATE work_ledger SET owner_thread_id = ${ref.threadId} WHERE work_key = ${owner.work_key}`;
    } else {
      const links = yield* decodeLinks(owner.links_json);
      const href = formatThreadLink(ref).slice(1, -1);
      const encodedLinks = yield* encodeLinks([...new Set([...links, href])]);
      yield* sql`UPDATE work_ledger SET owner_thread_id = NULL,
        links_json = ${encodedLinks} WHERE work_key = ${owner.work_key}`;
    }
  }
  yield* sql`CREATE INDEX work_ledger_due_idx ON work_ledger(next_check_at) WHERE next_check_at IS NOT NULL`;
  yield* sql`CREATE TABLE work_ledger_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, work_key TEXT NOT NULL,
    changed_at TEXT NOT NULL, changed_by TEXT NOT NULL, changes_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX work_ledger_history_key_idx ON work_ledger_history(work_key, id)`;
  // Keep terminal-run metadata in the projection transaction, including recovery and replay.
  for (const operation of ["INSERT", "UPDATE"] as const) {
    yield* sql.unsafe(`CREATE TRIGGER work_ledger_run_${operation.toLowerCase()}
      AFTER ${operation} ON orchestration_v2_projection_runs
      WHEN NEW.status IN ('completed', 'failed', 'cancelled', 'interrupted', 'rolled_back')
        AND CASE WHEN json_valid(NEW.payload_json)
          THEN json_extract(NEW.payload_json, '$.clientRequestId') IS NOT NULL ELSE 0 END
      BEGIN
        UPDATE work_ledger SET last_run_id = NEW.run_id, last_run_status = NEW.status,
          last_run_at = COALESCE(NEW.completed_at, NEW.requested_at),
          updated_at = MAX(updated_at, COALESCE(NEW.completed_at, NEW.requested_at))
        WHERE work_key = json_extract(NEW.payload_json, '$.clientRequestId')
          AND (last_run_at IS NULL OR last_run_at <= COALESCE(NEW.completed_at, NEW.requested_at));
      END`);
  }
});
