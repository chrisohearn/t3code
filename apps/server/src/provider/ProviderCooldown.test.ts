import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as ProviderCooldown from "./ProviderCooldown.ts";

it.effect("cools only account limits until reset and clears on success", () =>
  Effect.gen(function* () {
    const cooldown = yield* ProviderCooldown.ProviderCooldown;
    const instanceId = ProviderInstanceId.make("claude");
    const failure = {
      class: "usage_limit" as const,
      message: "5-hour limit",
      code: null,
      retryable: false,
      resetAt: "1970-01-01T00:01:00.000Z",
    };
    for (const limitScope of [undefined, "model"] as const) {
      yield* cooldown.observe(instanceId, {
        status: "failed",
        failure: { ...failure, limitScope },
      });
      assert.deepEqual(yield* cooldown.getAll, new Map());
    }
    yield* cooldown.observe(instanceId, {
      status: "failed",
      failure: { ...failure, limitScope: "account" },
    });
    assert.equal((yield* cooldown.getAll).get(instanceId), failure.resetAt);
    const providers: ReadonlyArray<ServerProvider> = [
      {
        instanceId,
        driver: ProviderDriverKind.make("claudeAgent"),
        status: "ready",
        enabled: true,
        installed: true,
        auth: { status: "authenticated" },
        checkedAt: "1970-01-01T00:00:00.000Z",
        version: "1.0.0",
        models: [],
        slashCommands: [],
        skills: [],
      },
    ];
    const limited = ProviderCooldown.withProviderCooldowns(providers, yield* cooldown.getAll);
    assert.equal(limited[0]?.status, "warning");
    assert.include(limited[0]?.message, failure.resetAt);
    yield* TestClock.adjust("1 minute");
    assert.deepEqual(yield* cooldown.getAll, new Map());
    assert.equal(
      ProviderCooldown.withProviderCooldowns(providers, yield* cooldown.getAll)[0],
      providers[0],
    );
    yield* cooldown.observe(instanceId, {
      status: "failed",
      failure: { ...failure, limitScope: "account" },
    });
    assert.deepEqual(yield* cooldown.getAll, new Map());
    yield* cooldown.observe(instanceId, {
      status: "failed",
      failure: { ...failure, limitScope: "account", resetAt: "1970-01-01T00:02:00.000Z" },
    });
    yield* cooldown.observe(instanceId, { status: "completed" });
    assert.deepEqual(yield* cooldown.getAll, new Map());
    const longFailure = {
      ...failure,
      limitScope: "account" as const,
      resetAt: "1970-01-08T00:00:00.000Z",
    };
    yield* cooldown.observe(instanceId, { status: "failed", failure: longFailure });
    assert.equal((yield* cooldown.getAll).get(instanceId), "1970-01-01T06:01:00.000Z");
    const healthy = {
      ...providers[0]!,
      checkedAt: "1970-01-01T00:01:01.000Z",
      usageLimits: {
        checkedAt: "1970-01-01T00:01:01.000Z",
        windows: [
          { id: "five_hour", kind: "session" as const, label: "Session", usedPercent: 20 },
          { id: "seven_day", kind: "weekly" as const, label: "Weekly", usedPercent: 30 },
        ],
      },
    };
    yield* TestClock.adjust("1 second");
    yield* cooldown.observeProvider({
      ...healthy,
      usageLimits: { ...healthy.usageLimits, checkedAt: "1970-01-01T00:00:00.000Z" },
    });
    assert.equal((yield* cooldown.getAll).size, 1);
    yield* cooldown.observeProvider({
      ...healthy,
      usageLimits: {
        ...healthy.usageLimits,
        windows: [{ ...healthy.usageLimits.windows[0]!, usedPercent: 100 }],
      },
    });
    assert.equal((yield* cooldown.getAll).size, 1);
    yield* cooldown.observeProvider({
      ...healthy,
      usageLimits: { ...healthy.usageLimits, windows: [] },
    });
    assert.equal((yield* cooldown.getAll).size, 1);
    yield* cooldown.observeProvider({
      ...healthy,
      usageLimits: { ...healthy.usageLimits, windows: [healthy.usageLimits.windows[0]!] },
    });
    assert.equal((yield* cooldown.getAll).size, 1);
    yield* cooldown.observeProvider({
      ...healthy,
      usageLimits: { ...healthy.usageLimits, unavailable: { reason: "probeFailed" } },
    });
    assert.equal((yield* cooldown.getAll).size, 1);
    yield* cooldown.observeProvider(healthy);
    assert.deepEqual(yield* cooldown.getAll, new Map());
    yield* cooldown.observe(instanceId, { status: "failed", failure: longFailure });
    yield* cooldown.clear(instanceId);
    assert.deepEqual(yield* cooldown.getAll, new Map());
    yield* cooldown.observe(instanceId, { status: "failed", failure: longFailure });
    yield* TestClock.adjust("5 hours");
    yield* cooldown.observeProvider({ ...healthy, usageLimits: undefined });
    assert.equal((yield* cooldown.getAll).size, 1);
    yield* TestClock.adjust("1 hour");
    assert.deepEqual(yield* cooldown.getAll, new Map());
    yield* cooldown.observe(instanceId, { status: "failed", failure: longFailure });
    assert.equal((yield* cooldown.getAll).get(instanceId), "1970-01-01T12:01:01.000Z");
  }).pipe(Effect.provide(ProviderCooldown.layer)),
);
