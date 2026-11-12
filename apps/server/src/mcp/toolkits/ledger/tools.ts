import {
  WorkLedgerUpsertInput,
  WorkLedgerItem,
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
  Tool.make("ledger_upsert", {
    ...common,
    description:
      "Create or partially update work by a stable `key`. New items need title, ownerKind and ownerName. Omitted fields stay; null clears a nullable field. Requires operate access. approvalNote records context and grants no approval.",
    parameters: WorkLedgerUpsertInput,
    success: WorkLedgerItem,
  }).annotate(Tool.Destructive, true),
  Tool.make("ledger_query", {
    ...common,
    description:
      "Read compact work ledger rows by status, ownerKind, ownerName or updatedSince (inclusive). Ordered by key; continue with nextCursor. Default 25 rows.",
    parameters: WorkLedgerQueryInput,
    success: WorkLedgerQueryResult,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
);
