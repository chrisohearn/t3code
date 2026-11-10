import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  EventId,
  ProviderSessionId,
  ThreadId,
  mcpClientScopes,
  type McpEventSubscribe,
  McpEventsError,
  NodeId,
  ProviderInstanceId,
  ProviderDriverKind,
  type OrchestrationV2StoredEvent,
  RuntimeRequestId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as Deliveries from "../persistence/McpEventDeliveries.ts";
import * as Subscriptions from "../persistence/McpEventSubscriptions.ts";
import * as EventStore from "../persistence/OrchestrationEventStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as McpEvents from "./McpEvents.ts";
import * as Invocation from "./McpInvocationContext.ts";
import * as Webhook from "./McpEventsWebhook.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";

const environmentId = EnvironmentId.make("events-test-environment");
const secret = Redacted.make(`whsec_${Buffer.alloc(32, 7).toString("base64")}`);
const replacement = Redacted.make(`whsec_${Buffer.alloc(32, 8).toString("base64")}`);
const json = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const database = Layer.mergeAll(
  AuthSessions.layer,
  Subscriptions.layer,
  Deliveries.layer,
  EventStore.layer,
).pipe(Layer.provideMerge(Sqlite.layerMemory));
const inputFor = (id: ThreadId): McpEventSubscribe => ({
  name: "thread.resource-released",
  arguments: { threadId: id },
  delivery: { mode: "webhook", url: "https://callbacks.example.com/events", secret },
  cursor: "0",
});

const fixture = Effect.gen(function* () {
  const context = yield* Layer.build(database);
  const sessions = Context.get(context, AuthSessions.AuthSessionRepository);
  const subscriptions = Context.get(context, Subscriptions.McpEventSubscriptions);
  const deliveries = Context.get(context, Deliveries.McpEventDeliveries);
  const store = Context.get(context, EventStore.OrchestrationEventStore);
  const deleted = new Set<string>();
  const sent: Array<Parameters<Webhook.McpEventsWebhook["Service"]["send"]>[0]> = [];
  const delivered =
    yield* Queue.unbounded<Parameters<Webhook.McpEventsWebhook["Service"]["send"]>[0]>();
  const verify: Array<Parameters<Webhook.McpEventsWebhook["Service"]["verify"]>[0]> = [];
  const responses = new Map<string, number>();
  let verificationWork: Effect.Effect<void> = Effect.void;
  const layer = McpEvents.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (id) => Effect.succeed(deleted.has(id) ? null : liveThreadShell(id)),
        }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(environmentId),
        }),
        Layer.succeed(Webhook.McpEventsWebhook, {
          verify: (input) =>
            Effect.sync(() => {
              verify.push(input);
            }).pipe(Effect.andThen(Effect.suspend(() => verificationWork))),
          send: (input) =>
            Effect.sync(() => {
              sent.push(input);
              return responses.get(input.id) ?? 204;
            }).pipe(Effect.tap(() => Queue.offer(delivered, input))),
        }),
      ),
    ),
  );
  const build = () =>
    Layer.build(layer).pipe(
      Effect.provide(context),
      Effect.map((built) => Context.get(built, McpEvents.McpEvents)),
    );
  const service = yield* build();
  const principal = AuthSessionId.make("principal-1");
  const other = AuthSessionId.make("principal-2");
  for (const sessionId of [principal, other])
    yield* sessions.create({
      sessionId,
      subject: "mcp-client",
      method: "bearer-access-token",
      scopes: mcpClientScopes("read-only"),
      issuedAt: DateTime.makeUnsafe(0),
      expiresAt: DateTime.makeUnsafe(7 * 86400_000),
      client: {
        label: null,
        ipAddress: null,
        userAgent: null,
        deviceType: "bot",
        os: null,
        browser: null,
      },
    });
  const scope = (sessionId = principal): Invocation.McpInvocationScope => ({
    environmentId,
    requestNamespace: sessionId,
    thread: undefined,
    client: { sessionId, label: "test", access: "read-only" },
    capabilities: new Set(["orchestration"]),
    issuedAt: 0,
  });
  const call = <A, E>(
    effect: Effect.Effect<A, E, Invocation.McpInvocationContext>,
    sessionId = principal,
  ) => effect.pipe(Effect.provideService(Invocation.McpInvocationContext, scope(sessionId)));
  const append = (ids: ReadonlyArray<ThreadId>, suffix = "") =>
    store.appendAgentEvents({
      events: ids.map((threadId, i) => ({
        id: EventId.make(`event-${i}${suffix}`),
        threadId,
        occurredAt: DateTime.makeUnsafe(1234),
        type: "provider-session.detached" as const,
        payload: {
          providerSessionId: ProviderSessionId.make(`provider-${i}`),
          detachedAt: DateTime.makeUnsafe(1234),
          reason: "PRIVATE TEXT NEVER EXPORTED",
        },
      })),
    });
  return {
    context,
    service,
    build,
    call,
    scope,
    principal,
    other,
    sessions,
    subscriptions,
    deliveries,
    store,
    append,
    sent,
    delivered,
    verify,
    responses,
    setVerificationWork: (work: Effect.Effect<void>) => {
      verificationWork = work;
    },
    deleted,
  };
});

it.effect(
  "follows committed source events in the scoped delivery worker without an idle polling clock",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const thread = ThreadId.make("thread");
        yield* f.call(f.service.subscribe(inputFor(thread)));
        yield* f.service.run().pipe(Effect.forkScoped);
        const first = yield* f.append([thread], "-first");
        yield* f.store.publishCommitted(first);
        expect((yield* Queue.take(f.delivered)).id).toBe("event-0-first");
        const second = yield* f.append([thread], "-second");
        yield* f.store.publishCommitted(second);
        expect((yield* Queue.take(f.delivered)).id).toBe("event-0-second");
      }),
    ).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect(
  "persists 128 independent identities, contiguous acknowledgements, duplicates and restart replay",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const ids = Array.from({ length: 128 }, (_, i) => ThreadId.make(`thread-${i}`));
        const subscriptions = yield* Effect.forEach(
          ids,
          (id) => f.call(f.service.subscribe(inputFor(id))),
          { concurrency: 16 },
        );
        expect(new Set(subscriptions.map((sub) => sub.id)).size).toBe(128);
        yield* f.append(ids);
        f.responses.set("event-0", 503);
        yield* f.service.drain();
        expect(f.sent).toHaveLength(128);
        for (let i = 0; i < ids.length; i++) {
          const sent = f.sent.find((request) => request.subscriptionId === subscriptions[i]?.id)!;
          const body = json(sent.body) as {
            data: { threadId: string; revision: number; state: string };
            cursor: string;
            eventId: string;
            timestamp: string;
          };
          expect(body.data.threadId).toBe(ids[i]);
          expect(body.eventId).toBe(`event-${i}`);
          expect(body.timestamp).toBe("1970-01-01T00:00:01.234Z");
          expect(body.data.state).toBe("detached");
          expect(body.cursor).toBe("0");
          expect(sent.body).not.toContain("PRIVATE TEXT");
        }
        const pending = yield* f.subscriptions.get(subscriptions[0]!.id);
        expect(pending?.ackCursor).toBe(0);
        expect((yield* f.subscriptions.get(subscriptions[1]!.id))?.ackCursor).toBe(128);
        const restarted = yield* f.build();
        f.responses.delete("event-0");
        yield* TestClock.adjust("1 second");
        yield* restarted.drain();
        expect(f.sent).toHaveLength(129);
        expect(f.sent.at(-1)?.body).toBe(f.sent.find((request) => request.id === "event-0")?.body);
        expect((yield* f.subscriptions.get(subscriptions[0]!.id))?.ackCursor).toBe(128);
        const again = yield* f.call(restarted.subscribe({ ...inputFor(ids[0]!), cursor: "128" }));
        expect(again.id).toBe(subscriptions[0]?.id);
        expect(again.cursor).toBe("128");
        yield* restarted.drain();
        expect(f.sent).toHaveLength(129);
        expect(yield* f.store.latestApplicationSequence).toBe(128);
      }),
    ).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect("does not let an out-of-order acknowledgement skip an earlier pending delivery", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const id = (yield* f.call(f.service.subscribe(inputFor(ThreadId.make("thread"))))).id;
      const event = (sequence: number) => ({ eventId: `event-${sequence}`, sequence, body: "{}" });
      yield* f.deliveries.enqueue({
        subscriptionId: id,
        sequence: 9,
        truncated: false,
        events: [event(2), event(5), event(9)],
      });
      yield* f.deliveries.enqueue({
        subscriptionId: id,
        sequence: 9,
        truncated: false,
        events: [event(2), event(5), event(9)],
      });
      const due = yield* f.deliveries.due(0);
      expect(due).toHaveLength(3);
      yield* f.deliveries.acknowledge(due[2]!);
      expect((yield* f.subscriptions.get(id))?.ackCursor).toBe(1);
      yield* f.deliveries.acknowledge(due[0]!);
      expect((yield* f.subscriptions.get(id))?.ackCursor).toBe(4);
      yield* f.deliveries.acknowledge(due[1]!);
      expect((yield* f.subscriptions.get(id))?.ackCursor).toBe(9);
      expect(yield* f.deliveries.count(id)).toBe(0);
    }),
  ).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect(
  "isolates principals, makes unsubscribe idempotent, and rechecks revocation and deleted resources",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const thread = ThreadId.make("thread");
        const input = inputFor(thread);
        const own = yield* f.call(f.service.subscribe(input));
        const other = yield* f.call(f.service.subscribe(input), f.other);
        expect(own.id).not.toBe(other.id);
        yield* f.call(f.service.unsubscribe(input), f.other);
        yield* f.call(f.service.unsubscribe(input), f.other);
        expect((yield* f.subscriptions.get(own.id))?.active).toBe(1);
        expect(yield* f.subscriptions.get(other.id)).toBeUndefined();
        yield* f.call(f.service.subscribe(input), f.other);
        yield* f.sessions.revoke({ sessionId: f.other, revokedAt: DateTime.makeUnsafe(0) });
        yield* f.append([thread]);
        yield* f.service.drain();
        expect(f.sent.map((request) => request.subscriptionId)).toEqual([own.id]);
        expect((yield* f.call(f.service.subscribe(input), f.other).pipe(Effect.flip)).reason).toBe(
          "access_denied",
        );
        f.deleted.add(thread);
        yield* f.append([thread], "-next");
        yield* f.service.drain();
        expect(f.sent).toHaveLength(1);
        expect((yield* f.subscriptions.get(own.id))?.active).toBe(0);
      }),
    ).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect.each([
  { status: 410, attempts: 1 },
  { status: 413, attempts: 1 },
  { status: 503, attempts: 8 },
])(
  "bounds delivery attempts for $status until an explicit verified reactivation",
  ({ status, attempts }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const thread = ThreadId.make("thread");
        const input = { ...inputFor(thread), ttlMs: null };
        const sub = yield* f.call(f.service.subscribe(input));
        expect(sub.refreshBefore).toBe("1970-01-02T00:00:00.000Z");
        f.responses.set("event-0", status);
        yield* f.append([thread]);
        yield* f.service.drain();
        if (status === 503) yield* f.call(f.service.subscribe(input));
        for (const delay of [1, 2, 4, 8, 16, 32, 64]) {
          yield* TestClock.adjust(`${delay} seconds`);
          yield* f.service.drain();
        }
        yield* TestClock.adjust("2 days");
        yield* f.service.drain();
        expect(f.sent).toHaveLength(attempts);
        expect(new Set(f.sent.map((delivery) => delivery.id)).size).toBe(1);
        expect(new Set(f.sent.map((delivery) => delivery.body)).size).toBe(1);
        expect((yield* f.subscriptions.get(sub.id))?.active).toBe(0);
        // Recovery requires a new authenticated subscribe; automatic retries stay stopped.
        f.responses.delete("event-0");
        yield* f.service.drain();
        expect(f.sent).toHaveLength(attempts);
        const resumed = yield* f.call(f.service.subscribe(input));
        expect(resumed.id).toBe(sub.id);
        expect(resumed.cursor).toBe("0");
        yield* f.service.drain();
        expect(f.sent).toHaveLength(attempts + 1);
        expect(f.sent.at(-1)?.id).toBe("event-0");
        expect((yield* f.subscriptions.get(sub.id))?.ackCursor).toBeGreaterThan(0);
        expect(yield* f.deliveries.count(sub.id)).toBe(0);
        const { cursor: _cursor, ...refresh } = input;
        yield* f.call(f.service.subscribe(refresh));
        yield* f.service.drain();
        expect(f.sent).toHaveLength(attempts + 1);
      }),
    ).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect(
  "expires finite subscriptions and bounds old-key rotation without granting extra scope",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const thread = ThreadId.make("thread");
        const input = inputFor(thread);
        const sub = yield* f.call(f.service.subscribe({ ...input, ttlMs: 1 }));
        expect(sub.refreshBefore).toBe("1970-01-01T00:01:00.000Z");
        yield* TestClock.adjust("1 minute");
        yield* f.append([thread]);
        yield* f.service.drain();
        expect(f.sent).toHaveLength(0);
        yield* f.call(
          f.service.subscribe({ ...input, delivery: { ...input.delivery, secret: replacement } }),
        );
        yield* f.service.drain();
        expect(f.sent[0]?.previousSecret).toEqual(secret);
        yield* TestClock.adjust("5 minutes");
        yield* f.append([thread], "-rotation-end");
        yield* f.service.drain();
        expect(f.sent.at(-1)?.previousSecret).toBeUndefined();
        const provider = {
          ...f.scope(),
          client: undefined,
          thread: {
            threadId: thread,
            providerSessionId: "provider",
            providerInstanceId: liveThreadShell(thread).providerInstanceId,
          },
        };
        expect(
          (yield* f.service
            .subscribe(input)
            .pipe(Effect.provideService(Invocation.McpInvocationContext, provider), Effect.flip))
            .reason,
        ).toBe("access_denied");
      }),
    ).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect(
  "allows a separately authorized session to explicitly replay after revocation without transferring the old principal",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const thread = ThreadId.make("thread");
        const input = inputFor(thread);
        const original = yield* f.call(f.service.subscribe(input));
        yield* f.append([thread], "-consumed");
        yield* f.service.drain();
        const consumed = json(f.sent[0]!.body) as { eventId: string; cursor: string };
        const downstreamEffects = new Set([consumed.eventId]);
        yield* f.sessions.revoke({ sessionId: f.principal, revokedAt: DateTime.makeUnsafe(0) });
        yield* f.append([thread], "-later");
        yield* f.service.drain();
        expect(f.sent).toHaveLength(1);
        expect((yield* f.subscriptions.get(original.id))?.active).toBe(0);
        const resumed = yield* f.call(
          f.service.subscribe({ ...input, cursor: consumed.cursor }),
          f.other,
        );
        expect(resumed.id).not.toBe(original.id);
        yield* f.service.drain();
        const replayed = f.sent
          .slice(1)
          .map((request) => json(request.body) as { eventId: string });
        expect(replayed.map((event) => event.eventId)).toEqual([
          "event-0-consumed",
          "event-0-later",
        ]);
        for (const event of replayed) downstreamEffects.add(event.eventId);
        expect(downstreamEffects.size).toBe(2);
        expect(f.sent.slice(1).every((request) => request.subscriptionId === resumed.id)).toBe(
          true,
        );
        expect((yield* f.call(f.service.subscribe(input)).pipe(Effect.flip)).reason).toBe(
          "access_denied",
        );
      }),
    ).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect(
  "reports pruned history while retaining a pending delivery that predates the prune boundary",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const thread = ThreadId.make("thread");
        const original = yield* f.call(f.service.subscribe(inputFor(thread)));
        yield* f.append([thread, thread, thread]);
        f.responses.set("event-0", 503);
        yield* f.service.drain();
        expect((yield* f.subscriptions.get(original.id))?.ackCursor).toBe(0);
        const sql = Context.get(f.context, SqlClient.SqlClient);
        yield* sql`DELETE FROM orchestration_events WHERE sequence <= 2`;
        yield* sql`INSERT INTO orchestration_v2_projection_metadata (projection_name, last_sequence, schema_version, updated_at)
    VALUES (${EventStore.EVENT_LOG_PRUNED_THROUGH}, 2, 1, '1970-01-01T00:00:00.000Z')
    ON CONFLICT(projection_name) DO UPDATE SET last_sequence = 2`;
        const resumed = yield* f.call(f.service.subscribe(inputFor(thread)), f.other);
        expect(resumed.truncated).toBe(true);
        expect(resumed.cursor).toBe("2");
        f.responses.delete("event-0");
        yield* TestClock.adjust("1 second");
        const restarted = yield* f.build();
        yield* restarted.drain();
        expect((yield* f.subscriptions.get(original.id))?.ackCursor).toBe(3);
        expect(
          f.sent
            .filter((request) => request.subscriptionId === resumed.id)
            .map((request) => request.id),
        ).toEqual(["event-2"]);
        yield* sql`DELETE FROM orchestration_events`;
        yield* sql`UPDATE orchestration_v2_projection_metadata SET last_sequence = 3 WHERE projection_name = ${EventStore.EVENT_LOG_PRUNED_THROUGH}`;
        const { cursor: _cursor, ...withoutCursor } = inputFor(thread);
        expect((yield* f.call(restarted.subscribe(withoutCursor), f.other)).cursor).toBe("3");
      }),
    ).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect.each(["scope", "expiry", "revocation"] as const)(
  "stops pending retries when the persisted session loses %s authority",
  (reason) =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const thread = ThreadId.make("thread");
        const sub = yield* f.call(f.service.subscribe(inputFor(thread)));
        f.responses.set("event-0", 503);
        yield* f.append([thread]);
        yield* f.service.drain();
        expect(f.sent).toHaveLength(1);
        const sql = Context.get(f.context, SqlClient.SqlClient);
        if (reason === "scope")
          yield* sql`UPDATE auth_sessions SET scopes = '[]' WHERE session_id = ${f.principal}`;
        else if (reason === "expiry")
          yield* sql`UPDATE auth_sessions SET expires_at = '1970-01-01T00:00:00.000Z' WHERE session_id = ${f.principal}`;
        else
          yield* f.sessions.revoke({ sessionId: f.principal, revokedAt: DateTime.makeUnsafe(0) });
        yield* TestClock.adjust("1 second");
        yield* f.service.drain();
        expect(f.sent).toHaveLength(1);
        expect((yield* f.subscriptions.get(sub.id))?.active).toBe(0);
      }),
    ).pipe(Effect.provide(NodeCrypto.layer)),
);

it("keeps helper completion distinct from a root run result and exports no task prose or accepted-outcome claim", () => {
  const threadId = ThreadId.make("child-thread");
  const parent = ThreadId.make("parent-thread");
  const shell = {
    lineage: {
      rootThreadId: parent,
      parentThreadId: parent,
      relationshipToParent: "subagent" as const,
    },
  };
  const stored: OrchestrationV2StoredEvent = {
    sequence: 7,
    commandId: null,
    event: {
      id: EventId.make("helper-event"),
      threadId,
      occurredAt: DateTime.makeUnsafe(0),
      type: "subagent.updated",
      payload: {
        id: NodeId.make("helper"),
        threadId,
        runId: null,
        parentNodeId: NodeId.make("parent-node"),
        origin: "provider_native",
        createdBy: "agent",
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("fixture"),
        providerThreadId: null,
        childThreadId: null,
        nativeTaskRef: null,
        prompt: "PRIVATE INSTRUCTIONS",
        title: "PRIVATE TITLE",
        model: null,
        status: "completed",
        result: "BUSINESS DONE CLAIM",
        startedAt: null,
        completedAt: DateTime.makeUnsafe(0),
        updatedAt: DateTime.makeUnsafe(0),
      },
    },
  };
  const observation = McpEvents.observeEvent(
    stored,
    shell,
    "https://app.example.com/thread/child-thread",
  );
  expect(observation).toMatchObject({
    name: "thread.run.result",
    data: {
      sourceEventType: "subagent.updated",
      state: "completed",
      parentThreadId: parent,
      relationshipToParent: "subagent",
      resourceId: "helper",
    },
  });
  expect(Object.keys(observation!.data).sort()).toEqual(
    [
      "parentThreadId",
      "relationshipToParent",
      "resourceId",
      "revision",
      "sourceEventType",
      "sourceUrl",
      "state",
      "threadId",
    ].sort(),
  );
  expect(encode(observation)).not.toMatch(/PRIVATE|BUSINESS DONE/);
  if (stored.event.type !== "subagent.updated") throw new Error("fixture");
  expect(
    McpEvents.observeEvent(
      {
        ...stored,
        event: { ...stored.event, payload: { ...stored.event.payload, status: "failed" } },
      },
      shell,
      "https://app.example.com/thread/child-thread",
    )?.name,
  ).toBe("thread.blocker");
  expect(
    McpEvents.observeEvent(
      {
        ...stored,
        event: { ...stored.event, payload: { ...stored.event.payload, status: "running" } },
      },
      shell,
      "https://app.example.com/thread/child-thread",
    ),
  ).toBeUndefined();
});

it.effect(
  "emits a minimal pending-decision observation without approval execution or resolved-request prose",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const threadId = ThreadId.make("thread");
        yield* f.call(
          f.service.subscribe({ ...inputFor(threadId), name: "thread.needs-decision" }),
        );
        const payload = {
          id: RuntimeRequestId.make("request"),
          nodeId: NodeId.make("node"),
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input" as const,
          responseCapability: { type: "not_resumable" as const, reason: "PRIVATE REQUEST PROSE" },
          createdAt: DateTime.makeUnsafe(0),
          resolvedAt: null,
        };
        yield* f.store.appendAgentEvents({
          events: [
            {
              id: EventId.make("pending"),
              threadId,
              occurredAt: DateTime.makeUnsafe(0),
              type: "runtime-request.updated",
              payload: { ...payload, status: "pending" },
            },
            {
              id: EventId.make("resolved"),
              threadId,
              occurredAt: DateTime.makeUnsafe(1),
              type: "runtime-request.updated",
              payload: { ...payload, status: "resolved", resolvedAt: DateTime.makeUnsafe(1) },
            },
          ],
        });
        yield* f.service.drain();
        expect(f.sent).toHaveLength(1);
        expect(json(f.sent[0]!.body)).toMatchObject({
          name: "thread.needs-decision",
          eventId: "pending",
          data: { state: "pending", resourceId: "request" },
        });
        expect(f.sent[0]!.body).not.toContain("PRIVATE REQUEST");
        expect(yield* f.store.latestApplicationSequence).toBe(2);
      }),
    ).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect.each(["principal", "global"] as const)(
  "enforces the %s cap on reactivation, retained rows and concurrent creation",
  (scope) =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const input = inputFor(ThreadId.make("capacity"));
        const sub = yield* f.call(f.service.subscribe(input));
        const sql = Context.get(f.context, SqlClient.SqlClient);
        const capacity = scope === "principal" ? 512 : 4096;
        const principal = scope === "principal" ? f.principal : f.other;
        // Seed the boundary directly; no synthetic threads or network work.
        yield* sql`WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n < ${capacity})
      INSERT INTO mcp_event_subscriptions
      SELECT id || '-' || n, ${principal}, name, thread_id, callback_url || '/' || n, source_url,
        secret, previous_secret, rotation_until, expires_at, 1, scan_cursor, ack_cursor, truncated
      FROM mcp_event_subscriptions CROSS JOIN numbers WHERE id = ${sub.id}`;
        yield* sql`UPDATE mcp_event_subscriptions SET active = 0 WHERE id = ${sub.id}`;
        expect((yield* f.call(f.service.subscribe(input)).pipe(Effect.flip)).reason).toBe(
          "subscription_limit",
        );
        // A stopped row still occupies bounded durable storage; new URLs cannot accumulate tombstones.
        yield* sql`UPDATE mcp_event_subscriptions SET active = 0`;
        const fresh = {
          ...input,
          delivery: { ...input.delivery, url: "https://new.example.com/events" },
        };
        expect((yield* f.call(f.service.subscribe(fresh)).pipe(Effect.flip)).reason).toBe(
          "subscription_limit",
        );
        // Exactly one remaining slot, with distinct identities racing to claim it.
        yield* sql`DELETE FROM mcp_event_subscriptions WHERE id IN (SELECT id FROM mcp_event_subscriptions LIMIT 2)`;
        const results = yield* Effect.forEach(
          [
            fresh,
            { ...fresh, delivery: { ...fresh.delivery, url: "https://other.example.com/events" } },
          ],
          (i) => f.call(f.service.subscribe(i)).pipe(Effect.result),
          { concurrency: "unbounded" },
        );
        expect(results.filter((r) => r._tag === "Success")).toHaveLength(1);
        expect(
          (yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM mcp_event_subscriptions`)[0]
            ?.count,
        ).toBe(capacity);
      }),
    ).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect(
  "lists only the current principal's secret-free subscriptions and revokes one by ID",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const input = inputFor(ThreadId.make("managed"));
        const own = yield* f.call(f.service.subscribe(input));
        yield* f.call(f.service.subscribe(input), f.other);
        const listed = yield* f.call(f.service.listSubscriptions());
        expect(listed.subscriptions).toEqual([
          {
            id: own.id,
            name: input.name,
            arguments: input.arguments,
            callbackOrigin: "https://callbacks.example.com",
            status: "active",
            expiresAt: "1970-01-02T00:00:00.000Z",
            cursor: "0",
          },
        ]);
        expect(encode(listed)).not.toContain(Redacted.value(secret));
        expect(encode(listed)).not.toContain(input.delivery.url);
        yield* f.call(f.service.unsubscribe({ id: own.id }), f.other);
        expect(yield* f.subscriptions.get(own.id)).toBeDefined();
        yield* f.append([input.arguments.threadId]);
        f.responses.set("event-0", 503);
        yield* f.service.drain();
        expect(yield* f.deliveries.count(own.id)).toBe(1);
        yield* f.call(f.service.unsubscribe({ id: own.id }));
        yield* f.call(f.service.unsubscribe({ id: own.id }));
        expect(yield* f.subscriptions.get(own.id)).toBeUndefined();
        expect(yield* f.deliveries.count(own.id)).toBe(0);
        const { cursor: _cursor, ...cursorless } = input;
        const restarted = yield* f.call(f.service.subscribe(cursorless));
        expect(restarted.cursor).toBe("1");
        yield* f.service.drain();
        expect(f.sent).toHaveLength(2); // one send for each principal before unsubscribe, none replayed
      }),
    ).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect("keeps the scoped worker recoverable beyond eight separated stream failures", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const attempts = yield* Queue.unbounded<number>();
      let count = 0;
      yield* Layer.build(
        McpEvents.layerDeliveryWorker.pipe(
          Layer.provide(
            Layer.mock(McpEvents.McpEvents)({
              run: () =>
                Effect.suspend(() =>
                  Queue.offer(attempts, ++count).pipe(
                    Effect.andThen(
                      count <= 9
                        ? Effect.fail(new McpEventsError({ code: -32603, reason: "storage" }))
                        : Effect.never,
                    ),
                  ),
                ),
            }),
          ),
        ),
      );
      for (let i = 1; i <= 9; i++) {
        expect(yield* Queue.take(attempts)).toBe(i);
        yield* TestClock.adjust("5 seconds");
      }
      expect(yield* Queue.take(attempts)).toBe(10);
    }),
  ),
);

it.effect(
  "does not rewind a cursorless refresh when delivery acknowledges during verification",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const input = inputFor(ThreadId.make("refresh-race"));
        const sub = yield* f.call(f.service.subscribe(input));
        yield* f.append([input.arguments.threadId]);
        f.setVerificationWork(f.service.drain().pipe(Effect.orDie));
        const { cursor: _cursor, ...refresh } = input;
        expect((yield* f.call(f.service.subscribe(refresh))).cursor).toBe("1");
        expect((yield* f.subscriptions.get(sub.id))?.ackCursor).toBe(1);
        yield* f.service.drain();
        expect(f.sent).toHaveLength(1);
      }),
    ).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect.each(["revoked", "expired"] as const)(
  "reclaims unreachable %s-principal transport slots without removing live receipts",
  (state) =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const input = inputFor(ThreadId.make("reclaim"));
        const own = yield* f.call(f.service.subscribe(input));
        yield* f.append([input.arguments.threadId]);
        f.responses.set("event-0", 503);
        yield* f.service.drain();
        const sql = Context.get(f.context, SqlClient.SqlClient);
        yield* sql`WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n < 4095)
      INSERT INTO mcp_event_subscriptions SELECT id || '-dead-' || n, ${f.other}, name, thread_id,
        callback_url || '/' || n, source_url, secret, previous_secret, rotation_until, expires_at,
        1, scan_cursor, ack_cursor, truncated FROM mcp_event_subscriptions CROSS JOIN numbers WHERE id = ${own.id}`;
        yield* sql`INSERT INTO mcp_event_deliveries (subscription_id, event_id, sequence, body) VALUES (${own.id + "-dead-1"}, 'dead-event', 1, '{}')`;
        if (state === "revoked")
          yield* f.sessions.revoke({ sessionId: f.other, revokedAt: DateTime.makeUnsafe(0) });
        else
          yield* sql`UPDATE auth_sessions SET expires_at = '1970-01-01T00:00:00.000Z' WHERE session_id = ${f.other}`;
        yield* f.call(
          f.service.subscribe({
            ...input,
            delivery: { ...input.delivery, url: "https://new.example.com/events" },
          }),
        );
        expect(
          (yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM mcp_event_subscriptions`)[0]
            ?.count,
        ).toBe(2);
        expect(yield* f.deliveries.count(own.id + "-dead-1")).toBe(0);
        expect(yield* f.deliveries.count(own.id)).toBe(1);
        expect((yield* f.subscriptions.get(own.id))?.active).toBe(1);
        expect((yield* f.call(f.service.subscribe(input), f.other).pipe(Effect.flip)).reason).toBe(
          "access_denied",
        );
      }),
    ).pipe(Effect.provide(NodeCrypto.layer)),
);
