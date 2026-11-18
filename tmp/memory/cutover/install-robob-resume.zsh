#!/bin/zsh -f
# Install a Robob desktop build and resume the threads that were running.
#
#   zsh install-robob-resume.zsh [--ready-budget-s N] [--dmg PATH] [--exclude THREAD_ID]... [--restart-opencode]
#   zsh install-robob-resume.zsh --resume-only [SNAPSHOT.json]  # resend; defaults to pending.json
#   zsh install-robob-resume.zsh --dry-run                      # only show what it would snapshot and resume
#   zsh install-robob-resume.zsh --before-launch 'CMD'          # run CMD once Robob is closed, before the install
#
# 1. Snapshots every active top-level thread (running, waiting, queued or
#    needing input). Subagent child threads are left out: their parents are
#    told to resume them. Threads are merged into
#    ~/.robob/restart-snapshots/pending.json, so a failed or repeated run never
#    loses the list. If the server can't be reached, the pending list is used.
# 2. Quits Robob and waits until every process from /Applications/Robob.app
#    (and anything on its port) is gone. If some won't close, it lists them and
#    asks you to close them yourself, then re-checks when you continue; it
#    never gives up on its own. Same for OpenCode with --restart-opencode.
#    With --before-launch, runs CMD while Robob is closed; if CMD fails it
#    reopens the old Robob and stops. Then installs the newest dmg from
#    tmp/build/release (or --dmg) and relaunches it.
#    Reopens Robob through open-robob-clean.zsh, so it never inherits this shell's environment.
# 3. Waits for the server (no time limit: a first start that runs big database
#    migrations can take half an hour), then asks you to confirm the client has
#    loaded.
# 4. Queues this message on every pending thread, then clears pending.json:
#    "The robob client has restarted. Please resume what you are doing. If you
#    had any sub-agents they must also be resumed."
#    Threads in a live mission are skipped: mission recovery sends them their
#    own notice through the mission's control room.
set -euo pipefail

REL=/Volumes/ExternalSSD/t3code-fork/tmp/build/release
T3CTL_JS=/Volumes/ExternalSSD/t3code-fork/apps/server/src/ardud/control/t3ctl.mjs
SNAP_DIR=$HOME/.robob/restart-snapshots
PENDING=$SNAP_DIR/pending.json
MESSAGE="The robob client has restarted. Please resume what you are doing. If you had any sub-agents they must also be resumed."

DMG=""
RESUME_ONLY=0
RESUME_FILE=""
DRY_RUN=0
RESTART_OPENCODE=0
BEFORE_LAUNCH=""
READY_BUDGET_S=180 READY_BUDGET_SET=0
READINESS_JS=${0:A:h}/../../../apps/desktop/scripts/install-readiness.mjs
typeset -a EXCLUDE
while (( $# )); do
  case $1 in
    --ready-budget-s)
      (( $# >= 2 && ! READY_BUDGET_SET )) || { print -u2 -- '--ready-budget-s needs one value'; exit 2; }
      READY_BUDGET_S=$2 READY_BUDGET_SET=1; shift 2 ;;
    --dmg) DMG=$2; shift 2 ;;
    --exclude) EXCLUDE+=($2); shift 2 ;;
    --resume-only)
      RESUME_ONLY=1
      if (( $# > 1 )) && [[ $2 != --* ]]; then RESUME_FILE=$2; shift; fi
      shift ;;
    --restart-opencode) RESTART_OPENCODE=1; shift ;;
    --before-launch) BEFORE_LAUNCH=$2; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' $0; exit 0 ;;
    *) print -u2 "unknown argument: $1"; exit 2 ;;
  esac
done

unset BUN_INSPECT
if ! command -v node >/dev/null 2>&1; then
  export NVM_DIR=${NVM_DIR:-$HOME/.nvm}
  source "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
fi
command -v node >/dev/null 2>&1 || { print -u2 "node not found"; exit 1; }

READY_BUDGET_S=$(node "$READINESS_JS" validate "$READY_BUDGET_S") || exit 2

OPEN_CLEAN=${0:A:h}/open-robob-clean.zsh
[[ -f $OPEN_CLEAN ]] || { print -u2 "missing $OPEN_CLEAN (opens Robob with a clean environment)"; exit 1; }

t3ctl() { node $T3CTL_JS "$@"; }
py() { /usr/bin/python3 "$@"; }
# A dry run must not add to the real pending list, or write anything under
# ~/.robob: its scratch files live in $TMPDIR.
if (( DRY_RUN )); then
  DRY_DIR=$(mktemp -d ${TMPDIR:-/tmp}/robob-dry-run.XXXXXX)
  PENDING=$DRY_DIR/pending.json
  [[ -f $SNAP_DIR/pending.json ]] && cp $SNAP_DIR/pending.json $PENDING
  SNAP_DIR=$DRY_DIR
  trap 'rm -rf $DRY_DIR' EXIT
else
  mkdir -p $SNAP_DIR
  rm -f $SNAP_DIR/*.raw(N)
fi

# ROBOB_UNATTENDED=1 (missions-cutover-unattended.zsh, run in tmux): nobody is
# watching, so questions take their third argument ("yes" or "no") as the answer.
UNATTENDED=${ROBOB_UNATTENDED:-0}

ask_confirm() {
  local prompt=$1 yes=${2:-Continue} unattended_answer=${3:-no}
  if (( UNATTENDED )); then
    print "$prompt -> $unattended_answer (unattended)"
    [[ $unattended_answer == yes ]]
    return
  fi
  if [[ -t 0 ]]; then
    local reply
    print -n "$prompt [Enter = yes, n = no] "
    read -r reply
    [[ $reply != [nN]* ]]
  else
    osascript -e "button returned of (display dialog \"$prompt\" buttons {\"Cancel\", \"$yes\"} default button \"$yes\" with title \"Robob restart\")" >/dev/null 2>&1
  fi
}

# `open` passes this shell's env (agent session id, tmux, secrets) to Robob and everything it starts.
open_robob() {
  zsh $OPEN_CLEAN /Applications/Robob.app && return 0
  print -u2 "Opening Robob with a clean environment failed; opening it normally."
  open /Applications/Robob.app
}

pending_count() {
  [[ -f $1 ]] || { print 0; return; }
  py -c 'import json,sys; print(len(json.load(open(sys.argv[1])).get("threads", [])))' $1
}

# Prints the given threads that belong to a live mission, one per line. Mission
# recovery sends those threads their own notice, so this script skips them.
# A server without the endpoint (404), or one that can't be reached, prints
# nothing and every thread gets the resume message as before.
mission_members() {
  node -e '
const fs = require("fs"), os = require("os");
// Same order as the control client: a named token file, the t3ctl component, then the retired shared file.
let cfg = {};
for (const f of [process.env.T3_CONTROL_TOKEN_FILE, os.homedir() + "/.robob/components/t3ctl.json", os.homedir() + "/.robob/ardud-control.json"]) {
  if (!f) continue;
  try { cfg = JSON.parse(fs.readFileSync(f, "utf8")); break; } catch {}
}
const url = (process.env.T3_CONTROL_URL || cfg.url || "http://127.0.0.1:3773").replace(/\/$/, "");
fetch(`${url}/api/ardud/missions/recovery/members?threadIds=${encodeURIComponent(process.argv[1])}`,
  { headers: { authorization: `Bearer ${process.env.T3_CONTROL_TOKEN || cfg.token}` }, signal: AbortSignal.timeout(15000) })
  .then((r) => (r.ok ? r.json() : { members: [] }))
  .then((d) => { for (const m of d.members ?? []) console.log(m.threadId); })
  .catch(() => {});' "${(j:,:)@}" 2>/dev/null || true
}

# Harness cutover (#245): before any generic resume, classify the snapshot
# against the server's harness-cutover status. Only resumeThreadIds get the
# generic message. Threads a completed cutover already continued are dropped
# from pending without a send; threads an active cutover still owns, and
# unresolved ones, stay pending. If the status or the plan can't be read,
# nothing is sent and pending.json is kept (exit 3).
CUTOVER_PLAN_JS=${CUTOVER_PLAN_JS:-$HOME/.local/share/stream-recovery/scripts/installer-resume-plan.mjs}
# Recheck just before sending: the status endpoint is slow (~60 s), so it is
# read once more right before the send loop and every thread is checked
# against that fresh status locally. RECHECK_IDS holds the ids still resumable.
typeset -a RECHECK_IDS
recheck_resumable() {
  local snapshot=$1 f=${TMPDIR:-/tmp}/robob-cutover-recheck.$$.json again
  cutover_status_file $f || { rm -f $f; return 1; }
  again=$(node $CUTOVER_PLAN_JS $snapshot $f) || { rm -f $f; return 1; }
  rm -f $f
  RECHECK_IDS=("${(@f)$(py -c 'import json,sys; print("\n".join(json.loads(sys.argv[1])["resumeThreadIds"]))' $again)}")
  RECHECK_IDS=(${RECHECK_IDS:#})
}
still_resumable() { (( ${RECHECK_IDS[(Ie)$1]} )); }
cutover_status_file() {
  node -e '
const fs = require("fs"), os = require("os");
let cfg = {};
for (const f of [process.env.T3_CONTROL_TOKEN_FILE, os.homedir() + "/.robob/components/t3ctl.json"]) {
  if (!f) continue;
  try { cfg = JSON.parse(fs.readFileSync(f, "utf8")); break; } catch {}
}
const url = (process.env.T3_CONTROL_URL || cfg.url || "http://127.0.0.1:3773").replace(/\/$/, "");
fetch(`${url}/api/ardud/control/harness-cutover/status?claims=1`,
  { headers: { authorization: `Bearer ${process.env.T3_CONTROL_TOKEN || cfg.token}` }, signal: AbortSignal.timeout(300000) })
  .then(async (r) => { if (!r.ok) throw new Error(`status ${r.status}`); fs.writeFileSync(process.argv[1], await r.text()); })
  .catch((e) => { console.error(`harness-cutover status: ${e.message}`); process.exit(1); });' "$1"
}

resume_threads() {
  local snapshot=$1
  [[ -f $snapshot ]] || { print "No snapshot at $snapshot; nothing to resume."; return 0; }
  local -a ids all_ids drop_ids hold_ids
  all_ids=("${(@f)$(py -c '
import json, sys
for t in json.load(open(sys.argv[1])).get("threads", []):
    print(t["threadId"])
' $snapshot)}")
  all_ids=(${all_ids:#})
  if (( ${#all_ids} == 0 )); then
    print "No threads to resume."
    [[ $snapshot == $PENDING ]] && rm -f $PENDING
    return 0
  fi
  if [[ ${CUTOVER_CHECK:-1} == 1 ]]; then
    local status_file=${TMPDIR:-/tmp}/robob-cutover-status.$$.json plan
    if ! cutover_status_file $status_file; then
      rm -f $status_file
      print -u2 "Couldn't read the harness-cutover status; sent nothing and kept $snapshot. Retry: zsh $0 --resume-only"
      return 3
    fi
    if ! plan=$(node $CUTOVER_PLAN_JS $snapshot $status_file); then
      rm -f $status_file
      print -u2 "The cutover resume plan failed; sent nothing and kept $snapshot. Retry: zsh $0 --resume-only"
      return 3
    fi
    rm -f $status_file
    ids=("${(@f)$(py -c 'import json,sys; print("\n".join(json.loads(sys.argv[1])["resumeThreadIds"]))' $plan)}"); ids=(${ids:#})
    drop_ids=("${(@f)$(py -c 'import json,sys; print("\n".join(json.loads(sys.argv[1])["cutoverCompletedThreadIds"]))' $plan)}"); drop_ids=(${drop_ids:#})
    hold_ids=("${(@f)$(py -c 'import json,sys; p=json.loads(sys.argv[1]); print("\n".join(p["cutoverPendingThreadIds"]+p["unresolvedThreadIds"]))' $plan)}"); hold_ids=(${hold_ids:#})
    print "Cutover plan: ${#ids} to resume, ${#drop_ids} already continued by the cutover, ${#hold_ids} held."
    local d; for d in $drop_ids; do print "  cutover  $d (continued by the harness cutover; no resume sent)"; done
    for d in $hold_ids; do print "  held     $d (cutover pending or unresolved; stays in pending)"; done
    if (( ! DRY_RUN && ${#ids} )) && ! recheck_resumable $snapshot; then
      print -u2 "Couldn't recheck the harness-cutover status before sending; sent nothing and kept $snapshot. Retry: zsh $0 --resume-only"
      return 3
    fi
  else
    ids=($all_ids)
  fi
  local -a members
  members=("${(@f)$(mission_members $ids)}"); members=(${members:#})
  local sent=0 id
  local -a failed
  for id in $ids; do
    if [[ ${CUTOVER_CHECK:-1} == 1 ]] && (( ! DRY_RUN )) && ! still_resumable $id; then
      print "  skipped  $id (now owned by the harness cutover)"; hold_ids+=($id); continue
    fi
    if (( ${members[(Ie)$id]} )); then
      print "  mission  $id (mission recovery sends its notice)"; continue
    fi
    if (( DRY_RUN )); then
      print "  would resume $id"; continue
    fi
    if t3ctl send $id $MESSAGE --mode queue >/dev/null 2>&1; then
      print "  resumed $id"
      sent=$((sent + 1))
    else
      print -u2 "  FAILED  $id"
      failed+=($id)
    fi
  done
  (( DRY_RUN )) && return 0
  print "Sent the resume message to $sent thread(s), ${#failed} failed."
  if [[ $snapshot == $PENDING ]]; then
    # Keep only the threads that still need the message, plus those the
    # cutover still holds. Completed-cutover threads are dropped unsent.
    py - $PENDING ${failed[@]} ${hold_ids[@]} <<'PY'
import json, os, sys
path, *keep = sys.argv[1:]
data = json.load(open(path))
data["threads"] = [t for t in data["threads"] if t["threadId"] in keep]
if data["threads"]:
    json.dump(data, open(path, "w"), indent=2)
else:
    os.remove(path)
PY
  fi
  (( ${#failed} == 0 )) || { print -u2 "Retry the rest with: zsh $0 --resume-only"; return 1; }
}

if (( RESUME_ONLY )); then
  resume_threads ${RESUME_FILE:-$PENDING}
  exit $?
fi

# Waiting for Robob or OpenCode to close would wait on this script too if it
# ran inside one of them.
if (( ! DRY_RUN )); then
  p=$$
  while (( p > 1 )); do
    case $(ps -ww -o command= -p $p 2>/dev/null || true) in
      /Applications/Robob.app/*|/Volumes/ExternalSSD/opencode2/*)
        print -u2 "Run this from Terminal.app: it quits Robob, which would stop this shell too."
        exit 1 ;;
    esac
    p=$(ps -o ppid= -p $p 2>/dev/null | tr -d ' ' || true)
    [[ -n $p ]] || break
  done
fi

# 1. Snapshot, merged into pending.json.
STAMP=$(date +%Y%m%d-%H%M%S)
if (( ! DRY_RUN )); then
  OLD_BOOT_ID=$(node "$READINESS_JS" boot-id "$HOME/.robob/userdata/logs/boot.ndjson") || OLD_BOOT_ID=""
  print -r -- "{\"phase\":\"install_started\",\"readyBudgetS\":$READY_BUDGET_S,\"at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" \
    | tee -a "${ROBOB_INSTALL_LOG:-$HOME/.robob/install-$STAMP.ndjson}"
fi
RAW=$(mktemp $SNAP_DIR/.threads.XXXXXX)
if t3ctl threads --active --limit 500 > $RAW 2>/dev/null \
  && py - $RAW $PENDING $SNAP_DIR/$STAMP.json ${EXCLUDE[@]} <<'PY'
import json, sys
raw, pending, snapshot, *exclude = sys.argv[1:]
data = json.load(open(raw))
if not data.get("ok", True):
    sys.exit(1)
fresh = [
    {k: t.get(k) for k in ("threadId", "title", "state", "origin", "worktreePath", "activeRunId")}
    for t in data.get("threads", [])
    if t.get("threadId") not in exclude and not t.get("archived")
]
json.dump({"threads": fresh}, open(snapshot, "w"), indent=2)
try:
    merged = json.load(open(pending))["threads"]
except (OSError, ValueError, KeyError):
    merged = []
known = {t["threadId"] for t in merged}
merged += [t for t in fresh if t["threadId"] not in known]
merged = [t for t in merged if t["threadId"] not in exclude]
json.dump({"threads": merged}, open(pending, "w"), indent=2)
print(f"Snapshot: {len(fresh)} active thread(s) now, {len(merged)} pending resume -> {pending}")
for t in merged:
    print(f"  {t['state']:<11} {t['threadId']}  {t['title']}")
PY
then
  :
else
  count=$(pending_count $PENDING)
  if (( count > 0 )); then
    print -u2 "Couldn't read threads from the Robob server; using the $count pending thread(s) from an earlier run ($PENDING)."
  else
    print -u2 "Couldn't read threads from the Robob server and there is no pending list."
    ask_confirm "Robob's server isn't answering, so no threads were snapshotted. Install anyway?" "Install anyway" \
      || { rm -f $RAW; exit 1; }
  fi
fi
rm -f $RAW

if (( DRY_RUN )); then
  [[ -n $BEFORE_LAUNCH ]] && print "While Robob is closed it would run: $BEFORE_LAUNCH"
  print "After the restart it would resume:"
  resume_threads $PENDING
  print "Dry run: nothing installed, nothing sent."
  exit 0
fi

# 2. Install.
if [[ -z $DMG ]]; then
  DMG=$(ls -t $REL/Robob-*-arm64.dmg 2>/dev/null | head -1)
fi
[[ -f $DMG ]] || { print -u2 "No dmg found (looked in $REL)."; exit 1; }
print "Installing $DMG"

# Prints "pid<TAB>command" for $1 and all of its descendants.
proc_tree() {
  local pid=$1 child cmd
  cmd=$(ps -ww -o command= -p $pid 2>/dev/null || true)
  [[ -n $cmd ]] || return 0
  print -r -- "$pid"$'\t'"$cmd"
  for child in ${(f)"$(pgrep -P $pid 2>/dev/null || true)"}; do proc_tree $child; done
}

# Of the "pid<TAB>command" lines in $1, prints the PIDs still running that same
# command (so a reused PID is never mistaken for a leftover).
still_running() {
  local line pid cmd
  # The tree is empty when nothing was running; an unquoted empty arg drops out (set -u).
  for line in ${(f)${1:-}}; do
    [[ -n $line ]] || continue
    pid=${line%%$'\t'*}
    cmd=${line#*$'\t'}
    [[ $(ps -ww -o command= -p $pid 2>/dev/null || true) == "$cmd" ]] && print $pid
  done
  true
}

# Robob's own processes: the app bundle, the headless browsers its server
# starts, and whatever holds its port.
robob_pids() {
  {
    pgrep -f '^/Applications/Robob\.app/' 2>/dev/null || true
    pgrep -f "^$HOME/\\.robob/tools/" 2>/dev/null || true
    lsof -nP -iTCP:3773 -sTCP:LISTEN -t 2>/dev/null || true
  } | sort -un
}

# Waits until the function named $1 prints no PIDs. After $2 seconds it lists
# what's left and waits for you to close them, re-checking each time you
# continue. It never gives up on its own; Ctrl-C stops it and keeps the
# pending list, so you can just run the script again.
wait_until_closed() {
  local list_fn=$1 grace=$2 what=$3 i reply
  local -a pids
  for i in {1..$grace}; do
    pids=(${(f)"$($list_fn)"})
    (( ${#pids} == 0 )) && return 0
    sleep 1
  done
  if (( UNATTENDED )); then
    # Give them the configured grace, then TERM, then KILL whatever is left.
    for (( i=0; i<READY_BUDGET_S; i++ )); do
      pids=(${(f)"$($list_fn)"})
      (( ${#pids} == 0 )) && { print "All $what processes are closed."; return 0; }
      sleep 1
    done
    pids=(${(f)"$($list_fn)"})
    print -u2 "Unattended: ${#pids} $what process(es) still running after grace + $READY_BUDGET_S s; stopping them:"
    ps -o pid=,command= -p ${(j:,:)pids} 2>/dev/null | cut -c1-160 >&2 || true
    kill -TERM $pids 2>/dev/null || true
    sleep 20
    pids=(${(f)"$($list_fn)"})
    (( ${#pids} )) && kill -9 $pids 2>/dev/null || true
    sleep 2
  fi
  while true; do
    pids=(${(f)"$($list_fn)"})
    if (( ${#pids} == 0 )); then
      print "All $what processes are closed."
      return 0
    fi
    print -u2 "\n${#pids} $what process(es) are still running:"
    ps -o pid=,command= -p ${(j:,:)pids} 2>/dev/null | cut -c1-160 >&2 || true
    print -u2 "Close them yourself (Activity Monitor, or kill -9 <pid> in another window)."
    if [[ -t 0 ]]; then
      print -n "Press Enter when they're closed to check again (k = kill -9 these for me): "
      read -r reply || reply=""
    else
      reply=$(osascript -e "button returned of (display dialog \"${#pids} $what process(es) are still running. Close them yourself, then press Check again.\" buttons {\"Kill them for me\", \"Check again\"} default button \"Check again\" with title \"Robob restart\")" 2>/dev/null) || { reply=""; sleep 5; }
    fi
    if [[ $reply == [kK]* ]]; then
      kill -9 $pids 2>/dev/null || true
    fi
    sleep 1
  done
}

source "${0:A:h}/../../../integrations/robob-guard/scripts/install-hold.zsh"
robob_hold_begin install-robob-resume || exit $?

if [[ -n $(robob_pids) ]]; then
  # Remember the whole tree first: provider CLIs and terminals Robob started
  # can outlive it once their parent is gone.
  ROBOB_TREE=""
  for p in ${(f)"$(robob_pids)"}; do ROBOB_TREE+="$(proc_tree $p)"$'\n'; done
  robob_left() { { still_running $ROBOB_TREE; robob_pids; } | sort -un; }
  robob_quit_reason install-robob-resume || exit $?
  osascript -e 'tell application "Robob" to quit' >/dev/null 2>&1 || true
  print "Waiting for Robob and everything it started to close..."
  wait_until_closed robob_left 90 Robob
fi

if [[ -n $BEFORE_LAUNCH ]]; then
  print "Robob is closed. Running: $BEFORE_LAUNCH"
  if zsh -c "$BEFORE_LAUNCH"; then :; else
    hook_rc=$?
    # 70: the step could not put its DB files back whole (release DB window), so Robob must stay closed.
    if (( hook_rc == 70 )); then
      print -u2 "That step failed AND could not restore its DB files. Nothing was installed and Robob stays closed; read the lines above before opening it."
      robob_hold_wait_for_repair t3ctl health
      exit 70
    fi
    print -u2 "That step failed, so nothing was installed. Reopening the current Robob."
    open_robob
    exit 1
  fi
fi

MNT=$(mktemp -d /tmp/robob-dmg.XXXXXX)
hdiutil attach -nobrowse -readonly -mountpoint $MNT $DMG >/dev/null
trap 'hdiutil detach $MNT -quiet >/dev/null 2>&1 || true; rmdir $MNT 2>/dev/null || true' EXIT

if (( RESTART_OPENCODE )); then
  OC_LABEL=com.ardud.opencode-service
  OC_PLIST=$HOME/Library/LaunchAgents/$OC_LABEL.plist
  OC_TREE=""
  # An unloaded agent makes launchctl print fail; under pipefail that would end the installer here.
  oc_pid=$(launchctl print gui/$UID/$OC_LABEL 2>/dev/null | awk '/^\tpid = /{print $3; exit}' || true)
  [[ -n $oc_pid ]] && OC_TREE=$(proc_tree $oc_pid)
  opencode_pids() {
    {
      still_running $OC_TREE
      pgrep -f '^/Volumes/ExternalSSD/opencode2/' 2>/dev/null || true
      lsof -nP -iTCP:49374 -sTCP:LISTEN -t 2>/dev/null || true
    } | sort -un
  }
  # bootout (not kickstart) so KeepAlive can't bring it back while old
  # processes are still holding the port.
  launchctl bootout gui/$UID/$OC_LABEL 2>/dev/null || true
  print "Waiting for OpenCode and everything it started to close..."
  wait_until_closed opencode_pids 60 OpenCode
  # Never exit here: Robob is closed and still has to be installed and reopened.
  launchctl bootstrap gui/$UID $OC_PLIST 2>/dev/null || launchctl kickstart gui/$UID/$OC_LABEL 2>/dev/null || true
  PW=$(cat $HOME/.config/opencode-service/password)
  print -n "Waiting for OpenCode"
  for (( i=0; i<READY_BUDGET_S; i+=2 )); do
    if curl -fsS -u opencode:$PW http://127.0.0.1:49374/api/info >/dev/null 2>&1; then
      print " up."
      break
    fi
    print -n "."
    sleep 2
  done
  curl -fsS -u opencode:$PW http://127.0.0.1:49374/api/info >/dev/null 2>&1 \
    || print -u2 "\nOpenCode still not answering; check ~/Library/Logs/opencode-service.log."
fi

rm -rf /Applications/Robob.app
ditto $MNT/Robob.app /Applications/Robob.app
xattr -dr com.apple.quarantine /Applications/Robob.app 2>/dev/null || true
print "Installed $(defaults read /Applications/Robob.app/Contents/Info.plist CFBundleShortVersionString)"
open_robob

# 3. Wait for the server, then for you.
# No time limit: the first start of a new build can run long migrations
# before it answers (0.1.0 on the 75 GB database: about half an hour).
print "Waiting for the Robob server (a first start after an upgrade can take 30 minutes or more)"
WAIT_START=$SECONDS
BUDGET_REPORTED=0
until t3ctl health >/dev/null 2>&1; do
  sleep 5
  if (( ! BUDGET_REPORTED && SECONDS - WAIT_START >= READY_BUDGET_S )); then
    BUDGET_REPORTED=1
    boot=$(node "$READINESS_JS" boot-phase "$HOME/.robob/userdata/logs/boot.ndjson" "$OLD_BOOT_ID") \
      || boot='{"unavailable":"diagnostic_failed"}'
    print -r -- "{\"phase\":\"recovery_waiting\",\"readyBudgetS\":$READY_BUDGET_S,\"boot\":$boot}" \
      | tee -a "${ROBOB_INSTALL_LOG:-$HOME/.robob/install-$STAMP.ndjson}" \
      || { print -u2 'Could not write recovery diagnostic; keeping the install heartbeat.' || true; }
  fi
  if (( (SECONDS - WAIT_START) % 60 < 5 )); then
    print "  still starting, $(( (SECONDS - WAIT_START) / 60 )) min so far"
  fi
done
print "Server up after $(( (SECONDS - WAIT_START) / 60 )) min."

if (( $(pending_count $PENDING) == 0 )); then
  print "No threads were running before the restart; nothing to resume."
  exit 0
fi
if (( UNATTENDED )); then
  # Nobody can confirm the client loaded, so wait until the server answers
  # thread reads three times in a row (a first start is slow for ~10 minutes).
  print "Unattended: waiting until the server answers reads steadily"
  ok_in_row=0 WAIT_START=$SECONDS
  until (( ok_in_row >= 3 )); do
    if t3ctl threads --active --limit 5 >/dev/null 2>&1; then ok_in_row=$((ok_in_row + 1)); else ok_in_row=0; fi
    (( ok_in_row >= 3 )) || sleep 20
  done
  print "Server answering steadily after $(( (SECONDS - WAIT_START) / 60 )) more min."
fi
if ! ask_confirm "Robob has restarted. Has the client finished loading? Confirm to resume the previously running threads." "Resume threads" yes; then
  print "Not resuming yet. When ready: zsh $0 --resume-only"
  exit 0
fi

# 4. Resume.
resume_threads $PENDING
