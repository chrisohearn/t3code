import { createMemoryHistory } from "@tanstack/react-router";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { OrchestrationV2Command } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform (React Compiler over ~4k lines)
// takes 6-11s; importing it here keeps that out of the test's timeout.
import "~/components/ChatView";
import { useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  dispatchedCommands,
  installFakeEnvironment,
  rejectPendingCommand,
  runningRun,
  threadWithHistory,
  type FakeDriver,
  type FakeThread,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver, installFakeEnvironment }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  // Discovery can start before the test installs its threads.
  installFakeEnvironment([]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const idleThread = threadWithHistory("thread-mode-pick", 1);
const refusedThread = threadWithHistory("thread-mode-refused", 1);
const runningThread = (() => {
  const idle = threadWithHistory("thread-mode-running", 1);
  return {
    ...idle,
    runs: [...idle.runs, runningRun(idle.id, "thread-mode-running-live", 2, "live-user")],
  };
})();
// The app's shell subscription outlives a test, so every test lists every thread.
const allThreads = [idleThread, refusedThread, runningThread];

async function openThread(
  thread: FakeThread,
  options: { readonly holdCommand?: (command: OrchestrationV2Command) => boolean } = {},
) {
  const stack = new AsyncDisposableStack();
  try {
    stack.use(installFakeEnvironment(allThreads, { acceptCommands: true, ...options }));
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    });
    const router = getRouter(
      createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
    );
    await router.load();
    // AppRoot brings its own router.
    stack.use(await render(<AppRoot router={router} />, { router: false }));
    await expect.element(page.getByText(`Answer 0 for ${thread.id}.`)).toBeVisible();
    return stack.move();
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}

// Permissions sit in the model picker's footer while they match the default.
async function pickSupervised() {
  await page.getByRole("button", { name: "GPT-5.4", exact: true }).click();
  await page.getByRole("button", { name: "Permissions: Full access" }).click();
  await page.getByRole("menuitemradio", { name: "Supervised" }).click();
}

const runtimeModeCommands = () =>
  dispatchedCommands().filter((command) => command.type === "thread.runtime-mode.set");

const draftRuntimeMode = (thread: FakeThread) =>
  useComposerDraftStore.getState().draftsByThreadKey[
    scopedThreadKey(scopeThreadRef(ENVIRONMENT_ID, thread.id))
  ]?.runtimeMode ?? null;

it("a permissions pick on an idle thread reaches the server before any message is sent", async () => {
  const thread = idleThread;
  await using _app = await openThread(thread);

  await pickSupervised();
  await vi.waitFor(() =>
    expect(runtimeModeCommands()).toEqual([
      expect.objectContaining({ threadId: thread.id, runtimeMode: "approval-required" }),
    ]),
  );
  // The server's value takes over, so a later send cannot carry a stale pick.
  await vi.waitFor(() => expect(draftRuntimeMode(thread)).toBeNull());
});

it("a refused permissions change shows the server's reason and the server's mode", async () => {
  const thread = refusedThread;
  await using _app = await openThread(thread, {
    holdCommand: (command) => command.type === "thread.runtime-mode.set",
  });

  await pickSupervised();
  await vi.waitFor(() => expect(runtimeModeCommands()).toHaveLength(1));
  expect(draftRuntimeMode(thread)).toBe("approval-required");
  await rejectPendingCommand("The current session is still running background agents.");

  await expect.element(page.getByText("Could not change permissions")).toBeVisible();
  await expect
    .element(page.getByText("The current session is still running background agents."))
    .toBeVisible();
  expect(draftRuntimeMode(thread)).toBeNull();
});

it("a permissions pick during a run is refused without reaching the server", async () => {
  const thread = runningThread;
  await using _app = await openThread(thread);

  await pickSupervised();
  await expect.element(page.getByText("Permissions not changed")).toBeVisible();
  expect(runtimeModeCommands()).toEqual([]);
  expect(draftRuntimeMode(thread)).toBeNull();
});
