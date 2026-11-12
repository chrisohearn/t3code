import { RegistryContext } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { RuntimeMode, ScopedThreadRef } from "@t3tools/contracts";
import { useContext, useEffect, useRef } from "react";

import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { useRuntimeModePickStore } from "./runtimeModePickStore";

// Bounds a pick the shell never shows, such as one another client changed again first.
const SHELL_CONFIRMATION_TIMEOUT_MS = 10_000;

/** Sets a server thread's runtime mode now; the pick shows until the thread shell has it. */
export function useApplyThreadRuntimeMode() {
  const registry = useContext(RegistryContext);
  const setThreadRuntimeMode = useOrchestrationCommand(threadEnvironment.setRuntimeMode, {
    label: "change permissions",
  });
  const pendingConfirmations = useRef(new Set<() => void>());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- ends shell subscriptions and timers this composer started
  useEffect(() => {
    const confirmations = pendingConfirmations.current;
    return () => {
      for (const stop of confirmations) stop();
    };
  }, []);

  return async (threadRef: ScopedThreadRef, mode: RuntimeMode) => {
    const threadKey = scopedThreadKey(threadRef);
    const picks = useRuntimeModePickStore.getState();
    const pick = { mode };
    picks.hold(threadKey, pick);
    const result = await setThreadRuntimeMode({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, runtimeMode: mode },
    });
    if (result._tag === "Success") {
      // The reply can beat the shell update; releasing before it lands flashes the old mode.
      const shellAtom = environmentThreadShells.threadShellAtom(threadRef);
      if (registry.get(shellAtom)?.runtimeMode === mode) {
        picks.release(threadKey, pick);
        return;
      }
      const unsubscribe = registry.subscribe(shellAtom, (shell) => {
        if (shell?.runtimeMode === mode) stop();
      });
      const timer = setTimeout(() => stop(), SHELL_CONFIRMATION_TIMEOUT_MS);
      const stop = () => {
        unsubscribe();
        clearTimeout(timer);
        pendingConfirmations.current.delete(stop);
        picks.release(threadKey, pick);
      };
      pendingConfirmations.current.add(stop);
      return;
    }
    if (!picks.release(threadKey, pick)) return;
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not change permissions",
          description: error instanceof Error ? error.message : "Try again.",
        }),
      );
    }
  };
}
