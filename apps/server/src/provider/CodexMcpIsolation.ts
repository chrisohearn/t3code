import { deepMerge } from "@t3tools/shared/Struct";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { parse } from "smol-toml";

import { codexAppServerArgs, codexMcpListLaunchArgs } from "./codexLaunchArgs.ts";

class CodexMcpConfigError extends Schema.TaggedError<CodexMcpConfigError>()("CodexMcpConfigError", {
  cause: Schema.Defect(),
}) {}

const table = (value: unknown): Record<string, unknown> => (Predicate.isObject(value) ? value : {});

const configuredServers = (source: string, launchArgs: string) => {
  const args = codexMcpListLaunchArgs(launchArgs);
  let config: Record<string, unknown> = parse(source);
  let overrides: Record<string, unknown> = {};
  let profile: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--profile" || arg === "-p") {
      profile = args[++index];
    } else if (arg.startsWith("--profile=") || arg.startsWith("-p=")) {
      profile = arg.slice(arg.indexOf("=") + 1);
    } else if (
      arg === "--config" ||
      arg === "-c" ||
      arg.startsWith("--config=") ||
      arg.startsWith("-c=")
    ) {
      const override =
        arg === "--config" || arg === "-c" ? args[++index]! : arg.slice(arg.indexOf("=") + 1);
      const key = override.slice(0, override.indexOf("="));
      if (
        key === "profile" ||
        key === "mcp_servers" ||
        key.startsWith("mcp_servers.") ||
        key.startsWith("profiles.")
      ) {
        let parsed: Record<string, unknown>;
        try {
          parsed = parse(override);
        } catch {
          parsed = parse(`${key}=${JSON.stringify(override.slice(override.indexOf("=") + 1))}`);
        }
        overrides = deepMerge(overrides, parsed);
      }
    }
  }
  config = deepMerge(config, overrides);
  const selectedProfile = profile ?? config.profile;
  if (typeof selectedProfile === "string") {
    config = deepMerge(config, table(table(config.profiles)[selectedProfile]));
  }
  return Object.keys(table(deepMerge(config, overrides).mcp_servers));
};

export const makeIsolatedCodexAppServerArgs = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const cache = new Map<string, { signature: string; servers: ReadonlyArray<string> }>();

  return Effect.fn("CodexMcpIsolation.appServerArgs")(function* (input: {
    readonly instanceId: string;
    readonly env: NodeJS.ProcessEnv;
    readonly launchArgs: string;
  }) {
    return yield* Effect.gen(function* () {
      const configPath = path.resolve(
        input.env.CODEX_HOME ||
          path.join(input.env.HOME || input.env.USERPROFILE || home, ".codex"),
        "config.toml",
      );
      const exists = yield* fs.exists(configPath);
      if (!exists) {
        const servers = yield* Effect.try({
          try: () => configuredServers("", input.launchArgs),
          catch: (cause) => new CodexMcpConfigError({ cause }),
        });
        return codexAppServerArgs(input.launchArgs, servers);
      }
      const info = yield* fs.stat(configPath);
      const signature = `${configPath}\0${Option.getOrUndefined(info.mtime)?.getTime()}\0${info.size}\0${input.launchArgs}`;
      let cached = cache.get(input.instanceId);
      if (cached?.signature !== signature) {
        const source = yield* fs.readFileString(configPath);
        const servers = yield* Effect.try({
          try: () => configuredServers(source, input.launchArgs),
          catch: (cause) => new CodexMcpConfigError({ cause }),
        });
        cached = { signature, servers };
        cache.set(input.instanceId, cached);
      }
      return codexAppServerArgs(input.launchArgs, cached.servers);
    }).pipe(
      Effect.timeout("250 millis"),
      Effect.catch(() =>
        Effect.logWarning(
          "Could not inspect offline Codex MCP configuration; identity isolation skipped",
          {
            instanceId: input.instanceId,
          },
        ).pipe(Effect.as(codexAppServerArgs(input.launchArgs))),
      ),
    );
  });
});
