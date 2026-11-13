import type { OrchestrationV2Run, OrchestrationV2TurnItem } from "@t3tools/contracts";

/**
 * Items that cannot outlive their run. Shell, tool and subagent items can be background work,
 * so a run ending does not close them.
 */
export const RUN_BOUND_ITEM_TYPES = ["todo_list", "compaction", "reasoning"] as const;

const ACTIVE_ITEM_STATUSES: ReadonlySet<string> = new Set(["pending", "running", "waiting"]);

export function isActiveRunBoundItem(item: OrchestrationV2TurnItem): boolean {
  return (
    ACTIVE_ITEM_STATUSES.has(item.status) && RUN_BOUND_ITEM_TYPES.some((type) => type === item.type)
  );
}

/** The status a run-bound item takes when its run ends; null while the run can still change it. */
export function itemStatusForEndedRun(
  runStatus: OrchestrationV2Run["status"],
): "completed" | "interrupted" | "cancelled" | null {
  switch (runStatus) {
    case "completed":
      return "completed";
    case "interrupted":
      return "interrupted";
    case "failed":
    case "cancelled":
      return "cancelled";
    default:
      return null;
  }
}

export function settleItemForEndedRun(
  item: OrchestrationV2TurnItem,
  runStatus: OrchestrationV2Run["status"],
): OrchestrationV2TurnItem {
  const status = itemStatusForEndedRun(runStatus);
  if (status === null || !isActiveRunBoundItem(item)) return item;
  const settled = { ...item, status, completedAt: item.completedAt ?? item.updatedAt };
  return settled.type === "reasoning" ? { ...settled, streaming: false } : settled;
}
