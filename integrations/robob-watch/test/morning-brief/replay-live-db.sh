#!/bin/zsh
# Replays whoop-recovery-card check.sh on four real days. Reads the live health.db only through
# `sqlite3 -readonly .backup` into a temp dir; each case runs on a copy with rows created after the
# simulated time removed. Never writes to the live DB, the live cards dir or the live watch dir.
# Override: CHECK_SH (staged check.sh), LIVE_DB (source DB).
set -u
CHECK=${CHECK_SH:-/Volumes/ExternalSSD/t3code-fork/tmp/robob-board/whoop-nap-norec/watchers/whoop-recovery-card/check.sh}
LIVE=${LIVE_DB:-$HOME/health-data/abdullah/health.db}
T=$(mktemp -d "${TMPDIR:-/tmp}/whoop-replay.XXXXXX")
trap 'rm -rf "$T"' EXIT
sqlite3 -readonly "$LIVE" ".backup '$T/h.db'" || { echo "backup failed"; exit 1; }

pass=0; fail=0
# replay <label> <dubai-day> <dubai-HH:MM> <utc YYYY-MM-DDTHH:MM> <held 0|1> <expect silent|just scored|NO_RECOVERY_TODAY>
replay() {
  local label=$1 d=$2 hm=$3 utc=$4 held=$5 want=$6
  local c=$T/$label cut="${4}:00.000Z" ep out ok
  mkdir -p $c/cards/out $c/watch
  cp $T/h.db $c/health.db
  sqlite3 $c/health.db "delete from whoop_recovery where json_extract(raw_json,'\$.created_at') > '$cut'; delete from whoop_sleep where json_extract(raw_json,'\$.created_at') > '$cut';"
  (( held == 1 )) && touch $c/cards/out/$d-recovery-held
  ep=$(/bin/date -j -u -f "%Y-%m-%dT%H:%M:%S" "${utc}:00" +%s)
  out=$(CARDS_DIR=$c/cards VAULT_DIR=$c/vault HEALTH_DB=$c/health.db WATCH_DIR=$c/watch \
    NOW_DXB=$d'T'$hm NOW_EPOCH=$ep NO_SYNC=1 zsh "$CHECK")
  case $want in
    silent) [[ -z $out ]] && ok=1 || ok=0 ;;
    "just scored") [[ $out == *"just scored"* ]] && ok=1 || ok=0 ;;
    NO_RECOVERY_TODAY) [[ $out == NO_RECOVERY_TODAY* ]] && ok=1 || ok=0 ;;
  esac
  if (( ok == 1 )); then pass=$((pass+1)); echo "PASS $label (expect $want)"; else fail=$((fail+1)); echo "FAIL $label (expect $want) :: [$out]"; fi
}

replay d29-1002 2026-10-29 10:02 2026-10-29T06:02 1 silent
replay d29-1140 2026-10-29 11:40 2026-10-29T07:40 1 "just scored"
replay d26-1200 2026-10-26 12:00 2026-10-26T08:00 0 silent
replay d24-1200 2026-10-24 12:00 2026-10-24T08:00 0 NO_RECOVERY_TODAY

echo "replay: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
