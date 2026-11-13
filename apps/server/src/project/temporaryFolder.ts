// @effect-diagnostics nodeBuiltinImport:off - probes the filesystem with node:fs/promises.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

const TEMPORARY_PREFIXES = [
  "/tmp",
  "/var/tmp",
  "/dev/shm",
  // macOS resolves /tmp and /var/tmp here, and keeps per-user temp folders in /var/folders.
  "/private/tmp",
  "/private/var/tmp",
  "/private/var/folders",
];
// Per-user runtime directory, except its network and document mounts, which persist.
const USER_RUNTIME_DIRECTORY = /^\/run\/user\/\d+(?:\/|$)/;
const PERSISTENT_MOUNTS = /^\/run\/user\/\d+\/(?:gvfs|doc)(?:\/|$)|^\/run\/media\//;
const LINUX_TMPFS_MAGIC = 0x01021994;
/** A dead network mount can hang a filesystem call, so the answer falls back after this. */
const PROBE_TIMEOUT = Duration.millis(500);

/** `~` and relative paths expanded and `..` removed, without touching the filesystem. */
function lexicalPath(path: string): string {
  const expanded =
    path === "~" || path.startsWith("~/") ? NodePath.join(NodeOS.homedir(), path.slice(1)) : path;
  return NodePath.resolve(expanded);
}

function underTemporaryName(path: string): boolean {
  return (
    !PERSISTENT_MOUNTS.test(path) &&
    (TEMPORARY_PREFIXES.some((root) => path === root || path.startsWith(`${root}/`)) ||
      USER_RUNTIME_DIRECTORY.test(path))
  );
}

/** By name only, for callers that cannot wait on the filesystem. */
export function isTemporaryPath(path: string): boolean {
  return underTemporaryName(lexicalPath(path));
}

export interface FolderProbe {
  /** The path with symlinks resolved, and whether its filesystem is a tmpfs. */
  readonly inspect: (
    path: string,
  ) => Promise<{ readonly resolved: string; readonly tmpfs: boolean }>;
}

const exists = (path: string) =>
  NodeFSP.access(path).then(
    () => true,
    () => false,
  );

const nodeProbe: FolderProbe = {
  inspect: async (path) => {
    // A missing folder is the usual case here, so inspect its nearest existing ancestor.
    let existing = path;
    while (!(await exists(existing)) && NodePath.dirname(existing) !== existing) {
      existing = NodePath.dirname(existing);
    }
    try {
      const real = await NodeFSP.realpath(existing);
      return {
        resolved: NodePath.join(real, NodePath.relative(existing, path)),
        tmpfs: (await NodeFSP.statfs(real)).type === LINUX_TMPFS_MAGIC,
      };
    } catch {
      return { resolved: path, tmpfs: false };
    }
  },
};

/**
 * A folder the system clears at reboot: a tmpfs, or under a well-known temporary directory.
 * `TMPDIR` is not trusted by itself. A path under a network or document mount is never
 * temporary, and is not probed. A probe that outlasts the timeout leaves the name check.
 */
export const isTemporaryFolder = Effect.fn("isTemporaryFolder")(function* (
  path: string,
  probe: FolderProbe = nodeProbe,
) {
  const lexical = lexicalPath(path);
  if (PERSISTENT_MOUNTS.test(lexical)) return false;
  const byName = underTemporaryName(lexical);
  const inspected = yield* Effect.tryPromise({
    try: () => probe.inspect(lexical),
    catch: (cause) => cause,
  }).pipe(
    Effect.timeoutOption(PROBE_TIMEOUT),
    Effect.orElseSucceed(() => Option.none()),
  );
  if (Option.isNone(inspected)) return byName;
  const { resolved, tmpfs } = inspected.value;
  return !PERSISTENT_MOUNTS.test(resolved) && (underTemporaryName(resolved) || tmpfs);
});

export const temporaryFolderWarning = Effect.fn("temporaryFolderWarning")(function* (
  path: string,
  probe?: FolderProbe,
) {
  return (yield* isTemporaryFolder(path, probe))
    ? `${path} is under a temporary folder, which the system clears at reboot; the project's threads then fail to start. Use a folder that persists.`
    : undefined;
});
