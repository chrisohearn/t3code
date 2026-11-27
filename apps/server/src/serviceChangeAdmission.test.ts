import { assert, it, vi } from "@effect/vitest";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The test verifies the guard-compatible host file protocol.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The test creates and removes its isolated runtime directory.
import * as NodePath from "node:path";
import * as Deferred from "effect/Deferred";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ServerConfig from "./config.ts";
import * as ServiceChangeAdmission from "./serviceChangeAdmission.ts";

const linuxProcessIncarnation = (pid: number) => {
  if (!NodeFS.existsSync("/proc/sys/kernel/random/boot_id")) return undefined;
  const ownerBootId = NodeFS.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
  const commandEnd = stat.lastIndexOf(")");
  assert.isAtLeast(commandEnd, 0);
  const fields = stat
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/);
  const ownerStartTicks = fields[19];
  assert.isDefined(ownerStartTicks);
  return { ownerBootId, ownerStartTicks };
};

it.effect("drains admitted commands before refusing work behind the snapshot fence", () => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-snapshot-admission-"));
  const root = NodePath.join(baseDir, "runtime", "service-change-admission");
  const active = NodePath.join(root, "active");
  const fence = NodePath.join(root, "snapshot-fence.json");
  const processIncarnation = linuxProcessIncarnation(process.pid);
  const testLayer = ServerConfig.ServerConfig.layerTest(baseDir, baseDir).pipe(
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.gen(function* () {
    yield* ServiceChangeAdmission.initialize(baseDir);
    const capability = JSON.parse(
      NodeFS.readFileSync(NodePath.join(root, "capability.json"), "utf8"),
    ) as {
      protocolVersion: number;
      pid: number;
    };
    assert.equal(capability.protocolVersion, 1);
    assert.equal(capability.pid, process.pid);

    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const admitted = ServiceChangeAdmission.withAdmission(
      Effect.gen(function* () {
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(release);
      }),
    );
    const fiber = yield* admitted.pipe(Effect.forkScoped({ startImmediately: true }));
    yield* Deferred.await(entered);
    assert.equal(NodeFS.readdirSync(active).length, 1);

    NodeFS.writeFileSync(
      fence,
      JSON.stringify(
        processIncarnation === undefined
          ? { protocolVersion: 1, ownerPid: process.pid }
          : { protocolVersion: 2, ownerPid: process.pid, ...processIncarnation },
      ),
      { mode: 0o600 },
    );
    let fencedEffectRan = false;
    const fenced = yield* Effect.exit(
      ServiceChangeAdmission.withAdmission(
        Effect.sync(() => {
          fencedEffectRan = true;
        }),
      ),
    );
    assert.isTrue(Exit.isFailure(fenced));
    assert.isFalse(fencedEffectRan);
    assert.equal(NodeFS.readdirSync(active).length, 1);

    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(fiber);
    assert.equal(NodeFS.readdirSync(active).length, 0);

    NodeFS.writeFileSync(fence, JSON.stringify({ protocolVersion: 1, ownerPid: 2_000_000_000 }), {
      mode: 0o600,
    });
    const incompatible = yield* Effect.exit(ServiceChangeAdmission.withAdmission(Effect.void));
    assert.isTrue(Exit.isFailure(incompatible));
    assert.isTrue(NodeFS.existsSync(fence));

    if (processIncarnation !== undefined) {
      NodeFS.writeFileSync(
        fence,
        JSON.stringify({
          protocolVersion: 2,
          ownerPid: process.pid,
          ...processIncarnation,
          ownerStartTicks: "0",
        }),
        { mode: 0o600 },
      );
      yield* ServiceChangeAdmission.withAdmission(Effect.void);
      assert.isFalse(NodeFS.existsSync(fence));

      NodeFS.writeFileSync(
        fence,
        JSON.stringify({
          protocolVersion: 2,
          ownerPid: 2_000_000_000,
          ...processIncarnation,
        }),
        { mode: 0o600 },
      );
      yield* ServiceChangeAdmission.withAdmission(Effect.void);
      assert.isFalse(NodeFS.existsSync(fence));

      NodeFS.writeFileSync(
        fence,
        JSON.stringify({
          protocolVersion: 2,
          ownerPid: process.pid,
          ...processIncarnation,
          ownerBootId: "00000000-0000-0000-0000-000000000000",
        }),
        { mode: 0o600 },
      );
      yield* ServiceChangeAdmission.withAdmission(Effect.void);
      assert.isFalse(NodeFS.existsSync(fence));
    }
  }).pipe(
    Effect.provide(testLayer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true }))),
  );
});

it.effect("serializes concurrent local admission file creation", () => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-snapshot-admission-"));
  const active = NodePath.join(baseDir, "runtime", "service-change-admission", "active");

  return Effect.gen(function* () {
    yield* ServiceChangeAdmission.initialize(baseDir);
    const admissions = yield* Effect.all(
      Array.from({ length: 16 }, () =>
        ServiceChangeAdmission.withAdmissionAt(baseDir, Effect.void),
      ),
      { concurrency: "unbounded" },
    );
    assert.lengthOf(admissions, 16);
    assert.isEmpty(NodeFS.readdirSync(active));
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true }))),
  );
});

it.effect("keeps admission active until forked preparation exits", () => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-snapshot-admission-"));
  const active = NodePath.join(baseDir, "runtime", "service-change-admission", "active");

  return Effect.gen(function* () {
    yield* ServiceChangeAdmission.initialize(baseDir);
    const scope = yield* Scope.make("sequential");
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const child = yield* ServiceChangeAdmission.withAdmissionAt(
      baseDir,
      ServiceChangeAdmission.forkInWithAdmissionAt(
        baseDir,
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
        }),
        scope,
      ),
    );

    yield* Deferred.await(entered);
    assert.lengthOf(NodeFS.readdirSync(active), 1);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(child);
    assert.isEmpty(NodeFS.readdirSync(active));
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true }))),
  );
});

it.effect("retries pending admission-token cleanup on the next admission", () => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-snapshot-admission-"));
  const active = NodePath.join(baseDir, "runtime", "service-change-admission", "active");
  const originalUnlink = NodeFS.promises.unlink.bind(NodeFS.promises);
  let tokenUnlinksToFail = 2;
  vi.spyOn(NodeFS.promises, "unlink").mockImplementation((filePath) => {
    if (NodePath.dirname(String(filePath)) === active && tokenUnlinksToFail > 0) {
      tokenUnlinksToFail -= 1;
      return Promise.reject(Object.assign(new Error("transient unlink failure"), { code: "EIO" }));
    }
    return originalUnlink(filePath);
  });

  return Effect.gen(function* () {
    yield* ServiceChangeAdmission.initialize(baseDir);
    const first = yield* Effect.exit(ServiceChangeAdmission.withAdmissionAt(baseDir, Effect.void));
    assert.isTrue(Exit.isFailure(first));
    assert.lengthOf(NodeFS.readdirSync(active), 1);

    yield* ServiceChangeAdmission.withAdmissionAt(baseDir, Effect.void);
    assert.isEmpty(NodeFS.readdirSync(active));
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        vi.restoreAllMocks();
        NodeFS.rmSync(baseDir, { recursive: true, force: true });
      }),
    ),
  );
});

it.effect("reports mutex cleanup failure and reclaims the stale local mutex", () => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-snapshot-admission-"));
  const mutex = NodePath.join(baseDir, "runtime", "service-change-admission", "mutex");
  const mutexOwner = NodePath.join(mutex, "owner");
  const originalUnlink = NodeFS.promises.unlink.bind(NodeFS.promises);
  let ownerUnlinksToFail = 2;
  vi.spyOn(NodeFS.promises, "unlink").mockImplementation((filePath) => {
    if (String(filePath) === mutexOwner && ownerUnlinksToFail > 0) {
      ownerUnlinksToFail -= 1;
      return Promise.reject(
        Object.assign(new Error("transient mutex cleanup failure"), { code: "EIO" }),
      );
    }
    return originalUnlink(filePath);
  });

  return Effect.gen(function* () {
    yield* ServiceChangeAdmission.initialize(baseDir);
    const first = yield* Effect.exit(ServiceChangeAdmission.withAdmissionAt(baseDir, Effect.void));
    assert.isTrue(Exit.isFailure(first));
    assert.isTrue(NodeFS.existsSync(mutexOwner));

    yield* ServiceChangeAdmission.withAdmissionAt(baseDir, Effect.void);
    assert.isFalse(NodeFS.existsSync(mutex));
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        vi.restoreAllMocks();
        NodeFS.rmSync(baseDir, { recursive: true, force: true });
      }),
    ),
  );
});
