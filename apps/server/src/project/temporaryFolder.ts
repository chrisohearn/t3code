import * as NodeOS from "node:os";

const TEMPORARY_ROOTS = ["/tmp", "/var/tmp", "/dev/shm", "/run"];

/** Folders the system clears at reboot (tmpfs, or a temp cleaner). */
export function isTemporaryFolder(path: string): boolean {
  return [NodeOS.tmpdir(), ...TEMPORARY_ROOTS].some((root) => path.startsWith(`${root}/`));
}

export function temporaryFolderWarning(path: string): string | undefined {
  return isTemporaryFolder(path)
    ? `${path} is under a temporary folder, which the system clears at reboot; the project's threads then fail to start. Use a folder that persists.`
    : undefined;
}
