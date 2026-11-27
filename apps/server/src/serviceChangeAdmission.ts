// @effect-diagnostics-next-line nodeBuiltinImport:off -- The host guard coordinates through these owner-only runtime files.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Admission files share the guard's cross-process fence.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Admission files share the guard's runtime path.
import * as NodePath from "node:path";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as ServerConfig from "./config.ts";

const PROTOCOL_VERSION = 1;
const FENCE_PROTOCOL_VERSION = 2;
const MUTEX_WAIT_MS = 5_000;

interface AdmissionLease {
  readonly tokenPath: string;
  references: number;
}

interface AdmissionPaths {
  readonly root: string;
  readonly mutex: string;
  readonly active: string;
  readonly fence: string;
  readonly capability: string;
}

const admissionPathsByBaseDir = new Map<string, AdmissionPaths>();
const admissionMutexesByBaseDir = new Map<string, Semaphore.Semaphore>();
const pendingAdmissionTokenCleanup = new Set<string>();

const admissionMutex = (baseDir: string) => {
  const cached = admissionMutexesByBaseDir.get(baseDir);
  if (cached !== undefined) return cached;
  const mutex = Semaphore.makeUnsafe(1);
  admissionMutexesByBaseDir.set(baseDir, mutex);
  return mutex;
};

export class ServiceChangeAdmissionError extends Schema.TaggedError<
  ServiceChangeAdmissionError,
  { readonly brand: unique symbol }
>()("ServiceChangeAdmissionError", {
  stage: Schema.Literals(["storage", "mutex", "fence"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.stage) {
      case "storage":
        return "Snapshot admission storage is unavailable; the command was not accepted.";
      case "mutex":
        return "The service-change admission mutex is unavailable; the command was not accepted.";
      case "fence":
        return "The guarded snapshot admission fence is closed; the command was not accepted.";
    }
  }
}

export const isServiceChangeAdmissionError = Schema.is(ServiceChangeAdmissionError);

const AdmissionCapabilityFile = Schema.fromJsonString(
  Schema.Struct({
    protocolVersion: Schema.Literal(PROTOCOL_VERSION),
    pid: Schema.Number,
    startedAt: Schema.String,
  }),
);
const encodeAdmissionCapability = Schema.encodeEffect(AdmissionCapabilityFile);

class AdmissionLeaseContext extends Context.Service<AdmissionLeaseContext, AdmissionLease>()(
  "t3/serviceChangeAdmission/AdmissionLeaseContext",
) {}

const admissionPaths = (baseDir: string): AdmissionPaths => {
  const cached = admissionPathsByBaseDir.get(baseDir);
  if (cached !== undefined) return cached;
  const root = NodePath.join(baseDir, "runtime", "service-change-admission");
  const paths = {
    root,
    mutex: NodePath.join(root, "mutex"),
    active: NodePath.join(root, "active"),
    fence: NodePath.join(root, "snapshot-fence.json"),
    capability: NodePath.join(root, "capability.json"),
  };
  admissionPathsByBaseDir.set(baseDir, paths);
  return paths;
};

const pidIsAlive = (pid: number) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EPERM";
  }
};

const linuxProcessStartTicks = async (pid: number): Promise<string> => {
  const stat = await NodeFS.promises.readFile(`/proc/${pid}/stat`, "utf8");
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) throw new Error("Snapshot fence owner process stat is invalid.");
  const fields = stat
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/);
  const startTicks = fields[19];
  if (startTicks === undefined || !/^[0-9]+$/.test(startTicks)) {
    throw new Error("Snapshot fence owner process start time is invalid.");
  }
  return startTicks;
};

const errorHasCode = (cause: unknown, code: string) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === code;

const unlinkWithRetry = async (filePath: string) => {
  let lastCause: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await NodeFS.promises.unlink(filePath);
      return;
    } catch (cause) {
      if (errorHasCode(cause, "ENOENT")) return;
      lastCause = cause;
    }
  }
  throw lastCause;
};

const rmdirWithRetry = async (directory: string) => {
  let lastCause: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await NodeFS.promises.rmdir(directory);
      return;
    } catch (cause) {
      if (errorHasCode(cause, "ENOENT")) return;
      lastCause = cause;
    }
  }
  throw lastCause;
};

const ensureDirectories = async (paths: AdmissionPaths) => {
  await NodeFS.promises.mkdir(paths.root, { recursive: true, mode: 0o700 });
  await NodeFS.promises.mkdir(paths.active, { recursive: true, mode: 0o700 });
  const root = await NodeFS.promises.lstat(paths.root);
  const active = await NodeFS.promises.lstat(paths.active);
  if (root.isSymbolicLink() || active.isSymbolicLink()) {
    throw new Error("Snapshot admission directories must not be symbolic links.");
  }
  await NodeFS.promises.chmod(paths.root, 0o700);
  await NodeFS.promises.chmod(paths.active, 0o700);
};

const releaseMutex = async (paths: AdmissionPaths) => {
  await unlinkWithRetry(NodePath.join(paths.mutex, "owner"));
  await rmdirWithRetry(paths.mutex);
};

const removeStaleMutex = async (paths: AdmissionPaths, now: number): Promise<boolean> => {
  const ownerPath = NodePath.join(paths.mutex, "owner");
  let stat: Awaited<ReturnType<typeof NodeFS.promises.lstat>>;
  try {
    stat = await NodeFS.promises.lstat(paths.mutex);
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") {
      return true;
    }
    throw cause;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Admission mutex is not a real directory.");
  let ownerPid: number | undefined;
  try {
    const ownerStat = await NodeFS.promises.lstat(ownerPath);
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || (ownerStat.mode & 0o777) !== 0o600) {
      throw new Error("Admission mutex owner is not a private regular file.");
    }
    const ownerText = (await NodeFS.promises.readFile(ownerPath, "utf8")).trim();
    if (!/^[1-9][0-9]*$/.test(ownerText)) throw new Error("Admission mutex owner PID is invalid.");
    ownerPid = Number(ownerText);
    if (!Number.isSafeInteger(ownerPid)) throw new Error("Admission mutex owner PID is invalid.");
  } catch (cause) {
    if (!errorHasCode(cause, "ENOENT")) throw cause;
    if (now - stat.mtimeMs <= 5_000) return false;
  }
  // This caller holds the process-local semaphore, so no other local operation
  // can still own a same-process mutex left behind by a failed finalizer.
  if (ownerPid === process.pid) {
    await releaseMutex(paths);
    return true;
  }
  if (ownerPid !== undefined && pidIsAlive(ownerPid)) return false;
  await releaseMutex(paths);
  return true;
};

type MutexAttempt =
  | { readonly tag: "acquired" }
  | { readonly tag: "busy" }
  | { readonly tag: "failed"; readonly cause: unknown };

const attemptAcquireMutex = async (paths: AdmissionPaths): Promise<MutexAttempt> => {
  try {
    await NodeFS.promises.mkdir(paths.mutex, { mode: 0o700 });
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EEXIST") {
      return { tag: "busy" };
    }
    return { tag: "failed", cause };
  }
  try {
    await NodeFS.promises.writeFile(NodePath.join(paths.mutex, "owner"), `${process.pid}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    return { tag: "acquired" };
  } catch (cause) {
    try {
      await NodeFS.promises.rmdir(paths.mutex);
    } catch {
      // Preserve the original failure and refuse admission.
    }
    return { tag: "failed", cause };
  }
};

const acquireMutex = Effect.fn("ServiceChangeAdmission.acquireMutex")(function* (
  paths: AdmissionPaths,
) {
  const deadline = (yield* Clock.currentTimeMillis) + MUTEX_WAIT_MS;
  while (true) {
    const attempt = yield* Effect.uninterruptible(
      Effect.tryPromise({
        try: () => attemptAcquireMutex(paths),
        catch: (cause) => new ServiceChangeAdmissionError({ stage: "mutex", cause }),
      }),
    );
    if (attempt.tag === "acquired") return;
    if (attempt.tag === "failed") {
      return yield* new ServiceChangeAdmissionError({ stage: "mutex", cause: attempt.cause });
    }

    const now = yield* Clock.currentTimeMillis;
    const staleMutexRemoved = yield* Effect.tryPromise({
      try: () => removeStaleMutex(paths, now),
      catch: (cause) => new ServiceChangeAdmissionError({ stage: "mutex", cause }),
    });
    if ((yield* Clock.currentTimeMillis) >= deadline) {
      return yield* new ServiceChangeAdmissionError({ stage: "mutex" });
    }
    if (!staleMutexRemoved) yield* Effect.sleep("10 millis");
  }
});

const withMutex = <A>(
  paths: AdmissionPaths,
  operation: () => Promise<A>,
): Effect.Effect<A, ServiceChangeAdmissionError> =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(acquireMutex(paths), () =>
        Effect.promise(() => releaseMutex(paths)),
      );
      return yield* Effect.uninterruptible(
        Effect.tryPromise({
          try: operation,
          catch: (cause) =>
            isServiceChangeAdmissionError(cause)
              ? cause
              : new ServiceChangeAdmissionError({ stage: "fence", cause }),
        }),
      );
    }),
  );

const removeStaleFence = async (paths: AdmissionPaths) => {
  let stat: Awaited<ReturnType<typeof NodeFS.promises.lstat>>;
  try {
    stat = await NodeFS.promises.lstat(paths.fence);
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT")
      return;
    throw cause;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
    throw new ServiceChangeAdmissionError({ stage: "fence" });
  }
  let ownerPid: number;
  let ownerBootId: string;
  let ownerStartTicks: string;
  try {
    const fence = JSON.parse(await NodeFS.promises.readFile(paths.fence, "utf8")) as {
      protocolVersion?: unknown;
      ownerPid?: unknown;
      ownerBootId?: unknown;
      ownerStartTicks?: unknown;
    };
    if (
      fence.protocolVersion !== FENCE_PROTOCOL_VERSION ||
      typeof fence.ownerPid !== "number" ||
      typeof fence.ownerBootId !== "string" ||
      !/^[a-f0-9-]{36}$/i.test(fence.ownerBootId) ||
      typeof fence.ownerStartTicks !== "string" ||
      !/^[0-9]+$/.test(fence.ownerStartTicks)
    ) {
      throw new Error("Snapshot admission fence protocol is invalid.");
    }
    ownerPid = fence.ownerPid;
    if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0)
      throw new Error("Snapshot fence owner PID is invalid.");
    ownerBootId = fence.ownerBootId;
    ownerStartTicks = fence.ownerStartTicks;
  } catch (cause) {
    throw new ServiceChangeAdmissionError({ stage: "fence", cause });
  }

  let currentBootId: string;
  try {
    currentBootId = (
      await NodeFS.promises.readFile("/proc/sys/kernel/random/boot_id", "utf8")
    ).trim();
    if (!/^[a-f0-9-]{36}$/i.test(currentBootId)) {
      throw new Error("Current Linux boot ID is invalid.");
    }
  } catch (cause) {
    throw new ServiceChangeAdmissionError({ stage: "fence", cause });
  }

  if (ownerBootId === currentBootId && pidIsAlive(ownerPid)) {
    let currentStartTicks: string;
    try {
      currentStartTicks = await linuxProcessStartTicks(ownerPid);
    } catch (cause) {
      if (!errorHasCode(cause, "ENOENT") || pidIsAlive(ownerPid)) {
        throw new ServiceChangeAdmissionError({ stage: "fence", cause });
      }
      currentStartTicks = "";
    }
    if (currentStartTicks === ownerStartTicks) {
      throw new ServiceChangeAdmissionError({ stage: "fence" });
    }
  }
  await NodeFS.promises.unlink(paths.fence);
};

const createAdmission = (baseDir: string) => {
  const paths = admissionPaths(baseDir);
  let createdLease: AdmissionLease | undefined;
  const acquired = Semaphore.withPermit(admissionMutex(baseDir))(
    Effect.tryPromise({
      try: () => ensureDirectories(paths),
      catch: (cause) => new ServiceChangeAdmissionError({ stage: "storage", cause }),
    }).pipe(
      Effect.andThen(
        withMutex(paths, async () => {
          for (const tokenPath of pendingAdmissionTokenCleanup) {
            if (NodePath.dirname(tokenPath) !== paths.active) continue;
            await unlinkWithRetry(tokenPath);
            pendingAdmissionTokenCleanup.delete(tokenPath);
          }
          await removeStaleFence(paths);
          const tokenPath = NodePath.join(
            paths.active,
            `${process.pid}-${NodeCrypto.randomUUID()}.json`,
          );
          await NodeFS.promises.writeFile(tokenPath, JSON.stringify({ pid: process.pid }), {
            mode: 0o600,
            flag: "wx",
          });
          createdLease = { tokenPath, references: 1 } satisfies AdmissionLease;
          return createdLease;
        }),
      ),
    ),
  );
  return acquired.pipe(
    Effect.onExit((exit) =>
      Exit.isFailure(exit) && createdLease !== undefined
        ? releaseAdmission(createdLease)
        : Effect.void,
    ),
  );
};

const releaseAdmission = (lease: AdmissionLease) =>
  Effect.promise(async () => {
    if (lease.references <= 0) throw new Error("Admission lease released more than once.");
    lease.references -= 1;
    if (lease.references > 0) return;
    try {
      await unlinkWithRetry(lease.tokenPath);
      pendingAdmissionTokenCleanup.delete(lease.tokenPath);
    } catch (cause) {
      pendingAdmissionTokenCleanup.add(lease.tokenPath);
      throw cause;
    }
  });

export const initialize = Effect.fn("ServiceChangeAdmission.initialize")(function* (
  baseDir: string,
): Effect.fn.Return<void, ServiceChangeAdmissionError> {
  const startedAt = DateTime.formatIso(yield* DateTime.now);
  const contents = yield* encodeAdmissionCapability({
    protocolVersion: PROTOCOL_VERSION,
    pid: process.pid,
    startedAt,
  }).pipe(Effect.mapError((cause) => new ServiceChangeAdmissionError({ stage: "storage", cause })));
  return yield* Effect.uninterruptible(
    Effect.tryPromise({
      try: async () => {
        const paths = admissionPaths(baseDir);
        await ensureDirectories(paths);
        const temporary = `${paths.capability}.${process.pid}.${NodeCrypto.randomUUID()}.tmp`;
        const descriptor = await NodeFS.promises.open(temporary, "wx", 0o600);
        try {
          await descriptor.writeFile(`${contents}\n`, "utf8");
          await descriptor.sync();
        } finally {
          await descriptor.close();
        }
        await NodeFS.promises.rename(temporary, paths.capability);
        const directoryDescriptor = await NodeFS.promises.open(paths.root, "r");
        try {
          await directoryDescriptor.sync();
        } finally {
          await directoryDescriptor.close();
        }
      },
      catch: (cause) => new ServiceChangeAdmissionError({ stage: "storage", cause }),
    }),
  );
});

const leaseIsActive = (lease: AdmissionLease) =>
  Effect.promise(() =>
    NodeFS.promises.access(lease.tokenPath).then(
      () => true,
      () => false,
    ),
  );

export const withAdmissionAt = Effect.fn("ServiceChangeAdmission.withAdmissionAt")(function* <
  A,
  E,
  R,
>(
  baseDir: string,
  effect: Effect.Effect<A, E, R>,
): Effect.fn.Return<A, E | ServiceChangeAdmissionError, R> {
  const activeLease = yield* Effect.serviceOption(AdmissionLeaseContext);
  if (
    Option.isSome(activeLease) &&
    NodePath.dirname(activeLease.value.tokenPath) === admissionPaths(baseDir).active &&
    activeLease.value.references > 0 &&
    (yield* leaseIsActive(activeLease.value))
  ) {
    return yield* effect;
  }

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const lease = yield* Effect.acquireRelease(createAdmission(baseDir), releaseAdmission);
      return yield* Effect.provideService(effect, AdmissionLeaseContext, lease);
    }),
  );
});

/**
 * Fork background work while retaining the command's admission lease until that
 * work exits. The child receives the same lease context, so nested dispatches
 * reuse it and a snapshot census cannot pass between acceptance and preparation.
 */
export const forkInWithAdmissionAt = Effect.fn("ServiceChangeAdmission.forkInWithAdmissionAt")(
  function* <A, E, R>(baseDir: string, effect: Effect.Effect<A, E, R>, scope: Scope.Scope) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const inheritedLease = yield* Effect.serviceOption(AdmissionLeaseContext);
        const leaseIsReusable =
          Option.isSome(inheritedLease) &&
          NodePath.dirname(inheritedLease.value.tokenPath) === admissionPaths(baseDir).active &&
          inheritedLease.value.references > 0 &&
          (yield* leaseIsActive(inheritedLease.value));
        const lease = leaseIsReusable
          ? inheritedLease.value
          : yield* restore(createAdmission(baseDir));
        if (leaseIsReusable) lease.references += 1;

        const child = Effect.provideService(
          effect.pipe(Effect.ensuring(releaseAdmission(lease))),
          AdmissionLeaseContext,
          lease,
        ).pipe(Effect.forkIn(scope));
        return yield* restore(child).pipe(
          Effect.onExit((exit) => (Exit.isFailure(exit) ? releaseAdmission(lease) : Effect.void)),
        );
      }),
    );
  },
);

export const withAdmission = Effect.fn("ServiceChangeAdmission.withAdmission")(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) {
  const config = yield* ServerConfig.ServerConfig;
  return yield* withAdmissionAt(config.baseDir, effect);
});
