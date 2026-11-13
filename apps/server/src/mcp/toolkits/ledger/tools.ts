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
      "Read ledger changes with handoffArgs and server-recorded changedByClient labels. Oldest first; nextCursor paginates. Default 25 rows.",
    parameters: WorkLedgerHistoryInput,
    success: WorkLedgerHistoryResult,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("portfolio_status", {
    ...common,
    description:
      "Open ledger rows with owner thread run, pending requests, result excerpt, staleWorker (no run for 24h), and flapping (>3 open/blocked flips in 24h). Flags grant no restart permission. Default 10 rows; nextCursor paginates.",
    parameters: PortfolioStatusInput,
    success: PortfolioStatusResult,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("ledger_upsert", {
    ...common,
    description:
      "Update work by stable key; new rows need title, ownerKind, ownerName. Omitted fields stay; JSON null clears nullable fields (not the string \"null\"). links replaces all; addLinks/removeLinks deduplicate; removals win. handoffArgs stores exact JSON tool arguments, at most 4096 UTF-8 bytes; never put secrets here. Requires operate access. approvalNote/handoffArgs grant no approval. For Chris's approval, ask a dialog with `Ledger key: <key>` on its own question line; pass approval.source (threadId = item's sourceThreadId, itemId from t3_thread_read). Server verifies and quotes, or refuses. approval:null revokes.",
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
