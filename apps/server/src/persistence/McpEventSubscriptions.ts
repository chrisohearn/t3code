import { McpEventName, McpEventsError, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const SubscriptionRow = Schema.Struct({
  id: Schema.String,
  principal: Schema.String,
  name: McpEventName,
  threadId: ThreadId,
  url: Schema.String,
  sourceUrl: Schema.String,
  secret: Schema.RedactedFromValue(Schema.String),
  previousSecret: Schema.NullOr(Schema.RedactedFromValue(Schema.String)),
  rotationUntil: Schema.Number,
  expiresAt: Schema.Number,
  active: Schema.Number,
  scanCursor: Schema.Number,
  ackCursor: Schema.Number,
  truncated: Schema.Number,
});
export type Subscription = typeof SubscriptionRow.Type;

export class McpEventSubscriptions extends Context.Service<
  McpEventSubscriptions,
  {
    readonly get: (id: string) => Effect.Effect<Subscription | undefined, McpEventsError>;
    readonly active: (now: number) => Effect.Effect<ReadonlyArray<Subscription>, McpEventsError>;
    readonly save: (
      input: Omit<Subscription, "previousSecret" | "rotationUntil"> & { readonly now: number },
    ) => Effect.Effect<void, McpEventsError>;
    readonly stop: (id: string, principal: string) => Effect.Effect<void, McpEventsError>;
  }
>()("t3/persistence/McpEventSubscriptions") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const select = sql`SELECT id, principal, name, thread_id AS "threadId", callback_url AS url, source_url AS "sourceUrl",
    secret, previous_secret AS "previousSecret", rotation_until AS "rotationUntil", expires_at AS "expiresAt",
    active, scan_cursor AS "scanCursor", ack_cursor AS "ackCursor", truncated FROM mcp_event_subscriptions`;
  const decode = Schema.decodeUnknownEffect(Schema.Array(SubscriptionRow));
  return McpEventSubscriptions.of({
    get: Effect.fn("McpEventSubscriptions.get")((id) =>
      sql`${select} WHERE id = ${id}`.pipe(
        Effect.flatMap(decode),
        Effect.map((rows) => rows[0]),
        Effect.mapError(() => new McpEventsError({ code: -32603, reason: "storage" })),
      ),
    ),
    active: Effect.fn("McpEventSubscriptions.active")((now) =>
      sql`${select} WHERE active = 1 AND expires_at > ${now}`.pipe(
        Effect.flatMap(decode),
        Effect.mapError(() => new McpEventsError({ code: -32603, reason: "storage" })),
      ),
    ),
    save: Effect.fn("McpEventSubscriptions.save")((input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
      INSERT INTO mcp_event_subscriptions (id, principal, name, thread_id, callback_url, source_url, secret, previous_secret,
        rotation_until, expires_at, active, scan_cursor, ack_cursor, truncated)
      VALUES (${input.id}, ${input.principal}, ${input.name}, ${input.threadId}, ${input.url}, ${input.sourceUrl},
        ${Redacted.value(input.secret)}, NULL, 0, ${input.expiresAt}, 1, ${input.scanCursor}, ${input.ackCursor}, ${input.truncated})
      ON CONFLICT(id) DO UPDATE SET
        previous_secret = CASE WHEN secret <> excluded.secret AND secret <> '' THEN secret
          WHEN rotation_until > ${input.now} THEN previous_secret ELSE NULL END,
        rotation_until = CASE WHEN secret <> excluded.secret THEN ${input.now + 300_000} ELSE rotation_until END,
        secret = excluded.secret, source_url = excluded.source_url, expires_at = excluded.expires_at, active = 1,
        scan_cursor = MIN(scan_cursor, excluded.scan_cursor), ack_cursor = MIN(ack_cursor, excluded.ack_cursor),
        truncated = excluded.truncated
      `;
            yield* sql`UPDATE mcp_event_deliveries SET body = json_set(body, '$.cursor', ${String(input.ackCursor)})
        WHERE subscription_id = ${input.id} AND CAST(json_extract(body, '$.cursor') AS INTEGER) > ${input.ackCursor}`;
          }),
        )
        .pipe(Effect.mapError(() => new McpEventsError({ code: -32603, reason: "storage" }))),
    ),
    stop: Effect.fn("McpEventSubscriptions.stop")((id, principal) =>
      sql`
      UPDATE mcp_event_subscriptions SET active = 0, secret = '', previous_secret = NULL, rotation_until = 0
      WHERE id = ${id} AND principal = ${principal}
    `.pipe(
        Effect.asVoid,
        Effect.mapError(() => new McpEventsError({ code: -32603, reason: "storage" })),
      ),
    ),
  });
});
export const layer = Layer.effect(McpEventSubscriptions, make);
