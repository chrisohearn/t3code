import type {
  OrchestrationV2ProviderFailure,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

export class ProviderCooldown extends Context.Service<
  ProviderCooldown,
  {
    readonly getAll: Effect.Effect<ReadonlyMap<ProviderInstanceId, string>>;
    readonly subscribeChanges: Effect.Effect<PubSub.Subscription<void>, never, Scope.Scope>;
    readonly clear: (instanceId: ProviderInstanceId) => Effect.Effect<void>;
    readonly observeProvider: (provider: ServerProvider) => Effect.Effect<void>;
    readonly observe: (
      instanceId: ProviderInstanceId,
      terminal: {
        readonly status: string;
        readonly failure?: OrchestrationV2ProviderFailure | null | undefined;
      },
    ) => Effect.Effect<void>;
  }
>()("t3/provider/ProviderCooldown") {}

const make = Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const entries = yield* Ref.make<
    ReadonlyMap<ProviderInstanceId, { readonly armedAt: number; readonly expiresAt: string }>
  >(new Map());
  const changes = yield* Effect.acquireRelease(PubSub.unbounded<void>(), PubSub.shutdown);
  const clear = Effect.fn("ProviderCooldown.clear")(function* (
    instanceId: ProviderInstanceId,
    expected?: { readonly armedAt: number; readonly expiresAt: string },
  ) {
    const changed = yield* Ref.modify(entries, (current) => {
      if (
        !current.has(instanceId) ||
        (expected !== undefined && current.get(instanceId) !== expected)
      )
        return [false, current];
      const next = new Map(current);
      next.delete(instanceId);
      return [true, next];
    });
    if (changed) yield* PubSub.publish(changes, undefined);
  });
  const getAll = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const current = yield* Ref.get(entries);
    return new Map(
      [...current]
        .filter(([, entry]) => DateTime.toEpochMillis(now) < Date.parse(entry.expiresAt))
        .map(([instanceId, entry]) => [instanceId, entry.expiresAt]),
    );
  });
  return {
    getAll,
    subscribeChanges: PubSub.subscribe(changes),
    clear: (instanceId) => clear(instanceId),
    observeProvider: Effect.fn("ProviderCooldown.observeProvider")(function* (provider) {
      const entry = (yield* Ref.get(entries)).get(provider.instanceId);
      const limits = provider.usageLimits;
      if (
        entry === undefined ||
        limits === undefined ||
        limits.unavailable !== undefined ||
        provider.auth.status !== "authenticated" ||
        (provider.status !== "ready" && provider.status !== "warning") ||
        !(Date.parse(limits.checkedAt) > entry.armedAt)
      )
        return;
      const accountWindows = limits.windows.filter((window) =>
        provider.driver === "claudeAgent"
          ? window.id === "five_hour" || window.id === "seven_day"
          : window.id === "primary" || window.id === "secondary" || window.id === "individual",
      );
      if (
        accountWindows.length > 0 &&
        (provider.driver !== "claudeAgent" ||
          (accountWindows.some((window) => window.id === "five_hour") &&
            accountWindows.some((window) => window.id === "seven_day"))) &&
        accountWindows.every((window) => window.usedPercent < 100)
      )
        yield* clear(provider.instanceId, entry);
    }),
    observe: Effect.fn("ProviderCooldown.observe")(function* (instanceId, terminal) {
      if (terminal.status === "completed") return yield* clear(instanceId);
      const failure = terminal.failure;
      if (
        terminal.status !== "failed" ||
        failure?.class !== "usage_limit" ||
        failure.limitScope !== "account" ||
        !failure.resetAt
      )
        return;
      const armedAt = DateTime.toEpochMillis(yield* DateTime.now);
      const delay = Math.min(Date.parse(failure.resetAt) - armedAt, 6 * 60 * 60 * 1000);
      if (!Number.isFinite(delay) || delay <= 0) return;
      const entry = {
        armedAt,
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(armedAt + delay)),
      };
      yield* Ref.update(entries, (current) => new Map(current).set(instanceId, entry));
      yield* PubSub.publish(changes, undefined);
      yield* clear(instanceId, entry).pipe(Effect.delay(delay), Effect.forkIn(scope));
    }),
  } satisfies ProviderCooldown["Service"];
});

export const layer = Layer.effect(ProviderCooldown, make);

export function withProviderCooldowns(
  providers: ReadonlyArray<ServerProvider>,
  cooldowns: ReadonlyMap<ProviderInstanceId, string>,
): ReadonlyArray<ServerProvider> {
  return providers.map((provider) => {
    const resetAt = cooldowns.get(provider.instanceId);
    return resetAt === undefined
      ? provider
      : {
          ...provider,
          status: provider.status === "ready" ? "warning" : provider.status,
          message: `Account usage limit until ${resetAt}. New runs use an available configured fallback.`,
        };
  });
}
