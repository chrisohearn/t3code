import {
  LaunchPresetToolInput,
  LaunchPresetToolResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as LaunchPresets from "../../../persistence/LaunchPresets.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "../../McpInvocationContext.ts";

export const PresetToolkit = Toolkit.make(
  Tool.make("t3_preset", {
    description: "Launch presets: list, read, save (omitted fields keep, null clears), delete.",
    parameters: LaunchPresetToolInput,
    success: LaunchPresetToolResult,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      Invocation.McpInvocationContext,
      ThreadManagement.ThreadManagementService,
      LaunchPresets.LaunchPresets,
    ],
  }).annotate(Tool.Destructive, true),
);
