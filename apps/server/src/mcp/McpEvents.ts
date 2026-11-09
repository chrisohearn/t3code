import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  McpEventName,
  McpEventEnvelope,
  McpEventArguments,
  McpEventData,
  McpEventsError,
  type McpEventSubscribe,
  type McpEventUnsubscribe,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as Deliveries from "../persistence/McpEventDeliveries.ts";
import * as Subscriptions from "../persistence/McpEventSubscriptions.ts";
import * as EventStore from "../persistence/OrchestrationEventStore.ts";
import * as Invocation from "./McpInvocationContext.ts";
import * as Webhook from "./McpEventsWebhook.ts";

const refused = () => new McpEventsError({ code: -32001, reason: "access_denied" });
const invalid = () => new McpEventsError({ code: -32602, reason: "invalid_params" });
const storage = () => new McpEventsError({ code: -32603, reason: "storage" });
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeEvent = Schema.encodeEffect(Schema.fromJsonString(McpEventEnvelope));
const jsonSchema = (schema: Schema.Constraint) => {
  const document = Schema.toJsonSchemaDocument(schema);
  return { ...document.schema, $defs: document.definitions };
};
const inputSchema = jsonSchema(McpEventArguments);
const payloadSchema = jsonSchema(McpEventData);
const eventDescriptions: Record<McpEventName, string> = {
  "thread.run.result":
    "A run or helper completed, was interrupted or cancelled, or was rolled back. Read its source thread for the result; this does not establish an accepted business outcome.",
  "thread.needs-decision":
    "A native runtime request is pending. Read the source thread; this notification grants no approval or consent.",
  "thread.blocker":
    "A run or helper recorded a native failed state. Read the source thread for the blocker.",
  "thread.resource-released": "A provider session detached from the source thread.",
};

export const observeEvent = (
  stored: OrchestrationV2StoredEvent,
  thread: Pick<OrchestrationV2ThreadShell, "lineage">,
  sourceUrl: string,
): Omit<McpEventEnvelope, "cursor"> | undefined => {
  const { event, sequence } = stored;
  let name: McpEventName;
  let state: string;
  let resourceId: string | undefined;
  switch (event.type) {
    case "run.updated":
    case "subagent.updated":
      state = event.payload.status;
      if (!["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(state))
        return;
      name = state === "failed" ? "thread.blocker" : "thread.run.result";
      resourceId = event.payload.id;
      break;
    case "runtime-request.updated":
      if (event.payload.status !== "pending") return;
      name = "thread.needs-decision";
      state = event.payload.status;
      resourceId = event.payload.id;
      break;
    case "provider-session.detached":
      name = "thread.resource-released";
      state = "detached";
      resourceId = event.payload.providerSessionId;
      break;
    default:
      return;
  }
  return {
    eventId: event.id,
    name,
    timestamp: DateTime.formatIso(event.occurredAt),
    data: {
      threadId: event.threadId,
      revision: sequence,
      sourceEventType: event.type,
      sourceUrl,
      state,
      ...(event.runId === undefined ? {} : { runId: event.runId }),
      ...(resourceId === undefined ? {} : { resourceId }),
      parentThreadId: thread.lineage.parentThreadId,
      relationshipToParent: thread.lineage.relationshipToParent,
    },
  };
};

export class McpEvents extends Context.Service<
  McpEvents,
  {
    readonly list: () => Effect.Effect<
      {
        readonly events: ReadonlyArray<{
          readonly name: McpEventName;
          readonly description: string;
          readonly delivery: ReadonlyArray<"webhook">;
          readonly inputSchema: object;
          readonly payloadSchema: object;
        }>;
      },
      McpEventsError,
      Invocation.McpInvocationContext
    >;
    readonly subscribe: (input: McpEventSubscribe) => Effect.Effect<
      {
        readonly id: string;
        readonly refreshBefore: string;
        readonly cursor: string;
        readonly truncated: boolean;
      },
      McpEventsError,
      Invocation.McpInvocationContext
    >;
    readonly unsubscribe: (
      input: McpEventUnsubscribe,
    ) => Effect.Effect<{}, McpEventsError, Invocation.McpInvocationContext>;
    readonly drain: () => Effect.Effect<void, McpEventsError>;
    readonly run: () => Effect.Effect<never, McpEventsError, Scope.Scope>;
  }
>()("t3/mcp/McpEvents") {}

const make = Effect.gen(function* () {
  const sessions = yield* AuthSessions.AuthSessionRepository;
  const subscriptions = yield* Subscriptions.McpEventSubscriptions;
  const deliveries = yield* Deliveries.McpEventDeliveries;
  const events = yield* EventStore.OrchestrationEventStore;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const webhook = yield* Webhook.McpEventsWebhook;
  const digest = yield* Digest.Digest;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const lock = yield* Semaphore.make(1);
  const wake = yield* Queue.sliding<void>(1);
  const subscriptionLocks = new Map<
    string,
    { readonly semaphore: Semaphore.Semaphore; users: number }
  >();
  const withSubscription = <A, E, R>(id: string, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        let entry = subscriptionLocks.get(id);
        if (entry === undefined) {
          entry = { semaphore: Semaphore.makeUnsafe(1), users: 0 };
          subscriptionLocks.set(id, entry);
        }
        entry.users++;
        return entry;
      }),
      (entry) => entry.semaphore.withPermit(effect),
      (entry) =>
        Effect.sync(() => {
          entry.users--;
          if (entry.users === 0) subscriptionLocks.delete(id);
        }),
    );

  const activePrincipal = Effect.fn("McpEvents.activePrincipal")(function* (principal: string) {
    const found = yield* sessions
      .getById({ sessionId: AuthSessionId.make(principal) })
      .pipe(Effect.mapError(storage));
    const now = yield* Clock.currentTimeMillis;
    if (
      Option.isNone(found) ||
      found.value.subject !== "mcp-client" ||
      found.value.method !== "bearer-access-token" ||
      found.value.revokedAt !== null ||
      found.value.expiresAt.epochMilliseconds <= now ||
      !found.value.scopes.includes(AuthOrchestrationReadScope)
    )
      return yield* refused();
    return found.value;
  });
  const caller = Effect.fn("McpEvents.caller")(function* () {
    const scope = yield* Invocation.McpInvocationContext;
    if (
      scope.client === undefined ||
      scope.thread !== undefined ||
      scope.client.linked === true ||
      scope.environmentId !== environmentId ||
      !scope.capabilities.has("orchestration")
    )
      return yield* refused();
    const principal = yield* activePrincipal(scope.client.sessionId);
    return { scope, principal };
  });
  const resource = Effect.fn("McpEvents.resource")(function* (threadId: ThreadId) {
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(storage));
    if (shell === null || shell.deletedAt !== null) return yield* refused();
    return shell;
  });
  const identity = Effect.fn("McpEvents.identity")(
    function* (principal: string, input: McpEventUnsubscribe) {
      const url = yield* Webhook.callbackUrl(input.delivery.url);
      const canonical = yield* encodeJson([
        principal,
        url.href,
        input.name,
        { threadId: input.arguments.threadId },
      ]);
      const bytes = yield* digest.digest(Digest.sha256, Buffer.from(canonical));
      return { id: `sub_${Buffer.from(bytes).toString("hex")}`, url: url.href };
    },
    Effect.mapError(() => invalid()),
  );
  const authorizeDelivery = Effect.fn("McpEvents.authorizeDelivery")(function* (
    sub: Subscriptions.Subscription,
  ) {
    yield* activePrincipal(sub.principal);
    if (sub.active !== 1 || sub.expiresAt <= (yield* Clock.currentTimeMillis))
      return yield* refused();
    return yield* resource(sub.threadId);
  });

  const collect = Effect.fn("McpEvents.collect")(function* (sub: Subscriptions.Subscription) {
    const shell = yield* authorizeDelivery(sub);
    if ((yield* deliveries.count(sub.id)) >= 4096) return false;
    const floor = yield* events.prunedThroughSequence.pipe(Effect.mapError(storage));
    const latest = yield* events.latestApplicationSequence.pipe(Effect.mapError(storage));
    const batch = yield* events
      .readApplicationEvents({
        afterSequence: Math.max(sub.scanCursor, floor),
        throughSequence: latest,
      })
      .pipe(Stream.take(256), Stream.runCollect, Effect.mapError(storage));
    let through = Math.max(sub.scanCursor, floor);
    const pending: Array<{ eventId: string; sequence: number; body: string }> = [];
    for (const stored of batch) {
      through = stored.sequence;
      if (!("event" in stored) || stored.event.threadId !== sub.threadId) continue;
      const observation = observeEvent(stored, shell, sub.sourceUrl);
      if (observation?.name !== sub.name) continue;
      const body = yield* encodeEvent({ ...observation, cursor: String(sub.ackCursor) }).pipe(
        Effect.mapError(() => invalid()),
      );
      if (Buffer.byteLength(body) > 256 * 1024)
        return yield* new McpEventsError({ code: -32603, reason: "payload_too_large" });
      pending.push({ eventId: observation.eventId, sequence: stored.sequence, body });
    }
    yield* deliveries.enqueue({
      subscriptionId: sub.id,
      sequence: through,
      truncated: sub.scanCursor < floor,
      events: pending,
    });
    return through < latest;
  });

  const deliver = Effect.fn("McpEvents.deliver")(function* (delivery: Deliveries.Delivery) {
    const sub = yield* subscriptions.get(delivery.subscriptionId);
    if (sub === undefined) return;
    yield* authorizeDelivery(sub);
    if (delivery.attempts >= 8) return yield* subscriptions.stop(sub.id, sub.principal);
    const now = yield* Clock.currentTimeMillis;
    yield* deliveries.begin(delivery, now);
    const status = yield* webhook
      .send({
        id: delivery.eventId,
        subscriptionId: sub.id,
        url: sub.url,
        body: delivery.body,
        secret: sub.secret,
        authorize: authorizeDelivery(sub).pipe(
          Effect.asVoid,
          Effect.mapError(
            (error) =>
              new Webhook.CallbackError({
                reason: error.reason === "access_denied" ? "access_denied" : "network",
              }),
          ),
        ),
        ...(sub.previousSecret !== null && sub.rotationUntil > now
          ? { previousSecret: sub.previousSecret }
          : {}),
      })
      .pipe(
        Effect.catchTags({
          McpEventsCallbackError: (error) =>
            Effect.succeed(error.reason === "access_denied" ? 410 : 0),
        }),
      );
    if (status >= 200 && status < 300) return yield* deliveries.acknowledge(delivery);
    if (
      (status > 0 && status < 500 && ![408, 425, 429].includes(status)) ||
      delivery.attempts + 1 >= 8
    )
      return yield* subscriptions.stop(sub.id, sub.principal);
    yield* deliveries.retry(
      delivery,
      (yield* Clock.currentTimeMillis) + Math.min(300_000, 1000 * 2 ** delivery.attempts),
    );
  });
  const drain = Effect.fn("McpEvents.drainPass")(() =>
    lock.withPermit(
      Effect.gen(function* () {
        const active = yield* subscriptions.active(yield* Clock.currentTimeMillis);
        let behind = false;
        for (const sub of active) {
          const more = yield* withSubscription(
            sub.id,
            subscriptions.get(sub.id).pipe(
              Effect.flatMap((current) =>
                current === undefined ? Effect.succeed(false) : collect(current),
              ),
              Effect.catchIf(
                (error) => error.reason === "access_denied",
                () => subscriptions.stop(sub.id, sub.principal).pipe(Effect.as(false)),
              ),
            ),
          );
          behind ||= more;
        }
        const due = yield* deliveries.due(yield* Clock.currentTimeMillis);
        yield* Effect.forEach(
          due,
          (delivery) =>
            withSubscription(delivery.subscriptionId, deliver(delivery)).pipe(Effect.ignore),
          { concurrency: 8, discard: true },
        );
        return behind;
      }),
    ),
  );

  return McpEvents.of({
    list: Effect.fn("McpEvents.list")(function* () {
      yield* caller();
      return {
        events: McpEventName.literals.map((name) => ({
          name,
          description: eventDescriptions[name],
          delivery: ["webhook" as const],
          inputSchema,
          payloadSchema,
        })),
      };
    }),
    subscribe: Effect.fn("McpEvents.subscribe")(function* (input) {
      const { scope, principal } = yield* caller();
      yield* resource(input.arguments.threadId);
      const { id, url } = yield* identity(principal.sessionId, input);
      const existing = yield* subscriptions.get(id);
      const active = yield* subscriptions.active(yield* Clock.currentTimeMillis);
      if (
        existing === undefined &&
        (active.length >= 4096 ||
          active.filter((sub) => sub.principal === principal.sessionId).length >= 512)
      )
        return yield* new McpEventsError({ code: -32000, reason: "subscription_limit" });
      const floor = yield* events.prunedThroughSequence.pipe(Effect.mapError(() => invalid()));
      const latest = Math.max(
        floor,
        yield* events.latestApplicationSequence.pipe(Effect.mapError(() => invalid())),
      );
      const requested =
        input.cursor == null ? (existing?.ackCursor ?? latest) : Number(input.cursor);
      if (
        !Number.isSafeInteger(requested) ||
        requested < 0 ||
        requested > latest ||
        (input.cursor != null && !/^(0|[1-9][0-9]*)$/.test(input.cursor)) ||
        (existing !== undefined && requested > existing.ackCursor)
      )
        return yield* invalid();
      yield* webhook
        .verify({
          principal: principal.sessionId,
          subscriptionId: id,
          url,
          secret: input.delivery.secret,
          authorize: activePrincipal(principal.sessionId).pipe(
            Effect.andThen(resource(input.arguments.threadId)),
            Effect.asVoid,
            Effect.mapError(
              (error) =>
                new Webhook.CallbackError({
                  reason: error.reason === "access_denied" ? "access_denied" : "network",
                }),
            ),
          ),
        })
        .pipe(
          Effect.mapError((error) => new McpEventsError({ code: -32015, reason: error.reason })),
        );
      return yield* withSubscription(
        id,
        Effect.gen(function* () {
          yield* caller();
          yield* resource(input.arguments.threadId);
          const current = yield* subscriptions.get(id);
          const now = yield* Clock.currentTimeMillis;
          const expiresAt = Math.min(
            principal.expiresAt.epochMilliseconds,
            now + Math.min(7 * 86400_000, Math.max(60_000, input.ttlMs ?? 86400_000)),
          );
          const cursor = Math.min(
            current?.ackCursor ?? Math.max(floor, requested),
            Math.max(floor, requested),
          );
          yield* subscriptions.save({
            id,
            principal: principal.sessionId,
            name: input.name,
            threadId: input.arguments.threadId,
            url,
            sourceUrl: Invocation.threadLinkFor(scope, input.arguments.threadId),
            secret: input.delivery.secret,
            active: 1,
            now,
            expiresAt,
            scanCursor:
              current !== undefined && cursor === current.ackCursor ? current.scanCursor : cursor,
            ackCursor: cursor,
            truncated: requested < floor || existing?.truncated === 1 ? 1 : 0,
          });
          yield* Queue.offer(wake, undefined);
          return {
            id,
            refreshBefore: DateTime.formatIso(DateTime.makeUnsafe(expiresAt)),
            cursor: String(cursor),
            truncated: requested < floor || existing?.truncated === 1,
          };
        }),
      );
    }),
    unsubscribe: Effect.fn("McpEvents.unsubscribe")(function* (input) {
      const { principal } = yield* caller();
      const { id } = yield* identity(principal.sessionId, input);
      yield* withSubscription(id, subscriptions.stop(id, principal.sessionId));
      yield* Queue.offer(wake, undefined);
      return {};
    }),
    drain: Effect.fn("McpEvents.drain")(() => drain().pipe(Effect.asVoid)),
    run: Effect.fn("McpEvents.run")(function* () {
      const afterSequence = yield* events.latestApplicationSequence.pipe(
        Effect.mapError(() => invalid()),
      );
      const follow = events
        .streamProjectedApplicationEvents({
          afterSequence,
          project: (event) => ({ sequence: event.sequence }),
          filter: (stored) =>
            "event" in stored &&
            [
              "run.updated",
              "subagent.updated",
              "runtime-request.updated",
              "provider-session.detached",
            ].includes(stored.event.type),
        })
        .pipe(
          Stream.mapError(storage),
          Stream.runForEach(() => Queue.offer(wake, undefined)),
          Effect.andThen(Effect.fail(storage())),
        );
      const pump = Effect.forever(
        Effect.gen(function* () {
          const behind = yield* drain();
          if (behind) return;
          const now = yield* Clock.currentTimeMillis;
          const next = yield* deliveries.nextAttempt(now);
          if (next === null) yield* Queue.take(wake);
          else
            yield* Queue.take(wake).pipe(
              Effect.timeoutOrElse({
                duration: Math.max(0, next - now),
                orElse: () => Effect.void,
              }),
            );
        }),
      );
      return yield* Effect.raceFirst(follow, pump);
    }),
  });
});

export const layer = Layer.effect(McpEvents, make);

export const layerDeliveryWorker = Layer.effectDiscard(
  McpEvents.pipe(
    Effect.flatMap((events) =>
      events.run().pipe(
        Effect.retry({ schedule: Schedule.exponential("1 second"), times: 7 }),
        Effect.tapError((error) =>
          Effect.logWarning("MCP Events delivery stopped.", { reason: error.reason }),
        ),
        Effect.forkScoped,
      ),
    ),
  ),
);
