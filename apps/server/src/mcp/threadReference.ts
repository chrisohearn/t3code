import {
  type EnvironmentId,
  OrchestratorMcpFailure,
  type OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import { parseThreadLinkHref, threadLinkCandidates } from "@t3tools/shared/threadLinks";
import * as Effect from "effect/Effect";

import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

type Threads = Pick<
  ThreadManagement.ThreadManagementService["Service"],
  "getThreadShell" | "listActiveShellIndex"
>;

const unavailable = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "The operation could not be completed.",
  });

const LINK_PREFIXES = ["t3-thread://", "https://", "http://"];
const MAX_SUGGESTIONS = 3;

/** The id-like core of a reference, without `mcp:`, `mcp:launch:` or a uuid's dashes. */
const idCore = (threadId: string) =>
  threadId
    .replace(/^mcp:(launch:)?/, "")
    .replaceAll("-", "")
    .toLowerCase();

/**
 * Outside clients get hosted links that escape `mcp:` as `mcp%3A`, and models often drop it and
 * pass the bare uuid. Reads have no per-thread grant, so the id is resolved here instead of
 * hinted; write tools keep their exact-id checks.
 */
const alternate = (threadId: ThreadId): ThreadId | undefined => {
  if (threadId.startsWith("mcp:launch:")) return undefined;
  if (threadId.startsWith("mcp:")) return ThreadId.make(threadId.slice(4));
  return ThreadId.make(`mcp:${threadId}`);
};

const closestMatches = Effect.fn("mcp.threadReference.closestMatches")(function* (
  threads: Threads,
  reference: ThreadId,
) {
  const core = idCore(reference);
  if (core.length < 6) return [];
  const prefix = core.slice(0, 8);
  const index = yield* threads.listActiveShellIndex().pipe(Effect.orElseSucceed(() => []));
  return index
    .map((entry) => entry.id)
    .filter((id) => idCore(id).startsWith(prefix))
    .slice(0, MAX_SUGGESTIONS);
});

/**
 * Resolves what an agent passed as a thread to read: a thread id, a `t3-thread://` v1 or v2 link,
 * a hosted thread link, a bare uuid of an `mcp:` thread, or an `mcp:launch:` id.
 */
export const resolveReadableThread = Effect.fn("mcp.resolveReadableThread")(function* (
  threads: Threads,
  environmentId: EnvironmentId,
  reference: ThreadId,
) {
  let candidates: ReadonlyArray<ThreadId> = [reference];
  if (LINK_PREFIXES.some((prefix) => reference.startsWith(prefix))) {
    const link = parseThreadLinkHref(reference);
    if (link === null) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `threadId ${reference} is not a thread link. Pass a thread id such as \`mcp:<uuid>\`, a t3-thread:// link, or a hosted /threads/<environment>/<thread> link.`,
      });
    }
    if (link.environmentId !== null && link.environmentId !== environmentId) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `That link names environment ${link.environmentId}, not this one (${environmentId}). Pass environmentId: "${link.environmentId}" and threadId: "${link.threadId}".`,
      });
    }
    candidates = threadLinkCandidates(link, environmentId).map((ref) => ref.threadId);
  }
  const shellOf = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
  // The id as given wins, deleted or not; another spelling stands in only for an id never here.
  for (const candidate of candidates) {
    const shell: OrchestrationV2ThreadShell | null = yield* shellOf(candidate);
    if (shell === null) continue;
    if (shell.deletedAt === null) return { threadId: candidate, shell };
    return yield* new OrchestratorMcpFailure({
      code: "thread_not_found",
      message: `Thread ${candidate} was deleted.`,
    });
  }
  let deleted: ThreadId | undefined;
  for (const candidate of candidates) {
    const other = alternate(candidate);
    if (other === undefined) continue;
    const shell = yield* shellOf(other);
    if (shell === null) continue;
    if (shell.deletedAt === null) return { threadId: other, shell };
    deleted ??= other;
  }
  if (deleted !== undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "thread_not_found",
      message: `Thread ${deleted} was deleted.`,
    });
  }
  const matches = yield* closestMatches(threads, candidates[0] ?? reference);
  return yield* new OrchestratorMcpFailure({
    code: "thread_not_found",
    message:
      matches.length > 0
        ? `No thread ${reference} in this environment. Closest: ${matches.map((id) => `\`${id}\``).join(", ")}.`
        : `No thread ${reference} in this environment (${environmentId}). For a linked environment's thread, pass its environmentId (t3_environment_links); t3_thread_search finds threads by title.`,
  });
});
