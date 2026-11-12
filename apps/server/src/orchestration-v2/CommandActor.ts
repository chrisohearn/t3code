import type { UserInputAnsweredBy } from "@t3tools/contracts";
import * as Context from "effect/Context";

/**
 * Who dispatched a command, provided by the transport that received it and never read from the
 * command, so a client cannot claim to be the owner. Absent means unknown and verifies as nobody.
 */
export class CommandActor extends Context.Service<
  CommandActor,
  { readonly kind: UserInputAnsweredBy }
>()("t3/orchestration-v2/CommandActor") {}
