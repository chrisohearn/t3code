import * as Effect from "effect/Effect";
import * as Access from "../../McpToolAccess.ts";
import * as Bridge from "../../BridgeStatusService.ts";
import { BridgeToolkit } from "./tools.ts";
export const layer = Access.toLayer(BridgeToolkit, {
  bridge_status: Access.reads(() =>
    Effect.flatMap(Bridge.BridgeStatusService, (service) => service.status()),
  ),
});
