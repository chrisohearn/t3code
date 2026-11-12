import {
  CommandId,
  MessageId,
  type RunId,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { DispatchModeLimit } from "./DispatchModeLimit.ts";
import { providerFailoverNotice } from "./ProviderFailover.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

/**
 * Runs the pending failover once. Every exit resolves the claim: the dispatch marks it
 * dispatched or skipped, and a last attempt that fails or dies skips it.
 */
export const dispatchProviderFailover = Effect.fn("ProviderFailover.dispatch")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly sourceRunId: RunId;
    /** Each attempt is its own command, so a rejected attempt does not replay into the next. */
    readonly attempt: number;
    readonly willRetry: boolean;
    readonly providers: Effect.Effect<ReadonlyArray<ServerProvider>>;
  }) {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const { runs } = yield* threads.getThreadRecords(input.threadId, ["runs"]);
    const source = runs.find((run) => run.id === input.sourceRunId);
    const failover = source?.failover;
    if (source === undefined || failover?.state !== "pending") return;
    const { messages } = yield* threads.getThreadRecords(input.threadId, ["messages"], {
      messageIds: [source.userMessageId],
    });
    const message = messages.find((candidate) => candidate.id === source.userMessageId);
    if (message === undefined) {
      return yield* threads.skipProviderFailover({ threadId: input.threadId, runId: source.id });
    }
    const providers = yield* input.providers;
    const dispatch = threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`command:provider-failover:${source.id}:${input.attempt}`),
      threadId: input.threadId,
      messageId: MessageId.make(`failover:${source.id}`),
      text: message.text,
      ...(message.context === undefined ? {} : { context: message.context }),
      attachments: message.attachments,
      modelSelection: failover.modelSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: message.createdBy,
      creationSource: message.creationSource,
      ...(message.scheduledTaskId === undefined
        ? {}
        : { scheduledTaskId: message.scheduledTaskId }),
      ...(message.senderThreadId === undefined ? {} : { senderThreadId: message.senderThreadId }),
      ...(message.linkedSender === undefined ? {} : { linkedSender: message.linkedSender }),
      ...(message.senderClient === undefined ? {} : { senderClient: message.senderClient }),
      failoverOfRunId: source.id,
      failoverNotice: providerFailoverNotice({
        providers,
        from: source.providerInstanceId,
        to: failover.modelSelection,
        reason: failover.reason,
      }),
    });
    // An outside client's message stays within the modes that client was approved for.
    const access = message.senderClient?.access;
    yield* access === undefined
      ? dispatch
      : dispatch.pipe(
          Effect.provideService(DispatchModeLimit, {
            runtimeMode: access === "full-access" ? "full-access" : "approval-required",
            interactionMode: "default",
          }),
        );
  },
  (effect, input) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        input.willRetry
          ? Effect.failCause(cause)
          : Effect.logWarning("orchestration-v2.provider-failover.dispatch-failed", {
              threadId: input.threadId,
              sourceRunId: input.sourceRunId,
              cause,
            }).pipe(
              Effect.andThen(
                ThreadManagementService.ThreadManagementService.pipe(
                  Effect.flatMap((threads) =>
                    threads.skipProviderFailover({
                      threadId: input.threadId,
                      runId: input.sourceRunId,
                    }),
                  ),
                ),
              ),
            ),
      ),
    ),
);
