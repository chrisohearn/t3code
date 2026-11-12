import {
  EnvironmentConnectReachability,
  McpEventSubscriptionsResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Invocation from "./McpInvocationContext.ts";
import * as McpEvents from "./McpEvents.ts";
import * as Metrics from "./McpBridgeMetrics.ts";
export const BridgeStatusResult = Schema.Struct({
  serviceStartedAt: Schema.String,
  tunnel: Schema.NullOr(EnvironmentConnectReachability),
  daysUntilSessionExpires: Schema.Number,
  subscriptions: McpEventSubscriptionsResult.fields.subscriptions,
  lastSuccessfulEventDeliveryAt: Schema.NullOr(Schema.String),
  deliveriesExhaustedRetries: Schema.Number,
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
        return { ...status, toolCalls: yield* metrics.read(scope.client!.sessionId) };
      }),
    });
  }),
);
