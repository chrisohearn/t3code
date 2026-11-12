import packageJson from "../../package.json" with { type: "json" };
import { BUILD_MIGRATION_HEAD, recordedMigrations } from "../persistence/databaseMigrationHead.ts";
import {
  FORK_MIGRATION_HEAD,
  FORK_MIGRATIONS_TABLE,
  forkHistoryProblems,
  historyAfterForkRepair,
} from "../persistence/ForkMigrations.ts";
import { migrationManifest, skippedMigrations } from "../persistence/Migrations.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

export type ServicePreflightResult =
  | {
      readonly status: "ready";
      readonly version: string;
      readonly launcherProtocol: typeof SERVICE_LAUNCHER_PROTOCOL;
    }
  | {
      readonly status: "blocked";
      readonly version: string;
      readonly reason: string;
    };

export function runServicePreflight(input: {
  readonly databasePath: string;
  readonly launcherProtocol: number;
  readonly version?: string;
}): ServicePreflightResult {
  const version = input.version ?? packageJson.version;
  if (input.launcherProtocol !== SERVICE_LAUNCHER_PROTOCOL) {
    return {
      status: "blocked",
      version,
      // A stale `t3` earlier on PATH (an old npm/nvm global) makes `t3 service install`
      // reinstall itself and report success, so name the exact install and the path check.
      reason: [
        `The installed service launcher speaks protocol ${input.launcherProtocol}, but t3@${version} requires protocol ${SERVICE_LAUNCHER_PROTOCOL}.`,
        `On the server machine, install this exact CLI: \`curl -fsSL https://t3.codes/install.sh | T3CODE_VERSION=${version} sh\`.`,
        `Check that \`t3 --version\` prints ${version} and that \`which -a t3\` lists no older t3 (such as an npm or nvm install) first, then run \`~/.local/bin/t3 service install\` (the installer's default path).`,
        "Updating the desktop app does not update this CLI, and `t3 service update` only repairs the service with whichever CLI runs it.",
      ].join(" "),
    };
  }

  const history = migrationHistory(input.databasePath);
  if (history === null) {
    return {
      status: "blocked",
      version,
      reason: `Could not read this database to confirm t3@${version} supports it.`,
    };
  }
  if (history.newer.length > 0) {
    return {
      status: "blocked",
      version,
      reason: `This database has migrations that t3@${version} does not know: ${history.newer.join(", ")}. A newer build wrote them, and running t3@${version} on this database is not safe. Stay on the newer release, or wait for a release that includes these migrations.`,
    };
  }
  if (history.skipped.length > 0) {
    return {
      status: "blocked",
      version,
      reason: `t3@${version} would skip these migrations on this database: ${history.skipped.join(", ")}. Another build recorded different migrations under the same ids, and the migrator skips ids by number, not name, so t3@${version} would refuse to start. Stay on the build that wrote this database, or report this migration history so an upgrade path can be added.`,
    };
  }

  return { status: "ready", version, launcherProtocol: SERVICE_LAUNCHER_PROTOCOL };
}

/** What startup would refuse on this database: migrations a newer build recorded, and ids that
 * another build recorded under a different name, which startup would skip. Null when the database
 * exists but cannot be read. Startup already handles renamed ids this build knows. */
function migrationHistory(
  databasePath: string,
): { readonly newer: ReadonlyArray<string>; readonly skipped: ReadonlyArray<string> } | null {
  const recorded = recordedMigrations(databasePath);
  const forkRecorded = recordedMigrations(databasePath, FORK_MIGRATIONS_TABLE);
  if (recorded === null || forkRecorded === null) return null;
  // Fork: startup moves fork rows off upstream ids first, so judge the history it leaves.
  const { upstream, fork } = historyAfterForkRepair(recorded, forkRecorded, migrationManifest);
  return {
    newer: [
      ...upstream
        .filter(({ id }) => id > BUILD_MIGRATION_HEAD)
        .map(({ id, name }) => `${id}_${name}`),
      ...fork
        .filter(({ id }) => id > FORK_MIGRATION_HEAD)
        .map(({ id, name }) => `fork ${id}_${name}`),
    ],
    skipped: [
      ...skippedMigrations(upstream),
      ...forkHistoryProblems(fork).map((problem) => `fork ${problem}`),
    ],
  };
}

export function decodeServicePreflightResult(value: unknown): ServicePreflightResult | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record.status === "ready" &&
    record.launcherProtocol === SERVICE_LAUNCHER_PROTOCOL &&
    typeof record.version === "string"
  ) {
    return {
      status: "ready",
      version: record.version,
      launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
    };
  }
  if (
    record.status === "blocked" &&
    typeof record.version === "string" &&
    typeof record.reason === "string"
  ) {
    return { status: "blocked", version: record.version, reason: record.reason };
  }
  return undefined;
}
