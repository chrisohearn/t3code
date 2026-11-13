#!/bin/bash
set -eu
original="$(cd "$(dirname "$0")" && pwd)/guard"
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
export HOME="$root/home" T3CODE_HOME="$root/t3" T3_GUARD_STATE_DIR="$root/state"
mkdir -p "$HOME" "$T3CODE_HOME/runtime"
sed '/^case "${1:-}" in/,$d' "$original" > "$root/functions"
source "$root/functions"
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; exit 1; }
# No real service calls, installs, or network calls below.
manager_ready() { echo manager >> "$root/calls"; return 0; }
active_version() { echo 1; }; is_trusted() { return 0; }; latest_release() { echo 1; }
service_version() { echo 1; }
printf hold > "$AUTO_HOLD"
cmd_update >/dev/null || fail hold
[[ ! -e "$root/calls" ]] || fail 'hold contacted manager'
pass 'automatic hold blocks all service and download activity'
rm "$AUTO_HOLD"
manager_ready() { return 1; }
cmd_update --now >/dev/null 2>&1 && fail 'manager failure accepted'
[[ -f "$AUTO_HOLD" ]] || fail 'missing circuit breaker'
pass 'manager failure stops update and trips circuit breaker'
rm "$AUTO_HOLD"
manager_ready() { return 0; }
service_version() { echo ''; }
cmd_update >/dev/null 2>&1 && fail 'unhealthy newest accepted'
[[ -f "$AUTO_HOLD" ]] || fail 'missing health breaker'
pass 'newest selected build without server is not reported healthy'
rm "$AUTO_HOLD"
cmd_update 1 >/dev/null 2>&1 && fail 'explicit unhealthy version accepted'
pass 'explicit current version also verifies health'
rm "$AUTO_HOLD"
service_version() { echo 1; }
cmd_update >/dev/null || fail healthy
[[ ! -e "$AUTO_HOLD" ]] || fail 'healthy tripped breaker'
pass 'healthy latest is a successful no-op'
latest_release() { echo 2; }; is_bad() { return 1; }; is_healthy() { return 0; }
release_binary_sha() { echo 1234; }
svc() { echo "$*" >> "$root/svc"; return 1; }
cmd_update --now >/dev/null 2>&1 && fail 'failed stop accepted'
[[ "$(head -1 "$root/svc")" == 'stop --no-block t3code.service' ]] || fail 'unexpected service calls'
[[ -f "$AUTO_HOLD" ]] || fail 'failed stop without breaker'
[[ "$(tail -1 "$root/svc")" == 'start --no-block t3code.service' ]] || fail 'stop failure did not request recovery'
pass 'failed stop aborts before snapshot/install and requests recovery'
rm -f "$AUTO_HOLD" "$root/svc"
svc() { echo "$*" >> "$root/svc"; return 0; }
wait_inactive() { return 0; }
snapshot_db() { echo "$root/snapshot"; }
binary_of() { echo /bin/false; }
installed() { return 1; }
restart_on() { echo "$1" > "$root/recovery"; }
cmd_update --now >/dev/null 2>&1 && fail 'failed installation accepted'
[[ "$(cat "$root/recovery")" == 1 ]] || fail 'failed installation did not recover current version'
pass 'failed install recovers old version even when selection is unchanged'
flock() { return 1; }
cmd_rollback >/dev/null 2>&1 && fail 'rollback continued without lock'
[[ ! -e "$GUARD_STATE/last-rollback" ]] || fail 'rollback changed state without lock'
pass 'rollback lock contention leaves state untouched'
timeout() { printf '%s\n' "$*" > "$root/timeout"; }
systemctl --user is-active t3code.service
[[ "$(cat "$root/timeout")" == '--kill-after=2 15 /usr/bin/systemctl --user is-active t3code.service' ]] || fail timeout
pass 'all systemctl calls have a bounded timeout'
