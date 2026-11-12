# Server-recorded message senders

Accepted 2026-11-12.

## Decision

MCP sends and posts retain a sender record from the authenticated sign-in context. It contains the server-stored client label, a 16-hex SHA-256 fingerprint of the sign-in session ID, and the authenticated outside-client or linked-agent classification. Local agents retain their validated sender thread ID. Read results and message events preserve the same record.

## Why

An agent authorship flag alone cannot distinguish the Jarvis inbox's outside senders. A session fingerprint distinguishes sign-ins without publishing their full identifiers or any token. Labels describe the approved client; the fingerprint identifies the sign-in. Existing messages remain unattributed rather than receiving an inferred sender.
