import { McpEventsError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
interface Status {
  readonly lastSuccessAt: number | null;
  readonly exhaustedRetries: number;
}
export class McpBridgeStatus extends Context.Service<
  McpBridgeStatus,
  {
    readonly read: (principal: string) => Effect.Effect<Status, McpEventsError>;
    readonly delivered: (principal: string, now: number) => Effect.Effect<void, McpEventsError>;
    readonly exhausted: (principal: string) => Effect.Effect<void, McpEventsError>;
  }
>()("t3/persistence/McpBridgeStatus") {}
const storage = () => new McpEventsError({ code: -32603, reason: "storage" });
export const layer = Layer.effect(
  McpBridgeStatus,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return McpBridgeStatus.of({
      read: Effect.fn("McpBridgeStatus.read")((principal) =>
        sql<Status>`SELECT last_success_at AS "lastSuccessAt", exhausted_retries AS "exhaustedRetries" FROM mcp_bridge_status WHERE principal = ${principal}`.pipe(
          Effect.map((rows) => rows[0] ?? { lastSuccessAt: null, exhaustedRetries: 0 }),
          Effect.mapError(storage),
        ),
      ),
      delivered: Effect.fn("McpBridgeStatus.delivered")((principal, now) =>
        sql`INSERT INTO mcp_bridge_status (principal, last_success_at) VALUES (${principal}, ${now}) ON CONFLICT(principal) DO UPDATE SET last_success_at = MAX(COALESCE(last_success_at, 0), excluded.last_success_at)`.pipe(
          Effect.asVoid,
          Effect.mapError(storage),
        ),
      ),
      exhausted: Effect.fn("McpBridgeStatus.exhausted")((principal) =>
        sql`INSERT INTO mcp_bridge_status (principal, exhausted_retries) VALUES (${principal}, 1) ON CONFLICT(principal) DO UPDATE SET exhausted_retries = exhausted_retries + 1`.pipe(
          Effect.asVoid,
          Effect.mapError(storage),
        ),
      ),
    });
  }),
);
