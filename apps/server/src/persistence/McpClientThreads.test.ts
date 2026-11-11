import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sqlite from "./Sqlite.ts";
import * as McpClientThreads from "./McpClientThreads.ts";
it.effect("retains the original sign-in provenance when a launch is replayed", () =>
  Effect.gen(function* () {
    const repository = yield* McpClientThreads.McpClientThreads;
    const first = {
      threadId: ThreadId.make("thread"),
      sessionId: "session-a",
      clientLabel: "ChatGPT",
    };
    yield* repository.record(first);
    yield* repository.record({ ...first, sessionId: "session-b" });
    yield* repository.record({ ...first, threadId: ThreadId.make("other") });
    expect(yield* repository.list({ threadIds: [first.threadId] })).toEqual([first]);
    expect(yield* repository.list({ sessionId: "session-b" })).toEqual([]);
    expect((yield* repository.list({ sessionId: "session-a" })).length).toBe(2);
  }).pipe(Effect.provide(McpClientThreads.layer.pipe(Layer.provide(Sqlite.layerMemory)))),
);
