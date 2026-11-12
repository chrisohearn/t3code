import {
  AuthMcpTokenError,
  type AuthMcpClientAccess,
  type AuthClientMetadata,
  type AuthSessionId,
  mcpClientScopes,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as SessionStore from "./SessionStore.ts";

const IDLE_MS = 30 * 86400_000;
const ACCESS_PREFIX = "t3mcp_a_";

interface TokenPair {
  readonly sessionId: AuthSessionId;
  readonly token: string;
  readonly refreshToken: string;
  readonly expiresAt: DateTime.Utc;
  readonly access: AuthMcpClientAccess;
  readonly offlineAccess: boolean;
}

export class McpOAuthSessionStorageError extends Schema.TaggedError<McpOAuthSessionStorageError>()(
  "McpOAuthSessionStorageError",
  { cause: Schema.Defect() },
) {}

export class McpOAuthSessions extends Context.Service<
  McpOAuthSessions,
  {
    readonly issue: (input: {
      readonly clientId: string;
      readonly resource: string;
      readonly label: string;
      readonly access: AuthMcpClientAccess;
      readonly peerLink: boolean;
      readonly client: AuthClientMetadata;
      readonly offlineAccess?: boolean;
    }) => Effect.Effect<TokenPair, McpOAuthSessionStorageError>;
    readonly refresh: (input: {
      readonly clientId: string;
      readonly resource: string;
      readonly refreshToken: Redacted.Redacted<string>;
      readonly scope?: string;
    }) => Effect.Effect<TokenPair, AuthMcpTokenError | McpOAuthSessionStorageError>;
    readonly authenticate: (token: string) => Effect.Effect<
      | {
          readonly sessionId: AuthSessionId;
          readonly label: string;
          readonly access: AuthMcpClientAccess;
          readonly peerLink: boolean;
        }
      | undefined,
      McpOAuthSessionStorageError
    >;
  }
>()("t3/auth/McpOAuthSessions") {}

const invalidGrant = () =>
  new AuthMcpTokenError({
    error: "invalid_grant",
    error_description: "The renewal token is invalid or expired.",
  });

export const isRollingAccessToken = (token: string) => token.startsWith(ACCESS_PREFIX);

export const layer = Layer.effect(
  McpOAuthSessions,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const random = yield* SecureRandom.SecureRandom;
    const digest = yield* Digest.Digest;
    const sessions = yield* SessionStore.SessionStore;
    const hash = (token: string) =>
      digest
        .digest(Digest.sha256, new TextEncoder().encode(token))
        .pipe(Effect.map((bytes) => Buffer.from(bytes).toString("hex")));
    const storageError = (cause: unknown) => new McpOAuthSessionStorageError({ cause });
    // These helpers run inside the named operation's transaction and span.
    const mint = Effect.fnUntraced(function* (
      sessionId: AuthSessionId,
      access: AuthMcpClientAccess,
      offlineAccess: boolean,
      now: DateTime.Utc,
    ) {
      const token =
        ACCESS_PREFIX + Buffer.from(yield* random.randomBytes(32)).toString("base64url");
      const refreshToken =
        "t3mcp_r_" + Buffer.from(yield* random.randomBytes(32)).toString("base64url");
      const expiresAt = DateTime.add(now, { milliseconds: IDLE_MS });
      yield* sql`INSERT INTO mcp_oauth_tokens (token_hash, session_id, kind, expires_at)
      VALUES (${yield* hash(token)}, ${sessionId}, 'access', ${expiresAt.epochMilliseconds}),
             (${yield* hash(refreshToken)}, ${sessionId}, 'refresh', 0)`;
      yield* sql`DELETE FROM mcp_oauth_tokens WHERE session_id = ${sessionId}
      AND kind = 'access' AND expires_at <= ${now.epochMilliseconds}`;
      return { sessionId, token, refreshToken, expiresAt, access, offlineAccess };
    });
    const touch = (sessionId: AuthSessionId, now: DateTime.Utc) =>
      sql`UPDATE auth_sessions SET expires_at = ${DateTime.formatIso(DateTime.add(now, { milliseconds: IDLE_MS }))}
      WHERE session_id = ${sessionId} AND revoked_at IS NULL`;

    interface Credential {
      readonly sessionId: AuthSessionId;
      readonly clientId: string;
      readonly resource: string;
      readonly access: AuthMcpClientAccess;
      readonly peerLink: number;
      readonly offlineAccess: number;
      readonly label: string;
      readonly expiresAt: string;
      readonly revokedAt: string | null;
      readonly usedAt: number | null;
      readonly tokenExpiresAt: number;
    }
    const find = (tokenHash: string, kind: "access" | "refresh") => sql<Credential>`
    SELECT s.session_id AS "sessionId", s.client_id AS "clientId", s.resource,
      s.access, s.peer_link AS "peerLink", s.offline_access AS "offlineAccess", a.client_label AS label,
      a.expires_at AS "expiresAt", a.revoked_at AS "revokedAt",
      t.used_at AS "usedAt", t.expires_at AS "tokenExpiresAt"
    FROM mcp_oauth_tokens t JOIN mcp_oauth_sessions s ON s.session_id = t.session_id
    JOIN auth_sessions a ON a.session_id = s.session_id
    WHERE t.token_hash = ${tokenHash} AND t.kind = ${kind}`;

    return McpOAuthSessions.of({
      issue: Effect.fn("McpOAuthSessions.issue")((input) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const issued = yield* sessions.issue({
                subject: "mcp-client",
                method: "bearer-access-token",
                scopes: mcpClientScopes(input.access),
                ttl: Duration.days(30),
                client: { ...input.client, label: input.label, deviceType: "bot" },
              });
              yield* sql`INSERT INTO mcp_oauth_sessions (session_id, client_id, resource, access, peer_link, offline_access)
        VALUES (${issued.sessionId}, ${input.clientId}, ${input.resource}, ${input.access}, ${input.peerLink ? 1 : 0}, ${input.offlineAccess ? 1 : 0})`;
              return yield* mint(
                issued.sessionId,
                input.access,
                input.offlineAccess === true,
                yield* DateTime.now,
              );
            }),
          )
          .pipe(Effect.mapError(storageError)),
      ),
      refresh: Effect.fn("McpOAuthSessions.refresh")(function* (input) {
        const tokenHash = yield* hash(Redacted.value(input.refreshToken)).pipe(
          Effect.mapError(storageError),
        );
        const result = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const row = (yield* find(tokenHash, "refresh"))[0];
              if (
                row === undefined ||
                row.clientId !== input.clientId ||
                row.resource !== input.resource
              )
                return undefined;
              const now = yield* DateTime.now;
              if (row.usedAt !== null) {
                yield* sessions.revoke(row.sessionId);
                return undefined;
              }
              if (
                row.revokedAt !== null ||
                DateTime.makeUnsafe(row.expiresAt).epochMilliseconds <= now.epochMilliseconds
              )
                return undefined;
              const scopes = [
                ...mcpClientScopes(row.access),
                ...(row.offlineAccess === 1 ? ["offline_access"] : []),
              ];
              const requestedScopes = input.scope?.split(/\s+/u);
              if (
                requestedScopes !== undefined &&
                (requestedScopes.some((scope) => !scopes.includes(scope)) ||
                  scopes.some((scope) => !requestedScopes.includes(scope)))
              )
                return "invalid_scope" as const;
              yield* sql`UPDATE mcp_oauth_tokens SET used_at = ${now.epochMilliseconds} WHERE token_hash = ${tokenHash}`;
              yield* touch(row.sessionId, now);
              return yield* mint(row.sessionId, row.access, row.offlineAccess === 1, now);
            }),
          )
          .pipe(Effect.mapError(storageError));
        // Reuse revocation must commit before returning an OAuth error.
        if (result === "invalid_scope")
          return yield* new AuthMcpTokenError({
            error: "invalid_scope",
            error_description: "Scope changes require signing in again.",
          });
        return result === undefined ? yield* invalidGrant() : result;
      }),
      authenticate: Effect.fn("McpOAuthSessions.authenticate")(function* (token) {
        const tokenHash = yield* hash(token);
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const row = (yield* find(tokenHash, "access"))[0];
            const now = yield* DateTime.now;
            if (
              row === undefined ||
              row.revokedAt !== null ||
              row.tokenExpiresAt <= now.epochMilliseconds ||
              DateTime.makeUnsafe(row.expiresAt).epochMilliseconds <= now.epochMilliseconds
            )
              return undefined;
            yield* touch(row.sessionId, now);
            return {
              sessionId: row.sessionId,
              label: row.label,
              access: row.access,
              peerLink: row.peerLink === 1,
            };
          }),
        );
      }, Effect.mapError(storageError)),
    });
  }),
);
