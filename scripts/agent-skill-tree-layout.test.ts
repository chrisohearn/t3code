import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, it } from "@effect/vitest";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
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

const listFiles = (directory: string, prefix = ""): string[] =>
  NodeFS.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const relative = NodePath.posix.join(prefix, entry.name);
      return entry.isDirectory()
        ? listFiles(NodePath.join(directory, entry.name), relative)
        : [relative];
    })
    .sort();

const localMarkdownLinks = (source: string) => [
  ...[...source.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]!.trim().split(/\s+/, 1)[0]!),
  ...[...source.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm)].map((match) => match[1]!),
];

it("preserves the seven Claude skill paths and their relative references", () => {
  const roots = skillTrees.map((tree) => NodePath.join(repoRoot, tree));

  for (const root of roots) {
    const stat = NodeFS.lstatSync(root);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), `${root} must be a real directory`);
    assert.deepStrictEqual(listFiles(root), skillFiles);
  }

  for (const relative of skillFiles) {
    const source = NodePath.join(roots[0]!, relative);
    const alias = NodePath.join(roots[1]!, relative);
    const sourceStat = NodeFS.lstatSync(source);
    assert.ok(
      sourceStat.isFile() && !sourceStat.isSymbolicLink(),
      `${source} must be a regular file`,
    );

    assert.ok(NodeFS.lstatSync(alias).isSymbolicLink(), `${alias} must stay a file-level link`);
    const target = NodeFS.readlinkSync(alias);
    assert.ok(!NodePath.isAbsolute(target), `${alias} must keep a relative target`);
    const resolvedTarget = NodePath.resolve(NodePath.dirname(alias), target);
    assert.equal(resolvedTarget, source);
    const targetStat = NodeFS.lstatSync(resolvedTarget);
    assert.ok(
      targetStat.isFile() && !targetStat.isSymbolicLink(),
      `${alias} must target a regular file`,
    );
    assert.deepStrictEqual(NodeFS.readFileSync(alias), NodeFS.readFileSync(source));
  }

  for (const relative of skillFiles.filter((file) => file.endsWith(".md"))) {
    const source = NodeFS.readFileSync(NodePath.join(roots[0]!, relative), "utf8");
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
        const resolved = NodePath.resolve(
          NodePath.dirname(NodePath.join(roots[index]!, relative)),
          localPath,
        );
        const fromRoot = NodePath.relative(repoRoot, resolved);
        assert.ok(
          fromRoot === "" ||
            (!NodePath.isAbsolute(fromRoot) &&
              !fromRoot.startsWith(`..${NodePath.sep}`) &&
              fromRoot !== ".."),
          `${relative} links outside the repository: ${link}`,
        );
        assert.ok(
          NodeFS.existsSync(resolved),
          `${skillTrees[index]} reference is missing: ${relative} -> ${link}`,
        );
      }
    }
  }
});
