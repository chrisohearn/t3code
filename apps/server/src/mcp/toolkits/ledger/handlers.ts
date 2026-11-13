import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ledger from "../../../persistence/WorkLedger.ts";
import * as Access from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { LedgerToolkit } from "./tools.ts";
import { messageSenderFor } from "../../McpInvocationContext.ts";
export const layer = Access.toLayer(LedgerToolkit, {
  ledger_upsert: Access.writes((input) =>
    Effect.gen(function* () {
      const { scope } = yield* readCaller();
      const updatedBy = scope.thread?.threadId ?? scope.client?.sessionId;
      if (updatedBy === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "A caller identity is required.",
        });
      return yield* (yield* Ledger.WorkLedger).upsert(
        input,
        updatedBy,
        messageSenderFor(scope).senderClient,
      );
    }),
  ),
  ledger_history: Access.reads((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      return yield* (yield* Ledger.WorkLedger).history(input);
    }),
  ),
  portfolio_status: Access.reads((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      return yield* (yield* Ledger.WorkLedger).portfolio(input);
    }),
  ),
  ledger_query: Access.reads((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      return yield* (yield* Ledger.WorkLedger).query(input);
    }),
  ),
});
