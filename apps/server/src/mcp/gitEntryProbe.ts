// @effect-diagnostics nodeBuiltinImport:off -- A synchronous stat walk; OrchestratorMcpService has no FileSystem service.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";

/**
 * Whether `cwd` or any parent folder has a `.git` entry (folder or gitfile). A folder that cannot be
 * inspected counts as having one, so callers that use this to prove "no repository" fail closed.
 */
export const hasGitEntry = (cwd: string): Effect.Effect<boolean> =>
  Effect.sync(() => {
    for (let folder = NodePath.resolve(cwd); ; folder = NodePath.dirname(folder)) {
      try {
        NodeFS.lstatSync(NodePath.join(folder, ".git"));
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") return true;
      }
      if (NodePath.dirname(folder) === folder) return false;
    }
  });
