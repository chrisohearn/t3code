import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, McpEventsError, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";
import { Tool, Toolkit } from "effect/ai";

import * as ServerSettings from "../serverSettings.ts";
import * as McpEvents from "./McpEvents.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as Invocation from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as McpToolAccess from "./McpToolAccess.ts";

const json = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.effect(
  "advertises and dispatches Events on the authenticated MCP endpoint while retaining tools and session admission",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const principals: Array<string> = [];
        const secrets: Array<string> = [];
        const layerEvents = Layer.mock(McpEvents.McpEvents)({
          list: () =>
            Invocation.McpInvocationContext.pipe(
              Effect.map((scope) => {
                principals.push(scope.client!.sessionId);
                return { events: [] };
              }),
            ),
          subscribe: (input) =>
            Effect.sync(() => {
              secrets.push(Redacted.value(input.delivery.secret));
            }).pipe(
              Effect.andThen(
                Effect.fail(new McpEventsError({ code: -32015, reason: "challenge_failed" })),
              ),
            ),
          listSubscriptions: () =>
            Effect.succeed({
              subscriptions: [
                {
                  id: "fixture-sub",
                  name: "thread.run.result",
                  arguments: { threadId: ThreadId.make("fixture-thread") },
                  callbackOrigin: "https://callbacks.example.com",
                  status: "active",
                  expiresAt: "2026-11-10T00:00:00.000Z",
                  cursor: "1",
                },
              ],
            }),
          unsubscribe: () => Effect.succeed({}),
        });
        const toolkit = Toolkit.make(
          Tool.make("fixture_read", {
            description: "Reads the fixture.",
            success: Schema.Struct({ ok: Schema.Boolean }),
            dependencies: [Invocation.McpInvocationContext],
          }),
        );
        const registration = McpHttpServer.toolkitRegistration(
          toolkit,
          McpToolAccess.toLayer(toolkit, {
            fixture_read: McpToolAccess.reads(() =>
              Invocation.McpInvocationContext.pipe(Effect.as({ ok: true })),
            ),
          }),
        );
        const layer = McpHttpServer.layerMcpTransport(registration).pipe(
          Layer.provide(
            Layer.mergeAll(
              layerEvents,
              ServerSettings.layerTest(),
              Layer.mock(McpSessionRegistry.McpSessionRegistry)({
                resolve: () => Effect.undefined,
              }),
              Layer.succeed(McpHttpServer.McpClientAuthenticator, {
                authenticate: (request) =>
                  Effect.succeed(
                    request.headers.authorization === "Bearer fixture-token"
                      ? {
                          environmentId: EnvironmentId.make("fixture-environment"),
                          issuedAt: 0,
                          requestNamespace: "fixture-session",
                          thread: undefined,
                          client: {
                            sessionId: "fixture-session",
                            label: "fixture",
                            access: "read-only",
                          },
                          capabilities: new Set(["orchestration"]),
                        }
                      : undefined,
                  ),
              }),
            ),
          ),
        );
        yield* HttpRouter.serve(layer, { disableListenLog: true, disableLogger: true }).pipe(
          Layer.build,
        );
        const client = yield* HttpClient.HttpClient;
        const post = (message: object, session?: string, authorization = "Bearer fixture-token") =>
          client.post("/mcp", {
            headers: {
              authorization,
              accept: "application/json, text/event-stream",
              ...(session === undefined ? {} : { "mcp-session-id": session }),
              "mcp-protocol-version": "2025-06-18",
            },
            body: HttpBody.text(encode(message), "application/json"),
          });
        const decode = (body: string) =>
          json(
            body.trim().startsWith("{")
              ? body
              : body
                  .split("\n")
                  .find((line) => line.startsWith("data:"))!
                  .slice(5),
          ) as {
            result?: {
              capabilities?: { events?: object };
              tools?: ReadonlyArray<unknown>;
              events?: ReadonlyArray<unknown>;
              subscriptions?: ReadonlyArray<unknown>;
              structuredContent?: unknown;
            };
            error?: { code: number; data?: { reason: string } };
          };
        const init = {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "fixture", version: "1" },
          },
        };
        expect((yield* post(init, undefined, "Bearer invalid")).status).toBe(401);
        const response = yield* post(init);
        expect(response.status).toBe(200);
        const session = response.headers["mcp-session-id"]!;
        const initialized = decode(yield* response.text);
        expect(initialized).toMatchObject({
          result: { capabilities: { events: {}, tools: { listChanged: true } } },
        });
        // Strict clients (Claude Code) reject `instructions: null`; an unset value must be absent.
        expect(initialized.result).not.toHaveProperty("instructions");
        expect(initialized.result).not.toHaveProperty("_meta");
        const list = yield* post(
          {
            jsonrpc: "2.0",
            id: 2,
            method: "events/list",
            params: { _meta: { progressToken: "fixture" } },
          },
          session,
        );
        expect(decode(yield* list.text).result?.events).toEqual([]);
        expect(principals).toEqual(["fixture-session"]);
        const subscriptions = yield* post(
          { jsonrpc: "2.0", id: 21, method: "events/subscriptions/list", params: { _meta: {} } },
          session,
        );
        expect(decode(yield* subscriptions.text).result?.subscriptions).toMatchObject([
          { id: "fixture-sub", callbackOrigin: "https://callbacks.example.com" },
        ]);
        const revoked = yield* post(
          {
            jsonrpc: "2.0",
            id: 22,
            method: "events/unsubscribe",
            params: { id: "fixture-sub", _meta: {} },
          },
          session,
        );
        expect(decode(yield* revoked.text).result).toEqual({});
        const tools = yield* post(
          { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
          session,
        );
        expect(decode(yield* tools.text).result?.tools).toMatchObject([{ name: "fixture_read" }]);
        const toolResult = yield* post(
          {
            jsonrpc: "2.0",
            id: 31,
            method: "tools/call",
            params: { name: "fixture_read", arguments: {} },
          },
          session,
        );
        expect(decode(yield* toolResult.text).result?.structuredContent).toEqual({ ok: true });
        const secret = `whsec_${Buffer.alloc(32, 1).toString("base64")}`;
        const params = {
          name: "thread.run.result",
          arguments: { threadId: "fixture-thread" },
          delivery: { mode: "webhook", url: "https://callbacks.example.com/events", secret },
        };
        const failed = yield* post(
          {
            jsonrpc: "2.0",
            id: 4,
            method: "events/subscribe",
            params: { ...params, _meta: { progressToken: "fixture" } },
          },
          session,
        );
        const body = yield* failed.text;
        expect(decode(body).error).toEqual({
          code: -32015,
          message: "The MCP Events request could not be completed.",
          data: { reason: "challenge_failed" },
        });
        expect(body).not.toContain(secret);
        expect(body).not.toContain(params.delivery.url);
        expect(secrets).toEqual([secret]);
        const invalid = yield* post(
          {
            jsonrpc: "2.0",
            id: 5,
            method: "events/subscribe",
            params: { ...params, arguments: { threadId: "fixture-thread", unapproved: true } },
          },
          session,
        );
        expect(decode(yield* invalid.text).error?.code).toBe(-32602);
        expect(secrets).toHaveLength(1);
        const unsubscribed = yield* post(
          {
            jsonrpc: "2.0",
            id: 51,
            method: "events/unsubscribe",
            params: {
              name: params.name,
              arguments: params.arguments,
              delivery: { mode: "webhook", url: params.delivery.url },
            },
          },
          session,
        );
        expect(decode(yield* unsubscribed.text).result).toEqual({});
        const unknown = yield* post(
          { jsonrpc: "2.0", id: 6, method: "events/list", params: {} },
          "unknown",
        );
        expect(unknown.status).toBe(404);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
