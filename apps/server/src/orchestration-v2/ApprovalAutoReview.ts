import {
  CommandId,
  ModelSelection,
  ProviderRequestKind,
  RuntimeRequestId,
  ThreadId,
  resolveProjectProviderInstanceEnabled,
  type OrchestrationV2TurnItem,
  type RunId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as TextGenerators from "../textGeneration/TextGenerators.ts";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import { McpApprovalAnswerContext } from "../mcp/McpApprovalAnswerContext.ts";
import { forkParked } from "../serverActivation.ts";
import * as Config from "./ApprovalAutoReviewConfig.ts";
import * as Status from "./ApprovalAutoReviewStatus.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as EventSink from "./EventSink.ts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";

const involvesMoney = (text: string) =>
  /\b(buy|buying|purchas\w*|pay\w*|paid|repay\w*|prepay\w*|autopay\w*|send.?money|book\w*|rebook\w*|order\w*|checkout|cart|deposit\w*|tip\w*|charge\w*|bill\w*|invoice\w*|subscri\w*|renew\w*|spend\w*|donat\w*|transfer\w*|wire\w*|sponsor\w*|price\w*|fee\w*|refund\w*|credit.?card|stripe\w*|paypal\w*|square\w*|letsfg\w*|shopify\w*|quickbooks\w*|usd|cad|eur|gbp|aud|bitcoin|crypto)\b|[$€£¥]/iu.test(
    text
      .normalize("NFKC")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
      .replace(/[_\-.]+/g, " "),
  );

const auditText = (text: string) => makeProviderFailure({ message: text }).message.slice(0, 2000);

const isApproval = Schema.is(ProviderRequestKind);
const fingerprint = (item: OrchestrationV2TurnItem) => JSON.stringify(item);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const sameConfig = Schema.toEquivalence(
  Schema.Struct({
    override: Config.AutoReviewOverride,
    effective: Schema.NullOr(ModelSelection),
  }),
);

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const generators = yield* TextGenerators.TextGenerators;
  const settings = yield* ServerSettings.ServerSettingsService;

  const readRequest = (threadId: ThreadId, requestId: RuntimeRequestId) =>
    threads.getThreadRecords(threadId, ["runtimeRequests", "turnItems"], {
      runtimeRequestStatuses: ["pending"],
      turnItemRequestIds: [requestId],
    });
  const readMessages = Effect.fn("ApprovalAutoReview.readMessages")(function* (
    threadId: ThreadId,
    runId: RunId | null,
  ) {
    const context = yield* threads.getThreadRecords(threadId, ["messages"], {
      ...(runId === null ? { latestMessageOnly: true } : { messageRunIds: [runId] }),
      messageRoles: ["user", "assistant"],
    });
    return context.messages.slice(-12).map((message) => {
      const { role, text, createdBy, creationSource, senderClient, senderThreadId } = message;
      const automated =
        message.scheduledTaskId != null ||
        message.followsThreadSelection != null ||
        message.idleCompaction != null ||
        message.workflowScript != null ||
        message.notification != null ||
        message.delegatedCompletion != null ||
        message.linkedSender != null;
      return {
        role,
        text,
        createdBy,
        creationSource,
        senderClient,
        senderThreadId,
        scheduledTaskId: message.scheduledTaskId,
        automated,
        grantsAuthority:
          !automated &&
          role === "user" &&
          createdBy === "user" &&
          (creationSource === "web" || creationSource === "mobile") &&
          senderClient == null &&
          senderThreadId == null,
      };
    });
  });

  return Effect.fn("ApprovalAutoReview.review")(function* (
    threadId: ThreadId,
    requestId: RuntimeRequestId,
  ) {
    const config = yield* Config.read(threadId);
    if (config.effective === null) return;
    const modelSelection = config.effective;
    const initial = yield* readRequest(threadId, requestId);
    const request = initial.runtimeRequests.find((entry) => entry.id === requestId);
    const item = initial.turnItems.find(
      (entry) =>
        (entry.type === "approval_request" || entry.type === "user_input_request") &&
        entry.requestId === requestId,
    );
    if (
      !request ||
      !item ||
      initial.thread.deletedAt !== null ||
      initial.thread.archivedAt !== null
    )
      return;
    const claimed = yield* sql`INSERT INTO approval_auto_review_claims (thread_id, request_id)
      VALUES (${threadId}, ${requestId}) ON CONFLICT DO NOTHING RETURNING request_id`;
    if (claimed.length === 0) return;
    const escalate = Effect.fn("ApprovalAutoReview.escalate")(function* (reason: string) {
      const record = {
        threadId,
        requestId,
        decision: "escalate" as const,
        requestKind: request.kind,
        prompt: auditText(
          item.type === "approval_request"
            ? (item.prompt ?? "")
            : item.type === "user_input_request"
              ? yield* encodeJson(item.questions)
              : "",
        ),
        answeredAt: DateTime.formatIso(yield* DateTime.now),
        reviewer: { modelSelection, reason: auditText(reason) },
      };
      const json = yield* encodeJson(record);
      yield* sql`INSERT INTO mcp_approval_answers (thread_id, request_id, outcome, answer_json)
        VALUES (${threadId}, ${requestId}, 'refused', ${json})`;
    });
    yield* Effect.gen(function* () {
      if (item.type !== "approval_request" || !isApproval(request.kind)) {
        return yield* escalate(
          "Human questions are never answered by the reviewer; owner and ledger approvals remain human-only.",
        );
      }
      if (request.responseCapability.type !== "live" || item.fullAccessOverride !== undefined) {
        return yield* escalate("This request is not a live, single-action approval.");
      }
      const messages = yield* readMessages(threadId, item.runId);
      const evidence = yield* encodeJson({ request: item, messages });
      if (/[^\x00-\x7f]/u.test((yield* encodeJson(item)).replace(/[^\p{L}]/gu, "")))
        return yield* escalate("Non-ASCII letters in the action require human review.");
      if (involvesMoney(yield* encodeJson(item)))
        return yield* escalate("Possible spending money: fresh human approval is required.");
      if (
        evidence.length > 24000 ||
        !item.prompt?.trim() ||
        !messages.some((message) => message.grantsAuthority && message.text.trim())
      ) {
        return yield* escalate("The action or context is missing or exceeds the review budget.");
      }
      const runner = yield* generators.runner(modelSelection.instanceId);
      const provider = runner ? undefined : yield* registry.getInstance(modelSelection.instanceId);
      if (provider) {
        if (provider.driverKind !== "codex" && provider.driverKind !== "claudeAgent") {
          return yield* escalate(
            "Use a Codex, Claude or text-generator reviewer; other reviewer drivers are not isolated for review.",
          );
        }
        const snapshot = yield* provider.snapshot.getSnapshot;
        if (
          !snapshot.enabled ||
          snapshot.status === "error" ||
          snapshot.auth.status === "unauthenticated" ||
          !resolveProjectProviderInstanceEnabled(
            yield* settings.getSettings,
            initial.thread.projectId,
            modelSelection.instanceId,
          )
        ) {
          return yield* escalate("The configured reviewer is disabled or unavailable.");
        }
      }
      const reviewer = runner
        ? TextGenerationOperations.fromRunner("ApprovalAutoReview", runner).reviewApproval
        : provider?.textGeneration.reviewApproval;
      if (!reviewer) return yield* escalate("The configured model cannot review approvals.");
      const result = yield* reviewer({
        cwd: initial.thread.worktreePath ?? ".",
        evidence,
        modelSelection,
      }).pipe(Effect.timeout("60 seconds"));
      if (result.decision === "escalate") return yield* escalate(result.reason);
      const decision = result.decision === "approve" ? "accept" : "decline";
      if (
        !result.reason.trim() ||
        (item.options && !item.options.some((option) => option.decision === decision))
      ) {
        return yield* escalate("The review did not select an available single-action decision.");
      }
      const current = yield* readRequest(threadId, requestId);
      const currentConfig = yield* Config.read(threadId);
      const currentEvidence = yield* encodeJson({
        request: item,
        messages: yield* readMessages(threadId, item.runId),
      });
      if (
        !sameConfig(currentConfig, config) ||
        current.thread.deletedAt !== null ||
        current.thread.archivedAt !== null ||
        evidence !== currentEvidence ||
        !current.runtimeRequests.some((entry) => entry.id === requestId) ||
        !current.turnItems.some((entry) => fingerprint(entry) === fingerprint(item))
      ) {
        return yield* escalate("The request or auto-review configuration changed during review.");
      }
      yield* threads
        .dispatch({
          type: "runtime-request.respond",
          threadId,
          requestId,
          decision,
          commandId: CommandId.make(`auto-review:${threadId}:${requestId}`),
        })
        .pipe(
          Effect.provideService(McpApprovalAnswerContext, {
            sessionId: "auto-review",
            clientLabel: "T3 approval reviewer",
            reviewer: { modelSelection, reason: auditText(result.reason) },
            note: auditText(result.reason),
          }),
        );
    }).pipe(
      Effect.catchCause((cause) =>
        escalate(`Reviewer failed; no automatic approval was granted. ${Cause.pretty(cause)}`),
      ),
    );
  });
});

export const runWorker = Effect.fn("ApprovalAutoReview.runWorker")(function* <R>(
  afterSequence: number,
  review: (threadId: ThreadId, requestId: RuntimeRequestId) => Effect.Effect<void, never, R>,
) {
  const events = yield* EventSink.EventSinkV2;
  const status = yield* Status.ApprovalAutoReviewStatus;
  let cursor = afterSequence;
  return yield* Effect.suspend(() =>
    events.stream({ afterSequence: cursor, bounded: true }).pipe(
      Stream.mapEffect(
        (stored) =>
          Effect.gen(function* () {
            const event = stored.event;
            if (event.type === "runtime-request.updated" && event.payload.status === "pending") {
              yield* review(event.threadId, event.payload.id);
            }
            if (
              event.type === "turn-item.updated" &&
              (event.payload.type === "approval_request" ||
                event.payload.type === "user_input_request")
            ) {
              yield* review(event.threadId, event.payload.requestId);
            }
            return stored.sequence;
          }),
        { concurrency: 4 },
      ),
      Stream.runForEach((sequence) =>
        Effect.sync(() => {
          cursor = sequence;
        }),
      ),
      Effect.andThen(Effect.fail("Approval auto-review event stream ended unexpectedly.")),
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const reason = auditText(Cause.pretty(cause));
          yield* status.failed(reason);
          yield* Effect.logWarning("Approval auto-review degraded; resubscribing", {
            afterSequence: cursor,
            cause: reason,
          });
          yield* Effect.sleep("1 second");
        }),
      ),
    ),
  ).pipe(Effect.forever);
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const events = yield* EventSink.EventSinkV2;
    const afterSequence = yield* events.latestSequence();
    const review = yield* make;
    const safelyReview = (threadId: ThreadId, requestId: RuntimeRequestId) =>
      review(threadId, requestId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Approval auto-review failed closed", {
            threadId,
            requestId,
            cause: auditText(Cause.pretty(cause)),
          }),
        ),
      );
    yield* forkParked(runWorker(afterSequence, safelyReview));
    yield* forkParked(
      Effect.gen(function* () {
        const pending = yield* sql<{
          thread_id: string;
          runtime_request_id: string;
        }>`SELECT thread_id, runtime_request_id
      FROM orchestration_v2_projection_runtime_requests WHERE status = 'pending'`;
        yield* Effect.forEach(
          pending,
          (row) =>
            safelyReview(
              ThreadId.make(row.thread_id),
              RuntimeRequestId.make(row.runtime_request_id),
            ),
          { concurrency: 4, discard: true },
        );
      }),
    );
  }),
).pipe(Layer.provide(Status.layer));
