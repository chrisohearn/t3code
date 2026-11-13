// @effect-diagnostics nodeBuiltinImport:off -- fff blocks its host thread and cannot safely unload in Node workers.
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodeSea from "node:sea";

import type { FileFinder, InitOptions, Result } from "@ff-labs/fff-node";
import * as Context from "effect/Context";

type FinderMethod =
  | "destroy"
  | "directorySearch"
  | "fileSearch"
  | "grep"
  | "isScanning"
  | "mixedSearch"
  | "scanFiles"
  | "scanFilesAsync"
  | "waitForIndexReady";

export interface ProcessFinder {
  readonly call: <Method extends FinderMethod>(
    method: Method,
    ...args: Parameters<FileFinder[Method]>
  ) => Promise<Awaited<ReturnType<FileFinder[Method]>>>;
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
  process.on("message", async ({ id, method, args }) => {
    try {
      process.send({ id, value: await finder[method](...args) });
    } catch (cause) {
      process.send({ id, failed: true, cause });
    }
  });
});
`;

type FinderMessage =
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

    const call: ProcessFinder["call"] = (method, ...args) =>
      new Promise((resolveCall, rejectCall) => {
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
      if ("created" in message) {
        if (!message.created.ok) {
          resolve(message.created);
          child.kill();
          return;
        }
        resolve({
          ok: true,
          value: {
            call,
            close: () => {
              child.kill();
              return exited;
            },
          },
        });
        return;
      }
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if ("failed" in message) request.reject(message.cause);
      else request.resolve(message.value as never);
    });
    child.send(options, (error) => {
      if (error) fail(error);
    });
  });

export const WorkspaceFinderOpener = Context.Reference<OpenFinder>(
  "t3/workspace/WorkspaceFinderProcess/WorkspaceFinderOpener",
  { defaultValue: () => openProcessFinder },
);
