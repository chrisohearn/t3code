import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { FORK_MIGRATIONS_TABLE, forkMigrationManifest, legacyForkRows } from "./ForkMigrations.ts";
import McpEvents from "./ForkMigrations/001_McpEvents.ts";
import { hasPendingMigrations, migrationManifest, runMigrations } from "./Migrations.ts";

// The last upstream id before fork builds started taking upstream's ids for fork migrations.
const LAST_SHARED_ID = 80;

const upstreamHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const forkHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
    readonly created_at: string;
  }>`SELECT migration_id, name, created_at FROM ${sql(FORK_MIGRATIONS_TABLE)} ORDER BY migration_id`;
  return rows.map((row) => [row.migration_id, row.name, row.created_at] as const);
});

// The history `0.1.9-preview.20261111.9` left on the live database: upstream through 80, then the
// fork's McpEvents at 81, the id upstream later gave ProjectionMessageSearchText.
const seedLegacyForkDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: LAST_SHARED_ID });
  yield* McpEvents;
  yield* sql`
    INSERT INTO effect_sql_migrations (migration_id, name, created_at)
    VALUES (81, 'McpEvents', '2026-11-10 10:32:04')
  `;
});

const pendingUpstream = migrationManifest.filter(([id]) => id > LAST_SHARED_ID);

describe("fork migrations", () => {
  it.effect("record in their own table on a new database", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: migrationManifest.at(-1)![0] });
      assert.isTrue(yield* hasPendingMigrations());
      yield* runMigrations();
      assert.isFalse(yield* hasPendingMigrations());
      assert.deepStrictEqual(yield* upstreamHistory, migrationManifest);
      assert.deepStrictEqual(
        (yield* forkHistory).map(([id, name]) => [id, name] as const),
        forkMigrationManifest,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("move off upstream ids so upstream's migrations there run, once", () =>
    Effect.gen(function* () {
      yield* seedLegacyForkDatabase;

      assert.isTrue(yield* hasPendingMigrations());
      // McpEvents is not run again: its CREATE TABLE would fail on the existing tables.
      assert.deepStrictEqual(yield* runMigrations(), pendingUpstream);
      assert.deepStrictEqual(yield* upstreamHistory, migrationManifest);
      assert.deepStrictEqual((yield* forkHistory)[0], [1, "McpEvents", "2026-11-10 10:32:04"]);
      assert.deepStrictEqual(
        (yield* forkHistory).map(([id, name]) => [id, name] as const),
        forkMigrationManifest,
      );

      const before = [yield* upstreamHistory, yield* forkHistory];
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual([yield* upstreamHistory, yield* forkHistory], before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades fork migration 1 while preserving existing event subscriptions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: migrationManifest.at(-1)![0] });
      yield* McpEvents;
      yield* sql`CREATE TABLE t3_fork_migrations (
        migration_id integer PRIMARY KEY NOT NULL,
        created_at datetime NOT NULL DEFAULT current_timestamp,
        name VARCHAR(255) NOT NULL
      )`;
      yield* sql`INSERT INTO t3_fork_migrations (migration_id, name, created_at)
        VALUES (1, 'McpEvents', '2026-11-12 04:10:00')`;
      yield* sql`INSERT INTO auth_sessions
        (session_id, subject, scopes, method, issued_at, expires_at)
        VALUES ('fork-upgrade', 'test', '[]', 'test', '2026-11-12', '2026-11-13')`;
      yield* sql`INSERT INTO mcp_event_subscriptions
        (id, principal, name, thread_id, callback_url, source_url, secret, rotation_until,
         expires_at, active, scan_cursor, ack_cursor)
        VALUES ('preserved', 'fork-upgrade', 'thread.run.result', 'thread:test',
          'https://example.com/events', 'https://example.com', 'test-secret', 0, 100, 1, 5, 3)`;
      const subscriptions = yield* sql`SELECT * FROM mcp_event_subscriptions`;
      const sessions = yield* sql`SELECT * FROM auth_sessions`;
      assert.isTrue(yield* hasPendingMigrations());
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(
        (yield* forkHistory).map(([id, name]) => [id, name] as const),
        [
          [1, "McpEvents"],
          [2, "WorkLedger"],
          [3, "McpClientThreads"],
          [4, "McpBridgeStatus"],
          [5, "McpOAuthRenewal"],
        ],
      );
      assert.equal((yield* forkHistory)[0]?.[2], "2026-11-12 04:10:00");
      assert.deepStrictEqual(yield* upstreamHistory, migrationManifest);
      assert.deepStrictEqual(yield* sql`SELECT * FROM mcp_event_subscriptions`, subscriptions);
      assert.deepStrictEqual(yield* sql`SELECT * FROM auth_sessions`, sessions);
      yield* sql`SELECT * FROM work_ledger`;
      yield* sql`SELECT * FROM mcp_client_threads`;
      yield* sql`SELECT * FROM mcp_bridge_status`;
      const before = yield* forkHistory;
      assert.isFalse(yield* hasPendingMigrations());
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* forkHistory, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("leave the history untouched when a moved row would clash", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedLegacyForkDatabase;
      yield* sql`
        CREATE TABLE ${sql(FORK_MIGRATIONS_TABLE)} (
          migration_id integer PRIMARY KEY NOT NULL,
          created_at datetime NOT NULL DEFAULT current_timestamp,
          name VARCHAR(255) NOT NULL
        )
      `;
      yield* sql`INSERT INTO ${sql(FORK_MIGRATIONS_TABLE)} (migration_id, name) VALUES (1, 'Other')`;
      const before = yield* upstreamHistory;

      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "81_McpEvents");
      assert.deepStrictEqual(yield* upstreamHistory, before);
      assert.deepStrictEqual(
        (yield* forkHistory).map(([id, name]) => [id, name] as const),
        [[1, "Other"]],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it("leave rows alone where upstream has the same migration", () => {
    const [id, name] = forkMigrationManifest[0]!;
    assert.deepStrictEqual(legacyForkRows([{ id: 500, name }], [[500, name]]), []);
    assert.deepStrictEqual(legacyForkRows([{ id: 500, name }], [[500, "Upstream"]]), [
      { id: 500, name },
    ]);
    assert.deepStrictEqual(legacyForkRows([{ id, name: "Upstream" }], []), []);
  });
});

it.effect("registers every fork migration file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(import.meta.dirname, "ForkMigrations");
    const files = (yield* fs.readDirectory(dir)).flatMap((name) => {
      const match = /^(\d+)_(\w+)\.ts$/.exec(name);
      return match ? [[Number(match[1]), match[2]] as const] : [];
    });
    assert.deepStrictEqual(
      files.toSorted(([a], [b]) => a - b),
      forkMigrationManifest,
    );
    for (const [, name] of forkMigrationManifest) {
      assert.notInclude(
        migrationManifest.map(([, upstreamName]) => upstreamName),
        name,
        `fork migration ${name} shares a name with an upstream migration`,
      );
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);
