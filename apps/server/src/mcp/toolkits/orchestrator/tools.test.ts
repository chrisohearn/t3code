import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import { OrchestratorToolkit } from "./tools.ts";

// Oversized page sizes clamp on decode, so the schema has no `maximum`; Codex also drops
// bounds from its TypeScript view. The description is the only place a model sees a limit.
it.each(["t3_thread_read", "t3_thread_inspect"] as const)(
  "states %s page size limits in the parameter descriptions",
  (name) => {
    const schema = Tool.getJsonSchema(OrchestratorToolkit.tools[name]) as {
      readonly properties: Readonly<Record<string, { readonly description?: string }>>;
    };
    const limits = { limit: "100", runLimit: "50", maxCharsPerItem: "50000" };
    for (const [name, maximum] of Object.entries(limits)) {
      expect(schema.properties[name]?.description, name).toContain(maximum);
    }
  },
);

it("advertises inspection as non-mutating without relabeling the consuming reader", () => {
  const { t3_thread_read: reader, t3_thread_inspect: inspector } = OrchestratorToolkit.tools;
  expect(Context.get(inspector.annotations, Tool.Readonly)).toBe(true);
  expect(Context.get(reader.annotations, Tool.Readonly)).toBe(false);
  expect(Tool.getJsonSchema(inspector)).toEqual(Tool.getJsonSchema(reader));
});

it("refuses a t3_thread_update whose fields do not fit its action", () => {
  const decode = Schema.decodeUnknownExit(
    OrchestratorToolkit.tools.t3_thread_update.parametersSchema,
  );
  expect(Exit.isFailure(decode({ action: "rename" }))).toBe(true);
  expect(Exit.isFailure(decode({ action: "regenerate_title", title: "New" }))).toBe(true);
  expect(Exit.isSuccess(decode({ action: "rename", title: "New", environmentId: undefined }))).toBe(
    true,
  );
});
