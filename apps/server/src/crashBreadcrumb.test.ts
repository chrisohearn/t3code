import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { CRASH_BREADCRUMB_FILE, CrashBreadcrumb, recordFatalExit } from "./crashBreadcrumb.ts";

class MigrationError extends Schema.TaggedError<MigrationError>()("MigrationError", {
  message: Schema.String,
}) {}

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(CrashBreadcrumb));

it.effect("records a fatal error, and a normal stop by interruption leaves it in place", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const logsDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-crash-breadcrumb-" });
    const record = recordFatalExit({ logsDir, version: "0.1.10-test" });
    const breadcrumb = path.join(logsDir, CRASH_BREADCRUMB_FILE);

    yield* Effect.fail(new MigrationError({ message: "81_ProjectionMessageSearchText" })).pipe(
      record,
      Effect.ignore,
    );
    const written = yield* decode(yield* fs.readFileString(breadcrumb));
    assert.equal(written.version, "0.1.10-test");
    assert.include(written.error, "MigrationError");
    assert.include(written.error, "81_ProjectionMessageSearchText");

    yield* Effect.interrupt.pipe(record, Effect.exit);
    assert.deepEqual(yield* decode(yield* fs.readFileString(breadcrumb)), written);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
