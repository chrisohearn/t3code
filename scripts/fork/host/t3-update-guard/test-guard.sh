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
# Database compatibility and Codex shadow readiness are separate rollback/startup checks.
real_binary_of=$(declare -f binary_of)
cat >"$root/fake-preflight" <<'EOF'
#!/bin/bash
printf '%s\n' "$PREFLIGHT_OUTPUT"
EOF
chmod +x "$root/fake-preflight"
binary_of() { echo "$root/fake-preflight"; }
export PREFLIGHT_OUTPUT='{"status":"ready","codexShadowHomes":{"status":"not-ready","instances":[{"status":"not-ready"}]}}'
can_open 1 || fail 'shadow readiness made a database-compatible build look incompatible'
if can_start 1; then fail 'startup selected a build with a known-unready Codex shadow home'; else
  [[ "$?" == 1 ]] || fail 'known shadow conflict did not return its distinct status'
fi
export PREFLIGHT_OUTPUT='{"status":"ready","codexShadowHomes":{"status":"ready","instances":[]}}'
can_open 1 || fail 'database compatibility rejected a build with ready Codex shadow homes'
can_start 1 || fail 'startup rejected a build with ready Codex shadow homes'
export PREFLIGHT_OUTPUT='{"status":"not-ready","codexShadowHomes":{"status":"not-ready","instances":[{"status":"unknown"}]}}'
can_open 1 || fail 'an unknown secret-backed shadow made a database-compatible build unusable'
if can_start 1; then fail 'an unknown secret-backed shadow was treated as positively ready'; else
  [[ "$?" == 3 ]] || fail 'unknown shadow readiness did not return its distinct status'
fi
export PREFLIGHT_OUTPUT='{"status":"ready"}'
can_open 1 || fail 'legacy preflight without shadow status made a database-compatible build unusable'
if can_start 1; then fail 'legacy preflight without shadow status was treated as positively ready'; else
  [[ "$?" == 3 ]] || fail 'legacy shadow readiness did not return its distinct status'
fi
export PREFLIGHT_OUTPUT='{"status":"blocked","reason":"migration unavailable"}'
if can_start 1; then fail 'database-incompatible build was selected'; else
  [[ "$?" == 2 ]] || fail 'database incompatibility did not return its distinct status'
fi
eval "$real_binary_of"
unset PREFLIGHT_OUTPUT
pass 'database compatibility, positive shadow conflicts, and unknown shadow status stay distinct'

# Exercise the service-launch and crash-loop paths, including an older build that has no
# shadow preflight report. Shadow readiness is a preference; database compatibility keeps T3 up.
# A known-unready active build stays up when the only older build has no shadow report.
(
  exec 9>&-
  export T3_GUARD_DRY_RUN=1
  mkdir -p "$GUARD_STATE/healthy" "$root/versions/1" "$root/versions/2"
  printf '{"protocol":4}\n' >"$GUARD_STATE/healthy/1.json"
  for v in 1 2; do
    cat >"$root/versions/$v/t3" <<EOF
#!/bin/bash
if [[ "$v" == 1 ]]; then
  echo '{"status":"ready"}'
else
  echo '{"status":"ready","codexShadowHomes":{"status":"not-ready","instances":[{"status":"not-ready"}]}}'
fi
EOF
    chmod +x "$root/versions/$v/t3"
  done
  binary_of() { echo "$root/versions/$1/t3"; }
  installed() { return 0; }
  is_trusted() { return 0; }
  is_bad() { return 1; }
  active_version() { echo 2; }
  out=$(cmd_launch 2>/dev/null)
  [[ "$out" == *"/versions/2/t3"* ]] || exit 1
) || fail 'launch downgraded a database-compatible build to a legacy build without shadow status'
pass 'launch keeps a database-compatible active build when a legacy fallback has no shadow report'

# An unknown active shadow report does not justify downgrading to an older ready build.
(
  exec 9>&-
  export T3_GUARD_DRY_RUN=1
  mkdir -p "$GUARD_STATE/healthy" "$root/versions/1" "$root/versions/2"
  printf '{"protocol":4}\n' >"$GUARD_STATE/healthy/1.json"
  cat >"$root/versions/1/t3" <<'EOF'
#!/bin/bash
echo '{"status":"ready","codexShadowHomes":{"status":"ready","instances":[]}}'
EOF
  cat >"$root/versions/2/t3" <<'EOF'
#!/bin/bash
echo '{"status":"ready"}'
EOF
  chmod +x "$root/versions/1/t3" "$root/versions/2/t3"
  binary_of() { echo "$root/versions/$1/t3"; }
  installed() { return 0; }; is_trusted() { return 0; }; is_bad() { return 1; }
  active_version() { echo 2; }
  out=$(cmd_launch 2>/dev/null)
  [[ "$out" == *"/versions/2/t3"* ]] || exit 1
) || fail 'launch downgraded an active build when its shadow preflight was unknown'
pass 'launch keeps the database-compatible active build when shadow readiness is unknown'

# A positive shadow conflict can select an older build whose shadow homes are known ready.
(
  exec 9>&-
  export T3_GUARD_DRY_RUN=1
  mkdir -p "$GUARD_STATE/healthy" "$root/versions/1" "$root/versions/2"
  printf '{"protocol":4}\n' >"$GUARD_STATE/healthy/1.json"
  cat >"$root/versions/1/t3" <<'EOF'
#!/bin/bash
echo '{"status":"ready","codexShadowHomes":{"status":"ready","instances":[]}}'
EOF
  cat >"$root/versions/2/t3" <<'EOF'
#!/bin/bash
echo '{"status":"ready","codexShadowHomes":{"status":"not-ready","instances":[{"status":"not-ready"}]}}'
EOF
  chmod +x "$root/versions/1/t3" "$root/versions/2/t3"
  binary_of() { echo "$root/versions/$1/t3"; }
  installed() { return 0; }; is_trusted() { return 0; }; is_bad() { return 1; }
  active_version() { echo 2; }
  out=$(cmd_launch 2>/dev/null)
  [[ "$out" == *"/versions/1/t3"* ]] || exit 1
) || fail 'launch did not switch from a positively unready build to a known-ready fallback'
pass 'launch switches to an older build only after a positive shadow conflict'

(
  exec 9>&-
  export T3_GUARD_DRY_RUN=1
  mkdir -p "$GUARD_STATE/healthy" "$GUARD_STATE/bad"
  printf '{"protocol":4}\n' >"$GUARD_STATE/healthy/1.json"
  binary_of() { echo "$root/versions/$1/t3"; }
  printf '%s\n' '#!/bin/bash' 'echo '\''{"status":"ready","codexShadowHomes":{"status":"not-ready","instances":[{"status":"not-ready"}]}}'\''' >"$root/versions/1/t3"
  chmod +x "$root/versions/1/t3"
  is_healthy() { [[ -f "$GUARD_STATE/healthy/$1.json" ]]; }
  is_bad() { [[ -f "$GUARD_STATE/bad/$1" ]]; }
  is_trusted() { return 0; }
  active_version() { echo 2; }
  restart_on() { echo "$1" >"$root/rollback-fallback"; }
  outage_begin() { :; }
  notify() { :; }
  report() { :; }
  last_fatal() { :; }
  rm -f "$GUARD_STATE/last-rollback" "$root/rollback-fallback"
  cmd_rollback >/dev/null 2>&1
  [[ "$(cat "$root/rollback-fallback")" == 1 ]]
) || fail 'crash-loop rollback did not use a database-compatible fallback with a shadow conflict'
pass 'crash-loop rollback preserves a database-compatible fallback when its Codex shadow is unready'

rm -f "$GUARD_STATE/healthy/1.json" "$GUARD_STATE/bad/2" "$GUARD_STATE/last-rollback" "$root/rollback-fallback"

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
# A hang that starts during the release download is caught just before the stop.
kernel_hang_signs() { local c; c=$(cat "$root/kh" 2>/dev/null || echo 0); echo $((c + 1)) > "$root/kh"; (( c == 0 )) && return 1; echo 'T3 task(s) 1:2 stuck while exiting'; }
rm -f "$root/kh" "$root/svc-kernel" "$GUARD_STATE/kernel-deferred"
set +e; out=$(cmd_update --now 2>/dev/null); rc=$?; set -e
[[ "$out" == Deferred:*'stuck while exiting'* && $rc == 3 ]] || fail "late hang not rechecked: rc=$rc $out"
[[ "$(cat "$root/kh")" == 2 && ! -e "$root/svc-kernel" ]] || fail 'second kernel check missing or service touched'
pass 'kernel hang signs are checked again just before the stop'
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
echo live2 > "$T3HOME/userdata/state.sqlite"; echo livewal > "$T3HOME/userdata/state.sqlite-wal"
cp() { command cp "${@/--reflink=always/--reflink=auto}"; }
mv() { [[ "$1" == "-f" && "$2" == *state.sqlite-wal && "$3" == "$SNAPSHOTS"/replaced-* ]] && return 1; command mv "$@"; }
restore_db "$root/snap" >/dev/null 2>&1 && fail 'restore with a failed rename reported success'
[[ "$(cat "$T3HOME/userdata/state.sqlite")" == live2 && "$(cat "$T3HOME/userdata/state.sqlite-wal")" == livewal ]] || fail 'failed rename left an incomplete live set'
unset -f cp mv
pass 'a rename that fails part-way puts every live file back'
# --- Provider canary (2026-11-13 incident) and release archive check.
sqlite3 "$DB" "alter table orchestration_v2_projection_runs add column provider_instance_id text;" 2>/dev/null || true
sqlite3 "$DB" "create table if not exists orchestration_v2_projection_turn_items (turn_item_id text, thread_id text, run_id text, type text, status text, updated_at text, payload_json text);" 2>/dev/null || true
sqlite3 "$DB" "alter table orchestration_v2_projection_turn_items add column payload_json text;" 2>/dev/null || true
sqlite3 "$DB" "delete from orchestration_v2_projection_runs; delete from orchestration_v2_projection_turn_items;"
run_row() { # id instance status requested started [thread]
  sqlite3 "$DB" "insert into orchestration_v2_projection_runs (run_id, thread_id, status, requested_at, payload_json, provider_instance_id)
    values ('$1','${6:-T-$1}','$3','$4','$( [[ -n "${5:-}" ]] && echo "{\"startedAt\":\"$5\"}" || echo '{}')','$2');"
}
open_fail() { # id instance time [thread] [message]
  run_row "$1" "$2" failed "$3" "" "${4:-T-$1}"
  sqlite3 "$DB" "insert into orchestration_v2_projection_turn_items (turn_item_id, run_id, type, status, updated_at, payload_json) values ('turn-item:run:$1:signal:provider-session-open-failure','$1','error','failed','$3','{\"failure\":{\"class\":\"provider_error\",\"message\":\"${5:-Cannot create Codex shadow home entry}\"}}');"
}
at=$(now '-3 minutes')
run_row ok1 P completed "$(now '-2 hours')" "$(now '-2 hours')"
[[ -z "$(broken_instances "$at")" ]] || fail 'canary flagged an instance with no failures'
open_fail f1 P "$(now '-2 minutes')"; open_fail f2 P "$(now '-1 minute')"
[[ "$(broken_instances "$at")" == 'P:2' ]] || fail "worked-before instance failing every session not flagged: $(broken_instances "$at")"
run_row ok2 P completed "$(now '-90 seconds')" "$(now '-80 seconds')"
[[ -z "$(broken_instances "$at")" ]] || fail 'instance that still starts sessions flagged'
open_fail g1 Q "$(now '-2 minutes')"; open_fail g2 Q "$(now '-1 minute')"
[[ -z "$(broken_instances "$at")" ]] || fail 'instance that never worked before (signed out, bad config) flagged'
run_row ok3 R completed "$(now '-2 hours')" "$(now '-2 hours')"
open_fail h1 R "$(now '-2 minutes')" one; open_fail h2 R "$(now '-1 minute')" one
[[ -z "$(broken_instances "$at")" ]] || fail 'one thread failing twice flagged'
run_row ok4 S completed "$(now '-2 hours')" "$(now '-2 hours')"
open_fail k1 S "$(now '-2 minutes')" "" "The workspace folder no longer exists"
open_fail k2 S "$(now '-1 minute')" "" "Please sign in again"
[[ -z "$(broken_instances "$at")" ]] || fail 'workspace or sign-in failures flagged'
pass 'canary flags only an instance that worked before and now fails every session on 2+ threads, not environment noise'
service_uptime() { echo 400; }; service_version() { echo 2; }; CANARY_POLL_SECONDS=0
sqlite3 "$DB" "delete from orchestration_v2_projection_runs where run_id = 'ok2';"
r=$(provider_canary "$at" 2) && fail 'canary passed a broken instance'
[[ "$r" == *'P:2'* ]] || fail "canary reason: $r"
sqlite3 "$DB" "delete from orchestration_v2_projection_runs; delete from orchestration_v2_projection_turn_items;"
provider_canary "$at" 2 >/dev/null || fail 'canary failed with nothing broken'
service_version() { echo 1; }
r=$(provider_canary "$at" 2) && fail 'canary passed after the build stopped serving'
[[ "$r" == *'stopped serving'* ]] || fail "reason: $r"
service_version() { echo 2; }; service_uptime() { echo 0; }; CANARY_SECONDS=1; CANARY_DEADLINE_SLACK=0
r=$(provider_canary "$at" 2) && fail 'canary did not end at its deadline'
[[ "$r" == *'did not stay up'* ]] || fail "deadline reason: $r"
CANARY_SECONDS=300; unset CANARY_DEADLINE_SLACK; service_uptime() { echo 400; }
pass 'canary fails if the build stops serving, and a wall-clock deadline bounds it'

# A build that serves but fails the canary is marked bad and rolled back, with the reason reported.
latest_release() { echo 2; }; active_runs() { echo 0; }; quiet_seconds() { echo 99999; }
svc() { return 0; }; wait_inactive() { return 0; }; snapshot_db() { echo "$root/snap"; }
binary_of() { echo /bin/true; }; installed() { return 0; }; is_trusted() { return 0; }
cur_v=1; active_version() { echo "$cur_v"; }; write_state_for() { :; }
service_version() { echo 2; }; can_open() { return 0; }
restart_on() { echo "$1" > "$root/recovery"; }
provider_canary() { echo 'new build breaks sessions'; return 1; }
rm -f "$root/recovery" "$GUARD_STATE/bad/2" "$GUARD_STATE/deferred-since"
HEALTH_WAIT_SECONDS=30 cmd_update >/dev/null 2>&1 && fail 'canary failure reported as success'
[[ -e "$GUARD_STATE/bad/2" ]] || fail 'canary failure did not mark the release bad'
[[ "$(cat "$root/recovery")" == 1 ]] || fail 'canary failure did not restart the old build'
grep -q 'failed the provider canary: new build breaks sessions' "$REPORTS_DEFERRED" "$REPORTS" 2>/dev/null || fail 'canary failure not reported'
pass 'a build that serves but fails the canary is marked bad, rolled back and reported'
unset -f provider_canary
service_version() { echo 1; }; active_version() { echo 1; }
rm -f "$AUTO_HOLD" "$GUARD_STATE/bad/2"

# A shadow-only preflight failure on the old build must not restore the pre-update database.
real_manager_ready=$(declare -f manager_ready); real_release_binary_sha=$(declare -f release_binary_sha)
real_write_state_for=$(declare -f write_state_for); real_installed=$(declare -f installed)
real_is_healthy=$(declare -f is_healthy); real_active_runs=$(declare -f active_runs)
real_quiet_seconds=$(declare -f quiet_seconds); real_record_pre_restart=$(declare -f record_pre_restart)
real_systemctl=$(declare -f systemctl); real_svc=$(declare -f svc); real_snapshot_db=$(declare -f snapshot_db)
real_outage_begin=$(declare -f outage_begin); real_restore_db=$(declare -f restore_db)
real_restart_on=$(declare -f restart_on); real_notify=$(declare -f notify); real_report=$(declare -f report)
real_wait_for_continuations=$(declare -f wait_for_continuations)
real_recovery_summary=$(declare -f recovery_summary); real_last_fatal=$(declare -f last_fatal)
real_binary_for_shadow_rollback=$(declare -f binary_of)
latest_release() { echo 2; }; active_runs() { echo 0; }; quiet_seconds() { echo 99999; }
manager_ready() { return 0; }; active_version() { echo 1; }; is_trusted() { return 0; }
is_healthy() { return 1; }; release_binary_sha() { echo 1234; }; record_pre_restart() { :; }
kernel_hang_signs() { return 1; }; write_state_for() { :; }; systemctl() { echo active; }
service_version() { echo ''; }; installed() { return 0; }; wait_inactive() { return 0; }
outage_begin() { :; }; svc() { echo "$*" >> "$root/shadow-rollback-svc"; return 0; }
snapshot_db() { echo "$root/snap"; }; restore_db() { echo restored > "$root/shadow-restore"; return 0; }
binary_of() { echo "$root/shadow-rollback-cli"; }
cat >"$root/shadow-rollback-cli" <<'EOF'
#!/bin/bash
case "${1:-}" in
  __service-preflight)
    echo '{"status":"ready","codexShadowHomes":{"status":"not-ready","instances":[{"status":"not-ready"}]}}'
    ;;
  update) exit 0 ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$root/shadow-rollback-cli"
restart_on() { echo "$1" > "$root/shadow-rollback-restart"; return 0; }
notify() { :; }; report() { :; }; wait_for_continuations() { :; }
recovery_summary() { :; }; last_fatal() { :; }
rm -f "$root/shadow-rollback-svc" "$root/shadow-restore" "$root/shadow-rollback-restart" "$AUTO_HOLD"
HEALTH_WAIT_SECONDS=0 cmd_update >/dev/null 2>&1 && fail 'shadow-only startup failure reported as success'
[[ ! -e "$root/shadow-restore" ]] || fail 'shadow-only startup failure restored the pre-update database'
[[ "$(cat "$root/shadow-rollback-restart")" == 1 ]] || fail 'database-compatible old build was not restarted'
pass 'shadow-only rollback failure restarts the database-compatible build without restoring its snapshot'

# A positive shadow redirect keeps the previous build serving without marking the release bad.
# Earlier cmd_update cases keep their service-change lock on fd 9 until the test process closes it.
exec 9>&-
(
  source "$root/functions"
  sim_active_version=1
  manager_ready() { return 0; }
  latest_release() { echo 2; }
  active_runs() { echo 0; }
  quiet_seconds() { echo 99999; }
  active_version() { echo "$sim_active_version"; }
  write_state_for() { sim_active_version="$1"; }
  is_trusted() { return 0; }
  is_healthy() { [[ "$1" == 1 ]]; }
  is_bad() { return 1; }
  release_binary_sha() { echo 1234; }
  record_pre_restart() { :; }
  kernel_hang_signs() { return 1; }
  systemctl() { echo active; }
  service_version() { echo "$sim_active_version"; }
  service_uptime() { echo 100; }
  installed() { return 0; }
  wait_inactive() { return 0; }
  snapshot_db() { echo "$root/snap"; }
  binary_of() { echo "$root/versions/$1/t3"; }
  svc() {
    echo "$*" >>"$root/redirect-svc"
    [[ "$1" != restart ]] || sim_active_version=1
    return 0
  }
  notify() { echo "$*" >>"$root/redirect-notify"; }
  mkdir -p "$root/versions/1" "$root/versions/2"
  cat >"$root/versions/1/t3" <<'EOF'
#!/bin/bash
case "${1:-}" in
  __service-preflight) echo '{"status":"ready","codexShadowHomes":{"status":"ready","instances":[]}}' ;;
  update) exit 0 ;;
esac
EOF
  cat >"$root/versions/2/t3" <<'EOF'
#!/bin/bash
case "${1:-}" in
  __service-preflight) echo '{"status":"ready","codexShadowHomes":{"status":"not-ready","instances":[{"status":"not-ready"}]}}' ;;
  update) exit 0 ;;
esac
EOF
  chmod +x "$root/versions/1/t3" "$root/versions/2/t3"
  rm -f "$AUTO_HOLD" "$GUARD_STATE/bad/2" "$GUARD_STATE/rejected/2" "$root/redirect-svc"
  rm -f "$OUTAGE" "$GUARD_STATE/outage-reported" "$GUARD_STATE/recoveries.log" "$REPORTS"
  if HEALTH_WAIT_SECONDS=0 cmd_update >"$root/redirect-output" 2>&1; then
    fail 'shadow redirect reported the new release as serving'
  fi
  exec 9>&-
  [[ -e "$GUARD_STATE/rejected/2" ]] || fail 'shadow redirect was not rejected on this host'
  [[ ! -e "$GUARD_STATE/bad/2" ]] || fail 'shadow redirect marked the release globally bad'
  [[ "$(grep -c '^stop --no-block t3code.service$' "$root/redirect-svc")" == 1 ]] ||
    fail 'guard stopped the already-serving fallback again'
  [[ "$(grep -c '^restart t3code.service$' "$root/redirect-svc")" == 1 ]] ||
    fail 'guard restarted the already-serving fallback again'
  [[ ! -e "$OUTAGE" ]] || fail 'shadow redirect left the outage clock open'
  [[ ! -e "$GUARD_STATE/outage-reported" ]] || fail 'shadow redirect left the outage report marker open'
  grep -q 'Codex shadow preflight is not-ready' "$REPORTS" ||
    fail 'shadow redirect was not reported with its cause'
  grep -q 'recovered on 1 after .* (update 1 -> 2)' "$GUARD_STATE/events.log" ||
    fail 'shadow redirect did not record recovery on the serving fallback'
) || fail 'shadow redirect was mishandled by cmd_update'
pass 'shadow redirect closes the outage clock, is host-rejected, and keeps the fallback serving'

eval "$real_manager_ready"; eval "$real_release_binary_sha"; eval "$real_write_state_for"; eval "$real_installed"
eval "$real_is_healthy"; eval "$real_active_runs"; eval "$real_quiet_seconds"; eval "$real_record_pre_restart"
eval "$real_systemctl"; eval "$real_svc"; eval "$real_snapshot_db"; eval "$real_outage_begin"
eval "$real_restore_db"; eval "$real_restart_on"; eval "$real_notify"; eval "$real_report"
eval "$real_wait_for_continuations"; eval "$real_recovery_summary"; eval "$real_last_fatal"
eval "$real_binary_for_shadow_rollback"
rm -f "$root/shadow-rollback-svc" "$root/shadow-rollback-cli" "$AUTO_HOLD" "$GUARD_STATE/bad/2"
rm -f "$GUARD_STATE/rejected/2"
active_version() { echo 1; }; latest_release() { echo 1; }; service_version() { echo 1; }

# A deploy onto an idle server is checked again on later ticks; a late break holds and reports.
sqlite3 "$DB" "delete from orchestration_v2_projection_runs; delete from orchestration_v2_projection_turn_items;"
rm -f "$AUTO_HOLD"; active_version() { echo 7; }
at=$(now '-20 minutes'); printf '7 %s\n' "$at" > "$GUARD_STATE/canary-pending"
late_canary; [[ -e "$GUARD_STATE/canary-pending" && ! -e "$AUTO_HOLD" ]] || fail 'late canary acted with nothing broken'
run_row ok9 P completed "$(now '-2 hours')" "$(now '-2 hours')"
open_fail L1 P "$(now '-5 minutes')"; open_fail L2 P "$(now '-4 minutes')"
exec 9>&-
late_canary; [[ -f "$AUTO_HOLD" && ! -e "$GUARD_STATE/canary-pending" ]] || fail 'late break not held'
grep -q 'broke provider sessions after it went live' "$AUTO_HOLD" || fail 'late hold reason'
[[ -e "$GUARD_STATE/rejected/7" && ! -e "$GUARD_STATE/bad/7" ]] || fail 'late break not marked rejected (and must not be marked bad)'
rm -f "$AUTO_HOLD"; printf '7 %s\n' "$(now '-3 hours')" > "$GUARD_STATE/canary-pending"
late_canary; [[ ! -e "$GUARD_STATE/canary-pending" && ! -e "$AUTO_HOLD" ]] || fail 'expired late canary not cleared'
( exec 9>>"$LOCK"; flock -n 9; printf '7 %s\n' "$(now '-10 minutes')" > "$GUARD_STATE/canary-pending"; rm -f "$AUTO_HOLD"
  late_canary; [[ -e "$GUARD_STATE/canary-pending" && ! -e "$AUTO_HOLD" ]] || fail 'late canary ran while another update held the lock' ) || exit 1
rm -f "$GUARD_STATE/canary-pending"
pass 'an idle deploy is re-checked on later ticks for 2 h; a late break holds, reports and marks the release rejected; it skips while an update holds the lock'
sqlite3 "$DB" "delete from orchestration_v2_projection_runs; delete from orchestration_v2_projection_turn_items;"
active_version() { echo 1; }

# A build that served but fails the canary, when the old build cannot open the migrated DB, stays.
latest_release() { echo 2; }; active_runs() { echo 0; }; quiet_seconds() { echo 99999; }
svc() { echo "$*" >> "$root/svc-stay"; return 0; }; wait_inactive() { return 0; }; snapshot_db() { echo "$root/snap"; }
binary_of() { echo /bin/true; }; installed() { return 0; }; is_trusted() { return 0; }
cur_v=1; active_version() { echo "$cur_v"; }; write_state_for() { :; }; service_version() { echo 2; }
can_open() { return 1; }; restore_db() { echo restored > "$root/restored"; }
provider_canary() { echo 'P:2 broken'; return 1; }
rm -f "$root/svc-stay" "$root/restored" "$AUTO_HOLD"
HEALTH_WAIT_SECONDS=30 cmd_update >/dev/null 2>&1 && fail 'stay path reported success'
[[ -f "$AUTO_HOLD" && ! -e "$root/restored" ]] || fail 'stay path restored the DB or set no hold'
! grep -q '^stop' "$root/svc-stay" 2>/dev/null || [[ "$(grep -c '^stop' "$root/svc-stay")" == 1 ]] || fail 'stay path stopped the service for a rollback'
pass 'a served build failing the canary stays (held) rather than restoring and discarding work'
unset -f provider_canary restore_db can_open
source <(sed -n '/^restore_db() {/,/^}/p' "$root/functions")
service_version() { echo 1; }; active_version() { echo 1; }; rm -f "$AUTO_HOLD" "$GUARD_STATE/bad/2"

# prove never records a build the update marked bad, and skips while an update holds the lock.
# Earlier tests ran cmd_update in this shell, which still holds the service lock on fd 9.
exec 9>&-
(
  source "$root/functions"
  active_version() { echo 5; }; service_version() { echo 5; }; service_uptime() { echo 100; }
  is_trusted() { return 0; }; outage_end() { :; }; log() { :; }
  mkdir -p "$GUARD_STATE/bad" "$GUARD_STATE/healthy" "$(dirname "$STATE_FILE")"; touch "$STATE_FILE"
  date -Is > "$GUARD_STATE/bad/5"; rm -f "$GUARD_STATE/healthy/5"*
  cmd_prove >/dev/null 2>&1
  [[ -e "$GUARD_STATE/bad/5" ]] || fail 'prove cleared a bad marker'
  ! is_healthy 5 || fail 'prove recorded a bad build healthy'
  rm -f "$GUARD_STATE/bad/5"
  exec 9>>"$LOCK"; flock -n 9
  cmd_prove >/dev/null 2>&1
  ! is_healthy 5 || fail 'prove recorded health while an update held the lock'
  exec 9>&-
  cmd_prove >/dev/null 2>&1
  is_healthy 5 || fail 'prove did not record a good build'
) || exit 1
pass 'prove skips a build marked bad, skips while an update holds the lock, and records a good build'

# A checksummed archive without the binary is rejected. (Earlier tests stub release_binary_sha.)
source <(sed -n '/^release_binary_sha() {/,/^}/p' "$root/functions")
mkdir -p "$root/rel/t3-9.9.9-linux-x64"; echo x > "$root/rel/t3-9.9.9-linux-x64/README"
tar czf "$root/rel/t3-9.9.9-linux-x64.tar.gz" -C "$root/rel" t3-9.9.9-linux-x64
(cd "$root/rel" && sha256sum t3-9.9.9-linux-x64.tar.gz > SHA256SUMS)
curl() { local out="" url=""; while (( $# )); do case "$1" in -o) out=$2; shift 2;; -*) shift;; *) url=$1; shift;; esac; done; cp "$root/rel/${url##*/}" "$out"; }
release_binary_sha 9.9.9 >/dev/null 2>&1 && fail 'archive without the binary accepted'
cp -r "$root/rel/t3-9.9.9-linux-x64" "$root/rel2"; echo bin > "$root/rel2/t3"; rm -rf "$root/rel/t3-9.9.9-linux-x64"; mv "$root/rel2" "$root/rel/t3-9.9.9-linux-x64"
tar czf "$root/rel/t3-9.9.9-linux-x64.tar.gz" -C "$root/rel" t3-9.9.9-linux-x64
(cd "$root/rel" && sha256sum t3-9.9.9-linux-x64.tar.gz > SHA256SUMS)
sha=$(release_binary_sha 9.9.9 2>/dev/null) || fail 'good archive rejected'
[[ "$sha" == "$(printf 'bin\n' | sha256sum | cut -d' ' -f1)" ]] || fail "binary sha wrong: $sha"
unset -f curl
pass 'release verification rejects an archive without the binary and hashes the real one'

timeout() { printf '%s\n' "$*" > "$root/timeout"; }
systemctl --user is-active t3code.service
[[ "$(cat "$root/timeout")" == '--kill-after=2 15 /usr/bin/systemctl --user is-active t3code.service' ]] || fail timeout
pass 'all systemctl calls have a bounded timeout'

# Snapshot-only path: real launcher-child listener in the current cgroup, full idle refusal,
# durable write-ahead intent, copy/restart timing, receipt privacy, and operation-ID idempotency.
# Service state and database changes are isolated; no live T3 unit or database is touched.
(
  exec 9>&-
  unset -f timeout
  T3CODE_HOME="$root/snapshot-t3" T3_GUARD_STATE_DIR="$root/snapshot-state"
  export T3CODE_HOME T3_GUARD_STATE_DIR
  source "$root/functions"
  DB="$T3CODE_HOME/userdata/statev2.sqlite"
  LOCK="$root/snapshot-service-change.lock"
  mkdir -p "$T3CODE_HOME/userdata" "$SNAPSHOTS"
  sqlite3 "$DB" "pragma user_version=119;
    create table orchestration_v2_projection_runs (run_id text, thread_id text, status text, requested_at text, completed_at text, payload_json text);
    create table orchestration_v2_projection_runtime_requests (runtime_request_id text, status text, resolved_at text);
    create table orchestration_v2_projection_turn_items (turn_item_id text, thread_id text, run_id text, type text, status text, updated_at text);
    create table orchestration_v2_projection_subagents (subagent_id text, status text);
    create table orchestration_v2_projection_provider_threads (provider_thread_id text, payload_json text);
    create table orchestration_v2_effect_outbox (effect_id text, status text);"
  sim_version=0.1.13-preview.20261127.1
  sim_control_group=""
  PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
  export PORT
  sim_command_fifo="$root/snapshot-command"
  sim_listener_file="$root/snapshot-listener.pid"
  sim_state_file="$root/snapshot-unit-state"
  sim_generation_file="$root/snapshot-generation"
  mkfifo "$sim_command_fifo"
  printf 'inactive\n' >"$sim_state_file"
  printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' >"$sim_generation_file"
  cat >"$root/snapshot-launcher.sh" <<'EOF'
#!/bin/bash
set -eu
command_fifo=$1
listener_file=$2
port=$3
listener_pid=""
stop_listener() {
  if [[ -n "$listener_pid" ]]; then
    kill "$listener_pid" 2>/dev/null || true
    wait "$listener_pid" 2>/dev/null || true
    listener_pid=""
  fi
  : >"$listener_file"
}
trap stop_listener EXIT
exec 3<>"$command_fifo"
while IFS= read -r command; do
  case "$command" in
    start)
      node -e 'const net=require("net"); const s=net.createServer(); s.listen(Number(process.argv[1]),"127.0.0.1"); setInterval(()=>{},1000)' "$port" >/dev/null 2>&1 &
      listener_pid=$!
      printf '%s\n' "$listener_pid" >"$listener_file"
      ;;
    stop) stop_listener ;;
    quit) exit 0 ;;
  esac
done <&3
EOF
  chmod +x "$root/snapshot-launcher.sh"
  bash "$root/snapshot-launcher.sh" "$sim_command_fifo" "$sim_listener_file" "$PORT" >/dev/null 2>&1 &
  sim_launcher_pid=$!
  sim_pid=$sim_launcher_pid
  sim_control_group=$(awk -F: '$1 == "0" { print $3; exit }' "/proc/$sim_pid/cgroup")
  [[ -n "$sim_control_group" ]] || fail 'fixture launcher has no unified cgroup'
  printf 'active\n' >"$sim_state_file"
  printf 'start\n' >"$sim_command_fifo"
  cleanup_sim_listener() {
    printf 'quit\n' >"$sim_command_fifo" 2>/dev/null || true
    kill "$sim_pid" 2>/dev/null || true
    wait "$sim_pid" 2>/dev/null || true
  }
  trap cleanup_sim_listener EXIT
  for ((i=0; i<50; i++)); do
    service_listener_pid >/dev/null 2>&1 && break
    sleep 0.05
  done
  service_listener_pid >/dev/null 2>&1 || fail 'could not start the isolated launcher-child listener'
  manager_ready() { return 0; }
  active_version() { echo "$sim_version"; }
  is_trusted() { return 0; }
  is_healthy() { return 0; }
  service_version() { echo "$sim_version"; }
  service_uptime() { echo 120; }
  unit_property() {
    case "$1" in
      ActiveState) cat "$sim_state_file" ;;
      InvocationID) cat "$sim_generation_file" ;;
      MainPID) echo "$sim_pid" ;;
      ControlGroup) echo "$sim_control_group" ;;
      *) return 1 ;;
    esac
  }
  kernel_hang_signs() { return 1; }
  wait_inactive() { [[ "$(cat "$sim_state_file")" == inactive ]]; }
  cp() { if [[ "$1" == --reflink=always ]]; then shift; fi; command cp "$@"; }
  snapshot_fsync() {
    local path
    for path in "$@"; do
      printf 'fsync:%s\n' "$path" >>"$root/snapshot-fsync"
      if [[ -e "$root/fail-prepared-receipt" && "$path" == */.snapshot-receipt.* ]]; then
        rm -f "$root/fail-prepared-receipt"
        return 1
      fi
    done
    python3 -c 'import os, sys
for path in sys.argv[1:]:
    flags = os.O_RDONLY
    if os.path.isdir(path):
        flags |= getattr(os, "O_DIRECTORY", 0)
    fd = os.open(path, flags)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)' "$@"
  }
  cmp() {
    [[ "$(cat "$sim_state_file")" == active ]] || fail 'full-file comparison ran while service was stopped'
    command cmp "$@"
  }
  sha256sum() {
    [[ "$(cat "$sim_state_file")" == active ]] || fail 'manifest hashing ran while service was stopped'
    printf 'hash-after-restart\n' >>"$root/snapshot-hash-order"
    command sha256sum "$@"
  }
  svc() {
    printf '%s\n' "$*" >>"$root/snapshot-svc"
    case "$1" in
      stop)
        [[ "$(jq -r '.status' "$GUARD_STATE/snapshot-receipts/snapshot-op.json")" == stop_requested ]] || fail 'stop ran without durable stop intent'
        [[ "$(tail -n 1 "$root/snapshot-fsync")" == "fsync:$GUARD_STATE/snapshot-receipts" ]] || fail 'stop ran before the receipt directory was fsynced'
        printf 'stop\n' >"$sim_command_fifo"
        local i
        for ((i=0; i<50; i++)); do
          [[ ! -s "$sim_listener_file" ]] && break
          sleep 0.05
        done
        printf 'inactive\n' >"$sim_state_file"
        printf 'wal bytes\n' >"$DB-wal"
        printf 'shm bytes\n' >"$DB-shm"
        ;;
      start)
        [[ "$(jq -r '.status' "$GUARD_STATE/snapshot-receipts/snapshot-op.json")" == copied ]] || fail 'restart ran before the copied receipt was durable'
        [[ "$(tail -n 1 "$root/snapshot-fsync")" == "fsync:$GUARD_STATE/snapshot-receipts" ]] || fail 'restart ran before the copied receipt directory was fsynced'
        printf 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n' >"$sim_generation_file"
        printf 'start\n' >"$sim_command_fifo"
        local i
        for ((i=0; i<50; i++)); do
          service_listener_pid >/dev/null 2>&1 && break
          sleep 0.05
        done
        service_listener_pid >/dev/null 2>&1 || fail 'same-version child listener did not restart'
        printf 'active\n' >"$sim_state_file"
        ;;
      *) return 1 ;;
    esac
    return 0
  }
  outage_begin() { :; }
  outage_end() { :; }
  log() { :; }
  QUIET_VALUE=900
  quiet_seconds() {
    if [[ -e "$root/insert-after-first-idle" && ! -e "$root/inserted-during-census" ]]; then
      sqlite3 "$DB" "insert into orchestration_v2_projection_runs values ('late','thread','preparing','2026-11-27T00:00:00.000Z',null,'{}');"
      touch "$root/inserted-during-census"
    fi
    echo "$QUIET_VALUE"
  }
  HEALTH_WAIT_SECONDS=0
  mkdir -p "$SNAPSHOTS/20200101T000000-before" "$SNAPSHOTS/20200102T000000-before" \
    "$SNAPSHOTS/20200103T000000-before" "$SNAPSHOTS/20200104T000000-before"

  QUIET_VALUE=899
  if cmd_snapshot snapshot-op before-stock-switch >/dev/null 2>&1; then fail 'snapshot accepted less than 15 minutes of quiet'; fi
  exec 9>&-
  QUIET_VALUE=900
  if cmd_snapshot "$(printf 'a%.0s' {1..60})" "$(printf 'b%.0s' {1..60})" >/dev/null 2>&1; then fail 'combined snapshot label over 128 characters was accepted'; fi
  exec 9>&-
  touch "$root/insert-after-first-idle"
  if cmd_snapshot snapshot-op before-stock-switch >/dev/null 2>&1; then fail 'snapshot missed activity arriving between idle reads'; fi
  exec 9>&-
  rm -f "$root/insert-after-first-idle" "$root/inserted-during-census"
  sqlite3 "$DB" "delete from orchestration_v2_projection_runs;"
  sqlite3 "$DB" "insert into orchestration_v2_projection_runs values ('queued','thread','queued','2026-11-27T00:00:00.000Z',null,'{}');"
  if cmd_snapshot snapshot-op before-stock-switch >/dev/null 2>&1; then fail 'snapshot stopped a queued run'; fi
  exec 9>&-
  sqlite3 "$DB" "delete from orchestration_v2_projection_runs; insert into orchestration_v2_projection_runs values ('preparing','thread','preparing','2026-11-27T00:00:00.000Z',null,'{}');"
  if cmd_snapshot snapshot-op before-stock-switch >/dev/null 2>&1; then fail 'snapshot stopped a preparing run'; fi
  exec 9>&-
  sqlite3 "$DB" "delete from orchestration_v2_projection_runs;
    insert into orchestration_v2_projection_runs values ('active-items','thread','running','2026-11-27T00:00:00.000Z',null,'{}');
    insert into orchestration_v2_projection_turn_items values ('item-command','thread','active-items','command_execution','pending','2026-11-27T00:00:00.000Z');
    insert into orchestration_v2_projection_turn_items values ('item-tool','thread','active-items','dynamic_tool','running','2026-11-27T00:00:00.000Z');
    insert into orchestration_v2_projection_turn_items values ('item-file','thread','active-items','file_change','waiting','2026-11-27T00:00:00.000Z');
    insert into orchestration_v2_projection_turn_items values ('item-subagent','thread','active-items','subagent','running','2026-11-27T00:00:00.000Z');
    insert into orchestration_v2_projection_turn_items values ('item-link','thread','active-items','link_request','pending','2026-11-27T00:00:00.000Z');
    insert into orchestration_v2_effect_outbox values ('effect-1','running');"
  if cmd_snapshot snapshot-op before-stock-switch >"$root/snapshot-reject.log" 2>&1; then fail 'snapshot ignored active command, tool, file, subagent, or link-request items'; fi
  grep -q 'activeItems=5' "$root/snapshot-reject.log" || fail 'complete active-item census did not report all five work types'
  grep -q 'activeEffects=1' "$root/snapshot-reject.log" || fail 'snapshot ignored a pending effect outbox job'
  exec 9>&-
  sqlite3 "$DB" "delete from orchestration_v2_projection_runs; delete from orchestration_v2_projection_turn_items;
    insert into orchestration_v2_projection_subagents values ('provider-subagent','running');
    insert into orchestration_v2_projection_subagents values ('app-owned-subagent','pending');"
  if cmd_snapshot snapshot-op before-stock-switch >/dev/null 2>&1; then fail 'snapshot stopped an active provider subagent'; fi
  exec 9>&-
  sqlite3 "$DB" "delete from orchestration_v2_projection_subagents; insert into orchestration_v2_projection_provider_threads values ('provider-thread','{\"pendingBackgroundTasks\":[{\"taskId\":\"task-1\"}]}');"
  if cmd_snapshot snapshot-op before-stock-switch >/dev/null 2>&1; then fail 'snapshot stopped a pending provider background task'; fi
  exec 9>&-
  sqlite3 "$DB" "delete from orchestration_v2_projection_provider_threads; insert into orchestration_v2_projection_provider_threads values ('provider-thread','invalid json');"
  if cmd_snapshot snapshot-op before-stock-switch >/dev/null 2>&1; then fail 'snapshot accepted an unreadable provider-thread payload'; fi
  exec 9>&-
  sqlite3 "$DB" "delete from orchestration_v2_projection_provider_threads; delete from orchestration_v2_effect_outbox;"
  [[ -z "$(grep '^stop ' "$root/snapshot-svc" 2>/dev/null || true)" ]] || fail 'snapshot stopped a busy or unverified service'

  # The real listener is a child in the unit cgroup, not MainPID. Both ancestry and exact cgroup
  # membership are required; an unrelated sibling in the same cgroup and a wrong cgroup fail.
  sim_identity=$(snapshot_service_identity "$sim_version") || fail 'real child listener did not bind to its launcher'
  sim_listener=$(service_listener_pid)
  [[ "$sim_listener" == "$(cat "$sim_listener_file")" && "$sim_listener" != "$sim_pid" ]] || fail 'fixture did not prove a child listener distinct from MainPID'
  sleep 100 &
  sibling_pid=$!
  sim_pid=$sibling_pid
  if snapshot_service_identity "$sim_version" >/dev/null 2>&1; then fail 'unrelated same-cgroup listener was accepted'; fi
  sim_pid=$sim_launcher_pid
  kill "$sibling_pid" 2>/dev/null || true
  wait "$sibling_pid" 2>/dev/null || true
  real_control_group=$sim_control_group
  sim_control_group=/outside-the-service-cgroup
  if snapshot_service_identity "$sim_version" >/dev/null 2>&1; then fail 'listener outside the exact unit cgroup was accepted'; fi
  sim_control_group=$real_control_group
  pass 'snapshot identity accepts its real child listener and rejects unrelated or out-of-cgroup listeners'

  touch "$root/fail-prepared-receipt"
  if cmd_snapshot snapshot-op before-stock-switch >/dev/null 2>&1; then fail 'snapshot proceeded when prepared receipt fsync failed'; fi
  exec 9>&-
  [[ -z "$(grep '^stop ' "$root/snapshot-svc" 2>/dev/null || true)" ]] || fail 'snapshot stopped before its prepared receipt was durable'
  [[ ! -e "$GUARD_STATE/snapshot-receipts/snapshot-op.json" ]] || fail 'failed prepared receipt was published'
  cmd_snapshot snapshot-op before-stock-switch >"$root/snapshot-out" || fail 'snapshot-only command failed in the isolated service fixture'
  out=$(cat "$root/snapshot-out")
  receipt="$GUARD_STATE/snapshot-receipts/snapshot-op.json"
  [[ "$(jq -r '.status' <<<"$out")" == complete ]] || fail 'snapshot receipt did not complete'
  [[ "$(jq -r '.stoppedGeneration.version' "$receipt")" == "$sim_version" ]] || fail 'receipt lost stopped version'
  [[ "$(jq -r '.stoppedGeneration.invocationId' "$receipt")" == aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ]] || fail 'receipt lost stopped invocation ID'
  [[ "$(jq -r '.restart.invocationId' "$receipt")" == bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ]] || fail 'receipt lost restarted invocation ID'
  [[ "$(jq -r '.files | map(.name) | sort | join(",")' "$receipt")" == 'statev2.sqlite,statev2.sqlite-shm,statev2.sqlite-wal' ]] || fail 'receipt omitted a SQLite file or sidecar'
  [[ "$(sha256sum "$(jq -r '.snapshotPath' "$receipt")/statev2.sqlite" | cut -d' ' -f1)" == "$(sha256sum "$DB" | cut -d' ' -f1)" ]] || fail 'snapshot main database differs from the stopped source'
  [[ "$(stat -c %a "$receipt")" == 600 && "$(stat -c %a "$(jq -r '.snapshotPath' "$receipt")")" == 700 ]] || fail 'snapshot receipt or files are not under owner-only directories'
  [[ "$(jq -r '.idleVerification.first.runs' "$receipt")" == 0 && "$(jq -r '.idleVerification.second.runs' "$receipt")" == 0 ]] || fail 'receipt did not retain both clean idle censuses'
  [[ -d "$SNAPSHOTS/20200101T000000-before" && -d "$SNAPSHOTS/20200104T000000-before" ]] || fail 'one-off snapshot rotated away an earlier copy'
  [[ "$(grep -c '^stop --no-block t3code.service$' "$root/snapshot-svc")" == 1 ]] || fail 'snapshot did not stop exactly once'
  [[ "$(grep -c '^start --no-block t3code.service$' "$root/snapshot-svc")" == 1 ]] || fail 'snapshot did not restart exactly once'
  [[ -s "$root/snapshot-hash-order" ]] || fail 'copied files were not hashed after restart'
  cmd_snapshot snapshot-op before-stock-switch >"$root/snapshot-out" || fail 'idempotent snapshot retry did not return its receipt'
  [[ "$(grep -c '^stop --no-block t3code.service$' "$root/snapshot-svc")" == 1 ]] || fail 'idempotent retry stopped the service twice'
  if cmd_snapshot snapshot-op different-point >/dev/null 2>&1; then fail 'snapshot reused an operation ID with a different point'; fi
  exec 9>&-
  [[ "$(grep -c '^stop --no-block t3code.service$' "$root/snapshot-svc")" == 1 ]] || fail 'mismatched receipt retry stopped the service again'
) || fail 'snapshot-only path violated its isolated activity, identity, durability, or restart contract'
pass 'snapshot-only path verifies full idle state and durable receipts, restarts before hashing, and is idempotent'
