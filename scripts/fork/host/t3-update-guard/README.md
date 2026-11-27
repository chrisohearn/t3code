# T3 update guard (host files)

These are the files that keep the T3 background service on Chris's Omarchy machine on a verified fork release. Until 2026-11-13 they lived only on that host. They are kept here so that changes go through review and CI like the rest of the fork.

| File                                                                                         | Installed at                                                                                        |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `guard`                                                                                      | `~/.local/libexec/t3-update-guard/guard`                                                            |
| `t3-service-update`                                                                          | `~/.local/bin/t3-service-update`                                                                    |
| `config.example`                                                                             | `~/.config/t3-update-guard/config` (host values, including `JARVIS_INBOX_THREAD`, stay on the host) |
| `systemd/t3-update-guard-update.{service,timer}`, `systemd/t3-update-guard-rollback.service` | `~/.config/systemd/user/`                                                                           |
| `systemd/30-update-guard.conf`                                                               | `~/.config/systemd/user/t3code.service.d/`                                                          |
| `test-guard.sh`                                                                              | not installed; run `bash test-guard.sh` from this directory                                         |

## Install a reviewed change

1. Run `bash test-guard.sh` and check that every line says PASS.
2. Back up the installed guard: `cp ~/.local/libexec/t3-update-guard/guard{,.bak-$(date +%Y%m%d-%H%M)}`.
3. Copy `guard` (and any changed unit files) to the paths above. Then run `systemctl --user daemon-reload` if a unit changed.
4. Check the install with `t3-service-update status`.

Installing the guard does not restart the T3 service.

## Capture a snapshot without updating

`t3-service-update snapshot <operation-id> <snapshot-point>` is the guarded stop/copy/restart entry point for a caller that needs a database snapshot without installing or selecting another release. Both identifiers must contain only letters, digits, dots, underscores, and hyphens, and start with a letter or digit. Reusing an operation ID with the same point returns its existing receipt and does not stop the service again; reusing it for a different point fails closed.

The command takes the existing service-change lock, requires the selected release to be installed, trusted, and healthy, and proves the loopback listener is a descendant of the systemd unit's launcher MainPID inside that exact unit's cgroup. It requires two clean activity reads, then rechecks the service identity and generation immediately before stopping: no preparing, queued, starting, running, or waiting runs; no pending requests; no active command, tool, file-change, subagent, or link-request items; no pending or running effect outbox jobs; no active provider subagents or persisted provider background tasks; and at least the configured 15 minutes of quiet. Unknown activity, health, listener, cgroup, or systemd state refuses the stop.

Before systemd receives a stop request, the guard fsyncs an owner-only intent receipt. It copies the SQLite files and WAL/SHM sidecars with the existing reflink path only after systemd confirms the unit is inactive, then fsyncs the copy and records that state durably. It restarts the same selected fork build before hashing the copied files, and marks the receipt complete only after the new systemd invocation, listener descendant and cgroup, health version, and service uptime are verified. The receipt includes the operation ID, snapshot point, stopped unit invocation and launcher PID, both idle censuses, snapshot path, and each copied file's SHA-256 and size. This one-off operation preserves earlier snapshots instead of applying the update path's three-snapshot rotation. It never downloads, installs, or selects a release and never runs the T3 CLI against the live database. A retry returns a complete receipt or resumes from its durable state; it never sends a second stop for the same operation ID. If a stop was recorded but the unit is active again before a copy was recorded, the guard refuses that operation ID so the caller can inspect the receipt and retained files before choosing a new one.

The guard receipt proves which stopped-service files were copied and that the same fork build returned. A caller must still perform isolated readback against the retained copy; this command does not claim migration compatibility or publication of another release.

## When updates happen

- **Launch selection:** the guard prefers a build with a positive Codex shadow readiness report. It switches away from the active build only when that build positively reports a shadow conflict and another verified build reports ready. Missing or unknown shadow status keeps the active build when it can open the database. If an update launch is redirected to a compatible build because of a positive shadow conflict, the release is marked rejected on this host, not bad globally; fix the shadow conflict and retry with `t3-service-update <version>`.

- **Idle server:** the guard updates once no thread has run for 15 min.
- **Busy server:** threads nearly always run, so after 30 min of waiting (`MAX_DEFER_SECONDS`) the update is forced.
- **Before a forced restart:** the guard waits up to 20 more minutes (`FORCE_GRACE_SECONDS`) while an approval or question is pending, or a tool call is still running. A restart cancels pending approvals, and a tool call cut off part-way can be repeated by its continuation. It checks again just before stopping.
- **Kernel exit hang:** the guard never stops the service while the kernel shows the 7.2.15 exit hang. That means the `__vma_start_write` stack or a bad-page error in this boot's kernel log, or a T3 task stuck while exiting. It defers instead and reports once per boot, and a reboot clears it. For a manual `--now` it exits with status 3. To skip this check, run `T3_GUARD_IGNORE_KERNEL=1 t3-service-update --now`. Only do that when you know the stop will not hang.
- **Provider canary:** after the new build serves, the guard watches provider sessions until the service has been up 5 min (`CANARY_SECONDS`), within a hard deadline. It rolls back to the previous build, marks the release bad and reports when either of these happens. First, a provider instance that started runs in the 6 h before the restart has 2 or more session-open failures (`CANARY_FAILURES`) and no run that started since. Second, the build stops serving. Ordinary provider trouble, such as a signed-out account, bad config or an outage, doesn't match the first, because it fails before the restart too or still lets some sessions start. A bad release is not retried, but a newer one is. Replayed on 2026-11-13 data, it would have rolled back release .4 and passed .3.
- **Holds:** a failure the guard cannot recover from sets an automatic-updates hold. `t3-service-update status` shows it. After you fix the cause, `t3-service-update resume` lifts it and keeps the old hold as an archive.
- **After a restart:** the guard reports to Jarvis how many interrupted runs got a continuation, which threads did not, and how many requests that were pending at the stop were lost. Check those threads before repeating any outside action.
