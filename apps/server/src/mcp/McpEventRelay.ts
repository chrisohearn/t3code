import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthSessionId,
  CommandId,
  MessageId,
  McpEventName,
  McpEventEnvelope,
  McpEventsError,
  RuntimeMode,
  ProviderInteractionMode,
  ThreadId,
  RunId,
  type McpThreadNotify,
  type OrchestrationV2DomainEvent,
  mcpClientScopes,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as EventStore from "../persistence/OrchestrationEventStore.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "./McpInvocationContext.ts";
import { resolveRuntimeMode, resolveInteractionMode } from "./delegatedTaskModes.ts";

// Durable message ids keep loop protection independent of the bounded outbox history.
const RELAY_MESSAGE_ID_PREFIX = "message:mcp-relay:";
const DELIVERED_RETENTION_MS = 86400_000;

const denied = () => new McpEventsError({ code: -32001, reason: "access_denied" });
const storage = () => new McpEventsError({ code: -32603, reason: "storage" });
const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/**
 * The relayed event's state, and why a cancelled or interrupted run stopped, as webhook event
 * data carries them; `server_shutdown` / `server_restart` mark a restart, not a real cancel.
 */
export function relayEventState(event: OrchestrationV2DomainEvent): {
  readonly state?: string;
  readonly stopReason?: string;
} {
  switch (event.type) {
    case "run.updated": {
      const { status, stop } = event.payload;
      return (status === "cancelled" || status === "interrupted") && stop !== undefined
        ? { state: status, stopReason: stop.reason }
        : { state: status };
    }
    case "runtime-request.updated":
      return { state: event.payload.status };
    case "provider-session.detached":
      return { state: "detached" };
    default:
      return {};
  }
}
const Modes = { runtimeMode: RuntimeMode, interactionMode: ProviderInteractionMode };
const Pin = Schema.Struct({ inboxThreadId: ThreadId, ...Modes });
const Binding = Schema.Struct({
  id: Schema.String,
  principal: Schema.String,
  threadId: ThreadId,
  inboxThreadId: ThreadId,
  runId: Schema.String,
  events: Schema.fromJsonString(Schema.Array(McpEventName)),
  ledgerKey: Schema.NullOr(Schema.String),
  scanCursor: Schema.Number,
  ...Modes,
});
const Job = Schema.Struct({
  id: Schema.String,
  principal: Schema.String,
  sourceKey: Schema.String,
  sourceThreadId: ThreadId,
  inboxThreadId: ThreadId,
  messageId: MessageId,
  clientRequestId: Schema.String,
  body: Schema.String,
  attempts: Schema.Number,
  alert: Schema.Number,
  ...Modes,
});
type Job = typeof Job.Type;
export interface PreparedRelay {
  readonly principal: string;
  readonly inboxThreadId: ThreadId;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly cursor: number;
  readonly events: ReadonlyArray<McpEventName>;
}

export class McpEventRelay extends Context.Service<
  McpEventRelay,
  {
    readonly pin: (
      scope: Invocation.McpInvocationScope,
      threadId: ThreadId | null,
    ) => Effect.Effect<void, McpEventsError>;
    readonly inbox: (principal: string) => Effect.Effect<ThreadId | null, McpEventsError>;
    readonly prepare: (
      scope: Invocation.McpInvocationScope,
      input: McpThreadNotify,
    ) => Effect.Effect<PreparedRelay | undefined, McpEventsError>;
    readonly bind: (
      prepared: PreparedRelay,
      threadId: ThreadId,
      runId: RunId,
      ledgerKey?: string,
    ) => Effect.Effect<void, McpEventsError>;
    readonly replay: (
      scope: Invocation.McpInvocationScope,
      id: string,
    ) => Effect.Effect<{ replayed: number }, McpEventsError>;
    readonly drain: () => Effect.Effect<boolean, McpEventsError>;
    readonly nextAttempt: Effect.Effect<number | null, McpEventsError>;
    readonly alert: (
      principal: string,
      sourceKey: string,
      threadId: ThreadId,
      reason: string,
    ) => Effect.Effect<void, McpEventsError>;
    readonly status: (
      principal: string,
    ) => Effect.Effect<
      { relayFailures: number; relayPending: number; relayLastError: string | null },
      McpEventsError
    >;
  }
>()("t3/mcp/McpEventRelay") {}

const excerpt = (text: string) => {
  let result = "";
  let bytes = 0;
  for (const character of text) {
    bytes += Buffer.byteLength(character);
    if (bytes > 1024) break;
    result += character;
  }
  return result;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* AuthSessions.AuthSessionRepository;
  const threads = yield* Threads.ThreadManagementService;
  const events = yield* EventStore.OrchestrationEventStore;
  const digest = yield* Digest.Digest;
  const pinGate = yield* Semaphore.make(1);
  const hash = Effect.fn("McpEventRelay.hash")(function* (value: unknown) {
    const json = yield* encode(value);
    return yield* digest
      .digest(Digest.sha256, Buffer.from(json))
      .pipe(Effect.map((bytes) => Buffer.from(bytes).toString("hex")));
  }, Effect.mapError(storage));
  const pinFor = Effect.fn("McpEventRelay.pinFor")((principal: string) =>
    sql`SELECT thread_id AS "inboxThreadId", runtime_mode AS "runtimeMode", interaction_mode AS "interactionMode"
      FROM mcp_event_inboxes WHERE principal = ${principal}`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Pin))),
      Effect.map((rows) => rows[0]),
      Effect.mapError(storage),
    ),
  );
  const authorize = Effect.fn("McpEventRelay.authorize")(function* (
    principal: string,
    threadId: ThreadId,
    modes?: Invocation.ClientModes,
  ) {
    const found = yield* sessions
      .getById({ sessionId: AuthSessionId.make(principal) })
      .pipe(Effect.mapError(storage));
    if (
      Option.isNone(found) ||
      found.value.subject !== "mcp-client" ||
      found.value.method !== "bearer-access-token" ||
      found.value.revokedAt !== null ||
      found.value.expiresAt.epochMilliseconds <= (yield* Clock.currentTimeMillis) ||
      !found.value.scopes.includes(AuthOrchestrationReadScope) ||
      !found.value.scopes.includes(AuthOrchestrationOperateScope) ||
      (modes !== undefined &&
        !mcpClientScopes(modes.runtimeMode).every((scope) => found.value.scopes.includes(scope)))
    )
      return yield* denied();
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(storage));
    if (
      shell === null ||
      shell.deletedAt !== null ||
      (modes !== undefined && shell.archivedAt !== null)
    )
      return yield* denied();
    if (modes !== undefined) {
      yield* resolveRuntimeMode(modes.runtimeMode, shell.runtimeMode).pipe(Effect.mapError(denied));
      yield* resolveInteractionMode(modes.interactionMode, shell.interactionMode).pipe(
        Effect.mapError(denied),
      );
    }
    return { shell, session: found.value };
  });
  const enqueue = Effect.fn("McpEventRelay.enqueue")(function* (
    input: Omit<Job, "id" | "messageId" | "clientRequestId" | "attempts">,
  ) {
    const id = yield* hash([input.principal, input.inboxThreadId, input.sourceKey]);
    const inserted = yield* sql`INSERT INTO mcp_event_relay_outbox
      (id, principal, source_key, source_thread_id, inbox_thread_id, message_id, client_request_id, runtime_mode, interaction_mode, body, alert)
      VALUES (${id}, ${input.principal}, ${input.sourceKey}, ${input.sourceThreadId}, ${input.inboxThreadId},
        ${`${RELAY_MESSAGE_ID_PREFIX}${id}`}, ${`relay:${id}`}, ${input.runtimeMode}, ${input.interactionMode}, ${input.body}, ${input.alert})
      ON CONFLICT DO NOTHING RETURNING id`.pipe(Effect.mapError(storage));
    return inserted.length;
  });
  const alert = Effect.fn("McpEventRelay.alert")(function* (
    principal: string,
    sourceKey: string,
    threadId: ThreadId,
    reason: string,
  ) {
    const pin = yield* pinFor(principal);
    if (pin === undefined) return;
    const day = Math.floor((yield* Clock.currentTimeMillis) / 86400_000);
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const added = yield* sql`INSERT INTO mcp_event_relay_alerts (principal, source_key, day)
        VALUES (${principal}, ${sourceKey}, ${day}) ON CONFLICT DO NOTHING RETURNING source_key`;
          if (added.length === 0) return;
          yield* enqueue({
            ...pin,
            principal,
            sourceKey: `alert:${sourceKey}:${day}`,
            sourceThreadId: threadId,
            alert: 1,
            body: yield* encode({ relay: "delivery-alert", sourceKey, threadId, reason }).pipe(
              Effect.mapError(storage),
            ),
          });
        }),
      )
      .pipe(Effect.mapError(storage));
  });
  const collect = Effect.fn("McpEventRelay.collect")(function* () {
    const bindings =
      yield* sql`SELECT id, principal, thread_id AS "threadId", inbox_thread_id AS "inboxThreadId",
      run_id AS "runId", events, ledger_key AS "ledgerKey", scan_cursor AS "scanCursor",
      runtime_mode AS "runtimeMode", interaction_mode AS "interactionMode"
      FROM mcp_event_relay_bindings WHERE expires_at > ${yield* Clock.currentTimeMillis}`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Binding))),
        Effect.mapError(storage),
      );
    const latest = yield* events.latestApplicationSequence.pipe(Effect.mapError(storage));
    const floor = yield* events.prunedThroughSequence.pipe(Effect.mapError(storage));
    let behind = false;
    for (const binding of bindings) {
      if (binding.scanCursor < floor) {
        yield* alert(binding.principal, binding.id, binding.threadId, "source_history_pruned");
      }
      const allowed = yield* authorize(binding.principal, binding.threadId).pipe(Effect.result);
      if (allowed._tag === "Failure") {
        yield* sql`UPDATE mcp_event_relay_bindings SET expires_at = 0, last_error = ${allowed.failure.reason} WHERE id = ${binding.id}`.pipe(
          Effect.mapError(storage),
        );
        yield* alert(binding.principal, binding.id, binding.threadId, allowed.failure.reason);
        continue;
      }
      const batch = yield* events
        .readApplicationEvents({
          afterSequence: Math.max(binding.scanCursor, floor),
          throughSequence: latest,
        })
        .pipe(Stream.take(256), Stream.runCollect, Effect.mapError(storage));
      let through = Math.max(binding.scanCursor, floor);
      let finished = false;
      // A failover run continues the bound run's work, so the relay follows it (and its own
      // failover) and relays that run's result, as the webhook path reports it.
      let boundRunId = binding.runId;
      for (const stored of batch) {
        through = stored.sequence;
        if (!("event" in stored) || stored.event.threadId !== binding.threadId) continue;
        const event = stored.event;
        if (
          event.type === "run.updated" &&
          event.payload.userMessageId.startsWith(RELAY_MESSAGE_ID_PREFIX)
        )
          continue;
        if (
          (event.type === "run.created" || event.type === "run.updated") &&
          event.payload.failoverOfRunId === boundRunId
        ) {
          boundRunId = event.payload.id;
        }
        const runId = event.type === "run.updated" ? event.payload.id : event.runId;
        const threadLevelRelease =
          event.type === "provider-session.detached" && runId === undefined;
        if (!threadLevelRelease && runId !== boundRunId) continue;
        // A run failing over is not a blocker: its failover run reports the outcome. A skip is.
        if (
          event.type === "run.updated" &&
          event.payload.failover !== undefined &&
          event.payload.failover.state !== "skipped"
        )
          continue;
        const outcome =
          event.type === "run.updated" &&
          ["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(
            event.payload.status,
          );
        const name = outcome
          ? event.type === "run.updated" && event.payload.status === "failed"
            ? "thread.blocker"
            : "thread.run.result"
          : event.type === "runtime-request.updated" && event.payload.status === "pending"
            ? "thread.needs-decision"
            : event.type === "provider-session.detached"
              ? "thread.resource-released"
              : undefined;
        if (name === undefined || !binding.events.includes(name)) continue;
        const records = yield* threads
          .getThreadRecords(binding.threadId, ["messages"], {
            messageRunIds: [RunId.make(boundRunId)],
          })
          .pipe(Effect.mapError(storage));
        const text =
          records.messages
            .filter((message) => message.runId === boundRunId && message.role === "assistant")
            .at(-1)?.text ?? "";
        const sourceKey = outcome ? `run:${boundRunId}:outcome` : event.id;
        yield* enqueue({
          ...binding,
          sourceKey,
          sourceThreadId: binding.threadId,
          alert: 0,
          body: yield* encode({
            relay: "event",
            sourceEventId: event.id,
            eventName: name,
            threadId: binding.threadId,
            threadTitle: excerpt(records.thread.title),
            runId: runId ?? null,
            ...relayEventState(event),
            ...(threadLevelRelease ? { boundRunId } : {}),
            ledgerKey: binding.ledgerKey === null ? null : excerpt(binding.ledgerKey),
            occurredAt: DateTime.formatIso(event.occurredAt),
            resultExcerpt: excerpt(text),
            pullRequestUrls: [
              ...new Set([
                ...(records.thread.pullRequests?.map((pr) => pr.url) ?? []),
                ...(records.thread.linkedPullRequest?.url
                  ? [records.thread.linkedPullRequest.url]
                  : []),
              ]),
            ]
              .filter((url) => Buffer.byteLength(url) <= 2048)
              .slice(0, 8),
          }).pipe(Effect.mapError(storage)),
        });
        if (outcome) {
          finished = true;
          break;
        }
      }
      yield* sql`UPDATE mcp_event_relay_bindings SET scan_cursor = ${through}, run_id = ${boundRunId}, expires_at = CASE WHEN ${finished ? 1 : 0} = 1 THEN 0 ELSE expires_at END WHERE id = ${binding.id}`.pipe(
        Effect.mapError(storage),
      );
      behind ||= !finished && through < latest;
    }
    return behind;
  });
  const dispatch = Effect.fn("McpEventRelay.dispatch")(
    function* (job: Job) {
      const pin = yield* pinFor(job.principal);
      if (pin === undefined || pin.inboxThreadId !== job.inboxThreadId) return yield* denied();
      if (job.alert === 0) yield* authorize(job.principal, job.sourceThreadId);
      const { shell } = yield* authorize(job.principal, job.inboxThreadId, job);
      yield* resolveRuntimeMode(pin.runtimeMode, shell.runtimeMode).pipe(Effect.mapError(denied));
      yield* resolveInteractionMode(pin.interactionMode, shell.interactionMode).pipe(
        Effect.mapError(denied),
      );
      yield* threads
        .sendToThread({
          projectId: shell.projectId,
          threadId: job.inboxThreadId,
          commandId: CommandId.make(job.clientRequestId),
          messageId: job.messageId,
          text: `[T3 event relay]\n${job.body}`,
          attachments: [],
          mode: "queue",
          createdBy: "system",
          creationSource: "server",
        })
        .pipe(
          Effect.mapError(() => new McpEventsError({ code: -32603, reason: "inbox_send_failed" })),
        );
      yield* sql`UPDATE mcp_event_relay_outbox SET status = 'delivered', last_error = NULL, body = '', next_attempt_at = ${yield* Clock.currentTimeMillis} WHERE id = ${job.id}`.pipe(
        Effect.mapError(storage),
      );
    },
    (effect) => pinGate.withPermit(effect),
  );
  return McpEventRelay.of({
    inbox: Effect.fn("McpEventRelay.inbox")((principal) =>
      pinFor(principal).pipe(Effect.map((pin) => pin?.inboxThreadId ?? null)),
    ),
    pin: Effect.fn("McpEventRelay.pin")(
      function* (scope, threadId) {
        if (
          scope.thread !== undefined ||
          scope.client === undefined ||
          scope.client.linked ||
          scope.client.access === "read-only"
        )
          return yield* denied();
        const modes = Invocation.clientModeCeiling(scope.client);
        if (threadId === null) {
          yield* sql`DELETE FROM mcp_event_inboxes WHERE principal = ${scope.client.sessionId}`.pipe(
            Effect.mapError(storage),
          );
          return;
        }
        yield* authorize(scope.client.sessionId, threadId, modes);
        yield* sql`INSERT INTO mcp_event_inboxes (principal, thread_id, runtime_mode, interaction_mode)
        VALUES (${scope.client.sessionId}, ${threadId}, ${modes.runtimeMode}, ${modes.interactionMode})
        ON CONFLICT(principal) DO UPDATE SET thread_id = excluded.thread_id, runtime_mode = excluded.runtime_mode,
        interaction_mode = excluded.interaction_mode`.pipe(Effect.mapError(storage));
      },
      (effect) => pinGate.withPermit(effect),
    ),
    prepare: Effect.fn("McpEventRelay.prepare")(function* (scope, input) {
      if (
        scope.client === undefined ||
        scope.thread !== undefined ||
        scope.client.linked ||
        scope.client.access === "read-only"
      )
        return yield* denied();
      const pin = yield* pinFor(scope.client.sessionId);
      if (pin === undefined) return undefined;
      const modes = Invocation.clientModeCeiling(scope.client);
      yield* authorize(scope.client.sessionId, pin.inboxThreadId, modes);
      return {
        ...modes,
        principal: scope.client.sessionId,
        inboxThreadId: pin.inboxThreadId,
        cursor: yield* events.latestApplicationSequence.pipe(Effect.mapError(storage)),
        events: input.events ?? ["thread.run.result", "thread.needs-decision", "thread.blocker"],
      };
    }),
    bind: Effect.fn("McpEventRelay.bind")(function* (prepared, threadId, runId, ledgerKey) {
      const { session } = yield* authorize(prepared.principal, threadId);
      const pin = yield* pinFor(prepared.principal);
      if (pin === undefined || pin.inboxThreadId !== prepared.inboxThreadId) return yield* denied();
      yield* authorize(prepared.principal, pin.inboxThreadId, prepared);
      const records = yield* threads
        .getThreadRecords(threadId, ["runs"], { runIds: [runId] })
        .pipe(Effect.mapError(storage));
      const run = records.runs.find((candidate) => candidate.id === runId);
      if (run?.userMessageId.startsWith(RELAY_MESSAGE_ID_PREFIX))
        return yield* new McpEventsError({ code: -32602, reason: "relay_loop" });
      const [start] = yield* sql<{
        firstSequence: number | null;
      }>`SELECT MIN(sequence) AS "firstSequence" FROM orchestration_events
        WHERE application_event_version = 2 AND aggregate_kind = 'thread' AND stream_id = ${threadId}
          AND event_type = 'run.updated' AND json_extract(payload_json, '$.id') = ${runId}`.pipe(
        Effect.mapError(storage),
      );
      if (run !== undefined && start?.firstSequence == null)
        return yield* new McpEventsError({ code: -32602, reason: "source_history_pruned" });
      const cursor = Math.min(
        prepared.cursor,
        start?.firstSequence == null ? prepared.cursor : Math.max(0, start.firstSequence - 1),
      );
      const id = yield* hash([prepared.principal, threadId, runId, prepared.inboxThreadId]);
      yield* sql`INSERT INTO mcp_event_relay_bindings
        (id, principal, thread_id, inbox_thread_id, run_id, events, ledger_key, runtime_mode, interaction_mode, scan_cursor, expires_at)
        VALUES (${id}, ${prepared.principal}, ${threadId}, ${prepared.inboxThreadId}, ${runId}, ${yield* encode(prepared.events).pipe(Effect.mapError(storage))},
          ${ledgerKey ?? null}, ${prepared.runtimeMode}, ${prepared.interactionMode}, ${cursor},
          ${session.expiresAt.epochMilliseconds})
        ON CONFLICT DO NOTHING`.pipe(Effect.mapError(storage));
    }),
    replay: Effect.fn("McpEventRelay.replay")(function* (scope, id) {
      if (
        scope.client === undefined ||
        scope.thread !== undefined ||
        scope.client.linked ||
        scope.client.access === "read-only"
      )
        return yield* denied();
      const pin = yield* pinFor(scope.client.sessionId);
      if (pin === undefined)
        return yield* new McpEventsError({ code: -32602, reason: "no_pinned_inbox" });
      const modes = Invocation.clientModeCeiling(scope.client);
      yield* authorize(scope.client.sessionId, pin.inboxThreadId, modes);
      const rows = yield* sql`SELECT d.body FROM mcp_event_deliveries AS d
        JOIN mcp_event_subscriptions AS s ON s.id = d.subscription_id
        WHERE s.id = ${id} AND s.principal = ${scope.client.sessionId} AND (s.active = 0 OR s.expires_at <= ${yield* Clock.currentTimeMillis})
          AND d.acknowledged = 0 AND d.attempts >= 8 AND NOT EXISTS (
            SELECT 1 FROM mcp_event_relay_outbox AS r WHERE r.principal = s.principal
            AND r.inbox_thread_id = ${pin.inboxThreadId} AND r.source_key = 'replay:' || s.id || ':' || d.event_id
          ) ORDER BY d.sequence LIMIT 256`.pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Array(Schema.Struct({ body: Schema.fromJsonString(McpEventEnvelope) })),
          ),
        ),
        Effect.mapError(storage),
      );
      let replayed = 0;
      for (const { body } of rows) {
        yield* authorize(scope.client.sessionId, body.data.threadId);
        replayed += yield* enqueue({
          ...modes,
          principal: scope.client.sessionId,
          inboxThreadId: pin.inboxThreadId,
          sourceKey: `replay:${id}:${body.eventId}`,
          sourceThreadId: body.data.threadId,
          alert: 0,
          body: yield* encode({
            relay: "replay",
            sourceEventId: body.eventId,
            eventName: body.name,
            threadId: body.data.threadId,
            runId: body.data.runId ?? null,
            source: body.data,
          }).pipe(Effect.mapError(storage)),
        });
      }
      return { replayed };
    }),
    drain: Effect.fn("McpEventRelay.drain")(function* () {
      yield* sql`DELETE FROM mcp_event_relay_outbox WHERE status = 'delivered'
        AND next_attempt_at < ${(yield* Clock.currentTimeMillis) - DELIVERED_RETENTION_MS}`.pipe(
        Effect.mapError(storage),
      );
      const behind = yield* collect();
      const day = Math.floor((yield* Clock.currentTimeMillis) / 86400_000);
      const exhausted = yield* sql<{ principal: string; sourceKey: string; threadId: ThreadId }>`
        SELECT DISTINCT s.principal, 'subscription:' || s.id AS "sourceKey", s.thread_id AS "threadId"
        FROM mcp_event_subscriptions AS s JOIN mcp_event_deliveries AS d ON d.subscription_id = s.id
        JOIN mcp_event_inboxes AS i ON i.principal = s.principal
        WHERE (s.active = 0 OR s.expires_at <= ${yield* Clock.currentTimeMillis}) AND d.attempts >= 8 AND d.acknowledged = 0 AND NOT EXISTS (
          SELECT 1 FROM mcp_event_relay_alerts AS a WHERE a.principal = s.principal
          AND a.source_key = 'subscription:' || s.id AND a.day = ${day}) LIMIT 64`.pipe(
        Effect.mapError(storage),
      );
      for (const failure of exhausted)
        yield* alert(
          failure.principal,
          failure.sourceKey,
          failure.threadId,
          "webhook_retries_exhausted",
        );
      const failed = yield* sql<{
        principal: string;
        sourceKey: string;
        threadId: ThreadId;
        reason: string;
      }>`
        SELECT principal, 'relay:' || source_key AS "sourceKey", source_thread_id AS "threadId", last_error AS reason
        FROM mcp_event_relay_outbox AS r WHERE status = 'failed' AND alert = 0 AND NOT EXISTS (
          SELECT 1 FROM mcp_event_relay_alerts AS a WHERE a.principal = r.principal
          AND a.source_key = 'relay:' || r.source_key AND a.day = ${day}) LIMIT 64`.pipe(
        Effect.mapError(storage),
      );
      for (const failure of failed)
        yield* alert(failure.principal, failure.sourceKey, failure.threadId, failure.reason);
      const jobs =
        yield* sql`SELECT id, principal, source_key AS "sourceKey", source_thread_id AS "sourceThreadId",
        inbox_thread_id AS "inboxThreadId", message_id AS "messageId", client_request_id AS "clientRequestId",
        runtime_mode AS "runtimeMode", interaction_mode AS "interactionMode", body, attempts, alert
        FROM mcp_event_relay_outbox WHERE status = 'pending' AND next_attempt_at <= ${yield* Clock.currentTimeMillis}
        ORDER BY rowid LIMIT 64`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Job))),
          Effect.mapError(storage),
        );
      for (const job of jobs) {
        yield* dispatch(job).pipe(
          Effect.catchTags({
            McpEventsError: Effect.fn("McpEventRelay.failed")(function* (error) {
              const exhausted = job.attempts + 1 >= 8 || error.reason === "access_denied";
              yield* sql`UPDATE mcp_event_relay_outbox SET attempts = attempts + 1, last_error = ${error.reason},
            status = ${exhausted ? "failed" : "pending"}, next_attempt_at = ${(yield* Clock.currentTimeMillis) + Math.min(300_000, 1000 * 2 ** job.attempts)}
            WHERE id = ${job.id}`.pipe(Effect.mapError(storage));
              if (exhausted && job.alert === 0)
                yield* alert(
                  job.principal,
                  `relay:${job.sourceKey}`,
                  job.sourceThreadId,
                  error.reason,
                );
            }),
          }),
        );
      }
      return behind || jobs.length === 64;
    }),
    nextAttempt: sql<{
      at: number | null;
    }>`SELECT MIN(next_attempt_at) AS at FROM mcp_event_relay_outbox WHERE status = 'pending'`.pipe(
      Effect.map((rows) => rows[0]?.at ?? null),
      Effect.mapError(storage),
    ),
    alert,
    status: Effect.fn("McpEventRelay.status")((principal) =>
      sql<{ relayFailures: number; relayPending: number; relayLastError: string | null }>`
      SELECT (SELECT COALESCE(SUM(attempts), 0) FROM mcp_event_relay_outbox WHERE principal = ${principal}) + (SELECT COUNT(*) FROM mcp_event_relay_bindings WHERE principal = ${principal} AND last_error IS NOT NULL) AS "relayFailures",
        (SELECT COUNT(*) FROM mcp_event_relay_outbox WHERE principal = ${principal} AND status = 'pending') AS "relayPending",
        COALESCE((SELECT last_error FROM mcp_event_relay_outbox WHERE principal = ${principal} AND last_error IS NOT NULL ORDER BY rowid DESC LIMIT 1),
        (SELECT last_error FROM mcp_event_relay_bindings WHERE principal = ${principal} AND last_error IS NOT NULL ORDER BY rowid DESC LIMIT 1)) AS "relayLastError"`.pipe(
        Effect.map((rows) => rows[0]!),
        Effect.mapError(storage),
      ),
    ),
  });
});
export const layer = Layer.effect(McpEventRelay, make);
