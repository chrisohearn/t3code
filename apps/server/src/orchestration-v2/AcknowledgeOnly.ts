import type {
  OrchestrationV2ContextHandoff,
  OrchestrationV2ConversationMessage,
  OrchestrationV2DomainEvent,
  OrchestrationV2ExecutionNode,
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  OrchestrationV2TurnItem,
  ServerSettings,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ProviderUsageAnalytics from "../telemetry/ProviderUsageAnalytics.ts";
import * as Settings from "../serverSettings.ts";
import type * as EventSink from "./EventSink.ts";

const EXCERPT_LENGTH = 120;

export const isAcknowledgeOnlyThread = (
  settings: Pick<ServerSettings, "acknowledgeOnlyThreadIds">,
  threadId: ThreadId,
): boolean => settings.acknowledgeOnlyThreadIds.includes(threadId);

export const setAcknowledgeOnly = Effect.fn("AcknowledgeOnly.set")(function* (
  threadId: ThreadId,
  enabled: boolean,
) {
  const settings = yield* Settings.ServerSettingsService;
  const current = (yield* settings.getSettings).acknowledgeOnlyThreadIds;
  if (current.includes(threadId) === enabled) return;
  yield* settings.updateSettings({
    acknowledgeOnlyThreadIds: enabled
      ? [...current, threadId]
      : current.filter((id) => id !== threadId),
  });
});

// Token prefixes and long opaque runs, as the update guard redacts them.
const SECRET_PATTERNS = [
  /(?:glpat-|gh[pousr]_|github_pat_|xox[abposr]-|sk-|AKIA|ASIA|AIza)[A-Za-z0-9_-]*/g,
  /[A-Za-z0-9+/=_-]{32,}/g,
];

/** Sender text becomes agent-authored output, so it is redacted and kept in a code span. */
const acknowledgementText = (message: string): string => {
  const line = SECRET_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, "[redacted]"),
    message.replace(/\s+/g, " ").trim(),
  ).replaceAll("`", "'");
  const characters = Array.from(line);
  if (characters.length === 0) return "Queued.";
  const excerpt = characters.slice(0, EXCERPT_LENGTH).join("");
  return `Queued: \`${characters.length > EXCERPT_LENGTH ? `${excerpt}…` : excerpt}\``;
};

/**
 * Completes a starting run with a written acknowledgement and no provider turn. It emits the
 * run lifecycle a provider turn would (running, then an assistant message, then completed), so
 * event subscriptions and relays see an ordinary run. No checkpoint is captured.
 */
export const settleAcknowledgeOnlyRun = Effect.fn("AcknowledgeOnly.settleRun")(function* (input: {
  readonly eventSink: EventSink.EventSinkV2["Service"];
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly run: OrchestrationV2Run;
  readonly attempt: OrchestrationV2RunAttempt;
  readonly rootNode: OrchestrationV2ExecutionNode;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly message: Pick<OrchestrationV2ConversationMessage, "text">;
  readonly nextTurnItemOrdinal: number;
  /** Handoffs addressed to this run; no provider reads them, so they are superseded. */
  readonly handoffs: ReadonlyArray<OrchestrationV2ContextHandoff>;
}) {
  const { run, attempt, rootNode, providerThread } = input;
  const now = yield* DateTime.now;
  const nativeItemId = `acknowledgement:${run.id}`;
  const itemIds = { driver: providerThread.driver, nativeItemId };
  const nodeId = input.idAllocator.derive.nodeFromProviderItem(itemIds);
  const messageId = input.idAllocator.derive.messageFromProviderItem(itemIds);
  const text = acknowledgementText(input.message.text);
  const assistantNode: OrchestrationV2ExecutionNode = {
    id: nodeId,
    threadId: run.threadId,
    runId: run.id,
    parentNodeId: rootNode.id,
    rootNodeId: rootNode.id,
    kind: "assistant_message",
    status: "completed",
    countsForRun: false,
    providerThreadId: providerThread.id,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt: now,
    completedAt: now,
  };
  const message: OrchestrationV2ConversationMessage = {
    createdBy: "agent",
    creationSource: "provider",
    id: messageId,
    threadId: run.threadId,
    runId: run.id,
    nodeId,
    role: "assistant",
    text,
    attachments: [],
    streaming: false,
    createdAt: now,
    updatedAt: now,
  };
  const turnItem: OrchestrationV2TurnItem = {
    id: input.idAllocator.derive.turnItemFromProviderItem(itemIds),
    threadId: run.threadId,
    runId: run.id,
    nodeId,
    providerThreadId: providerThread.id,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.nextTurnItemOrdinal,
    status: "completed",
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "assistant_message",
    messageId,
    text,
    streaming: false,
  };
  const running = { status: "running" as const, startedAt: now };
  const completed = { status: "completed" as const, startedAt: now, completedAt: now };
  const payloads = [
    { type: "run.updated", nodeId: rootNode.id, payload: { ...run, ...running } },
    { type: "run-attempt.updated", nodeId: rootNode.id, payload: { ...attempt, ...running } },
    { type: "node.updated", nodeId: rootNode.id, payload: { ...rootNode, ...running } },
    { type: "node.updated", nodeId, payload: assistantNode },
    { type: "message.updated", nodeId, payload: message },
    { type: "turn-item.updated", nodeId, payload: turnItem },
    ...input.handoffs.map(
      (handoff) =>
        ({
          type: "context-handoff.updated",
          nodeId: rootNode.id,
          payload: { ...handoff, status: "superseded", updatedAt: now },
        }) as const,
    ),
    { type: "run-attempt.updated", nodeId: rootNode.id, payload: { ...attempt, ...completed } },
    { type: "run.updated", nodeId: rootNode.id, payload: { ...run, ...completed } },
    { type: "node.updated", nodeId: rootNode.id, payload: { ...rootNode, ...completed } },
    {
      type: "provider-thread.updated",
      payload: {
        ...providerThread,
        status: providerThread.nativeThreadRef === null ? "not_loaded" : "idle",
        updatedAt: now,
      },
    },
  ] as const;
  const events = yield* Effect.forEach(payloads, (event) =>
    input.idAllocator.allocate.event({ threadId: run.threadId }).pipe(
      Effect.map(
        (id) =>
          ({
            ...event,
            id,
            threadId: run.threadId,
            runId: run.id,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
          }) satisfies OrchestrationV2DomainEvent,
      ),
    ),
  );
  const written = yield* input.eventSink.writeIfRunCurrent({
    threadId: run.threadId,
    runId: run.id,
    activeAttemptId: attempt.id,
    expectedStatus: "starting",
    events,
  });
  if (written.committed) {
    yield* (yield* ProviderUsageAnalytics.ProviderTurnAnalytics).runSettled({
      runId: run.id,
      status: "completed",
      completedAt: now,
      childrenRunning: false,
    });
  }
});
