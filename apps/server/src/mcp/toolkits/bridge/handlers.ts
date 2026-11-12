import * as Effect from "effect/Effect";
import * as Access from "../../McpToolAccess.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as RequestLog from "../../../persistence/McpRequestLog.ts";
import * as Bridge from "../../BridgeStatusService.ts";
import { BridgeToolkit } from "./tools.ts";
export const layer = Access.toLayer(BridgeToolkit, {
  mcp_usage: Access.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* Invocation.McpInvocationContext;
      return yield* (yield* RequestLog.McpRequestLog).usage(input, scope.client?.sessionId);
    }),
  ),
  bridge_status: Access.reads(() =>
    Effect.flatMap(Bridge.BridgeStatusService, (service) => service.status()),
  ),
});
