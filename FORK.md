# Fork notes (chrisohearn/t3code)

This fork follows `pingdotgg/t3code` `main`. Its integration branch is `integration/mcp-events-20261109`, and the live server on Chris's machine runs its fork preview releases. Keep fork changes small and in fork-only files where possible, so upstream merges stay cheap.

## Database migrations

Upstream owns every id in `effect_sql_migrations`. Effect's migrator skips every id up to the highest recorded one, so a fork migration that takes an upstream id silently blocks upstream's migration with that id, and upstream builds then refuse to start on the database.

- Put fork migrations in `apps/server/src/persistence/ForkMigrations/NNN_Name.ts` and register them in `ForkMigrations.ts`. They are recorded in `t3_fork_migrations`, with ids local to that table, and run after all upstream migrations.
- Never add a file to `apps/server/src/persistence/Migrations/` or an entry to `Migrations.ts` in the fork. Those come only from upstream merges.
- Never rename a fork migration. Startup (`repairForkMigrationHistory`) finds fork migrations that older fork builds recorded in `effect_sql_migrations` by name, moves them to `t3_fork_migrations` with their original `created_at`, and so lets upstream's migrations at those ids run. It runs in one transaction and does nothing once nothing is left to move.
- A fork migration name must never equal an upstream migration name; a test enforces it.

### Assigning fork migration ids

Effect applies only migration ids above the highest applied id. Landing a higher
id first can therefore prevent a lower migration from ever running.

Assign the final id at merge time: fetch `origin/integration/mcp-events-20261109`,
inspect its `ForkMigrations.ts`, and use the highest id on that tip plus one.
Re-check the tip immediately before merging. A PR containing a migration merges
only when every lower id is already on the tip; never merge it while a lower-id
migration PR is unmerged. Earlier allocations are provisional. When the final id
changes, update the unmerged candidate and repeat its migration checks and hosted
gates. Never renumber a merged migration.

Keep the existing registry test in
[`ForkMigrations.test.ts`](apps/server/src/persistence/ForkMigrations.test.ts): it
checks registration against migration files and requires unique, strictly
increasing ids. It cannot enforce the order in which separate PRs merge; the tip
check remains required.

## Post-merge CI

Upstream's `ci.yml` runs on pull requests and on pushes to `main`, and this fork never pushes to `main`, so a merge into the integration branch was never re-verified. `.github/workflows/fork-integration-ci.yml` runs every `ci.yml` job on each push to `integration/mcp-events-20261109`. It is generated: `scripts/fork/sync-integration-ci.sh` copies `ci.yml`'s jobs under a new trigger, which keeps `ci.yml` untouched. After an upstream merge that changes `ci.yml`, run the script and commit the result. The workflow's first job warns when the copy is stale.

## Upstream sync and releases

`scripts/fork/upstream-sync.sh` runs hourly from a T3 scheduled task on Chris's machine (it needs Chris's `gh` login, Docker, and read access to the live database for the preflight). It:

1. Fetches upstream `main`. If the integration branch already contains it, it verifies that the integration tree is published and retries an unfinished publication.
2. Merges it on a `sync/upstream-<UTC stamp>` branch, or re-checks an open `sync/upstream-*` PR (one a failed run opened, or an agent's conflict fix). `agentContextBudget.json` conflicts are taken from upstream and re-measured.
3. Runs format, lint, typecheck and the server tests. Every test must pass; pre-existing failures still block publication.
4. Builds the release in a container (`scripts/fork/build-release.sh`, the recipe every `v0.1.9-preview.*` release used) and smoke-tests it, then runs the built CLI's `__service-preflight` read-only against the live database for launcher protocols 3 and 4. The same output reports each configured Codex instance's shadow home; an instance whose shadow the new build would refuse to set up (`not-ready`) or could not inspect (`unknown`) stops the release, while `auto-settle` ones, which the build moves aside into a dated backup beside the shadow, do not.
5. When all of that and the hosted checks pass, it merges the PR and publishes `v<upstream nightly core>-preview.<UTC date>.<n>` with the tarball and `SHA256SUMS` (`scripts/fork/publish-release.sh`). The host's update guard then installs it when no threads are running.

A conflict opens (or updates) an issue labelled `upstream-sync`, or comments on the open sync PR. A failed check opens a PR that says what failed. Neither publishes anything. The scheduled agent watches a pending PR and resumes on CI/review completion, so publication need not wait until the next hourly check. An existing candidate is completed before newer upstream changes are added, preventing repeated CI resets. Exit codes: 0 done or nothing to do, 3 conflict, 4 failed check, 2 environment problem.

To release by hand from a clean, merged integration commit: `scripts/fork/build-release.sh <version>`, then `scripts/fork/publish-release.sh <version> <artifacts-dir> <merge-commit> "<notes>"`. Versions must sort above every earlier fork release under `sort -V`, because the guard installs the newest one.

The host update guard that installs these releases lives in `scripts/fork/host/t3-update-guard/` (see its README). It waits up to 30 min for an idle server, then forces the update after a bounded wait for pending approvals and in-flight tool calls. It never stops the service while the kernel shows the exit hang, and it reports which interrupted threads continued. Change it here, run `test-guard.sh`, then install it.

The service's `T3CODE_RELEASE_BASE_URL` selects the fork feed for both metadata and
self-update targets. An upstream desktop's exact nightly target resolves to the
newest published fork archive for the host platform; exact fork versions remain
exact. Feed failures never fall back to npm or upstream archives. The service
launcher and runtime must be upgraded together through `t3-service-update`, which
waits for idle and snapshots the stopped database before changing it.

Fork release cores use upstream's `scripts/resolve-nightly-release.ts`, which
previews the next patch after the checked-in desktop version. Using the stable
package core directly leaves nightly clients reporting version skew even after
an upstream sync.
