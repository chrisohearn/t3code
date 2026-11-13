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
