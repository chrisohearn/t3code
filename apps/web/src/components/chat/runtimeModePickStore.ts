import type { RuntimeMode } from "@t3tools/contracts";
import { create } from "zustand";

/** One permissions pick; its identity tells it apart from a later pick of the same mode. */
export interface RuntimeModePick {
  readonly mode: RuntimeMode;
}

interface RuntimeModePickState {
  /** Server-thread picks waiting to show in the thread shell, by scoped thread key. */
  readonly picks: Readonly<Record<string, RuntimeModePick>>;
  readonly hold: (threadKey: string, pick: RuntimeModePick) => void;
  /** Drops the pick unless a newer one replaced it. Returns whether it was still held. */
  readonly release: (threadKey: string, pick: RuntimeModePick) => boolean;
}

// Not persisted: a pick the server has not confirmed must not outlive this page.
export const useRuntimeModePickStore = create<RuntimeModePickState>()((set, get) => ({
  picks: {},
  hold: (threadKey, pick) => set((state) => ({ picks: { ...state.picks, [threadKey]: pick } })),
  release: (threadKey, pick) => {
    if (get().picks[threadKey] !== pick) return false;
    set((state) => {
      const { [threadKey]: _released, ...picks } = state.picks;
      return { picks };
    });
    return true;
  },
}));
