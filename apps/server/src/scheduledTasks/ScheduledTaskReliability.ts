import type { ScheduledTask } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { missedScheduleRun, type MissedScheduleRun } from "./Schedule.ts";

const RECENT_RUN_WINDOW_DAYS = 7;
const RECENT_RUN_WINDOW_MS = RECENT_RUN_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const MESSAGE_PREFIX = "scheduled-task-message:";
const ERROR_TEXT_LIMIT = 500;

export interface RecentRunFailures {
  readonly failed: number;
  readonly cancelled: number;
  readonly lastAt: string;
  readonly lastStatus: "failed" | "cancelled";
  /** The error of the latest failed run, which may be older than `lastAt`. */
  readonly lastError: string | null;
}

export interface ScheduledTaskReliability {
  readonly taskId: string;
  readonly recentFailures?: RecentRunFailures;
  readonly missedRun?: MissedScheduleRun;
}

/** A scheduled run's message id is `scheduled-task-message:<taskId>:<startedAtMs>:<trigger>`. */
function parseScheduledRunMessageId(
  messageId: string,
): { readonly taskId: string; readonly startedAtMs: number | null } | null {
  if (!messageId.startsWith(MESSAGE_PREFIX)) return null;
  const key = messageId.slice(MESSAGE_PREFIX.length);
  const timed = /^(.+):(\d+):(?:scheduled|manual)$/.exec(key);
  if (timed !== null) return { taskId: timed[1]!, startedAtMs: Number(timed[2]) };
  const webhook = /^(.+):webhook:[^:]+$/.exec(key);
  return webhook === null ? null : { taskId: webhook[1]!, startedAtMs: null };
}

interface FailedRun {
  readonly status: "failed" | "cancelled";
  readonly at: string;
  readonly threadId: string;
  readonly runId: string;
  readonly startedAtMs: number | null;
}

/**
 * Failures and cancels of the last 7 days per task, derived from the runs themselves, so no
 * second record exists to drift. A failure that never created a run comes from the task row.
 */
export const readTaskReliability = Effect.fn("ScheduledTaskReliability.read")(function* (
  tasks: ReadonlyArray<ScheduledTask>,
  now: DateTime.DateTime,
) {
  const sql = yield* SqlClient.SqlClient;
  const sinceMs = DateTime.toEpochMillis(now) - RECENT_RUN_WINDOW_MS;
  const sinceIso = DateTime.formatIso(DateTime.makeUnsafe(sinceMs));
  const rows = yield* sql<{
    readonly status: "failed" | "cancelled";
    readonly requested_at: string;
    readonly thread_id: string;
    readonly run_id: string;
    readonly message_id: string;
  }>`
    SELECT status, requested_at, thread_id, run_id,
      json_extract(payload_json, '$.userMessageId') AS message_id
    FROM orchestration_v2_projection_runs
    WHERE status IN ('failed', 'cancelled') AND requested_at >= ${sinceIso}
      AND substr(json_extract(payload_json, '$.userMessageId'), 1, ${MESSAGE_PREFIX.length}) = ${MESSAGE_PREFIX}
  `.pipe(NodeSqliteClient.readOnly);

  const runsByTask = new Map<string, FailedRun[]>();
  for (const row of rows) {
    const parsed = parseScheduledRunMessageId(row.message_id);
    if (parsed === null) continue;
    runsByTask.set(parsed.taskId, [
      ...(runsByTask.get(parsed.taskId) ?? []),
      {
        status: row.status,
        at: row.requested_at,
        threadId: row.thread_id,
        runId: row.run_id,
        startedAtMs: parsed.startedAtMs,
      },
    ]);
  }

  const reliability: ScheduledTaskReliability[] = [];
  for (const task of tasks) {
    const runs = [...(runsByTask.get(task.id) ?? [])];
    let failed = runs.filter((run) => run.status === "failed").length;
    const cancelled = runs.filter((run) => run.status === "cancelled").length;
    const byLatest = runs.toSorted((x, y) => y.at.localeCompare(x.at));
    let latest: { at: string; status: "failed" | "cancelled" } | null =
      byLatest[0] === undefined ? null : { at: byLatest[0].at, status: byLatest[0].status };
    const latestFailedRun = byLatest.find((run) => run.status === "failed");
    let latestFailed: { at: string; error: string | null } | null = null;
    if (latestFailedRun !== undefined) {
      const [errorRow] = yield* sql<{ readonly message: string | null }>`
        SELECT json_extract(payload_json, '$.failure.message') AS message
        FROM orchestration_v2_projection_turn_items
        WHERE thread_id = ${latestFailedRun.threadId} AND run_id = ${latestFailedRun.runId}
          AND type = 'error' AND status = 'failed'
        ORDER BY updated_at DESC, ordinal DESC
        LIMIT 1
      `.pipe(NodeSqliteClient.readOnly);
      latestFailed = { at: latestFailedRun.at, error: errorRow?.message ?? null };
    }
    // A dispatch that failed before a run existed leaves only the task row.
    const lastStartedMs = task.lastRunAt === null ? Number.NaN : Date.parse(task.lastRunAt);
    if (
      task.lastRunStatus === "failed" &&
      task.schedule.type !== "webhook" &&
      lastStartedMs >= sinceMs &&
      !runs.some((run) => run.startedAtMs === lastStartedMs)
    ) {
      failed += 1;
      if (latest === null || task.lastRunAt! > latest.at) {
        latest = { at: task.lastRunAt!, status: "failed" };
      }
      if (latestFailed === null || task.lastRunAt! > latestFailed.at) {
        latestFailed = { at: task.lastRunAt!, error: task.lastRunError };
      }
    }

    const missedRun = missedScheduleRun(task, now);
    if (latest === null && missedRun === null) continue;
    reliability.push({
      taskId: task.id,
      ...(latest === null
        ? {}
        : {
            recentFailures: {
              failed,
              cancelled,
              lastAt: latest.at,
              lastStatus: latest.status,
              lastError: latestFailed?.error?.slice(0, ERROR_TEXT_LIMIT) ?? null,
            },
          }),
      ...(missedRun === null ? {} : { missedRun }),
    });
  }
  return reliability;
});
