import { ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import LedgerMigration from "./ForkMigrations/007_WorkLedgerPortfolio.ts";
import BaseLedgerMigration from "./ForkMigrations/002_WorkLedger.ts";
import * as TestClock from "effect/testing/TestClock";
import * as Sqlite from "./Sqlite.ts";
import * as WorkLedger from "./WorkLedger.ts";

it.effect(
  "upserts by stable key, preserves omitted fields, clears values and pages filtered rows",
  () =>
    Effect.gen(function* () {
      const ledger = yield* WorkLedger.WorkLedger;
      yield* TestClock.setTime(0);
      expect((yield* ledger.upsert({ key: "missing" }, "session-a").pipe(Effect.flip)).code).toBe(
        "invalid_request",
      );
      const first = yield* ledger.upsert(
        {
          key: "a",
          title: "Ship batch",
          ownerKind: "jarvis",
          ownerName: "chief",
          blocker: "CI",
          links: ["https://example.com/pr/1"],
        },
        "session-a",
      );
      yield* TestClock.setTime(1000);
      const { warnings, ...updated } = yield* ledger.upsert(
        { key: "a", status: "done", blocker: null },
        "thread-b",
      );
      expect(warnings).toEqual([]);
      expect(updated).toMatchObject({
        title: first.title,
        ownerKind: first.ownerKind,
        ownerName: first.ownerName,
        status: "done",
        blocker: null,
        links: first.links,
        createdAt: first.createdAt,
        updatedBy: "thread-b",
      });
      expect(updated.updatedAt).not.toBe(first.updatedAt);
      yield* ledger.upsert(
        { key: "b", title: "Other", ownerKind: "human", ownerName: "Chris" },
        "session-b",
      );
      const page = yield* ledger.query({ limit: 1 });
      expect(page.items.map((item) => item.key)).toEqual(["a"]);
      expect(page.nextCursor).toBe("a");
      expect(
        (yield* ledger.query({ cursor: page.nextCursor!, limit: 1 })).items.map((item) => item.key),
      ).toEqual(["b"]);
      expect(
        (yield* ledger.query({
          status: "done",
          ownerKind: "jarvis",
          ownerName: "chief",
          updatedSince: first.updatedAt,
        })).items,
      ).toEqual([updated]);
      expect((yield* ledger.query({ ownerKind: "vision" })).items).toEqual([]);
      // An offset timestamp names the same instant as its UTC form.
      const offset = DateTime.formatIsoOffset(
        DateTime.setZone(
          DateTime.makeUnsafe(updated.updatedAt),
          DateTime.zoneMakeOffset(7 * 3600_000),
        ),
      );
      expect(
        (yield* ledger.query({ updatedSince: offset })).items.map((item) => item.key),
      ).toContain("a");
      // Thread ids from create_threads can be longer than a display name.
      const longCaller = `thread:${"x".repeat(300)}`;
      expect((yield* ledger.upsert({ key: "a" }, longCaller)).updatedBy).toBe(longCaller);
    }).pipe(Effect.provide(WorkLedger.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect(
  "filters waits and due checks, normalizes links and records every upsert atomically",
  () =>
    Effect.gen(function* () {
      const ledger = yield* WorkLedger.WorkLedger;
      yield* TestClock.setTime(1000);
      const first = yield* ledger.upsert(
        {
          key: "wait",
          title: "Wait",
          ownerKind: "t3",
          ownerName: "worker",
          ownerThreadId: ThreadId.make("t3-thread://v1/missing"),
          links: ["https://app.t3.codes/threads/env-1/also-missing"],
          waitReason: "external",
          nextCheckAt: "1970-01-01T01:00:00+01:00",
        },
        "caller-a",
      );
      expect(first.ownerThreadId).toBe("missing");
      expect(first.links).toEqual(["t3-thread://v2/env-1/also-missing"]);
      expect(first.warnings).toHaveLength(2);
      expect(
        (yield* ledger.query({ due: true, waitReason: "external" })).items.map((item) => item.key),
      ).toEqual(["wait"]);
      expect((yield* ledger.query({ due: false })).items).toEqual([]);
      const change = { key: "wait", waitReason: null, nextCheckAt: null } as const;
      yield* ledger.upsert(change, "caller-b");
      yield* ledger.upsert({ key: "wait" }, "caller-b");
      const page = yield* ledger.history({ key: "wait", limit: 1 });
      expect(page.items[0]).toMatchObject({
        changedBy: "caller-a",
        changes: { title: { before: null, after: "Wait" } },
      });
      const rest = yield* ledger.history({ key: "wait", cursor: page.nextCursor! });
      expect(rest.items[0]).toMatchObject({
        changedBy: "caller-b",
        changes: {
          waitReason: { before: "external", after: null },
          nextCheckAt: { before: "1970-01-01T00:00:00.000Z", after: null },
        },
      });
      expect(rest.items[1]!.changes).toEqual({});
      expect((yield* ledger.query({ waitReason: null })).items).toHaveLength(1);
      expect((yield* ledger.query({ due: true })).items).toEqual([]);
      const before = yield* ledger.history({ key: "wait" });
      yield* ledger.upsert({ key: "wait", nextCheckAt: "invalid" }, "caller-c").pipe(Effect.flip);
      expect(yield* ledger.history({ key: "wait" })).toEqual(before);
    }).pipe(Effect.provide(WorkLedger.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect(
  "joins bounded portfolio results and tracks terminal runs without changing ledger status",
  () =>
    Effect.gen(function* () {
      const ledger = yield* WorkLedger.WorkLedger;
      const sql = yield* SqlClient.SqlClient;
      yield* TestClock.setTime(0);
      yield* ledger.upsert(
        {
          key: "run-key",
          title: "Run",
          ownerKind: "t3",
          ownerName: "worker",
          ownerThreadId: ThreadId.make("worker-thread"),
          status: "blocked",
        },
        "caller",
      );
      yield* ledger.upsert(
        { key: "done", title: "Done", ownerKind: "human", ownerName: "Chris", status: "done" },
        "caller",
      );
      yield* sql`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, provider_instance_id, status, requested_at, payload_json)
      VALUES ('run-1', 'worker-thread', 1, 'codex', 'codex', 'running', '1970-01-01T00:00:00.000Z', '{"clientRequestId":"run-key"}')`;
      expect(
        (yield* ledger.query({})).items.find((item) => item.key === "run-key")!.lastRunId,
      ).toBeNull();
      yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed', completed_at = '1970-01-01T00:00:01.000Z' WHERE run_id = 'run-1'`;
      yield* sql`INSERT INTO orchestration_v2_projection_messages
      (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
      VALUES ('result-1', 'worker-thread', 'run-1', 'assistant', 0, '1970-01-01T00:00:01.000Z', '1970-01-01T00:00:01.000Z', '{"text":"Completed the batch"}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests
      (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json)
      VALUES ('request-1', 'worker-thread', 'node-1', 'question', 'pending', '1970-01-01T00:00:01.000Z', '{}')`;
      yield* TestClock.setTime(25 * 60 * 60 * 1000);
      const portfolio = yield* ledger.portfolio({ limit: 1 });
      expect(portfolio.items).toHaveLength(1);
      expect(portfolio.items[0]).toMatchObject({
        item: {
          key: "run-key",
          status: "blocked",
          lastRunId: "run-1",
          lastRunStatus: "completed",
          lastRunAt: "1970-01-01T00:00:01.000Z",
        },
        latestRunStatus: "completed",
        pendingRequestCount: 1,
        resultExcerpt: "Completed the batch",
        staleWorker: true,
      });
      yield* ledger.upsert(
        { key: "z", title: "No thread", ownerKind: "human", ownerName: "Chris" },
        "caller",
      );
      const page = yield* ledger.portfolio({ limit: 1 });
      expect(page.nextCursor).toBe("run-key");
      expect((yield* ledger.portfolio({ cursor: page.nextCursor! })).items[0]).toMatchObject({
        item: { key: "z" },
        staleWorker: false,
      });
      yield* sql`UPDATE orchestration_v2_projection_runs SET completed_at = '1969-12-31T23:59:59.000Z', status = 'failed' WHERE run_id = 'run-1'`;
      expect(
        (yield* ledger.query({})).items.find((item) => item.key === "run-key")!.lastRunStatus,
      ).toBe("completed");
    }).pipe(Effect.provide(WorkLedger.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect("backfills only recognized blocker prefixes during migration", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* BaseLedgerMigration;
    yield* sql`CREATE TABLE orchestration_v2_projection_runs (run_id TEXT, status TEXT, completed_at TEXT, requested_at TEXT, payload_json TEXT)`;
    for (const [key, blocker] of [
      ["a", "WAIT_EXTERNAL: vendor"],
      ["b", "WAIT_NATURAL event"],
      ["c", "NEEDS_DECISION: approve"],
      ["d", "Other"],
    ]) {
      yield* sql`INSERT INTO work_ledger (work_key, title, owner_kind, owner_name, status, blocker, links_json, created_at, updated_at, updated_by)
        VALUES (${key!}, 'Title', 't3', 'worker', 'blocked', ${blocker!}, '[]', '1970-01-01', '1970-01-01', 'caller')`;
    }
    yield* LedgerMigration;
    expect(yield* sql`SELECT wait_reason FROM work_ledger ORDER BY work_key`).toEqual([
      { wait_reason: "external" },
      { wait_reason: "natural" },
      { wait_reason: "decision" },
      { wait_reason: null },
    ]);
    expect(yield* sql`SELECT * FROM work_ledger_history`).toEqual([]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
