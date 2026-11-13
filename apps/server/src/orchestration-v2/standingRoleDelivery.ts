import type { ThreadRoleRecord } from "../persistence/ThreadRoles.ts";

/** Runs after which a role is sent again, in case the provider compacted it away on its own. */
export const STANDING_ROLE_REFRESH_RUNS = 25;

/**
 * Whether this turn carries the role. Each copy stays in the provider's history, so a role goes
 * once, then again when it changed, the native session is new, a compaction ran, or enough runs
 * passed for an automatic compaction to have dropped it.
 */
export function standingRoleDue(input: {
  readonly role: ThreadRoleRecord;
  readonly nativeThreadId: string | null;
  readonly runOrdinal: number;
  readonly compactedSinceDelivery: (afterRunOrdinal: number) => boolean;
}): boolean {
  const { delivered } = input.role;
  return (
    delivered === undefined ||
    delivered.revision !== input.role.revision ||
    delivered.nativeThreadId !== input.nativeThreadId ||
    input.runOrdinal - delivered.runOrdinal >= STANDING_ROLE_REFRESH_RUNS ||
    input.compactedSinceDelivery(delivered.runOrdinal)
  );
}
