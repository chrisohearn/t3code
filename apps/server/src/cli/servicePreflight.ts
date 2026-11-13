import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import { inspectConfiguredCodexShadowHomes } from "../cloud/codexShadowPreflight.ts";
import { runServicePreflight } from "../cloud/servicePreflight.ts";

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
      const codexShadowHomes = yield* inspectConfiguredCodexShadowHomes(path.dirname(databasePath));
      yield* Console.log(yield* encodeJson({ ...result, codexShadowHomes }));
    }),
  ),
);
