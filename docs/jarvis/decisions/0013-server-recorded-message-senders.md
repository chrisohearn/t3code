# Server-recorded message senders

Accepted 2026-11-12.

## Decision

MCP sends and posts retain a sender record from the authenticated sign-in context. It contains the server-stored client label, the first eight characters of the sign-in session ID, the authenticated outside-client or linked-agent classification, and its read-only, approval-required or full-access tier. Non-admin operate modes use the approval-required tier. The payload field is `senderClient`. Local agents retain their validated sender thread ID. Read results and message events preserve the same record.

## Why

An agent authorship flag alone cannot distinguish the Jarvis inbox's outside senders. A short session identifier helps distinguish sign-ins without publishing their full identifiers or any token. Labels describe the approved client. Existing messages remain unattributed rather than receiving an inferred sender.
