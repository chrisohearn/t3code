import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

declare const __T3CODE_JARVIS_PLAYBOOK__: string;

export const URI = "t3://jarvis/playbook";
// Release bundles embed these docs; dev reads the checkout so edits are visible immediately.
export const read = Effect.fn("JarvisPlaybook.read")(function* () {
  if (typeof __T3CODE_JARVIS_PLAYBOOK__ !== "undefined") return __T3CODE_JARVIS_PLAYBOOK__;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(new URL("../../../../docs/jarvis/", import.meta.url));
  const files = (yield* fs.readDirectory(root, { recursive: true }))
    .filter((name) => name.endsWith(".md"))
    .sort();
  const sections = yield* Effect.forEach(files, (name) =>
    fs
      .readFileString(path.join(root, name))
      .pipe(Effect.map((content) => `<!-- ${name} -->\n${content}`)),
  );
  return sections.join("\n\n");
});
