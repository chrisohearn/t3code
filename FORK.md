# Fork notes (chrisohearn/t3code)

This fork follows `pingdotgg/t3code` `main`. Its integration branch is `integration/mcp-events-20261109`, and the live server on Chris's machine runs its `v0.1.9-preview.*` releases. Keep fork changes small and in fork-only files where possible, so upstream merges stay cheap.

## Database migrations

Upstream owns every id in `effect_sql_migrations`. Effect's migrator skips every id up to the highest recorded one, so a fork migration that takes an upstream id silently blocks upstream's migration with that id, and upstream builds then refuse to start on the database.

- Put fork migrations in `apps/server/src/persistence/ForkMigrations/NNN_Name.ts` and register them in `ForkMigrations.ts`. They are recorded in `t3_fork_migrations`, with ids local to that table, and run after all upstream migrations.
- Never add a file to `apps/server/src/persistence/Migrations/` or an entry to `Migrations.ts` in the fork. Those come only from upstream merges.
- Never rename a fork migration. Startup (`repairForkMigrationHistory`) finds fork migrations that older fork builds recorded in `effect_sql_migrations` by name, moves them to `t3_fork_migrations` with their original `created_at`, and so lets upstream's migrations at those ids run. It runs in one transaction and does nothing once nothing is left to move.
- A fork migration name must never equal an upstream migration name; a test enforces it.
