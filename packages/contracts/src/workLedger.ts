import * as Struct from "effect/Struct";
import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  RunId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

const text = Schema.String.check(Schema.isMaxLength(8000));
const name = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export const WorkLedgerStatus = Schema.Literals([
  "open",
  "blocked",
  "waiting_on_human",
  "done",
  "cancelled",
]);
export const WorkLedgerWaitReason = Schema.NullOr(
  Schema.Literals(["external", "natural", "decision"]),
);
const pageLimit = Schema.optional(
  NonNegativeInt.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
);
const ownerKind = Schema.Literals(["jarvis", "vision", "t3", "human"]);
const fields = {
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  ownerKind,
  ownerName: name,
  ownerThreadId: Schema.NullOr(ThreadId),
  status: WorkLedgerStatus,
  blocker: Schema.NullOr(text),
  waitReason: WorkLedgerWaitReason,
  nextCheckAt: Schema.NullOr(IsoDateTime),
  nextAction: Schema.NullOr(text),
  approvalNote: Schema.NullOr(text),
  links: Schema.Array(Schema.String.check(Schema.isMaxLength(4096))).check(Schema.isMaxLength(100)),
};
export const WorkLedgerItem = Schema.Struct({
  key: name,
  ...fields,
  lastRunId: Schema.NullOr(RunId),
  lastRunStatus: Schema.NullOr(Schema.String),
  lastRunAt: Schema.NullOr(IsoDateTime),
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
  waitReason: Schema.optional(WorkLedgerWaitReason),
  due: Schema.optional(Schema.Boolean),
  cursor: Schema.optional(name),
  limit: pageLimit,
});
export type WorkLedgerQueryInput = typeof WorkLedgerQueryInput.Type;
export const WorkLedgerQueryResult = Schema.Struct({
  items: Schema.Array(WorkLedgerItem),
  nextCursor: Schema.NullOr(name),
});
export type WorkLedgerQueryResult = typeof WorkLedgerQueryResult.Type;

export const WorkLedgerUpsertResult = WorkLedgerItem.mapFields(
  Struct.assign({ warnings: Schema.Array(Schema.String) }),
);
export type WorkLedgerUpsertResult = typeof WorkLedgerUpsertResult.Type;
export const WorkLedgerHistoryInput = Schema.Struct({
  key: name,
  cursor: Schema.optional(NonNegativeInt),
  limit: pageLimit,
});
export type WorkLedgerHistoryInput = typeof WorkLedgerHistoryInput.Type;
export const WorkLedgerHistoryEntry = Schema.Struct({
  id: NonNegativeInt,
  key: name,
  changedAt: IsoDateTime,
  changedBy: TrimmedNonEmptyString,
  changes: Schema.Record(
    Schema.String,
    Schema.Struct({ before: Schema.Unknown, after: Schema.Unknown }),
  ),
});
export const WorkLedgerHistoryResult = Schema.Struct({
  items: Schema.Array(WorkLedgerHistoryEntry),
  nextCursor: Schema.NullOr(NonNegativeInt),
});
export type WorkLedgerHistoryResult = typeof WorkLedgerHistoryResult.Type;
export const PortfolioStatusInput = Schema.Struct({
  cursor: Schema.optional(name),
  limit: pageLimit,
});
export type PortfolioStatusInput = typeof PortfolioStatusInput.Type;
export const PortfolioStatusResult = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      item: WorkLedgerItem,
      latestRunId: Schema.NullOr(RunId),
      latestRunStatus: Schema.NullOr(Schema.String),
      pendingRequestCount: NonNegativeInt,
      resultExcerpt: Schema.NullOr(Schema.String),
      staleWorker: Schema.Boolean,
    }),
  ),
  nextCursor: Schema.NullOr(name),
});
export type PortfolioStatusResult = typeof PortfolioStatusResult.Type;
