import * as Struct from "effect/Struct";
import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const text = Schema.String.check(Schema.isMaxLength(8000));
const name = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export const WorkLedgerStatus = Schema.Literals([
  "open",
  "blocked",
  "waiting_on_human",
  "done",
  "cancelled",
]);
const ownerKind = Schema.Literals(["jarvis", "vision", "t3", "human"]);
const fields = {
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  ownerKind,
  ownerName: name,
  ownerThreadId: Schema.NullOr(ThreadId),
  status: WorkLedgerStatus,
  blocker: Schema.NullOr(text),
  nextAction: Schema.NullOr(text),
  approvalNote: Schema.NullOr(text),
  links: Schema.Array(Schema.String.check(Schema.isMaxLength(4096))).check(Schema.isMaxLength(100)),
};
export const WorkLedgerItem = Schema.Struct({
  key: name,
  ...fields,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  // A thread or session id, which can be longer than a display name.
  updatedBy: TrimmedNonEmptyString,
});
export type WorkLedgerItem = typeof WorkLedgerItem.Type;
export const WorkLedgerUpsertInput = Schema.Struct({
  key: name,
  ...Schema.Struct(fields).mapFields(Struct.map(Schema.optional)).fields,
});
export type WorkLedgerUpsertInput = typeof WorkLedgerUpsertInput.Type;
export const WorkLedgerQueryInput = Schema.Struct({
  status: Schema.optional(WorkLedgerStatus),
  ownerKind: Schema.optional(ownerKind),
  ownerName: Schema.optional(name),
  updatedSince: Schema.optional(IsoDateTime),
  cursor: Schema.optional(name),
  limit: Schema.optional(NonNegativeInt.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export type WorkLedgerQueryInput = typeof WorkLedgerQueryInput.Type;
export const WorkLedgerQueryResult = Schema.Struct({
  items: Schema.Array(WorkLedgerItem),
  nextCursor: Schema.NullOr(name),
});
export type WorkLedgerQueryResult = typeof WorkLedgerQueryResult.Type;
