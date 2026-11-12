import type { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";

export class McpApprovalAnswerContext extends Context.Service<
  McpApprovalAnswerContext,
  {
    readonly sessionId: string;
    readonly clientLabel: string;
    readonly originEnvironmentId?: EnvironmentId;
    readonly note?: string;
  }
>()("t3/mcp/McpApprovalAnswerContext") {}
