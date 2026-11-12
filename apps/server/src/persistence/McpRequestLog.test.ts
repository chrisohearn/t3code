import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "./Sqlite.ts";
import * as Log from "./McpRequestLog.ts";

it.effect("aggregates nearest-rank latency and bytes, isolates sign-ins and expires metadata", () =>
  Effect.gen(function* () {
    const log = yield* Log.McpRequestLog;
    const sql = yield* SqlClient.SqlClient;
    const now = 15 * 24 * 60 * 60 * 1_000;
    yield* TestClock.setTime(now);
    for (const [client, durationMs, startedAt, errorClass] of [
      ["a", 10, now - 100, null],
      ["a", 20, now - 50, "tool_error"],
      ["a", 90, now, null],
      ["b", 200, now, null],
      ["a", 999, 0, null],
    ] as const) {
      yield* log.record({
        client,
        session: client,
        tool: "read",
        startedAt,
        durationMs,
        requestBytes: 7,
        responseBytes: 11,
        errorClass,
      });
    }
    const own = yield* log.usage({}, "a");
    expect(own.byTool).toEqual([
      {
        tool: "read",
        calls: 3,
        errors: 1,
        requestBytes: 21,
        responseBytes: 33,
        p50Ms: 20,
        p95Ms: 90,
      },
    ]);
    expect(own.byClient.map((row) => row.client)).toEqual(["a"]);
    expect((yield* log.usage({}, undefined)).byClient.map((row) => row.client)).toEqual(["a", "b"]);
    expect((yield* log.usage({ since: now, until: now }, "a")).byTool[0]?.calls).toBe(1);
    expect((yield* log.usage({ since: now + 1 }, "a").pipe(Effect.flip)).code).toBe(
      "invalid_request",
    );
    expect((yield* sql`SELECT * FROM mcp_request_log`).length).toBe(4);
    yield* TestClock.setTime(now + 15 * 24 * 60 * 60 * 1_000);
    expect((yield* log.usage({}, "a")).byTool).toEqual([]);
    expect(yield* sql`SELECT * FROM mcp_request_log`).toEqual([]);
    const later = now + 15 * 24 * 60 * 60 * 1_000;
    yield* sql`WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM rows WHERE n < 100100)
      INSERT INTO mcp_request_log (client, session, tool, started_at, duration_ms, request_bytes, response_bytes)
      SELECT printf('%06d', n), 'test', 'read', ${later}, 1, 1, 1 FROM rows`;
    yield* log.record({
      client: "z",
      session: "z",
      tool: "read",
      startedAt: later,
      durationMs: 2,
      requestBytes: 1,
      responseBytes: 1,
      errorClass: null,
    });
    expect(
      (yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM mcp_request_log`)[0]?.count,
    ).toBe(100000);
    const firstPage = yield* log.usage({}, undefined);
    expect(firstPage.byClient).toHaveLength(100);
    expect(firstPage.byClient[0]?.client).toBe("000102");
    expect(firstPage.nextClientCursor).toBe(firstPage.byClient.at(-1)?.client);
    const secondPage = yield* log.usage(
      { since: firstPage.since, until: firstPage.until, clientCursor: firstPage.nextClientCursor! },
      undefined,
    );
    expect(secondPage.byClient).toHaveLength(100);
    expect(secondPage.byClient[0]!.client > firstPage.nextClientCursor!).toBe(true);
    expect((yield* log.usage({ clientCursor: "000001" }, "missing")).byClient).toEqual([]);
  }).pipe(Effect.provide(Log.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);
