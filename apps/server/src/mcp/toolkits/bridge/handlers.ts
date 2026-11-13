import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as McpEvents from "../../McpEvents.ts";
import * as Effect from "effect/Effect";
import * as Invocation from "../../McpInvocationContext.ts";
import * as AgentRegistry from "../../../persistence/AgentRegistry.ts";
import * as RequestLog from "../../../persistence/McpRequestLog.ts";
import * as Access from "../../McpToolAccess.ts";
import * as Bridge from "../../BridgeStatusService.ts";
import { BridgeToolkit } from "./tools.ts";
export const layer = Access.toLayer(BridgeToolkit, {
  mcp_usage: Access.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* Invocation.McpInvocationContext;
      return yield* (yield* RequestLog.McpRequestLog).usage(input, scope.client?.sessionId);
    }),
  ),
  agent_registry: Access.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* Invocation.McpInvocationContext;
      const client = scope.client;
      return yield* (yield* AgentRegistry.AgentRegistry).list(input, {
        sessionId: client?.sessionId,
        seesAll:
          client === undefined || (client.access === "full-access" && client.linked !== true),
      });
    }),
  ),
  event_subscriptions: Access.reads(() =>
    Effect.flatMap(McpEvents.McpEvents, (service) => service.listSubscriptions()).pipe(
      Effect.mapError(
        (error) =>
          new OrchestratorMcpFailure({
            code: error.reason === "access_denied" ? "capability_denied" : "orchestration_error",
            message: error.message,
          }),
      ),
    ),
  ),
  event_deliveries_replay: Access.writes((input) =>
    Effect.flatMap(McpEvents.McpEvents, (service) => service.replay(input)).pipe(
      Effect.mapError(
        (error) =>
          new OrchestratorMcpFailure({
            code: error.reason === "access_denied" ? "capability_denied" : "orchestration_error",
            message: error.message,
          }),
      ),
    ),
  ),
  event_inbox_set: Access.writes((input) =>
    Effect.flatMap(McpEvents.McpEvents, (service) => service.setInbox(input)).pipe(
      Effect.mapError(
        (error) =>
          new OrchestratorMcpFailure({
            code: error.reason === "access_denied" ? "capability_denied" : "orchestration_error",
            message: error.message,
          }),
      ),
    ),
  ),
  event_unsubscribe: Access.reads((input) =>
    Effect.flatMap(McpEvents.McpEvents, (service) => service.unsubscribe(input)).pipe(
      Effect.mapError(
        (error) =>
          new OrchestratorMcpFailure({
            code: error.reason === "access_denied" ? "capability_denied" : "orchestration_error",
            message: error.message,
          }),
      ),
    ),
  ),
  bridge_status: Access.reads(() =>
    Effect.flatMap(Bridge.BridgeStatusService, (service) => service.status()),
  ),
});
