import { RunId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { queueStanding } from "./queueStanding.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);
const now = DateTime.toEpochMillis(at("2026-11-12T10:20:00Z"));

const projection = (runs: ReadonlyArray<object>, messages: ReadonlyArray<object> = []) =>
  ({ runs, messages }) as never;

describe("queueStanding", () => {
  it("counts the messages that start first and the age of the run it waits on", () => {
    const runs = [
      {
        id: "run:active",
        ordinal: 1,
        status: "running",
        requestedAt: at("2026-11-12T10:00:00Z"),
        startedAt: at("2026-11-12T10:02:30Z"),
      },
      { id: "run:mine", ordinal: 4, queuePosition: 3, status: "queued", userMessageId: "m:mine" },
      { id: "run:first", ordinal: 2, queuePosition: 1, status: "queued", userMessageId: "m:first" },
      { id: "run:second", ordinal: 3, queuePosition: 2, status: "queued", userMessageId: "m:2" },
      { id: "run:later", ordinal: 5, queuePosition: 4, status: "queued", userMessageId: "m:later" },
    ];

    expect(queueStanding(projection(runs), RunId.make("run:mine"), now)).toEqual({
      position: 3,
      messagesAhead: 2,
      activeRunId: "run:active",
      activeRunAgeSeconds: 1050,
    });
  });

  it("puts automatic task completions ahead and reports a held queue without an active run", () => {
    const runs = [
      {
        id: "run:mine",
        ordinal: 2,
        queuePosition: 1,
        queueHeld: true,
        status: "queued",
        userMessageId: "m:mine",
      },
      {
        id: "run:completion",
        ordinal: 3,
        queuePosition: 2,
        queueHeld: true,
        status: "queued",
        userMessageId: "m:completion",
      },
    ];
    const messages = [
      { id: "m:mine" },
      {
        id: "m:completion",
        delegatedCompletion: { parentRunId: "run:p", generation: 1, taskIds: [] },
      },
    ];

    expect(queueStanding(projection(runs, messages), RunId.make("run:mine"), now)).toEqual({
      position: 2,
      messagesAhead: 1,
      activeRunId: null,
      activeRunAgeSeconds: null,
      held: true,
    });
    expect(queueStanding(projection(runs, messages), RunId.make("run:gone"), now)).toBeUndefined();
  });
});
