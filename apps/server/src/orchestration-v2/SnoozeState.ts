import * as DateTime from "effect/DateTime";

import type * as ProjectionStore from "./ProjectionStore.ts";

const toMillis = (value: DateTime.Utc | null | undefined): number | null =>
  value == null ? null : DateTime.toEpochMillis(value);

/** Match client effectiveSnoozed so agents and sidebar agree. */
export function isSnoozed(
  thread: Pick<
    ProjectionStore.ProjectionSettlementCandidate,
    | "snoozedUntil"
    | "snoozedAt"
    | "latestRunCompletedAt"
    | "status"
    | "pendingRuntimeRequest"
    | "pendingGuestMessageCount"
  >,
  nowMs: number,
): boolean {
  const snoozedUntilMs = toMillis(thread.snoozedUntil);
  if (snoozedUntilMs === null || snoozedUntilMs <= nowMs) return false;
  // Same as the client: a waiting guest message wakes the thread, and the snooze stays stored.
  if ((thread.pendingGuestMessageCount ?? 0) > 0) return false;
  const snoozedAtMs = toMillis(thread.snoozedAt);
  if (
    thread.pendingRuntimeRequest !== null &&
    (thread.pendingRuntimeRequest.kind !== "user_input" ||
      snoozedAtMs === null ||
      DateTime.toEpochMillis(thread.pendingRuntimeRequest.createdAt) > snoozedAtMs)
  ) {
    return false;
  }
  const completedAtMs = toMillis(thread.latestRunCompletedAt);
  const wokeOnError =
    thread.status === "failed" &&
    (snoozedAtMs === null || (completedAtMs !== null && completedAtMs > snoozedAtMs));
  return !wokeOnError;
}
