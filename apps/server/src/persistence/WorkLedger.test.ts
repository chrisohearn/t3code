import { ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
      const updated = yield* ledger.upsert({ key: "a", status: "done", blocker: null }, "thread-b");
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
      yield* ledger.upsert({ key: "a", ownerThreadId: ThreadId.make("coordinator") }, "session-a");
      expect(yield* ledger.forThread("coordinator")).toEqual([]);
      yield* ledger.upsert({ key: "a", status: "open" }, "session-a");
      expect((yield* ledger.forThread("coordinator")).map((row) => row.key)).toEqual(["a"]);
      expect(yield* ledger.forThread("other")).toEqual([]);
      yield* ledger.upsert({ key: "a", status: "done", ownerThreadId: null }, "thread-b");
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
    }).pipe(Effect.provide(WorkLedger.layer.pipe(Layer.provide(Sqlite.layerMemory)))),
);
