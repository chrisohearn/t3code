import type {
  OrchestrationV2AppThread,
  OrchestrationV2Command,
  ThreadFreeze,
  ThreadFreezeActor,
  UserInputAnsweredBy,
} from "@t3tools/contracts";
import * as Context from "effect/Context";

/**
 * Proof that the command comes from the gated `t3_thread_organize` action, which has checked its
 * caller like `t3_thread_interrupt` does. A raw WebSocket command never carries it, so it cannot
 * set or fake a freeze marker.
 */
export class ThreadFreezeGate extends Context.Service<
  ThreadFreezeGate,
  | { readonly op: "freeze" }
  | {
      readonly op: "unfreeze";
      readonly by: ThreadFreezeActor;
      readonly at: string;
      readonly freshContext: boolean;
    }
>()("t3/orchestration-v2/ThreadFreeze/ThreadFreezeGate") {}

/** Only a paired owner client lifts a freeze by acting; agents and outside sign-ins must unfreeze. */
export const liftsFreeze = (actor: UserInputAnsweredBy | undefined): boolean =>
  actor === "owner_client";

export const frozenRefusal = (freeze: ThreadFreeze): string =>
  `This thread is frozen by ${freeze.by.label}${
    freeze.by.sessionId === undefined ? "" : ` (${freeze.by.sessionId})`
  } since ${freeze.at}: ${freeze.reason}. Unfreeze it first.`;

export const FREEZE_GATE_REFUSAL = "A freeze is set and lifted only through t3_thread_organize.";

/** The thread after a freeze lifts: marker cleared, who lifted it, and a fresh next turn if asked. */
export const liftedThread = (
  thread: OrchestrationV2AppThread,
  lift: { readonly by: ThreadFreezeActor; readonly at: string; readonly freshContext: boolean },
): OrchestrationV2AppThread => ({
  ...thread,
  frozen: null,
  unfrozen: { at: lift.at, by: lift.by },
  ...(lift.freshContext ? { nextTurnFreshContext: true } : {}),
});

/** The `thread.metadata.update` field that sets the freeze marker. */
export const threadFreezePatch = (
  command: Extract<OrchestrationV2Command, { readonly type: "thread.metadata.update" }>,
): Partial<Pick<OrchestrationV2AppThread, "frozen" | "unfrozen">> =>
  command.frozen === undefined ? {} : { frozen: command.frozen, unfrozen: null };

/** The recorded actor for a paired owner client, from the transport's command actor. */
export const ownerActor = (actor: {
  readonly client?: { readonly sessionId: string; readonly clientLabel: string } | undefined;
}): ThreadFreezeActor => ({
  kind: "owner",
  label: (actor.client?.clientLabel ?? "owner").slice(0, 128),
  ...(actor.client === undefined ? {} : { sessionId: actor.client.sessionId }),
});
