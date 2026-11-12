import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE mcp_oauth_sessions (
    session_id TEXT PRIMARY KEY REFERENCES auth_sessions(session_id),
    client_id TEXT NOT NULL, resource TEXT NOT NULL, access TEXT NOT NULL,
    peer_link INTEGER NOT NULL, offline_access INTEGER NOT NULL
  )`;
  yield* sql`CREATE TABLE mcp_oauth_tokens (
    token_hash TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES mcp_oauth_sessions(session_id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('access', 'refresh')),
    expires_at INTEGER NOT NULL, used_at INTEGER
  )`;
  yield* sql`CREATE INDEX mcp_oauth_tokens_session ON mcp_oauth_tokens(session_id)`;
});
