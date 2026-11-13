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
# The host's kernel log and processes must not decide the outcome; the real check is tested below.
eval "real_kernel_hang_signs () $(declare -f kernel_hang_signs | tail -n +2)"
kernel_hang_signs() { return 1; }
service_uptime() { echo 100; }
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
sqlite3 "$DB" "create table orchestration_v2_projection_runs (run_id text, thread_id text, status text, requested_at text, completed_at text, payload_json text);
  create table orchestration_v2_projection_runtime_requests (runtime_request_id text, status text, resolved_at text);
  create table orchestration_v2_projection_turn_items (turn_item_id text, thread_id text, run_id text, type text, status text, updated_at text);"
now() { date -u -d "${1:-now}" +%Y-%m-%dT%H:%M:%S.000Z; }
sqlite3 "$DB" "insert into orchestration_v2_projection_runs values ('r1','A','running','$(now '-1 hour')',null,'{}');
  insert into orchestration_v2_projection_turn_items values ('i1','A','r1','command_execution','running','$(now '-7 hours')');"
[[ -z "$(force_blockers)" ]] || fail 'orphaned tool item counted as running'
sqlite3 "$DB" "insert into orchestration_v2_projection_turn_items values ('i2','A','r1','dynamic_tool','running','$(now '-50 minutes')');
  insert into orchestration_v2_projection_runtime_requests values ('q1','pending',null);"
b=$(force_blockers)
[[ "$b" == *'1 pending approval'* && "$b" == *'1 tool call(s) still running'* ]] || fail "blockers: $b"
pass 'force_blockers counts pending approvals and quiet long-running tool calls, not orphans'
b=$(DB="$root/missing.sqlite" force_blockers)
[[ "$b" == *'unknown number of pending'* ]] || fail "unreadable DB not a blocker: $b"
pass 'an unreadable database counts as a blocker'

export T3_GUARD_DRY_RUN=1
active_runs() { echo 2; }; quiet_seconds() { echo 5; }
mkdir -p "$GUARD_STATE"
touch -d '-31 minutes' "$GUARD_STATE/deferred-since"
out=$(cmd_update 2>/dev/null)
[[ "$out" == Deferred:*'waiting up to'*'pending approval'* ]] || fail "cap with blockers did not wait: $out"
pass 'past the cap, open approvals and tool calls get a bounded extra wait'
touch -d '-51 minutes' "$GUARD_STATE/deferred-since"
out=$(cmd_update 2>/dev/null)
[[ "$out" == RUN* ]] || fail "cap plus grace did not force: $out"
grep -qx 'run r1 A' "$PRE_RESTART" && grep -qx 'req q1' "$PRE_RESTART" || fail 'running run or pending request not recorded before restart'
pass 'past the cap plus grace the update is forced and running runs are recorded'
sqlite3 "$DB" "delete from orchestration_v2_projection_runtime_requests; delete from orchestration_v2_projection_turn_items;"
touch -d '-31 minutes' "$GUARD_STATE/deferred-since"
out=$(cmd_update 2>/dev/null)
[[ "$out" == RUN* ]] || fail "cap without blockers did not force: $out"
pass 'past the cap with no blockers the update is forced at once'

# A blocker that appears during the release download still gets the grace window.
real_force_blockers="$(declare -f force_blockers)"
force_blockers() { local c; c=$(cat "$root/fb" 2>/dev/null || echo 0); echo $((c + 1)) > "$root/fb"; (( c == 0 )) || echo '1 tool call(s) still running'; }
rm -f "$root/fb"; touch -d '-31 minutes' "$GUARD_STATE/deferred-since"
since=$(stat -c %Y "$GUARD_STATE/deferred-since")
out=$(cmd_update 2>/dev/null)
[[ "$out" == Deferred:*'before stopping'* ]] || fail "late blocker not rechecked: $out"
[[ "$(stat -c %Y "$GUARD_STATE/deferred-since")" == "$since" ]] || fail 'deferral clock reset by the recheck'
pass 'blockers are rechecked just before the stop, keeping the original deferral clock'
eval "$real_force_blockers"

svc() { echo "$*" >> "$root/svc-kernel"; return 0; }
kernel_hang_signs() { echo 'kernel logged 1 exit-hang or bad-page line(s) this boot'; return 0; }
rm -f "$root/svc-kernel"
set +e; out=$(cmd_update --now 2>/dev/null); rc=$?; set -e
[[ "$out" == Deferred:*exit-hang* && $rc == 3 ]] || fail "kernel signs did not defer --now with rc 3: rc=$rc $out"
[[ ! -e "$root/svc-kernel" ]] || fail 'service touched while the kernel showed the hang'
[[ ! -e "$AUTO_HOLD" ]] || fail 'kernel deferral set a hold that needs a human'
[[ -e "$GUARD_STATE/deferred-since" ]] || fail 'manual kernel deferral erased the timer clock'
touch -d '-10 minutes' "$GUARD_STATE/deferred-since"; since=$(stat -c %Y "$GUARD_STATE/deferred-since")
out=$(cmd_update 2>/dev/null)
[[ "$(stat -c %Y "$GUARD_STATE/deferred-since")" == "$since" ]] || fail 'kernel deferral reset a recent deferral clock'
touch -d '-5 hours' "$GUARD_STATE/deferred-since"
out=$(cmd_update 2>/dev/null)
age=$(( $(date +%s) - $(stat -c %Y "$GUARD_STATE/deferred-since") ))
(( age >= MAX_DEFER_SECONDS - 5 && age <= MAX_DEFER_SECONDS + 5 )) || fail "old clock not clamped to the cap: age $age"
pass 'kernel hang signs defer even --now (rc 3) with no service touch or hold; the clock is kept but never older than the cap'
kernel_hang_signs() { return 1; }
unset T3_GUARD_DRY_RUN

# The real kernel check: the hang's own stack counts; an unrelated hung task does not.
kernel_log() { printf '%s\n' "${FAKE_KLOG:-}"; }
t3_exit_hang_tasks() { :; }
FAKE_KLOG='INFO: task mount.cifs:42 blocked for more than 122 seconds.' real_kernel_hang_signs >/dev/null && fail 'unrelated hung task blocked updates'
FAKE_KLOG=' __vma_start_write+0x55/0xe0' real_kernel_hang_signs >/dev/null || fail 'exit-hang stack not detected'
FAKE_KLOG=' __vma_start_write+0x55/0xe0' T3_GUARD_IGNORE_KERNEL=1 real_kernel_hang_signs >/dev/null && fail 'override ignored'
pass 'kernel check matches the exit-hang stack only, and honours T3_GUARD_IGNORE_KERNEL'
stat_is_exiting_d '123 (we) ird) name) D 1 1 1 0 -1 4194372 0 0' || fail 'D with PF_EXITING and odd comm not detected'
stat_is_exiting_d '123 (node) D 1 1 1 0 -1 4194368 0 0' && fail 'plain D state counted as exiting'
stat_is_exiting_d '123 (node) S 1 1 1 0 -1 4194372 0 0' && fail 'sleeping task counted'
pass '/proc stat parsing finds D state with PF_EXITING, whatever the comm'

printf '%s\nrun r1 A\nrun r9 B\nreq q2\nreq q3\nreq q4\n' "$(now '-2 minutes')" > "$PRE_RESTART"
sqlite3 "$DB" "insert into orchestration_v2_projection_runs values ('r2','A','running','$(now '-1 minute')',null,'{\"restartContinuationOfRunId\":\"r1\"}');
  insert into orchestration_v2_projection_runs values ('r10','B','running','$(now '-1 minute')',null,'{}');
  insert into orchestration_v2_projection_runtime_requests values ('q2','cancelled','$(now '-1 minute')');
  insert into orchestration_v2_projection_runtime_requests values ('q3','expired','$(now '-1 minute')');
  insert into orchestration_v2_projection_runtime_requests values ('q4','resolved','$(now '-1 minute')');
  insert into orchestration_v2_projection_runtime_requests values ('q5','cancelled','$(now '-1 minute')');"
s=$(recovery_summary)
[[ "$s" == '1/2 interrupted run(s) continued; not continued: B; 2 pending request(s) lost' ]] || fail "summary: $s"
[[ ! -e "$PRE_RESTART" ]] || fail 'pre-restart record kept after summary'
pass 'recovery summary matches continuations to their runs and counts only requests pending at the stop'
printf '%s\n' "$(now)" > "$PRE_RESTART"
sqlite3 "$DB" "delete from orchestration_v2_projection_runtime_requests;"
[[ -z "$(recovery_summary)" ]] || fail 'empty restart produced a summary'
pass 'an idle restart produces no recovery report'

latest_release() { echo 1; }
service_uptime() { return 1; }
cmd_update >/dev/null 2>&1 && fail 'no-op reported with the managed unit down'
[[ -f "$AUTO_HOLD" ]] || fail 'unit down did not trip the health breaker'
pass 'a no-op needs the managed unit up, not just an answer on the port'
rm -f "$AUTO_HOLD"
cmd_update 1 >/dev/null 2>&1 && fail 'explicit current version reported with the unit down'
[[ -f "$AUTO_HOLD" ]] || fail 'explicit current version with unit down did not hold'
pass 'an explicit current version also needs the managed unit up'
out=$(cmd_resume)
[[ ! -e "$AUTO_HOLD" && "$out" == 'Automatic updates resumed.'* ]] || fail "resume: $out"
ls "$AUTO_HOLD".cleared-* >/dev/null 2>&1 || fail 'resume deleted the hold instead of archiving it'
[[ "$(cmd_resume)" == 'No automatic-updates hold.' ]] || fail 'resume without a hold'
pass 'resume lifts a hold and keeps it as an archive'
rm -f "$AUTO_HOLD"; service_uptime() { echo 100; }

latest_release() { echo 2; }; active_runs() { echo 0; }; quiet_seconds() { echo 99999; }
svc() { return 0; }; wait_inactive() { return 0; }; snapshot_db() { return 1; }
restart_on() { echo "$1" > "$root/recovery"; }
cmd_update >/dev/null 2>&1 && fail 'failed snapshot accepted'
[[ -f "$AUTO_HOLD" ]] || fail 'failed snapshot did not set the hold'
[[ "$(cat "$root/recovery")" == 1 ]] || fail 'failed snapshot did not restart the old build'
pass 'a failed snapshot after the stop holds automatic updates and restarts the old build'
rm -f "$AUTO_HOLD"

mkdir -p "$T3HOME/userdata" "$root/snap"
echo live > "$T3HOME/userdata/state.sqlite"; echo old > "$root/snap/state.sqlite"; echo old > "$root/snap/extra.sqlite-wal"
# tmpfs cannot reflink; the host (btrfs) can.
cp() { [[ "$*" == *extra.sqlite-wal* ]] && return 1; command cp "${@/--reflink=always/--reflink=auto}"; }
restore_db "$root/snap" 2>/dev/null && fail 'partial restore reported success'
[[ "$(cat "$T3HOME/userdata/state.sqlite")" == live ]] || fail 'failed restore changed the live database'
ls -d "$T3HOME"/userdata/.restore-* >/dev/null 2>&1 && fail 'failed restore left its staging dir'
cp() { command cp "${@/--reflink=always/--reflink=auto}"; }
restore_db "$root/snap" >/dev/null 2>&1 || fail 'restore failed'
[[ "$(cat "$T3HOME/userdata/state.sqlite")" == old && -e "$T3HOME/userdata/extra.sqlite-wal" ]] || fail 'restore incomplete'
pass 'a database restore is staged first, so a failed copy leaves the live files untouched'
unset -f cp
timeout() { printf '%s\n' "$*" > "$root/timeout"; }
systemctl --user is-active t3code.service
[[ "$(cat "$root/timeout")" == '--kill-after=2 15 /usr/bin/systemctl --user is-active t3code.service' ]] || fail timeout
pass 'all systemctl calls have a bounded timeout'
