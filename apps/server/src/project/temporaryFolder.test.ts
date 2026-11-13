// @effect-diagnostics nodeBuiltinImport:off - builds a symlink fixture with node:fs.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";

import { isTemporaryFolder, temporaryFolderWarning } from "./temporaryFolder.ts";

it.each([
  ["/tmp/review", true],
  ["/var/tmp/review", true],
  ["/dev/shm/work", true],
  ["/run/user/1000/work", true],
  ["/private/tmp/review", true],
  ["/tmp/../home/user/app", false],
  ["/home/user/app", false],
  ["/tmpfoo/app", false],
  ["/run/media/user/disk/app", false],
])("%s is temporary: %s", (path, temporary) => {
  expect(isTemporaryFolder(path)).toBe(temporary);
  expect(temporaryFolderWarning(path) !== undefined).toBe(temporary);
});

it("resolves symlinks and a persistent TMPDIR", () => {
  const sandbox = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "temporary-folder-"));
  try {
    const persistent = NodePath.join(NodeOS.homedir(), ".t3");
    const link = NodePath.join(sandbox, "link");
    NodeFS.symlinkSync(process.cwd(), link);
    // Under /tmp by name, but it leads to a folder that is not temporary.
    expect(isTemporaryFolder(NodePath.join(link, "missing"))).toBe(false);
    expect(isTemporaryFolder(NodePath.join(sandbox, "missing"))).toBe(true);
    // Relative paths resolve against the working directory, which is not temporary here.
    expect(isTemporaryFolder(NodePath.relative(process.cwd(), persistent))).toBe(
      isTemporaryFolder(persistent),
    );
  } finally {
    NodeFS.rmSync(sandbox, { recursive: true, force: true });
  }
});
