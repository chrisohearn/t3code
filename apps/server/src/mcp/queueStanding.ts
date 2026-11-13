import type {
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  OrchestratorMcpQueueStanding,
  RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { isActiveRun } from "../orchestration-v2/ThreadManagementService.ts";
import { queuedRunsInDeliveryOrder } from "../orchestration-v2/QueuedRunOrder.ts";

/** Where a queued run waits: what starts before it, and how long the run it waits on has run. */
export function queueStanding(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  runId: RunId,
  nowMs: number,
): OrchestratorMcpQueueStanding | undefined {
  const queued = queuedRunsInDeliveryOrder(projection);
  const index = queued.findIndex((run) => run.id === runId);
  if (index < 0) return undefined;
  const active = projection.runs
    .filter(isActiveRun)
    .toSorted((left, right) => right.ordinal - left.ordinal)[0];
  const since = active === undefined ? undefined : (active.startedAt ?? active.requestedAt);
  return {
    position: index + 1,
    messagesAhead: index,
    activeRunId: active?.id ?? null,
    activeRunAgeSeconds:
      since === undefined
        ? null
        : Math.max(0, Math.floor((nowMs - DateTime.toEpochMillis(since)) / 1000)),
    ...(queued[index]?.queueHeld === true ? { held: true } : {}),
  };
}

export const queuedRunMessageIds = (runs: ReadonlyArray<OrchestrationV2Run>) =>
  runs.filter((run) => run.status === "queued").map((run) => run.userMessageId);
