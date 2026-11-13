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
import * as Stream from "effect/Stream";

export class ProviderCooldown extends Context.Service<
  ProviderCooldown,
  {
    readonly getAll: Effect.Effect<ReadonlyMap<ProviderInstanceId, string>>;
    readonly changes: Stream.Stream<void>;
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
  const entries = yield* Ref.make<ReadonlyMap<ProviderInstanceId, string>>(new Map());
  const changes = yield* Effect.acquireRelease(PubSub.unbounded<void>(), PubSub.shutdown);
  const clear = Effect.fn("ProviderCooldown.clear")(function* (
    instanceId: ProviderInstanceId,
    resetAt?: string,
  ) {
    const changed = yield* Ref.modify(entries, (current) => {
      if (
        !current.has(instanceId) ||
        (resetAt !== undefined && current.get(instanceId) !== resetAt)
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
      [...current].filter(([, resetAt]) => DateTime.toEpochMillis(now) < Date.parse(resetAt)),
    );
  });
  return {
    getAll,
    changes: Stream.fromPubSub(changes),
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
      const resetAt = failure.resetAt;
      const delay = Date.parse(resetAt) - DateTime.toEpochMillis(yield* DateTime.now);
      if (!Number.isFinite(delay) || delay <= 0) return;
      if ((yield* Ref.get(entries)).get(instanceId) === resetAt) return;
      yield* Ref.update(entries, (current) => new Map(current).set(instanceId, resetAt));
      yield* PubSub.publish(changes, undefined);
      yield* clear(instanceId, resetAt).pipe(Effect.delay(delay), Effect.forkIn(scope));
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
