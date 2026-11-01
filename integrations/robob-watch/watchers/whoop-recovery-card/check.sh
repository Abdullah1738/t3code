#!/bin/zsh
# Recovery card on its own: fires once per Dubai day when today's WHOOP recovery is scored.
# It no longer needs the morning brief first. Gates:
#   - never 00:00-08:00 Dubai (MINS must be > 480)
#   - before 12:00 Dubai only if a brief already went out held (pending-recovery-$D or out/$D-recovery-held)
#   - never if a recovery card already went out today (out/$D-recovery-sent, written by cards.py morning)
#   - never twice (sent-$D in WATCH_DIR)
# Also fires once when WHOOP scored today's sleep but gave no recovery for today, so the promised card
# never hangs. The line says travel only when a WHOOP cycle from the last two days is outside +04:00.
# Test overrides (unset in production): CARDS_DIR, VAULT_DIR, HEALTH_DB, NOW_DXB (YYYY-MM-DDTHH:MM Dubai),
# NOW_EPOCH (unix seconds), NO_SYNC (skip whoop sync).
CARDS=${CARDS_DIR:-$HOME/health-data/abdullah/cards}
VAULT=${VAULT_DIR:-$HOME/health-data/abdullah}
HDB=${HEALTH_DB:-$VAULT/health.db}
if [[ -n ${NOW_DXB:-} ]]; then
  D=${NOW_DXB%%T*}; HM=${NOW_DXB#*T}
else
  D=$(TZ=Asia/Dubai date +%F); HM=$(TZ=Asia/Dubai date +%H:%M)
fi
MINS=$(( 10#${HM%%:*} * 60 + 10#${HM#*:} ))
P=$CARDS/pending-recovery-$D
HELD=$CARDS/out/$D-recovery-held
SENT=$CARDS/out/$D-recovery-sent
(( MINS > 480 )) || exit 0
[[ -f "$WATCH_DIR/sent-$D" ]] && exit 0
[[ -f $SENT ]] && exit 0
if [[ -f $P || -f $HELD ]]; then BRIEF_HELD=1; else BRIEF_HELD=0; fi
(( BRIEF_HELD == 1 || MINS >= 720 )) || exit 0
if [[ -z ${NO_SYNC:-} ]]; then
  (cd "$VAULT" && /usr/bin/python3 whoop/whoop.py sync --days 2 >/dev/null 2>&1) || true
fi
# Dubai is UTC+4 all year: day D runs from 20:00Z the day before to 20:00Z on D.
LO=$(/usr/bin/python3 -c "import datetime,sys;print((datetime.date.fromisoformat(sys.argv[1])-datetime.timedelta(days=1)).isoformat()+'T20:00:00')" "$D")
HI=${D}T20:00:00
R=$(sqlite3 "$HDB" "select json_extract(raw_json,'\$.created_at') from whoop_recovery where json_extract(raw_json,'\$.score_state')='SCORED' and json_extract(raw_json,'\$.created_at') >= '$LO' and json_extract(raw_json,'\$.created_at') < '$HI' order by 1 desc limit 1")
if [[ -n $R ]]; then
  touch "$WATCH_DIR/sent-$D"; rm -f $P
  if [[ -f $WATCH_DIR/norec-$D ]]; then
    echo "Today's ($D) WHOOP recovery just scored after all (created $R); earlier today Abdullah was told there was no recovery score. Send the fresh recovery card and say it came in after all."
  else
    echo "Today's ($D) WHOOP recovery just scored (created $R). Send the fresh recovery card."
  fi
  exit 0
fi
# Newest scored main sleep (naps under 3h are ignored: a nap is tied to the previous cycle, and must
# not stand in for today's sleep). Recovery normally lands with it, so 45 min after such a sleep
# scored today with no recovery today means WHOOP tied the night to an older cycle and no card is coming.
S=$(sqlite3 "$HDB" "select json_extract(raw_json,'\$.created_at') from whoop_sleep where score_state='SCORED' and json_extract(raw_json,'\$.created_at') >= '$LO' and json_extract(raw_json,'\$.created_at') < '$HI' and (coalesce(json_extract(raw_json,'\$.nap'),0)=0 or (julianday(json_extract(raw_json,'\$.end'))-julianday(json_extract(raw_json,'\$.start')))*24 >= 3) order by 1 desc limit 1")
[[ -z $S ]] && exit 0
AGE=$(/usr/bin/python3 -c "import datetime,os,sys,time;now=float(os.environ.get('NOW_EPOCH') or time.time());print(int(now-datetime.datetime.fromisoformat(sys.argv[1].replace('Z','+00:00')).timestamp()))" "$S")
(( AGE >= 2700 )) || exit 0
# Own marker, not sent-$D: a later real recovery must still go out (see the SCORED path above).
[[ -f $WATCH_DIR/norec-$D ]] && exit 0
touch "$WATCH_DIR/norec-$D"; rm -f $P
# Travel only when WHOOP put a cycle from the last two days outside Dubai's +04:00.
LO2=$(/usr/bin/python3 -c "import datetime,sys;print((datetime.date.fromisoformat(sys.argv[1])-datetime.timedelta(days=2)).isoformat()+'T20:00:00')" "$D")
TZX=$(sqlite3 "$HDB" "select timezone_offset from whoop_cycles where start_utc >= '$LO2' and start_utc < '$HI' and coalesce(timezone_offset,'') not in ('','+04:00') order by start_utc desc limit 1" 2>/dev/null)
if [[ -n $TZX ]]; then
  echo "NO_RECOVERY_TODAY ($D): WHOOP scored last night's sleep at $S but gave no recovery for today, and its latest cycle is on a travel time zone ($TZX), so no recovery card is coming. Send Abdullah one line: No recovery score today (travel cycle)."
else
  echo "NO_RECOVERY_TODAY ($D): WHOOP scored last night's sleep at $S but gave no recovery for today, so no recovery card is coming. Send Abdullah one line: No recovery score today."
fi
