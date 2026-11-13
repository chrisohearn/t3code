import {
  LaunchPreset,
  ModelSelection,
  OrchestratorMcpFailure,
  type LaunchPresetToolInput,
  type LaunchPresetToolResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class LaunchPresets extends Context.Service<
  LaunchPresets,
  {
    readonly get: (name: string) => Effect.Effect<LaunchPreset, OrchestratorMcpFailure>;
    readonly run: (
      input: LaunchPresetToolInput,
      updatedBy: string,
    ) => Effect.Effect<LaunchPresetToolResult, OrchestratorMcpFailure>;
  }
>()("t3/persistence/LaunchPresets") {}

const presetJson = Schema.fromJsonString(LaunchPreset);
const decodeModel = Schema.decodeUnknownEffect(ModelSelection);
const decodePreset = Schema.decodeUnknownEffect(presetJson);
const encodePreset = Schema.encodeEffect(presetJson);
const storage = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "Could not access launch presets.",
  });
const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const find = (name: string) =>
    sql<{ preset_json: string }>`SELECT preset_json FROM launch_presets WHERE name = ${name}`.pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined ? Effect.undefined : decodePreset(rows[0].preset_json),
      ),
      Effect.mapError(storage),
    );
  const get = Effect.fn("LaunchPresets.get")(function* (name: string) {
    return (
      (yield* find(name)) ??
      (yield* invalid(`Launch preset "${name}" was not found. Use t3_preset list.`))
    );
  });
  const run = Effect.fn("LaunchPresets.run")(function* (
    input: LaunchPresetToolInput,
    updatedBy: string,
  ) {
    if (input.action === "list") {
      const rows = yield* sql<{ name: string }>`SELECT name FROM launch_presets ORDER BY name`.pipe(
        Effect.mapError(storage),
      );
      return { presets: rows.map((row) => row.name) };
    }
    const name = input.name;
    if (name === undefined) return yield* invalid("This action needs `name`.");
    if (input.action === "read") return yield* get(name);
    if (input.action === "delete") {
      yield* get(name);
      yield* sql`DELETE FROM launch_presets WHERE name = ${name}`.pipe(Effect.mapError(storage));
      return { deleted: true as const, name };
    }
    const existing = yield* find(name);
    const model =
      input.modelSelection === undefined || input.modelSelection === null
        ? input.modelSelection
        : yield* decodeModel(input.modelSelection).pipe(
            Effect.mapError(() => invalid("modelSelection must be {instanceId, model, options?}.")),
          );
    const given = { ...input, modelSelection: model };
    // Omitted fields keep their value; null clears one.
    const pick = <
      K extends
        | "modelSelection"
        | "runtimeMode"
        | "standingRole"
        | "workspaceStrategy"
        | "doneFormat",
    >(
      key: K,
    ) => {
      const value = given[key];
      return value === undefined ? existing?.[key] : (value ?? undefined);
    };
    const merged = {
      name,
      modelSelection: pick("modelSelection"),
      runtimeMode: pick("runtimeMode"),
      standingRole: pick("standingRole"),
      workspaceStrategy: pick("workspaceStrategy"),
      doneFormat: pick("doneFormat"),
    };
    const preset: LaunchPreset = {
      name,
      ...(merged.modelSelection === undefined ? {} : { modelSelection: merged.modelSelection }),
      ...(merged.runtimeMode === undefined ? {} : { runtimeMode: merged.runtimeMode }),
      ...(merged.standingRole === undefined ? {} : { standingRole: merged.standingRole }),
      ...(merged.workspaceStrategy === undefined
        ? {}
        : { workspaceStrategy: merged.workspaceStrategy }),
      ...(merged.doneFormat === undefined ? {} : { doneFormat: merged.doneFormat }),
      updatedAt: DateTime.formatIso(yield* DateTime.now),
      updatedBy,
    };
    const json = yield* encodePreset(preset).pipe(Effect.mapError(storage));
    yield* sql`INSERT INTO launch_presets (name, preset_json, updated_at, updated_by)
      VALUES (${name}, ${json}, ${preset.updatedAt}, ${updatedBy})
      ON CONFLICT (name) DO UPDATE SET preset_json = excluded.preset_json,
        updated_at = excluded.updated_at, updated_by = excluded.updated_by`.pipe(
      Effect.mapError(storage),
    );
    return preset;
  });
  return LaunchPresets.of({ get, run });
});

export const layer = Layer.effect(LaunchPresets, make);
