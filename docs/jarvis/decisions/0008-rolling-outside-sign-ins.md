# Outside sign-ins roll for 30 days

Accepted 2026-11-12.

## Decision

Outside sign-ins use refresh tokens and a rolling 30-day session window. This supersedes the November 11 decision to defer refresh tokens.

## Alternatives

Require repeated manual sign-in or retain scheduled credential renewal scripts as the long-term solution.

## Why

Outside assistants need continuity without a recurring sign-in cliff. Refresh tokens make renewal part of the supported sign-in lifecycle. This record states the chosen behavior, not its implementation status.
