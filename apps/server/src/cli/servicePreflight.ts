import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import {
  type CodexShadowHomesPreflight,
  inspectConfiguredCodexShadowHomes,
} from "../cloud/codexShadowPreflight.ts";
import { runServicePreflight } from "../cloud/servicePreflight.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const servicePreflightCommand = Command.make("__service-preflight", {
  databasePath: Flag.String("database-path"),
  launcherProtocol: Flag.Int("launcher-protocol"),
}).pipe(
  Command.unlisted,
  Command.withHandler(({ databasePath, launcherProtocol }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const result = runServicePreflight({ databasePath, launcherProtocol });
      // Reported beside `status`, which the launcher reads: the release gate checks it instead.
      const codexShadowHomes = yield* ManagedPolicy.ManagedPolicy.pipe(
        Effect.flatMap((policy) =>
          inspectConfiguredCodexShadowHomes(path.dirname(databasePath), policy),
        ),
        // Only JSON may reach stdout.
        Effect.provide(
          ManagedPolicy.layer.pipe(
            Layer.provide(Layer.succeed(References.MinimumLogLevel, "Warn")),
          ),
        ),
        Effect.orElseSucceed((): CodexShadowHomesPreflight => ({
          status: "not-ready",
          instances: [
            {
              instanceId: "*",
              shadowHomePath: "",
              status: "unknown",
              conflicts: [],
              detail: "The managed policy could not be read, so Codex instances cannot be checked.",
            },
          ],
        })),
      );
      yield* Console.log(yield* encodeJson({ ...result, codexShadowHomes }));
    }),
  ),
);
