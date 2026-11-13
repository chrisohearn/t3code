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
# --- Forced updates (2026-11-13): bounded waits, kernel gate, recovery summary.
unset -f flock
rm -f "$AUTO_HOLD"
DB="$root/state.sqlite"
sqlite3 "$DB" "create table orchestration_v2_projection_runs (run_id text, thread_id text, status text, requested_at text, completed_at text);
  create table orchestration_v2_projection_runtime_requests (runtime_request_id text, status text, resolved_at text);
  create table orchestration_v2_projection_turn_items (turn_item_id text, run_id text, type text, status text, updated_at text);"
now() { date -u -d "${1:-now}" +%Y-%m-%dT%H:%M:%S.000Z; }
sqlite3 "$DB" "insert into orchestration_v2_projection_runs values ('r1','A','running','$(now '-1 hour')',null);
  insert into orchestration_v2_projection_turn_items values ('i1','r1','command_execution','running','$(now '-3 hours')');"
[[ -z "$(force_blockers)" ]] || fail 'stale tool item counted as in flight'
sqlite3 "$DB" "insert into orchestration_v2_projection_turn_items values ('i2','r1','dynamic_tool','running','$(now '-10 seconds')');
  insert into orchestration_v2_projection_runtime_requests values ('q1','pending',null);"
b=$(force_blockers)
[[ "$b" == *'1 pending approval'* && "$b" == *'1 tool call(s) active'* ]] || fail "blockers: $b"
pass 'force_blockers reports pending approvals and in-flight tool calls, not stale items'

export T3_GUARD_DRY_RUN=1
active_runs() { echo 2; }; quiet_seconds() { echo 5; }
kernel_hang_signs() { return 1; }
touch -d '-31 minutes' "$GUARD_STATE/deferred-since" 2>/dev/null || { mkdir -p "$GUARD_STATE"; touch -d '-31 minutes' "$GUARD_STATE/deferred-since"; }
out=$(cmd_update 2>/dev/null)
[[ "$out" == Deferred:*'waiting up to'*'pending approval'* ]] || fail "cap with blockers did not wait: $out"
pass 'past the cap, open approvals and tool calls get a bounded extra wait'
touch -d '-51 minutes' "$GUARD_STATE/deferred-since"
out=$(cmd_update 2>/dev/null)
[[ "$out" == RUN* ]] || fail "cap plus grace did not force: $out"
[[ "$(sed -n 2p "$PRE_RESTART")" == A ]] || fail 'running thread not recorded before restart'
pass 'past the cap plus grace the update is forced and running threads are recorded'
sqlite3 "$DB" "delete from orchestration_v2_projection_runtime_requests; delete from orchestration_v2_projection_turn_items;"
touch -d '-31 minutes' "$GUARD_STATE/deferred-since"
out=$(cmd_update 2>/dev/null)
[[ "$out" == RUN* ]] || fail "cap without blockers did not force: $out"
pass 'past the cap with no blockers the update is forced at once'

svc() { echo "$*" >> "$root/svc-kernel"; return 0; }
kernel_hang_signs() { echo 'kernel logged 1 hung-task or bad-page message(s) this boot'; return 0; }
rm -f "$root/svc-kernel"
out=$(cmd_update --now 2>/dev/null)
[[ "$out" == Deferred:*hung-task* ]] || fail "kernel signs did not defer: $out"
[[ ! -e "$root/svc-kernel" ]] || fail 'service touched while the kernel showed the hang'
[[ ! -e "$AUTO_HOLD" ]] || fail 'kernel deferral set a hold that needs a human'
pass 'kernel hang signs defer even --now, without touching the service or setting a hold'
kernel_hang_signs() { return 1; }
unset T3_GUARD_DRY_RUN

printf '%s\nA\nB\n' "$(now '-2 minutes')" > "$PRE_RESTART"
sqlite3 "$DB" "insert into orchestration_v2_projection_runs values ('r2','A','running','$(now '-1 minute')',null);
  insert into orchestration_v2_projection_runtime_requests values ('q2','cancelled','$(now '-1 minute')');"
s=$(recovery_summary)
[[ "$s" == '1/2 interrupted thread(s) continued; not continued: B; 1 request(s) cancelled' ]] || fail "summary: $s"
[[ ! -e "$PRE_RESTART" ]] || fail 'pre-restart record kept after summary'
pass 'recovery summary names threads that did not continue and counts cancelled requests'
printf '%s\n' "$(now)" > "$PRE_RESTART"
[[ -z "$(recovery_summary)" ]] || fail 'empty restart produced a summary'
pass 'an idle restart produces no recovery report'
timeout() { printf '%s\n' "$*" > "$root/timeout"; }
systemctl --user is-active t3code.service
[[ "$(cat "$root/timeout")" == '--kill-after=2 15 /usr/bin/systemctl --user is-active t3code.service' ]] || fail timeout
pass 'all systemctl calls have a bounded timeout'
