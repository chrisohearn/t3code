import { expect, it } from "@effect/vitest";

import { isTemporaryFolder, temporaryFolderWarning } from "./temporaryFolder.ts";

it.each([
  ["/tmp/review", true],
  ["/var/tmp/review", true],
  ["/dev/shm/work", true],
  ["/home/user/app", false],
  ["/tmpfoo/app", false],
])("%s is temporary: %s", (path, temporary) => {
  expect(isTemporaryFolder(path)).toBe(temporary);
  expect(temporaryFolderWarning(path) !== undefined).toBe(temporary);
});
