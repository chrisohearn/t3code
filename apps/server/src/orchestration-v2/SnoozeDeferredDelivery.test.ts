import { assert, describe, it } from "@effect/vitest";
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as SnoozeDeferredDelivery from "./SnoozeDeferredDelivery.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const startMs = Date.parse("2026-11-13T03:00:00.000Z");
const deferred = (threadId: string, snoozedUntil: string | null) => ({
  threadId,
  snoozedUntil,
  firstRunId: `run:${threadId}`,
});

describe("snoozeDeferredReleases", () => {
  it("releases awake threads and wakes at the earliest snooze still holding a turn", () => {
    const { due, wakeAtMs } = SnoozeDeferredDelivery.snoozeDeferredReleases(
      [
        deferred("unsnoozed", null),
        deferred("expired", "2026-11-13T02:59:59.000Z"),
        deferred("later", "2026-11-24T00:00:00.000Z"),
        deferred("sooner", "2026-11-18T00:00:00.000Z"),
      ],
      startMs,
    );
    assert.deepEqual(
      due.map((entry) => entry.threadId),
      ["unsnoozed", "expired"],
    );
    assert.equal(wakeAtMs, Date.parse("2026-11-18T00:00:00.000Z"));
  });
});

it.effect("resumes a held turn when the thread wakes, retrying a refused resume", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(startMs);
    const rows = yield* Ref.make([
      deferred("snoozed", "2026-11-13T03:01:00.000Z"),
      deferred("failed", "2026-11-24T00:00:00.000Z"),
    ]);
    const attempts = yield* Queue.unbounded<Readonly<Record<string, string>>>();
    const refuseNext = yield* Ref.make(new Set(["snoozed"]));
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const snoozedShell = (status: string, completedAt: string | null) => ({
      snoozedUntil: DateTime.makeUnsafe("2026-11-24T00:00:00.000Z"),
      snoozedAt: DateTime.makeUnsafe("2026-11-13T02:00:00.000Z"),
      latestRunCompletedAt: completedAt === null ? null : DateTime.makeUnsafe(completedAt),
      status,
      pendingRuntimeRequest: null,
      pendingGuestMessageCount: 0,
    });
    const layer = SnoozeDeferredDelivery.layerWorker.pipe(
      Layer.provide(
        Layer.mergeAll(
          Scheduler.layer,
          Layer.succeed(SnoozeDeferredDelivery.SnoozeDeferredStore, {
            read: Ref.get(rows),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            // "failed" failed after it was snoozed, which wakes it as the sidebar shows it.
            getThreadShell: (threadId) =>
              Effect.succeed(
                (threadId === "failed"
                  ? snoozedShell("failed", "2026-11-13T02:30:00.000Z")
                  : snoozedShell("idle", null)) as never,
              ),
            // A refusal, such as a limited provider, releases nothing; a release clears the deferral.
            dispatch: (command) => {
              const attempt = command as unknown as Readonly<Record<string, string>>;
              const threadId = attempt["threadId"]!;
              return Queue.offer(attempts, attempt).pipe(
                Effect.andThen(Ref.get(refuseNext)),
                Effect.flatMap((refused) =>
                  refused.has(threadId)
                    ? Ref.update(refuseNext, (current) => {
                        const next = new Set(current);
                        next.delete(threadId);
                        return next;
                      }).pipe(Effect.andThen(Effect.fail("refused" as never)))
                    : Ref.update(rows, (current) =>
                        current.filter((row) => row.threadId !== threadId),
                      ).pipe(Effect.as({ sequence: 1, storedEvents: [] })),
                ),
              );
            },
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromQueue(events),
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      // The first sweep releases the thread that woke on its failure, long before its date.
      assert.equal((yield* Queue.take(attempts))["threadId"], "failed");

      yield* TestClock.adjust("60 seconds");
      const refused = yield* Queue.take(attempts);
      assert.equal(refused["threadId"], "snoozed");
      yield* TestClock.adjust("60 seconds");
      const retried = yield* Queue.take(attempts);
      assert.equal(retried["threadId"], "snoozed");
      assert.notEqual(retried["commandId"], refused["commandId"]);

      yield* Ref.set(rows, [deferred("woken", null)]);
      yield* Queue.offer(events, { type: "thread.unsnoozed" } as never);
      yield* TestClock.adjust("5 seconds");
      assert.equal((yield* Queue.take(attempts))["threadId"], "woken");

      yield* TestClock.adjust("10 minutes");
      assert.equal(yield* Queue.size(attempts), 0);
    }).pipe(Effect.provide(layer));
  }),
);
