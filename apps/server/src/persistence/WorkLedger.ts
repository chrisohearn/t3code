import {
  WorkLedgerItem,
  type WorkLedgerUpsertInput,
  type WorkLedgerQueryInput,
  type WorkLedgerQueryResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/sql/SqlClient";

export class WorkLedger extends Context.Service<
  WorkLedger,
  {
    readonly forThread: (
      threadId: string,
    ) => Effect.Effect<ReadonlyArray<WorkLedgerItem>, OrchestratorMcpFailure>;
    readonly upsert: (
      input: WorkLedgerUpsertInput,
      updatedBy: string,
    ) => Effect.Effect<WorkLedgerItem, OrchestratorMcpFailure>;
    readonly query: (
      input: WorkLedgerQueryInput,
    ) => Effect.Effect<WorkLedgerQueryResult, OrchestratorMcpFailure>;
  }
>()("t3/persistence/WorkLedger") {}

const decode = Schema.decodeUnknownEffect(
  Schema.Array(
    WorkLedgerItem.mapFields(
      Struct.assign({ links: Schema.fromJsonString(WorkLedgerItem.fields.links) }),
    ),
  ),
);
const encodeLinks = Schema.encodeEffect(Schema.fromJsonString(WorkLedgerItem.fields.links));
const isFailure = Schema.is(OrchestratorMcpFailure);
const decodeItem = Schema.decodeUnknownEffect(WorkLedgerItem);
const storage = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "Could not access the work ledger.",
  });
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const select = sql`SELECT work_key AS key, title, owner_kind AS "ownerKind", owner_name AS "ownerName", owner_thread_id AS "ownerThreadId", status, blocker, next_action AS "nextAction", approval_note AS "approvalNote", links_json AS links, created_at AS "createdAt", updated_at AS "updatedAt", updated_by AS "updatedBy" FROM work_ledger`;
  const read = (key: string) =>
    sql`${select} WHERE work_key = ${key}`.pipe(
      Effect.flatMap(decode),
      Effect.map((rows) => rows[0]),
      Effect.mapError(storage),
    );
  return WorkLedger.of({
    forThread: Effect.fn("WorkLedger.forThread")((threadId) =>
      sql`${select} WHERE owner_thread_id = ${threadId} AND status NOT IN ('done', 'cancelled') ORDER BY work_key LIMIT 26`.pipe(
        Effect.flatMap(decode),
        Effect.mapError(storage),
      ),
    ),
    upsert: Effect.fn("WorkLedger.upsert")((input, updatedBy) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const current = yield* read(input.key);
            const now = DateTime.formatIso(yield* DateTime.now);
            const patch = Object.fromEntries(
              Object.entries(input).filter(([, value]) => value !== undefined),
            );
            const candidate = {
              ownerThreadId: null,
              status: "open",
              blocker: null,
              nextAction: null,
              approvalNote: null,
              links: [],
              ...current,
              ...patch,
              createdAt: current?.createdAt ?? now,
              updatedAt: now,
              updatedBy,
            };
            const item = yield* decodeItem(candidate).pipe(
              Effect.mapError(
                () =>
                  new OrchestratorMcpFailure({
                    code: "invalid_request",
                    message: "A new ledger item needs title, ownerKind and ownerName.",
                  }),
              ),
            );
            const linksJson = yield* encodeLinks(item.links).pipe(Effect.mapError(storage));
            yield* sql`INSERT INTO work_ledger (work_key, title, owner_kind, owner_name, owner_thread_id, status, blocker, next_action, approval_note, links_json, created_at, updated_at, updated_by)
        VALUES (${item.key}, ${item.title}, ${item.ownerKind}, ${item.ownerName}, ${item.ownerThreadId}, ${item.status}, ${item.blocker}, ${item.nextAction}, ${item.approvalNote}, ${linksJson}, ${item.createdAt}, ${item.updatedAt}, ${item.updatedBy})
        ON CONFLICT(work_key) DO UPDATE SET title = excluded.title, owner_kind = excluded.owner_kind, owner_name = excluded.owner_name, owner_thread_id = excluded.owner_thread_id, status = excluded.status, blocker = excluded.blocker, next_action = excluded.next_action, approval_note = excluded.approval_note, links_json = excluded.links_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`.pipe(
              Effect.mapError(storage),
            );
            return item;
          }),
        )
        .pipe(Effect.mapError((error) => (isFailure(error) ? error : storage()))),
    ),
    query: Effect.fn("WorkLedger.query")(function* (input) {
      const limit = input.limit ?? 25;
      // Stored times are UTC ISO strings, so an offset timestamp must be normalized to compare.
      const since =
        input.updatedSince === undefined
          ? undefined
          : Option.map(DateTime.make(input.updatedSince), DateTime.formatIso);
      if (since !== undefined && Option.isNone(since))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "updatedSince must be an ISO-8601 time.",
        });
      const rows = yield* sql`${select} WHERE 1 = 1
        ${input.status === undefined ? sql`` : sql`AND status = ${input.status}`}
        ${input.ownerKind === undefined ? sql`` : sql`AND owner_kind = ${input.ownerKind}`}
        ${input.ownerName === undefined ? sql`` : sql`AND owner_name = ${input.ownerName}`}
        ${since === undefined ? sql`` : sql`AND updated_at >= ${Option.getOrThrow(since)}`}
        ${input.cursor === undefined ? sql`` : sql`AND work_key > ${input.cursor}`}
        ORDER BY work_key ASC LIMIT ${limit + 1}`.pipe(
        Effect.flatMap(decode),
        Effect.mapError(storage),
      );
      const items = rows.slice(0, limit);
      return { items, nextCursor: rows.length > limit ? items.at(-1)!.key : null };
    }),
  });
});
export const layer = Layer.effect(WorkLedger, make);
