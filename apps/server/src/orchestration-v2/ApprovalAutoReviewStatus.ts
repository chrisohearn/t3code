import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

export const Snapshot = Schema.Struct({
  status: Schema.Literals(["healthy", "degraded"]),
  failures: Schema.Number,
  lastError: Schema.NullOr(Schema.String),
});

export class ApprovalAutoReviewStatus extends Context.Service<
  ApprovalAutoReviewStatus,
  {
    readonly read: Effect.Effect<typeof Snapshot.Type>;
    readonly failed: (reason: string) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ApprovalAutoReviewStatus") {}

export const layer = Layer.effect(
  ApprovalAutoReviewStatus,
  Effect.gen(function* () {
    const state = yield* Ref.make<typeof Snapshot.Type>({
      status: "healthy",
      failures: 0,
      lastError: null,
    });
    return ApprovalAutoReviewStatus.of({
      read: Ref.get(state),
      failed: Effect.fn("ApprovalAutoReviewStatus.failed")((reason: string) =>
        Ref.update(state, (previous) => ({
          status: "degraded" as const,
          failures: previous.failures + 1,
          lastError: makeProviderFailure({ message: reason }).message.slice(0, 2000),
        })),
      ),
    });
  }),
);
