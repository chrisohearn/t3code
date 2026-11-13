import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { CodexSettings } from "@t3tools/contracts";
import {
  CodexShadowHomeEntryConflictError,
  CodexShadowHomePathConflictError,
  inspectCodexShadowHome,
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
  withCodexSqliteHome,
} from "./CodexHomeLayout.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
const decodeCodexSettingsValue = Schema.decodeSync(CodexSettings);

const decodeCodexSettings = (input: {
  readonly enabled?: boolean;
  readonly homePath?: string;
  readonly shadowHomePath?: string;
  readonly customModels?: readonly string[];
  readonly binaryPath?: string;
}): CodexSettings => decodeCodexSettingsValue(input);

const noSqliteHome = { sqliteHome: undefined };

const makeTempDir = Effect.fn("CodexHomeLayout.test.makeTempDir")(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix });
});

const writeTextFile = Effect.fn("CodexHomeLayout.test.writeTextFile")(function* (
  filePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fileSystem.writeFileString(filePath, contents);
});

it.layer(NodeServices.layer)("CodexHomeLayout", (it) => {
  describe("resolveCodexHomeLayout", () => {
    it.effect("uses the shared home for continuation and the shadow home for runtime", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
        const shadowHome = path.join(shadowRoot, "shadow");

        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({
            homePath: sharedHome,
            shadowHomePath: shadowHome,
          }),
        );

        expect(layout).toMatchObject({
          mode: "authOverlay",
          sharedHomePath: sharedHome,
          effectiveHomePath: shadowHome,
          continuationKey: `codex:home:${sharedHome}`,
        });
      }),
    );
  });

  describe("withCodexSqliteHome", () => {
    it.effect("points only auth overlay homes at the shared SQLite home", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const sharedHome = path.resolve("codex-shared");
        const overlay = yield* resolveCodexHomeLayout(
          decodeCodexSettings({
            homePath: sharedHome,
            shadowHomePath: path.resolve("codex-shadow"),
          }),
        );
        const direct = yield* resolveCodexHomeLayout(decodeCodexSettings({ homePath: sharedHome }));

        expect(withCodexSqliteHome(overlay, { PATH: "bin" })).toEqual({
          PATH: "bin",
          CODEX_SQLITE_HOME: sharedHome,
        });
        expect(withCodexSqliteHome(overlay, { CODEX_SQLITE_HOME: "custom" })).toEqual({
          CODEX_SQLITE_HOME: "custom",
        });
        expect(withCodexSqliteHome(direct, { PATH: "bin" })).toEqual({ PATH: "bin" });
      }),
    );
  });

  describe("materializeCodexShadowHome", () => {
    it.effect.skipIf(!symlinksSupported)(
      "keeps Finder metadata local across repeated shadow home setup",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowHome = yield* makeTempDir("t3code-codex-shadow-");
          const sharedMetadata = path.join(sharedHome, ".DS_Store");
          const shadowMetadata = path.join(shadowHome, ".DS_Store");

          yield* writeTextFile(sharedMetadata, "shared Finder metadata");
          yield* writeTextFile(shadowMetadata, "shadow Finder metadata");
          yield* writeTextFile(path.join(shadowHome, "auth.json"), '{"shadow":true}\n');
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );

          yield* materializeCodexShadowHome(layout, noSqliteHome);
          expect(yield* fileSystem.readFileString(shadowMetadata)).toBe("shadow Finder metadata");
          yield* fileSystem.remove(shadowMetadata);
          yield* materializeCodexShadowHome(layout, noSqliteHome);
          expect(yield* fileSystem.exists(shadowMetadata)).toBe(false);

          yield* writeTextFile(shadowMetadata, "shadow Finder metadata");
          yield* materializeCodexShadowHome(layout, noSqliteHome);
          yield* materializeCodexShadowHome(layout, noSqliteHome);

          expect(yield* fileSystem.readFileString(sharedMetadata)).toBe("shared Finder metadata");
          expect(yield* fileSystem.readFileString(shadowMetadata)).toBe("shadow Finder metadata");
          expect(yield* fileSystem.readFileString(path.join(shadowHome, "auth.json"))).toBe(
            '{"shadow":true}\n',
          );
          expect(yield* fileSystem.readLink(path.join(shadowHome, "sessions"))).toBe(
            path.join(sharedHome, "sessions"),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "materializes a shadow home with shared state links and private auth",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");

          yield* fileSystem.makeDirectory(path.join(sharedHome, "sessions"));
          yield* writeTextFile(path.join(sharedHome, "config.toml"), 'model = "gpt-5-codex"\n');
          yield* writeTextFile(
            path.join(sharedHome, "models_cache.json"),
            '{"models":["shared"]}\n',
          );
          yield* writeTextFile(path.join(sharedHome, "auth.json"), '{"shared":true}\n');
          yield* writeTextFile(path.join(sharedHome, "auth.lock"), "");
          yield* fileSystem.makeDirectory(shadowHome, { recursive: true });
          yield* writeTextFile(path.join(shadowHome, "auth.json"), '{"shadow":true}\n');
          yield* writeTextFile(path.join(shadowHome, "auth.lock"), "");
          yield* fileSystem.symlink(
            path.join(sharedHome, "models_cache.json"),
            path.join(shadowHome, "models_cache.json"),
          );

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          yield* materializeCodexShadowHome(layout, noSqliteHome);

          const sessionsTarget = yield* fileSystem.readLink(path.join(shadowHome, "sessions"));
          const configTarget = yield* fileSystem.readLink(path.join(shadowHome, "config.toml"));
          const mcpOauthLocksTarget = yield* fileSystem.readLink(
            path.join(shadowHome, "mcp-oauth-locks"),
          );
          const modelsCacheExists = yield* fileSystem.exists(
            path.join(shadowHome, "models_cache.json"),
          );
          const authLinkResult = yield* fileSystem
            .readLink(path.join(shadowHome, "auth.json"))
            .pipe(Effect.result);
          const authContents = yield* fileSystem.readFileString(path.join(shadowHome, "auth.json"));
          const authLockLinkResult = yield* fileSystem
            .readLink(path.join(shadowHome, "auth.lock"))
            .pipe(Effect.result);

          expect(sessionsTarget).toBe(path.join(sharedHome, "sessions"));
          expect(configTarget).toBe(path.join(sharedHome, "config.toml"));
          expect(mcpOauthLocksTarget).toBe(path.join(sharedHome, "mcp-oauth-locks"));
          expect(modelsCacheExists).toBe(false);
          expect(authLinkResult._tag).toBe("Failure");
          expect(authContents).toContain("shadow");
          expect(authLockLinkResult._tag).toBe("Failure");
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "replaces a Codex-created local sqlite maintenance lock with the shared lock",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          const sharedLock = path.join(sharedHome, ".sqlite-maintenance.lock");
          const shadowLock = path.join(shadowHome, ".sqlite-maintenance.lock");

          yield* writeTextFile(sharedLock, "");
          yield* writeTextFile(shadowLock, "");

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          yield* materializeCodexShadowHome(layout, noSqliteHome);

          expect(yield* fileSystem.readLink(shadowLock)).toBe(sharedLock);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "links SQLite databases but settles shadow sidecars instead of linking them",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          for (const name of ["state_5.sqlite", "state_5.sqlite-wal", "state_5.sqlite-shm"]) {
            yield* writeTextFile(path.join(sharedHome, name), "shared");
          }
          for (const name of ["logs_2.sqlite", "goals_1.sqlite"]) {
            yield* writeTextFile(path.join(sharedHome, name), "shared");
          }
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );
          yield* materializeCodexShadowHome(layout, noSqliteHome);

          // Windows SQLite leaves these beside the symlinked database (#79).
          yield* writeTextFile(path.join(shadowHome, "state_5.sqlite-wal"), "");
          yield* writeTextFile(path.join(shadowHome, "state_5.sqlite-shm"), "index");
          yield* writeTextFile(path.join(shadowHome, "logs_2.sqlite-wal"), "frames");
          yield* writeTextFile(path.join(shadowHome, "logs_2.sqlite-shm"), "index");
          yield* fileSystem.symlink(
            path.join(sharedHome, "goals_1.sqlite-wal"),
            path.join(shadowHome, "goals_1.sqlite-wal"),
          );
          yield* materializeCodexShadowHome(layout, noSqliteHome);

          for (const name of ["state_5.sqlite", "logs_2.sqlite"]) {
            expect(yield* fileSystem.readLink(path.join(shadowHome, name))).toBe(
              path.join(sharedHome, name),
            );
          }
          const shadowEntries = yield* fileSystem.readDirectory(shadowHome);
          expect(shadowEntries.filter((name) => /-(?:wal|shm|journal)$/.test(name))).toEqual([]);
          const staleEntries = shadowEntries.filter((name) => name.includes(".stale-")).toSorted();
          expect(staleEntries.map((name) => name.replace(/\.stale-\d+$/, ""))).toEqual([
            "logs_2.sqlite-shm",
            "logs_2.sqlite-wal",
          ]);
          const staleWal = staleEntries.find((name) => name.startsWith("logs_2.sqlite-wal"))!;
          expect(yield* fileSystem.readFileString(path.join(shadowHome, staleWal))).toBe("frames");
          expect(
            yield* fileSystem.readFileString(path.join(sharedHome, "state_5.sqlite-wal")),
          ).toBe("shared");
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "keeps a link to another home while SQLite files sit beside it",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const otherHome = yield* makeTempDir("t3code-codex-other-");
          const shadowHome = path.join(shadowRoot, "shadow");
          // Goals_1 differs only in case, so it is the same entry where names ignore case.
          const databases = ["state_5.sqlite", "logs_2.sqlite", "Goals_1.sqlite", "jobs_1.sqlite"];
          for (const name of databases) {
            yield* writeTextFile(path.join(sharedHome, name), "shared");
          }
          yield* fileSystem.makeDirectory(shadowHome, { recursive: true });
          for (const name of [
            "state_5.sqlite",
            "logs_2.sqlite",
            "goals_1.sqlite",
            "jobs_1.sqlite",
          ]) {
            yield* fileSystem.symlink(path.join(otherHome, name), path.join(shadowHome, name));
          }
          for (const name of ["logs_2.sqlite-wal", "goals_1.sqlite-wal"]) {
            yield* writeTextFile(path.join(shadowHome, name), "frames");
          }
          // An older build linked sidecars too; this one's target is gone.
          yield* fileSystem.symlink(
            path.join(otherHome, "jobs_1.sqlite-wal"),
            path.join(shadowHome, "jobs_1.sqlite-wal"),
          );

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );
          yield* materializeCodexShadowHome(layout, noSqliteHome);

          expect(yield* fileSystem.readLink(path.join(shadowHome, "state_5.sqlite"))).toBe(
            path.join(sharedHome, "state_5.sqlite"),
          );
          expect(yield* fileSystem.readLink(path.join(shadowHome, "jobs_1.sqlite"))).toBe(
            path.join(otherHome, "jobs_1.sqlite"),
          );
          for (const name of ["logs_2.sqlite", "goals_1.sqlite"]) {
            expect(yield* fileSystem.readLink(path.join(shadowHome, name))).toBe(
              path.join(otherHome, name),
            );
            expect(yield* fileSystem.readFileString(path.join(shadowHome, `${name}-wal`))).toBe(
              "frames",
            );
          }
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "leaves sidecars alone beside a shadow's own database or a link it cannot re-point",
      () => {
        const warnings: unknown[] = [];
        const logger = Logger.make(({ message, logLevel }) => {
          if (logLevel === "Warn") warnings.push(message);
        });
        return Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          const ownFiles = ["queue_1.sqlite", "queue_1.sqlite-wal", "queue_1.sqlite-shm"];
          for (const name of ownFiles) {
            yield* writeTextFile(path.join(shadowHome, name), `live ${name}`);
          }
          // The shared home has no jobs_1.sqlite, so nothing re-points this link.
          const otherHome = yield* makeTempDir("t3code-codex-other-");
          const foreignTarget = path.join(otherHome, "jobs_1.sqlite");
          yield* fileSystem.symlink(foreignTarget, path.join(shadowHome, "jobs_1.sqlite"));
          yield* writeTextFile(path.join(shadowHome, "jobs_1.sqlite-wal"), "frames");

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );
          yield* materializeCodexShadowHome(layout, noSqliteHome);

          for (const name of ownFiles) {
            expect(yield* fileSystem.readFileString(path.join(shadowHome, name))).toBe(
              `live ${name}`,
            );
          }
          expect(yield* fileSystem.readLink(path.join(shadowHome, "jobs_1.sqlite"))).toBe(
            foreignTarget,
          );
          expect(yield* fileSystem.readFileString(path.join(shadowHome, "jobs_1.sqlite-wal"))).toBe(
            "frames",
          );
          const message =
            "Left SQLite files alone in a Codex shadow home because its database is not the shared one.";
          expect(warnings).toHaveLength(2);
          for (const database of ["queue_1.sqlite", "jobs_1.sqlite"]) {
            expect(warnings).toContainEqual([message, { path: path.join(shadowHome, database) }]);
          }
        }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
      },
    );

    it.effect.skipIf(!symlinksSupported)(
      "replaces Codex-created local MCP OAuth locks with the shared lock directory",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          const sharedLocks = path.join(sharedHome, "mcp-oauth-locks");
          const shadowLocks = path.join(shadowHome, "mcp-oauth-locks");

          yield* writeTextFile(path.join(sharedLocks, "file-store.lock"), "");
          yield* writeTextFile(path.join(shadowLocks, "file-store.lock"), "");

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          yield* materializeCodexShadowHome(layout, noSqliteHome);

          const locksTarget = yield* fileSystem.readLink(shadowLocks);
          const sharedLockExists = yield* fileSystem.exists(
            path.join(sharedLocks, "file-store.lock"),
          );

          expect(locksTarget).toBe(sharedLocks);
          expect(sharedLockExists).toBe(true);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "shares local thread writer locks once no writer still holds one",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          const shadowLocks = path.join(shadowHome, "thread-writer-locks");
          const threadLock = path.join(shadowLocks, "019a0000-0000-7000-8000-000000000000.lock");

          yield* writeTextFile(path.join(shadowLocks, ".coordination.lock"), "");
          yield* writeTextFile(path.join(shadowLocks, ".DS_Store"), "");
          yield* writeTextFile(threadLock, "");

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          yield* materializeCodexShadowHome(layout, noSqliteHome);
          expect(yield* fileSystem.exists(threadLock)).toBe(true);

          yield* fileSystem.remove(threadLock);
          yield* materializeCodexShadowHome(layout, noSqliteHome);
          expect(yield* fileSystem.readLink(shadowLocks)).toBe(
            path.join(sharedHome, "thread-writer-locks"),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "accepts Codex-created shadow-local runtime directories",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");

          yield* fileSystem.makeDirectory(path.join(sharedHome, "log"));
          yield* fileSystem.makeDirectory(path.join(sharedHome, "memories"));
          yield* fileSystem.makeDirectory(path.join(sharedHome, "tmp"));
          yield* writeTextFile(path.join(sharedHome, "config.toml"), 'model = "gpt-5-codex"\n');
          yield* writeTextFile(path.join(shadowHome, "auth.json"), '{"shadow":true}\n');
          yield* fileSystem.makeDirectory(path.join(shadowHome, "log"), { recursive: true });
          yield* fileSystem.makeDirectory(path.join(shadowHome, "memories"), { recursive: true });
          yield* fileSystem.makeDirectory(path.join(shadowHome, "tmp"), { recursive: true });

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          yield* materializeCodexShadowHome(layout, noSqliteHome);

          const configTarget = yield* fileSystem.readLink(path.join(shadowHome, "config.toml"));
          const logLinkResult = yield* fileSystem
            .readLink(path.join(shadowHome, "log"))
            .pipe(Effect.result);
          const memoriesLinkResult = yield* fileSystem
            .readLink(path.join(shadowHome, "memories"))
            .pipe(Effect.result);
          const tmpLinkResult = yield* fileSystem
            .readLink(path.join(shadowHome, "tmp"))
            .pipe(Effect.result);

          expect(configTarget).toBe(path.join(sharedHome, "config.toml"));
          expect(logLinkResult._tag).toBe("Failure");
          expect(memoriesLinkResult._tag).toBe("Failure");
          expect(tmpLinkResult._tag).toBe("Failure");
        }),
    );

    it.effect("rejects shadow homes that point at the shared home", () =>
      Effect.gen(function* () {
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({
            homePath: sharedHome,
            shadowHomePath: sharedHome,
          }),
        );

        const error = yield* materializeCodexShadowHome(layout, noSqliteHome).pipe(Effect.flip);

        expect(error).toBeInstanceOf(CodexShadowHomePathConflictError);
        expect(error).toMatchObject({
          sharedHomePath: sharedHome,
          effectiveHomePath: sharedHome,
        });
        expect(error.message).toBe(
          `Codex shadow home path '${sharedHome}' must be different from the shared home path '${sharedHome}'.`,
        );
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "rejects shared entries that already exist in the shadow home as real files",
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          yield* writeTextFile(path.join(sharedHome, "config.toml"), 'model = "gpt-5-codex"\n');
          yield* writeTextFile(path.join(shadowHome, "config.toml"), 'model = "local"\n');

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          const error = yield* materializeCodexShadowHome(layout, noSqliteHome).pipe(Effect.flip);

          expect(error).toBeInstanceOf(CodexShadowHomeEntryConflictError);
          expect(error).toMatchObject({
            sharedHomePath: sharedHome,
            effectiveHomePath: shadowHome,
            entryName: "config.toml",
            linkPath: path.join(shadowHome, "config.toml"),
            targetPath: path.join(sharedHome, "config.toml"),
          });
          expect(error.message).toBe(
            `Cannot create Codex shadow home entry 'config.toml' because '${path.join(shadowHome, "config.toml")}' already exists and is not a symlink.`,
          );
        }),
    );

    // Codex wrote memories_v2_1.sqlite into the shadow before CODEX_SQLITE_HOME, and the
    // shared home gained its own copy later; the next setup failed every session.
    const ownDatabaseFiles = [
      "memories_v2_1.sqlite",
      "memories_v2_1.sqlite-wal",
      "memories_v2_1.sqlite-shm",
    ];
    const prepareOwnDatabaseShadow = Effect.fn("CodexHomeLayout.test.prepareOwnDatabaseShadow")(
      function* () {
        const path = yield* Path.Path;
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
        const shadowHome = path.join(shadowRoot, "shadow");
        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
        );
        yield* materializeCodexShadowHome(layout, { sqliteHome: sharedHome });
        for (const name of ownDatabaseFiles) {
          yield* writeTextFile(path.join(shadowHome, name), `own ${name}`);
        }
        yield* materializeCodexShadowHome(layout, { sqliteHome: sharedHome });
        yield* writeTextFile(path.join(sharedHome, "memories_v2_1.sqlite"), "shared");
        const backup = path.join(shadowRoot, "shadow-conflict-backup-19700101T000000Z");
        return { sharedHome, shadowHome, layout, backup };
      },
    );

    it.effect.skipIf(!symlinksSupported)(
      "moves a shadow's own database aside once the shared home has the same database",
      () => {
        const warnings: unknown[] = [];
        const logger = Logger.make(({ message, logLevel }) => {
          if (logLevel === "Warn") warnings.push(message);
        });
        return Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { sharedHome, shadowHome, layout, backup } = yield* prepareOwnDatabaseShadow();

          yield* materializeCodexShadowHome(layout, { sqliteHome: sharedHome });

          expect(yield* fileSystem.readLink(path.join(shadowHome, "memories_v2_1.sqlite"))).toBe(
            path.join(sharedHome, "memories_v2_1.sqlite"),
          );
          for (const name of ownDatabaseFiles) {
            expect(yield* fileSystem.readFileString(path.join(backup, name))).toBe(`own ${name}`);
          }
          const shadowEntries = yield* fileSystem.readDirectory(shadowHome);
          expect(shadowEntries.filter((name) => name.startsWith("memories_v2_1.sqlite-"))).toEqual(
            [],
          );
          const moved = warnings.filter(
            (message) =>
              Array.isArray(message) && String(message[0]).startsWith("Moved a Codex shadow home"),
          );
          expect(moved).toEqual([
            [
              "Moved a Codex shadow home's own SQLite database aside so the shadow can share the home's database.",
              { files: ownDatabaseFiles, backup },
            ],
          ]);
        }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
      },
    );

    it.effect.skipIf(!symlinksSupported)(
      "refuses to move a shadow's own database when Codex would not open the shared one",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { shadowHome, layout, backup } = yield* prepareOwnDatabaseShadow();

          const error = yield* materializeCodexShadowHome(layout, noSqliteHome).pipe(Effect.flip);

          assert.instanceOf(error, CodexShadowHomeEntryConflictError);
          const conflict = error;
          expect(conflict.entryName).toBe("memories_v2_1.sqlite");
          expect(conflict.strandedBackupPath).toBeUndefined();
          for (const fragment of [
            backup,
            ...ownDatabaseFiles.map((name) => path.join(shadowHome, name)),
          ]) {
            expect(conflict.backupCommand).toContain(fragment);
          }
          expect(conflict.message).toContain(conflict.backupCommand!);
          for (const name of ownDatabaseFiles) {
            expect(yield* fileSystem.readFileString(path.join(shadowHome, name))).toBe(
              `own ${name}`,
            );
          }
          expect(yield* fileSystem.exists(backup)).toBe(false);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "puts a shadow's own database back when one of its files cannot be moved",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { sharedHome, shadowHome, layout, backup } = yield* prepareOwnDatabaseShadow();
          // An entry already at the destination stands in for a file Windows keeps open.
          yield* writeTextFile(path.join(backup, "memories_v2_1.sqlite-wal", "held"), "");

          const error = yield* materializeCodexShadowHome(layout, { sqliteHome: sharedHome }).pipe(
            Effect.flip,
          );

          assert.instanceOf(error, CodexShadowHomeEntryConflictError);
          expect(error.strandedBackupPath).toBeUndefined();
          for (const name of ownDatabaseFiles) {
            expect(yield* fileSystem.readFileString(path.join(shadowHome, name))).toBe(
              `own ${name}`,
            );
          }
          expect(yield* fileSystem.exists(path.join(backup, "memories_v2_1.sqlite"))).toBe(false);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "refuses before moving a shadow's own database when another entry blocks setup",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { sharedHome, shadowHome, layout, backup } = yield* prepareOwnDatabaseShadow();
          yield* writeTextFile(path.join(sharedHome, "config.toml"), "shared");
          yield* writeTextFile(path.join(shadowHome, "config.toml"), "local");

          const error = yield* materializeCodexShadowHome(layout, { sqliteHome: sharedHome }).pipe(
            Effect.flip,
          );

          assert.instanceOf(error, CodexShadowHomeEntryConflictError);
          expect(error.entryName).toBe("config.toml");
          for (const name of ownDatabaseFiles) {
            expect(yield* fileSystem.readFileString(path.join(shadowHome, name))).toBe(
              `own ${name}`,
            );
          }
          expect(yield* fileSystem.exists(backup)).toBe(false);
        }),
    );

    it.effect("reports a thread-writer-locks entry that setup cannot list", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
        const shadowHome = path.join(shadowRoot, "shadow");
        yield* writeTextFile(path.join(shadowHome, "thread-writer-locks"), "not a directory");
        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
        );

        const conflicts = yield* inspectCodexShadowHome(layout, noSqliteHome);

        expect(conflicts.map((conflict) => conflict.entryName)).toEqual(["thread-writer-locks"]);
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "puts every database back when a later one cannot be moved",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { sharedHome, shadowHome, layout, backup } = yield* prepareOwnDatabaseShadow();
          yield* writeTextFile(path.join(sharedHome, "goals_1.sqlite"), "shared");
          yield* writeTextFile(path.join(shadowHome, "goals_1.sqlite"), "own goals_1.sqlite");
          const order = yield* inspectCodexShadowHome(layout, { sqliteHome: sharedHome });
          // Block the database that moves last, so an earlier one has already moved.
          const last = order.at(-1)!.entryName;
          yield* writeTextFile(path.join(backup, last, "held"), "");

          const error = yield* materializeCodexShadowHome(layout, { sqliteHome: sharedHome }).pipe(
            Effect.flip,
          );

          assert.instanceOf(error, CodexShadowHomeEntryConflictError);
          for (const name of [...ownDatabaseFiles, "goals_1.sqlite"]) {
            expect(yield* fileSystem.readFileString(path.join(shadowHome, name))).toBe(
              `own ${name}`,
            );
          }
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "refuses a shadow path that resolves to the shared home",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const aliasRoot = yield* makeTempDir("t3code-codex-alias-");
          const aliasShadow = path.join(aliasRoot, "shadow");
          yield* fileSystem.symlink(sharedHome, aliasShadow);
          yield* writeTextFile(path.join(sharedHome, "memories_v2_1.sqlite"), "shared");
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: aliasShadow }),
          );

          const error = yield* materializeCodexShadowHome(layout, {
            sqliteHome: sharedHome,
          }).pipe(Effect.flip);

          expect(error).toBeInstanceOf(CodexShadowHomePathConflictError);
          expect(
            yield* fileSystem.readFileString(path.join(sharedHome, "memories_v2_1.sqlite")),
          ).toBe("shared");
        }),
    );

    // Windows ignores the mode, and root writes regardless of it.
    it.effect.skipIf(
      !symlinksSupported ||
        HostProcess.Platform.defaultValue() === "win32" ||
        process.getuid?.() === 0,
    )(
      "refuses to move a shadow's own database when the shadow or the backup's parent is read-only",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          for (const pick of [path.dirname, (shadow: string) => shadow]) {
            const { sharedHome, shadowHome, layout, backup } = yield* prepareOwnDatabaseShadow();
            const readOnly = pick(shadowHome);
            yield* fileSystem.chmod(readOnly, 0o555);

            const error = yield* materializeCodexShadowHome(layout, {
              sqliteHome: sharedHome,
            }).pipe(
              Effect.flip,
              Effect.ensuring(fileSystem.chmod(readOnly, 0o755).pipe(Effect.orDie)),
            );

            assert.instanceOf(error, CodexShadowHomeEntryConflictError);
            expect(error.backupCommand).toContain(backup);
            for (const name of ownDatabaseFiles) {
              expect(yield* fileSystem.readFileString(path.join(shadowHome, name))).toBe(
                `own ${name}`,
              );
            }
          }
        }),
    );
  });
});
