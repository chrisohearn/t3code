import type { McpThreadNotify, McpThreadNotifyResult, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as McpEvents from "./McpEvents.ts";

export const prepare = Effect.fn("ThreadNotifications.prepare")(function* (
  input: McpThreadNotify | undefined,
) {
  if (input === undefined) return undefined;
  const events = yield* Effect.serviceOption(McpEvents.McpEvents);
  if (Option.isNone(events))
    return {
      result: {
        status: "unavailable",
        subscriptionIds: [],
        reason: "events_unavailable",
      } satisfies McpThreadNotifyResult,
    };
  const prepared = yield* events.value
    .prepareNotify(input)
    .pipe(
      Effect.catch((error) =>
        Effect.succeed({ status: "failed" as const, subscriptionIds: [], reason: error.reason }),
      ),
    );
  return "status" in prepared ? { result: prepared } : { events: events.value, prepared };
});
export const finish = Effect.fn("ThreadNotifications.finish")(function* (
  notification: Effect.Success<ReturnType<typeof prepare>>,
  threadId: ThreadId,
) {
  if (notification === undefined) return undefined;
  if ("result" in notification) return notification.result;
  return yield* notification.events
    .notifyThread(notification.prepared, threadId)
    .pipe(
      Effect.catch((error) =>
        Effect.succeed({ status: "failed" as const, subscriptionIds: [], reason: error.reason }),
      ),
    );
});
