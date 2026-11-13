import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { codexAppServerArgs, codexMcpListLaunchArgs } from "./codexLaunchArgs.ts";

const decodeServers = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ name: Schema.String }))),
);

class CodexMcpIsolationError extends Schema.TaggedError<CodexMcpIsolationError>()(
  "CodexMcpIsolationError",
  { exitCode: Schema.Number },
) {}

export const isolatedCodexAppServerArgs = Effect.fn("CodexMcpIsolation.appServerArgs")(
  function* (input: {
    readonly binary: string;
    readonly env: NodeJS.ProcessEnv;
    readonly launchArgs: string;
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const command = yield* resolveSpawnCommand(
      input.binary,
      [...codexMcpListLaunchArgs(input.launchArgs), "mcp", "list", "--json"],
      { env: input.env },
    );
    const child = yield* spawner.spawn(
      ChildProcess.make(command.command, command.args, {
        env: input.env,
        shell: command.shell,
        forceKillAfter: "1 second",
      }),
    );
    const [stdout, , exitCode] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.runDrain),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0) {
      return yield* new CodexMcpIsolationError({ exitCode: Number(exitCode) });
    }
    const servers = yield* decodeServers(stdout);
    return codexAppServerArgs(
      input.launchArgs,
      servers.map((server) => server.name),
    );
  },
  Effect.scoped,
  Effect.timeout("10 seconds"),
);
