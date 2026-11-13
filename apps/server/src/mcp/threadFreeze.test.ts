import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { ThreadFreezeGate } from "../orchestration-v2/ThreadFreeze.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";
import { freezeThread, unfreezeThread } from "./threadFreeze.ts";

const target = ThreadId.make("thread:inbox");
const queuedRun = { id: RunId.make("run:queued"), status: "queued" } as OrchestrationV2Run;
const longLabel = "x".repeat(300);

const outside = (label = "Codex"): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("env"),
  requestNamespace: "ns",
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
  thread: undefined,
  client: { sessionId: "963da7fc-7a35-4939-b709-dfd27d40d323", label, access: "full-access" },
});
const asThread = (
  threadId: ThreadId,
  subagent = false,
): McpInvocationContext.McpInvocationScope => ({
  ...outside(),
  client: undefined,
  thread: {
    threadId,
    providerSessionId: "provider-session",
    providerInstanceId: McpToolAccessTestkit.liveThreadShell(threadId).providerInstanceId,
    ...(subagent ? { subagent: true } : {}),
  },
});

const harness = (options: {
  readonly frozen: boolean;
  readonly runs: Array<OrchestrationV2Run>;
}) => {
  const commands: Array<OrchestrationV2ServerCommand> = [];
  const stopped: Array<ThreadId> = [];
  const gates: Array<ThreadFreezeGate["Service"] | undefined> = [];
  const shell = McpToolAccessTestkit.liveThreadShell(target);
  const projection = McpToolAccessTestkit.idleThreadProjection(shell);
  const layer = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (id) => Effect.succeed(McpToolAccessTestkit.liveThreadShell(id)),
    getProjectThreadRecords: () =>
      Effect.succeed({
        ...projection,
        runs: options.runs,
        thread: {
          ...projection.thread,
          ...(options.frozen
            ? { frozen: { at: "t", by: { kind: "owner", label: "Chris" }, reason: "r" } }
            : {}),
        },
      }) as never,
    dispatch: (command) =>
      Effect.gen(function* () {
        commands.push(command);
        gates.push(Option.getOrUndefined(yield* Effect.serviceOption(ThreadFreezeGate)));
        return { sequence: 1, storedEvents: [], replayed: false } as never;
      }),
    stopDelegatedTasks: ({ threadId }) => Effect.sync(() => void stopped.push(threadId)),
  }).pipe(Layer.provideMerge(NodeCrypto.layer));
  const run = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    scope: McpInvocationContext.McpInvocationScope,
  ) =>
    effect.pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provide(layer),
    );
  return { commands, gates, stopped, run };
};

it.effect("freeze records the authenticated caller, then stops and holds", () => {
  const { commands, gates, stopped, run } = harness({ frozen: false, runs: [queuedRun] });
  return Effect.gen(function* () {
    const result = yield* run(
      freezeThread({ threadId: target, reason: " misbehaving " }),
      outside(longLabel),
    );
    expect(result).toMatchObject({ frozen: true, queuedMessages: 1 });
    expect(commands.map((command) => command.type)).toEqual([
      "thread.metadata.update",
      "thread.stop",
    ]);
    const marker = commands[0];
    expect(marker?.type === "thread.metadata.update" ? marker.frozen : undefined).toMatchObject({
      by: { kind: "outside-client", sessionId: "963da7fc", label: "x".repeat(128) },
      reason: "misbehaving",
    });
    expect(gates).toEqual([{ op: "freeze" }, undefined]);
    expect(stopped).toEqual([target]);
    const missing = yield* run(freezeThread({ threadId: target, reason: "  " }), outside()).pipe(
      Effect.flip,
    );
    expect(missing.code).toBe("invalid_request");
  });
});

it.effect("a frozen thread or its delegate cannot unfreeze it", () => {
  const { commands, run } = harness({ frozen: true, runs: [] });
  return Effect.gen(function* () {
    for (const scope of [asThread(target), asThread(ThreadId.make("thread:child"), true)]) {
      const refused = yield* run(
        unfreezeThread({ threadId: target, freshContext: undefined }),
        scope,
      ).pipe(Effect.flip);
      expect(refused.code).toBe("capability_denied");
    }
    expect(commands).toEqual([]);
  });
});

it.effect("unfreeze resumes the queue, and freshContext waits for an empty queue", () => {
  const queued = harness({ frozen: true, runs: [queuedRun] });
  const empty = harness({ frozen: true, runs: [] });
  return Effect.gen(function* () {
    const refused = yield* queued
      .run(unfreezeThread({ threadId: target, freshContext: true }), outside())
      .pipe(Effect.flip);
    expect(refused.message).toContain("1 queued message");
    expect(queued.commands).toEqual([]);

    expect(
      yield* queued.run(unfreezeThread({ threadId: target, freshContext: undefined }), outside()),
    ).toMatchObject({ frozen: false, wasFrozen: true, queuedMessages: 1 });
    expect(queued.commands.map((command) => command.type)).toEqual(["queue.resume"]);
    expect(queued.gates).toMatchObject([
      {
        op: "unfreeze",
        freshContext: false,
        by: { kind: "outside-client", sessionId: "963da7fc" },
      },
    ]);

    expect(
      yield* empty.run(unfreezeThread({ threadId: target, freshContext: true }), outside()),
    ).toMatchObject({ frozen: false, freshContextNext: true });
    expect(empty.commands.map((command) => command.type)).toEqual(["queue.resume"]);
    expect(empty.gates).toMatchObject([{ op: "unfreeze", freshContext: true }]);
  });
});
