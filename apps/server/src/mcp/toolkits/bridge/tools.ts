import * as Schema from "effect/Schema";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpEvents from "../../McpEvents.ts";
import {
  McpEventSubscriptionsResult,
  McpEventInboxInput,
  McpEventReplayInput,
  McpEventReplayResult,
  McpEventInboxResult,
  McpEventUnsubscribeById,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as AgentRegistry from "../../../persistence/AgentRegistry.ts";
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
      "Read this outside MCP sign-in's expiry, event subscriptions, last successful webhook and exhausted retries. Per-tool calls, errors and response bytes count since this server started. Never returns callback secrets.",
    parameters: Tool.EmptyParams,
    success: Bridge.BridgeStatusResult,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [Invocation.McpInvocationContext, Bridge.BridgeStatusService],
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("agent_registry", {
    description:
      "List agents that called in 14 days, newest first: sign-ins, threads, scheduled tasks, delegates. 'shared, unattributable': a sign-in on overlapping MCP connections, so calls can't be tied to one agent. Others see only their own. Page with nextCursor.",
    parameters: AgentRegistry.RegistryInput,
    success: AgentRegistry.RegistryResult,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [Invocation.McpInvocationContext, AgentRegistry.AgentRegistry],
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("event_subscriptions", {
    description:
      "List this caller's own event subscriptions by native id, thread, event, expiry and callbackGroup (one watch). Includes the inbox pin; notifyDerived distinguishes notify copies from explicit watches. Legacy origin is recovered by callback-group creation order. Callback URLs and secrets are omitted.",
    parameters: Tool.EmptyParams,
    success: McpEventSubscriptionsResult,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [Invocation.McpInvocationContext, McpEvents.McpEvents],
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("event_deliveries_replay", {
    description:
      "Replay up to 256 of your exhausted webhook deliveries into your pinned inbox, once per source event. Repeating is safe. Does not recreate a ChatGPT watch or reactivate its callback. Requires inbox write authority.",
    parameters: McpEventReplayInput,
    success: McpEventReplayResult,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      Invocation.McpInvocationContext,
      McpEvents.McpEvents,
      ThreadManagement.ThreadManagementService,
    ],
  }).annotate(Tool.Destructive, false),
  Tool.make("event_inbox_set", {
    description:
      "Pin a writable thread as your notification inbox. Pass threadId:null to clear. notify binds a durable relay to this inbox; no pin means no relay. Starts no run and creates no ChatGPT watch.",
    parameters: McpEventInboxInput,
    success: McpEventInboxResult,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      Invocation.McpInvocationContext,
      McpEvents.McpEvents,
      ThreadManagement.ThreadManagementService,
    ],
  }).annotate(Tool.Destructive, false),
  Tool.make("event_unsubscribe", {
    description:
      "Remove your event subscription by its native id from event_subscriptions. Safe to repeat for a missing id; refuses another caller's subscription. Removes that subscription's delivery backlog.",
    parameters: McpEventUnsubscribeById,
    success: Schema.Struct({}),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [Invocation.McpInvocationContext, McpEvents.McpEvents],
  }).annotate(Tool.Destructive, true),
);
