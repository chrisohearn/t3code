import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";

export const McpEventName = Schema.Literals([
  "thread.run.result",
  "thread.needs-decision",
  "thread.blocker",
  "thread.resource-released",
]);
export type McpEventName = typeof McpEventName.Type;

export const McpEventArguments = Schema.Struct({ threadId: ThreadId });
export const McpEventDelivery = Schema.Struct({
  mode: Schema.Literal("webhook"),
  url: Schema.String.check(Schema.isMaxLength(4096)),
});
export const McpEventSubscribe = Schema.Struct({
  name: McpEventName,
  arguments: McpEventArguments,
  delivery: Schema.Struct({
    ...McpEventDelivery.fields,
    secret: Schema.RedactedFromValue(Schema.String),
  }),
  cursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
  ttlMs: Schema.optionalKey(Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0)))),
});
export type McpEventSubscribe = typeof McpEventSubscribe.Type;
export const McpEventSubscriptionIdentity = Schema.Struct({
  name: McpEventName,
  arguments: McpEventArguments,
  delivery: McpEventDelivery,
});
export const McpEventUnsubscribeById = Schema.Struct({
  id: Schema.String.check(Schema.isMaxLength(128)),
});
export const McpEventUnsubscribe = Schema.Union([
  McpEventSubscriptionIdentity,
  McpEventUnsubscribeById,
]);
export type McpEventUnsubscribe = typeof McpEventUnsubscribe.Type;
export const McpEventReplayInput = McpEventUnsubscribeById;
export const McpEventReplayResult = Schema.Struct({ replayed: Schema.Number });
export const McpEventInboxInput = Schema.Struct({ threadId: Schema.NullOr(ThreadId) });
export type McpEventInboxInput = typeof McpEventInboxInput.Type;
export const McpEventInboxResult = Schema.Struct({ inboxThreadId: Schema.NullOr(ThreadId) });
export type McpEventInboxResult = typeof McpEventInboxResult.Type;
export const McpEventSubscriptionsResult = Schema.Struct({
  ...McpEventInboxResult.fields,
  subscriptions: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: McpEventName,
      arguments: McpEventArguments,
      callbackOrigin: Schema.String,
      callbackGroup: Schema.String,
      notifyDerived: Schema.Boolean,
      status: Schema.Literals(["active", "stopped", "expired"]),
      expiresAt: Schema.String,
      cursor: Schema.String,
    }),
  ),
});
export type McpEventSubscriptionsResult = typeof McpEventSubscriptionsResult.Type;

export const McpEventWatch = Schema.Struct({
  callbackGroup: Schema.String,
  callbackOrigin: Schema.String,
  subscriptionIds: Schema.Array(Schema.String),
  soonestExpiry: Schema.String,
});

export const McpEventSubscriptionResult = Schema.Struct({
  id: Schema.String,
  refreshBefore: Schema.String,
  cursor: Schema.String,
  truncated: Schema.Boolean,
});

export const McpEventData = Schema.Struct({
  threadId: ThreadId,
  revision: Schema.Int,
  sourceEventType: Schema.String,
  sourceUrl: Schema.String,
  state: Schema.String,
  runId: Schema.optionalKey(Schema.String),
  resourceId: Schema.optionalKey(Schema.String),
  parentThreadId: Schema.NullOr(ThreadId),
  relationshipToParent: Schema.NullOr(Schema.Literals(["fork", "subagent"])),
});
export const McpEventEnvelope = Schema.Struct({
  eventId: Schema.String,
  name: McpEventName,
  timestamp: Schema.String,
  data: McpEventData,
  cursor: Schema.String,
});
export type McpEventEnvelope = typeof McpEventEnvelope.Type;

export class McpEventsError extends Schema.TaggedError<McpEventsError>()("McpEventsError", {
  code: Schema.Int,
  reason: Schema.String,
}) {
  override get message() {
    return "The MCP Events request could not be completed.";
  }
}

export const McpThreadNotify = Schema.Struct({
  events: Schema.optional(
    Schema.Array(McpEventName).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
  ),
});
export type McpThreadNotify = typeof McpThreadNotify.Type;
export const McpThreadNotifyResult = Schema.Struct({
  status: Schema.Literals(["bound", "subscribed", "unavailable", "failed"]),
  refreshBefore: Schema.optional(Schema.String),
  inboxThreadId: Schema.optional(ThreadId),
  relay: Schema.optional(Schema.String),
  subscriptionIds: Schema.Array(Schema.String),
  reason: Schema.optional(Schema.String),
});
export type McpThreadNotifyResult = typeof McpThreadNotifyResult.Type;
