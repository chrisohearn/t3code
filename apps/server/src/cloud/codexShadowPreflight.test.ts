import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { inspectConfiguredCodexShadowHomes } from "./codexShadowPreflight.ts";

it.layer(NodeServices.layer)("inspectConfiguredCodexShadowHomes", (it) => {
  describe("Codex shadow homes", () => {
    it.effect.skipIf(!symlinksSupported)(
      "reports a shadow's own copy of a shared database without changing anything",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const stateDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-state-" });
          const sharedHome = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3code-codex-shared-",
          });
          const otherSqliteHome = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3code-codex-sqlite-",
          });
          // Managed instances get a shadow under the state directory without a configured path.
          const managedShadow = path.join(stateDir, "providers", "codex", "codex_pro", "shadow");
          const workShadow = path.join(stateDir, "work-shadow");
          yield* fileSystem.writeFileString(
            path.join(stateDir, "settings.json"),
            JSON.stringify({
              providerInstances: {
                codex_pro: {
                  driver: "codex",
                  config: { setupMode: "managed", homePath: sharedHome },
                },
                codex_work: {
                  driver: "codex",
                  config: { homePath: sharedHome, shadowHomePath: workShadow },
                  environment: [{ name: "CODEX_SQLITE_HOME", value: otherSqliteHome }],
                },
              },
            }),
          );
          yield* fileSystem.writeFileString(
            path.join(sharedHome, "memories_v2_1.sqlite"),
            "shared",
          );
          for (const shadow of [managedShadow, workShadow]) {
            yield* fileSystem.makeDirectory(shadow, { recursive: true });
            for (const name of ["memories_v2_1.sqlite", "memories_v2_1.sqlite-wal"]) {
              yield* fileSystem.writeFileString(path.join(shadow, name), `own ${name}`);
            }
          }
          const listing = Effect.fn("listing")(function* () {
            return {
              state: (yield* fileSystem.readDirectory(stateDir, { recursive: true })).toSorted(),
              shared: (yield* fileSystem.readDirectory(sharedHome)).toSorted(),
            };
          });
          const before = yield* listing();

          const report = yield* inspectConfiguredCodexShadowHomes(stateDir);

          expect(report.status).toBe("not-ready");
          expect(report.instances).toEqual([
            {
              instanceId: "codex_pro",
              shadowHomePath: managedShadow,
              status: "auto-settle",
              conflicts: [
                {
                  entryName: "memories_v2_1.sqlite",
                  path: path.join(managedShadow, "memories_v2_1.sqlite"),
                  autoSettle: true,
                },
              ],
            },
            {
              instanceId: "codex_work",
              shadowHomePath: workShadow,
              status: "not-ready",
              conflicts: [
                {
                  entryName: "memories_v2_1.sqlite",
                  path: path.join(workShadow, "memories_v2_1.sqlite"),
                  autoSettle: false,
                },
              ],
            },
          ]);
          expect(yield* listing()).toEqual(before);
        }),
    );

    it.effect("is ready when there is no settings file", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const stateDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-state-" });

        expect(yield* inspectConfiguredCodexShadowHomes(stateDir)).toEqual({
          status: "ready",
          instances: [],
        });
      }),
    );
  });
});
