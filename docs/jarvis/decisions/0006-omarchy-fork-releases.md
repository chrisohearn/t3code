# Omarchy runs guarded fork previews

Accepted 2026-11-11.

## Decision

Omarchy is the first machine for this workflow and continues to run fork preview releases. Service changes go through the guarded fork updater.

## Alternatives

Move off the preview channel to reduce interruptions, install upstream builds, or move execution to another machine first.

## Why

Chris chose to keep receiving fork changes. Reliability therefore has to protect active work during updates rather than depend on freezing releases. Fork-only database history also makes an upstream installation unsuitable for this service.
