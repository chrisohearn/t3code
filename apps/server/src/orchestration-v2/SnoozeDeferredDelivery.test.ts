import { assert, describe, it } from "@effect/vitest";
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
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

it.effect("resumes a held turn when its snooze ends or the thread is woken, once", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(startMs);
    const rows = yield* Ref.make([deferred("snoozed", "2026-11-13T03:01:00.000Z")]);
    const released = yield* Queue.unbounded<Readonly<Record<string, string>>>();
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const layer = SnoozeDeferredDelivery.layerWorker.pipe(
      Layer.provide(
        Layer.mergeAll(
          Scheduler.layer,
          Layer.succeed(SnoozeDeferredDelivery.SnoozeDeferredStore, {
            read: Ref.get(rows),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            // A release clears the turn's deferral, so the store stops listing it.
            dispatch: (command) => {
              const resumed = command as unknown as Readonly<Record<string, string>>;
              return Ref.update(rows, (current) =>
                current.filter((row) => row.threadId !== resumed["threadId"]),
              ).pipe(
                Effect.andThen(Queue.offer(released, resumed)),
                Effect.as({ sequence: 1, storedEvents: [] }),
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
      yield* TestClock.adjust("60 seconds");
      assert.deepEqual(yield* Queue.take(released), {
        type: "queue.resume",
        commandId: "snooze-deferred-release:run:snoozed",
        threadId: "snoozed",
      });

      yield* Ref.set(rows, [deferred("woken", null)]);
      yield* Queue.offer(events, { type: "thread.unsnoozed" } as never);
      yield* TestClock.adjust("5 seconds");
      assert.equal((yield* Queue.take(released))["threadId"], "woken");

      yield* TestClock.adjust("10 minutes");
      assert.equal(yield* Queue.size(released), 0);
    }).pipe(Effect.provide(layer));
  }),
);
