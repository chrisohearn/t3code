import { McpEventName, McpEventsError, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const isMcpEventsError = Schema.is(McpEventsError);

const SubscriptionRow = Schema.Struct({
  refreshedAt: Schema.Number,
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
    readonly forPrincipal: (
      principal: string,
    ) => Effect.Effect<ReadonlyArray<Subscription>, McpEventsError>;
    readonly remove: (id: string, principal: string) => Effect.Effect<void, McpEventsError>;
    readonly save: (
      input: Omit<Subscription, "previousSecret" | "rotationUntil" | "refreshedAt"> & {
        readonly now: number;
      },
    ) => Effect.Effect<void, McpEventsError>;
    readonly stop: (id: string, principal: string) => Effect.Effect<void, McpEventsError>;
  }
>()("t3/persistence/McpEventSubscriptions") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const select = sql`SELECT COALESCE((SELECT refreshed_at FROM mcp_event_subscription_activity WHERE subscription_id = mcp_event_subscriptions.id), 0) AS "refreshedAt", id, principal, name, thread_id AS "threadId", callback_url AS url, source_url AS "sourceUrl",
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
    forPrincipal: Effect.fn("McpEventSubscriptions.forPrincipal")((principal) =>
      sql`${select} WHERE principal = ${principal} ORDER BY "refreshedAt" DESC, rowid DESC`.pipe(
        Effect.flatMap(decode),
        Effect.mapError(() => new McpEventsError({ code: -32603, reason: "storage" })),
      ),
    ),
    remove: Effect.fn("McpEventSubscriptions.remove")((id, principal) =>
      sql`DELETE FROM mcp_event_subscriptions WHERE id = ${id} AND principal = ${principal}`.pipe(
        Effect.asVoid,
        Effect.mapError(() => new McpEventsError({ code: -32603, reason: "storage" })),
      ),
    ),
    save: Effect.fn("McpEventSubscriptions.save")((input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            // A dead auth principal cannot unsubscribe; its transport state must not hold capacity forever.
            yield* sql`DELETE FROM mcp_event_subscriptions WHERE principal IN (
              SELECT session_id FROM auth_sessions
              WHERE revoked_at IS NOT NULL OR expires_at <= ${DateTime.formatIso(DateTime.makeUnsafe(input.now))}
            )`;
            // An expired row stays a day, then frees its slot; the one being resubscribed is kept,
            // since an explicit resubscribe resumes from its acknowledged cursor.
            yield* sql`DELETE FROM mcp_event_subscriptions
              WHERE id <> ${input.id} AND expires_at <= ${input.now - 86_400_000}`;
            // Bound retained storage as well as live delivery. Check and activate in
            // this transaction, so distinct identities cannot race for the last slot.
            const [counts] = yield* sql<{
              total: number;
              own: number;
              active: number;
              ownActive: number;
            }>`
              SELECT COUNT(*) AS total,
                COALESCE(SUM(principal = ${input.principal}), 0) AS own,
                COALESCE(SUM(active = 1 AND expires_at > ${input.now}), 0) AS active,
                COALESCE(SUM(principal = ${input.principal} AND active = 1 AND expires_at > ${input.now}), 0) AS ownActive
              FROM mcp_event_subscriptions`;
            const [current] = yield* sql<{ active: number; expiresAt: number }>`
              SELECT active, expires_at AS "expiresAt" FROM mcp_event_subscriptions
              WHERE id = ${input.id} AND principal = ${input.principal}`;
            if (
              (current === undefined && (counts!.total >= 4096 || counts!.own >= 512)) ||
              ((current?.active !== 1 || current.expiresAt <= input.now) &&
                (counts!.active >= 4096 || counts!.ownActive >= 512))
            )
              return yield* new McpEventsError({ code: -32000, reason: "subscription_limit" });
            // Only an explicitly verified reactivation starts another bounded retry window.
            // A routine refresh of an active subscription must not replenish its attempts.
            yield* sql`UPDATE mcp_event_deliveries SET attempts = 0, next_attempt_at = ${input.now}
      WHERE subscription_id = ${input.id} AND acknowledged = 0 AND EXISTS (
        SELECT 1 FROM mcp_event_subscriptions
        WHERE id = ${input.id} AND principal = ${input.principal} AND active = 0
      )`;
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
            yield* sql`INSERT INTO mcp_event_subscription_activity (subscription_id, refreshed_at) VALUES (${input.id}, ${input.now}) ON CONFLICT(subscription_id) DO UPDATE SET refreshed_at = excluded.refreshed_at`;
            yield* sql`UPDATE mcp_event_deliveries SET body = json_set(body, '$.cursor', ${String(input.ackCursor)})
        WHERE subscription_id = ${input.id} AND CAST(json_extract(body, '$.cursor') AS INTEGER) > ${input.ackCursor}`;
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            isMcpEventsError(error)
              ? error
              : new McpEventsError({ code: -32603, reason: "storage" }),
          ),
        ),
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
