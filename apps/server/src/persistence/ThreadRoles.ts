import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

/** Room for a 4000-character role, a 1000-character done format and the line that introduces it. */
export const THREAD_ROLE_STORED_MAX_CHARS = 5200;

export interface ThreadRoleRecord {
  readonly text: string;
  /** Counts each set, so a changed role is told apart from one already delivered. */
  readonly revision: number;
  readonly updatedAt: string;
  readonly updatedBy: string;
  /** Where the provider last accepted this role, if it did. */
  readonly delivered?: {
    readonly revision: number;
    readonly nativeThreadId: string | null;
    readonly runOrdinal: number;
  };
}

export class ThreadRoles extends Context.Service<
  ThreadRoles,
  {
    /** Read at each provider turn start, so a role set after the session began still applies. */
    readonly get: (
      threadId: string,
    ) => Effect.Effect<ThreadRoleRecord | undefined, OrchestratorMcpFailure>;
    /** An empty or null `role` clears it. */
    readonly set: (
      threadId: string,
      role: string | null,
      updatedBy: string,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
    /** Recorded after the provider accepts a turn that carried revision `revision`. */
    readonly markDelivered: (
      threadId: string,
      delivery: { revision: number; nativeThreadId: string | null; runOrdinal: number },
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
  }
>()("t3/persistence/ThreadRoles") {}

const storage = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "Could not access the thread's standing role.",
  });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return ThreadRoles.of({
    get: Effect.fn("ThreadRoles.get")(function* (threadId) {
      const [row] = yield* sql<{
        role_text: string;
        revision: number;
        updated_at: string;
        updated_by: string;
        delivered_revision: number | null;
        delivered_native_thread_id: string | null;
        delivered_run_ordinal: number | null;
      }>`SELECT role_text, revision, updated_at, updated_by, delivered_revision,
          delivered_native_thread_id, delivered_run_ordinal
        FROM thread_standing_roles WHERE thread_id = ${threadId}`.pipe(Effect.mapError(storage));
      if (row === undefined) return undefined;
      return {
        text: row.role_text,
        revision: row.revision,
        updatedAt: row.updated_at,
        updatedBy: row.updated_by,
        ...(row.delivered_revision === null || row.delivered_run_ordinal === null
          ? {}
          : {
              delivered: {
                revision: row.delivered_revision,
                nativeThreadId: row.delivered_native_thread_id,
                runOrdinal: row.delivered_run_ordinal,
              },
            }),
      };
    }),
    set: Effect.fn("ThreadRoles.set")(function* (threadId, role, updatedBy) {
      const text = role?.trim() ?? "";
      if (text === "") {
        yield* sql`DELETE FROM thread_standing_roles WHERE thread_id = ${threadId}`.pipe(
          Effect.mapError(storage),
        );
        return;
      }
      if (text.length > THREAD_ROLE_STORED_MAX_CHARS)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `A standing role is at most ${THREAD_ROLE_STORED_MAX_CHARS} characters with its done format.`,
        });
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`INSERT INTO thread_standing_roles (thread_id, role_text, revision, updated_at, updated_by)
        VALUES (${threadId}, ${text}, 1, ${now}, ${updatedBy})
        ON CONFLICT (thread_id) DO UPDATE SET role_text = excluded.role_text,
          revision = thread_standing_roles.revision + 1,
          updated_at = excluded.updated_at, updated_by = excluded.updated_by`.pipe(
        Effect.mapError(storage),
      );
    }),
    markDelivered: Effect.fn("ThreadRoles.markDelivered")(function* (threadId, delivery) {
      // A role changed while the turn started keeps its newer revision, so it is sent again.
      yield* sql`UPDATE thread_standing_roles SET delivered_revision = ${delivery.revision},
        delivered_native_thread_id = ${delivery.nativeThreadId},
        delivered_run_ordinal = ${delivery.runOrdinal}
        WHERE thread_id = ${threadId} AND revision = ${delivery.revision}`.pipe(
        Effect.mapError(storage),
      );
    }),
  });
});

export const layer = Layer.effect(ThreadRoles, make);
