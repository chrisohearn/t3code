import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2RunStop,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as QueuedSendCancelNotice from "./QueuedSendCancelNotice.ts";

const recipient = ThreadId.make("mcp:82704295");
const sender = ThreadId.make("4e3f096d");
const now = DateTime.makeUnsafe("2026-11-13T01:13:10.000Z");
const instanceId = ProviderInstanceId.make("codex");

const cancelled = (stop: OrchestrationV2RunStop): OrchestrationV2Run => ({
  id: RunId.make("run:78"),
  threadId: recipient,
  ordinal: 78,
  clientRequestId: "policy-6fd-review",
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "gpt-5.1-codex" },
  providerThreadId: null,
  userMessageId: MessageId.make("message:78"),
  rootNodeId: null,
  activeAttemptId: null,
  status: "cancelled",
  requestedAt: now,
  startedAt: null,
  completedAt: now,
  checkpointId: null,
  contextHandoffId: null,
  stop,
});

const notices = (
  run: OrchestrationV2Run,
  message: Partial<OrchestrationV2ConversationMessage> = {},
) =>
  Effect.gen(function* () {
    const dispatched: Array<OrchestrationV2Command> = [];
    const layer = QueuedSendCancelNotice.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            dispatch: (command) =>
              Effect.sync(() => {
                dispatched.push(command);
                return { sequence: 1, storedEvents: [] } as never;
              }),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getMessagesById: () =>
              Effect.succeed(
                new Map([
                  [
                    run.userMessageId,
                    {
                      id: run.userMessageId,
                      senderThreadId: sender,
                      ...message,
                    } as OrchestrationV2ConversationMessage,
                  ],
                ]),
              ),
          }),
        ),
      ),
    );
    yield* Effect.flatMap(QueuedSendCancelNotice.QueuedSendCancelNotice, (service) =>
      service.handle({
        id: EventId.make("event:cancel"),
        type: "run.updated",
        threadId: recipient,
        runId: run.id,
        occurredAt: now,
        payload: run,
      }),
    ).pipe(Effect.provide(layer));
    return dispatched;
  });

it.effect("tells the sender once when another thread's agent drops its queued message", () =>
  Effect.gen(function* () {
    const byRecipient = cancelled({
      reason: "queue_cancelled",
      actor: { kind: "agent", threadId: recipient },
    });
    const [notice, ...rest] = yield* notices(byRecipient);
    assert.isEmpty(rest);
    assert.equal(notice?.type, "message.dispatch");
    if (notice?.type !== "message.dispatch") return;
    assert.equal(notice.threadId, sender);
    assert.isTrue(notice.postOnly);
    // Stable ids make a repeated run update reuse the first notice's receipt.
    assert.equal(notice.commandId, "server:queued-send-cancelled:run:78");
    assert.equal(
      notice.text,
      "Your message to thread mcp:82704295 (run 78, request policy-6fd-review) was not delivered: it was removed from the queue before it started by an agent from thread mcp:82704295. Send it again if it is still needed.",
    );

    // The sender withdrew it, it was delivered as a steer, or it was a server wake.
    assert.isEmpty(
      yield* notices(
        cancelled({ reason: "queue_cancelled", actor: { kind: "agent", threadId: sender } }),
      ),
    );
    assert.isEmpty(
      yield* notices(
        cancelled({ reason: "steered", actor: { kind: "agent", threadId: recipient } }),
      ),
    );
    assert.isEmpty(
      yield* notices(byRecipient, {
        notification: { source: { kind: "monitor" }, outcome: "failed", summary: "checks failed" },
      }),
    );
  }),
);
