import {
  WorkLedgerItem,
  RunId,
  type WorkLedgerHistoryResult,
  WorkLedgerHistoryEntry,
  type WorkLedgerUpsertResult,
  type WorkLedgerHistoryInput,
  type PortfolioStatusInput,
  type PortfolioStatusResult,
  type WorkLedgerUpsertInput,
  type WorkLedgerQueryInput,
  type WorkLedgerQueryResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { parseThreadLinkHref, formatThreadLink } from "@t3tools/shared/threadLinks";
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
    ) => Effect.Effect<WorkLedgerUpsertResult, OrchestratorMcpFailure>;
    readonly history: (
      input: WorkLedgerHistoryInput,
    ) => Effect.Effect<WorkLedgerHistoryResult, OrchestratorMcpFailure>;
    readonly portfolio: (
      input: PortfolioStatusInput,
    ) => Effect.Effect<PortfolioStatusResult, OrchestratorMcpFailure>;
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
const decodeHistory = Schema.decodeUnknownEffect(
  Schema.Array(
    WorkLedgerHistoryEntry.mapFields(
      Struct.assign({
        changes: Schema.fromJsonString(WorkLedgerHistoryEntry.fields.changes),
      }),
    ),
  ),
);
const encodeChanges = Schema.encodeEffect(
  Schema.fromJsonString(WorkLedgerHistoryEntry.fields.changes),
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
  const select = sql`SELECT work_key AS key, title, owner_kind AS "ownerKind", owner_name AS "ownerName", owner_thread_id AS "ownerThreadId", status, wait_reason AS "waitReason", next_check_at AS "nextCheckAt", last_run_id AS "lastRunId", last_run_status AS "lastRunStatus", last_run_at AS "lastRunAt", blocker, next_action AS "nextAction", approval_note AS "approvalNote", links_json AS links, created_at AS "createdAt", updated_at AS "updatedAt", updated_by AS "updatedBy" FROM work_ledger`;
  const read = (key: string) =>
    sql`${select} WHERE work_key = ${key}`.pipe(
      Effect.flatMap(decode),
      Effect.map((rows) => rows[0]),
      Effect.mapError(storage),
    );
  const query = Effect.fn("WorkLedger.query")(function* (input: WorkLedgerQueryInput) {
    const limit = input.limit ?? 25;
    const now = DateTime.formatIso(yield* DateTime.now);
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
        ${input.waitReason === undefined ? sql`` : input.waitReason === null ? sql`AND wait_reason IS NULL` : sql`AND wait_reason = ${input.waitReason}`}
        ${input.due === undefined ? sql`` : input.due ? sql`AND next_check_at <= ${now}` : sql`AND (next_check_at IS NULL OR next_check_at > ${now})`}
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
  });
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
              waitReason: null,
              nextCheckAt: null,
              lastRunId: null,
              lastRunStatus: null,
              lastRunAt: null,
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
            if (candidate.nextCheckAt !== null) {
              const parsed = DateTime.make(candidate.nextCheckAt);
              if (Option.isNone(parsed))
                return yield* new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message: "nextCheckAt must be an ISO-8601 time.",
                });
              candidate.nextCheckAt = DateTime.formatIso(parsed.value);
            }
            const warnings: string[] = [];
            const threadIds = new Set<string>();
            if (candidate.ownerThreadId !== null) {
              const ref = parseThreadLinkHref(candidate.ownerThreadId);
              if (ref?.environmentId != null)
                return yield* new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message:
                    "ownerThreadId must be an environment-local thread id or v1 link. Keep scoped thread references in links.",
                });
              if (ref !== null) candidate.ownerThreadId = ref.threadId;
              threadIds.add(candidate.ownerThreadId);
            }
            candidate.links = candidate.links.map((link) => {
              const href = (link.match(/^\[[^\]]*\]\((.*)\)$/)?.[1] ?? link).replace(/^<|>$/g, "");
              const ref = parseThreadLinkHref(href);
              if (ref === null) return link;
              if (ref.environmentId === null) threadIds.add(ref.threadId);
              else warnings.push(`Scoped thread ${ref.threadId} was not checked locally.`);
              return formatThreadLink(ref).slice(1, -1);
            });
            for (const threadId of threadIds) {
              const exists =
                yield* sql`SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId} AND deleted_at IS NULL`;
              if (exists.length === 0)
                warnings.push(`Thread ${threadId} does not exist in this environment.`);
            }
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
            const row = {
              work_key: item.key,
              title: item.title,
              owner_kind: item.ownerKind,
              owner_name: item.ownerName,
              owner_thread_id: item.ownerThreadId,
              status: item.status,
              blocker: item.blocker,
              wait_reason: item.waitReason,
              next_check_at: item.nextCheckAt,
              next_action: item.nextAction,
              approval_note: item.approvalNote,
              links_json: linksJson,
              created_at: item.createdAt,
              updated_at: item.updatedAt,
              updated_by: item.updatedBy,
            };
            yield* sql`INSERT INTO work_ledger ${sql.insert(row)} ON CONFLICT(work_key) DO UPDATE SET
              title=excluded.title, owner_kind=excluded.owner_kind, owner_name=excluded.owner_name,
              owner_thread_id=excluded.owner_thread_id, status=excluded.status, blocker=excluded.blocker,
              wait_reason=excluded.wait_reason, next_check_at=excluded.next_check_at,
              next_action=excluded.next_action, approval_note=excluded.approval_note, links_json=excluded.links_json,
              updated_at=excluded.updated_at, updated_by=excluded.updated_by`;
            const changes = Object.fromEntries(
              Object.entries(item)
                .filter(
                  ([field, value]) =>
                    !["createdAt", "updatedAt", "updatedBy"].includes(field) &&
                    JSON.stringify(current?.[field as keyof WorkLedgerItem] ?? null) !==
                      JSON.stringify(value),
                )
                .map(([field, value]) => [
                  field,
                  { before: current?.[field as keyof WorkLedgerItem] ?? null, after: value },
                ]),
            );
            const changesJson = yield* encodeChanges(changes);
            yield* sql`INSERT INTO work_ledger_history (work_key, changed_at, changed_by, changes_json)
              VALUES (${item.key}, ${now}, ${updatedBy}, ${changesJson})`;
            return { ...item, warnings };
          }),
        )
        .pipe(Effect.mapError((error) => (isFailure(error) ? error : storage()))),
    ),
    query,
    history: Effect.fn("WorkLedger.history")(function* (input) {
      const limit = input.limit ?? 25;
      const rows =
        yield* sql`SELECT id, work_key AS key, changed_at AS "changedAt", changed_by AS "changedBy", changes_json AS changes
        FROM work_ledger_history WHERE work_key = ${input.key} AND id > ${input.cursor ?? 0}
        ORDER BY id LIMIT ${limit + 1}`;
      const decoded = yield* decodeHistory(rows);
      const items = decoded.slice(0, limit);
      return { items, nextCursor: decoded.length > limit ? items.at(-1)!.id : null };
    }, Effect.mapError(storage)),
    portfolio: Effect.fn("WorkLedger.portfolio")(function* (input) {
      const limit = input.limit ?? 10;
      const ledgerRows = yield* sql`${select} WHERE status NOT IN ('done', 'cancelled')
        ${input.cursor === undefined ? sql`` : sql`AND work_key > ${input.cursor}`}
        ORDER BY work_key LIMIT ${limit + 1}`.pipe(
        Effect.flatMap(decode),
        Effect.mapError(storage),
      );
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const items = yield* Effect.forEach(ledgerRows.slice(0, limit), (item) =>
        Effect.gen(function* () {
          if (item.ownerThreadId === null)
            return {
              item,
              latestRunId: null,
              latestRunStatus: null,
              pendingRequestCount: 0,
              resultExcerpt: null,
              staleWorker: false,
            };
          const [run] = yield* sql<{
            run_id: string;
            status: string;
            requested_at: string;
          }>`SELECT run_id, status, requested_at
          FROM orchestration_v2_projection_runs WHERE thread_id = ${item.ownerThreadId} ORDER BY ordinal DESC LIMIT 1`;
          const [pending] = yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM orchestration_v2_projection_runtime_requests
          WHERE thread_id = ${item.ownerThreadId} AND status = 'pending'`;
          const [result] = yield* sql<{
            text: string;
          }>`SELECT substr(json_extract(payload_json, '$.text'), 1, 400) AS text
          FROM orchestration_v2_projection_messages WHERE thread_id = ${item.ownerThreadId} AND role = 'assistant'
          ${run === undefined ? sql`AND 0` : sql`AND run_id = ${run.run_id}`}
          ORDER BY created_at DESC, message_id DESC LIMIT 1`;
          return {
            item,
            latestRunId: run === undefined ? null : RunId.make(run.run_id),
            latestRunStatus: run?.status ?? null,
            pendingRequestCount: pending?.count ?? 0,
            resultExcerpt: result?.text ?? null,
            staleWorker:
              now - Date.parse(run?.requested_at ?? item.createdAt) > 24 * 60 * 60 * 1000,
          };
        }).pipe(Effect.mapError(storage)),
      );
      return { items, nextCursor: ledgerRows.length > limit ? items.at(-1)!.item.key : null };
    }),
  });
});
export const layer = Layer.effect(WorkLedger, make);
