import { ProviderDriverKind, type CodexSettings } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as PlatformError from "effect/PlatformError";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";

export interface CodexHomeLayout {
  readonly mode: "direct" | "authOverlay";
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string | undefined;
  readonly continuationKey: string;
}

const KNOWN_SHARED_DIRECTORIES = [
  "sessions",
  "archived_sessions",
  "sqlite",
  "shell_snapshots",
  "worktrees",
  "skills",
  "plugins",
  "cache",
  "logs",
  "mcp-oauth-locks",
  "thread-writer-locks",
] as const;

// auth.lock guards the shadow home's private auth.json.
const PRIVATE_ENTRY_NAMES = new Set(["auth.json", "auth.lock", "models_cache.json"]);
// Finder maintains metadata separately for each directory, including shadow homes.
const SHADOW_LOCAL_ENTRY_NAMES = new Set(["log", "memories", "tmp", ".DS_Store"]);
// Shadow homes may create local runtime locks first; replace them with shared links because they guard shared state.
const REPLACEABLE_SHARED_RUNTIME_ENTRIES = new Set([
  "mcp-oauth-locks",
  "thread-writer-locks",
  ".sqlite-maintenance.lock",
]);

// Windows SQLite names -wal/-shm beside a symlinked database rather than its target,
// which gave each shadow home a private WAL for a shared database (#79).
const SQLITE_SIDECAR_PATTERN = /^(.+\.sqlite)-(?:wal|shm|journal)$/;
const SQLITE_DATABASE_PATTERN = /\.sqlite$/i;
const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

/** Points an auth overlay's SQLite databases at the shared home so they keep one WAL. */
export function withCodexSqliteHome(
  layout: CodexHomeLayout,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (layout.mode !== "authOverlay" || environment.CODEX_SQLITE_HOME?.trim()) return environment;
  return { ...environment, CODEX_SQLITE_HOME: layout.sharedHomePath };
}

function resolveHomePath(path: Path.Path, home: string, value: string | undefined): string {
  const expanded =
    value && value.trim().length > 0 ? expandHomePath(value, home) : path.join(home, ".codex");
  return path.resolve(expanded);
}

export const resolveCodexHomeLayout = Effect.fn("resolveCodexHomeLayout")(function* (
  config: CodexSettings,
): Effect.fn.Return<CodexHomeLayout, never, Path.Path> {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const sharedHomePath = resolveHomePath(path, home, config.homePath);
  const shadowHomePath = config.shadowHomePath.trim();
  if (shadowHomePath.length === 0) {
    return {
      mode: "direct",
      sharedHomePath,
      effectiveHomePath: config.homePath.trim().length > 0 ? sharedHomePath : undefined,
      continuationKey: `codex:home:${sharedHomePath}`,
    };
  }

  const effectiveHomePath = path.resolve(expandHomePath(shadowHomePath, home));
  return {
    mode: "authOverlay",
    sharedHomePath,
    effectiveHomePath,
    continuationKey: `codex:home:${sharedHomePath}`,
  };
});

const CodexShadowHomeContext = {
  sharedHomePath: Schema.String,
  effectiveHomePath: Schema.String,
};

export class CodexShadowHomeFileSystemError extends Schema.TaggedError<CodexShadowHomeFileSystemError>()(
  "CodexShadowHomeFileSystemError",
  {
    ...CodexShadowHomeContext,
    operation: Schema.Literals(["readLink", "makeDirectory", "readDirectory", "remove", "symlink"]),
    path: Schema.String,
    targetPath: Schema.optional(Schema.String),
    entryName: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const target = this.targetPath === undefined ? "" : ` to '${this.targetPath}'`;
    return `Codex shadow home filesystem operation '${this.operation}' failed for '${this.path}'${target}.`;
  }
}

export class CodexShadowHomePathConflictError extends Schema.TaggedError<CodexShadowHomePathConflictError>()(
  "CodexShadowHomePathConflictError",
  CodexShadowHomeContext,
) {
  override get message(): string {
    return `Codex shadow home path '${this.effectiveHomePath}' must be different from the shared home path '${this.sharedHomePath}'.`;
  }
}

export class CodexShadowHomeEntryConflictError extends Schema.TaggedError<CodexShadowHomeEntryConflictError>()(
  "CodexShadowHomeEntryConflictError",
  {
    ...CodexShadowHomeContext,
    entryName: Schema.String,
    linkPath: Schema.String,
    targetPath: Schema.String,
    backupCommand: Schema.optional(Schema.String),
    strandedBackupPath: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    const base = `Cannot create Codex shadow home entry '${this.entryName}' because '${this.linkPath}' already exists and is not a symlink.`;
    const stranded =
      this.strandedBackupPath === undefined
        ? ""
        : ` Some of its files were moved to '${this.strandedBackupPath}' and could not be moved back.`;
    const command =
      this.backupCommand === undefined
        ? ""
        : ` Stop Codex for this instance, then move the shadow's own database and its SQLite files aside: ${this.backupCommand}`;
    return `${base}${stranded}${command}`;
  }
}

export class CodexShadowHomePrivateEntrySymlinkError extends Schema.TaggedError<CodexShadowHomePrivateEntrySymlinkError>()(
  "CodexShadowHomePrivateEntrySymlinkError",
  {
    ...CodexShadowHomeContext,
    entryName: Schema.String,
    path: Schema.String,
  },
) {
  override get message(): string {
    return `Codex shadow home private entry '${this.entryName}' at '${this.path}' must be a real file, not a symlink.`;
  }
}

export const CodexShadowHomeError = Schema.Union([
  CodexShadowHomeFileSystemError,
  CodexShadowHomePathConflictError,
  CodexShadowHomeEntryConflictError,
  CodexShadowHomePrivateEntrySymlinkError,
]);
export type CodexShadowHomeError = typeof CodexShadowHomeError.Type;

type LinkState =
  | {
      readonly _tag: "Missing";
    }
  | {
      readonly _tag: "NotSymlink";
    }
  | {
      readonly _tag: "Symlink";
      readonly target: string;
    };

function isNotSymlinkError(error: PlatformError.PlatformError): boolean {
  const cause = error.reason.cause;
  return (
    error.reason._tag === "Unknown" &&
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "EINVAL"
  );
}

const readLinkState = Effect.fn("CodexHomeLayout.readLinkState")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
  readonly entryName: string;
  readonly linkPath: string;
}): Effect.fn.Return<LinkState, CodexShadowHomeError> {
  return yield* input.fileSystem.readLink(input.linkPath).pipe(
    Effect.map((target): LinkState => ({ _tag: "Symlink", target })),
    Effect.catchTags({
      PlatformError: (cause) => {
        if (cause.reason._tag === "NotFound") {
          return Effect.succeed<LinkState>({ _tag: "Missing" });
        }
        if (isNotSymlinkError(cause)) {
          return Effect.succeed<LinkState>({ _tag: "NotSymlink" });
        }
        return new CodexShadowHomeFileSystemError({
          sharedHomePath: input.sharedHomePath,
          effectiveHomePath: input.effectiveHomePath,
          operation: "readLink",
          path: input.linkPath,
          entryName: input.entryName,
          cause,
        });
      },
    }),
  );
});

const removePrivateSymlink = Effect.fn("CodexHomeLayout.removePrivateSymlink")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
  readonly entryName: string;
}): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const privatePath = path.join(input.effectiveHomePath, input.entryName);
  const state = yield* readLinkState({
    ...input,
    linkPath: privatePath,
  });
  if (state._tag === "Symlink") {
    yield* input.fileSystem.remove(privatePath).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new CodexShadowHomeFileSystemError({
            sharedHomePath: input.sharedHomePath,
            effectiveHomePath: input.effectiveHomePath,
            operation: "remove",
            path: privatePath,
            entryName: input.entryName,
            cause,
          }),
      }),
    );
  }
});

const ensureSymlink = Effect.fn("CodexHomeLayout.ensureSymlink")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
  readonly entryName: string;
}): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const target = path.join(input.sharedHomePath, input.entryName);
  const link = path.join(input.effectiveHomePath, input.entryName);
  const state = yield* readLinkState({
    ...input,
    linkPath: link,
  });

  const createLink = input.fileSystem.symlink(target, link).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        new CodexShadowHomeFileSystemError({
          sharedHomePath: input.sharedHomePath,
          effectiveHomePath: input.effectiveHomePath,
          operation: "symlink",
          path: link,
          targetPath: target,
          entryName: input.entryName,
          cause,
        }),
    }),
  );

  if (state._tag === "NotSymlink") {
    if (!REPLACEABLE_SHARED_RUNTIME_ENTRIES.has(input.entryName)) {
      return yield* new CodexShadowHomeEntryConflictError({
        sharedHomePath: input.sharedHomePath,
        effectiveHomePath: input.effectiveHomePath,
        entryName: input.entryName,
        linkPath: link,
        targetPath: target,
      });
    }

    if (input.entryName === "thread-writer-locks") {
      const lockNames = yield* input.fileSystem.readDirectory(link).pipe(
        Effect.catchTags({
          PlatformError: (cause) =>
            new CodexShadowHomeFileSystemError({
              sharedHomePath: input.sharedHomePath,
              effectiveHomePath: input.effectiveHomePath,
              operation: "readDirectory",
              path: link,
              entryName: input.entryName,
              cause,
            }),
        }),
      );
      // Codex deletes a thread lock on release, so one that is left may still guard a live
      // writer. Keep the local directory until a later setup finds none.
      if (lockNames.some((name) => name.endsWith(".lock") && name !== ".coordination.lock")) {
        return yield* Effect.logWarning(
          "Codex shadow home still has thread writer locks; it will share them on a later setup.",
          { path: link },
        );
      }
    }

    yield* input.fileSystem.remove(link, { recursive: true }).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new CodexShadowHomeFileSystemError({
            sharedHomePath: input.sharedHomePath,
            effectiveHomePath: input.effectiveHomePath,
            operation: "remove",
            path: link,
            entryName: input.entryName,
            cause,
          }),
      }),
    );
    return yield* createLink;
  }

  if (state._tag === "Missing") {
    return yield* createLink;
  }

  const resolvedExisting = path.resolve(path.dirname(link), state.target);
  if (resolvedExisting !== target) {
    // The filesystem's own lookup applies its case rules; a dangling sidecar link still counts.
    const sidecarStates = SQLITE_DATABASE_PATTERN.test(input.entryName)
      ? yield* Effect.forEach(SQLITE_SIDECAR_SUFFIXES, (suffix) =>
          readLinkState({ ...input, linkPath: `${link}${suffix}` }),
        )
      : [];
    const sidecarsRemain = sidecarStates.some((sidecar) => sidecar._tag !== "Missing");
    if (sidecarsRemain) {
      return yield* Effect.logWarning(
        "Kept a Codex shadow home database link pointing at another home because SQLite files beside it belong to that database.",
        { path: link },
      );
    }
    yield* input.fileSystem.remove(link).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new CodexShadowHomeFileSystemError({
            sharedHomePath: input.sharedHomePath,
            effectiveHomePath: input.effectiveHomePath,
            operation: "remove",
            path: link,
            entryName: input.entryName,
            cause,
          }),
      }),
    );
    yield* createLink;
  }
});

// Codex now opens its databases in the shared home, so sidecars of a shared database are
// leftovers. Empty ones go; any holding WAL or journal data is moved aside, never deleted.
const settleShadowSqliteSidecars = Effect.fn("CodexHomeLayout.settleShadowSqliteSidecars")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly sharedHomePath: string;
    readonly effectiveHomePath: string;
  }): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
    const path = yield* Path.Path;
    // A Codex process from before this fix may still hold the file open on Windows.
    const warnUnsettled = (sidecarPath: string) => (cause: PlatformError.PlatformError) =>
      Effect.logWarning("Could not settle a leftover SQLite file in a Codex shadow home.", {
        path: sidecarPath,
        cause,
      });
    const shadowEntryNames = yield* input.fileSystem.readDirectory(input.effectiveHomePath).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new CodexShadowHomeFileSystemError({
            sharedHomePath: input.sharedHomePath,
            effectiveHomePath: input.effectiveHomePath,
            operation: "readDirectory",
            path: input.effectiveHomePath,
            cause,
          }),
      }),
    );
    const sidecarsByDatabase = new Map<string, Array<string>>();
    for (const entryName of shadowEntryNames) {
      const database = SQLITE_SIDECAR_PATTERN.exec(entryName)?.[1];
      if (database === undefined) continue;
      sidecarsByDatabase.set(database, [...(sidecarsByDatabase.get(database) ?? []), entryName]);
    }

    for (const [database, sidecarNames] of sidecarsByDatabase) {
      // A shadow's own database (say, from an older Codex) may be open; its sidecars are live.
      // Beside a link to another home they belong to that database; ensureSymlink keeps both.
      const databasePath = path.join(input.effectiveHomePath, database);
      const databaseState = yield* readLinkState({
        ...input,
        entryName: database,
        linkPath: databasePath,
      });
      const sharesDatabase =
        databaseState._tag === "Missing" ||
        (databaseState._tag === "Symlink" &&
          path.resolve(input.effectiveHomePath, databaseState.target) ===
            path.join(input.sharedHomePath, database));
      if (!sharesDatabase) {
        yield* Effect.logWarning(
          "Left SQLite files alone in a Codex shadow home because its database is not the shared one.",
          { path: databasePath },
        );
        continue;
      }
      const regularSidecars: Array<{ readonly name: string; readonly size: bigint }> = [];
      for (const entryName of sidecarNames) {
        const sidecarPath = path.join(input.effectiveHomePath, entryName);
        const state = yield* readLinkState({ ...input, entryName, linkPath: sidecarPath });
        if (state._tag === "Symlink") {
          yield* input.fileSystem
            .remove(sidecarPath)
            .pipe(Effect.catchTags({ PlatformError: warnUnsettled(sidecarPath) }));
        } else if (state._tag === "NotSymlink") {
          const info = yield* input.fileSystem.stat(sidecarPath).pipe(Effect.option);
          if (Option.isSome(info)) regularSidecars.push({ name: entryName, size: info.value.size });
        }
      }
      if (regularSidecars.length === 0) continue;

      // -shm only indexes the WAL, so the group holds data only through -wal or -journal.
      const holdsData = regularSidecars.some(
        (sidecar) => !sidecar.name.endsWith("-shm") && sidecar.size > 0n,
      );
      const suffix = `.stale-${yield* Clock.currentTimeMillis}`;
      for (const sidecar of regularSidecars) {
        const sidecarPath = path.join(input.effectiveHomePath, sidecar.name);
        const settle = holdsData
          ? input.fileSystem.rename(sidecarPath, `${sidecarPath}${suffix}`)
          : input.fileSystem.remove(sidecarPath);
        yield* settle.pipe(Effect.catchTags({ PlatformError: warnUnsettled(sidecarPath) }));
      }
      if (holdsData) {
        yield* Effect.logWarning(
          "Moved SQLite WAL data left in a Codex shadow home aside; it was not applied to the shared database.",
          { files: regularSidecars.map((sidecar) => `${sidecar.name}${suffix}`) },
        );
      }
    }
  },
);

const ensureShadowAuthIsPrivate = Effect.fn("CodexHomeLayout.ensureShadowAuthIsPrivate")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly sharedHomePath: string;
    readonly effectiveHomePath: string;
  }): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
    const path = yield* Path.Path;
    const entryName = "auth.json";
    const authPath = path.join(input.effectiveHomePath, entryName);
    const state = yield* readLinkState({
      ...input,
      entryName,
      linkPath: authPath,
    });
    if (state._tag === "Symlink") {
      return yield* new CodexShadowHomePrivateEntrySymlinkError({
        sharedHomePath: input.sharedHomePath,
        effectiveHomePath: input.effectiveHomePath,
        entryName,
        path: authPath,
      });
    }
  },
);

function shadowLinkEntryNames(sharedEntryNames: ReadonlyArray<string>): ReadonlySet<string> {
  const entries = new Set<string>(KNOWN_SHARED_DIRECTORIES);
  for (const entryName of sharedEntryNames) {
    if (
      !PRIVATE_ENTRY_NAMES.has(entryName) &&
      !SHADOW_LOCAL_ENTRY_NAMES.has(entryName) &&
      !SQLITE_SIDECAR_PATTERN.test(entryName)
    ) {
      entries.add(entryName);
    }
  }
  return entries;
}

/** A regular file or directory in a shadow home where materializing would place a shared link. */
export interface CodexShadowHomeConflict {
  readonly entryName: string;
  readonly path: string;
  /** The shadow's own SQLite database and its sidecars, which must move together. */
  readonly sqliteFiles: ReadonlyArray<string> | undefined;
  /** Materializing moves it aside because Codex opens its databases in the shared home. */
  readonly autoSettle: boolean;
}

// Real paths see through symlinked parents, and on Windows the native call returns the stored case.
const pathIdentity = (fileSystem: FileSystem.FileSystem, path: Path.Path, value: string) =>
  fileSystem.realPath(value).pipe(Effect.orElseSucceed(() => path.resolve(value)));

const sameDirectory = Effect.fnUntraced(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  left: string,
  right: string,
) {
  return (
    (yield* pathIdentity(fileSystem, path, left)) === (yield* pathIdentity(fileSystem, path, right))
  );
});

// A sibling backup needs a writable parent on the shadow's filesystem, or rename cannot reach it.
const backupParentAccepts = Effect.fnUntraced(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  effectiveHomePath: string,
) {
  const parent = path.dirname(effectiveHomePath);
  const [shadowInfo, parentInfo, writable] = yield* Effect.all([
    fileSystem.stat(effectiveHomePath).pipe(Effect.option),
    fileSystem.stat(parent).pipe(Effect.option),
    fileSystem.access(parent, { writable: true }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    ),
  ]);
  return (
    writable &&
    Option.isSome(shadowInfo) &&
    Option.isSome(parentInfo) &&
    shadowInfo.value.dev === parentInfo.value.dev
  );
});

/** Read-only: what materializing this shadow home would have to move aside or refuse. */
export const inspectCodexShadowHome = Effect.fn("inspectCodexShadowHome")(function* (
  layout: CodexHomeLayout,
  options: { readonly sqliteHome: string | undefined },
): Effect.fn.Return<
  ReadonlyArray<CodexShadowHomeConflict>,
  CodexShadowHomeError,
  FileSystem.FileSystem | Path.Path
> {
  const effectiveHomePath = layout.effectiveHomePath;
  if (layout.mode !== "authOverlay" || !effectiveHomePath) return [];
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // A shadow that resolves to the shared home would have its shared databases moved aside.
  if (yield* sameDirectory(fileSystem, path, effectiveHomePath, layout.sharedHomePath)) {
    return yield* new CodexShadowHomePathConflictError({
      sharedHomePath: layout.sharedHomePath,
      effectiveHomePath,
    });
  }
  const context = { fileSystem, sharedHomePath: layout.sharedHomePath, effectiveHomePath };
  const sharedEntryNames = yield* fileSystem.readDirectory(layout.sharedHomePath).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed<ReadonlyArray<string>>([])
          : new CodexShadowHomeFileSystemError({
              ...context,
              operation: "readDirectory",
              path: layout.sharedHomePath,
              cause,
            }),
    }),
  );
  const autoSettle =
    options.sqliteHome !== undefined &&
    (yield* sameDirectory(fileSystem, path, options.sqliteHome, layout.sharedHomePath)) &&
    (yield* backupParentAccepts(fileSystem, path, effectiveHomePath));
  const conflicts: Array<CodexShadowHomeConflict> = [];
  // ensureShadowAuthIsPrivate refuses this one; nothing moves it aside.
  const authPath = path.join(effectiveHomePath, "auth.json");
  const authState = yield* readLinkState({
    ...context,
    entryName: "auth.json",
    linkPath: authPath,
  });
  if (authState._tag === "Symlink") {
    conflicts.push({
      entryName: "auth.json",
      path: authPath,
      sqliteFiles: undefined,
      autoSettle: false,
    });
  }
  for (const entryName of shadowLinkEntryNames(sharedEntryNames)) {
    if (PRIVATE_ENTRY_NAMES.has(entryName) || REPLACEABLE_SHARED_RUNTIME_ENTRIES.has(entryName)) {
      continue;
    }
    const entryPath = path.join(effectiveHomePath, entryName);
    const state = yield* readLinkState({ ...context, entryName, linkPath: entryPath });
    if (state._tag !== "NotSymlink") continue;
    if (!SQLITE_DATABASE_PATTERN.test(entryName)) {
      conflicts.push({ entryName, path: entryPath, sqliteFiles: undefined, autoSettle: false });
      continue;
    }
    const sqliteFiles = [entryName];
    for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
      const sidecar = `${entryName}${suffix}`;
      const sidecarState = yield* readLinkState({
        ...context,
        entryName: sidecar,
        linkPath: path.join(effectiveHomePath, sidecar),
      });
      if (sidecarState._tag !== "Missing") sqliteFiles.push(sidecar);
    }
    conflicts.push({ entryName, path: entryPath, sqliteFiles, autoSettle });
  }
  return conflicts;
});

function backupDirectoryFor(path: Path.Path, effectiveHomePath: string, millis: number): string {
  const stamp = DateTime.formatIso(DateTime.makeUnsafe(millis))
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "");
  return path.join(
    path.dirname(effectiveHomePath),
    `${path.basename(effectiveHomePath)}-conflict-backup-${stamp}`,
  );
}

function backupCommandFor(
  platform: NodeJS.Platform,
  directory: string,
  files: ReadonlyArray<string>,
): string {
  if (platform === "win32") {
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    return `New-Item -ItemType Directory -Force -Path ${quote(directory)} | Out-Null; Move-Item -LiteralPath ${files.map(quote).join(",")} -Destination ${quote(directory)}`;
  }
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return `mkdir -p ${quote(directory)} && mv ${files.map(quote).join(" ")} ${quote(directory)}/`;
}

// Moves a shadow's own database with its sidecars, all or nothing. Rename is the only
// operation, so a file Windows holds open or a backup on another filesystem refuses the move.
const moveShadowDatabaseAside = Effect.fn("CodexHomeLayout.moveShadowDatabaseAside")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly sharedHomePath: string;
    readonly effectiveHomePath: string;
    readonly conflict: CodexShadowHomeConflict & { readonly sqliteFiles: ReadonlyArray<string> };
    readonly backupDirectory: string;
  }): Effect.fn.Return<
    { readonly moved: true } | { readonly moved: false; readonly stranded: boolean },
    never,
    Path.Path
  > {
    const path = yield* Path.Path;
    const { fileSystem, conflict, backupDirectory } = input;
    const made = yield* fileSystem
      .makeDirectory(backupDirectory, { recursive: true })
      .pipe(Effect.exit);
    if (made._tag === "Failure") return { moved: false, stranded: false };
    const moved: Array<string> = [];
    for (const name of conflict.sqliteFiles) {
      const destination = path.join(backupDirectory, name);
      // Rename replaces an existing file, so never move onto an earlier backup.
      const destinationState = yield* readLinkState({
        ...input,
        entryName: name,
        linkPath: destination,
      }).pipe(Effect.option);
      const renamed =
        Option.isSome(destinationState) && destinationState.value._tag === "Missing"
          ? yield* fileSystem
              .rename(path.join(input.effectiveHomePath, name), destination)
              .pipe(Effect.exit)
          : undefined;
      if (renamed === undefined || renamed._tag === "Failure") {
        let stranded = false;
        for (const back of moved.toReversed()) {
          const restored = yield* fileSystem
            .rename(path.join(backupDirectory, back), path.join(input.effectiveHomePath, back))
            .pipe(Effect.exit);
          if (restored._tag === "Failure") stranded = true;
        }
        return { moved: false, stranded };
      }
      moved.push(name);
    }
    return { moved: true };
  },
);

// Shadow setup runs again for each session; concurrent runs must not split a database from its WAL.
const shadowHomeLock = Semaphore.makeUnsafe(1);

export const materializeCodexShadowHome = (
  layout: CodexHomeLayout,
  options: { readonly sqliteHome: string | undefined },
) => shadowHomeLock.withPermit(materializeCodexShadowHomeUnlocked(layout, options));

const materializeCodexShadowHomeUnlocked = Effect.fn("materializeCodexShadowHome")(function* (
  layout: CodexHomeLayout,
  options: { readonly sqliteHome: string | undefined },
) {
  if (layout.mode !== "authOverlay") return;
  const effectiveHomePath = layout.effectiveHomePath;
  if (!effectiveHomePath) return;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (
    layout.sharedHomePath === effectiveHomePath ||
    (yield* sameDirectory(fileSystem, path, effectiveHomePath, layout.sharedHomePath))
  ) {
    return yield* new CodexShadowHomePathConflictError({
      sharedHomePath: layout.sharedHomePath,
      effectiveHomePath,
    });
  }

  const makeDirectory = (directoryPath: string) =>
    fileSystem.makeDirectory(directoryPath, { recursive: true }).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new CodexShadowHomeFileSystemError({
            sharedHomePath: layout.sharedHomePath,
            effectiveHomePath,
            operation: "makeDirectory",
            path: directoryPath,
            cause,
          }),
      }),
    );

  yield* Effect.all(
    [
      makeDirectory(layout.sharedHomePath),
      makeDirectory(effectiveHomePath),
      ...KNOWN_SHARED_DIRECTORIES.map((directory) =>
        makeDirectory(path.join(layout.sharedHomePath, directory)),
      ),
    ],
    { concurrency: "unbounded" },
  );

  const sharedEntryNames = yield* fileSystem.readDirectory(layout.sharedHomePath).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        new CodexShadowHomeFileSystemError({
          sharedHomePath: layout.sharedHomePath,
          effectiveHomePath,
          operation: "readDirectory",
          path: layout.sharedHomePath,
          cause,
        }),
    }),
  );
  const entries = shadowLinkEntryNames(sharedEntryNames);

  yield* Effect.forEach(
    PRIVATE_ENTRY_NAMES,
    (entryName) =>
      entryName === "auth.json"
        ? Effect.void
        : removePrivateSymlink({
            fileSystem,
            sharedHomePath: layout.sharedHomePath,
            effectiveHomePath,
            entryName,
          }),
    { discard: true },
  );

  const conflicts = yield* inspectCodexShadowHome(layout, options);
  const platform = yield* HostProcess.Platform;
  const backupDirectory = backupDirectoryFor(
    path,
    effectiveHomePath,
    yield* Clock.currentTimeMillis,
  );
  for (const conflict of conflicts) {
    if (conflict.sqliteFiles === undefined) continue;
    const sqliteConflict = { ...conflict, sqliteFiles: conflict.sqliteFiles };
    const result = conflict.autoSettle
      ? yield* moveShadowDatabaseAside({
          fileSystem,
          sharedHomePath: layout.sharedHomePath,
          effectiveHomePath,
          conflict: sqliteConflict,
          backupDirectory,
        })
      : { moved: false as const, stranded: false };
    if (result.moved) {
      yield* Effect.logWarning(
        "Moved a Codex shadow home's own SQLite database aside so the shadow can share the home's database.",
        { files: conflict.sqliteFiles, backup: backupDirectory },
      );
      continue;
    }
    return yield* new CodexShadowHomeEntryConflictError({
      sharedHomePath: layout.sharedHomePath,
      effectiveHomePath,
      entryName: conflict.entryName,
      linkPath: conflict.path,
      targetPath: path.join(layout.sharedHomePath, conflict.entryName),
      backupCommand: backupCommandFor(
        platform,
        backupDirectory,
        conflict.sqliteFiles.map((name) => path.join(effectiveHomePath, name)),
      ),
      ...(result.stranded ? { strandedBackupPath: backupDirectory } : {}),
    });
  }

  yield* settleShadowSqliteSidecars({
    fileSystem,
    sharedHomePath: layout.sharedHomePath,
    effectiveHomePath,
  });

  yield* Effect.forEach(
    entries,
    (entryName) => {
      if (PRIVATE_ENTRY_NAMES.has(entryName)) {
        return Effect.void;
      }
      return ensureSymlink({
        fileSystem,
        sharedHomePath: layout.sharedHomePath,
        effectiveHomePath,
        entryName,
      });
    },
    { discard: true },
  );

  yield* ensureShadowAuthIsPrivate({
    fileSystem,
    sharedHomePath: layout.sharedHomePath,
    effectiveHomePath,
  });
});

export function codexContinuationIdentity(layout: CodexHomeLayout) {
  return {
    driverKind: ProviderDriverKind.make("codex"),
    continuationKey: layout.continuationKey,
  };
}
