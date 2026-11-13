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
          const linkShadow = path.join(stateDir, "link-shadow");
          const legacyShadow = path.join(stateDir, "legacy-shadow");
          // Codex follows a symlinked CODEX_SQLITE_HOME into the shared home.
          const sqliteHomeLink = path.join(otherSqliteHome, "shared-link");
          yield* fileSystem.symlink(sharedHome, sqliteHomeLink);
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
                codex_link: {
                  driver: "codex",
                  config: { homePath: sharedHome, shadowHomePath: linkShadow },
                  environment: [{ name: "CODEX_SQLITE_HOME", value: sqliteHomeLink }],
                },
              },
              // Startup still migrates this pre-instance key into the default Codex instance.
              providers: { codex: { homePath: sharedHome, shadowHomePath: legacyShadow } },
            }),
          );
          yield* fileSystem.writeFileString(
            path.join(sharedHome, "memories_v2_1.sqlite"),
            "shared",
          );
          for (const shadow of [managedShadow, workShadow, linkShadow, legacyShadow]) {
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
            ...[
              ["codex_link", linkShadow],
              ["codex", legacyShadow],
            ].map(([instanceId, shadow]) => ({
              instanceId,
              shadowHomePath: shadow,
              status: "auto-settle",
              conflicts: [
                {
                  entryName: "memories_v2_1.sqlite",
                  path: path.join(shadow!, "memories_v2_1.sqlite"),
                  autoSettle: true,
                },
              ],
            })),
          ]);
          expect(yield* listing()).toEqual(before);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "is not ready for a shared auth.json or a home path held in a secret",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const stateDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-state-" });
          const sharedHome = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3code-codex-shared-",
          });
          const authShadow = path.join(stateDir, "auth-shadow");
          yield* fileSystem.writeFileString(path.join(sharedHome, "auth.json"), "{}");
          yield* fileSystem.makeDirectory(authShadow, { recursive: true });
          yield* fileSystem.symlink(
            path.join(sharedHome, "auth.json"),
            path.join(authShadow, "auth.json"),
          );
          yield* fileSystem.writeFileString(
            path.join(stateDir, "settings.json"),
            JSON.stringify({
              providerInstances: {
                codex_auth: {
                  driver: "codex",
                  config: { homePath: sharedHome, shadowHomePath: authShadow },
                },
                codex_secret: {
                  driver: "codex",
                  config: { homePath: sharedHome, shadowHomePath: path.join(stateDir, "s") },
                  environment: [
                    {
                      name: "CODEX_SQLITE_HOME",
                      value: "",
                      secret: { provider: "vault", reference: "codex/sqlite-home" },
                    },
                  ],
                },
              },
            }),
          );

          const report = yield* inspectConfiguredCodexShadowHomes(stateDir);

          expect(report.status).toBe("not-ready");
          expect(
            report.instances.map(({ instanceId, status, conflicts }) => ({
              instanceId,
              status,
              entries: conflicts.map((conflict) => conflict.entryName),
            })),
          ).toEqual([
            { instanceId: "codex_auth", status: "not-ready", entries: ["auth.json"] },
            { instanceId: "codex_secret", status: "unknown", entries: [] },
          ]);
        }),
    );

    it.effect("is not ready when settings.json exists but cannot be read", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-state-" });
        yield* fileSystem.makeDirectory(path.join(stateDir, "settings.json"));

        const report = yield* inspectConfiguredCodexShadowHomes(stateDir);

        expect(report.status).toBe("not-ready");
        expect(report.instances.map((instance) => instance.status)).toEqual(["unknown"]);
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
