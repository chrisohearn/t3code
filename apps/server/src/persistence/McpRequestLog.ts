import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const RETENTION_MS = 14 * 24 * 60 * 60 * 1_000;
const MAX_ROWS = 100_000;
const Counts = Schema.Struct({
  calls: Schema.Number,
  errors: Schema.Number,
  requestBytes: Schema.Number,
  responseBytes: Schema.Number,
  p50Ms: Schema.Number,
  p95Ms: Schema.Number,
});
export const UsageInput = Schema.Struct({
  since: Schema.optional(Schema.Number),
  until: Schema.optional(Schema.Number),
  clientCursor: Schema.optional(Schema.String),
});
export const UsageResult = Schema.Struct({
  since: Schema.Number,
  until: Schema.Number,
  retentionDays: Schema.Number,
  byTool: Schema.Array(Schema.Struct({ tool: Schema.String, ...Counts.fields })),
  nextClientCursor: Schema.NullOr(Schema.String),
  byClient: Schema.Array(Schema.Struct({ client: Schema.String, ...Counts.fields })),
});
interface RequestEntry {
  readonly client: string;
  readonly session: string;
  readonly tool: string;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly errorClass: string | null;
}
export class McpRequestLog extends Context.Service<
  McpRequestLog,
  {
    readonly record: (entry: RequestEntry) => Effect.Effect<void, OrchestratorMcpFailure>;
    readonly usage: (
      input: typeof UsageInput.Type,
      client: string | undefined,
    ) => Effect.Effect<typeof UsageResult.Type, OrchestratorMcpFailure>;
  }
>()("t3/persistence/McpRequestLog") {}
const storage = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "Could not access MCP usage.",
  });
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const prune = Effect.fn("McpRequestLog.prune")(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* sql`DELETE FROM mcp_request_log WHERE started_at < ${now - RETENTION_MS}`;
    yield* sql`DELETE FROM mcp_request_log WHERE id <= (SELECT MAX(id) - ${MAX_ROWS} FROM mcp_request_log)`;
  });
  const record = Effect.fn("McpRequestLog.record")((entry: RequestEntry) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO mcp_request_log (client, session, tool, started_at, duration_ms, request_bytes, response_bytes, error_class)
        VALUES (${entry.client}, ${entry.session}, ${entry.tool}, ${entry.startedAt}, ${entry.durationMs}, ${entry.requestBytes}, ${entry.responseBytes}, ${entry.errorClass})`;
          yield* prune();
        }),
      )
      .pipe(Effect.mapError(storage)),
  );
  const usage = Effect.fn("McpRequestLog.usage")(function* (
    input: typeof UsageInput.Type,
    client: string | undefined,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const since = Math.max(input.since ?? now - 24 * 60 * 60 * 1_000, now - RETENTION_MS);
    const until = input.until ?? now;
    if (!Number.isFinite(since) || !Number.isFinite(until) || since > until || until > now) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "Use a finite past time window in epoch milliseconds, since <= until.",
      });
    }
    yield* prune().pipe(Effect.mapError(storage));
    const aggregate = (column: "tool" | "client") =>
      sql<{
        readonly name: string;
        readonly calls: number;
        readonly errors: number;
        readonly requestBytes: number;
        readonly responseBytes: number;
        readonly p50Ms: number;
        readonly p95Ms: number;
      }>`WITH ranked AS (
      SELECT ${sql(column)} AS name, duration_ms, request_bytes, response_bytes, error_class,
        ROW_NUMBER() OVER (PARTITION BY ${sql(column)} ORDER BY duration_ms) AS rank,
        COUNT(*) OVER (PARTITION BY ${sql(column)}) AS total
      FROM mcp_request_log WHERE started_at >= ${since} AND started_at <= ${until}
        ${client === undefined ? sql`` : sql`AND client = ${client}`}
        ${column === "client" && input.clientCursor !== undefined ? sql`AND client > ${input.clientCursor}` : sql``}
    ) SELECT name, COUNT(*) AS calls, SUM(error_class IS NOT NULL) AS errors,
      SUM(request_bytes) AS "requestBytes", SUM(response_bytes) AS "responseBytes",
      MAX(CASE WHEN rank = (total + 1) / 2 THEN duration_ms END) AS "p50Ms",
      MAX(CASE WHEN rank = (total * 95 + 99) / 100 THEN duration_ms END) AS "p95Ms"
      FROM ranked GROUP BY name ORDER BY name ${column === "client" ? sql`LIMIT 101` : sql``}`.pipe(
        Effect.mapError(storage),
      );
    const clients = yield* aggregate("client");
    return {
      since,
      until,
      retentionDays: 14,
      byTool: (yield* aggregate("tool")).map(({ name, ...counts }) => ({ tool: name, ...counts })),
      nextClientCursor: clients.length > 100 ? clients[99]!.name : null,
      byClient: clients.slice(0, 100).map(({ name, ...counts }) => ({
        client: name,
        ...counts,
      })),
    };
  });
  return McpRequestLog.of({ record, usage });
});
export const layer = Layer.effect(McpRequestLog, make);
