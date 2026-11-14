import { expect, it } from "@effect/vitest";
import { EnvironmentId, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as Bridge from "./BridgeStatusService.ts";
import * as Invocation from "./McpInvocationContext.ts";
import * as Events from "./McpEvents.ts";
import * as Metrics from "./McpBridgeMetrics.ts";
import * as AutoReview from "../orchestration-v2/ApprovalAutoReviewStatus.ts";
import * as ApprovalWorker from "../orchestration-v2/ApprovalAutoReview.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstances from "../provider/ProviderInstanceRegistry.ts";
import * as TextGenerators from "../textGeneration/TextGenerators.ts";
import * as Settings from "../serverSettings.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";

it.effect(
  "reports fresh peer probe results and preserves bridge status when links are unavailable",
  () =>
    Effect.gen(function* () {
      const unavailable = yield* Ref.make(false);
      const worker = ApprovalWorker.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Sqlite.layerMemory,
            Settings.layerTest(),
            Layer.mock(ThreadManagement.ThreadManagementService)({}),
            Layer.mock(ProviderInstances.ProviderInstanceRegistry)({}),
            Layer.mock(TextGenerators.TextGenerators)({}),
            Layer.mock(EventSink.EventSinkV2)({
              latestSequence: () => Effect.succeed(0),
              stream: () => Stream.never,
            }),
          ),
        ),
      );
      const scope: Invocation.McpInvocationScope = {
        environmentId: EnvironmentId.make("here"),
        requestNamespace: "outside",
        thread: undefined,
        client: { sessionId: "outside", label: "Jarvis", access: "read-only" },
        capabilities: new Set(["orchestration"]),
        issuedAt: 0,
      };
      const dependencies = Layer.mergeAll(
        Metrics.layer,
        Layer.mock(Events.McpEvents)({
          bridgeStatus: () =>
            Effect.succeed({
              serviceStartedAt: "1970-01-01T00:00:00.000Z",
              tunnel: null,
              daysUntilSessionExpires: 1,
              subscriptions: [],
              inboxThreadId: null,
              watches: [],
              relayFailures: 0,
              relayPending: 0,
              relayLastError: null,
              lastSuccessfulEventDeliveryAt: null,
              deliveriesExhaustedRetries: 0,
            }),
        }),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          reliability: () =>
            Effect.succeed([
              { taskId: "scheduled-task:quiet" },
              {
                taskId: "scheduled-task:late",
                missedRun: {
                  dueAt: "1969-12-31T00:00:00.000Z",
                  overdueMs: 86_400_000,
                  reason: "not_dispatched" as const,
                },
              },
            ]),
        }),
        Layer.mock(PeerForwarding.PeerForwarding)({
          links: (caller) =>
            Effect.gen(function* () {
              expect(caller).toBe(scope);
              if (yield* Ref.get(unavailable))
                return yield* new OrchestratorMcpFailure({
                  code: "capability_denied",
                  message: "Disabled",
                });
              return {
                environmentId: scope.environmentId,
                notListed: "",
                links: ["reachable", "unreachable", "expired"].map((status) => ({
                  environmentId: EnvironmentId.make(status),
                  label: status,
                  status: status as "reachable" | "unreachable" | "expired",
                  access: "full-access" as const,
                  expiresAt: "2030-01-01",
                  lastError: null,
                })),
              };
            }),
        }),
      );
      yield* Effect.gen(function* () {
        const service = yield* Bridge.BridgeStatusService;
        const status = yield* service.status();
        expect(status.autoReview).toEqual({ status: "healthy", failures: 0, lastError: null });
        expect(status.missedScheduledRuns).toEqual([
          {
            scheduledTaskId: "scheduled-task:late",
            dueAt: "1969-12-31T00:00:00.000Z",
            overdueMs: 86_400_000,
          },
        ]);
        expect(status.linkedEnvironments).toMatchObject({
          checkedAt: "1970-01-01T00:00:00.000Z",
          links: [
            { environmentId: "reachable", label: "reachable", answeredProbe: true },
            { environmentId: "unreachable", answeredProbe: false },
            { environmentId: "expired", answeredProbe: false },
          ],
        });
        yield* Ref.set(unavailable, true);
        const autoReview = yield* AutoReview.ApprovalAutoReviewStatus;
        yield* autoReview.failed("Subscription overflow; resubscribing");
        const workerStatus = yield* autoReview.read;
        expect(yield* service.status()).toMatchObject({
          linkedEnvironments: null,
          daysUntilSessionExpires: 1,
          autoReview: workerStatus,
        });
        expect(workerStatus.status).toBe("degraded");
        expect(workerStatus.failures).toBe(1);
        expect(workerStatus.lastError).toContain("Subscription overflow");
      }).pipe(
        Effect.provide(Bridge.layer.pipe(Layer.provide(dependencies), Layer.provideMerge(worker))),
        Effect.provideService(Invocation.McpInvocationContext, scope),
      );
    }),
);
