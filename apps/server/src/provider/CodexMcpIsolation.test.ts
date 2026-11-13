import * as NodeServices from "@effect/platform-node/NodeServices";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";

import { isolatedCodexAppServerArgs } from "./CodexMcpIsolation.ts";

it.live("isolates configured T3 sign-ins without introducing absent transports", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const binary = writeFakeCli({
      directory,
      name: "codex",
      source: `
        import assert from "node:assert/strict";
        assert.deepEqual(process.argv.slice(2), ["-c", "mcp_servers.t3_macbook.enabled=true", "mcp", "list", "--json"]);
        console.log(process.env.SERVERS);
      `,
    });
    for (const servers of [[], [{ name: "other" }], [{ name: "t3_macbook" }, { name: "other" }]]) {
      const args = yield* isolatedCodexAppServerArgs({
        binary,
        env: { ...process.env, SERVERS: JSON.stringify(servers) },
        launchArgs: "-c mcp_servers.t3_macbook.enabled=true",
      });
      assert.deepEqual(args, [
        "app-server",
        "-c",
        "thread_unload_delay_secs=0",
        "-c",
        "mcp_servers.t3_macbook.enabled=true",
        ...(servers.some((server) => server.name === "t3_macbook")
          ? ["-c", "mcp_servers.t3_macbook.enabled=false"]
          : []),
      ]);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("refuses to launch when inherited MCP configuration cannot be inspected", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    for (const source of ["process.exit(1)", 'console.log("not JSON")']) {
      const binary = writeFakeCli({ directory, name: "codex", source });
      const result = yield* Effect.exit(
        isolatedCodexAppServerArgs({ binary, env: process.env, launchArgs: "" }),
      );
      assert.isTrue(Exit.isFailure(result));
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
