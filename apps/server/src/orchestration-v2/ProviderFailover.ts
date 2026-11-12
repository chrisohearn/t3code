import {
  CommandId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderFailoverReason,
  type OrchestrationV2Run,
  type OrchestrationV2RunFailover,
  type ProviderInstanceId,
  type RunId,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerSettings from "../serverSettings.ts";
import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";

/** What a terminal failure must prove before a run may move to the fallback model. */
export interface ProviderFailoverEvidence {
  readonly noWorkObserved?: true | undefined;
  readonly accountFailure?: OrchestrationV2ProviderFailoverReason | undefined;
}

/**
 * Only a prompt someone sent is re-sent. Wakes, delegated results, compaction and slash
 * commands are provider-specific or have their own recovery.
 */
function resendable(message: OrchestrationV2ConversationMessage): boolean {
  return (
    message.role === "user" &&
    message.notification === undefined &&
    message.delegatedCompletion === undefined &&
    message.idleCompaction === undefined &&
    message.workflowScript !== true &&
    !message.text.trimStart().startsWith("/")
  );
}

/** The fallback this run would move to, decided before it starts; undefined keeps today's behavior. */
export function providerFailoverTarget(input: {
  readonly run: OrchestrationV2Run;
  readonly message: OrchestrationV2ConversationMessage | undefined;
  /** Evidence covers one turn; a run that already ran an earlier attempt may have done work. */
  readonly firstAttempt: boolean;
  readonly fallback: ModelSelection | null;
}): ModelSelection | undefined {
  const { run, message, fallback } = input;
  if (
    !input.firstAttempt ||
    fallback === null ||
    // The account that failed is the one the fallback would use.
    fallback.instanceId === run.providerInstanceId ||
    run.failover !== undefined ||
    run.failoverOfRunId !== undefined ||
    run.restartContinuationOfRunId !== undefined ||
    message === undefined ||
    !resendable(message)
  )
    return undefined;
  return fallback;
}

export const resolveProviderFailoverTarget = Effect.fn("ProviderFailover.resolveTarget")(
  function* (input: {
    readonly thread: Pick<OrchestrationV2AppThread, "projectId">;
    readonly run: OrchestrationV2Run;
    readonly message: OrchestrationV2ConversationMessage | undefined;
    readonly firstAttempt: boolean;
  }) {
    const settings = yield* ServerSettings.ServerSettingsService.pipe(
      Effect.flatMap((service) => service.getSettings),
      Effect.option,
    );
    if (Option.isNone(settings)) return undefined;
    return providerFailoverTarget({
      ...input,
      fallback: resolveProjectSettings(settings.value, input.thread.projectId).settings
        .fallbackModelSelection,
    });
  },
);

/** The claim a failed terminal earns: the adapter must prove no work and name an account cause. */
export function providerFailoverClaim(
  target: ModelSelection | undefined,
  evidence: ProviderFailoverEvidence,
): OrchestrationV2RunFailover | undefined {
  return target === undefined ||
    evidence.noWorkObserved !== true ||
    evidence.accountFailure === undefined
    ? undefined
    : { state: "pending", reason: evidence.accountFailure, modelSelection: target };
}

export function providerFailoverEffect(
  threadId: ThreadId,
  sourceRunId: RunId,
): PendingOrchestrationEffectV2 {
  return {
    id: `effect:provider-failover:${sourceRunId}`,
    commandId: CommandId.make(`command:effect:provider-failover:${sourceRunId}`),
    threadId,
    request: { type: "run.failover", sourceRunId },
  };
}

const REASON_TEXT: Record<OrchestrationV2ProviderFailoverReason, string> = {
  usage_limit: "hit its usage limit",
  auth: "could not sign in",
  billing: "hit a billing error",
};

export function providerFailoverNotice(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly from: ProviderInstanceId;
  readonly to: ModelSelection;
  readonly reason: OrchestrationV2ProviderFailoverReason;
}): string {
  const instanceName = (id: ProviderInstanceId) =>
    input.providers.find((provider) => provider.instanceId === id)?.displayName ?? id;
  const target = input.providers.find((provider) => provider.instanceId === input.to.instanceId);
  const modelName =
    target?.models.find((model) => model.slug === input.to.model)?.name ?? input.to.model;
  return `Switched to ${modelName} after ${instanceName(input.from)} ${REASON_TEXT[input.reason]}.`;
}
