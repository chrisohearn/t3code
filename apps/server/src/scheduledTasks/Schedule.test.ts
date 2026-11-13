import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { isSameSchedule, missedScheduleRun, nextScheduledRunAt } from "./Schedule.ts";

describe("scheduled task schedule calculation", () => {
  it("skips to the next matching fixed-time weekday", () => {
    const next = nextScheduledRunAt(
      { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
      DateTime.makeZonedUnsafe(
        {
          year: 2026,
          month: 7,
          day: 3,
          hour: 10,
          minute: 0,
          second: 0,
          millisecond: 0,
        },
        { timeZone: "America/Los_Angeles", adjustForTimeZone: true },
      ),
    );
    const parts = next ? DateTime.toParts(next) : null;
    expect(parts?.weekDay).toBe(1);
    expect(parts?.hour).toBe(9);
    expect(parts?.minute).toBe(0);
  });

  it("compares schedules structurally", () => {
    expect(
      isSameSchedule(
        { type: "once", runAt: "2026-11-01T03:00:00-05:00" },
        { type: "once", runAt: "2026-11-01T08:00:00.000Z" },
      ),
    ).toBe(true);
    expect(
      isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 60_000 }),
    ).toBe(true);
    expect(
      isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 30_000 }),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [5, 1] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 5, 5] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [] },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 3] },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:30" },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "interval", everyMs: 60_000 },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(false);
  });
});

describe("missed scheduled runs", () => {
  const at = (iso: string) => DateTime.makeUnsafe(iso);
  const interval = { type: "interval", everyMs: 3_600_000 } as const;
  const task = (nextRunAt: string | null, lastRunStatus = "succeeded") => ({
    enabled: true,
    schedule: interval,
    nextRunAt,
    lastRunStatus,
  });

  it("flags a slot overdue by more than one interval and separates a stuck running task", () => {
    const now = at("2026-11-13T05:00:00.000Z");
    expect(missedScheduleRun(task("2026-11-13T03:30:00.000Z"), now)).toEqual({
      dueAt: "2026-11-13T03:30:00.000Z",
      overdueMs: 90 * 60_000,
      reason: "not_dispatched",
    });
    expect(missedScheduleRun(task("2026-11-13T03:30:00.000Z", "running"), now)?.reason).toBe(
      "run_in_progress",
    );
  });

  it.each([
    ["within one interval", task("2026-11-13T04:30:00.000Z")],
    ["disabled", { ...task("2026-11-13T00:00:00.000Z"), enabled: false }],
    ["no next run", task(null)],
    [
      "webhook",
      {
        ...task("2026-11-13T00:00:00.000Z"),
        schedule: { type: "webhook", signature: null } as const,
      },
    ],
  ])("does not flag a task that is %s", (_name, candidate) => {
    expect(missedScheduleRun(candidate, at("2026-11-13T05:00:00.000Z"))).toBeNull();
  });

  it("measures the gap between fixed-time slots in the scheduler's zone", () => {
    // Monday 22:00 in Los Angeles is Tuesday 06:00 UTC, so a UTC reading would see 6d16h, not 7d.
    const weekly = {
      enabled: true,
      schedule: { type: "fixed_time", timeOfDay: "22:00", weekdays: [1] } as const,
      nextRunAt: "2026-11-10T06:00:00.000Z",
      lastRunStatus: "succeeded",
    };
    const inLosAngeles = (iso: string) =>
      DateTime.setZone(at(iso), DateTime.zoneMakeNamedUnsafe("America/Los_Angeles"));
    expect(missedScheduleRun(weekly, inLosAngeles("2026-11-17T02:00:00.000Z"))).toBeNull();
    expect(missedScheduleRun(weekly, inLosAngeles("2026-11-17T08:00:00.000Z"))).not.toBeNull();
  });

  it("uses the gap to the following slot for fixed-time tasks and 10 minutes for one-time tasks", () => {
    const daily = {
      enabled: true,
      schedule: { type: "fixed_time", timeOfDay: "09:00" } as const,
      nextRunAt: "2026-11-12T09:00:00.000Z",
      lastRunStatus: "succeeded",
    };
    const utc = (iso: string) => DateTime.setZone(at(iso), DateTime.zoneMakeNamedUnsafe("UTC"));
    expect(missedScheduleRun(daily, utc("2026-11-13T08:00:00.000Z"))).toBeNull();
    expect(missedScheduleRun(daily, utc("2026-11-13T10:00:00.000Z"))).not.toBeNull();
    const once = {
      enabled: true,
      schedule: { type: "once", runAt: "2026-11-13T04:00:00.000Z" } as const,
      nextRunAt: "2026-11-13T04:00:00.000Z",
      lastRunStatus: "never",
    };
    expect(missedScheduleRun(once, at("2026-11-13T04:09:00.000Z"))).toBeNull();
    expect(missedScheduleRun(once, at("2026-11-13T04:11:00.000Z"))).not.toBeNull();
  });
});
