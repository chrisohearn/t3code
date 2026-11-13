import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  ProviderInstanceId,
  RunId,
  ThreadId,
  ProjectId,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  providerFailoverClaim,
  providerFailoverTarget,
  resolveProviderCooldownTarget,
  resolveProviderFailoverTarget,
} from "./ProviderFailover.ts";
import * as ProviderCooldown from "../provider/ProviderCooldown.ts";
import * as ServerSettings from "../serverSettings.ts";

const now = DateTime.makeUnsafe("2026-11-12T17:10:00Z");
const threadId = ThreadId.make("thread:failover");
const limited = { instanceId: ProviderInstanceId.make("codex_e6f5e4dd"), model: "gpt-5.5" };
const fallback = {
  instanceId: ProviderInstanceId.make("claude"),
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: "high" }],
};
const run: OrchestrationV2Run = {
  id: RunId.make("run:20"),
  threadId,
  ordinal: 20,
  providerInstanceId: limited.instanceId,
  modelSelection: limited,
  providerThreadId: null,
  userMessageId: MessageId.make("message:20"),
  rootNodeId: NodeId.make("node:20"),
  activeAttemptId: null,
  status: "running",
  requestedAt: now,
  startedAt: now,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
};
const message: OrchestrationV2ConversationMessage = {
  id: run.userMessageId,
  threadId,
  runId: run.id,
  nodeId: null,
  role: "user",
  text: "Queue this for Jarvis.",
  attachments: [],
  streaming: false,
  createdBy: "agent",
  creationSource: "mcp",
  createdAt: now,
  updatedAt: now,
};

describe("provider failover", () => {
  it("moves only an eligible prompt to a configured fallback on another instance", () => {
    assert.deepEqual(
      providerFailoverTarget({ run, message, firstAttempt: true, fallback }),
      fallback,
    );
    const cases: ReadonlyArray<
      [string, Omit<Parameters<typeof providerFailoverTarget>[0], "firstAttempt">]
    > = [
      ["no fallback configured", { run, message, fallback: null }],
      ["fallback on the failed instance", { run, message, fallback: { ...limited, model: "o" } }],
      [
        "a failover run",
        { run: { ...run, failoverOfRunId: RunId.make("run:19") }, message, fallback },
      ],
      [
        "an already claimed run",
        {
          run: { ...run, failover: { state: "skipped", reason: "auth", modelSelection: fallback } },
          message,
          fallback,
        },
      ],
      [
        "a restart continuation",
        { run: { ...run, restartContinuationOfRunId: RunId.make("run:19") }, message, fallback },
      ],
      ["a slash command", { run, message: { ...message, text: "/compact" }, fallback }],
      [
        "a wake",
        {
          run,
          message: {
            ...message,
            notification: { source: { kind: "system" }, outcome: "updated", summary: "Woke" },
          },
          fallback,
        },
      ],
      ["a missing message", { run, message: undefined, fallback }],
    ];
    for (const [name, input] of cases) {
      assert.isUndefined(providerFailoverTarget({ ...input, firstAttempt: true }), name);
    }
    assert.isUndefined(
      providerFailoverTarget({ run, message, firstAttempt: false, fallback }),
      "a run whose earlier attempt may have worked",
    );
  });

  it("claims only with positive no-work evidence and an account cause", () => {
    const alternate = { ...limited, model: "alternate" };
    const targets = { account: fallback, model: alternate };
    const failure = {
      class: "usage_limit" as const,
      message: "7-day model limit",
      code: null,
      retryable: false,
      limitScope: "model" as const,
    };
    assert.equal(
      providerFailoverClaim(targets, {
        noWorkObserved: true,
        accountFailure: "usage_limit",
        failure,
      })?.modelSelection,
      alternate,
    );
    assert.equal(
      providerFailoverClaim(targets, { noWorkObserved: true, accountFailure: "auth", failure })
        ?.modelSelection,
      fallback,
    );
    assert.isUndefined(providerFailoverClaim(targets, { accountFailure: "usage_limit", failure }));
    assert.deepEqual(
      providerFailoverClaim(
        { account: fallback, model: fallback },
        { noWorkObserved: true, accountFailure: "usage_limit" },
      ),
      { state: "pending", reason: "usage_limit", modelSelection: fallback },
    );
    assert.isUndefined(
      providerFailoverClaim(
        { account: fallback, model: fallback },
        { accountFailure: "usage_limit" },
      ),
    );
    assert.isUndefined(
      providerFailoverClaim({ account: fallback, model: fallback }, { noWorkObserved: true }),
    );
    assert.isUndefined(
      providerFailoverClaim(undefined, { noWorkObserved: true, accountFailure: "auth" }),
    );
  });

  it.effect(
    "routes new prompts around cooling accounts but never slash commands or unavailable targets",
    () =>
      Effect.gen(function* () {
        const cooldown = yield* ProviderCooldown.ProviderCooldown;
        const settings = yield* ServerSettings.ServerSettingsService;
        const selection = { instanceId: ProviderInstanceId.make("claude"), model: "fable" };
        const secondary = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" };
        const input = {
          cooldown,
          settings,
          modelSelection: selection,
          projectId: ProjectId.make("project:cooldown"),
          message,
          run: {},
        };
        assert.deepEqual(yield* resolveProviderCooldownTarget(input), selection);
        const failure = {
          class: "usage_limit" as const,
          message: "5-hour limit",
          code: null,
          retryable: false,
          resetAt: "1970-01-01T01:00:00.000Z",
          limitScope: "account" as const,
        };
        yield* cooldown.observe(selection.instanceId, { status: "failed", failure });
        assert.deepEqual(yield* resolveProviderCooldownTarget(input), secondary);
        const targetInput = {
          run: { ...run, providerInstanceId: selection.instanceId, modelSelection: selection },
          thread: { projectId: input.projectId },
          message,
          firstAttempt: true,
        };
        assert.deepEqual((yield* resolveProviderFailoverTarget(targetInput))?.account, secondary);
        yield* settings.updateSettings({
          providerInstances: {
            [selection.instanceId]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              enabled: false,
            },
          },
        });
        assert.deepEqual((yield* resolveProviderFailoverTarget(targetInput))?.account, secondary);
        assert.deepEqual(
          yield* resolveProviderCooldownTarget({
            ...input,
            message: { ...message, text: "/compact" },
          }),
          selection,
        );
        yield* settings.updateSettings({
          providerInstances: {
            [secondary.instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: false },
          },
        });
        assert.deepEqual(yield* resolveProviderCooldownTarget(input), selection);
        yield* settings.updateSettings({
          providerInstances: {
            [secondary.instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
          },
        });
        yield* cooldown.observe(secondary.instanceId, { status: "failed", failure });
        assert.deepEqual(yield* resolveProviderCooldownTarget(input), selection);
        yield* cooldown.observe(selection.instanceId, { status: "completed" });
        assert.deepEqual(yield* resolveProviderCooldownTarget(input), selection);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            ProviderCooldown.layer,
            ServerSettings.layerTest({
              fallbackModelSelection: fallback,
              secondaryFallbackModelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-5.5",
              },
            }),
          ),
        ),
      ),
  );

  it("uses the same account only for a different model's limit, otherwise the secondary", () => {
    const sameAccount = { ...limited, model: "other-model" };
    assert.deepEqual(
      providerFailoverTarget({
        run,
        message,
        firstAttempt: true,
        fallback: sameAccount,
        limitScope: "model",
      }),
      sameAccount,
    );
    assert.isUndefined(
      providerFailoverTarget({
        run,
        message,
        firstAttempt: true,
        fallback: limited,
        limitScope: "model",
      }),
    );
    assert.deepEqual(
      providerFailoverTarget({
        run,
        message,
        firstAttempt: true,
        fallback: sameAccount,
        secondaryFallback: fallback,
      }),
      fallback,
    );
    assert.isUndefined(
      providerFailoverTarget({
        run,
        message,
        firstAttempt: false,
        fallback: sameAccount,
        secondaryFallback: fallback,
        limitScope: "model",
      }),
    );
  });
});
