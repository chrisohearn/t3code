import { CodexSettings, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { resolveManagedCodexHomeLayout } from "../provider/CodexManagedHome.ts";
import {
  inspectCodexShadowHome,
  resolveCodexHomeLayout,
  withCodexSqliteHome,
} from "../provider/Drivers/CodexHomeLayout.ts";
import { decodeSettingsFileContents } from "../serverSettings.ts";

/** One configured Codex instance's shadow home, as the next materialization would find it. */
export interface CodexShadowHomeReport {
  readonly instanceId: string;
  readonly shadowHomePath: string;
  /** `auto-settle`: setup will move the shadow's own databases aside; `not-ready`: setup will refuse. */
  readonly status: "ready" | "auto-settle" | "not-ready" | "unknown";
  readonly conflicts: ReadonlyArray<{
    readonly entryName: string;
    readonly path: string;
    readonly autoSettle: boolean;
  }>;
  readonly detail?: string;
}

export interface CodexShadowHomesPreflight {
  readonly status: "ready" | "not-ready";
  readonly instances: ReadonlyArray<CodexShadowHomeReport>;
}

const decodeCodexSettings = Schema.decodeUnknownExit(CodexSettings);
const CODEX = ProviderDriverKind.make("codex");

/**
 * Read-only: every configured Codex instance's shadow home, laid out the way its driver lays it
 * out. Managed-policy pins are not applied here, so a pinned field reads as the user stored it.
 */
export const inspectConfiguredCodexShadowHomes = Effect.fn("inspectConfiguredCodexShadowHomes")(
  function* (stateDir: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const settingsPath = path.join(stateDir, "settings.json");
    const raw = yield* fileSystem.readFileString(settingsPath).pipe(
      Effect.asSome,
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound" ? Effect.succeedNone : Effect.fail(cause),
      }),
      Effect.result,
    );
    if (raw._tag === "Success" && Option.isNone(raw.success)) {
      return { status: "ready", instances: [] } satisfies CodexShadowHomesPreflight;
    }
    const settings =
      raw._tag === "Success" && Option.isSome(raw.success)
        ? decodeSettingsFileContents(raw.success.value)
        : undefined;
    if (settings === undefined) {
      return {
        status: "not-ready",
        instances: [
          {
            instanceId: "*",
            shadowHomePath: settingsPath,
            status: "unknown",
            conflicts: [],
            detail:
              "settings.json cannot be read or decoded, so Codex instances cannot be checked.",
          },
        ],
      } satisfies CodexShadowHomesPreflight;
    }

    const instances: Array<CodexShadowHomeReport> = [];
    // A default instance has no stored config and so no shadow home; only stored ones can.
    for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
      if (instance.driver !== CODEX) continue;
      const decoded = decodeCodexSettings(instance.config ?? {});
      if (decoded._tag === "Failure") {
        instances.push({
          instanceId,
          shadowHomePath: "",
          status: "unknown",
          conflicts: [],
          detail: "Its Codex settings do not decode.",
        });
        continue;
      }
      const config = decoded.value;
      const environment = yield* mergeProviderInstanceEnvironment(instance.environment);
      // Mirrors CodexManagedProvider and CodexDriver, which pick the layout by setup mode.
      const layout =
        config.setupMode === "managed"
          ? yield* resolveManagedCodexHomeLayout(
              stateDir,
              ProviderInstanceId.make(instanceId),
              config,
            )
          : yield* resolveCodexHomeLayout(
              !config.homePath && !config.shadowHomePath && environment.CODEX_HOME?.trim()
                ? { ...config, homePath: environment.CODEX_HOME }
                : config,
            );
      if (layout.mode !== "authOverlay" || layout.effectiveHomePath === undefined) continue;
      const shadowHomePath = layout.effectiveHomePath;
      const inspected = yield* inspectCodexShadowHome(layout, {
        sqliteHome: withCodexSqliteHome(layout, environment).CODEX_SQLITE_HOME,
      }).pipe(Effect.result);
      if (inspected._tag === "Failure") {
        instances.push({
          instanceId,
          shadowHomePath,
          status: "unknown",
          conflicts: [],
          detail: inspected.failure.message,
        });
        continue;
      }
      const conflicts = inspected.success.map(({ entryName, path: entryPath, autoSettle }) => ({
        entryName,
        path: entryPath,
        autoSettle,
      }));
      instances.push({
        instanceId,
        shadowHomePath,
        status:
          conflicts.length === 0
            ? "ready"
            : conflicts.every((conflict) => conflict.autoSettle)
              ? "auto-settle"
              : "not-ready",
        conflicts,
      });
    }
    return {
      status: instances.some(
        (instance) => instance.status === "not-ready" || instance.status === "unknown",
      )
        ? "not-ready"
        : "ready",
      instances,
    } satisfies CodexShadowHomesPreflight;
  },
);
