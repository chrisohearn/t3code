import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const DAY_MS = 24 * 60 * 60 * 1_000;

export const RegistryInput = Schema.Struct({
  cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(300))),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export const RegistryItem = Schema.Struct({
  /** The sign-in's session prefix, or the thread id. */
  id: Schema.String,
  kind: Schema.Literals([
    "outside_client",
    "linked_agent",
    "local_thread",
    "scheduled_task",
    "delegate",
  ]),
  label: Schema.String,
  /** First eight characters of the sign-in or provider session. */
  sessionPrefix: Schema.String,
  threadId: Schema.optional(ThreadId),
  lastToolAt: Schema.Number,
  lastTool: Schema.String,
  calls24h: Schema.Number,
  /** Runs started in the last 24 hours: in the thread, or in the threads a sign-in launched. */
  runs24h: Schema.Number,
  /** Null for a sign-in: only threads freeze. */
  frozen: Schema.NullOr(Schema.Boolean),
  attribution: Schema.Literals(["attributed", "shared, unattributable"]),
  /** MCP connections a sign-in used in the last 24h, among calls logged since connections were recorded. */
  connections: Schema.optional(Schema.Number),
});
export const RegistryResult = Schema.Struct({
  scope: Schema.Literals(["all", "own"]),
  now: Schema.Number,
  items: Schema.Array(RegistryItem),
  nextCursor: Schema.NullOr(Schema.String),
});
export type RegistryCaller = {
  /** Set for an outside sign-in. */
  readonly sessionId: string | undefined;
  /** A thread caller or a full-access, unlinked sign-in sees every agent; others see their own row. */
  readonly seesAll: boolean;
};

export class AgentRegistry extends Context.Service<
  AgentRegistry,
  {
    readonly list: (
      input: typeof RegistryInput.Type,
      caller: RegistryCaller,
    ) => Effect.Effect<typeof RegistryResult.Type, OrchestratorMcpFailure>;
  }
>()("t3/persistence/AgentRegistry") {}

const storage = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "Could not read the agent registry.",
  });

// The cursor is the log row id of the last agent's latest call: it names no agent or sign-in.
const parseCursor = (cursor: string | undefined) => {
  if (cursor === undefined) return undefined;
  const id = Number(cursor);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const list = Effect.fn("AgentRegistry.list")(function* (
    input: typeof RegistryInput.Type,
    caller: RegistryCaller,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const day = now - DAY_MS;
    const dayIso = DateTime.formatIso(DateTime.makeUnsafe(day));
    const limit = input.limit ?? 20;
    const cursor = parseCursor(input.cursor);
    if (input.cursor !== undefined && cursor === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "The cursor is not one this tool returned.",
      });
    }
    if (!caller.seesAll && caller.sessionId === undefined) {
      return yield* storage();
    }
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const own = caller.seesAll ? sql`` : sql`AND client = ${caller.sessionId ?? ""}`;
          const page = yield* sql<{
            readonly client: string;
            readonly lastId: number;
            readonly lastAt: number;
            readonly lastTool: string;
            readonly session: string;
          }>`SELECT client, last_id AS "lastId", last_at AS "lastAt", last_tool AS "lastTool",
              last_session AS session
            FROM mcp_agent_summary
            WHERE last_id < ${cursor ?? Number.MAX_SAFE_INTEGER} ${own}
            ORDER BY last_id DESC LIMIT ${limit + 1}`;
          const rows = page.slice(0, limit);
          if (rows.length === 0) {
            return {
              scope: caller.seesAll ? ("all" as const) : ("own" as const),
              now,
              items: [],
              nextCursor: null,
            };
          }
          const clients = rows.map((row) => row.client);
          const calls = new Map(
            (yield* sql<{ readonly client: string; readonly calls: number }>`
              SELECT client, COUNT(*) AS calls FROM mcp_request_log
              WHERE started_at >= ${day} AND ${sql.in("client", clients)} GROUP BY client`).map(
              (row) => [row.client, row.calls],
            ),
          );
          const signIns = new Map(
            (yield* sql<{
              readonly sessionId: string;
              readonly label: string | null;
              readonly peerLink: number | null;
            }>`SELECT a.session_id AS "sessionId", a.client_label AS label, o.peer_link AS "peerLink"
              FROM auth_sessions a LEFT JOIN mcp_oauth_sessions o ON o.session_id = a.session_id
              WHERE ${sql.in("a.session_id", clients)}`).map((row) => [row.sessionId, row]),
          );
          const threadClients = clients.filter((client) => !signIns.has(client));
          const threads = new Map(
            (threadClients.length === 0
              ? []
              : yield* sql<{
                  readonly threadId: string;
                  readonly title: string;
                  readonly delegate: number;
                  readonly frozen: number;
                  readonly scheduled: number;
                }>`SELECT t.thread_id AS "threadId", t.title,
                    COALESCE(json_extract(t.payload_json, '$.lineage.relationshipToParent') = 'subagent', 0)
                      OR json_extract(t.payload_json, '$.delegatedFrom') IS NOT NULL AS delegate,
                    json_extract(t.payload_json, '$.frozen') IS NOT NULL AS frozen,
                    EXISTS (SELECT 1 FROM scheduled_tasks s WHERE s.thread_id = t.thread_id)
                      OR COALESCE((SELECT m.payload_json LIKE '%"scheduledTaskId"%'
                        FROM orchestration_v2_projection_messages m
                        WHERE m.thread_id = t.thread_id AND m.role = 'user'
                        ORDER BY m.created_at LIMIT 1), 0) AS scheduled
                  FROM orchestration_v2_projection_threads t
                  WHERE ${sql.in("t.thread_id", threadClients)}`
            ).map((row) => [row.threadId, row]),
          );
          // Threads a sign-in launched, for its run count.
          const signInIds = clients.filter((client) => signIns.has(client));
          const launched = new Map<string, Set<string>>(signInIds.map((id) => [id, new Set()]));
          // Connection activity windows in the last 24h: overlapping windows are agents acting at once.
          const windows = new Map<string, Array<readonly [number, number]>>(
            signInIds.map((id) => [id, []]),
          );
          if (signInIds.length > 0) {
            for (const row of yield* sql<{ readonly sessionId: string; readonly threadId: string }>`
              SELECT session_id AS "sessionId", thread_id AS "threadId" FROM mcp_client_threads
              WHERE ${sql.in("session_id", signInIds)} LIMIT 500`) {
              launched.get(row.sessionId)?.add(row.threadId);
            }
            for (const row of yield* sql<{
              readonly client: string;
              readonly first: number;
              readonly last: number;
            }>`SELECT client, MIN(started_at) AS first, MAX(started_at) AS last FROM mcp_request_log
              WHERE started_at >= ${day} AND connection IS NOT NULL AND ${sql.in("client", signInIds)}
              GROUP BY client, connection`) {
              windows.get(row.client)?.push([row.first, row.last]);
            }
          }
          const runThreads = [
            ...new Set([...threadClients, ...[...launched.values()].flatMap((ids) => [...ids])]),
          ];
          const runs = new Map(
            (runThreads.length === 0
              ? []
              : yield* sql<{ readonly threadId: string; readonly runs: number }>`
                  SELECT thread_id AS "threadId", COUNT(*) AS runs FROM orchestration_v2_projection_runs
                  WHERE requested_at >= ${dayIso} AND ${sql.in("thread_id", runThreads)}
                  GROUP BY thread_id`
            ).map((row) => [row.threadId, row.runs]),
          );
          const items = rows.map((row) => {
            const base = {
              lastToolAt: row.lastAt,
              lastTool: row.lastTool,
              calls24h: calls.get(row.client) ?? 0,
            };
            const signIn = signIns.get(row.client);
            if (signIn !== undefined) {
              const prefix = row.client.slice(0, 8);
              const reached = launched.get(row.client) ?? new Set<string>();
              const spans = windows.get(row.client) ?? [];
              const concurrent = spans.some(([first, last], index) =>
                spans.some(
                  ([otherFirst, otherLast], other) =>
                    other > index && otherFirst <= last && first <= otherLast,
                ),
              );
              return {
                ...base,
                id: prefix,
                kind:
                  signIn.peerLink === 1 ? ("linked_agent" as const) : ("outside_client" as const),
                label: signIn.label ?? "unlabelled sign-in",
                sessionPrefix: prefix,
                runs24h: [...reached].reduce((sum, id) => sum + (runs.get(id) ?? 0), 0),
                frozen: null,
                attribution: concurrent
                  ? ("shared, unattributable" as const)
                  : ("attributed" as const),
                connections: spans.length,
              };
            }
            const thread = threads.get(row.client);
            // A sign-in logs under its own session id, so a miss in both tables is a removed sign-in.
            if (thread === undefined && row.client === row.session) {
              return {
                ...base,
                id: row.client.slice(0, 8),
                kind: "outside_client" as const,
                label: "removed sign-in",
                sessionPrefix: row.client.slice(0, 8),
                runs24h: 0,
                frozen: null,
                attribution: "attributed" as const,
              };
            }
            return {
              ...base,
              id: row.client,
              kind:
                thread === undefined
                  ? ("local_thread" as const)
                  : thread.scheduled === 1
                    ? ("scheduled_task" as const)
                    : thread.delegate === 1
                      ? ("delegate" as const)
                      : ("local_thread" as const),
              label: thread?.title ?? "removed thread",
              sessionPrefix: row.session.slice(0, 8),
              threadId: ThreadId.make(row.client),
              runs24h: runs.get(row.client) ?? 0,
              frozen: thread === undefined ? false : thread.frozen === 1,
              attribution: "attributed" as const,
            };
          });
          const last = rows.at(-1)!;
          return {
            scope: caller.seesAll ? ("all" as const) : ("own" as const),
            now,
            items,
            nextCursor: page.length > limit ? String(last.lastId) : null,
          };
        }),
      )
      .pipe(NodeSqliteClient.readOnly, Effect.mapError(storage));
  });
  return AgentRegistry.of({ list });
});
export const layer = Layer.effect(AgentRegistry, make);
