import {
  EnvironmentId,
  EnvironmentConnectReachability,
  McpEventSubscriptionsResult,
  IsoDateTime,
  McpEventWatch,
  NonNegativeInt,
  OrchestratorMcpFailure,
  ScheduledTaskId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as Invocation from "./McpInvocationContext.ts";
import * as McpEvents from "./McpEvents.ts";
import * as Metrics from "./McpBridgeMetrics.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
export const BridgeStatusResult = Schema.Struct({
  serviceStartedAt: Schema.String,
  tunnel: Schema.NullOr(EnvironmentConnectReachability),
  daysUntilSessionExpires: Schema.Number,
  subscriptions: McpEventSubscriptionsResult.fields.subscriptions,
  inboxThreadId: McpEventSubscriptionsResult.fields.inboxThreadId,
  watches: Schema.Array(McpEventWatch),
  relayFailures: Schema.Number,
  relayPending: Schema.Number,
  relayLastError: Schema.NullOr(Schema.String),
  lastSuccessfulEventDeliveryAt: Schema.NullOr(Schema.String),
  deliveriesExhaustedRetries: Schema.Number,
  linkedEnvironments: Schema.NullOr(
    Schema.Struct({
      checkedAt: Schema.String,
      links: Schema.Array(
        Schema.Struct({
          environmentId: EnvironmentId,
          label: Schema.String,
          status: Schema.Literals(["reachable", "unreachable", "expired"]),
          answeredProbe: Schema.Boolean,
        }),
      ),
    }),
  ),
  missedScheduledRuns: Schema.Array(
    Schema.Struct({
      scheduledTaskId: ScheduledTaskId,
      dueAt: IsoDateTime,
      overdueMs: NonNegativeInt,
      reason: Schema.Literals(["not_dispatched", "run_in_progress"]),
    }),
  ),
  toolCalls: Schema.Array(
    Schema.Struct({
      tool: Schema.String,
      calls: Schema.Number,
      errors: Schema.Number,
      responseBytes: Schema.Number,
    }),
  ),
});
export class BridgeStatusService extends Context.Service<
  BridgeStatusService,
  {
    readonly status: () => Effect.Effect<
      typeof BridgeStatusResult.Type,
      OrchestratorMcpFailure,
      Invocation.McpInvocationContext
    >;
  }
>()("t3/mcp/BridgeStatusService") {}
export const layer = Layer.effect(
  BridgeStatusService,
  Effect.gen(function* () {
    const events = yield* McpEvents.McpEvents;
    const metrics = yield* Metrics.McpBridgeMetrics;
    const forwarding = yield* PeerForwarding.PeerForwarding;
    const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
    return BridgeStatusService.of({
      status: Effect.fn("BridgeStatusService.status")(function* () {
        const scope = yield* Invocation.McpInvocationContext;
        const status = yield* events.bridgeStatus().pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({
                code:
                  error.reason === "access_denied" ? "capability_denied" : "orchestration_error",
                message: error.message,
              }),
          ),
        );
        const linkedEnvironments = yield* forwarding.links(scope).pipe(
          Effect.map((result) => ({
            links: result.links.map(({ environmentId, label, status }) => ({
              environmentId,
              label,
              status,
              answeredProbe: status === "reachable",
            })),
          })),
          Effect.flatMap((result) =>
            DateTime.now.pipe(
              Effect.map((now) => ({ ...result, checkedAt: DateTime.formatIso(now) })),
            ),
          ),
          Effect.orElseSucceed(() => null),
        );
        const missedScheduledRuns = yield* scheduledTasks.reliability().pipe(
          Effect.map((entries) =>
            entries.flatMap(({ taskId, missedRun }) =>
              missedRun === undefined
                ? []
                : [{ scheduledTaskId: ScheduledTaskId.make(taskId), ...missedRun }],
            ),
          ),
          Effect.orElseSucceed(() => []),
        );
        return {
          ...status,
          linkedEnvironments,
          missedScheduledRuns,
          toolCalls: yield* metrics.read(scope.client!.sessionId),
        };
      }),
    });
  }),
);
