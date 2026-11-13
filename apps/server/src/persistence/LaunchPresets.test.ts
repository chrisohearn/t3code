import { ProviderInstanceId, type LaunchPresetToolInput } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as LaunchPresets from "./LaunchPresets.ts";
import * as Sqlite from "./Sqlite.ts";
import * as ThreadRoles from "./ThreadRoles.ts";

const layer = Layer.mergeAll(LaunchPresets.layer, ThreadRoles.layer).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
);
const model = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };

it.effect("saves, merges, clears, lists, reads and deletes presets, and records who", () =>
  Effect.gen(function* () {
    const presets = yield* LaunchPresets.LaunchPresets;
    const run = (input: LaunchPresetToolInput, by = "thread-a") => presets.run(input, by);

    yield* run({
      action: "save",
      name: "worker",
      modelSelection: model,
      runtimeMode: "auto",
      standingRole: "Be brief.",
      doneFormat: "DONE: <summary>",
    });
    // Omitted fields keep their value; null clears one.
    const updated = yield* run(
      { action: "save", name: "worker", runtimeMode: null, standingRole: "Be thorough." },
      "thread-b",
    );
    expect(updated).toMatchObject({
      name: "worker",
      modelSelection: model,
      standingRole: "Be thorough.",
      doneFormat: "DONE: <summary>",
      updatedBy: "thread-b",
    });
    expect(updated).not.toHaveProperty("runtimeMode");
    expect(yield* run({ action: "read", name: "worker" })).toEqual(updated);
    expect(yield* run({ action: "list" })).toEqual({ presets: ["worker"] });

    // The tool advertises modelSelection loosely, so the service is what refuses a bad one.
    const badModel = yield* run({ action: "save", name: "bad", modelSelection: { model: 1 } }).pipe(
      Effect.flip,
    );
    expect(badModel.code).toBe("invalid_request");
    expect(yield* run({ action: "list" })).toEqual({ presets: ["worker"] });

    expect(yield* run({ action: "delete", name: "worker" })).toEqual({
      deleted: true,
      name: "worker",
    });
    expect((yield* presets.get("worker").pipe(Effect.flip)).code).toBe("invalid_request");
    expect((yield* run({ action: "save" }).pipe(Effect.flip)).code).toBe("invalid_request");
  }).pipe(Effect.provide(layer)),
);

it.effect("tracks a thread's role revisions and deliveries, and drops it with the thread", () =>
  Effect.gen(function* () {
    const roles = yield* ThreadRoles.ThreadRoles;
    const sql = yield* SqlClient.SqlClient;
    expect(yield* roles.get("thread-1")).toBeUndefined();
    yield* roles.set("thread-1", "  You are the build agent. ", "thread-a");
    expect(yield* roles.get("thread-1")).toMatchObject({
      text: "You are the build agent.",
      revision: 1,
      updatedBy: "thread-a",
    });
    yield* roles.markDelivered("thread-1", {
      revision: 1,
      nativeThreadId: "native",
      runOrdinal: 3,
    });
    expect((yield* roles.get("thread-1"))?.delivered).toEqual({
      revision: 1,
      nativeThreadId: "native",
      runOrdinal: 3,
    });
    // A change bumps the revision, and a delivery of the old one no longer counts.
    yield* roles.set("thread-1", "Now the review agent.", "thread-b");
    yield* roles.markDelivered("thread-1", {
      revision: 1,
      nativeThreadId: "native",
      runOrdinal: 4,
    });
    expect(yield* roles.get("thread-1")).toMatchObject({
      text: "Now the review agent.",
      revision: 2,
      updatedBy: "thread-b",
      delivered: { revision: 1, runOrdinal: 3 },
    });
    const refused = yield* roles
      .set("thread-1", "x".repeat(ThreadRoles.THREAD_ROLE_STORED_MAX_CHARS + 1), "thread-a")
      .pipe(Effect.flip);
    expect(refused.code).toBe("invalid_request");

    yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title,
      default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
      VALUES ('thread-1', 'project', 'one', 'codex', 'full-access', 'default', 'now', 'now', '{}')`;
    yield* sql`UPDATE orchestration_v2_projection_threads
      SET deleted_at = '1970-01-01T00:00:03.000Z' WHERE thread_id = 'thread-1'`;
    expect(yield* roles.get("thread-1")).toBeUndefined();

    yield* roles.set("thread-2", "Another.", "thread-a");
    yield* roles.set("thread-2", "", "thread-a");
    expect(yield* roles.get("thread-2")).toBeUndefined();
  }).pipe(Effect.provide(layer)),
);
