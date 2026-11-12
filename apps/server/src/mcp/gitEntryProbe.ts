// @effect-diagnostics nodeBuiltinImport:off -- A synchronous stat walk; OrchestratorMcpService has no FileSystem service.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";

export interface GitEntry {
  readonly path: string;
  /** The folder holding it, which is `cwd` itself or one of its parents. */
  readonly folder: string;
  readonly inParent: boolean;
}

/**
 * The nearest `.git` entry (folder or gitfile) in `cwd` or any parent folder, or null. A folder that
 * cannot be inspected counts as having one, so callers that use this to prove "no repository" fail
 * closed.
 */
export const findGitEntry = (cwd: string): Effect.Effect<GitEntry | null> =>
  Effect.sync(() => {
    const start = NodePath.resolve(cwd);
    for (let folder = start; ; folder = NodePath.dirname(folder)) {
      const found = { path: NodePath.join(folder, ".git"), folder, inParent: folder !== start };
      try {
        NodeFS.lstatSync(found.path);
        return found;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") return found;
      }
      if (NodePath.dirname(folder) === folder) return null;
    }
  });

export const hasGitEntry = (cwd: string): Effect.Effect<boolean> =>
  Effect.map(findGitEntry(cwd), (entry) => entry !== null);
