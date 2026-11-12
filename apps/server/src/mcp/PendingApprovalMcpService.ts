import {
  OrchestrationV2McpApprovalAnswer,
  OrchestratorMcpFailure,
  ProviderRequestKind,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Invocation from "./McpInvocationContext.ts";
import { McpApprovalAnswerContext } from "./McpApprovalAnswerContext.ts";
import {
  assertFullAccess,
  dispatchFailure,
  newCommandId,
  readCaller,
  readThread,
  unavailable,
} from "./threadAccess.ts";

export const ApprovalDetails = OrchestrationV2McpApprovalAnswer.fields.requested;
export const ApprovalLogResult = Schema.Struct({
  records: Schema.Array(OrchestrationV2McpApprovalAnswer),
  nextCursor: Schema.NullOr(Schema.Number),
});
const isApproval = Schema.is(ProviderRequestKind);
const decodeAnswer = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2McpApprovalAnswer),
);
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
        yield* Invocation.assertOutsideApprovalCaller(scope);
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
            Effect.provideService(McpApprovalAnswerContext, {
              sessionId: scope.client!.approvalOrigin?.sessionId ?? scope.client!.sessionId,
              clientLabel: scope.client!.approvalOrigin?.clientLabel ?? scope.client!.label,
              originEnvironmentId:
                scope.client!.approvalOrigin?.environmentId ?? scope.environmentId,
              ...(scope.client!.approvalOrigin === undefined
                ? {}
                : {
                    forwardedBy: {
                      sessionId: scope.client!.sessionId,
                      clientLabel: scope.client!.label,
                    },
                  }),
              ...(input.note === undefined ? {} : { note: input.note }),
            }),
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
