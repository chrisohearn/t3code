import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import ForkMigration0001 from "./ForkMigrations/001_McpEvents.ts";

// Fork-only migrations, recorded in their own table so upstream keeps every id in
// effect_sql_migrations. They run after all upstream migrations. Add new ones here, never in
// Migrations.ts, and never rename one: the repair below finds old rows by name. See FORK.md.
const forkMigrationEntries = [[1, "McpEvents", ForkMigration0001]] as const;

export const FORK_MIGRATIONS_TABLE = "t3_fork_migrations";

export const forkMigrationManifest = forkMigrationEntries.map(([id, name]) => [id, name] as const);

const forkIdsByName = new Map<string, number>(
  forkMigrationManifest.map(([id, name]) => [name, id]),
);

interface RecordedMigration {
  readonly id: number;
  readonly name: string;
}

/**
 * Rows of `effect_sql_migrations` that a fork build wrote before fork migrations had their own
 * table: a fork migration's name at an id where upstream has a different migration or none.
 */
export function legacyForkRows(
  recorded: ReadonlyArray<RecordedMigration>,
  upstreamManifest: ReadonlyArray<readonly [number, string]>,
): ReadonlyArray<RecordedMigration> {
  const upstreamNames = new Map<number, string>(upstreamManifest);
  return recorded.filter(
    ({ id, name }) => forkIdsByName.has(name) && upstreamNames.get(id) !== name,
  );
}

/** Fork-table history problems that would make the fork migrator skip a migration. */
function forkHistoryProblems(recorded: ReadonlyArray<RecordedMigration>): Array<string> {
  const latest = Math.max(0, ...recorded.map(({ id }) => id));
  const names = new Map(recorded.map(({ id, name }) => [id, name]));
  return forkMigrationManifest.flatMap(([id, name]) => {
    if (id > latest) return [];
    const recordedName = names.get(id);
    return recordedName === name ? [] : [`${id}_${name} (recorded: ${recordedName ?? "nothing"})`];
  });
}

const tableExists = (sql: SqlClient.SqlClient, table: string) =>
  sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}
  `.pipe(Effect.map((rows) => rows.length > 0));

// Same shape the Effect migrator creates for SQLite, so it adopts this table as its own.
const createForkMigrationsTable = (sql: SqlClient.SqlClient) => sql`
  CREATE TABLE IF NOT EXISTS ${sql(FORK_MIGRATIONS_TABLE)} (
    migration_id integer PRIMARY KEY NOT NULL,
    created_at datetime NOT NULL DEFAULT current_timestamp,
    name VARCHAR(255) NOT NULL
  )
`;

/**
 * Moves fork migrations that older fork builds recorded in `effect_sql_migrations` (McpEvents at
 * 81, and so on) into the fork table, keeping their `created_at`. Upstream's migrations at those ids
 * then run, and the fork's are not run again. One transaction; a no-op once nothing is left to move.
 */
export const repairForkMigrationHistory = Effect.fn("repairForkMigrationHistory")(function* (
  upstreamManifest: ReadonlyArray<readonly [number, string]>,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* tableExists(sql, "effect_sql_migrations"))) return [];
      const recorded = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
        readonly created_at: string;
      }>`SELECT migration_id, name, created_at FROM effect_sql_migrations ORDER BY migration_id`;
      const legacy = legacyForkRows(
        recorded.map((row) => ({ id: row.migration_id, name: row.name })),
        upstreamManifest,
      );
      if (legacy.length === 0) return [];

      yield* createForkMigrationsTable(sql);
      const existing = new Map(
        (yield* sql<{ readonly migration_id: number; readonly name: string }>`
          SELECT migration_id, name FROM ${sql(FORK_MIGRATIONS_TABLE)}
        `).map((row) => [row.migration_id, row.name]),
      );
      const moved: Array<readonly [from: number, to: number, name: string]> = [];
      for (const { id, name } of legacy) {
        const forkId = forkIdsByName.get(name)!;
        const recordedName = existing.get(forkId);
        if (recordedName !== undefined && recordedName !== name) {
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message: `Cannot move fork migration ${id}_${name} to ${FORK_MIGRATIONS_TABLE} id ${forkId}, which records ${recordedName}.`,
          });
        }
        if (recordedName === undefined) {
          const createdAt = recorded.find((row) => row.migration_id === id)!.created_at;
          yield* sql`
            INSERT INTO ${sql(FORK_MIGRATIONS_TABLE)} (migration_id, name, created_at)
            VALUES (${forkId}, ${name}, ${createdAt})
          `;
          existing.set(forkId, name);
        }
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = ${id} AND name = ${name}`;
        moved.push([id, forkId, name]);
      }
      return moved;
    }),
  );
});

const readForkHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* tableExists(sql, FORK_MIGRATIONS_TABLE))) return [];
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM ${sql(FORK_MIGRATIONS_TABLE)} ORDER BY migration_id
  `;
  return rows.map((row) => ({ id: row.migration_id, name: row.name }));
});

const runForkMigrator = Migrator.make({});

/** Runs pending fork migrations. Call after upstream's migrations and the history repair. */
export const runForkMigrations = Effect.fn("runForkMigrations")(function* () {
  const problems = forkHistoryProblems(yield* readForkHistory);
  if (problems.length > 0) {
    return yield* new Migrator.MigrationError({
      kind: "BadState",
      message: `This database's fork migration history would skip fork migrations: ${problems.join(", ")}. It was probably written by a different fork build.`,
    });
  }
  return yield* runForkMigrator({
    table: FORK_MIGRATIONS_TABLE,
    loader: Migrator.fromRecord(
      Object.fromEntries(
        forkMigrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
  });
});
