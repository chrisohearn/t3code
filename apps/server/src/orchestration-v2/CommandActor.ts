import type {
  ServerAuthSessionMethod,
  ThreadId,
  UserInputAnsweredBy,
  UserInputAnsweringClient,
} from "@t3tools/contracts";
import * as Context from "effect/Context";

/**
 * Who dispatched a command, provided by the transport that received it and never read from the
 * command, so a client cannot claim to be the owner. Absent means unknown and verifies as nobody.
 */
export class CommandActor extends Context.Service<
  CommandActor,
  {
    readonly kind: UserInputAnsweredBy;
    readonly client?: UserInputAnsweringClient;
    /** An MCP caller's sign-in and thread, for attribution only; approvals read `client`. */
    readonly caller?: {
      readonly sessionId?: string;
      readonly clientLabel?: string;
      readonly threadId?: ThreadId;
    };
  }
>()("t3/orchestration-v2/CommandActor") {}

/**
 * The owner actor for a WebSocket session, or none. `t3 auth session issue` sessions are stamped
 * `bot` by the server, so a local process cannot answer as the owner with one. A session paired
 * from `t3 auth pairing create` looks like any paired device; ADR 0015 records that limit.
 */
export const ownerClientActor = (session: {
  readonly sessionId: string;
  readonly method: ServerAuthSessionMethod;
  readonly client?: { readonly label?: string; readonly deviceType?: string };
}): CommandActor["Service"] | undefined =>
  session.client === undefined || session.client.deviceType === "bot"
    ? undefined
    : {
        kind: "owner_client",
        client: {
          sessionId: session.sessionId.slice(0, 8),
          clientLabel: session.client.label ?? session.method,
        },
      };
