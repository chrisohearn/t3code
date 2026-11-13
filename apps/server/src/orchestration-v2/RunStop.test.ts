import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { CommandActor } from "./CommandActor.ts";
import { makeRunStopStamper, runStopDetail, runStopReason } from "./RunStop.ts";

const threadId = ThreadId.make("thread:run-stop");
const now = DateTime.makeUnsafe("2026-11-13T01:02:22.000Z");
const instanceId = ProviderInstanceId.make("codex");

const run = (ordinal: number, patch: Partial<OrchestrationV2Run> = {}): OrchestrationV2Run => ({
  id: RunId.make(`run:${ordinal}`),
  threadId,
  ordinal,
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "gpt-5.1-codex" },
  providerThreadId: null,
  userMessageId: MessageId.make(`message:${ordinal}`),
  rootNodeId: null,
  activeAttemptId: null,
  status: "running",
  requestedAt: now,
  startedAt: now,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
  ...patch,
});

const runUpdated = (payload: OrchestrationV2Run): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:${payload.id}:${payload.status}`),
  type: "run.updated",
  threadId,
  runId: payload.id,
  occurredAt: now,
  payload,
});

const interruptRequest = (runId: RunId): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:${runId}:interrupt-request`),
  type: "turn-item.updated",
  threadId,
  runId,
  occurredAt: now,
  payload: {
    id: TurnItemId.make(`turn-item:${runId}:interrupt-request`),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: "Interrupt requested",
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "run_interrupt_request",
    message: "Stopped by user",
  },
});

const stopOf = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
  events.flatMap((event) => (event.type === "run.updated" ? [event.payload.stop] : []));

it.each([
  [
    {
      commandType: "provider-runtime.reconcile",
      commandId: "command:runtime-reconcile:shutdown:t:x",
    },
    "server_shutdown",
  ],
  [
    {
      commandType: "provider-runtime.reconcile",
      commandId: "command:runtime-reconcile:startup:t:x",
    },
    "server_restart",
  ],
  [{ commandType: "queued-run.cancel", commandId: "mcp-command" }, "queue_cancelled"],
  [
    { commandType: "queued-run.cancel", commandId: "server:delegated-task-question-cancel:t:r" },
    "superseded",
  ],
  [{ commandType: "queued-message.promote-to-steer" }, "steered"],
  [{ commandType: "thread.stop" }, "stopped"],
  [{ commandType: "thread.settle" }, "thread_settled"],
  [{ commandType: "thread.archive" }, "thread_archived"],
  [{ commandType: "thread.delete" }, "thread_deleted"],
  [{}, "other"],
] as const)("%j stops a run as %s", (context, reason) => {
  assert.equal(runStopReason(context), reason);
});

it.effect(
  "stamps the transition once and keeps a requested stop for the provider's confirmation",
  () =>
    Effect.gen(function* () {
      const stored = new Map<RunId, OrchestrationV2Run["status"]>();
      const stamp = makeRunStopStamper((candidate) => Effect.succeed(stored.get(candidate.id)));
      const owner = {
        kind: "owner_client" as const,
        client: { sessionId: "session1", clientLabel: "Chris's Mac" },
      };

      // Stop is requested in a command; the provider confirms later with no command.
      const stopping = run(1);
      stored.set(stopping.id, "running");
      yield* stamp([interruptRequest(stopping.id)], { commandType: "thread.stop" }).pipe(
        Effect.provideService(CommandActor, owner),
      );
      const confirmed = yield* stamp([runUpdated({ ...stopping, status: "interrupted" })], {});
      assert.deepEqual(stopOf(confirmed), [
        {
          reason: "stopped",
          actor: { kind: "owner_client", sessionId: "session1", clientLabel: "Chris's Mac" },
          commandType: "thread.stop",
        },
      ]);

      // A later rewrite of a finished run keeps what it had.
      stored.set(stopping.id, "interrupted");
      const rewritten = yield* stamp([runUpdated({ ...stopping, status: "interrupted" })], {
        commandType: "thread.archive",
      });
      assert.deepEqual(stopOf(rewritten), [undefined]);

      // A run the queue holds again is no longer stopped.
      const held = run(2, {
        status: "queued",
        startedAt: null,
        stop: { reason: "server_restart", actor: { kind: "server" } },
      });
      assert.deepEqual(stopOf(yield* stamp([runUpdated(held)], {})), [undefined]);
    }),
);

it("labels a restart cancel with the run that continued it", () => {
  const source = run(75, {
    status: "cancelled",
    stop: { reason: "server_shutdown", actor: { kind: "server" } },
  });
  const continuation = run(76, { restartContinuationOfRunId: source.id });
  assert.deepEqual(runStopDetail(source, [source, continuation]), {
    reason: "server_shutdown",
    actor: { kind: "server" },
    continuedAsRunId: continuation.id,
    label: "cancelled by restart, continued as run 76",
  });
  // Runs cancelled before reasons were recorded still read as continued work.
  const { stop: _none, ...legacy } = source;
  assert.equal(
    runStopDetail(legacy, [legacy, continuation])?.label,
    "cut short by restart, continued as run 76",
  );
  assert.equal(
    runStopDetail(
      run(74, {
        status: "cancelled",
        startedAt: null,
        stop: {
          reason: "queue_cancelled",
          actor: { kind: "agent", sessionId: "ab3aa7f5", threadId: ThreadId.make("mcp:8270") },
        },
      }),
      [],
    )?.label,
    "removed from the queue before it started by an agent (session ab3aa7f5) from thread mcp:8270",
  );
  assert.isUndefined(runStopDetail(run(77, { status: "completed" }), []));
});
