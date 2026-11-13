// @effect-diagnostics nodeBuiltinImport:off - builds a symlink fixture with node:fs.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  dedupeProbe,
  isTemporaryFolder,
  isTemporaryPath,
  temporaryFolderWarning,
} from "./temporaryFolder.ts";

it.effect.each([
  ["/tmp/review", true],
  ["/var/tmp/review", true],
  ["/dev/shm/work", true],
  ["/run/user/1000/work", true],
  ["/private/tmp/review", true],
  ["/tmp/../home/user/app", false],
  ["/home/user/app", false],
  ["/tmpfoo/app", false],
  ["/run/media/user/disk/app", false],
  ["/run/user/1000/gvfs/sftp:host=nas/app", false],
  ["/run/user/1000/doc/by-app/app", false],
] as const)("%s is temporary: %s", ([path, temporary]) =>
  Effect.gen(function* () {
    assert.equal(yield* isTemporaryFolder(path), temporary);
    assert.equal((yield* temporaryFolderWarning(path)) !== undefined, temporary);
    assert.equal(isTemporaryPath(path), temporary);
  }),
);

it.effect("never probes the filesystem under a network or document mount", () =>
  Effect.gen(function* () {
    const probed: string[] = [];
    const probe = {
      inspect: (path: string) => {
        probed.push(path);
        return Promise.resolve({ resolved: path, tmpfs: true });
      },
    };
    assert.isFalse(yield* isTemporaryFolder("/run/user/1000/gvfs/smb-share/x", probe));
    assert.deepEqual(probed, []);
  }),
);

it.effect("falls back to the name when the filesystem does not answer in time", () =>
  Effect.gen(function* () {
    const hung = { inspect: () => new Promise<never>(() => {}) };
    const byName = (path: string) =>
      Effect.forkChild(isTemporaryFolder(path, hung)).pipe(
        Effect.tap(() => TestClock.adjust("500 millis")),
        Effect.flatMap(Fiber.join),
      );
    assert.isTrue(yield* byName("/tmp/review"));
    assert.isFalse(yield* byName("/home/user/app"));
  }),
);

it.effect("resolves symlinks, and ignores a persistent TMPDIR", () =>
  Effect.gen(function* () {
    const sandbox = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "temporary-folder-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(sandbox, { recursive: true, force: true })),
    );
    const link = NodePath.join(sandbox, "link");
    NodeFS.symlinkSync(process.cwd(), link);
    // Under /tmp by name, but it leads to a folder that is not temporary.
    assert.isFalse(yield* isTemporaryFolder(NodePath.join(link, "missing")));
    assert.isTrue(yield* isTemporaryFolder(NodePath.join(sandbox, "missing")));
  }).pipe(Effect.scoped),
);

it("sends a retry to the name while a probe is unanswered, and reuses a settled answer until it expires", async () => {
  let clock = 0;
  let calls = 0;
  const answers = [new Promise<never>(() => {})];
  const probe = dedupeProbe(
    {
      inspect: (path) => {
        calls += 1;
        return answers.shift() ?? Promise.resolve({ resolved: path, tmpfs: false });
      },
    },
    () => clock,
    1_000,
  );
  // The first probe never settles, as on a dead mount: later calls get no answer, not another probe.
  void probe.inspect("/mnt/dead/a");
  expect(await probe.inspect("/mnt/dead/a")).toBeUndefined();
  expect(await probe.inspect("/mnt/dead/a")).toBeUndefined();
  expect(calls).toBe(1);
  // Another path probes on its own, and its answer is reused until the TTL passes.
  expect(await probe.inspect("/home/a")).toEqual({ resolved: "/home/a", tmpfs: false });
  await probe.inspect("/home/a");
  expect(calls).toBe(2);
  clock = 1_001;
  await probe.inspect("/home/a");
  expect(calls).toBe(3);
});

it("keeps an unanswered probe when many other paths fill the result cache", async () => {
  let calls = 0;
  const probe = dedupeProbe({
    inspect: (path) => {
      calls += 1;
      return path === "/mnt/dead" ? new Promise<never>(() => {}) : Promise.resolve(undefined);
    },
  });
  void probe.inspect("/mnt/dead");
  for (let index = 0; index < 300; index += 1) await probe.inspect(`/home/p${index}`);
  expect(await probe.inspect("/mnt/dead")).toBeUndefined();
  expect(calls).toBe(301);
});
