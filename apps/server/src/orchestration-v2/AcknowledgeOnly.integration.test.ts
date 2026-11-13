import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as McpEvents from "../mcp/McpEvents.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AcknowledgeOnly from "./AcknowledgeOnly.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const driver = ProviderDriverKind.make("claudeAgent");
const instanceId = ProviderInstanceId.make("claudeAgent");
const modelSelection = { instanceId, model: "claude-test" };
const threadId = ThreadId.make("thread:acknowledge-only-inbox");
const otherInbox = ThreadId.make("thread:another-inbox");

const messages = [
  "First request for Jarvis",
  "Second request",
  `Third request\nwith a second line and ${"padding ".repeat(20)}to pass the excerpt limit`,
];

// The Jarvis inbox: each message ends in a run whose result wakes Jarvis, without a model call.
it.effect("an acknowledge-only thread answers queued messages in order without a provider", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("acknowledge-only-inbox");
      let sessionsOpened = 0;
      const turns: Array<ProviderAdapter.ProviderAdapterV2TurnInput> = [];
      const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.gen(function* () {
            sessionsOpened += 1;
            const now = yield* DateTime.now;
            const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
            return {
              instanceId,
              driver,
              providerSessionId: input.providerSessionId,
              providerSession: {
                id: input.providerSessionId,
                driver,
                providerInstanceId: instanceId,
                status: "ready",
                cwd,
                model: modelSelection.model,
                capabilities: ClaudeProviderCapabilitiesV2,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.fromQueue(events),
              ensureThread: ({ threadId: appThreadId }) =>
                Effect.succeed({
                  id: ProviderThreadId.make(`provider-thread:${appThreadId}`),
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: input.providerSessionId,
                  appThreadId,
                  ownerNodeId: null,
                  nativeThreadRef: {
                    driver,
                    nativeId: `native:${appThreadId}`,
                    strength: "strong",
                  },
                  nativeConversationHeadRef: null,
                  status: "idle",
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                }),
              resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
              startTurn: (turn) =>
                Effect.gen(function* () {
                  turns.push(turn);
                  yield* Queue.offer(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: {
                      id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                      providerThreadId: turn.providerThread.id,
                      nodeId: turn.rootNodeId,
                      runAttemptId: turn.attemptId,
                      nativeTurnRef: null,
                      ordinal: turn.providerTurnOrdinal,
                      status: "running",
                      startedAt: now,
                      completedAt: null,
                    },
                  });
                }),
              steerTurn: () => Effect.die("unused"),
              interruptTurn: () => Effect.void,
              respondToRuntimeRequest: () => Effect.die("unused"),
              readThreadSnapshot: () => Effect.die("unused"),
              rollbackThread: () => Effect.die("unused"),
              forkThread: () => Effect.die("unused"),
            };
          }),
      };
      const settingsLayer = ServerSettings.layerTest({
        acknowledgeOnlyThreadIds: [otherInbox],
      }).pipe(Layer.orDie);
      const layerTest = Layer.merge(
        ProviderReplayHarness.layerWithRegistry(
          { name: "acknowledge-only-inbox" },
          ProviderAdapterRegistry.layerSingle(adapter),
          { settingsLayer, runEffectWorker: false },
        ),
        settingsLayer,
      ).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const settings = yield* ServerSettings.ServerSettingsService;
        const send = (index: number, text: string) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`send-${index}`),
            threadId,
            messageId: MessageId.make(`message:inbox-${index}`),
            text,
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "agent",
            creationSource: "mcp",
          });

        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create-inbox"),
          threadId,
          projectId: ProjectId.make("project:acknowledge-only"),
          title: "Jarvis inbox",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        yield* AcknowledgeOnly.setAcknowledgeOnly(threadId, true);
        assert.deepEqual((yield* settings.getSettings).acknowledgeOnlyThreadIds, [
          otherInbox,
          threadId,
        ]);
        const settled = yield* eventSink
          .stream({
            threadId,
            afterSequence: yield* eventSink.latestSequence(),
            eventType: "run.updated",
          })
          .pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "run.updated" && stored.event.payload.status === "completed",
            ),
            Stream.take(messages.length),
            Stream.runCollect,
            Effect.forkScoped,
          );
        yield* Effect.forEach(messages, (text, index) => send(index, text), { discard: true });
        // Started after the sends, so the later messages wait in the queue.
        yield* EffectWorker.runDaemon.pipe(Effect.forkScoped);
        const results = Array.from(yield* Fiber.join(settled));

        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(sessionsOpened, 0);
        assert.deepEqual(turns, []);
        assert.deepEqual(projection.providerSessions, []);
        assert.deepEqual(projection.providerTurns, []);
        const runs = projection.runs.toSorted((left, right) => left.ordinal - right.ordinal);
        const replies = runs.map((run) => ({
          request: projection.messages.find((message) => message.id === run.userMessageId)?.text,
          // What the inbox relay quotes: the run's last assistant message.
          reply: projection.messages
            .filter((message) => message.runId === run.id && message.role === "assistant")
            .at(-1)?.text,
        }));
        assert.deepEqual(replies, [
          { request: messages[0], reply: "Queued for Jarvis: First request for Jarvis" },
          { request: messages[1], reply: "Queued for Jarvis: Second request" },
          {
            request: messages[2],
            reply: `Queued for Jarvis: ${Array.from(messages[2]!.replace(/\s+/g, " "))
              .slice(0, 120)
              .join("")}…`,
          },
        ]);
        // Completions arrive in send order, each the event that wakes an inbox subscription.
        expect(
          results.map((stored) => McpEvents.observeEvent(stored, projection.thread, "t3://inbox")),
        ).toEqual(
          runs.map((run) =>
            expect.objectContaining({
              name: "thread.run.result",
              data: expect.objectContaining({ runId: run.id, state: "completed" }),
            }),
          ),
        );
        const lifecycle = yield* eventSink.stream({ threadId, afterSequence: 0 }).pipe(
          Stream.takeUntil((stored) => stored.sequence >= results.at(-1)!.sequence),
          Stream.runCollect,
        );
        expect(
          runs.map((run) =>
            Array.from(lifecycle).flatMap(({ event }) =>
              (event.type === "run.created" || event.type === "run.updated") &&
              event.payload.id === run.id
                ? [`${event.type}:${event.payload.status}`]
                : [],
            ),
          ),
        ).toEqual([
          ["run.created:starting", "run.updated:running", "run.updated:completed"],
          ...[1, 2].map(() => [
            "run.created:queued",
            "run.updated:starting",
            "run.updated:running",
            "run.updated:completed",
          ]),
        ]);

        // Off again, the next message is an ordinary provider turn.
        yield* AcknowledgeOnly.setAcknowledgeOnly(threadId, false);
        assert.deepEqual((yield* settings.getSettings).acknowledgeOnlyThreadIds, [otherInbox]);
        const turnStarted = yield* eventSink
          .stream({
            threadId,
            afterSequence: yield* eventSink.latestSequence(),
            eventType: "provider-turn.updated",
          })
          .pipe(Stream.take(1), Stream.runDrain, Effect.forkScoped);
        yield* send(3, "Answer this one yourself");
        yield* Fiber.join(turnStarted);
        assert.equal(sessionsOpened, 1);
        assert.equal(turns.length, 1);
        assert.include(JSON.stringify(turns[0]), "Answer this one yourself");
      }).pipe(Effect.provide(layerTest));
    }),
  ),
);
