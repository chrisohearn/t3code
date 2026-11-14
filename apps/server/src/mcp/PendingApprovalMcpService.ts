import {
  OrchestrationV2McpApprovalAnswer,
  OrchestratorMcpFailure,
  ProviderRequestKind,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Invocation from "./McpInvocationContext.ts";
import { ApprovalReviewEscalation, McpApprovalAnswerContext } from "./McpApprovalAnswerContext.ts";
import {
  assertFullAccess,
  dispatchFailure,
  newCommandId,
  readCaller,
  readThread,
  unavailable,
} from "./threadAccess.ts";

export const ApprovalDetails = OrchestrationV2McpApprovalAnswer.fields.requested;
const ApprovalRefusal = Schema.Struct({
  ...OrchestrationV2McpApprovalAnswer.fields,
  threadId: Schema.optional(OrchestrationV2McpApprovalAnswer.fields.threadId),
  requested: Schema.optional(ApprovalDetails),
  decision: Schema.Literal("refused"),
  attemptedDecision: OrchestrationV2McpApprovalAnswer.fields.decision,
  reason: Schema.String,
});
const ApprovalRecord = Schema.Union([
  OrchestrationV2McpApprovalAnswer,
  ApprovalRefusal,
  ApprovalReviewEscalation,
]);
export const ApprovalLogResult = Schema.Struct({
  records: Schema.Array(ApprovalRecord),
  nextCursor: Schema.NullOr(Schema.Number),
});
const isApproval = Schema.is(ProviderRequestKind);
const decodeAnswer = Schema.decodeUnknownEffect(Schema.fromJsonString(ApprovalRecord));
const encodeRefusal = Schema.encodeEffect(Schema.fromJsonString(ApprovalRefusal));
const readApproval = Effect.fn("PendingApprovalMcpService.readApproval")(function* (
  scope: Invocation.McpInvocationScope,
  input: { threadId?: ThreadId | undefined; requestId: RuntimeRequestId },
) {
  const context = yield* readThread(input.threadId, ["runtimeRequests", "turnItems"]).pipe(
    Effect.provideService(Invocation.McpInvocationContext, scope),
  );
  const request = context.projection.runtimeRequests.find(
    (request) => request.id === input.requestId,
  );
  const item = context.projection.turnItems.find(
    (item) => item.type === "approval_request" && item.requestId === input.requestId,
  );
  if (
    request === undefined ||
    !isApproval(request.kind) ||
    item?.type !== "approval_request" ||
    request.status !== "pending"
  ) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "The approval is not pending or was already answered.",
    });
  }
  return { ...context, request, item };
});

export class PendingApprovalMcpService extends Context.Service<
  PendingApprovalMcpService,
  {
    readonly read: (
      scope: Invocation.McpInvocationScope,
      input: { threadId?: ThreadId | undefined; requestId: RuntimeRequestId },
    ) => Effect.Effect<
      { requestId: RuntimeRequestId; approval: typeof ApprovalDetails.Type },
      OrchestratorMcpFailure
    >;
    readonly respond: (
      scope: Invocation.McpInvocationScope,
      input: {
        threadId?: ThreadId | undefined;
        requestId: RuntimeRequestId;
        decision: "accept" | "decline";
        note?: string;
      },
    ) => Effect.Effect<{ sequence: number }, OrchestratorMcpFailure>;
    readonly list: (
      scope: Invocation.McpInvocationScope,
      input: {
        threadId?: ThreadId | undefined;
        cursor?: number | undefined;
        limit?: number | undefined;
      },
    ) => Effect.Effect<typeof ApprovalLogResult.Type, OrchestratorMcpFailure>;
  }
>()("t3/mcp/PendingApprovalMcpService") {}

export const layer = Layer.effect(
  PendingApprovalMcpService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const random = yield* SecureRandom.SecureRandom;
    return PendingApprovalMcpService.of({
      read: Effect.fn("PendingApprovalMcpService.read")(function* (scope, input) {
        const { item } = yield* readApproval(scope, input).pipe(
          Effect.provideService(ThreadManagement.ThreadManagementService, threads),
        );
        return {
          requestId: input.requestId,
          approval: {
            requestKind: item.requestKind,
            ...(item.prompt === undefined ? {} : { prompt: item.prompt }),
            ...(item.reason === undefined ? {} : { reason: item.reason }),
            ...(item.appName === undefined ? {} : { appName: item.appName }),
          },
        };
      }),
      respond: Effect.fn("PendingApprovalMcpService.respond")(function* (scope, input) {
        if (scope.thread !== undefined || scope.client?.linked !== true)
          yield* Invocation.assertOutsideApprovalCaller(scope);
        const attribution = {
          sessionId: scope.client!.approvalOrigin?.sessionId ?? scope.client!.sessionId,
          clientLabel: scope.client!.approvalOrigin?.clientLabel ?? scope.client!.label,
          ...(scope.client!.approvalOrigin !== undefined
            ? { originEnvironmentId: scope.client!.approvalOrigin.environmentId }
            : scope.client!.linked === true
              ? {}
              : { originEnvironmentId: scope.environmentId }),
          ...(scope.client!.linked !== true
            ? {}
            : {
                forwardedBy: {
                  sessionId: scope.client!.sessionId,
                  clientLabel: scope.client!.label,
                },
              }),
          ...(input.note === undefined ? {} : { note: input.note }),
        };
        if (scope.thread === undefined && scope.client?.linked === true) {
          const reason =
            "Forwarded approval answers are refused. Answer through a direct sign-in to the target server with Full access.";
          const approval = yield* readApproval(scope, input).pipe(
            Effect.provideService(ThreadManagement.ThreadManagementService, threads),
            Effect.option,
          );
          const details = approval._tag === "Some" ? approval.value : undefined;
          const json = yield* encodeRefusal({
            ...attribution,
            ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
            requestId: input.requestId,
            ...(details === undefined
              ? {}
              : {
                  requested: {
                    requestKind: details.item.requestKind,
                    ...(details.item.prompt === undefined ? {} : { prompt: details.item.prompt }),
                    ...(details.item.reason === undefined ? {} : { reason: details.item.reason }),
                    ...(details.item.appName === undefined
                      ? {}
                      : { appName: details.item.appName }),
                  },
                }),
            decision: "refused",
            attemptedDecision: input.decision,
            answeredAt: DateTime.formatIso(yield* DateTime.now),
            reason,
          }).pipe(Effect.mapError(unavailable));
          yield* sql`INSERT INTO mcp_approval_answers (thread_id, request_id, outcome, answer_json)
            VALUES (${input.threadId ?? null}, ${input.requestId}, 'refused', ${json})`.pipe(
            Effect.mapError(unavailable),
          );
          return yield* new OrchestratorMcpFailure({ code: "capability_denied", message: reason });
        }
        const { projection } = yield* readApproval(scope, input).pipe(
          Effect.provideService(ThreadManagement.ThreadManagementService, threads),
        );
        return yield* threads
          .dispatch({
            type: "runtime-request.respond",
            threadId: projection.thread.id,
            commandId: yield* newCommandId().pipe(
              Effect.provideService(SecureRandom.SecureRandom, random),
            ),
            requestId: input.requestId,
            decision: input.decision,
          })
          .pipe(
            Effect.provideService(McpApprovalAnswerContext, attribution),
            Effect.mapError(dispatchFailure),
            Effect.map(({ sequence }) => ({ sequence })),
          );
      }),
      list: Effect.fn("PendingApprovalMcpService.list")(function* (scope, input) {
        yield* assertFullAccess(
          yield* readCaller().pipe(
            Effect.provideService(Invocation.McpInvocationContext, scope),
            Effect.provideService(ThreadManagement.ThreadManagementService, threads),
          ),
          "read approval answers",
        );
        const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
        const rows = yield* sql<{
          id: number;
          answer_json: string;
        }>`SELECT id, answer_json FROM mcp_approval_answers
        WHERE id > ${input.cursor ?? 0} ${input.threadId === undefined ? sql`` : sql`AND thread_id = ${input.threadId}`}
        ORDER BY id LIMIT ${limit + 1}`.pipe(Effect.mapError(unavailable));
        const page = rows.slice(0, limit);
        const records = yield* Effect.forEach(page, (row) =>
          decodeAnswer(row.answer_json).pipe(Effect.mapError(unavailable)),
        );
        return { records, nextCursor: rows.length > limit ? page.at(-1)!.id : null };
      }),
    });
  }),
);
