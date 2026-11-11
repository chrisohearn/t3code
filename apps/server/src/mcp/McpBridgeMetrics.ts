import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
export interface ToolCounts {
  readonly tool: string;
  readonly calls: number;
  readonly errors: number;
  readonly responseBytes: number;
}
export class McpBridgeMetrics extends Context.Service<
  McpBridgeMetrics,
  {
    readonly record: (
      sessionId: string,
      tool: string,
      error: boolean,
      responseBytes: number,
    ) => Effect.Effect<void>;
    readonly read: (sessionId: string) => Effect.Effect<ReadonlyArray<ToolCounts>>;
  }
>()("t3/mcp/McpBridgeMetrics") {}
export const layer = Layer.sync(McpBridgeMetrics, () => {
  const sessions = new Map<string, Map<string, ToolCounts>>();
  return McpBridgeMetrics.of({
    record: Effect.fn("McpBridgeMetrics.record")((sessionId, tool, error, responseBytes) =>
      Effect.sync(() => {
        const tools = sessions.get(sessionId) ?? new Map<string, ToolCounts>();
        const old = tools.get(tool);
        tools.set(tool, {
          tool,
          calls: (old?.calls ?? 0) + 1,
          errors: (old?.errors ?? 0) + Number(error),
          responseBytes: (old?.responseBytes ?? 0) + responseBytes,
        });
        // Most recently used last; the oldest sign-in's counters go first past the cap.
        sessions.delete(sessionId);
        sessions.set(sessionId, tools);
        if (sessions.size > 64) sessions.delete(sessions.keys().next().value!);
      }),
    ),
    read: Effect.fn("McpBridgeMetrics.read")((sessionId) =>
      Effect.sync(() =>
        [...(sessions.get(sessionId)?.values() ?? [])].sort((a, b) => a.tool.localeCompare(b.tool)),
      ),
    ),
  });
});
