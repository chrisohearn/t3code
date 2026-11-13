import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const CRASH_BREADCRUMB_FILE = "last-fatal.json";
const MAX_ERROR_CHARS = 4000;

export const CrashBreadcrumb = Schema.Struct({
  at: Schema.String,
  version: Schema.String,
  pid: Schema.Number,
  error: Schema.String,
});
const encodeBreadcrumb = Schema.encodeEffect(Schema.fromJsonString(CrashBreadcrumb));

/**
 * Records the server's last fatal error in its logs directory: the service log rotates and its
 * lines carry no date, so a crash loop otherwise leaves nothing easy to find.
 */
const writeCrashBreadcrumb = Effect.fn("crashBreadcrumb.write")(function* (input: {
  readonly logsDir: string;
  readonly version: string;
  readonly error: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.join(input.logsDir, CRASH_BREADCRUMB_FILE);
  const temporary = `${target}.${process.pid}.tmp`;
  yield* fs.makeDirectory(input.logsDir, { recursive: true });
  const text = yield* encodeBreadcrumb({
    at: DateTime.formatIso(yield* DateTime.now),
    version: input.version,
    pid: process.pid,
    error: input.error.slice(0, MAX_ERROR_CHARS),
  });
  yield* fs.writeFileString(temporary, `${text}\n`);
  yield* fs.rename(temporary, target);
});

/** Writes the breadcrumb when `effect` fails; a normal stop ends by interruption and keeps it. */
export const recordFatalExit =
  (input: { readonly logsDir: string; readonly version: string }) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R | FileSystem.FileSystem | Path.Path> =>
    effect.pipe(
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : writeCrashBreadcrumb({ ...input, error: Cause.pretty(cause) }).pipe(
              // Best effort: the process must still exit with its real error.
              Effect.ignore,
            ),
      ),
    );
