import {
  WorkLedgerUpsertInput,
  WorkLedgerUpsertResult,
  WorkLedgerHistoryInput,
  WorkLedgerHistoryResult,
  PortfolioStatusInput,
  PortfolioStatusResult,
  WorkLedgerQueryInput,
  WorkLedgerQueryResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as WorkLedger from "../../../persistence/WorkLedger.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "../../McpInvocationContext.ts";
const common = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    Invocation.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
    WorkLedger.WorkLedger,
  ],
};
export const LedgerToolkit = Toolkit.make(
  Tool.make("ledger_history", {
    ...common,
    description:
      "Read who changed a ledger key, when, and before/after values, including handoffArgs. changedByClient carries the server-recorded editor label and session prefix when available; old entries remain unattributed. No-op updates add no history. Ordered oldest first; continue with nextCursor. Default 25 rows.",
    parameters: WorkLedgerHistoryInput,
    success: WorkLedgerHistoryResult,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("portfolio_status", {
    ...common,
    description:
      "Open ledger rows with owner thread latest run, pending request count, result excerpt and staleWorker (no run for over 24 hours). openBlockedFlips24h counts open/blocked transitions in the last 24 hours; flapping means more than 3. Flags are attention signals, not permission to restart. Default 10 rows; continue with nextCursor.",
    parameters: PortfolioStatusInput,
    success: PortfolioStatusResult,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("ledger_upsert", {
    ...common,
    description:
      "Create or partially update work by a stable `key`. New items need title, ownerKind and ownerName. Omitted fields stay; null clears nullable fields. links replaces the list; prefer addLinks/removeLinks for partial changes (normalized, deduplicated, removals win). handoffArgs stores exact handoff tool arguments as JSON, at most 4096 UTF-8 bytes; null clears it. Blocked work without waitReason defaults to decision with a warning; contradictory blocker prefixes also warn. No-op updates preserve timestamps and add no history. Requires operate access. approvalNote and handoffArgs grant no approval. For Chris's approval, ask him in a dialog whose question has `Ledger key: <key>` on its own line, then pass `approval.source` (itemId, sourceThreadId from t3_thread_read); the server verifies and quotes it, or refuses. `approval: null` revokes.",
    parameters: WorkLedgerUpsertInput,
    success: WorkLedgerUpsertResult,
  }).annotate(Tool.Destructive, true),
  Tool.make("ledger_query", {
    ...common,
    description:
      "Read compact work ledger rows by status, ownerKind, ownerName, waitReason, due, approved or updatedSince (inclusive). Ordered by key; continue with nextCursor. Default 25 rows.",
    parameters: WorkLedgerQueryInput,
    success: WorkLedgerQueryResult,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
);
