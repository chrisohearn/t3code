import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as RequestLog from "../../../persistence/McpRequestLog.ts";
import * as Bridge from "../../BridgeStatusService.ts";
import * as Invocation from "../../McpInvocationContext.ts";
export const BridgeToolkit = Toolkit.make(
  Tool.make("mcp_usage", {
    description:
      "Read MCP tool counts, errors, bytes and nearest-rank p50/p95 latency by tool and client. since/until are epoch milliseconds (default last 24h). Retains up to 14 days and 100,000 calls. Outside sign-ins see only their own sign-in, since client IDs can be shared by different accounts. Client pages contain at most 100 rows; continue with nextClientCursor as clientCursor, keeping the same since/until. No bodies or secrets.",
    parameters: RequestLog.UsageInput,
    success: RequestLog.UsageResult,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [Invocation.McpInvocationContext, RequestLog.McpRequestLog],
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("bridge_status", {
    description:
      "Read this outside MCP sign-in's expiry, event subscriptions, last successful webhook and exhausted retries. Per-tool calls, errors and response bytes count since this server started. Linked environments include a fresh identity probe result and check time; null means links are disabled or unavailable. Never returns callback secrets.",
    parameters: Tool.EmptyParams,
    success: Bridge.BridgeStatusResult,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [Invocation.McpInvocationContext, Bridge.BridgeStatusService],
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
);
