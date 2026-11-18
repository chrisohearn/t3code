import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";

const skillFiles = [
  "contribution-triage/SKILL.md",
  "test-t3-app/SKILL.md",
  "test-t3-app/agents/openai.yaml",
  "test-t3-app/references/sqlite-fixtures.md",
  "test-t3-mobile/SKILL.md",
  "test-t3-mobile/agents/openai.yaml",
  "test-t3-mobile/scripts/pair-client.sh",
];
const skillTrees = [".agents/skills", ".claude/skills"] as const;

const listFiles = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  directory: string,
  prefix = "",
): Effect.Effect<ReadonlyArray<string>, PlatformError> =>
  Effect.gen(function* () {
    const entries = yield* fileSystem.readDirectoryEntries(directory);
    const nested = yield* Effect.forEach(entries, (entry) => {
      const relative = path.join(prefix, entry.name);
      return entry.type === "Directory"
        ? listFiles(fileSystem, path, path.join(directory, entry.name), relative)
        : Effect.succeed([relative]);
    });
    return nested.flat().sort();
  });

const localMarkdownLinks = (source: string) => [
  ...[...source.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]!.trim().split(/\s+/, 1)[0]!),
  ...[...source.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm)].map((match) => match[1]!),
];

it.layer(NodeServices.layer)("agent-skill-tree-layout", (it) => {
  it.effect("preserves the seven Claude skill paths and their relative references", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const testPath = yield* path.fromFileUrl(new URL(import.meta.url));
      const repoRoot = path.resolve(path.dirname(testPath), "..");
      const roots = skillTrees.map((tree) => path.join(repoRoot, tree));

      for (const root of roots) {
        const stat = yield* fileSystem.lstat(root);
        assert.equal(stat.type, "Directory", `${root} must be a real directory`);
        assert.deepStrictEqual(yield* listFiles(fileSystem, path, root), skillFiles);
      }

      for (const relative of skillFiles) {
        const source = path.join(roots[0]!, relative);
        const alias = path.join(roots[1]!, relative);
        const sourceStat = yield* fileSystem.lstat(source);
        assert.equal(sourceStat.type, "File", `${source} must be a regular file`);

        const aliasStat = yield* fileSystem.lstat(alias);
        assert.equal(aliasStat.type, "SymbolicLink", `${alias} must stay a file-level link`);
        const target = yield* fileSystem.readLink(alias);
        assert.isFalse(path.isAbsolute(target), `${alias} must keep a relative target`);
        const resolvedTarget = path.resolve(path.dirname(alias), target);
        assert.equal(resolvedTarget, source);
        const targetStat = yield* fileSystem.lstat(resolvedTarget);
        assert.equal(targetStat.type, "File", `${alias} must target a regular file`);
        assert.equal(
          yield* fileSystem.readFileString(alias),
          yield* fileSystem.readFileString(source),
        );
      }

      for (const relative of skillFiles.filter((file) => file.endsWith(".md"))) {
        const source = yield* fileSystem.readFileString(path.join(roots[0]!, relative));
        for (const link of localMarkdownLinks(source)) {
          const target = link.replace(/^<|>$/g, "");
          if (
            !target ||
            target.startsWith("#") ||
            target.startsWith("/") ||
            /^[a-z][a-z\d+.-]*:/i.test(target)
          ) {
            continue;
          }
          const localPath = decodeURIComponent(target.split(/[?#]/, 1)[0]!);
          if (!localPath) continue;

          for (let index = 0; index < roots.length; index++) {
            const resolved = path.resolve(
              path.dirname(path.join(roots[index]!, relative)),
              localPath,
            );
            const fromRoot = path.relative(repoRoot, resolved);
            assert.ok(
              fromRoot === "" ||
                (!path.isAbsolute(fromRoot) &&
                  !fromRoot.startsWith(`..${path.sep}`) &&
                  fromRoot !== ".."),
              `${relative} links outside the repository: ${link}`,
            );
            assert.isTrue(
              yield* fileSystem.exists(resolved),
              `${skillTrees[index]} reference is missing: ${relative} -> ${link}`,
            );
          }
        }
      }
    }),
  );
});
