import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { RuntimeMode } from "./providerPolicy.ts";

const STANDING_ROLE_MAX_CHARS = 4000;
const DONE_FORMAT_MAX_CHARS = 1000;

export const StandingRole = Schema.String.check(Schema.isMaxLength(STANDING_ROLE_MAX_CHARS));
export const DoneFormat = Schema.String.check(Schema.isMaxLength(DONE_FORMAT_MAX_CHARS));

export const LaunchPresetName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/),
);

/** A preset names a kind of checkout, never a path or branch, which belong to one launch. */
export const LaunchPresetWorkspaceStrategy = Schema.Union([
  Schema.Struct({ type: Schema.Literal("root") }),
  Schema.Struct({
    type: Schema.Literal("worktree"),
    baseRef: TrimmedNonEmptyString,
    startFromOrigin: Schema.optional(Schema.Boolean),
  }),
]);

export const LaunchPreset = Schema.Struct({
  name: LaunchPresetName,
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  standingRole: Schema.optional(StandingRole),
  workspaceStrategy: Schema.optional(LaunchPresetWorkspaceStrategy),
  doneFormat: Schema.optional(DoneFormat),
  updatedAt: IsoDateTime,
  updatedBy: Schema.String,
});
export type LaunchPreset = typeof LaunchPreset.Type;

/** Fields the caller may set. `null` clears one on an existing preset. */
const presetFields = {
  // Checked against ModelSelection on save: the full schema is large in the tool list.
  modelSelection: Schema.optional(
    Schema.Unknown.annotate({ description: "{instanceId, model, options?}; null clears." }),
  ),
  runtimeMode: Schema.optional(Schema.NullOr(RuntimeMode)),
  standingRole: Schema.optional(Schema.NullOr(StandingRole)),
  workspaceStrategy: Schema.optional(Schema.NullOr(LaunchPresetWorkspaceStrategy)),
  doneFormat: Schema.optional(Schema.NullOr(DoneFormat)),
};

export const LaunchPresetToolInput = Schema.Struct({
  action: Schema.Literals(["list", "read", "save", "delete"]),
  name: Schema.optional(LaunchPresetName),
  ...presetFields,
});
export type LaunchPresetToolInput = typeof LaunchPresetToolInput.Type;

export const LaunchPresetToolResult = Schema.Union([
  Schema.Struct({ presets: Schema.Array(Schema.String) }),
  // Loose here: the tool list carries this schema, and the stored preset is already decoded.
  LaunchPreset.mapFields(
    Struct.assign({
      modelSelection: Schema.optional(Schema.Unknown),
      workspaceStrategy: Schema.optional(Schema.Unknown),
    }),
  ),
  Schema.Struct({ deleted: Schema.Literal(true), name: LaunchPresetName }),
]);
export type LaunchPresetToolResult = typeof LaunchPresetToolResult.Type;

/** The standing role a launch stores: the role text, then the required done-message format. */
export function composeStandingRole(input: {
  readonly standingRole?: string | undefined;
  readonly doneFormat?: string | undefined;
}): string | undefined {
  const role = input.standingRole?.trim() ?? "";
  const done = input.doneFormat?.trim() ?? "";
  const parts = [role, done === "" ? "" : `Your final message must follow this format:\n${done}`];
  const text = parts.filter((part) => part !== "").join("\n\n");
  return text === "" ? undefined : text;
}
