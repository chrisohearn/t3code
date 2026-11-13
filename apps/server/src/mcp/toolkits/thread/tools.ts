import {
  OrchestratorMcpEnvironmentTarget,
  ScheduledTaskId,
  ScheduledTask,
  OrchestrationSearchThreadsInput,
  OrchestrationThreadSearchMatch,
  OrchestrationV2ThreadForkSourcePoint,
  OrchestrationV2ContextTransfer,
  TrimmedNonEmptyString,
  ModelSelection,
  RuntimeMode,
  ProviderInteractionMode,
  RuntimeRequestId,
  ProviderUserInputAnswers,
  IsoDateTime,
  OrchestratorMcpFailure,
  OrchestratorMcpScheduledTaskRunStatus,
  OrchestrationV2DispatchCommandResult,
  ThreadId,
  RunId,
  NonNegativeInt,
  ProjectId,
  ThreadFreeze,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerSettings from "../../../serverSettings.ts";
import { Tool, Toolkit } from "effect/ai";

import * as ScratchThreadPromotion from "../../../project/ScratchThreadPromotion.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PendingApproval from "../../PendingApprovalMcpService.ts";
import { AutoReviewOverride } from "../../../orchestration-v2/ApprovalAutoReviewConfig.ts";

const ThreadOrganizeTool = Tool.make("t3_thread_organize", {
  description:
    "Pin, snooze, settle, archive, or mark unread. move: file an idle No project thread into existing `projectId`; keeps its folder. Omit `threadId` for this thread. `snooze` needs `snoozedUntil`. Settling this thread applies at turn end. A failed turn or queued message leaves it active. freeze (needs `reason`): stop the run, hold the queue and delegates, start nothing until unfreeze. unfreeze: resume; `freshContext` needs an empty queue.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    action: Schema.Literals([
      "pin",
      "unpin",
      "snooze",
      "unsnooze",
      "settle",
      "unsettle",
      "archive",
      "unarchive",
      "mark_unread",
      "move",
      "freeze",
      "unfreeze",
    ]),
    snoozedUntil: Schema.optional(IsoDateTime),
    projectId: Schema.optional(ProjectId),
    reason: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(500))),
    freshContext: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Union([
    OrchestrationV2DispatchCommandResult,
    Schema.Struct({ moved: Schema.Literal(true), threadIds: Schema.Array(ThreadId) }),
    Schema.Struct({ settlesWhenTurnEnds: Schema.Literal(true) }),
    Schema.Struct({
      frozen: Schema.Literal(true),
      freeze: ThreadFreeze,
      interruptedRunId: Schema.NullOr(RunId),
      queuedMessages: NonNegativeInt,
    }),
    Schema.Struct({
      frozen: Schema.Literal(false),
      wasFrozen: Schema.Boolean,
      queuedMessages: NonNegativeInt,
      freshContextNext: Schema.optional(Schema.Literal(true)),
    }),
  ]),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    ScratchThreadPromotion.ScratchThreadPromotion,
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    SecureRandom.SecureRandom,
  ],
})
  .annotate(Tool.Title, "Organize a thread")
  .annotate(Tool.Strict, true)
  .annotate(Tool.Destructive, true);

const commandTool = {
  success: OrchestrationV2DispatchCommandResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    SecureRandom.SecureRandom,
  ],
};
const queueEntry = Schema.Struct({
  queuedRunId: RunId,
  text: Schema.String,
  truncated: Schema.Boolean,
});
const QUEUE_READ_ACTIONS = ["list", "read"] as const;
const QueueTool = Tool.make("t3_queue", {
  ...commandTool,
  description:
    "Manage a thread's queued messages. Omit `threadId` for this thread. list: send order, paged by `cursor` and `limit`. read: up to 16,000 chars of one. edit: replace its `text`; attachments stay. cancel. reorder: before `beforeRunId`, or to the end with null. promote_to_steer: send it now as steering to active `targetRunId`. Writes fail once the run is no longer queued.",
  parameters: Schema.Struct({
    action: Schema.Literals([
      ...QUEUE_READ_ACTIONS,
      "edit",
      "cancel",
      "reorder",
      "promote_to_steer",
    ]),
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    queuedRunId: Schema.optional(RunId),
    text: Schema.optional(Schema.String.check(Schema.isMaxLength(100000))),
    beforeRunId: Schema.optional(Schema.NullOr(RunId)),
    targetRunId: Schema.optional(RunId),
    cursor: Schema.optional(NonNegativeInt),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  }),
  success: Schema.Union([
    Schema.Struct({ items: Schema.Array(queueEntry), nextCursor: Schema.NullOr(NonNegativeInt) }),
    queueEntry,
    OrchestrationV2DispatchCommandResult,
  ]),
}).annotate(Tool.Destructive, true);

const question = Schema.Struct({
  id: Schema.String,
  header: Schema.String,
  question: Schema.String,
  options: Schema.Array(
    Schema.Struct({
      label: Schema.String,
      description: Schema.String,
      value: Schema.optional(Schema.String),
    }),
  ),
  multiSelect: Schema.optional(Schema.Boolean),
  allowCustomAnswer: Schema.optional(Schema.Boolean),
  initialAnswer: Schema.optional(Schema.String),
  required: Schema.optional(Schema.Boolean),
});
const PendingRequestTool = Tool.make("t3_pending_request", {
  ...commandTool,
  description:
    "Pending questions and approvals. list: ids with `kind`. read: details by `requestId`. respond: questions use `answers`. Only an outside full-access sign-in can answer an approval on any thread with `decision`: accept allows once, decline denies. Optional `note` records what the caller says Chris said. Answers are logged. Standing grants and permission modes stay in the app.",
  parameters: Schema.Struct({
    action: Schema.Literals(["list", "read", "respond"]),
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    requestId: Schema.optional(RuntimeRequestId),
    answers: Schema.optional(ProviderUserInputAnswers),
    decision: Schema.optional(Schema.Literals(["accept", "decline"])),
    note: Schema.optional(Schema.String.pipe(Schema.check(Schema.isMaxLength(4000)))),
  }),
  success: Schema.Union([
    Schema.Struct({
      requestIds: Schema.Array(RuntimeRequestId),
      // Optional: a linked environment on an older build omits it.
      requests: Schema.optional(
        Schema.Array(
          Schema.Struct({
            requestId: RuntimeRequestId,
            kind: Schema.Literals(["user_input", "approval"]),
          }),
        ),
      ),
    }),
    Schema.Struct({ requestId: RuntimeRequestId, questions: Schema.Array(question) }),
    Schema.Struct({ requestId: RuntimeRequestId, approval: PendingApproval.ApprovalDetails }),
    OrchestrationV2DispatchCommandResult,
  ]),
  dependencies: [...commandTool.dependencies, PendingApproval.PendingApprovalMcpService],
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const ApprovalLogTool = Tool.make("t3_approval_log", {
  ...commandTool,
  description:
    "Read durable MCP approval answers, including who answered, what was requested, decision, time and caller note. Requires full access. Optional threadId filters; cursor and limit page the log.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    cursor: Schema.optional(NonNegativeInt),
    limit: Schema.optional(
      Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
    ),
  }),
  success: PendingApproval.ApprovalLogResult,
  dependencies: [...commandTool.dependencies, PendingApproval.PendingApprovalMcpService],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const threadConfiguration = Schema.Struct({
  autoReview: Schema.Struct({
    override: AutoReviewOverride,
    effective: Schema.NullOr(ModelSelection),
  }),
  threadId: ThreadId,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
const ThreadConfigureTool = Tool.make("t3_thread_configure", {
  ...commandTool,
  dependencies: [
    ...commandTool.dependencies,
    SqlClient.SqlClient,
    ServerSettings.ServerSettingsService,
  ],
  description:
    "Read or set a thread's model and modes. Omit threadId for this thread. Set runtimeMode alone to lower permissions on an idle thread; raises and active runs are refused. autoReview alone sets a reviewer model selection, null disables it, or 'inherit' uses the server default (off initially). Only a full-access caller can change auto-review. Reviews allow once or deny; money, human questions and errors remain pending. Values from orchestrator_capabilities.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    modelSelection: Schema.optional(ModelSelection),
    runtimeMode: Schema.optional(RuntimeMode),
    autoReview: Schema.optional(AutoReviewOverride),
  }),
  success: Schema.Union([threadConfiguration, OrchestrationV2DispatchCommandResult]),
}).annotate(Tool.Destructive, true);

const ThreadTransferTool = Tool.make("t3_thread_transfer", {
  ...commandTool,
  description:
    "Move context between threads. Omit `threadId` for this thread. fork: copy it from `sourcePoint` (default latest stable run) into a new thread with the same setup; no turn runs yet. merge_back: merge it from `sourcePoint` into a related `targetThreadId` in the same project. status: its context transfers.",
  parameters: Schema.Struct({
    action: Schema.Literals(["fork", "merge_back", "status"]),
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    sourcePoint: Schema.optional(OrchestrationV2ThreadForkSourcePoint),
    targetThreadId: Schema.optional(ThreadId),
    title: Schema.optional(TrimmedNonEmptyString),
  }),
  success: Schema.Union([
    Schema.Struct({ sequence: NonNegativeInt, targetThreadId: ThreadId }),
    Schema.Struct({
      transfers: Schema.Array(
        Schema.Struct({
          id: OrchestrationV2ContextTransfer.fields.id,
          sourceThreadId: OrchestrationV2ContextTransfer.fields.sourceThreadId,
          targetThreadId: OrchestrationV2ContextTransfer.fields.targetThreadId,
          status: OrchestrationV2ContextTransfer.fields.status,
        }),
      ),
    }),
  ]),
}).annotate(Tool.Destructive, true);

const ThreadSearchTool = Tool.make("t3_thread_search", {
  ...commandTool,
  description:
    "Search active threads by title, branch, PR, project, then message text. Skips subagent threads. `projectId`: one project, else yours, else all outside a thread. Not exhaustive.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...OrchestrationSearchThreadsInput.fields,
    projectId: Schema.optional(ProjectId),
  }),
  success: Schema.Struct({
    currentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
    matches: Schema.Array(
      Schema.Struct({
        threadId: OrchestrationThreadSearchMatch.fields.threadId,
        projectId: OrchestrationThreadSearchMatch.fields.projectId,
        title: Schema.String,
        link: Schema.optional(Schema.String),
        source: Schema.Literals(["title", "user", "assistant"]),
        snippet: Schema.optional(OrchestrationThreadSearchMatch.fields.snippet),
        messageCreatedAt: Schema.optional(OrchestrationThreadSearchMatch.fields.messageCreatedAt),
      }),
    ),
  }),
  dependencies: [...commandTool.dependencies, ThreadSearch.ThreadSearch],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ScheduledTaskRunTool = Tool.make("run_scheduled_task_now", {
  ...commandTool,
  description:
    "Run one scheduled task now. Needs a full-access or default caller. Returns its thread, or null if not started. Success means started, not finished.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    taskId: ScheduledTaskId,
  }),
  success: Schema.Struct({
    taskId: ScheduledTaskId,
    threadId: ScheduledTask.fields.threadId,
    link: Schema.optional(Schema.String),
    lastRunStatus: OrchestratorMcpScheduledTaskRunStatus,
    runCount: NonNegativeInt,
    nextRunAt: ScheduledTask.fields.nextRunAt,
  }),
  dependencies: [...commandTool.dependencies, ScheduledTaskService.ScheduledTaskService],
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const ThreadToolkit = Toolkit.make(
  ScheduledTaskRunTool,
  ThreadSearchTool,
  ThreadConfigureTool,
  ThreadTransferTool,
  ThreadOrganizeTool,
  PendingRequestTool,
  ApprovalLogTool,
  QueueTool,
);
