import * as ThreadLaunchMcp from "../../ThreadLaunchMcpService.ts";
import {
  OrchestratorMcpFailure,
  ProjectId,
  type Project as ProjectRecord,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Project from "../../../project/ProjectService.ts";
import * as ProjectCloneTracker from "../../../project/ProjectCloneTracker.ts";
import { mutateProjectWithClone } from "../../../project/ProjectMutation.ts";
import { temporaryFolderWarning } from "../../../project/temporaryFolder.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as Repositories from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { newCommandId, readCaller, unavailable } from "../../threadAccess.ts";
import { ProjectToolkit } from "./tools.ts";

function projectFailure(error: Project.ProjectServiceError) {
  if (error._tag === "ProjectOperationError") return unavailable();
  const message =
    error._tag === "ProjectInvalidError"
      ? error.detail
      : error._tag === "ProjectNotFoundError"
        ? "The project was not found."
        : error._tag === "ProjectConflictError"
          ? "The workspace is already registered to a project."
          : "The project is not empty; force=true is required to delete it.";
  return new OrchestratorMcpFailure({ code: "invalid_request", message });
}

const access = Effect.gen(function* () {
  yield* readCaller();
  return yield* Project.ProjectService;
});

/** Settings, not the project record, hold the default model and actions that new threads use. */
const withSavedProjectSettings = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService.pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.mapError(unavailable),
  );
  return (project: ProjectRecord) => {
    const resolved = resolveProjectSettings(settings, project.id, project);
    return {
      ...project,
      defaultModelSelection:
        resolved.sources.defaultModelSelection === "project"
          ? resolved.settings.defaultModelSelection
          : null,
      scripts: resolveProjectScripts(settings, project),
    };
  };
});

// The project is already committed, so a failed Settings read must not report the create as failed.
const withSavedProjectSettingsAfterCreate = withSavedProjectSettings.pipe(
  Effect.orElseSucceed(() => (project: ProjectRecord) => project),
);

export const layer = McpToolAccess.toLayer(ProjectToolkit, {
  t3_thread_launch: McpToolAccess.startsThreads(
    (input) => input,
    (input, { runtimeMode, interactionMode, linkOrigin }) =>
      Effect.gen(function* () {
        const service = yield* ThreadLaunchMcp.ThreadLaunchMcpService;
        return yield* service.launch(input, { runtimeMode, interactionMode, linkOrigin });
      }),
    // The launched thread carries the caller's link, if it has one.
    "stamped",
  ),
  t3_project_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const projects = yield* access;
      // Identities are resolved: linked environments find this side's project by repository.
      const page = yield* projects
        .listPage({ cursor: input.cursor ?? 0, limit: input.limit ?? 20 })
        .pipe(Effect.mapError(unavailable));
      return { ...page, projects: page.projects.map(yield* withSavedProjectSettings) };
    }),
  ),
  t3_project_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const projects = yield* access;
      const result = yield* projects.getById(input.projectId).pipe(Effect.mapError(unavailable));
      if (Option.isNone(result))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The project was not found.",
        });
      return (yield* withSavedProjectSettings)(result.value);
    }),
  ),
  t3_project_create: McpToolAccess.writesEnvironment(
    ({ workspaceRoot, ...input }) =>
      Effect.gen(function* () {
        const projects = yield* Project.ProjectService;
        if (workspaceRoot === undefined) {
          // Only updates record model defaults; reject defaults that creation would silently drop.
          if (
            input.scripts !== undefined ||
            input.trackedFolders !== undefined ||
            input.createWorkspaceRootIfMissing !== undefined ||
            input.defaultModelSelection !== undefined
          )
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message:
                "A project started from its title takes only a title; set scripts or defaultModelSelection afterwards with t3_project_update.",
            });
          const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
          const created = yield* folders.createNamedProject({ name: input.title }).pipe(
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({
                  code: "orchestration_error",
                  message: error.message,
                }),
            ),
          );
          const project = yield* projects
            .getById(created.projectId)
            .pipe(
              Effect.mapError(unavailable),
              Effect.flatMap(
                Option.match({ onNone: () => Effect.fail(unavailable()), onSome: Effect.succeed }),
              ),
            );
          return {
            ...(yield* withSavedProjectSettingsAfterCreate)(project),
            ...(created.commitError === undefined ? {} : { commitError: created.commitError }),
          };
        }
        if (input.defaultModelSelection !== undefined && input.defaultModelSelection !== null)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "Creating a project does not set its default model; set defaultModelSelection afterwards with t3_project_update.",
          });
        const commandId = yield* newCommandId();
        const created = yield* projects
          .create({ ...input, workspaceRoot, commandId, projectId: ProjectId.make(commandId) })
          .pipe(Effect.mapError(projectFailure));
        const project = (yield* withSavedProjectSettingsAfterCreate)(created);
        const warning = yield* temporaryFolderWarning(workspaceRoot);
        return warning === undefined ? project : { ...project, warning };
      }),
    // Linked work may bring the repository it works in; an existing
    // registered workspace is still refused.
    { linkedCallers: "allowed" },
  ),
  t3_project_update: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const projects = yield* Project.ProjectService;
      const updated = yield* projects
        .update({ ...input, commandId: yield* newCommandId() })
        .pipe(Effect.mapError(projectFailure));
      return (yield* withSavedProjectSettings)(updated);
    }),
  ),
  t3_project_delete: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
      if (yield* folders.isScratchProject(input.projectId))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            '"No project" is the built-in scratch project and cannot be deleted through MCP. The user can remove it in Settings.',
        });
      const projects = yield* Project.ProjectService;
      const clones = yield* ProjectCloneTracker.ProjectCloneTracker;
      return yield* mutateProjectWithClone(projects, clones, {
        ...input,
        type: "project.delete",
        commandId: yield* newCommandId(),
      }).pipe(Effect.mapError(projectFailure));
    }),
  ),
  t3_project_clone: McpToolAccess.writesEnvironment(
    (input) =>
      Effect.gen(function* () {
        const repositories = yield* Repositories.SourceControlRepositoryService;
        // Agents' MCP calls have their own long budget, and an aborted call interrupts git.
        return yield* repositories.cloneRepository(input, { timeoutMs: null }).pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: error.detail,
              }),
          ),
        );
      }),
    // An existing destination is never adopted.
    { linkedCallers: "allowed" },
  ),
});
