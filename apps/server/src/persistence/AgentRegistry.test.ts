import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as Registry from "./AgentRegistry.ts";
import * as Log from "./McpRequestLog.ts";
import * as Sqlite from "./Sqlite.ts";

const DAY = 24 * 60 * 60 * 1_000;
const now = 20 * DAY;
const shared = "963da7fc-7a35-4939-b709-dfd27d40d323";
const reconnecting = "03857f09-0d4b-4d2f-8244-3171f050721f";
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

it.effect(
  "lists sign-ins and thread agents, flags a sign-in used at once, and pages by recency",
  () =>
    Effect.gen(function* () {
      const registry = yield* Registry.AgentRegistry;
      const log = yield* Log.McpRequestLog;
      const sql = yield* SqlClient.SqlClient;
      yield* TestClock.setTime(now);
      const call = (
        client: string,
        tool: string,
        startedAt: number,
        options: { readonly session?: string; readonly connection?: string } = {},
      ) =>
        log.record({
          client,
          session: options.session ?? client,
          tool,
          startedAt,
          connection: options.connection,
          durationMs: 1,
          requestBytes: 1,
          responseBytes: 1,
          errorClass: null,
        });
      // Two connections active over the same minutes behind one sign-in.
      yield* call(shared, "t3_thread_send", now - 10, { connection: "1:1" });
      yield* call(shared, "t3_thread_read", now - 20, { connection: "1:2" });
      yield* call(shared, "t3_thread_read", now - 30, { connection: "1:1" });
      yield* call(shared, "t3_thread_read", now - 25, { connection: "1:2" });
      // One agent that reconnected: its connections never overlap.
      yield* call(reconnecting, "ledger_query", now - 30_000, { connection: "1:3" });
      yield* call(reconnecting, "ledger_query", now - 5, { connection: "1:4" });
      const thread = (id: string, tool: string, at: number, session: string) =>
        call(id, tool, at, { session });
      yield* thread("thread:frozen", "t3_thread_read", now - 40, "provider-session-1");
      yield* thread("thread:child", "ledger_upsert", now - 50, "provider-session-2");
      yield* thread("thread:cron", "ledger_query", now - 60, "provider-session-3");
      yield* thread("thread:stale", "ledger_query", now - 3 * DAY, "provider-session-4");

      for (const [id, label] of [
        [shared, "Codex"],
        [reconnecting, "Jarvis"],
      ] as const) {
        yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, client_label, issued_at, expires_at)
          VALUES (${id}, 'mcp-client', '[]', 'bearer-access-token', ${label}, ${iso(0)}, ${iso(now + DAY)})`;
        yield* sql`INSERT INTO mcp_oauth_sessions (session_id, client_id, resource, access, peer_link, offline_access)
          VALUES (${id}, 'client', 'resource', 'full-access', 0, 0)`;
      }
      const insertThread = (id: string, title: string, payload: object) =>
        sql`INSERT INTO orchestration_v2_projection_threads
          (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
          VALUES (${id}, 'project', ${title}, 'codex', 'full-access', 'default', ${iso(0)}, ${iso(0)}, ${JSON.stringify(payload)})`;
      yield* insertThread("thread:frozen", "Inbox", { frozen: { reason: "x" } });
      yield* insertThread("thread:child", "Child", {
        lineage: { relationshipToParent: "subagent" },
      });
      yield* insertThread("thread:cron", "Cron", {});
      yield* insertThread("thread:stale", "Stale", {});
      yield* sql`INSERT INTO scheduled_tasks (task_id, title, prompt, enabled, schedule_json, project_id, thread_id,
          workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode, created_by, creation_source,
          created_at, updated_at, last_run_status, run_count)
        VALUES ('task', 'Cron', 'p', 1, '{}', 'project', 'thread:cron', '{}', '{}', 'full-access', 'default', 'user', 'web',
          ${iso(0)}, ${iso(0)}, 'idle', 0)`;
      yield* sql`INSERT INTO mcp_client_threads (thread_id, session_id, client_label, created_at)
        VALUES ('thread:frozen', ${shared}, 'Codex', ${iso(0)})`;
      for (const [id, threadId, at, ordinal] of [
        ["r-recent", "thread:frozen", now - 1_000, 3],
        ["r-cron", "thread:cron", now - 2_000, 2],
        ["r-old", "thread:frozen", now - 2 * DAY, 1],
      ] as const) {
        yield* sql`INSERT INTO orchestration_v2_projection_runs
          (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
          VALUES (${id}, ${threadId}, ${ordinal}, 'codex', 'completed', ${iso(at)}, '{}')`;
      }

      const everyone = { sessionId: undefined, seesAll: true };
      // Newest call first, by log order.
      const first = yield* registry.list({ limit: 3 }, everyone);
      expect(first.items.map((item) => [item.id, item.kind, item.frozen])).toEqual([
        ["thread:stale", "local_thread", false],
        ["thread:cron", "scheduled_task", false],
        ["thread:child", "delegate", false],
      ]);
      expect(first.items[0]?.calls24h).toBe(0);
      // The cursor is a log row number: it names no agent or sign-in.
      expect(first.nextCursor).toMatch(/^\d+$/);
      const second = yield* registry.list(
        { limit: 3, ...(first.nextCursor === null ? {} : { cursor: first.nextCursor }) },
        everyone,
      );
      expect(second.items.map((item) => [item.id, item.kind])).toEqual([
        ["thread:frozen", "local_thread"],
        ["03857f09", "outside_client"],
        ["963da7fc", "outside_client"],
      ]);
      expect(second.nextCursor).toBeNull();
      expect(second.items[0]).toMatchObject({
        frozen: true,
        sessionPrefix: "provider",
        runs24h: 1,
      });
      expect(second.items[2]).toMatchObject({
        label: "Codex",
        lastTool: "t3_thread_read",
        calls24h: 4,
        runs24h: 1,
        connections: 2,
        attribution: "shared, unattributable",
        frozen: null,
      });
      expect(second.items[1]).toMatchObject({ attribution: "attributed", connections: 2 });

      const own = yield* registry.list({}, { sessionId: reconnecting, seesAll: false });
      expect(own).toMatchObject({ scope: "own", items: [{ id: "03857f09" }], nextCursor: null });
      const refused = yield* registry.list({ cursor: "garbage" }, everyone).pipe(Effect.flip);
      expect(refused.code).toBe("invalid_request");
    }).pipe(
      Effect.provide(
        Registry.layer.pipe(Layer.provideMerge(Log.layer), Layer.provideMerge(Sqlite.layerMemory)),
      ),
    ),
);
