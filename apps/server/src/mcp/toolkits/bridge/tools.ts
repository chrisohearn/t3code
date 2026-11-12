import * as Schema from "effect/Schema";
import * as McpEvents from "../../McpEvents.ts";
import {
  McpEventSubscriptionsResult,
  McpEventHubInput,
  McpEventHubResult,
  McpEventUnsubscribeById,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Bridge from "../../BridgeStatusService.ts";
import * as Invocation from "../../McpInvocationContext.ts";
export const BridgeToolkit = Toolkit.make(
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
  Tool.make("event_subscriptions", {
    description:
      "List this caller's own event subscriptions by native id, thread, event, expiry and callbackGroup (one watch). Includes the hub pin; notifyDerived distinguishes notify copies from explicit watches. Legacy origin is recovered by callback-group creation order. Callback URLs and secrets are omitted.",
    parameters: Tool.EmptyParams,
    success: McpEventSubscriptionsResult,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [Invocation.McpInvocationContext, McpEvents.McpEvents],
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("event_hub_set", {
    description:
      "Pin one owned active explicit subscription as your notify hub by native id from event_subscriptions. Pass id:null to clear the pin. notify.via overrides the pin for one call; without a pin, notify uses the newest active explicit result watch. Does not create or renew a watch.",
    parameters: McpEventHubInput,
    success: McpEventHubResult,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [Invocation.McpInvocationContext, McpEvents.McpEvents],
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
