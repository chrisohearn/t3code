// @effect-diagnostics nodeBuiltinImport:off - a synchronous check that backs an error message getter.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const TEMPORARY_PREFIXES = [
  "/tmp",
  "/var/tmp",
  "/dev/shm",
  // macOS resolves /tmp and /var/tmp here, and keeps per-user temp folders in /var/folders.
  "/private/tmp",
  "/private/var/tmp",
  "/private/var/folders",
];
// Per-user runtime directory; /run/media (external drives) is persistent and must not match.
const USER_RUNTIME_DIRECTORY = /^\/run\/user\/\d+(?:\/|$)/;
// Removable drives mount here; a missing path under it must not inherit /run's tmpfs.
const REMOVABLE_MEDIA = "/run/media/";
const LINUX_TMPFS_MAGIC = 0x01021994;

/** The path as the filesystem sees it: `~` and relative paths expanded, `..` and symlinks resolved. */
function resolveExisting(path: string): string {
  const expanded =
    path === "~" || path.startsWith("~/") ? NodePath.join(NodeOS.homedir(), path.slice(1)) : path;
  const absolute = NodePath.resolve(expanded);
  // A missing folder is the usual case here, so resolve its nearest existing ancestor.
  let existing = absolute;
  while (!NodeFS.existsSync(existing) && NodePath.dirname(existing) !== existing) {
    existing = NodePath.dirname(existing);
  }
  try {
    return NodePath.join(NodeFS.realpathSync(existing), NodePath.relative(existing, absolute));
  } catch {
    return absolute;
  }
}

function onTmpfs(path: string): boolean {
  let existing = path;
  while (!NodeFS.existsSync(existing) && NodePath.dirname(existing) !== existing) {
    existing = NodePath.dirname(existing);
  }
  try {
    // Only Linux reports this magic number; elsewhere the prefixes decide.
    return NodeFS.statfsSync(existing).type === LINUX_TMPFS_MAGIC;
  } catch {
    return false;
  }
}

/**
 * A folder the system clears at reboot: a tmpfs, or under a well-known temporary directory.
 * `TMPDIR` is not trusted by itself; a persistent one is not temporary.
 */
export function isTemporaryFolder(path: string): boolean {
  const resolved = resolveExisting(path);
  if (resolved.startsWith(REMOVABLE_MEDIA)) return false;
  return (
    TEMPORARY_PREFIXES.some((root) => resolved === root || resolved.startsWith(`${root}/`)) ||
    USER_RUNTIME_DIRECTORY.test(resolved) ||
    onTmpfs(resolved)
  );
}

export function temporaryFolderWarning(path: string): string | undefined {
  return isTemporaryFolder(path)
    ? `${path} is under a temporary folder, which the system clears at reboot; the project's threads then fail to start. Use a folder that persists.`
    : undefined;
}
