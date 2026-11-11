import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as Bridge from "../../BridgeStatusService.ts";
import * as Invocation from "../../McpInvocationContext.ts";
export const BridgeToolkit = Toolkit.make(
  Tool.make("bridge_status", {
    description:
      "Read this outside MCP sign-in's expiry, event subscriptions, last successful webhook and exhausted retries. Per-tool calls, errors and response bytes count since this server started. Never returns callback secrets.",
    parameters: Schema.Struct({}),
    success: Bridge.BridgeStatusResult,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [Invocation.McpInvocationContext, Bridge.BridgeStatusService],
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
);
