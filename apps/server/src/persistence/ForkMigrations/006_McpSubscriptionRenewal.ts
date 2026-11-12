import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE mcp_event_subscription_activity ADD COLUMN renewal_ttl_ms INTEGER NOT NULL DEFAULT 86400000`;
  // Old rows lack creation provenance; preserve their granted lifetime for rolling delivery renewal.
  yield* sql`UPDATE mcp_event_subscription_activity SET renewal_ttl_ms = MIN(604800000, MAX(60000,
    COALESCE((SELECT expires_at FROM mcp_event_subscriptions WHERE id = subscription_id) - refreshed_at, 86400000)))`;
  yield* sql`INSERT INTO mcp_event_subscription_activity (subscription_id, refreshed_at, renewal_ttl_ms)
    SELECT id, 0, 86400000 FROM mcp_event_subscriptions WHERE id NOT IN (
      SELECT subscription_id FROM mcp_event_subscription_activity
    )`;
});
