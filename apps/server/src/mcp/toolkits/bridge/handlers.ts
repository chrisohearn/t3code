import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as McpEvents from "../../McpEvents.ts";
import * as Effect from "effect/Effect";
import * as Access from "../../McpToolAccess.ts";
import * as Bridge from "../../BridgeStatusService.ts";
import { BridgeToolkit } from "./tools.ts";
export const layer = Access.toLayer(BridgeToolkit, {
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
  event_hub_set: Access.reads((input) =>
    Effect.flatMap(McpEvents.McpEvents, (service) => service.setHub(input)).pipe(
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
