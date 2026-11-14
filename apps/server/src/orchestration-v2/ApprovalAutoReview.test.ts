import { assert, it } from "@effect/vitest";
import {
  EventId,
  NodeId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ApprovalAutoReview from "./ApprovalAutoReview.ts";
import * as Status from "./ApprovalAutoReviewStatus.ts";
import * as EventSink from "./EventSink.ts";
import { LiveStreamBufferError } from "./LiveStreamBudget.ts";

it.effect.each(["overflow", "ended"] as const)(
  "resubscribes after %s and exposes degraded status without losing pending work",
  (failure) =>
    Effect.gen(function* () {
      const subscriptions = yield* Queue.unbounded<number>();
      const reviewed = yield* Deferred.make<void>();
      const now = yield* DateTime.now;
      const pending: OrchestrationV2StoredEvent = {
        sequence: 43,
        commandId: null,
        event: {
          id: EventId.make("pending-event"),
          type: "runtime-request.updated",
          threadId: ThreadId.make("pending-thread"),
          occurredAt: now,
          payload: {
            id: RuntimeRequestId.make("pending-request"),
            nodeId: NodeId.make("pending-node"),
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "command",
            status: "pending",
            responseCapability: {
              type: "live",
              providerSessionId: ProviderSessionId.make("pending-session"),
            },
            createdAt: now,
            resolvedAt: null,
          },
        },
      };
      let attempts = 0;
      yield* Effect.gen(function* () {
        const status = yield* Status.ApprovalAutoReviewStatus;
        yield* ApprovalAutoReview.runWorker(42, (threadId, requestId) =>
          Effect.gen(function* () {
            assert.equal(threadId, "pending-thread");
            assert.equal(requestId, "pending-request");
            yield* Deferred.succeed(reviewed, undefined);
          }),
        ).pipe(Effect.forkScoped);
        assert.equal(yield* Queue.take(subscriptions), 42);
        yield* TestClock.adjust("1 second");
        assert.equal(yield* Queue.take(subscriptions), 42);
        yield* Deferred.await(reviewed);
        const degraded = yield* status.read;
        assert.equal(degraded.status, "degraded");
        assert.equal(degraded.failures, 1);
        assert.include(
          degraded.lastError,
          failure === "overflow" ? "buffer is full" : "ended unexpectedly",
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Status.layer,
            Layer.mock(EventSink.EventSinkV2)({
              stream: (input) =>
                Stream.unwrap(
                  Effect.gen(function* () {
                    yield* Queue.offer(subscriptions, input?.afterSequence ?? -1);
                    attempts += 1;
                    if (attempts === 1) {
                      return failure === "overflow"
                        ? Stream.fail(
                            new EventSink.EventSinkStreamError({
                              afterSequence: 42,
                              cause: new LiveStreamBufferError({ message: "buffer is full" }),
                            }),
                          )
                        : Stream.empty;
                    }
                    return Stream.concat(Stream.make(pending), Stream.never);
                  }),
                ),
            }),
          ),
        ),
      );
    }).pipe(Effect.scoped),
);
