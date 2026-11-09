// @effect-diagnostics anyUnknownInErrorContext:off -- The public MCP adapter interface erases the base handler's error and service types.
import {
  McpEventSubscribe,
  McpEventUnsubscribe,
  McpEventSubscriptionResult,
  type McpEventsError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";
import { McpProtocol, McpSchema } from "effect/ai";

import * as McpEvents from "./McpEvents.ts";

const protocolFailure = Schema.Struct({
  code: Schema.Int,
  message: Schema.String,
  data: Schema.Struct({ reason: Schema.String }),
});
const eventRpcs = RpcGroup.make(
  Rpc.make("events/list", {
    payload: Schema.Struct({ cursor: Schema.optionalKey(Schema.String) }),
    success: Schema.Struct({ events: Schema.Array(Schema.Unknown) }),
    error: protocolFailure,
  }),
  Rpc.make("events/subscribe", {
    payload: McpEventSubscribe,
    success: McpEventSubscriptionResult,
    error: protocolFailure,
  }),
  Rpc.make("events/unsubscribe", {
    payload: McpEventUnsubscribe,
    success: Schema.Struct({}),
    error: protocolFailure,
  }),
).middleware(McpSchema.McpServerClientMiddleware);

const Initialize = McpSchema.Initialize.setSuccess(
  Schema.Struct({
    protocolVersion: Schema.String,
    capabilities: Schema.Record(Schema.String, Schema.Unknown),
    serverInfo: McpSchema.Implementation,
    instructions: Schema.optional(Schema.String),
    _meta: Schema.optional(Schema.Unknown),
  }),
).middleware(McpSchema.McpServerClientMiddleware);

type Install = <R extends Rpc.Any, H extends RpcGroup.HandlersFrom<R>>(
  protocol: { readonly protocolVersion: string },
  rpcs: RpcGroup.RpcGroup<R>,
  handlers: H,
) => Effect.Effect<void, never, RpcGroup.HandlersServices<R, H>>;
type Handler = (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown, unknown, unknown>;

const protocolError = (error: McpEventsError) => ({
  code: error.code,
  message: error.message,
  data: { reason: error.reason },
});

/** Extend the public adapter boundary, preserving Effect's HTTP sessions and existing tool handlers. */
export const protocol: McpProtocol.ProtocolAdapter<
  "2025-06-18",
  McpProtocol.StatefulRuntimeDescriptor
> = {
  ...McpProtocol.v2025_06_18,
  payloadCodecs: (rpc) => {
    const event = Array.from(eventRpcs.requests.values()).find(
      (event) => rpc._tag === event._tag || rpc._tag.endsWith(`/${event._tag}`),
    );
    if (event === undefined) return McpProtocol.v2025_06_18.payloadCodecs(rpc);
    const codec = Schema.toCodecJson(event.payloadSchema);
    return {
      decode: Schema.decodeUnknownEffect(codec, { onExcessProperty: "error" }),
      encode: Schema.encodeUnknownEffect(codec),
    };
  },
  clientRpcs: RpcGroup.make(...McpProtocol.v2025_06_18.clientRpcs.requests.values())
    .omit("initialize")
    .add(Initialize)
    .merge(eventRpcs),
  installHandlers: Effect.fn("McpEventsProtocol.installHandlers")(
    function* (core, lifecycle, rawTarget) {
      const events = yield* McpEvents.McpEvents;
      const target = rawTarget as { readonly context: unknown; readonly install: Install };
      const install: Install = (selected, rpcs, handlers) => {
        const original = (handlers as Record<string, Handler>).initialize;
        if (original === undefined) return target.install(selected, rpcs, handlers);
        const amended = {
          ...handlers,
          initialize: (...args: ReadonlyArray<unknown>) =>
            original(...args).pipe(
              Effect.map((result) => {
                if (
                  !Predicate.isReadonlyObject(result) ||
                  !Predicate.isReadonlyObject(result.capabilities)
                )
                  return result;
                const capabilities = Object.fromEntries(
                  Object.entries(result.capabilities).filter(([, value]) => value !== undefined),
                );
                return { ...result, capabilities: { ...capabilities, events: {} } };
              }),
            ),
        } as typeof handlers;
        return target.install(selected, rpcs, amended);
      };
      yield* McpProtocol.v2025_06_18.installHandlers(core, lifecycle, { ...target, install });
      yield* target.install(McpProtocol.v2025_06_18, eventRpcs, {
        "events/list": () => events.list().pipe(Effect.mapError(protocolError)),
        "events/subscribe": (input) => events.subscribe(input).pipe(Effect.mapError(protocolError)),
        "events/unsubscribe": (input) =>
          events.unsubscribe(input).pipe(Effect.mapError(protocolError)),
      });
    },
  ),
};
