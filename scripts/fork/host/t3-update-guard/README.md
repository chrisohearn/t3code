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

## When updates happen

- **Idle server:** the guard updates once no thread has run for 15 min.
- **Busy server:** threads nearly always run, so after 30 min of waiting (`MAX_DEFER_SECONDS`) the update is forced.
- **Before a forced restart:** the guard waits up to 20 more minutes (`FORCE_GRACE_SECONDS`) while an approval or question is pending, or a tool call is still running. A restart cancels pending approvals, and a tool call cut off part-way can be repeated by its continuation. It checks again just before stopping.
- **Kernel exit hang:** the guard never stops the service while the kernel shows the 7.2.15 exit hang. That means the `__vma_start_write` stack or a bad-page error in this boot's kernel log, or a T3 task stuck while exiting. It defers instead and reports once per boot, and a reboot clears it. For a manual `--now` it exits with status 3. To skip this check, run `T3_GUARD_IGNORE_KERNEL=1 t3-service-update --now`. Only do that when you know the stop will not hang.
- **Provider canary:** after the new build serves, the guard watches new provider sessions until the service has been up 5 min (`CANARY_SECONDS`). If at least 2 sessions (`CANARY_FAILURES`) fail to open, more than in the 30 min before the restart, it rolls back to the previous build and marks the release bad. A bad release is not retried, but a newer release is. This catches a build that serves but cannot open sessions, as release .4 did on 2026-11-13.
- **Holds:** a failure the guard cannot recover from sets an automatic-updates hold. `t3-service-update status` shows it. After you fix the cause, `t3-service-update resume` lifts it and keeps the old hold as an archive.
- **After a restart:** the guard reports to Jarvis how many interrupted runs got a continuation, which threads did not, and how many requests that were pending at the stop were lost. Check those threads before repeating any outside action.
