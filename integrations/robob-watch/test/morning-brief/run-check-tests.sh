#!/bin/zsh
# Six check.sh cases against temp health.db / cards dir / WATCH_DIR. Never touches live state.
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

echo "check.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
