import { CommandId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";

import * as DueHint from "../scheduling/DueHint.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const RELEASE_RETRY_MS = 60_000;

export interface SnoozeDeferredThread {
  readonly threadId: string;
  readonly snoozedUntil: string | null;
  /** The first held turn, so a release names this deferral and a later one gets its own. */
  readonly firstRunId: string;
}

/** Threads to release now, and when the next snooze holding a turn ends. */
export function snoozeDeferredReleases(
  threads: ReadonlyArray<SnoozeDeferredThread>,
  nowMs: number,
): { readonly due: ReadonlyArray<SnoozeDeferredThread>; readonly wakeAtMs: number } {
  const due: Array<SnoozeDeferredThread> = [];
  let wakeAtMs = Infinity;
  for (const thread of threads) {
    const untilMs = thread.snoozedUntil === null ? Number.NaN : Date.parse(thread.snoozedUntil);
    if (Number.isFinite(untilMs) && untilMs > nowMs) wakeAtMs = Math.min(wakeAtMs, untilMs);
    else due.push(thread);
  }
  return { due, wakeAtMs };
}

/** Threads with turns held for a snooze. The partial recovery index covers queued runs. */
export const readSnoozeDeferredThreads = Effect.fn("SnoozeDeferredDelivery.read")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly thread_id: string;
    readonly snoozed_until: string | null;
    readonly first_run_id: string;
  }>`
    SELECT r.thread_id, json_extract(t.payload_json, '$.snoozedUntil') AS snoozed_until,
      MIN(r.run_id) AS first_run_id
    FROM orchestration_v2_projection_runs AS r
    JOIN orchestration_v2_projection_threads AS t ON t.thread_id = r.thread_id
    WHERE r.status = 'queued'
      AND json_extract(r.payload_json, '$.snoozeDeferred') = 1
      AND json_extract(r.payload_json, '$.queueHeld') = 1
      AND t.deleted_at IS NULL
    GROUP BY r.thread_id
  `;
  return rows.map((row): SnoozeDeferredThread => ({
    threadId: row.thread_id,
    snoozedUntil: row.snoozed_until,
    firstRunId: row.first_run_id,
  }));
});

const affectsDeferral = (event: OrchestrationV2DomainEvent) =>
  event.type.startsWith("thread.") || event.type === "run.created" || event.type === "run.updated";

const makeSweep = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const due = DueHint.make();
  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
      affectsDeferral(event) ? due.invalidate : Effect.void,
    ),
  );
  return Effect.fn("SnoozeDeferredDelivery.sweep")(function* () {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    if (yield* due.isIdle(nowMs)) return;
    const readVersion = yield* due.version;
    const { due: releases, wakeAtMs } = snoozeDeferredReleases(
      yield* readSnoozeDeferredThreads().pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.orElseSucceed(() => []),
      ),
      nowMs,
    );
    for (const thread of releases) {
      yield* threads
        .dispatch({
          type: "queue.resume",
          commandId: CommandId.make(`snooze-deferred-release:${thread.firstRunId}`),
          threadId: ThreadId.make(thread.threadId),
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.snooze-deferred.release-failed", {
              threadId: thread.threadId,
              cause,
            }),
          ),
        );
    }
    // A release's events invalidate the hint; one that failed, such as a limited provider,
    // retries in a minute instead of every tick.
    yield* due.record(
      readVersion,
      releases.length === 0 ? wakeAtMs : nowMs + RELEASE_RETRY_MS,
      nowMs,
    );
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("snooze-deferred-delivery", sweep());
  }),
);
