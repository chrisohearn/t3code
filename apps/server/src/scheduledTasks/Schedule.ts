import { MIN_SCHEDULED_TASK_INTERVAL_MS, type ScheduledTaskSchedule } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

const MINUTE_MS = 60_000;

function parseTimeOfDay(value: string): { hour: number; minute: number } | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

export function nextScheduledRunAt(
  schedule: ScheduledTaskSchedule,
  from: DateTime.DateTime,
): DateTime.DateTime | null {
  if (schedule.type === "webhook") return null;
  if (schedule.type === "once") {
    const runAt = DateTime.make(schedule.runAt);
    return Option.isSome(runAt) &&
      DateTime.toEpochMillis(runAt.value) > DateTime.toEpochMillis(from)
      ? runAt.value
      : null;
  }
  if (schedule.type === "interval") {
    // Intervals advance elapsed time, including across daylight-saving changes.
    return DateTime.addDuration(from, Math.max(schedule.everyMs, MIN_SCHEDULED_TASK_INTERVAL_MS));
  }

  const time = parseTimeOfDay(schedule.timeOfDay);
  if (time === null) return null;
  const weekdays =
    schedule.weekdays && schedule.weekdays.length > 0 ? new Set(schedule.weekdays) : null;
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = DateTime.setParts(DateTime.add(from, { days: offset }), {
      hour: time.hour,
      minute: time.minute,
      second: 0,
      millisecond: 0,
    });
    if (DateTime.toEpochMillis(candidate) <= DateTime.toEpochMillis(from)) continue;
    if (weekdays !== null && !weekdays.has(DateTime.toParts(candidate).weekDay)) continue;
    return candidate;
  }
  return null;
}

function weekdayKey(weekdays: ReadonlyArray<number> | undefined): string {
  const unique = [...new Set(weekdays ?? [])].toSorted((x, y) => x - y);
  if (unique.length === 0 || unique.length === 7) return "daily";
  return unique.join(",");
}

export function isSameSchedule(a: ScheduledTaskSchedule, b: ScheduledTaskSchedule): boolean {
  if (a.type === "interval") {
    return b.type === "interval" && a.everyMs === b.everyMs;
  }
  if (a.type === "webhook") return b.type === "webhook";
  if (a.type === "once") return b.type === "once" && Date.parse(a.runAt) === Date.parse(b.runAt);
  if (b.type !== "fixed_time") return false;
  // Compare parsed times so padded-hour edits do not reschedule pending runs.
  const aTime = parseTimeOfDay(a.timeOfDay);
  const bTime = parseTimeOfDay(b.timeOfDay);
  return (
    aTime !== null &&
    bTime !== null &&
    aTime.hour === bTime.hour &&
    aTime.minute === bTime.minute &&
    weekdayKey(a.weekdays) === weekdayKey(b.weekdays)
  );
}

const MISSED_FIXED_TIME_GRACE_MS = 10 * MINUTE_MS;

export function isMissedFixedTimeRun(
  schedule: ScheduledTaskSchedule,
  dueAt: DateTime.DateTime,
  now: DateTime.DateTime,
): boolean {
  if (schedule.type !== "fixed_time") return false;
  return DateTime.toEpochMillis(now) - DateTime.toEpochMillis(dueAt) > MISSED_FIXED_TIME_GRACE_MS;
}

export interface MissedScheduleRun {
  readonly dueAt: string;
  readonly overdueMs: number;
  /** The run that should have fired later is still going, or nothing started it. */
  readonly reason: "run_in_progress" | "not_dispatched";
}

const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * An enabled task whose `nextRunAt` passed by more than one interval without a new run.
 * A task stuck in `running` counts: its later slots are skipped while the run lasts.
 */
export function missedScheduleRun(
  task: {
    readonly enabled: boolean;
    readonly schedule: ScheduledTaskSchedule;
    readonly nextRunAt: string | null;
    readonly lastRunStatus: string;
  },
  now: DateTime.DateTime,
): MissedScheduleRun | null {
  if (!task.enabled || task.nextRunAt === null || task.schedule.type === "webhook") return null;
  const dueAt = DateTime.make(task.nextRunAt);
  if (Option.isNone(dueAt)) return null;
  const dueMs = DateTime.toEpochMillis(dueAt.value);
  const overdueMs = DateTime.toEpochMillis(now) - dueMs;
  let intervalMs: number;
  if (task.schedule.type === "interval") {
    intervalMs = Math.max(task.schedule.everyMs, MIN_SCHEDULED_TASK_INTERVAL_MS);
  } else if (task.schedule.type === "once") {
    intervalMs = MISSED_FIXED_TIME_GRACE_MS;
  } else {
    const following = nextScheduledRunAt(task.schedule, dueAt.value);
    intervalMs =
      following === null ? DAY_MS : Math.max(DateTime.toEpochMillis(following) - dueMs, MINUTE_MS);
  }
  return overdueMs > intervalMs
    ? {
        dueAt: DateTime.formatIso(dueAt.value),
        overdueMs,
        reason: task.lastRunStatus === "running" ? "run_in_progress" : "not_dispatched",
      }
    : null;
}
