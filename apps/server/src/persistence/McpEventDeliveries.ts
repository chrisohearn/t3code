import { McpEventsError } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

export interface Delivery {
  readonly subscriptionId: string;
  readonly eventId: string;
  readonly sequence: number;
  readonly body: string;
  readonly attempts: number;
  readonly nextAttemptAt: number;
}
export class McpEventDeliveries extends Context.Service<
  McpEventDeliveries,
  {
    readonly enqueue: (input: {
      readonly subscriptionId: string;
      readonly sequence: number;
      readonly truncated: boolean;
      readonly events: ReadonlyArray<{
        readonly eventId: string;
        readonly sequence: number;
        readonly body: string;
      }>;
    }) => Effect.Effect<void, McpEventsError>;
    readonly due: (now: number) => Effect.Effect<ReadonlyArray<Delivery>, McpEventsError>;
    readonly begin: (delivery: Delivery, now: number) => Effect.Effect<void, McpEventsError>;
    readonly acknowledge: (delivery: Delivery, now: number) => Effect.Effect<void, McpEventsError>;
    readonly retry: (delivery: Delivery, nextAt: number) => Effect.Effect<void, McpEventsError>;
    readonly count: (subscriptionId: string) => Effect.Effect<number, McpEventsError>;
    readonly nextAttempt: (now: number) => Effect.Effect<number | null, McpEventsError>;
  }
>()("t3/persistence/McpEventDeliveries") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const advance = (
    id: string,
  ) => sql`UPDATE mcp_event_subscriptions SET ack_cursor = MAX(ack_cursor,
    MIN(scan_cursor, COALESCE((SELECT MIN(sequence) - 1 FROM mcp_event_deliveries
      WHERE subscription_id = ${id} AND acknowledged = 0), scan_cursor))) WHERE id = ${id}`;
  const storage = () => new McpEventsError({ code: -32603, reason: "storage" });
  return McpEventDeliveries.of({
    enqueue: Effect.fn("McpEventDeliveries.enqueue")((input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            for (const event of input.events) {
              yield* sql`INSERT INTO mcp_event_deliveries (subscription_id, event_id, sequence, body)
          VALUES (${input.subscriptionId}, ${event.eventId}, ${event.sequence}, ${event.body}) ON CONFLICT DO NOTHING`;
            }
            yield* sql`UPDATE mcp_event_subscriptions SET scan_cursor = MAX(scan_cursor, ${input.sequence}),
        truncated = MAX(truncated, ${input.truncated ? 1 : 0}) WHERE id = ${input.subscriptionId}`;
            yield* advance(input.subscriptionId);
          }),
        )
        .pipe(Effect.mapError(storage)),
    ),
    due: Effect.fn("McpEventDeliveries.due")((now) =>
      sql<Delivery>`SELECT
      d.subscription_id AS "subscriptionId", d.event_id AS "eventId", d.sequence, d.body, d.attempts,
      d.next_attempt_at AS "nextAttemptAt" FROM mcp_event_deliveries d
      JOIN mcp_event_subscriptions s ON s.id = d.subscription_id
      WHERE d.acknowledged = 0 AND d.next_attempt_at <= ${now}
        AND s.active = 1 AND s.expires_at > ${now}
      ORDER BY d.next_attempt_at, d.sequence, d.subscription_id LIMIT 256`.pipe(
        Effect.mapError(storage),
      ),
    ),
    begin: Effect.fn("McpEventDeliveries.begin")((delivery, now) =>
      sql`UPDATE mcp_event_deliveries
      SET attempts = attempts + 1, next_attempt_at = ${now + 30_000}
      WHERE subscription_id = ${delivery.subscriptionId} AND event_id = ${delivery.eventId}
    `.pipe(Effect.asVoid, Effect.mapError(storage)),
    ),
    acknowledge: Effect.fn("McpEventDeliveries.acknowledge")((delivery, now) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const acknowledged = yield* sql`UPDATE mcp_event_deliveries SET acknowledged = 1
        WHERE subscription_id = ${delivery.subscriptionId} AND event_id = ${delivery.eventId}
          AND acknowledged = 0 RETURNING event_id`;
            if (acknowledged.length > 0) {
              yield* sql`UPDATE mcp_event_subscriptions AS s
                SET expires_at = MIN(${now} + a.renewal_ttl_ms,
                  CAST(unixepoch(p.expires_at, 'subsec') * 1000 AS INTEGER))
                FROM mcp_event_subscription_activity AS a, auth_sessions AS p
                WHERE s.id = ${delivery.subscriptionId} AND a.subscription_id = s.id
                  AND p.session_id = s.principal AND p.revoked_at IS NULL
                  AND p.expires_at > ${DateTime.formatIso(DateTime.makeUnsafe(now))}
                  AND s.active = 1 AND s.expires_at > ${now} AND a.renewal_ttl_ms > 0`;
            }
            yield* advance(delivery.subscriptionId);
            yield* sql`DELETE FROM mcp_event_deliveries WHERE subscription_id = ${delivery.subscriptionId}
        AND acknowledged = 1 AND sequence <= (SELECT ack_cursor FROM mcp_event_subscriptions WHERE id = ${delivery.subscriptionId})`;
          }),
        )
        .pipe(Effect.mapError(storage)),
    ),
    retry: Effect.fn("McpEventDeliveries.retry")((delivery, nextAt) =>
      sql`UPDATE mcp_event_deliveries
      SET next_attempt_at = ${nextAt} WHERE subscription_id = ${delivery.subscriptionId} AND event_id = ${delivery.eventId}
    `.pipe(Effect.asVoid, Effect.mapError(storage)),
    ),
    count: Effect.fn("McpEventDeliveries.count")((id) =>
      sql<{ count: number }>`SELECT COUNT(*) AS count
      FROM mcp_event_deliveries WHERE subscription_id = ${id}`.pipe(
        Effect.map((rows) => rows[0]?.count ?? 0),
        Effect.mapError(storage),
      ),
    ),
    nextAttempt: Effect.fn("McpEventDeliveries.nextAttempt")((now) =>
      sql<{ next: number | null }>`
      SELECT MIN(d.next_attempt_at) AS next FROM mcp_event_deliveries d JOIN mcp_event_subscriptions s ON s.id = d.subscription_id
      WHERE d.acknowledged = 0 AND s.active = 1 AND s.expires_at > ${now}
    `.pipe(
        Effect.map((rows) => rows[0]?.next ?? null),
        Effect.mapError(storage),
      ),
    ),
  });
});
export const layer = Layer.effect(McpEventDeliveries, make);
