import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";

export class ScheduledTaskChanges extends Context.Service<
  ScheduledTaskChanges,
  PubSub.PubSub<void>
>()("t3/scheduledTasks/ScheduledTaskChanges") {}

// Notifications re-emit the full list; slow subscribers need only the newest dirty signal.
export const layer = Layer.effect(ScheduledTaskChanges, PubSub.sliding<void>(1));
