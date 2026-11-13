import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { ActiveShellIndexEntry } from "../orchestration-v2/ProjectionStore.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import { resolveReadableThread } from "./threadReference.ts";

const here = EnvironmentId.make("environment-here");
const uuid = "5d0b4a3e-8c1f-4a52-9d37-2f6c7e1b9a04";
const mcpThread = ThreadId.make(`mcp:${uuid}`);
const launchThread = ThreadId.make(`mcp:launch:${"be52150e".repeat(8)}`);
const nativeThread = ThreadId.make("7e56b504-8739-4f3f-80e7-298410d87ec0");
const deletedThread = ThreadId.make("mcp:0dd09096-12e3-4179-87d5-42fa45c77d5e");
// A deleted mcp: thread whose bare uuid is another, live thread.
const replacedUuid = "29b25a73-a7a7-4321-bef4-2b4eb4386aa8";
const deletedReplaced = ThreadId.make(`mcp:${replacedUuid}`);
const liveReplaced = ThreadId.make(replacedUuid);

const threads = {
  getThreadShell: (threadId: ThreadId) =>
    Effect.succeed(
      threadId === deletedThread || threadId === deletedReplaced
        ? { ...liveThreadShell(threadId), deletedAt: DateTime.makeUnsafe(0) }
        : [mcpThread, launchThread, nativeThread, liveReplaced].includes(threadId)
          ? liveThreadShell(threadId)
          : null,
    ),
  listActiveShellIndex: () =>
    Effect.succeed(
      [mcpThread, launchThread, nativeThread].map(
        (id) => ({ id }) as unknown as ActiveShellIndexEntry,
      ),
    ),
};

const resolve = (reference: string) =>
  resolveReadableThread(threads, here, ThreadId.make(reference)).pipe(
    Effect.map(({ threadId }) => threadId),
  );
const refuse = (reference: string) => resolve(reference).pipe(Effect.flip);

describe("resolveReadableThread", () => {
  it.effect("reads each reference shape agents pass as the thread it names", () =>
    Effect.gen(function* () {
      for (const [reference, expected] of [
        [mcpThread, mcpThread],
        [uuid, mcpThread],
        [launchThread, launchThread],
        [nativeThread, nativeThread],
        [`t3-thread://v1/${mcpThread}`, mcpThread],
        [`t3-thread://v1/${uuid}`, mcpThread],
        [`t3-thread://v2/${here}/${launchThread}`, launchThread],
        [`t3-thread://v1/mcp%3A${uuid}`, mcpThread],
        [`https://app.t3.codes/threads/${here}/mcp%3A${uuid}`, mcpThread],
      ] as const) {
        expect(yield* resolve(reference), reference).toBe(expected);
      }
    }),
  );

  it.effect("sends a link for another environment there instead of reading a local thread", () =>
    Effect.gen(function* () {
      const error = yield* refuse(`t3-thread://v2/environment-there/${mcpThread}`);
      expect(error.code).toBe("invalid_request");
      expect(error.message).toContain(`Pass environmentId: "environment-there"`);
    }),
  );

  it.effect("says a thread was deleted, and names the closest ids for one never here", () =>
    Effect.gen(function* () {
      expect((yield* refuse(deletedThread)).message).toBe(`Thread ${deletedThread} was deleted.`);
      expect((yield* refuse(deletedReplaced)).message).toBe(
        `Thread ${deletedReplaced} was deleted.`,
      );
      // A bare uuid of a deleted mcp: thread says so too.
      expect((yield* refuse(deletedThread.slice(4))).message).toBe(
        `Thread ${deletedThread} was deleted.`,
      );

      const typo = yield* refuse("mcp:5d0b4a3e-0000-4000-8000-000000000000");
      expect(typo.code).toBe("thread_not_found");
      expect(typo.message).toContain(`Closest: \`${mcpThread}\``);

      const unknown = yield* refuse("mcp:11111111-2222-4333-8444-555555555555");
      expect(unknown.message).toContain("pass its environmentId");
    }),
  );
});
