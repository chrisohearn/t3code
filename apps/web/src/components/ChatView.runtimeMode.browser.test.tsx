import { createMemoryHistory } from "@tanstack/react-router";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { OrchestrationV2Command } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform (React Compiler over ~4k lines)
// takes 6-11s; importing it here keeps that out of the test's timeout.
import "~/components/ChatView";
import { useRuntimeModePickStore } from "~/components/chat/runtimeModePickStore";
import { useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  dispatchedCommands,
  emitThreadShellUpdate,
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
const revertedThread = threadWithHistory("thread-mode-reverted", 1);
const sendingThread = threadWithHistory("thread-mode-sending", 1);
const savedDraftThread = threadWithHistory("thread-mode-saved-draft", 1);
const ACTIVE_STATUSES = ["preparing", "starting", "running", "waiting"] as const;
const activeThreads = ACTIVE_STATUSES.map((status) => {
  const idle = threadWithHistory(`thread-mode-${status}`, 1);
  const live = runningRun(idle.id, `thread-mode-${status}-live`, 2, "live-user");
  return { ...idle, runs: [...idle.runs, { ...live, status }] };
});
// The app's shell subscription outlives a test, so every test lists every thread.
const allThreads = [
  idleThread,
  refusedThread,
  revertedThread,
  sendingThread,
  savedDraftThread,
  ...activeThreads,
];

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

const threadRef = (thread: FakeThread) => scopeThreadRef(ENVIRONMENT_ID, thread.id);

const pendingPick = (thread: FakeThread) =>
  useRuntimeModePickStore.getState().picks[scopedThreadKey(threadRef(thread))]?.mode ?? null;

const holdRuntimeModeCommands = (command: OrchestrationV2Command) =>
  command.type === "thread.runtime-mode.set";

async function typeAndSend(text: string) {
  await userEvent.click(page.getByTestId("composer-editor"));
  await userEvent.keyboard(`${text}{Enter}`);
}

const messageSent = () =>
  vi.waitFor(() =>
    expect(dispatchedCommands().map((command) => command.type)).toContain("message.dispatch"),
  );

it("a permissions pick on an idle thread reaches the server before any message is sent", async () => {
  const thread = idleThread;
  await using _app = await openThread(thread);

  await pickSupervised();
  await vi.waitFor(() =>
    expect(runtimeModeCommands()).toEqual([
      expect.objectContaining({ threadId: thread.id, runtimeMode: "approval-required" }),
    ]),
  );
  // The pick holds until the shell shows it, then the server's value takes over.
  expect(pendingPick(thread)).toBe("approval-required");
  await emitThreadShellUpdate(thread.id, { runtimeMode: "approval-required" });
  await vi.waitFor(() => expect(pendingPick(thread)).toBeNull());
  await expect
    .element(page.getByRole("button", { name: "Permissions: Supervised" }).first())
    .toBeVisible();
});

it("a refused permissions change shows the server's reason and the server's mode", async () => {
  const thread = refusedThread;
  await using _app = await openThread(thread, { holdCommand: holdRuntimeModeCommands });

  await pickSupervised();
  await vi.waitFor(() => expect(runtimeModeCommands()).toHaveLength(1));
  // The picker's control; the footer chip also appears once the mode leaves the default.
  await expect
    .element(page.getByRole("button", { name: "Permissions: Supervised" }).first())
    .toBeVisible();
  await rejectPendingCommand("The current session is still running background agents.");

  await expect.element(page.getByText("Could not change permissions")).toBeVisible();
  await expect
    .element(page.getByText("The current session is still running background agents."))
    .toBeVisible();
  expect(pendingPick(thread)).toBeNull();
  // The model picker stays open after the permissions pick.
  await expect
    .element(page.getByRole("button", { name: "Permissions: Full access" }))
    .toBeVisible();
});

it("returning to the server's mode before a pick lands sends that mode too", async () => {
  const thread = revertedThread;
  await using _app = await openThread(thread, { holdCommand: holdRuntimeModeCommands });

  await pickSupervised();
  await page.getByRole("button", { name: "Permissions: Supervised" }).first().click();
  await page.getByRole("menuitemradio", { name: "Full access" }).click();
  // Commands on one thread run in order, so the second waits for the first's reply.
  await vi.waitFor(() => expect(runtimeModeCommands()).toHaveLength(1));
  await rejectPendingCommand("Refused.");
  await vi.waitFor(() =>
    expect(runtimeModeCommands().map((command) => command.runtimeMode)).toEqual([
      "approval-required",
      "full-access",
    ]),
  );
  // The older pick's refusal neither toasts nor takes over the newer pick.
  expect(pendingPick(thread)).toBe("full-access");
  await expect.element(page.getByText("Could not change permissions")).not.toBeInTheDocument();
});

it("a send while a pick is pending does not set the mode again", async () => {
  const thread = sendingThread;
  await using _app = await openThread(thread, { holdCommand: holdRuntimeModeCommands });

  await pickSupervised();
  await vi.waitFor(() => expect(runtimeModeCommands()).toHaveLength(1));
  await userEvent.keyboard("{Escape}");
  await typeAndSend("Go");
  // The send queues behind the pick; releasing the pick lets only the message through.
  await rejectPendingCommand("Refused.");
  await messageSent();
  expect(runtimeModeCommands()).toHaveLength(1);
});

it("a mode saved in an older draft neither shows nor reaches the server", async () => {
  const thread = savedDraftThread;
  useComposerDraftStore.getState().setRuntimeMode(threadRef(thread), "approval-required");
  await using _app = await openThread(thread);

  await page.getByRole("button", { name: "GPT-5.4", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Permissions: Full access" }))
    .toBeVisible();
  await userEvent.keyboard("{Escape}");
  await typeAndSend("Go");
  await messageSent();
  expect(runtimeModeCommands()).toEqual([]);
});

it.each(activeThreads)("a permissions pick is refused while $id works", async (thread) => {
  await using _app = await openThread(thread);

  await pickSupervised();
  await expect.element(page.getByText("Permissions not changed")).toBeVisible();
  expect(runtimeModeCommands()).toEqual([]);
  expect(pendingPick(thread)).toBeNull();
});
