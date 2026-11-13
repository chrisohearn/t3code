import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS thread_standing_roles (
    thread_id TEXT PRIMARY KEY NOT NULL,
    role_text TEXT NOT NULL,
    revision INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    delivered_revision INTEGER,
    delivered_native_thread_id TEXT,
    delivered_run_ordinal INTEGER
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS launch_presets (
    name TEXT PRIMARY KEY NOT NULL,
    preset_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
  )`;
  // A deleted or purged thread keeps no role.
  yield* sql`CREATE TRIGGER IF NOT EXISTS thread_standing_roles_thread_deleted
    AFTER UPDATE OF deleted_at ON orchestration_v2_projection_threads
    WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
    BEGIN DELETE FROM thread_standing_roles WHERE thread_id = NEW.thread_id; END`;
  yield* sql`CREATE TRIGGER IF NOT EXISTS thread_standing_roles_thread_purged
    AFTER DELETE ON orchestration_v2_projection_threads
    BEGIN DELETE FROM thread_standing_roles WHERE thread_id = OLD.thread_id; END`;
});
