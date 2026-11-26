import {
  CommandId,
  ModelSelection,
  NonNegativeInt,
  ProjectId,
  ProjectScript,
  ThreadEnvMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as OrchestrationCommandReceipts from "../persistence/OrchestrationCommandReceipts.ts";

export class CommandReceiptStoreWriteError extends Schema.TaggedError<CommandReceiptStoreWriteError>()(
  "CommandReceiptStoreWriteError",
  {
    commandId: CommandId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to write orchestration V2 command receipt ${this.commandId}.`;
  }
}

export class CommandReceiptStoreReadError extends Schema.TaggedError<CommandReceiptStoreReadError>()(
  "CommandReceiptStoreReadError",
  {
    commandId: CommandId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to read orchestration V2 command receipt ${this.commandId}.`;
  }
}

export const CommandReceiptStoreV2Error = Schema.Union([
  CommandReceiptStoreWriteError,
  CommandReceiptStoreReadError,
]);
export type CommandReceiptStoreV2Error = typeof CommandReceiptStoreV2Error.Type;

export const CommandReceiptV2Status = Schema.Literals(["accepted", "rejected"]);
export type CommandReceiptV2Status = typeof CommandReceiptV2Status.Type;

const projectScriptSyncSnapshot = Schema.Struct({
  present: Schema.Boolean,
  value: Schema.optional(Schema.Array(ProjectScript)),
});
const modelSelectionSyncSnapshot = Schema.Struct({
  present: Schema.Boolean,
  value: Schema.optional(Schema.NullOr(ModelSelection)),
});
const threadEnvModeSyncSnapshot = Schema.Struct({
  present: Schema.Boolean,
  value: Schema.optional(Schema.NullOr(ThreadEnvMode)),
});
const autoPullSyncSnapshot = Schema.Struct({
  present: Schema.Boolean,
  value: Schema.optional(Schema.Boolean),
});

export const ProjectSettingsSyncChange = Schema.Union([
  Schema.Struct({
    key: Schema.Literal("defaultProjectScripts"),
    before: projectScriptSyncSnapshot,
    after: projectScriptSyncSnapshot,
  }),
  Schema.Struct({
    key: Schema.Literal("defaultModelSelection"),
    before: modelSelectionSyncSnapshot,
    after: modelSelectionSyncSnapshot,
  }),
  Schema.Struct({
    key: Schema.Literal("defaultThreadEnvMode"),
    before: threadEnvModeSyncSnapshot,
    after: threadEnvModeSyncSnapshot,
  }),
  Schema.Struct({
    key: Schema.Literal("defaultAutoPull"),
    before: autoPullSyncSnapshot,
    after: autoPullSyncSnapshot,
  }),
]);
export type ProjectSettingsSyncChange = typeof ProjectSettingsSyncChange.Type;

export const ProjectSettingsSync = Schema.Struct({
  changes: Schema.Array(ProjectSettingsSyncChange),
});
export type ProjectSettingsSync = typeof ProjectSettingsSync.Type;

export const CommandReceiptV2 = Schema.Struct({
  commandId: CommandId,
  threadId: ThreadId,
  commandType: Schema.String,
  acceptedAt: Schema.DateTimeUtc,
  resultSequence: NonNegativeInt,
  status: CommandReceiptV2Status,
  error: Schema.NullOr(Schema.String),
});
export type CommandReceiptV2 = typeof CommandReceiptV2.Type;

export const ProjectCommandReceiptV2 = Schema.Struct({
  commandId: CommandId,
  projectId: ProjectId,
  commandType: Schema.String,
  acceptedAt: Schema.DateTimeUtc,
  resultSequence: NonNegativeInt,
  status: CommandReceiptV2Status,
  error: Schema.NullOr(Schema.String),
  projectSettingsSync: Schema.optional(ProjectSettingsSync),
});
export type ProjectCommandReceiptV2 = typeof ProjectCommandReceiptV2.Type;

type AnyCommandReceiptV2 = CommandReceiptV2 | ProjectCommandReceiptV2;

export interface CommandReceiptStoreV2Shape {
  readonly insertIfAbsent: (
    receipt: AnyCommandReceiptV2,
  ) => Effect.Effect<boolean, CommandReceiptStoreV2Error>;
  readonly upsert: (
    receipt: AnyCommandReceiptV2,
  ) => Effect.Effect<void, CommandReceiptStoreV2Error>;
  /** None for project command ids. */
  readonly getByCommandId: (
    commandId: CommandId,
  ) => Effect.Effect<Option.Option<CommandReceiptV2>, CommandReceiptStoreV2Error>;
  /** None for thread command ids. */
  readonly getProjectByCommandId: (
    commandId: CommandId,
  ) => Effect.Effect<Option.Option<ProjectCommandReceiptV2>, CommandReceiptStoreV2Error>;
}

export class CommandReceiptStoreV2 extends Context.Service<
  CommandReceiptStoreV2,
  CommandReceiptStoreV2Shape
>()("t3/orchestration-v2/CommandReceiptStore/CommandReceiptStoreV2") {}

const decodeReceipt = Schema.decodeUnknownEffect(
  CommandReceiptV2.mapFields((fields) => ({
    ...fields,
    acceptedAt: Schema.DateTimeUtcFromString,
  })),
);
const ProjectSettingsSyncJson = Schema.fromJsonString(ProjectSettingsSync);
const decodeProjectSettingsSyncJson = Schema.decodeUnknownEffect(ProjectSettingsSyncJson);
const decodeProjectCommandReceipt = Schema.decodeUnknownEffect(
  ProjectCommandReceiptV2.mapFields((fields) => ({
    ...fields,
    acceptedAt: Schema.DateTimeUtcFromString,
  })),
);
const decodeProjectReceipt = Effect.fn("CommandReceiptStore.decodeProjectReceipt")(function* (
  receipt: OrchestrationCommandReceipts.OrchestrationCommandReceipt,
) {
  const projectSettingsSync =
    receipt.projectSettingsSyncJson == null
      ? undefined
      : yield* decodeProjectSettingsSyncJson(receipt.projectSettingsSyncJson);
  return yield* decodeProjectCommandReceipt({
    commandId: receipt.commandId,
    projectId: receipt.aggregateId as ProjectId,
    commandType: receipt.commandType,
    acceptedAt: receipt.acceptedAt,
    resultSequence: receipt.resultSequence,
    status: receipt.status,
    error: receipt.error,
    ...(projectSettingsSync === undefined ? {} : { projectSettingsSync }),
  });
});

function fromApplicationReceipt(receipt: OrchestrationCommandReceipts.OrchestrationCommandReceipt) {
  return decodeReceipt({
    commandId: receipt.commandId,
    threadId: receipt.aggregateId,
    commandType: receipt.commandType,
    acceptedAt: receipt.acceptedAt,
    resultSequence: receipt.resultSequence,
    status: receipt.status,
    error: receipt.error,
  });
}

function toApplicationReceipt(
  receipt: AnyCommandReceiptV2,
): OrchestrationCommandReceipts.OrchestrationCommandReceipt {
  return {
    commandId: receipt.commandId,
    ...("projectId" in receipt
      ? { aggregateKind: "project" as const, aggregateId: receipt.projectId }
      : { aggregateKind: "thread" as const, aggregateId: receipt.threadId }),
    commandType: receipt.commandType,
    acceptedAt: DateTime.formatIso(receipt.acceptedAt),
    resultSequence: receipt.resultSequence,
    status: receipt.status,
    error: receipt.error,
    projectSettingsSyncJson:
      "projectSettingsSync" in receipt && receipt.projectSettingsSync !== undefined
        ? JSON.stringify(receipt.projectSettingsSync)
        : null,
  };
}

const layerBase: Layer.Layer<
  CommandReceiptStoreV2,
  never,
  OrchestrationCommandReceipts.OrchestrationCommandReceiptRepository
> = Layer.effect(
  CommandReceiptStoreV2,
  Effect.gen(function* () {
    const receipts = yield* OrchestrationCommandReceipts.OrchestrationCommandReceiptRepository;

    return CommandReceiptStoreV2.of({
      insertIfAbsent: (receipt) =>
        receipts.insertIfAbsent(toApplicationReceipt(receipt)).pipe(
          Effect.mapError(
            (cause) =>
              new CommandReceiptStoreWriteError({
                commandId: receipt.commandId,
                cause,
              }),
          ),
        ),
      upsert: (receipt) =>
        receipts.upsert(toApplicationReceipt(receipt)).pipe(
          Effect.mapError(
            (cause) =>
              new CommandReceiptStoreWriteError({
                commandId: receipt.commandId,
                cause,
              }),
          ),
        ),
      getByCommandId: (commandId) =>
        receipts.getByCommandId({ commandId }).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeedNone,
              onSome: (receipt) =>
                receipt.aggregateKind !== "thread"
                  ? Effect.succeedNone
                  : fromApplicationReceipt(receipt).pipe(Effect.asSome),
            }),
          ),
          Effect.mapError(
            (cause) =>
              new CommandReceiptStoreReadError({
                commandId,
                cause,
              }),
          ),
        ),
      getProjectByCommandId: (commandId) =>
        receipts.getByCommandId({ commandId }).pipe(
          Effect.flatMap((receipt) =>
            Option.isNone(receipt) || receipt.value.aggregateKind !== "project"
              ? Effect.succeedNone
              : decodeProjectReceipt(receipt.value).pipe(Effect.asSome),
          ),
          Effect.mapError((cause) => new CommandReceiptStoreReadError({ commandId, cause })),
        ),
    } satisfies CommandReceiptStoreV2Shape);
  }),
);

export const layer = layerBase.pipe(Layer.provide(OrchestrationCommandReceipts.layer));

export const layerFromApplicationReceipts = layerBase;
