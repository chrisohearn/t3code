import {
  CommandId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderFailoverReason,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2Run,
  type OrchestrationV2RunFailover,
  type ProviderInstanceId,
  type RunId,
  type ServerProvider,
  type ThreadId,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerSettings from "../serverSettings.ts";
import * as ProviderCooldown from "../provider/ProviderCooldown.ts";
import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";

/** What a terminal failure must prove before a run may move to the fallback model. */
export interface ProviderFailoverEvidence {
  readonly noWorkObserved?: true | undefined;
  readonly accountFailure?: OrchestrationV2ProviderFailoverReason | undefined;
  readonly failure?: OrchestrationV2ProviderFailure | undefined;
}

export interface ProviderFailoverTargets {
  readonly account: ModelSelection | undefined;
  readonly model: ModelSelection | undefined;
}

/**
 * Only a prompt someone sent is re-sent. Wakes, delegated results, compaction and slash
 * commands are provider-specific or have their own recovery.
 */
function resendable(
  message: Pick<
    OrchestrationV2ConversationMessage,
    "role" | "notification" | "delegatedCompletion" | "idleCompaction" | "workflowScript" | "text"
  >,
): boolean {
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
  readonly secondaryFallback?: ModelSelection | null;
  readonly limitScope?: "account" | "model";
}): ModelSelection | undefined {
  const { run, message, fallback } = input;
  if (
    !input.firstAttempt ||
    run.failover !== undefined ||
    run.failoverOfRunId !== undefined ||
    run.restartContinuationOfRunId !== undefined ||
    message === undefined ||
    !resendable(message)
  )
    return undefined;
  const eligible = (target: ModelSelection | null | undefined) =>
    target != null &&
    (target.instanceId !== run.providerInstanceId ||
      (input.limitScope === "model" && target.model !== run.modelSelection.model));
  if (fallback !== null && eligible(fallback)) return fallback;
  return fallback?.instanceId === run.providerInstanceId &&
    input.secondaryFallback != null &&
    eligible(input.secondaryFallback)
    ? input.secondaryFallback
    : undefined;
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
    const project = resolveProjectSettings(settings.value, input.thread.projectId).settings;
    const cooldownService = yield* Effect.serviceOption(ProviderCooldown.ProviderCooldown);
    const cooldowns = Option.isSome(cooldownService)
      ? yield* cooldownService.value.getAll
      : new Map();
    const available = (selection: ModelSelection | null) =>
      selection !== null &&
      resolveProjectProviderInstanceEnabled(
        settings.value,
        input.thread.projectId,
        selection.instanceId,
      ) &&
      !cooldowns.has(selection.instanceId)
        ? selection
        : null;
    const targetInput = {
      ...input,
      fallback: available(project.fallbackModelSelection),
      secondaryFallback: available(settings.value.secondaryFallbackModelSelection),
    };
    return {
      account: providerFailoverTarget(targetInput),
      model: providerFailoverTarget({ ...targetInput, limitScope: "model" }),
    };
  },
);

export const resolveProviderCooldownTarget = Effect.fn("ProviderFailover.resolveCooldownTarget")(
  function* (input: {
    readonly projectId: OrchestrationV2AppThread["projectId"];
    readonly modelSelection: ModelSelection;
    readonly message: Pick<
      OrchestrationV2ConversationMessage,
      "role" | "notification" | "delegatedCompletion" | "idleCompaction" | "workflowScript" | "text"
    >;
    readonly cooldown: ProviderCooldown.ProviderCooldown["Service"];
    readonly settings: ServerSettings.ServerSettingsService["Service"];
  }) {
    if (!resendable(input.message)) return input.modelSelection;
    const cooldowns = yield* input.cooldown.getAll;
    if (!cooldowns.has(input.modelSelection.instanceId)) return input.modelSelection;
    const settingsOption = yield* input.settings.getSettings.pipe(Effect.option);
    if (Option.isNone(settingsOption)) return input.modelSelection;
    const settings = settingsOption.value;
    const project = resolveProjectSettings(settings, input.projectId).settings;
    return (
      [project.fallbackModelSelection, settings.secondaryFallbackModelSelection].find(
        (candidate) =>
          candidate !== null &&
          candidate.instanceId !== input.modelSelection.instanceId &&
          !cooldowns.has(candidate.instanceId) &&
          resolveProjectProviderInstanceEnabled(settings, input.projectId, candidate.instanceId),
      ) ?? input.modelSelection
    );
  },
);

/** The claim a failed terminal earns: the adapter must prove no work and name an account cause. */
export function providerFailoverClaim(
  targets: ProviderFailoverTargets | undefined,
  evidence: ProviderFailoverEvidence,
): OrchestrationV2RunFailover | undefined {
  const target =
    evidence.accountFailure === "usage_limit" && evidence.failure?.limitScope === "model"
      ? targets?.model
      : targets?.account;
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
