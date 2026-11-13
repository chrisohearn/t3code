import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as EventStore from "./EventStore.ts";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import { CommandActor } from "./CommandActor.ts";
import { ThreadFreezeGate } from "./ThreadFreeze.ts";
import * as SnoozeDeferredDelivery from "./SnoozeDeferredDelivery.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      EventStore.layer.pipe(Layer.provide(layerDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "thread-freeze" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
);

const threadId = (name: string) => ThreadId.make(`thread:freeze:${name}`);
const freezeRecord = {
  at: "2026-11-13T00:00:00.000Z",
  by: { kind: "outside-client", label: "Codex", sessionId: "963da7fc" },
  reason: "misbehaving inbox agent",
} as const;

const create = (id: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${id}`),
      threadId: id,
      projectId: ProjectId.make("project:thread-freeze"),
      title: id,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

const send = (
  id: ThreadId,
  text: string,
  options: {
    readonly mode?: "start_immediately" | "queue_after_active";
    readonly by?: "user" | "agent";
    readonly deliveryIntent?: "auto" | "steer" | "restart";
    readonly freshContext?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${id}:${text}`),
      threadId: id,
      messageId: MessageId.make(`message:${id}:${text}`),
      text,
      attachments: [],
      dispatchMode: { type: options.mode ?? "start_immediately" },
      ...(options.deliveryIntent === undefined ? {} : { deliveryIntent: options.deliveryIntent }),
      ...(options.freshContext === true ? { freshContext: true } : {}),
      createdBy: options.by ?? "user",
      creationSource: options.by === "agent" ? "mcp" : "web",
    });
  });

const freeze = (id: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator
      .dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`freeze:${id}`),
        threadId: id,
        frozen: freezeRecord,
      })
      .pipe(Effect.provideService(ThreadFreezeGate, { op: "freeze" }));
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make(`freeze-stop:${id}`),
      threadId: id,
      reason: "Frozen",
    });
  });

const state = (id: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projection = yield* orchestrator.getThreadProjection(id);
    return {
      frozen: projection.thread.frozen?.by.sessionId ?? null,
      runs: projection.runs.map((run) => `${run.status}${run.queueHeld === true ? ":held" : ""}`),
      projection,
    };
  });

const asActor = <A, E, R>(kind: "owner_client" | "agent", effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, CommandActor, { kind });
const asActorEffect =
  (kind: "owner_client" | "agent") =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    asActor(kind, effect);

it.effect(
  "a freeze stops the run, holds the queue and the delegates, and records who froze it",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const id = threadId("stop");
      yield* create(id);
      yield* send(id, "first");
      yield* send(id, "second", { mode: "queue_after_active" });
      const parentRun = (yield* orchestrator.getThreadProjection(id)).runs[0]!;
      yield* orchestrator.dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make("freeze:delegate"),
        parentThreadId: id,
        parentRunId: parentRun.id,
        parentNodeId: parentRun.rootNodeId!,
        task: "child task",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        completionWake: "always",
        createdBy: "agent",
        creationSource: "mcp",
      });
      const childId = (yield* orchestrator.getThreadProjection(id)).subagents[0]!.childThreadId!;

      yield* freeze(id);
      yield* threads.stopDelegatedTasks({
        threadId: id,
        commandId: CommandId.make(`freeze-stop:${id}`),
      });

      const parent = yield* state(id);
      assert.equal(parent.frozen, "963da7fc");
      assert.equal(parent.projection.thread.frozen?.reason, "misbehaving inbox agent");
      assert.deepEqual(parent.runs, ["interrupted", "queued:held"]);
      assert.deepEqual((yield* state(childId)).runs, ["interrupted"]);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("a frozen thread holds every send; only an owner client lifts the freeze", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const id = threadId("sends");
    yield* create(id);
    yield* send(id, "first");
    yield* freeze(id);
    assert.deepEqual((yield* state(id)).runs, ["interrupted"]);

    // Idle and frozen: an agent's send and a restart-mode send queue held instead of starting.
    yield* send(id, "agent", { by: "agent" });
    yield* send(id, "restart", { by: "agent", deliveryIntent: "restart" });
    assert.deepEqual((yield* state(id)).runs, ["interrupted", "queued:held", "queued:held"]);

    const resume = (key: string) =>
      orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make(`freeze:resume:${key}`),
        threadId: id,
      });
    const refused = yield* asActor("agent", resume("agent")).pipe(Effect.flip);
    assert.include(String("cause" in refused ? refused.cause : refused), "frozen");
    const outside = yield* resume("outside").pipe(Effect.flip);
    assert.include(String("cause" in outside ? outside.cause : outside), "frozen");
    assert.equal((yield* state(id)).frozen, "963da7fc");

    // A raw command cannot set, replace or clear the marker.
    const forged = yield* orchestrator
      .dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("freeze:forge"),
        threadId: id,
        frozen: { ...freezeRecord, by: { kind: "owner", label: "Chris" } },
      })
      .pipe(asActorEffect("owner_client"), Effect.flip);
    assert.include(String("cause" in forged ? forged.cause : forged), "t3_thread_organize");
    assert.equal((yield* state(id)).frozen, "963da7fc");

    yield* asActor("owner_client", send(id, "human"));
    const after = yield* state(id);
    assert.equal(after.frozen, null);
    assert.equal(after.projection.thread.unfrozen?.by.kind, "owner");
    assert.notInclude(after.runs.slice(1), "queued:held");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("unfreeze with freshContext starts only the next message fresh", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const id = threadId("fresh");
    yield* create(id);
    yield* send(id, "first");
    yield* freeze(id);
    yield* orchestrator
      .dispatch({
        type: "queue.resume",
        commandId: CommandId.make("freeze:unfreeze"),
        threadId: id,
      })
      .pipe(
        Effect.provideService(ThreadFreezeGate, {
          op: "unfreeze",
          by: { kind: "agent", label: "Coordinator" },
          at: "2026-11-13T01:00:00.000Z",
          freshContext: true,
        }),
      );
    const lifted = yield* state(id);
    assert.equal(lifted.frozen, null);
    assert.equal(lifted.projection.thread.unfrozen?.by.label, "Coordinator");

    yield* send(id, "next");
    yield* send(id, "later", { mode: "queue_after_active" });
    const { projection } = yield* state(id);
    const byText = (text: string) =>
      projection.runs.find(
        (run) => projection.messages.find((m) => m.id === run.userMessageId)?.text === text,
      );
    assert.equal(byText("next")?.freshContext, true);
    assert.equal(byText("later")?.freshContext, undefined);
    assert.equal(projection.thread.nextTurnFreshContext, false);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "repeat deliveries to a frozen thread are all held, and a never-run thread starts on unfreeze",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const id = threadId("held");
      yield* create(id);
      yield* send(id, "first");
      yield* freeze(id);
      // Each delivery carries its own content, so each is kept: sendToThread needs the message back.
      for (const key of ["one", "two"]) {
        const result = yield* threads.sendToThread({
          projectId: ProjectId.make("project:thread-freeze"),
          commandId: CommandId.make(`webhook:${id}:${key}`),
          threadId: id,
          messageId: MessageId.make(`message:${id}:${key}`),
          scheduledTaskId: ScheduledTaskId.make("task:webhook"),
          text: `payload ${key}`,
          attachments: [],
          mode: "auto",
          createdBy: "agent",
          creationSource: "server",
        });
        assert.equal(result.delivery, "queued");
        assert.equal(result.run.queueHeld, true);
      }
      assert.deepEqual((yield* state(id)).runs, ["interrupted", "queued:held", "queued:held"]);

      const never = threadId("never");
      yield* create(never);
      yield* orchestrator
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("freeze:never"),
          threadId: never,
          frozen: freezeRecord,
        })
        .pipe(Effect.provideService(ThreadFreezeGate, { op: "freeze" }));
      const held = yield* threads.sendToThread({
        projectId: ProjectId.make("project:thread-freeze"),
        commandId: CommandId.make("send:never:waiting"),
        threadId: never,
        messageId: MessageId.make("message:never:waiting"),
        text: "waiting",
        attachments: [],
        mode: "auto",
        createdBy: "agent",
        creationSource: "mcp",
      });
      assert.equal(held.delivery, "queued");
      assert.deepEqual((yield* state(never)).runs, ["queued:held"]);

      yield* orchestrator
        .dispatch({
          type: "queue.resume",
          commandId: CommandId.make("freeze:never:unfreeze"),
          threadId: never,
        })
        .pipe(
          Effect.provideService(ThreadFreezeGate, {
            op: "unfreeze",
            by: { kind: "agent", label: "Coordinator" },
            at: "2026-11-13T01:00:00.000Z",
            freshContext: false,
          }),
        );
      const started = yield* state(never);
      assert.equal(started.frozen, null);
      assert.notInclude(started.runs[0], "queued");
    }).pipe(Effect.provide(layerTest)),
);

it.effect("a freeze and a snooze each keep their own holds", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const id = threadId("snoozed");
    yield* create(id);
    yield* send(id, "first");
    yield* freeze(id);
    yield* orchestrator.dispatch({
      type: "thread.snooze",
      commandId: CommandId.make(`snooze:${id}`),
      threadId: id,
      snoozedUntil: "2099-01-01T00:00:00.000Z",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${id}:agent`),
      threadId: id,
      messageId: MessageId.make(`message:${id}:agent`),
      text: "agent",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      respectSnooze: true,
      createdBy: "agent",
      creationSource: "mcp",
    });
    const heldRun = () =>
      state(id).pipe(
        Effect.map(({ projection }) =>
          projection.runs.find((run) => run.userMessageId === `message:${id}:agent`),
        ),
      );
    assert.include(yield* heldRun(), { status: "queued", queueHeld: true, snoozeDeferred: true });
    // The snooze sweep leaves a frozen thread to its unfreeze.
    assert.deepEqual(
      (yield* SnoozeDeferredDelivery.readSnoozeDeferredThreads()).filter(
        (row) => row.threadId === id,
      ),
      [],
    );

    // Unfreezing resumes the queue, but the thread still sleeps: the snooze's hold stays.
    yield* orchestrator
      .dispatch({
        type: "queue.resume",
        commandId: CommandId.make(`unfreeze:${id}`),
        threadId: id,
      })
      .pipe(
        Effect.provideService(ThreadFreezeGate, {
          op: "unfreeze",
          by: { kind: "agent", label: "Coordinator" },
          at: "2026-11-13T01:00:00.000Z",
          freshContext: false,
        }),
      );
    assert.equal((yield* state(id)).frozen, null);
    assert.include(yield* heldRun(), { status: "queued", queueHeld: true, snoozeDeferred: true });

    // Awake, the sweep's resume releases it.
    yield* orchestrator.dispatch({
      type: "thread.unsnooze",
      commandId: CommandId.make(`unsnooze:${id}`),
      threadId: id,
      reason: "user",
    });
    yield* orchestrator.dispatch({
      type: "queue.resume",
      commandId: CommandId.make(`snooze-release:${id}`),
      threadId: id,
    });
    const released = yield* heldRun();
    assert.notEqual(released?.queueHeld, true);
    assert.isUndefined(released?.snoozeDeferred);
  }).pipe(Effect.provide(layerTest)),
);
