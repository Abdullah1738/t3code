#!/bin/zsh
# check.sh cases against temp health.db / cards dir / WATCH_DIR. Never touches live state.
set -eu
HERE=${0:A:h}
CHECK=${CHECK_SH:-$HERE/../../watchers/whoop-recovery-card/check.sh}
T=$(mktemp -d "${TMPDIR:-/tmp}/morning-brief-test.XXXXXX")
trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok()  { echo "PASS $1"; pass=$((pass+1)); }
bad() { echo "FAIL $1 :: $2"; fail=$((fail+1)); }

schema() {
  sqlite3 "$1" "
    create table whoop_recovery(cycle_id integer primary key, sleep_id text, score_state text, recovery_score real, created_at_api text, raw_json text);
    create table whoop_sleep(sleep_id text primary key, cycle_id integer, sleep_date text, start_utc text, end_utc text, timezone_offset text, is_nap integer, score_state text, created_at_api text, raw_json text);
    create table whoop_cycles(cycle_id integer primary key, cycle_date text, start_utc text, end_utc text, timezone_offset text);
  "
}
mkdb() {  # $1 = db path; $2 = yes|no (recovery scored at 10:00 Dubai)
  schema "$1"
  add_sleep "$1" 2026-10-28T01:00:00.000Z 2026-10-27T20:00:00.000Z 2026-10-28T00:30:00.000Z false
  if [[ $2 == yes ]]; then
    add_recovery "$1" 2026-10-28T06:00:00.000Z 2026-10-28T00:30:00.000Z
  fi
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
setup_bare() {  # $1 dir
  mkdir -p "$1/cards/out" "$1/vault" "$1/watch"
  schema "$1/health.db"
}
add_sleep() {  # $1 db; $2 created_at_api; $3 start; $4 end; $5 is_nap; optional $6 id (default end)
  sqlite3 "$1" "insert into whoop_sleep(sleep_id, sleep_date, start_utc, end_utc, timezone_offset, is_nap, score_state, created_at_api, raw_json) values ('${6:-$4}',substr('$4',1,10),'$3','$4','+04:00',$5,'SCORED','$2','{}');"
}
add_recovery() {  # $1 db; $2 created_at_api; $3 sleep_id; optional $4 score_state
  sqlite3 "$1" "insert into whoop_recovery(sleep_id, score_state, created_at_api, raw_json) values ('$3','${4:-SCORED}','$2','{}');"
}
add_cycle() {  # $1 db; $2 start_utc; $3 timezone_offset
  sqlite3 "$1" "insert into whoop_cycles(start_utc, timezone_offset) values ('$2','$3');"
}
epoch() {
  /usr/bin/python3 -I -c 'import datetime,sys;print(int(datetime.datetime.fromisoformat(sys.argv[1]).timestamp()))' "$1"
}
EP_1230=$(epoch 2026-10-28T12:30:00+04:00)

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
add_recovery $c/health.db 2026-10-28T08:00:00.000Z 2026-10-28T05:53:00.000Z
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

EP_1116=$(epoch 2026-11-16T15:00:00+04:00)
backfill() {  # Historical sleeps uploaded together on 16 Nov; no raw_json timestamp fixtures.
  add_sleep "$1" 2026-11-16T16:58:39.128Z 2026-11-12T20:00:00.000Z 2026-11-13T03:41:08.710Z false
  add_sleep "$1" 2026-11-16T17:07:15.280Z 2026-11-13T20:00:00.000Z 2026-11-14T05:10:19.160Z false
  add_sleep "$1" 2026-11-16T17:11:36.774Z 2026-11-14T20:00:00.000Z 2026-11-15T05:39:31.160Z false
}
backfill_recoveries() {
  add_recovery "$1" 2026-11-16T16:58:39.128Z 2026-11-13T03:41:08.710Z
  add_recovery "$1" 2026-11-16T17:07:15.280Z 2026-11-14T05:10:19.160Z
  add_recovery "$1" 2026-11-16T17:11:36.774Z 2026-11-15T05:39:31.160Z
}

# A. Backfilled recoveries cannot use up today's single fire.
c=$T/cA; setup_bare $c; backfill $c/health.db; backfill_recoveries $c/health.db
o=$(run $c 2026-11-16T15:00 $EP_1116)
[[ -z $o && ! -f $c/watch/sent-2026-11-16 && ! -f $c/watch/norec-2026-11-16 ]] && ok "A backfilled recoveries stay silent" || bad "A" "[$o]"

# B. The real night wins even when the old nights have newer upload timestamps.
add_sleep $c/health.db 2026-11-16T05:00:00.000Z 2026-11-15T21:00:00.000Z 2026-11-16T04:30:00.000Z false
add_recovery $c/health.db 2026-11-16T05:00:00.000Z 2026-11-16T04:30:00.000Z
o1=$(run $c 2026-11-16T15:00 $EP_1116)
o2=$(run $c 2026-11-16T15:01 $((EP_1116+60)))
[[ $o1 == *"just scored (created 2026-11-16T05:00:00.000Z) for the sleep that ended 2026-11-16T04:30:00.000Z"* && -z $o2 && -f $c/watch/sent-2026-11-16 ]] && ok "B real recovery among backfills fires once" || bad "B" "first=[$o1] second=[$o2]"

# C. Upload hours after waking still belongs to today's sleep.
c=$T/cC; setup_bare $c
add_sleep $c/health.db 2026-11-16T04:45:00.000Z 2026-11-15T21:00:00.000Z 2026-11-16T04:30:00.000Z false
add_recovery $c/health.db 2026-11-16T10:30:00.000Z 2026-11-16T04:30:00.000Z
o=$(run $c 2026-11-16T15:00 $EP_1116)
[[ $o == *"just scored (created 2026-11-16T10:30:00.000Z)"* && -f $c/watch/sent-2026-11-16 ]] && ok "C late real upload fires" || bad "C" "[$o]"

# D. Old sleeps uploaded today cannot cancel the promised recovery card either.
c=$T/cD; setup_bare $c; backfill $c/health.db
o=$(run $c 2026-11-16T21:10 $(epoch 2026-11-16T21:10:00+04:00))
[[ -z $o && ! -f $c/watch/norec-2026-11-16 && ! -f $c/watch/sent-2026-11-16 ]] && ok "D backfilled sleeps cannot fire no-recovery" || bad "D" "[$o]"

# E. A real main sleep scored 50 min ago still fires no-recovery.
c=$T/cE; setup_bare $c
add_sleep $c/health.db 2026-11-16T10:10:00.000Z 2026-11-15T21:00:00.000Z 2026-11-16T04:30:00.000Z false
o=$(run $c 2026-11-16T15:00 $EP_1116)
[[ $o == NO_RECOVERY_TODAY* && -f $c/watch/norec-2026-11-16 && ! -f $c/watch/sent-2026-11-16 ]] && ok "E real sleep without recovery fires after 50 min" || bad "E" "[$o]"

# F. A scored recovery for a one-hour nap is not today's recovery or a no-recovery signal.
c=$T/cF; setup_bare $c
add_sleep $c/health.db 2026-11-16T09:30:00.000Z 2026-11-16T08:00:00.000Z 2026-11-16T09:00:00.000Z true
add_recovery $c/health.db 2026-11-16T09:30:00.000Z 2026-11-16T09:00:00.000Z
o=$(run $c 2026-11-16T15:00 $EP_1116)
[[ -z $o && ! -f $c/watch/sent-2026-11-16 && ! -f $c/watch/norec-2026-11-16 ]] && ok "F short nap recovery stays silent" || bad "F" "[$o]"

# G. Dubai day edges, on both branches. The band-local date deliberately disagrees with Dubai.
# end_utc                     belongs to 16 Nov Dubai
# 15 Nov 19:59 / 19:59:59.999   no
# 15 Nov 20:00 / 20:01         yes (inclusive lower bound)
# 16 Nov 19:59:59.999          yes
# 16 Nov 20:00                no  (exclusive upper bound)
for edge expected in \
  2026-11-15T19:59:00.000Z no \
  2026-11-15T19:59:59.999Z no \
  2026-11-15T20:00:00Z yes \
  2026-11-15T20:01:00.000Z yes \
  2026-11-16T19:59:59.999Z yes \
  2026-11-16T20:00:00Z no; do
  for branch in scored norec; do
    c=$T/cG-$edge-$branch; setup_bare $c
    add_sleep $c/health.db 2026-11-16T10:00:00.000Z 2026-11-15T12:00:00.000Z $edge false
    if [[ $expected == yes ]]; then band_date=2026-11-17; else band_date=2026-11-16; fi
    sqlite3 $c/health.db "update whoop_sleep set sleep_date='$band_date', timezone_offset='+08:00';"
    if [[ $branch == scored ]]; then add_recovery $c/health.db 2026-11-16T10:00:00.000Z $edge; fi
    o=$(run $c 2026-11-16T15:00 $EP_1116)
    if [[ $expected == no ]]; then
      [[ -z $o && ! -f $c/watch/sent-2026-11-16 && ! -f $c/watch/norec-2026-11-16 ]] && ok "G $edge $branch excluded" || bad "G $edge $branch" "[$o]"
    elif [[ $branch == scored ]]; then
      [[ $o == *"just scored"* && -f $c/watch/sent-2026-11-16 ]] && ok "G $edge recovery included" || bad "G $edge scored" "[$o]"
    else
      [[ $o == NO_RECOVERY_TODAY* && -f $c/watch/norec-2026-11-16 ]] && ok "G $edge no-recovery included" || bad "G $edge norec" "[$o]"
    fi
  done
done

# H. Grace is measured from scoring, even if waking was hours ago.
c=$T/cH; setup_bare $c
add_sleep $c/health.db 2026-11-16T10:16:00.000Z 2026-11-15T21:00:00.000Z 2026-11-16T04:30:00.000Z false
o=$(run $c 2026-11-16T15:00 $EP_1116)
[[ -z $o && ! -f $c/watch/norec-2026-11-16 ]] && ok "H 44 min since scoring stays silent" || bad "H" "[$o]"
o=$(run $c 2026-11-16T15:01 $((EP_1116+60)))
[[ $o == NO_RECOVERY_TODAY* && -f $c/watch/norec-2026-11-16 ]] && ok "H exactly 45 min since scoring fires" || bad "H threshold" "[$o]"

# I. The preserved nap rule accepts a three-hour nap on either branch.
for branch in scored norec; do
  c=$T/cI-$branch; setup_bare $c
  add_sleep $c/health.db 2026-11-16T10:00:00.000Z 2026-11-16T06:00:00.000Z 2026-11-16T09:00:00.000Z true
  if [[ $branch == scored ]]; then add_recovery $c/health.db 2026-11-16T10:00:00.000Z 2026-11-16T09:00:00.000Z; fi
  o=$(run $c 2026-11-16T15:00 $EP_1116)
  if [[ $branch == scored ]]; then
    [[ $o == *"just scored"* && -f $c/watch/sent-2026-11-16 ]] && ok "I three-hour nap recovery counts" || bad "I scored" "[$o]"
  else
    [[ $o == NO_RECOVERY_TODAY* && -f $c/watch/norec-2026-11-16 ]] && ok "I three-hour nap without recovery counts" || bad "I norec" "[$o]"
  fi
done

# J. A pending recovery joined to today's main sleep is still no scored recovery.
c=$T/cJ; setup_bare $c
add_sleep $c/health.db 2026-11-16T10:00:00.000Z 2026-11-15T21:00:00.000Z 2026-11-16T04:30:00.000Z false
add_recovery $c/health.db 2026-11-16T10:00:00.000Z 2026-11-16T04:30:00.000Z PENDING_SCORE
o=$(run $c 2026-11-16T15:00 $EP_1116)
[[ $o == NO_RECOVERY_TODAY* && -f $c/watch/norec-2026-11-16 && ! -f $c/watch/sent-2026-11-16 ]] && ok "J pending recovery does not count as scored" || bad "J" "[$o]"

echo "check.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
