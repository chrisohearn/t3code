import { describe, expect, it } from "vite-plus/test";

import { snoozeDeferredReleases } from "./SnoozeDeferredDelivery.ts";

describe("snoozeDeferredReleases", () => {
  it("releases awake threads and wakes at the earliest snooze still holding a turn", () => {
    const now = Date.parse("2026-11-13T03:00:00Z");
    const thread = (threadId: string, snoozedUntil: string | null) => ({
      threadId,
      snoozedUntil,
      firstRunId: `run:${threadId}`,
    });
    const { due, wakeAtMs } = snoozeDeferredReleases(
      [
        thread("unsnoozed", null),
        thread("expired", "2026-11-13T02:59:59.000Z"),
        thread("later", "2026-11-24T00:00:00.000Z"),
        thread("sooner", "2026-11-18T00:00:00.000Z"),
      ],
      now,
    );
    expect(due.map((entry) => entry.threadId)).toEqual(["unsnoozed", "expired"]);
    expect(wakeAtMs).toBe(Date.parse("2026-11-18T00:00:00.000Z"));
  });
});
