import {
  CommandId,
  OrchestratorMcpFailure,
  type ThreadFreeze,
  type ThreadFreezeActor,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { ThreadFreezeGate } from "../orchestration-v2/ThreadFreeze.ts";
import { type McpInvocationScope, messageSenderFor } from "./McpInvocationContext.ts";
import { assertLiveCaller, dispatchFailure, newCommandId, readThread } from "./threadAccess.ts";

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/** The caller's identity from the authenticated scope, never from a tool argument. */
const freezeActor = (scope: McpInvocationScope, label: string): ThreadFreezeActor => {
  const sender = messageSenderFor(scope).senderClient;
  if (sender !== undefined) {
    return {
      kind: sender.kind,
      label: sender.clientLabel.slice(0, 128),
      sessionId: sender.sessionId,
    };
  }
  return scope.thread === undefined
    ? { kind: "unknown", label: label.slice(0, 128) }
    : { kind: "agent", label: label.slice(0, 128), threadId: scope.thread.threadId };
};

const nowIso = Effect.map(Clock.currentTimeMillis, (ms) =>
  DateTime.formatIso(DateTime.makeUnsafe(ms)),
);

/**
 * Freeze records the marker first, so nothing starts while the stop lands, then does what
 * `t3_thread_interrupt` with `stop` does: interrupt the run, hold the queue, stop delegated tasks.
 * It checks its caller as interrupt does. A thread may freeze itself, and then cannot lift it.
 */
export const freezeThread = Effect.fn("mcp.freezeThread")(function* (input: {
  readonly threadId?: Parameters<typeof readThread>[0];
  readonly reason: string | undefined;
}) {
  const reason = input.reason?.trim() ?? "";
  if (reason.length === 0) return yield* invalid("freeze needs a `reason`.");
  const { projection, ...context } = yield* readThread(input.threadId, ["runs"]);
  const { threads, scope, caller } = context;
  yield* assertLiveCaller(context);
  const threadId = projection.thread.id;
  const queuedMessages = projection.runs.filter((run) => run.status === "queued").length;
  const existing = projection.thread.frozen ?? null;
  const freeze: ThreadFreeze = existing ?? {
    at: yield* nowIso,
    by: freezeActor(scope, caller?.title ?? "Unknown caller"),
    reason: reason.slice(0, 500),
  };
  const base = yield* newCommandId();
  if (existing === null) {
    yield* threads
      .dispatch({ type: "thread.metadata.update", commandId: base, threadId, frozen: freeze })
      .pipe(
        Effect.provideService(ThreadFreezeGate, { op: "freeze" }),
        Effect.mapError(dispatchFailure),
      );
  }
  const stopReason = `Frozen by ${freeze.by.label}: ${freeze.reason}`;
  const stopId = CommandId.make(`${base}:stop`);
  const stopped = yield* threads
    .dispatch({ type: "thread.stop", commandId: stopId, threadId, reason: stopReason })
    .pipe(Effect.mapError(dispatchFailure));
  yield* threads
    .stopDelegatedTasks({ threadId, commandId: stopId, reason: stopReason })
    .pipe(Effect.mapError(dispatchFailure));
  const interrupted = stopped.storedEvents.find(
    ({ event }) =>
      (event.type === "run.updated" && event.payload.status === "interrupted") ||
      (event.type === "turn-item.updated" &&
        event.payload.type === "run_interrupt_request" &&
        event.payload.providerTurnId !== null),
  )?.event.runId;
  return {
    frozen: true as const,
    freeze,
    interruptedRunId: interrupted ?? null,
    queuedMessages,
  };
});

/**
 * Unfreeze is one `queue.resume` that lifts the marker and releases the queue together, so a
 * refused resume (a usage limit, say) leaves the thread frozen and the call can be repeated.
 * The frozen thread or a delegate of it cannot call it.
 */
export const unfreezeThread = Effect.fn("mcp.unfreezeThread")(function* (input: {
  readonly threadId?: Parameters<typeof readThread>[0];
  readonly freshContext: boolean | undefined;
}) {
  const { projection, ...context } = yield* readThread(input.threadId, ["runs"]);
  const { threads, scope, caller } = context;
  yield* assertLiveCaller(context);
  const threadId = projection.thread.id;
  if (caller?.id === threadId || scope.thread?.subagent === true) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message:
        "A frozen thread or a delegate of it cannot unfreeze it; the operator or its coordinator must.",
    });
  }
  if (projection.thread.frozen == null) {
    return { frozen: false as const, wasFrozen: false as const, queuedMessages: 0 };
  }
  const held = projection.runs.filter((run) => run.status === "queued").length;
  if (input.freshContext === true && held > 0) {
    return yield* invalid(
      `${held} queued message${held === 1 ? "" : "s"} would start first on the old context. Cancel them with t3_queue, or unfreeze without freshContext.`,
    );
  }
  yield* threads
    .dispatch({ type: "queue.resume", commandId: yield* newCommandId(), threadId })
    .pipe(
      Effect.provideService(ThreadFreezeGate, {
        op: "unfreeze",
        by: freezeActor(scope, caller?.title ?? "Unknown caller"),
        at: yield* nowIso,
        freshContext: input.freshContext === true,
      }),
      Effect.mapError(dispatchFailure),
    );
  return {
    frozen: false as const,
    wasFrozen: true as const,
    queuedMessages: held,
    ...(input.freshContext === true ? { freshContextNext: true as const } : {}),
  };
});
