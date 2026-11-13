import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Who froze a thread, from the authenticated caller and never from a tool argument. */
export const ThreadFreezeActor = Schema.Struct({
  kind: Schema.Literals(["owner", "outside-client", "linked-agent", "agent", "unknown"]),
  label: Schema.String.check(Schema.isMaxLength(128)),
  /** First eight characters of the sign-in session, as in a message's `senderClient`. */
  sessionId: Schema.optional(Schema.String.check(Schema.isMaxLength(8))),
  threadId: Schema.optional(ThreadId),
});
export type ThreadFreezeActor = typeof ThreadFreezeActor.Type;

export const ThreadFreeze = Schema.Struct({
  at: IsoDateTime,
  by: ThreadFreezeActor,
  reason: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
});
export type ThreadFreeze = typeof ThreadFreeze.Type;

/** Who lifted the last freeze, kept on the thread until the next one. */
export const ThreadUnfreeze = Schema.Struct({ at: IsoDateTime, by: ThreadFreezeActor });
