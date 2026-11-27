import { assert, it } from "@effect/vitest";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The test verifies the guard-compatible host file protocol.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The test creates and removes its isolated runtime directory.
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ServerConfig from "./config.ts";
import * as ServiceChangeAdmission from "./serviceChangeAdmission.ts";

it.effect("drains admitted commands before refusing work behind the snapshot fence", () => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-snapshot-admission-"));
  const root = NodePath.join(baseDir, "runtime", "service-change-admission");
  const active = NodePath.join(root, "active");
  const fence = NodePath.join(root, "snapshot-fence.json");
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

    NodeFS.writeFileSync(fence, JSON.stringify({ protocolVersion: 1, ownerPid: process.pid }), {
      mode: 0o600,
    });
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

    NodeFS.writeFileSync(fence, JSON.stringify({ protocolVersion: 2, ownerPid: 2_000_000_000 }), {
      mode: 0o600,
    });
    const incompatible = yield* Effect.exit(ServiceChangeAdmission.withAdmission(Effect.void));
    assert.isTrue(Exit.isFailure(incompatible));
    assert.isTrue(NodeFS.existsSync(fence));

    NodeFS.writeFileSync(fence, JSON.stringify({ protocolVersion: 1, ownerPid: 2_000_000_000 }), {
      mode: 0o600,
    });
    yield* ServiceChangeAdmission.withAdmission(Effect.void);
    assert.isFalse(NodeFS.existsSync(fence));
  }).pipe(
    Effect.provide(testLayer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true }))),
  );
});
