#!/bin/zsh
# Twelve check.sh cases against temp health.db / cards dir / WATCH_DIR. Never touches live state.
set -u
HERE=${0:A:h}
CHECK=${CHECK_SH:-$HERE/../../../../tmp/robob-board/morning-brief/watchers/whoop-recovery-card/check.sh}
T=$(mktemp -d "${TMPDIR:-/tmp}/morning-brief-test.XXXXXX")
trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok()  { echo "PASS $1"; pass=$((pass+1)); }
bad() { echo "FAIL $1 :: $2"; fail=$((fail+1)); }

mkdb() {  # $1 = db path; $2 = yes|no (recovery scored at 10:00 Dubai)
  sqlite3 "$1" "create table whoop_recovery(raw_json text); create table whoop_sleep(score_state text, raw_json text);"
  if [[ $2 == yes ]]; then
    sqlite3 "$1" "insert into whoop_recovery values ('{\"score_state\":\"SCORED\",\"created_at\":\"2026-10-28T06:00:00.000Z\"}');"
  fi
  sqlite3 "$1" "insert into whoop_sleep values ('SCORED','{\"created_at\":\"2026-10-28T01:00:00.000Z\"}');"
}
# run <case-dir> <now-dxb> <now-epoch>
run() {
  CARDS_DIR=$1/cards VAULT_DIR=$1/vault HEALTH_DB=$1/health.db WATCH_DIR=$1/watch \
  NOW_DXB=$2 NOW_EPOCH=$3 NO_SYNC=1 zsh "$CHECK"
}
setup() {  # $1 dir, $2 recovery yes/no
  mkdir -p "$1/cards/out" "$1/vault" "$1/watch"
  mkdb "$1/health.db" "$2"
}
# Cases 7-10: empty tables, so only the sleep rows they add exist.
setup_bare() {  # $1 dir
  mkdir -p "$1/cards/out" "$1/vault" "$1/watch"
  sqlite3 "$1/health.db" "create table whoop_recovery(raw_json text); create table whoop_sleep(score_state text, raw_json text);"
}
add_sleep() {  # $1 db; $2 created_at; $3 start; $4 end; $5 nap (true|false)
  sqlite3 "$1" "insert into whoop_sleep values ('SCORED','{\"created_at\":\"$2\",\"start\":\"$3\",\"end\":\"$4\",\"nap\":$5}');"
}
add_recovery() {  # $1 db; $2 created_at (scored today)
  sqlite3 "$1" "insert into whoop_recovery values ('{\"score_state\":\"SCORED\",\"created_at\":\"$2\"}');"
}
add_cycle() {  # $1 db; $2 start_utc; $3 timezone_offset
  sqlite3 "$1" "create table if not exists whoop_cycles(cycle_id integer primary key, start_utc text, timezone_offset text); insert into whoop_cycles(start_utc, timezone_offset) values ('$2','$3');"
}
EP_1230=$(/bin/date -j -u -f "%Y-%m-%dT%H:%M:%S" "2026-10-28T08:30:00" +%s)  # 12:30 Dubai

# 1. scored, no brief files, 12:30: fires once; rerun same day: silent
c=$T/c1; setup $c yes
o1=$(run $c 2026-10-28T12:30 $EP_1230)
o2=$(run $c 2026-10-28T12:40 $((EP_1230+600)))
[[ $o1 == *"just scored"* && -z $o2 ]] && ok "1 fires once at 12:30, silent on rerun" || bad "1" "run1=[$o1] run2=[$o2]"

# 2. 07:00 Dubai: never fires
c=$T/c2; setup $c yes
o=$(run $c 2026-10-28T07:00 $((EP_1230-19800)))
[[ -z $o ]] && ok "2 07:00 never fires" || bad "2" "[$o]"

# 3. out/$D-recovery-sent exists: no fire
c=$T/c3; setup $c yes; touch $c/cards/out/2026-10-28-recovery-sent
o=$(run $c 2026-10-28T12:30 $EP_1230)
[[ -z $o ]] && ok "3 recovery-sent marker suppresses" || bad "3" "[$o]"

# 4. pending-recovery-$D at 09:00: fires (old behaviour, before noon when a brief held)
c=$T/c4; setup $c yes; touch $c/cards/pending-recovery-2026-10-28
o=$(run $c 2026-10-28T09:00 $((EP_1230-12600)))
[[ $o == *"just scored"* ]] && ok "4 held brief at 09:00 fires" || bad "4" "[$o]"

# 5. not scored: NO_RECOVERY_TODAY after sleep age >= 45 min
c=$T/c5; setup $c no
o=$(run $c 2026-10-28T12:30 $((EP_1230+2700)))
[[ $o == NO_RECOVERY_TODAY* ]] && ok "5 NO_RECOVERY_TODAY path" || bad "5" "[$o]"

# 6. 00:30 Dubai with a scored recovery and a held brief: still never fires (night gate beats the held flag)
c=$T/c6; setup $c yes; touch $c/cards/pending-recovery-2026-10-28
o=$(run $c 2026-10-28T00:30 $((EP_1230-28800)))
[[ -z $o ]] && ok "6 00:30 never fires even when held" || bad "6" "[$o]"

# 7. only a 2.6h nap scored 4h ago, no recovery: silent (a nap never stands in for the main sleep)
c=$T/c7; setup_bare $c
add_sleep $c/health.db 2026-10-28T04:30:00.000Z 2026-10-27T20:43:00.000Z 2026-10-27T23:17:00.000Z true
o=$(run $c 2026-10-28T12:30 $EP_1230)
[[ -z $o && ! -f $c/watch/norec-2026-10-28 && ! -f $c/watch/sent-2026-10-28 ]] && ok "7 short nap alone is silent" || bad "7" "[$o]"

# 8. only a 6.6h sleep flagged nap=true scored 2h ago, no recovery: NO_RECOVERY_TODAY, norec only; rerun silent
c=$T/c8; setup_bare $c
add_sleep $c/health.db 2026-10-28T06:30:00.000Z 2026-10-27T23:14:00.000Z 2026-10-28T05:53:00.000Z true
o1=$(run $c 2026-10-28T12:30 $EP_1230)
o2=$(run $c 2026-10-28T12:40 $((EP_1230+600)))
[[ $o1 == NO_RECOVERY_TODAY* && -f $c/watch/norec-2026-10-28 && ! -f $c/watch/sent-2026-10-28 && -z $o2 ]] && ok "8 long nap-flagged sleep fires no-recovery once" || bad "8" "run1=[$o1] run2=[$o2]"

# 9. continue from 8: a SCORED recovery created today; the 'after all' line once, rerun silent
add_recovery $c/health.db 2026-10-28T08:00:00.000Z
o3=$(run $c 2026-10-28T12:50 $((EP_1230+1200)))
o4=$(run $c 2026-10-28T13:00 $((EP_1230+1800)))
[[ $o3 == *"just scored after all"* && $o3 == *"Send the fresh recovery card and say it came in after all."* && -f $c/watch/sent-2026-10-28 && -z $o4 ]] && ok "9 late recovery after no-recovery line says so once" || bad "9" "run3=[$o3] run4=[$o4]"

# 10. non-nap sleep, no recovery, age >= 45 min: NO_RECOVERY_TODAY (case 5 covers the same shape; this one uses real start/end)
c=$T/c10; setup_bare $c
add_sleep $c/health.db 2026-10-28T04:00:00.000Z 2026-10-27T20:00:00.000Z 2026-10-28T04:00:00.000Z false
o=$(run $c 2026-10-28T12:30 $EP_1230)
[[ $o == NO_RECOVERY_TODAY* && -f $c/watch/norec-2026-10-28 && $o != *travel* ]] && ok "10 non-nap sleep fires no-recovery, no travel without cycles" || bad "10" "[$o]"

# 11. same as 10, plus a non-Dubai cycle from the last two days: the line says travel
c=$T/c11; setup_bare $c
add_sleep $c/health.db 2026-10-28T04:00:00.000Z 2026-10-27T20:00:00.000Z 2026-10-28T04:00:00.000Z false
add_cycle $c/health.db 2026-10-27T22:00:00.000Z +01:00
o=$(run $c 2026-10-28T12:30 $EP_1230)
[[ $o == NO_RECOVERY_TODAY* && $o == *"Send Abdullah one line: No recovery score today (travel cycle)."* ]] && ok "11 non-Dubai cycle gives travel line" || bad "11" "[$o]"

# 12. same as 10, cycle on Dubai's +04:00: plain line, no travel
c=$T/c12; setup_bare $c
add_sleep $c/health.db 2026-10-28T04:00:00.000Z 2026-10-27T20:00:00.000Z 2026-10-28T04:00:00.000Z false
add_cycle $c/health.db 2026-10-27T22:00:00.000Z +04:00
o=$(run $c 2026-10-28T12:30 $EP_1230)
[[ $o == NO_RECOVERY_TODAY* && $o == *"Send Abdullah one line: No recovery score today."* && $o != *travel* ]] && ok "12 Dubai-only cycles give plain line" || bad "12" "[$o]"

echo "check.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
