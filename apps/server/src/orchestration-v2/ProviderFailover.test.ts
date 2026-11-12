import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { providerFailoverClaim, providerFailoverTarget } from "./ProviderFailover.ts";

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
    assert.deepEqual(
      providerFailoverClaim(fallback, { noWorkObserved: true, accountFailure: "usage_limit" }),
      { state: "pending", reason: "usage_limit", modelSelection: fallback },
    );
    assert.isUndefined(providerFailoverClaim(fallback, { accountFailure: "usage_limit" }));
    assert.isUndefined(providerFailoverClaim(fallback, { noWorkObserved: true }));
    assert.isUndefined(
      providerFailoverClaim(undefined, { noWorkObserved: true, accountFailure: "auth" }),
    );
  });
});
