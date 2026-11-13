import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as TestClock from "effect/testing/TestClock";

import { makeIsolatedCodexAppServerArgs } from "./CodexMcpIsolation.ts";
import { codexAppServerArgs } from "./codexLaunchArgs.ts";

it.live(
  "reads home MCP servers offline and ignores profile tables, caching until configuration changes",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const configPath = `${directory}/config.toml`;
      const source = `profile = "work"
[mcp_servers.t3_omarchy]
command = "unused"
[profiles.work.mcp_servers.t3_macbook]
url = "http://127.0.0.1:1"
[profiles.travel.mcp_servers.t3_macbook]
command = "unused"`;
      yield* fs.writeFileString(configPath, source);
      let reads = 0;
      const isolate = yield* makeIsolatedCodexAppServerArgs.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readFileString: (path, encoding) => {
            reads++;
            return fs.readFileString(path, encoding);
          },
        }),
      );
      const input = { instanceId: "one", env: { CODEX_HOME: directory }, launchArgs: "" };
      assert.deepEqual(yield* isolate(input), codexAppServerArgs("", ["t3_omarchy"]));
      yield* isolate(input);
      assert.equal(reads, 1);
      assert.deepEqual(
        yield* isolate({ ...input, launchArgs: "--profile travel" }),
        codexAppServerArgs("--profile travel", ["t3_omarchy"]),
      );
      assert.deepEqual(
        yield* isolate({ ...input, launchArgs: "-c profile=travel" }),
        codexAppServerArgs("-c profile=travel", ["t3_omarchy"]),
      );
      const profileOverride = String.raw`-c profiles.work.mcp_servers.t3_macbook.command=\"unused\"`;
      assert.deepEqual(
        yield* isolate({ ...input, launchArgs: profileOverride }),
        codexAppServerArgs(profileOverride, ["t3_omarchy"]),
      );
      yield* fs.writeFileString(configPath, '[mcp_servers.t3_macbook]\ncommand="unused"\n');
      assert.deepEqual(yield* isolate(input), codexAppServerArgs("", ["t3_macbook"]));
      yield* fs.writeFileString(configPath, source);
      assert.equal(yield* fs.readFileString(configPath), source);
      yield* fs.makeDirectory(`${directory}/.codex`);
      yield* fs.writeFileString(
        `${directory}/.codex/config.toml`,
        '[mcp_servers.t3_macbook]\ncommand="unused"',
      );
      assert.deepEqual(
        yield* isolate({ ...input, env: { HOME: directory } }),
        codexAppServerArgs("", ["t3_macbook"]),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("never holds startup behind stalled configuration IO", () =>
  Effect.gen(function* () {
    const reading = yield* Deferred.make<void>();
    const fs = yield* FileSystem.FileSystem;
    const isolate = yield* makeIsolatedCodexAppServerArgs.pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        exists: () => Deferred.succeed(reading, undefined).pipe(Effect.andThen(Effect.never)),
      }),
    );
    const startup = yield* isolate({ instanceId: "stalled", env: {}, launchArgs: "" }).pipe(
      Effect.forkScoped,
    );
    yield* Deferred.await(reading);
    yield* TestClock.adjust("250 millis");
    assert.deepEqual(yield* Fiber.join(startup), codexAppServerArgs());
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live(
  "adds no absent transports and skips isolation on unreadable or invalid configuration",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const isolate = yield* makeIsolatedCodexAppServerArgs;
      const input = { instanceId: "one", env: { CODEX_HOME: directory }, launchArgs: "" };
      for (const source of ["", '[mcp_servers.other]\ncommand="unused"', "invalid TOML !"]) {
        yield* fs.writeFileString(`${directory}/config.toml`, source);
        assert.deepEqual(yield* isolate(input), codexAppServerArgs());
      }
      yield* fs.remove(`${directory}/config.toml`);
      assert.deepEqual(yield* isolate(input), codexAppServerArgs());
      const launchArgs = String.raw`-c mcp_servers.t3_macbook.command=\"unused\"`;
      assert.deepEqual(
        yield* isolate({ ...input, launchArgs }),
        codexAppServerArgs(launchArgs, ["t3_macbook"]),
      );
      yield* fs.makeDirectory(`${directory}/config.toml`);
      assert.deepEqual(yield* isolate(input), codexAppServerArgs());
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
