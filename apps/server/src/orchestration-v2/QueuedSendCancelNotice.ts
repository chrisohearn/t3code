import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RunStopReason,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { runStopLabel } from "./RunStop.ts";

/**
 * Tells an agent when a message it sent to another thread was cancelled before it ran, so a
 * sender never assumes delivery. The notice is posted, not queued: it informs without a turn.
 */
export class QueuedSendCancelNotice extends Context.Service<
  QueuedSendCancelNotice,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/QueuedSendCancelNotice") {}

// Delivered by another route, or a server wake that no sender is waiting on.
const DELIVERED_OR_REPLACED: ReadonlySet<string> = new Set([
  "steered",
  "superseded",
] satisfies ReadonlyArray<OrchestrationV2RunStopReason>);

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  const handle: QueuedSendCancelNotice["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (event.type !== "run.updated") return;
      const run = event.payload;
      const stop = run.stop;
      if (
        run.status !== "cancelled" ||
        run.startedAt !== null ||
        // A delegated task reports back to its parent through its own completion delivery.
        run.delegatedTaskId !== undefined ||
        stop === undefined ||
        DELIVERED_OR_REPLACED.has(stop.reason)
      ) {
        return;
      }
      const message = (yield* projections.getMessagesById(run.threadId, [run.userMessageId])).get(
        run.userMessageId,
      );
      const senderThreadId = message?.senderThreadId;
      if (
        message === undefined ||
        senderThreadId === undefined ||
        senderThreadId === run.threadId ||
        message.notification !== undefined ||
        // A sender that withdrew its own message already knows.
        stop.actor.threadId === senderThreadId
      ) {
        return;
      }
      const request = run.clientRequestId === undefined ? "" : `, request ${run.clientRequestId}`;
      yield* engine.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`server:queued-send-cancelled:${run.id}`),
        threadId: senderThreadId,
        messageId: MessageId.make(`message:queued-send-cancelled:${run.id}`),
        text: `Your message to thread ${run.threadId} (run ${run.ordinal}${request}) was not delivered: it was ${runStopLabel({ stop, continuedAs: undefined })}. Send it again if it is still needed.`,
        attachments: [],
        postOnly: true,
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("telling a sender its queued message was cancelled failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  const start: QueuedSendCancelNotice["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(engine.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("queued send cancel notice event stream failed", { cause }),
        ),
      ),
    );

  return { start, handle } satisfies QueuedSendCancelNotice["Service"];
});

export const layer = Layer.effect(QueuedSendCancelNotice, make);
