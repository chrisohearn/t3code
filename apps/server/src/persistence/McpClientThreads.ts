import { ThreadId, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
interface Provenance {
  readonly threadId: ThreadId;
  readonly sessionId: string;
  readonly clientLabel: string;
}
export class McpClientThreads extends Context.Service<
  McpClientThreads,
  {
    readonly record: (input: Provenance) => Effect.Effect<void, OrchestratorMcpFailure>;
    /** Rows for these threads, or for this sign-in session. */
    readonly list: (
      filter: { readonly threadIds: ReadonlyArray<ThreadId> } | { readonly sessionId: string },
    ) => Effect.Effect<ReadonlyArray<Provenance>, OrchestratorMcpFailure>;
  }
>()("t3/persistence/McpClientThreads") {}
const storage = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "Could not access MCP thread provenance.",
  });
export const layer = Layer.effect(
  McpClientThreads,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return McpClientThreads.of({
      record: Effect.fn("McpClientThreads.record")(function* (input) {
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* sql`INSERT INTO mcp_client_threads (thread_id, session_id, client_label, created_at) VALUES (${input.threadId}, ${input.sessionId}, ${input.clientLabel}, ${now}) ON CONFLICT(thread_id) DO NOTHING`.pipe(
          Effect.mapError(storage),
        );
      }),
      list: Effect.fn("McpClientThreads.list")((filter) =>
        sql<Provenance>`SELECT thread_id AS "threadId", session_id AS "sessionId", client_label AS "clientLabel" FROM mcp_client_threads
          WHERE ${
            "sessionId" in filter
              ? sql`session_id = ${filter.sessionId}`
              : sql`thread_id IN (SELECT value FROM json_each(${JSON.stringify(filter.threadIds)}))`
          }`.pipe(Effect.mapError(storage)),
      ),
    });
  }),
);
