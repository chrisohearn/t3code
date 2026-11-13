import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The MCP session (a digest of Mcp-Session-Id) a call arrived on, so several agents behind one
  // sign-in can be told apart.
  yield* sql`ALTER TABLE mcp_request_log ADD COLUMN connection TEXT`;
  // One row per caller with its latest call, so the agent registry pages without grouping the log.
  yield* sql`CREATE TABLE mcp_agent_summary (
    client TEXT PRIMARY KEY, last_id INTEGER NOT NULL, last_at INTEGER NOT NULL,
    last_tool TEXT NOT NULL, last_session TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX mcp_agent_summary_last ON mcp_agent_summary(last_id)`;
  yield* sql`INSERT INTO mcp_agent_summary (client, last_id, last_at, last_tool, last_session)
    SELECT client, id, started_at, tool, session FROM (
      SELECT client, id, started_at, tool, session,
        ROW_NUMBER() OVER (PARTITION BY client ORDER BY id DESC) AS newest
      FROM mcp_request_log
    ) WHERE newest = 1`;
});
