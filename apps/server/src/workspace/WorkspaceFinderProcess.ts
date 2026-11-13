// @effect-diagnostics nodeBuiltinImport:off -- fff blocks its host thread and cannot safely unload in Node workers.
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodeSea from "node:sea";

import type {
  FileFinder,
  InitOptions,
  Result,
  WatchEvent,
  WatchUnsubscribe,
} from "@ff-labs/fff-node";
import * as Context from "effect/Context";

type FinderMethod =
  | "destroy"
  | "directorySearch"
  | "directorySearchAsync"
  | "fileSearch"
  | "fileSearchAsync"
  | "getScanProgressAsync"
  | "grep"
  | "grepAsync"
  | "isScanning"
  | "mixedSearch"
  | "mixedSearchAsync"
  | "scanFiles"
  | "scanFilesAsync"
  | "waitForIndexReady";

export interface ProcessFinder {
  readonly call: <Method extends FinderMethod>(
    method: Method,
    ...args: Parameters<FileFinder[Method]>
  ) => Promise<Awaited<ReturnType<FileFinder[Method]>>>;
  readonly watch: (
    onBatch: (events: ReadonlyArray<WatchEvent>) => void,
  ) => Promise<Result<WatchUnsubscribe>>;
  readonly close: () => Promise<void>;
}

type OpenFinder = (options: InitOptions) => Promise<Result<ProcessFinder>>;

const FINDER_PROCESS_SOURCE = `
delete globalThis.__dirname;
delete globalThis.__filename;
const { FileFinder } = require(fffEntryPath);
process.on("disconnect", () => process.exit());
process.once("message", (options) => {
  const created = FileFinder.create(options);
  process.send({ created: created.ok ? { ok: true } : created });
  if (!created.ok) return;
  const finder = created.value;
  let unwatch;
  process.on("message", async ({ id, method, args }) => {
    try {
      if (method === "watch") {
        const watched = finder.watch((events) => process.send({ events }));
        if (watched.ok) unwatch = watched.value;
        process.send({ id, value: watched.ok ? { ok: true } : watched });
      } else if (method === "unwatch") {
        unwatch?.();
        unwatch = undefined;
        process.send({ id });
      } else {
        process.send({ id, value: await finder[method](...args) });
      }
    } catch (cause) {
      process.send({ id, failed: true, cause });
    }
  });
});
`;

type FinderMessage =
  | { readonly events: ReadonlyArray<WatchEvent> }
  | { readonly created: Result<undefined> }
  | { readonly id: number; readonly value: unknown }
  | { readonly id: number; readonly failed: true; readonly cause: unknown };

const requireForFff = NodeModule.createRequire(import.meta.url);
const fffEntryPath = requireForFff.resolve("@ff-labs/fff-node");

export function runWorkspaceFinderWorker() {
  if (!process.send) throw new Error("Workspace finders require an IPC channel.");
  new Function("require", "fffEntryPath", FINDER_PROCESS_SOURCE)(requireForFff, fffEntryPath);
}

const openProcessFinder: OpenFinder = (options) =>
  new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      process.execPath,
      NodeSea.isSea()
        ? ["__workspace-finder"]
        : [
            "--input-type=commonjs",
            "-e",
            `const fffEntryPath = ${JSON.stringify(fffEntryPath)};${FINDER_PROCESS_SOURCE}`,
          ],
      {
        stdio: ["ignore", "ignore", "inherit", "ipc"],
        serialization: "advanced",
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      },
    );
    const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    const pending = new Map<
      number,
      { readonly resolve: (value: never) => void; readonly reject: (cause: unknown) => void }
    >();
    let nextId = 0;
    let onWatchBatch: ((events: ReadonlyArray<WatchEvent>) => void) | undefined;
    let failure: unknown;
    const fail = (cause: unknown) => {
      failure ??= cause;
      reject(failure);
      for (const request of pending.values()) request.reject(failure);
      pending.clear();
      child.kill();
    };
    child.on("error", fail);
    child.on("exit", (code, signal) =>
      fail(new Error(`The fff process exited with ${signal ?? `code ${code}`}.`)),
    );

    const request = (method: string, args: ReadonlyArray<unknown>) =>
      new Promise<never>((resolveCall, rejectCall) => {
        if (failure !== undefined) {
          rejectCall(failure);
          return;
        }
        const id = nextId++;
        pending.set(id, { resolve: resolveCall, reject: rejectCall });
        child.send({ id, method, args }, (error) => {
          if (error) fail(error);
        });
      });

    child.on("message", (message: FinderMessage) => {
      if ("events" in message) {
        onWatchBatch?.(message.events);
        return;
      }
      if ("created" in message) {
        if (!message.created.ok) {
          resolve(message.created);
          child.kill();
          return;
        }
        resolve({
          ok: true,
          value: {
            call: (method, ...args) => request(method, args),
            watch: async (onBatch) => {
              onWatchBatch = onBatch;
              const result = (await request("watch", [])) as Result<undefined>;
              if (!result.ok) return result;
              return {
                ok: true,
                value: () => {
                  onWatchBatch = undefined;
                  void request("unwatch", []).catch(() => undefined);
                },
              };
            },
            close: () => {
              child.kill();
              return exited;
            },
          },
        });
        return;
      }
      const pendingRequest = pending.get(message.id);
      if (!pendingRequest) return;
      pending.delete(message.id);
      if ("failed" in message) pendingRequest.reject(message.cause);
      else pendingRequest.resolve(message.value as never);
    });
    child.send(options, (error) => {
      if (error) fail(error);
    });
  });

export const WorkspaceFinderOpener = Context.Reference<OpenFinder>(
  "t3/workspace/WorkspaceFinderProcess/WorkspaceFinderOpener",
  { defaultValue: () => openProcessFinder },
);
