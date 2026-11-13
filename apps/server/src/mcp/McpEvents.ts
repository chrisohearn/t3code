import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CLOUD_LINK_REVOKED, CLOUD_LINKED_USER_ID, RELAY_URL_SECRET } from "../cloud/config.ts";
import * as ConnectReachability from "../cloud/ConnectReachability.ts";
import * as BridgeStatus from "../persistence/McpBridgeStatus.ts";
import {
  type EnvironmentConnectReachability,
  type McpThreadNotify,
  type McpThreadNotifyResult,
  AuthOrchestrationReadScope,
  AuthSessionId,
  McpEventName,
  McpEventEnvelope,
  McpEventArguments,
  McpEventData,
  McpEventWatch,
  McpEventsError,
  type McpEventSubscribe,
  type McpEventInboxInput,
  type McpEventReplayInput,
  type McpEventReplayResult,
  type McpEventInboxResult,
  type McpEventSubscriptionsResult,
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
import * as Relay from "./McpEventRelay.ts";
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
      // A run failing over is not a blocker: its failover run reports the outcome. A skip is.
      if (
        event.type === "run.updated" &&
        event.payload.failover !== undefined &&
        event.payload.failover.state !== "skipped"
      )
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

export type PreparedThreadNotify = Relay.PreparedRelay;

export class McpEvents extends Context.Service<
  McpEvents,
  {
    readonly replay: (
      input: typeof McpEventReplayInput.Type,
    ) => Effect.Effect<
      typeof McpEventReplayResult.Type,
      McpEventsError,
      Invocation.McpInvocationContext
    >;
    readonly setInbox: (
      input: McpEventInboxInput,
    ) => Effect.Effect<McpEventInboxResult, McpEventsError, Invocation.McpInvocationContext>;
    readonly prepareNotify: (
      input: McpThreadNotify,
    ) => Effect.Effect<
      PreparedThreadNotify | McpThreadNotifyResult,
      McpEventsError,
      Invocation.McpInvocationContext
    >;
    readonly notifyThread: (
      prepared: PreparedThreadNotify,
      threadId: ThreadId,
      runId?: import("@t3tools/contracts").RunId,
      clientRequestId?: string,
    ) => Effect.Effect<McpThreadNotifyResult, McpEventsError, Invocation.McpInvocationContext>;
    readonly bridgeStatus: () => Effect.Effect<
      {
        readonly serviceStartedAt: string;
        readonly tunnel: EnvironmentConnectReachability | null;
        readonly daysUntilSessionExpires: number;
        readonly subscriptions: McpEventSubscriptionsResult["subscriptions"];
        readonly inboxThreadId: ThreadId | null;
        readonly relayFailures: number;
        readonly relayPending: number;
        readonly relayLastError: string | null;
        readonly watches: ReadonlyArray<typeof McpEventWatch.Type>;
        readonly lastSuccessfulEventDeliveryAt: string | null;
        readonly deliveriesExhaustedRetries: number;
      },
      McpEventsError,
      Invocation.McpInvocationContext
    >;
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
    readonly listSubscriptions: () => Effect.Effect<
      McpEventSubscriptionsResult,
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
  const reachability = yield* ConnectReachability.ConnectReachability;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const serviceStartedAt = yield* Clock.currentTimeMillis;
  // A restart stores the tunnel config only after the relay provisions the tunnel again,
  // seconds after startup. Until then a check reads not_linked although the server is
  // linked, so not_linked releases the hold only when no cloud link is stored either.
  const cloudLinked = Effect.all(
    [
      secrets.get(CLOUD_LINKED_USER_ID),
      secrets.get(RELAY_URL_SECRET),
      secrets.get(CLOUD_LINK_REVOKED),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map(
      ([user, relay, revoked]) =>
        Option.isSome(user) && Option.isSome(relay) && Option.isNone(revoked),
    ),
    Effect.orElseSucceed(() => false),
  );
  let startupHoldReleased = false;
  const awaitStartupTunnel = Effect.fn("McpEvents.awaitStartupTunnel")(function* () {
    if (startupHoldReleased) return;
    const remaining = serviceStartedAt + 180_000 - (yield* Clock.currentTimeMillis);
    if (remaining > 0) {
      yield* Effect.gen(function* () {
        const latest = yield* reachability.latest;
        const status = Option.getOrNull(latest);
        if (status?.status === "reachable") return true;
        const checked = yield* reachability.check;
        if (checked.status === "reachable") return true;
        return checked.cause === "not_linked" && !(yield* cloudLinked);
      }).pipe(
        Effect.repeat({ schedule: Schedule.spaced("5 seconds"), until: (ready) => ready }),
        Effect.timeoutOption(remaining),
      );
    }
    startupHoldReleased = true;
  });
  const bridge = yield* BridgeStatus.McpBridgeStatus;
  const relay = yield* Relay.McpEventRelay;
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
    function* (
      principal: string,
      input: McpEventSubscribe | Exclude<McpEventUnsubscribe, { readonly id: string }>,
    ) {
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
    if (delivery.attempts >= 8) {
      yield* subscriptions.stop(sub.id, sub.principal);
      yield* bridge.exhausted(sub.principal);
      return yield* relay.alert(
        sub.principal,
        `subscription:${sub.id}`,
        sub.threadId,
        "webhook_retries_exhausted",
      );
    }
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
    if (status >= 200 && status < 300) {
      yield* deliveries.acknowledge(delivery, yield* Clock.currentTimeMillis);
      return yield* bridge.delivered(sub.principal, yield* Clock.currentTimeMillis);
    }
    if (
      (status > 0 && status < 500 && ![408, 425, 429].includes(status)) ||
      delivery.attempts + 1 >= 8
    ) {
      yield* subscriptions.stop(sub.id, sub.principal);
      if (delivery.attempts + 1 >= 8) {
        yield* bridge.exhausted(sub.principal);
        yield* relay.alert(
          sub.principal,
          `subscription:${sub.id}`,
          sub.threadId,
          "webhook_retries_exhausted",
        );
      }
      return;
    }
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
        if (due.length > 0) yield* awaitStartupTunnel();
        yield* Effect.forEach(
          due,
          (delivery) =>
            withSubscription(delivery.subscriptionId, deliver(delivery)).pipe(Effect.ignore),
          { concurrency: 8, discard: true },
        );
        return (yield* relay.drain()) || behind;
      }),
    ),
  );

  const callbackGroup = Effect.fn("McpEvents.callbackGroup")(function* (url: string) {
    const bytes = yield* digest.digest(Digest.sha256, Buffer.from(url));
    return `watch_${Buffer.from(bytes).toString("hex")}`;
  });

  const listSubscriptions = Effect.fn("McpEvents.listSubscriptions")(function* () {
    const { principal } = yield* caller();
    const now = yield* Clock.currentTimeMillis;
    const own = yield* subscriptions.forPrincipal(principal.sessionId);
    return {
      inboxThreadId: yield* relay.inbox(principal.sessionId),
      subscriptions: yield* Effect.forEach(own, (sub) =>
        Effect.gen(function* () {
          return {
            id: sub.id,
            name: sub.name,
            arguments: { threadId: sub.threadId },
            // Callback paths and queries may be credentials. Management needs only the destination origin.
            callbackOrigin: new URL(sub.url).origin,
            callbackGroup: yield* callbackGroup(sub.url),
            notifyDerived: sub.notifyDerived === 1,
            status:
              sub.expiresAt <= now
                ? ("expired" as const)
                : sub.active === 1
                  ? ("active" as const)
                  : ("stopped" as const),
            expiresAt: DateTime.formatIso(DateTime.makeUnsafe(sub.expiresAt)),
            cursor: String(sub.ackCursor),
          };
        }),
      ),
    };
  });

  const subscribe = Effect.fn("McpEvents.subscribe")(function* (input: McpEventSubscribe) {
    const { scope, principal } = yield* caller();
    yield* resource(input.arguments.threadId);
    const { id, url } = yield* identity(principal.sessionId, input);
    const existing = yield* subscriptions.get(id);
    const floor = yield* events.prunedThroughSequence.pipe(Effect.mapError(() => invalid()));
    const latest = Math.max(
      floor,
      yield* events.latestApplicationSequence.pipe(Effect.mapError(() => invalid())),
    );
    const requested = input.cursor == null ? (existing?.ackCursor ?? latest) : Number(input.cursor);
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
      .pipe(Effect.mapError((error) => new McpEventsError({ code: -32015, reason: error.reason })));
    return yield* withSubscription(
      id,
      Effect.gen(function* () {
        yield* caller();
        yield* resource(input.arguments.threadId);
        const current = yield* subscriptions.get(id);
        const now = yield* Clock.currentTimeMillis;
        const ttlMs = Math.min(7 * 86400_000, Math.max(60_000, input.ttlMs ?? 86400_000));
        const expiresAt = Math.min(principal.expiresAt.epochMilliseconds, now + ttlMs);
        // A cursorless refresh must use the acknowledgement after verification:
        // delivery may have advanced while the callback challenge was in flight.
        const currentFloor = yield* events.prunedThroughSequence.pipe(Effect.mapError(storage));
        const currentLatest = Math.max(
          currentFloor,
          yield* events.latestApplicationSequence.pipe(Effect.mapError(storage)),
        );
        const selected = input.cursor == null ? (current?.ackCursor ?? currentLatest) : requested;
        const cursor = Math.min(
          current?.ackCursor ?? Math.max(currentFloor, selected),
          Math.max(currentFloor, selected),
        );
        yield* subscriptions.save({
          id,
          notifyDerived: 0,
          principal: principal.sessionId,
          name: input.name,
          threadId: input.arguments.threadId,
          url,
          sourceUrl: Invocation.threadLinkFor(scope, input.arguments.threadId),
          secret: input.delivery.secret,
          active: 1,
          now,
          expiresAt,
          renewalTtlMs: ttlMs,
          scanCursor:
            current !== undefined && cursor === current.ackCursor ? current.scanCursor : cursor,
          ackCursor: cursor,
          truncated: selected < currentFloor || current?.truncated === 1 ? 1 : 0,
        });
        yield* Queue.offer(wake, undefined);
        return {
          id,
          refreshBefore: DateTime.formatIso(DateTime.makeUnsafe(expiresAt)),
          cursor: String(cursor),
          truncated: selected < currentFloor || current?.truncated === 1,
        };
      }),
    );
  });

  return McpEvents.of({
    replay: Effect.fn("McpEvents.replay")(function* (input) {
      const { scope, principal } = yield* caller();
      const subscription = yield* subscriptions.get(input.id);
      if (subscription === undefined || subscription.principal !== principal.sessionId)
        return yield* refused();
      const result = yield* relay.replay(scope, input.id);
      yield* Queue.offer(wake, undefined);
      return result;
    }),
    setInbox: Effect.fn("McpEvents.setInbox")(function* (input) {
      const { scope } = yield* caller();
      yield* relay.pin(scope, input.threadId);
      return { inboxThreadId: input.threadId };
    }),
    prepareNotify: Effect.fn("McpEvents.prepareNotify")(function* (input) {
      const scope = yield* Invocation.McpInvocationContext;
      if (scope.client === undefined || scope.thread !== undefined || scope.client.linked === true)
        return {
          status: "unavailable" as const,
          subscriptionIds: [],
          reason: "outside_client_required",
        };
      yield* caller();
      const prepared = yield* relay.prepare(scope, input);
      return (
        prepared ?? {
          status: "unavailable" as const,
          subscriptionIds: [],
          reason: "no_pinned_inbox",
        }
      );
    }),
    notifyThread: Effect.fn("McpEvents.notifyThread")(
      function* (prepared, threadId, runId, clientRequestId) {
        const { principal } = yield* caller();
        if (principal.sessionId !== prepared.principal) return yield* refused();
        if (runId === undefined)
          return { status: "unavailable" as const, subscriptionIds: [], reason: "run_required" };
        yield* relay.bind(prepared, threadId, runId, clientRequestId);
        yield* Queue.offer(wake, undefined);
        return {
          status: "bound" as const,
          subscriptionIds: [],
          inboxThreadId: prepared.inboxThreadId,
          relay: `relay: inbox ${prepared.inboxThreadId}`,
        };
      },
    ),
    bridgeStatus: Effect.fn("McpEvents.bridgeStatus")(function* () {
      const { principal } = yield* caller();
      const now = yield* Clock.currentTimeMillis;
      const status = yield* bridge.read(principal.sessionId);
      const listing = yield* listSubscriptions();
      const listed = listing.subscriptions;
      const watches = new Map<string, typeof McpEventWatch.Type>();
      for (const sub of listed.filter((sub) => sub.status === "active")) {
        const watch = watches.get(sub.callbackGroup);
        watches.set(sub.callbackGroup, {
          callbackGroup: sub.callbackGroup,
          callbackOrigin: sub.callbackOrigin,
          subscriptionIds: [...(watch?.subscriptionIds ?? []), sub.id],
          soonestExpiry:
            watch === undefined || sub.expiresAt < watch.soonestExpiry
              ? sub.expiresAt
              : watch.soonestExpiry,
        });
      }
      return {
        serviceStartedAt: DateTime.formatIso(DateTime.makeUnsafe(serviceStartedAt)),
        tunnel: Option.getOrNull(yield* reachability.latest),
        daysUntilSessionExpires: Math.max(
          0,
          (principal.expiresAt.epochMilliseconds - now) / 86400_000,
        ),
        inboxThreadId: listing.inboxThreadId,
        subscriptions: listed,
        watches: [...watches.values()],
        ...(yield* relay.status(principal.sessionId)),
        lastSuccessfulEventDeliveryAt:
          status.lastSuccessAt === null
            ? null
            : DateTime.formatIso(DateTime.makeUnsafe(status.lastSuccessAt)),
        deliveriesExhaustedRetries: status.exhaustedRetries,
      };
    }),
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
    listSubscriptions,
    subscribe,
    unsubscribe: Effect.fn("McpEvents.unsubscribe")(function* (input) {
      const { principal } = yield* caller();
      const id = "id" in input ? input.id : (yield* identity(principal.sessionId, input)).id;
      const existing = yield* subscriptions.get(id);
      if (existing !== undefined && existing.principal !== principal.sessionId)
        return yield* refused();
      // Explicit unsubscribe forgets the transport backlog. Recovery after a
      // delivery failure still uses stop(), retaining the acknowledged cursor.
      yield* withSubscription(id, subscriptions.remove(id, principal.sessionId));
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
          const webhookNext = yield* deliveries.nextAttempt(now);
          const relayNext = yield* relay.nextAttempt;
          const next =
            webhookNext === null
              ? relayNext
              : relayNext === null
                ? webhookNext
                : Math.min(webhookNext, relayNext);
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
        Effect.tapError((error) =>
          Effect.logWarning("MCP Events delivery worker restarting.", { reason: error.reason }),
        ),
        Effect.retry({ schedule: Schedule.spaced("5 seconds") }),
        Effect.forkScoped,
      ),
    ),
  ),
);
