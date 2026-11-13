import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  OrchestrationV2RunStop,
  OrchestrationV2RunStopActorKind,
  OrchestrationV2RunStopReason,
  RunId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { CommandActor } from "./CommandActor.ts";

/** The command a batch of events is committed for, when the writer has one. */
export interface RunStopContext {
  readonly commandType?: string | undefined;
  readonly commandId?: string | undefined;
}

const STOPPED: ReadonlySet<OrchestrationV2Run["status"]> = new Set(["cancelled", "interrupted"]);
const FINISHED: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
// A run back in the queue or retrying its start is no longer stopped.
const REVIVED: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "queued",
  "preparing",
  "starting",
]);
const STOP_COMMANDS = new Set(["thread.stop", "run.interrupt", "subagent.stop"]);
const SUPERSEDED_COMMAND_ID = /^(command:system:stale-question:|server:delegated-task-question)/;

export function runStopReason(context: RunStopContext): OrchestrationV2RunStopReason {
  const commandId = context.commandId ?? "";
  switch (context.commandType) {
    case "provider-runtime.reconcile":
      return commandId.startsWith("command:runtime-reconcile:shutdown:")
        ? "server_shutdown"
        : "server_restart";
    case "thread.stop":
    case "run.interrupt":
    case "subagent.stop":
    case "thread.interrupt.unresponsive":
    case "thread.background-work.settle":
      return "stopped";
    case "queued-run.cancel":
      return SUPERSEDED_COMMAND_ID.test(commandId) ? "superseded" : "queue_cancelled";
    case "queued-message.promote-to-steer":
      return "steered";
    case "message.dispatch":
      return "replaced";
    case "thread.archive":
      return "thread_archived";
    case "thread.settle":
    case "thread.auto-settle":
      return "thread_settled";
    case "thread.delete":
      return "thread_deleted";
    case "checkpoint.rollback":
    case "checkpoint.rollback-requested":
      return "rolled_back";
    default:
      return "other";
  }
}

/**
 * Who stopped a run. Transports provide the actor for the commands they receive; a write without
 * one came from the server itself (reconciliation, reactors, the effect worker) or a bot session.
 */
const runStopFor = Effect.fnUntraced(function* (
  context: RunStopContext,
  reason: OrchestrationV2RunStopReason = runStopReason(context),
) {
  const actor = yield* Effect.serviceOption(CommandActor);
  const commandType = context.commandType === undefined ? {} : { commandType: context.commandType };
  if (Option.isNone(actor)) {
    return { reason, actor: { kind: "server" }, ...commandType } satisfies OrchestrationV2RunStop;
  }
  const { kind, client, caller } = actor.value;
  const sessionId = client?.sessionId ?? caller?.sessionId;
  const clientLabel = client?.clientLabel ?? caller?.clientLabel;
  return {
    reason,
    actor: {
      kind,
      ...(sessionId === undefined ? {} : { sessionId: sessionId.slice(0, 8) }),
      ...(clientLabel === undefined ? {} : { clientLabel }),
      ...(caller?.threadId === undefined ? {} : { threadId: caller.threadId }),
    },
    ...commandType,
  } satisfies OrchestrationV2RunStop;
});

/**
 * Stamps `stop` on each run that enters cancelled or interrupted in this batch. A provider confirms
 * a requested stop outside any command, so the request's stop is held here until that write.
 */
export const makeRunStopStamper = <E, R>(
  storedRun: (run: OrchestrationV2Run) => Effect.Effect<OrchestrationV2Run | undefined, E, R>,
) => {
  const requested = new Map<RunId, OrchestrationV2RunStop>();
  const remember = (runId: RunId, stop: OrchestrationV2RunStop) => {
    requested.delete(runId);
    requested.set(runId, stop);
    // Requests the provider never confirms (a crash) are reconciled with their own reason.
    if (requested.size > 1024) requested.delete(requested.keys().next().value!);
  };

  return Effect.fnUntraced(function* (
    events: ReadonlyArray<OrchestrationV2DomainEvent>,
    context: RunStopContext,
  ) {
    if (STOP_COMMANDS.has(context.commandType ?? "")) {
      for (const event of events) {
        if (event.type === "turn-item.updated" && event.payload.type === "run_interrupt_request") {
          if (event.payload.runId !== null) {
            remember(event.payload.runId, yield* runStopFor(context));
          }
        }
      }
    }
    const stamped: Array<OrchestrationV2DomainEvent> = [];
    for (const event of events) {
      if (event.type !== "run.updated") {
        stamped.push(event);
        continue;
      }
      const run = event.payload;
      if (REVIVED.has(run.status) && run.stop !== undefined) {
        const { stop: _cleared, ...revived } = run;
        stamped.push({ ...event, payload: revived });
        continue;
      }
      if (!STOPPED.has(run.status) || run.stop !== undefined) {
        stamped.push(event);
        continue;
      }
      const before = yield* storedRun(run);
      // A later rewrite of an already finished run keeps the stop it had.
      if (before !== undefined && FINISHED.has(before.status)) {
        stamped.push(
          before.stop === undefined ? event : { ...event, payload: { ...run, stop: before.stop } },
        );
        continue;
      }
      // An interrupt written outside any command came from the provider or its runtime, unless a
      // Stop asked for it: the provider's confirmation and the worker's settle carry no actor.
      const reason =
        context.commandType === undefined && run.status === "interrupted"
          ? "provider_interrupted"
          : runStopReason(context);
      const pending =
        (reason === "stopped" || reason === "provider_interrupted" || reason === "other") &&
        Option.isNone(yield* Effect.serviceOption(CommandActor))
          ? requested.get(run.id)
          : undefined;
      requested.delete(run.id);
      const stop = pending ?? (yield* runStopFor(context, reason));
      stamped.push({ ...event, payload: { ...run, stop } });
    }
    return stamped;
  });
};

const REASON_TEXT: Record<OrchestrationV2RunStopReason, string> = {
  server_shutdown: "cancelled by restart",
  server_restart: "cancelled by restart",
  stopped: "stopped",
  provider_interrupted: "interrupted by the provider",
  queue_cancelled: "removed from the queue before it started",
  steered: "delivered into the running turn instead",
  replaced: "replaced by a newer message",
  superseded: "superseded by a newer wake",
  thread_archived: "cancelled because the thread was archived",
  thread_settled: "cancelled because the thread was settled",
  thread_deleted: "cancelled because the thread was deleted",
  rolled_back: "cancelled by a rollback",
  other: "cancelled",
};

const ACTOR_TEXT: Record<OrchestrationV2RunStopActorKind, string> = {
  owner_client: "the user",
  mcp_client: "an MCP client",
  agent: "an agent",
  server: "the server",
};
// Rows a newer build wrote can hold reasons and actors this build does not know.
const reasonText = new Map<string, string>(Object.entries(REASON_TEXT));
const actorText = new Map<string, string>(Object.entries(ACTOR_TEXT));

/** One line that says why a run stopped and where its work went, for thread reads. */
export function runStopLabel(input: {
  readonly status?: OrchestrationV2Run["status"];
  readonly stop: OrchestrationV2RunStop | undefined;
  readonly continuedAs: Pick<OrchestrationV2Run, "id" | "ordinal"> | undefined;
}): string {
  const { stop, continuedAs } = input;
  // A finished or waiting run a restart continued lost only background work it left running.
  const reason =
    input.status !== undefined && !STOPPED.has(input.status)
      ? `${input.status}; its background work was cut short by restart`
      : stop === undefined
        ? continuedAs === undefined
          ? "stopped; no reason was recorded"
          : "cut short by restart"
        : (reasonText.get(stop.reason) ?? stop.reason.replaceAll("_", " "));
  const actor =
    stop === undefined ||
    stop.reason === "server_shutdown" ||
    stop.reason === "server_restart" ||
    stop.actor.kind === "server"
      ? ""
      : ` by ${actorText.get(stop.actor.kind) ?? stop.actor.kind}${stop.actor.sessionId === undefined ? "" : ` (session ${stop.actor.sessionId})`}${stop.actor.threadId === undefined ? "" : ` from thread ${stop.actor.threadId}`}`;
  return continuedAs === undefined
    ? `${reason}${actor}`
    : `${reason}${actor}, continued as run ${continuedAs.ordinal}`;
}

/**
 * Runs a restart can continue: cancelled ones, and finished ones whose background work it cut.
 * Reads look for a continuation only for these, so every read reports the same thing.
 */
export function mayHaveRestartContinuation(
  run: Pick<OrchestrationV2Run, "status" | "restartCancelledBackgroundWork">,
): boolean {
  return run.status === "cancelled" || (run.restartCancelledBackgroundWork?.length ?? 0) > 0;
}

/** Shown on a cancelled or interrupted run, or one a restart continued. */
export function runStopDetail(run: OrchestrationV2Run, runs: ReadonlyArray<OrchestrationV2Run>) {
  const continuedAs = mayHaveRestartContinuation(run)
    ? runs.find((candidate) => candidate.restartContinuationOfRunId === run.id)
    : undefined;
  if (!STOPPED.has(run.status) && continuedAs === undefined) return undefined;
  return {
    ...run.stop,
    ...(continuedAs === undefined ? {} : { continuedAsRunId: continuedAs.id }),
    label: runStopLabel({ status: run.status, stop: run.stop, continuedAs }),
  };
}

/** For server writes made outside a command, which the stamper cannot attribute by type. */
export const serverRunStop = (reason: OrchestrationV2RunStopReason): OrchestrationV2RunStop => ({
  reason,
  actor: { kind: "server" },
});
