import {
  CommandId,
  type OrchestrationV2ThreadShell,
  ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { threadHasUnfinishedWork } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ManagedProjectFolders from "./ManagedProjectFolders.ts";
import * as ProjectService from "./ProjectService.ts";

export class ScratchThreadPromotionError extends Schema.TaggedError<ScratchThreadPromotionError>()(
  "ScratchThreadPromotionError",
  {
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export class ScratchThreadPromotion extends Context.Service<
  ScratchThreadPromotion,
  {
    readonly file: (input: {
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
    }) => Effect.Effect<
      { readonly threadIds: ReadonlyArray<ThreadId> },
      ScratchThreadPromotionError
    >;
    /**
     * Turns a No project thread's folder into a project, in place, and moves every
     * thread working in that folder into it. Running it again finishes a partial move.
     */
    readonly promote: (input: {
      readonly threadId: ThreadId;
    }) => Effect.Effect<{ readonly projectId: ProjectId }, ScratchThreadPromotionError>;
  }
>()("t3/project/ScratchThreadPromotion") {}

const make = Effect.gen(function* () {
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const random = yield* SecureRandom.SecureRandom;
  const path = yield* Path.Path;

  const fail = (reason: string) => (cause: unknown) =>
    new ScratchThreadPromotionError({ reason, cause });

  const promote: ScratchThreadPromotion["Service"]["promote"] = Effect.fn(
    "ScratchThreadPromotion.promote",
  )(function* (input) {
    const thread = yield* threads.getThreadShell(input.threadId).pipe(
      Effect.mapError(fail("Could not read the thread.")),
      Effect.filterOrFail(
        (shell) => shell !== null,
        () => new ScratchThreadPromotionError({ reason: "Thread not found." }),
      ),
    );
    const project = yield* projects
      .getById(thread.projectId)
      .pipe(Effect.mapError(fail("Could not read the thread's project.")));
    const folder = thread.worktreePath ?? Option.getOrUndefined(project)?.workspaceRoot;
    const scratchRoot = Option.getOrUndefined(yield* managedFolders.scratchRoot);
    const isScratch = yield* managedFolders.isScratchProject(thread.projectId);
    // A thread already rooted at its folder is a partial earlier promotion; finish it.
    const alreadyPromoted =
      Option.isSome(project) && project.value.workspaceRoot === folder && !isScratch;
    if (
      folder === undefined ||
      scratchRoot === undefined ||
      path.dirname(folder) !== scratchRoot ||
      !(isScratch || alreadyPromoted)
    ) {
      return yield* new ScratchThreadPromotionError({
        reason: "Only a No project thread with its own folder can become a project.",
      });
    }

    const snapshot = yield* Effect.flatten(
      threads.readShellSnapshot({ worktreePath: folder }),
    ).pipe(Effect.mapError(fail("Could not read the threads in this folder.")));
    const moveSet = new Map<ThreadId, OrchestrationV2ThreadShell>();
    if (isScratch) moveSet.set(thread.id, thread);
    for (const candidate of [...snapshot.threads, ...snapshot.archivedThreads]) {
      if (yield* managedFolders.isScratchProject(candidate.projectId)) {
        moveSet.set(candidate.id, candidate);
      }
    }

    for (const candidate of moveSet.values()) {
      const records = yield* threads
        .getThreadRecords(candidate.id, ["runs", "runtimeRequests"], { turnItemTypes: [] })
        .pipe(Effect.mapError(fail(`Could not read "${candidate.title}".`)));
      if (threadHasUnfinishedWork(records)) {
        return yield* new ScratchThreadPromotionError({
          reason: `"${candidate.title}" is still working. Finish or stop it first.`,
        });
      }
    }

    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const projectId = yield* createProject(thread.title, folder);
        yield* scheduledTasks
          .moveThreadTasks({ threadIds: [...moveSet.keys()], projectId })
          .pipe(Effect.mapError(fail("Could not move the thread's scheduled tasks.")));
        for (const candidate of moveSet.values()) {
          const commandId = CommandId.make(`scratch-promotion:${yield* randomId}`);
          yield* threads
            .dispatch({
              type: "thread.project.adopt-folder",
              commandId,
              threadId: candidate.id,
              projectId,
            })
            .pipe(Effect.mapError(fail(`Could not move "${candidate.title}". Try again.`)));
        }
        return { projectId };
      }),
    );
  });

  const file: ScratchThreadPromotion["Service"]["file"] = Effect.fn("ScratchThreadPromotion.file")(
    function* (input) {
      const thread = yield* threads.getThreadShell(input.threadId).pipe(
        Effect.mapError(fail("Could not read the thread.")),
        Effect.filterOrFail(
          (shell) => shell !== null,
          () => new ScratchThreadPromotionError({ reason: "Thread not found." }),
        ),
      );
      if (thread.deletedAt !== null) {
        return yield* new ScratchThreadPromotionError({ reason: "Thread not found." });
      }
      const folder = thread.worktreePath;
      const scratchRoot = Option.getOrUndefined(yield* managedFolders.scratchRoot);
      const isScratch = yield* managedFolders.isScratchProject(thread.projectId);
      if (
        folder === null ||
        scratchRoot === undefined ||
        path.dirname(folder) !== scratchRoot ||
        !(isScratch || thread.projectId === input.projectId)
      ) {
        return yield* new ScratchThreadPromotionError({
          reason: "Only a No project thread with its own folder can be filed into a project.",
        });
      }
      const target = yield* projects
        .getById(input.projectId)
        .pipe(Effect.mapError(fail("Could not read the target project.")));
      if (
        Option.isNone(target) ||
        target.value.deletedAt !== null ||
        (yield* managedFolders.isScratchProject(input.projectId))
      ) {
        return yield* new ScratchThreadPromotionError({ reason: "Target project not found." });
      }
      if (target.value.workspaceRoot === folder) {
        return yield* new ScratchThreadPromotionError({
          reason: "This folder is the target project's root. Promote it instead.",
        });
      }
      const snapshot = yield* Effect.flatten(
        threads.readShellSnapshot({ worktreePath: folder }),
      ).pipe(Effect.mapError(fail("Could not read the threads in this folder.")));
      const all = [...snapshot.threads, ...snapshot.archivedThreads];
      const moveSet = new Map<ThreadId, OrchestrationV2ThreadShell>();
      if (isScratch) moveSet.set(thread.id, thread);
      for (const candidate of all) {
        if (
          candidate.worktreePath === folder &&
          (yield* managedFolders.isScratchProject(candidate.projectId))
        ) {
          moveSet.set(candidate.id, candidate);
        }
      }
      for (const candidate of isScratch ? moveSet.values() : [thread, ...moveSet.values()]) {
        const family = yield* Effect.flatten(
          threads.readShellSnapshot({ familyOf: candidate.id }),
        ).pipe(Effect.mapError(fail(`Could not read "${candidate.title}".`)));
        if (
          candidate.lineage.parentThreadId !== null ||
          [...family.threads, ...family.archivedThreads].some(
            (child) => child.lineage.parentThreadId === candidate.id,
          )
        ) {
          return yield* new ScratchThreadPromotionError({
            reason: `"${candidate.title}" has a parent or child thread. It cannot be filed separately.`,
          });
        }
        const records = yield* threads
          .getThreadRecords(candidate.id, ["runs", "runtimeRequests"], { turnItemTypes: [] })
          .pipe(Effect.mapError(fail(`Could not read "${candidate.title}".`)));
        if (threadHasUnfinishedWork(records)) {
          return yield* new ScratchThreadPromotionError({
            reason: `"${candidate.title}" is still working. Finish or stop it first.`,
          });
        }
      }
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const threadIds = [...moveSet.keys()];
          yield* scheduledTasks
            .moveThreadTasks({ threadIds, projectId: input.projectId })
            .pipe(Effect.mapError(fail("Could not move the thread's scheduled tasks.")));
          for (const candidate of moveSet.values()) {
            yield* threads
              .dispatch({
                type: "thread.project.file-scratch",
                commandId: CommandId.make(`scratch-filing:${yield* randomId}`),
                threadId: candidate.id,
                projectId: input.projectId,
              })
              .pipe(Effect.mapError(fail(`Could not move "${candidate.title}". Try again.`)));
          }
          return { threadIds };
        }),
      );
    },
  );

  const randomId = random.uuidV4();

  // bootstrap returns the project that already owns the folder, so retries reuse it.
  const createProject = Effect.fn("ScratchThreadPromotion.createProject")(function* (
    title: string,
    workspaceRoot: string,
  ) {
    const id = yield* randomId;
    return yield* projects
      .bootstrap({
        commandId: CommandId.make(`scratch-promotion-project:${id}`),
        projectId: ProjectId.make(id),
        title,
        workspaceRoot,
      })
      .pipe(
        Effect.map(({ project }) => project.id),
        // bootstrap reads before locking; racing creates return the winner in a conflict.
        Effect.catchTags({
          ProjectConflictError: (conflict) => Effect.succeed(conflict.conflictingProjectId),
        }),
        Effect.mapError(fail("Could not create the project.")),
      );
  });

  return ScratchThreadPromotion.of({ promote, file });
});

export const layer = Layer.effect(ScratchThreadPromotion, make);
