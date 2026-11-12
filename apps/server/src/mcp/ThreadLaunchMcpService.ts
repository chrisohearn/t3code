import * as ThreadNotifications from "./ThreadNotifications.ts";
import { McpThreadNotify, McpThreadNotifyResult } from "@t3tools/contracts";
import {
  CommandId,
  MessageId,
  ThreadId,
  OrchestratorMcpFailure,
  ProjectId,
} from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { OrchestratorRuntimeModeAboveCeilingError } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadMessageIntake from "../orchestration-v2/ThreadMessageIntake.ts";
import * as Claims from "../orchestration-v2/AttachmentClaims.ts";
import * as Project from "../project/ProjectService.ts";

import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as DateTime from "effect/DateTime";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveRuntimeMode } from "./delegatedTaskModes.ts";
import { requireAdvertisedModel } from "./providerModels.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

import { newCommandId, readCaller, resolveProjectId, unavailable } from "./threadAccess.ts";

import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as McpClientThreads from "../persistence/McpClientThreads.ts";
import { McpAttachmentInput } from "./toolkits/attachment/input.ts";
import {
  OrchestratorMcpClientRequestId,
  OrchestratorMcpEnvironmentTarget,
  TrimmedNonEmptyString,
  ModelSelection,
  RuntimeMode,
  ProviderInteractionMode,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  OrchestrationV2DelegatedFrom,
  RunId,
  OrchestrationV2RunStatus,
  type OrchestrationV2LinkOrigin,
} from "@t3tools/contracts";

const isAboveCeilingError = Schema.is(OrchestratorRuntimeModeAboveCeilingError);

export const launchInput = Schema.Struct({
  notify: Schema.optional(McpThreadNotify),
  environmentId: OrchestratorMcpEnvironmentTarget,
  projectId: Schema.optional(ProjectId),
  scratch: Schema.optional(
    Schema.Boolean.annotate({
      description: "No project: a new Scratch folder. Not with `projectId` or `workspaceStrategy`.",
    }),
  ),
  title: TrimmedNonEmptyString,
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  workspaceStrategy: Schema.optional(
    OrchestrationV2ThreadLaunchWorkspaceStrategy.annotate({
      description:
        "'worktree': new checkout from `baseRef`. Honor a requested base. Otherwise, independent work uses the default branch as `remote/branch` (e.g. `origin/main`) with `startFromOrigin: true`; with no remote, use the local default branch. Required unpublished commits and dependent or stacked work use their local base with `startFromOrigin: false`. 'existing_worktree': bind `worktreePath`, a project worktree. 'root': project checkout, the default, not your worktree. Uncommitted edits are not copied.",
    }),
  ),
  message: Schema.optional(
    Schema.String.check(Schema.isMaxLength(120000)).annotate({
      description: "First prompt. Omit it and `attachments` for idle.",
    }),
  ),
  attachments: Schema.optional(Schema.Array(McpAttachmentInput).check(Schema.isMaxLength(8))),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
  /** Set by a linked environment launching its agent's delegated task here; ignored otherwise. */
  delegatedFrom: Schema.optional(OrchestrationV2DelegatedFrom),
});
export const launchResult = Schema.Struct({
  notify: Schema.optional(McpThreadNotifyResult),
  threadId: ThreadId,
  link: Schema.optional(Schema.String),
  projectId: ProjectId,
  modelSelection: ModelSelection,
  runId: Schema.NullOr(RunId),
  status: Schema.NullOr(OrchestrationV2RunStatus),
});
function worktreeCheckHint(
  error:
    | ThreadLaunch.ThreadLaunchBaseRefError
    | ThreadLaunch.ThreadLaunchBranchConflictError
    | ThreadLaunch.ThreadLaunchNotRepositoryError,
  strategy: { readonly startFromOrigin?: boolean | undefined },
) {
  if (error._tag === "ThreadLaunchNotRepositoryError")
    return `Use workspaceStrategy: {type: "root"}, or pass the projectId of a Git repository.`;
  if (error._tag === "ThreadLaunchBranchConflictError") {
    const sibling = error.branch.replaceAll("/", "-");
    return `Use a name that does not nest under or contain an existing branch${
      sibling === error.branch ? "" : `, such as "${sibling}"`
    }.`;
  }
  return `Pass a branch, tag, or commit that exists there${
    strategy.startFromOrigin === true
      ? "; the project has no usable remote to fetch it from."
      : ", or set startFromOrigin:true if it exists only on a remote."
  }`;
}

/** Require project worktrees so launches cannot target arbitrary host directories. */
const assertProjectWorktree = Effect.fn("mcp.assertProjectWorktree")(function* (
  workspaceRoot: string,
  worktreePath: string,
) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fileSystem = yield* FileSystem.FileSystem;
  const real = (path: string) => fileSystem.realPath(path).pipe(Effect.orElseSucceed(() => path));
  const worktrees = yield* git.listWorktreePaths(workspaceRoot).pipe(
    Effect.flatMap((paths) => Effect.forEach(paths, real)),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );
  if (!worktrees.includes(yield* real(worktreePath)))
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        "worktreePath must be one of the project's git worktrees. t3_worktree_list shows them.",
    });
});

/** A fixed-length id, so a long key fits in the scratch folder name derived from it. */
const launchCommandId = Effect.fn("mcp.launchCommandId")(function* (
  namespace: string,
  key: string,
) {
  const crypto = yield* Digest.Digest;
  // @effect-diagnostics-next-line globalJsonInEffect:off - a JSON pair keeps the caller apart from the key.
  const bytes = new TextEncoder().encode(JSON.stringify([namespace, key]));
  const digest = yield* crypto.digest(Digest.sha256, bytes).pipe(Effect.mapError(unavailable));
  return CommandId.make(`mcp:launch:${Hex.encode(digest)}`);
});

const launch = Effect.fn("ThreadLaunchMcpService.launch")(
  (
    input: typeof launchInput.Type,
    {
      runtimeMode,
      interactionMode,
      linkOrigin,
    }: {
      runtimeMode: RuntimeMode;
      interactionMode: ProviderInteractionMode;
      linkOrigin?: OrchestrationV2LinkOrigin | undefined;
    },
  ) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const context = yield* readCaller();
      const { caller } = context;
      // A retry with the same key replays the first launch: the ids derive
      // from the caller and the key, and the launch service replays a
      // command it already accepted.
      const commandId =
        input.clientRequestId === undefined
          ? yield* newCommandId()
          : yield* launchCommandId(scope.requestNamespace, input.clientRequestId);
      const threadId = ThreadId.make(commandId);
      const messageId = MessageId.make(commandId);
      const attachments = input.attachments ?? [];
      if (attachments.some((attachment) => !Claims.attachmentIsPendingUpload(attachment)))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "A new thread accepts only pending attachment uploads.",
        });
      if (
        input.scratch === true &&
        (input.projectId !== undefined || input.workspaceStrategy !== undefined)
      )
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "scratch:true picks its own project and folder; omit projectId and workspaceStrategy.",
        });
      const projectId =
        input.scratch === true
          ? (yield* ManagedProjectFolders.ManagedProjectFolders.pipe(
              Effect.flatMap((folders) => folders.ensureScratchProject),
              Effect.mapError(
                (error) =>
                  new OrchestratorMcpFailure({
                    code: "orchestration_error",
                    message: error.message,
                  }),
              ),
            )).projectId
          : yield* resolveProjectId(context, input.projectId);
      // A retry of an accepted launch replays it: it keeps the model it started
      // with and skips the checks only a new launch needs, which the project
      // may no longer pass, such as a base branch deleted since.
      const launched =
        input.clientRequestId === undefined
          ? null
          : yield* context.threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
      const launchedModel =
        launched === null || launched.deletedAt !== null ? undefined : launched.modelSelection;
      const replaying = launchedModel !== undefined;
      const project = replaying
        ? undefined
        : yield* Project.ProjectService.pipe(
            Effect.flatMap((projects) => projects.getById(projectId)),
            Effect.mapError(unavailable),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    new OrchestratorMcpFailure({
                      code: "invalid_request",
                      message: "The project was not found.",
                    }),
                  ),
                onSome: Effect.succeed,
              }),
            ),
          );
      if (project !== undefined && input.workspaceStrategy?.type === "existing_worktree")
        yield* assertProjectWorktree(project.workspaceRoot, input.workspaceStrategy.worktreePath);
      if (!replaying && input.modelSelection !== undefined) {
        const { instanceId, model } = input.modelSelection;
        const providers = yield* (yield* ProviderRegistry.ProviderRegistry).getProviders;
        const provider = providers.find((candidate) => candidate.instanceId === instanceId);
        if (provider !== undefined) yield* requireAdvertisedModel(provider, model);
      }
      // Reject unresolved base refs and blocked branch names before accepting a launch; worktree provisioning happens later.
      const strategy = input.workspaceStrategy;
      if (!replaying && strategy?.type === "worktree")
        yield* ThreadLaunch.ThreadLaunchService.pipe(
          Effect.flatMap((launches) =>
            launches.checkWorktreeBase({ projectId, workspaceStrategy: strategy }),
          ),
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({
                code: "invalid_request",
                message: `${error.message} No thread was created. ${worktreeCheckHint(error, strategy)}`,
              }),
          ),
        );
      // A caller outside a thread has nothing to inherit, so it starts with the
      // project's effective defaults, as the composer does. Its mode stays
      // within the ceiling it was approved with.
      const projectDefaults =
        caller === undefined && project !== undefined
          ? yield* ServerSettings.ServerSettingsService.pipe(
              Effect.flatMap((settings) => settings.getSettings),
              Effect.mapError(unavailable),
              Effect.map(
                (settings) => resolveProjectSettings(settings, projectId, project).settings,
              ),
            )
          : undefined;
      const modelSelection =
        input.modelSelection ??
        launchedModel ??
        caller?.modelSelection ??
        (projectDefaults
          ? resolveNewThreadModelSelection({
              defaultSelection: projectDefaults.defaultModelSelection,
              fallbackSelection: projectDefaults.fallbackModelSelection,
              providers: yield* ProviderRegistry.ProviderRegistry.pipe(
                Effect.flatMap((registry) => registry.getProviders),
              ),
              settings: projectDefaults,
              projectId,
              now: DateTime.toEpochMillis(yield* DateTime.now),
            }).selection
          : null) ??
        undefined;
      if (modelSelection === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "Pass modelSelection: the project has no default model. orchestrator_capabilities lists providers and models.",
        });
      let startedRuntimeMode =
        projectDefaults !== undefined && input.runtimeMode === undefined
          ? yield* resolveRuntimeMode(runtimeMode, projectDefaults.defaultRuntimeMode).pipe(
              Effect.orElseSucceed(() => runtimeMode),
            )
          : runtimeMode;
      if (!replaying) {
        const providers = yield* (yield* ProviderRegistry.ProviderRegistry).getProviders;
        startedRuntimeMode = yield* resolveRuntimeMode(startedRuntimeMode, input.runtimeMode, {
          modelSelection,
          supportedRuntimeModes: providers.find(
            (provider) => provider.instanceId === modelSelection.instanceId,
          )?.supportedRuntimeModes,
        });
      }
      const notification = yield* ThreadNotifications.prepare(input.notify);
      const result = yield* ThreadMessageIntake.launchThread({
        commandId,
        threadId,
        projectId,
        title: input.title,
        modelSelection,
        runtimeMode: startedRuntimeMode,
        interactionMode,
        workspaceStrategy: input.workspaceStrategy ?? { type: "root" },
        ...(input.message === undefined && attachments.length === 0
          ? {}
          : {
              initialMessage: {
                messageId,
                ...(caller === undefined ? {} : { senderThreadId: caller.id }),
                text: input.message ?? "",
                attachments,
              },
            }),
        createdBy: "agent",
        creationSource: "mcp",
        ...(linkOrigin === undefined ? {} : { linkOrigin }),
        // Kept only alongside linkOrigin: thread.create drops it otherwise.
        ...(input.delegatedFrom === undefined ? {} : { delegatedFrom: input.delegatedFrom }),
      }).pipe(
        Effect.mapError((error) => {
          if (error._tag === "AttachmentClaimError") {
            return new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: error.message,
            });
          }
          if (error._tag === "ThreadManagementProviderInstanceDisabledError") {
            return new OrchestratorMcpFailure({
              code: "invalid_request",
              message: error.message,
            });
          }
          // The administrator's ceiling refuses the mode; say so rather than "unavailable".
          if (error._tag === "ThreadLaunchError" && isAboveCeilingError(error.cause)) {
            return new OrchestratorMcpFailure({
              code: "invalid_request",
              message: error.cause.message,
            });
          }
          return unavailable();
        }),
      );
      const thread = result.projection.thread;
      if (
        scope.thread === undefined &&
        scope.client !== undefined &&
        scope.client.linked !== true
      ) {
        // The thread already exists; failing here would invite a duplicate relaunch.
        yield* (yield* McpClientThreads.McpClientThreads)
          .record({
            threadId: thread.id,
            sessionId: scope.client.sessionId,
            clientLabel: scope.client.label,
          })
          .pipe(Effect.ignore({ log: true }));
      }
      const run = result.projection.runs.find((run) => run.userMessageId === messageId);
      const notify = yield* ThreadNotifications.finish(
        notification,
        thread.id,
        run?.id,
        input.clientRequestId,
      );
      return {
        ...(notify === undefined ? {} : { notify }),
        threadId: thread.id,
        link: McpInvocationContext.threadLinkFor(scope, thread.id, thread.title),
        projectId: thread.projectId,
        modelSelection: thread.modelSelection,
        runId: run?.id ?? null,
        status: run?.status ?? null,
      };
    }),
);
export class ThreadLaunchMcpService extends Context.Service<
  ThreadLaunchMcpService,
  { readonly launch: typeof launch }
>()("t3/mcp/ThreadLaunchMcpService") {}
export const layer = Layer.succeed(ThreadLaunchMcpService, { launch });
