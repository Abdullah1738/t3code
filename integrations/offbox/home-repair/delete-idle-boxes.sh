#!/bin/zsh
# Deletes stopped (archived) run boxes on the home offbox server that nobody used for MIN_H hours, oldest idle first,
# through boatd's own API (DELETE /sandboxes/<id>), paced like the snapshot prune.
# Owner OK: Abdullah, 15 Nov 2026 ~17:16Z, AskUserQuestion in the home-monitor repair thread: "Idle 12h+, and keep doing it"
#   = his boxes only, never Moni's, never pinned boxes or saved bases; repeat when free space is under 150 GB until offbox #190 is live.
# Guards: list built read-only on the server (idle-boxes-list.py); the ardud API token cannot see other owners' boxes;
#   client bases/templates and any box named *template* are skipped; state is re-read as "archived" right before each delete.
set -u
MIN_H=${1:-12}
TARGET_GB=${2:-450}
STATE=${OFFBOX_STATE_DIR:-$HOME/.local/share/offbox}; R=$STATE/home-repair; IP=100.75.104.72
SOURCE=${0:A:h}
mkdir -p "$R"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
PROTECTION=$HOME/.config/opencode/skills/remote-compute/scripts/offbox_protection.py
[[ -f $PROTECTION ]] || { print -u2 'shared protection helper missing; refusing cleanup'; exit 1; }
ACTOR=$(python3 -I "$PROTECTION" --actor home-repair/delete-idle-boxes.sh --reason "archived, idle >= ${MIN_H}h; disk cleanup") || exit 1
box() { ssh -i ~/.ssh/offbox_server -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=20 \
      -o UserKnownHostsFile=$STATE/server_known_hosts -o HostKeyAlias=$IP root@$IP "$@"; }
STAMP=$(date -u +%Y%m%dT%H%MZ); LIST=$R/list-$STAMP.txt; LOG=$R/delete-$STAMP.log
log() { echo "$(date -u +%H:%M:%SZ) $*" >> $LOG; }
box "python3 -I - $MIN_H" < "$SOURCE/idle-boxes-list.py" > $LIST || { log "list build failed"; exit 1; }
PROT=$( (cd /Volumes/ExternalSSD/t3code-fork 2>/dev/null; offbox bases 2>/dev/null; offbox template list 2>/dev/null) | grep -o 'bx_[a-z0-9]*' | sort -u | tr '\n' ' ')
[[ -n $PROT ]] || { log "could not read the client's bases and templates; refusing to run"; exit 1; }
K=$(security find-generic-password -s offbox-server-api -a ardud -w 2>/dev/null); [[ -n $K ]] || { log "API key missing"; exit 1; }
# boatd wants the box named again in X-Ascii-Confirm-Delete on a DELETE (the offbox client's api.delete() sends the same header).
api() {
  { printf 'Authorization: Bearer %s\nX-Offbox-Caller: %s\n' "$K" "$ACTOR"
    [[ $1 == DELETE ]] && printf 'X-Ascii-Confirm-Delete: %s\n' "${2##*/}"
  } > "$WORK/headers"
  chmod 600 "$WORK/headers"
  curl -s -m ${3:-30} -H @"$WORK/headers" -X $1 -o "$WORK/response.json" -w '%{http_code}' http://$IP:8443/api/v1$2
}
pr() {  # sets FR (bytes still freeing), IO10, IO60 (io full pressure %), IMS (Incus answer time, ms), ST (boxes starting or resuming).
        # Read by /root/offbox-prune-loop/gate.sh on the server; an unreachable server reads as "busy".
  local o; o=$(box /root/offbox-prune-loop/gate.sh 2>/dev/null </dev/null) || o=""
  if [[ $o == <->\ <->\ <->\ <->\ <-> ]]; then local f=(${=o}); FR=$f[1]; IO10=$f[2]; IO60=$f[3]; IMS=$f[4]; ST=$f[5]
  else FR=999999999999; IO10=99; IO60=99; IMS=99999; ST=99; fi
}
a0=$(box 'zfs list -H -o avail offbox'); log "begin min_idle=${MIN_H}h listed=$(wc -l < $LIST | tr -d ' ') avail=$a0 protected=$(echo $PROT | wc -w | tr -d ' ')"
ok=0; skip=0; fail=0
while read -r b idle gb name <&3; do
  if [[ " $PROT " == *" $b "* || $name == *template* || $name == *person* ]]; then skip=$((skip+1)); log "skip $b protected ($name)"; continue; fi
  [[ -e $R/STOP ]] && { log "STOP file, ending"; break; }
  # Stop once there is room again (17 Nov): available plus still-freeing space of TARGET_GB or more. Fewer deletes means
  # fewer warm boxes lost and fewer big ZFS frees, which slow Incus writes and fail box starts (offbox #216).
  av=$(box 'echo $(( ($(zfs list -H -p -o avail offbox) + $(zpool get -H -p -o value freeing offbox)) / 1073741824 ))' 2>/dev/null </dev/null) || av=0
  [[ $av == <-> && $av -ge $TARGET_GB ]] && { log "room is back: ${av}G available incl. freeing (target ${TARGET_GB}G), ending"; break; }
  big=0; [[ ${gb%.*} -ge 50 ]] && big=1
  # Gate BEFORE: never delete while ZFS is still freeing or the disk is under pressure (no time cap; the pool has room).
  # A box over 50 GB goes alone and only when the last minute was calm as well.
  w=0
  while :; do
    pr; ok1=0
    # also (15 Nov 18:50Z, offbox #216): Incus must answer within 3 s and no box may be starting or resuming
    [[ $FR -lt 6000000000 && $IO10 -lt 15 && $IMS -lt 3000 && $ST -eq 0 ]] && ok1=1
    [[ $big == 1 && $IO60 -ge 10 ]] && ok1=0
    [[ $ok1 == 1 ]] && break
    w=$((w+1)); (( w % 20 == 0 )) && log "waiting before $b (${gb}G): freeing=$((FR/1073741824))G io_full avg10=$IO10 avg60=$IO60 incus=${IMS}ms starting=$ST"
    [[ -e $R/STOP ]] && break
    sleep 15
  done
  [[ -e $R/STOP ]] && { log "STOP file, ending"; break; }
  before="freeing=$((FR/1073741824))G io_full=$IO10/$IO60 incus=${IMS}ms starting=$ST"
  code=$(api GET /sandboxes/$b 20); st=$(python3 -I -c "import json,sys; d=json.load(open(sys.argv[1])); d=d.get('sandbox',d); print(d.get('state'), d.get('pinned'))" "$WORK/response.json" 2>/dev/null)
  if [[ $code != 200 || $st != "archived False" ]]; then skip=$((skip+1)); log "skip $b http=$code state=$st"; continue; fi
  code=$(api GET /sandboxes/$b/protection 20)
  if [[ $code != 200 ]] || ! python3 -I "$PROTECTION" --check "$WORK/response.json"; then
    skip=$((skip+1)); log "skip $b protection held or unknown http=$code"; continue
  fi
  # DELETE rechecks under boatd's lifecycle lock; the read above is never authority to bypass it.
  code=$(api DELETE /sandboxes/$b 330)
  if [[ $code == 200 || $code == 204 ]]; then ok=$((ok+1)); pr; log "deleted $b idle=${idle}h own=${gb}G $name | before: $before | after: freeing=$((FR/1073741824))G io_full=$IO10/$IO60 incus=${IMS}ms"
  else fail=$((fail+1)); log "FAIL $b http=$code $(head -c 160 "$WORK/response.json" | tr '\n' ' ')"; fi
  sleep 10
  # Drain AFTER: wait until what this delete released has been freed before even looking at the next box.
  while :; do pr; [[ $FR -lt 6000000000 && $IMS -lt 3000 ]] && break; [[ -e $R/STOP ]] && break; sleep 15; done
done 3< $LIST   # fd 3: ssh inside the loop must not eat the list from stdin
log "end ok=$ok skipped=$skip fail=$fail avail=$(box 'zfs list -H -o avail offbox') freeing=$(box 'zpool get -H -o value freeing offbox')"
