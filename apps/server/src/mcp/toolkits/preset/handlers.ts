import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as LaunchPresets from "../../../persistence/LaunchPresets.ts";
import * as Access from "../../McpToolAccess.ts";
import { actorLabel } from "../../McpInvocationContext.ts";
import { readCaller } from "../../threadAccess.ts";
import { PresetToolkit } from "./tools.ts";

const run = Effect.fn("mcp.presetTool")(function* (
  input: Parameters<LaunchPresets.LaunchPresets["Service"]["run"]>[0],
) {
  const { scope } = yield* readCaller();
  if (scope.thread === undefined && scope.client === undefined)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "A caller identity is required.",
    });
  return yield* (yield* LaunchPresets.LaunchPresets).run(input, actorLabel(scope));
});

export const layer = Access.toLayer(PresetToolkit, {
  // A preset is instructions that broader-mode threads later start with, so changing one is
  // held to the same access as changing the environment's settings.
  t3_preset: Access.either(
    (input) => input.action === "list" || input.action === "read",
    Access.reads(run),
    Access.writesEnvironment((input) => run(input)),
  ),
});
