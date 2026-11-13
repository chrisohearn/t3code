import {
  type EnvironmentId,
  ModelSelection,
  OrchestrationV2McpApprovalAnswer,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";

export const ApprovalReviewEscalation = Schema.Struct({
  threadId: ThreadId,
  requestId: RuntimeRequestId,
  decision: Schema.Literal("escalate"),
  answeredAt: OrchestrationV2McpApprovalAnswer.fields.answeredAt,
  reviewer: Schema.Struct({ modelSelection: ModelSelection, reason: Schema.String }),
});

export class McpApprovalAnswerContext extends Context.Service<
  McpApprovalAnswerContext,
  {
    readonly sessionId: string;
    readonly clientLabel: string;
    readonly originEnvironmentId?: EnvironmentId;
    readonly note?: string;
    readonly reviewer?: { readonly modelSelection: ModelSelection; readonly reason: string };
  }
>()("t3/mcp/McpApprovalAnswerContext") {}
