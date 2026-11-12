# Shared restart boundary; tests source this with a dummy process and stub app commands.
# A detector failure must never turn into permission to interrupt a client.
clients_clear() {
  snapshot=$(client_detector)
  rc=$?
  if [ "$rc" -ne 0 ]; then
    log "skip: ${snapshot:-client detection unavailable (rc=$rc)}"
    echo "$now" >"$STATE/last_hold_log"
    return 1
  fi
  return 0
}

open_mirage() {
  if [ -n "$(mirage_pid)" ]; then log "open skipped: already running pid $(mirage_pid)"; return 0; fi
  clients_clear || return 1
  open -g -a "$APP"
}

restart_mirage() {
  pid=$1
  clients_clear || return 0
  echo "$now" >"$STATE/last_restart"
  log "restart: graceful quit pid $pid"
  run_to 12 osascript -e "with timeout of 10 seconds" -e "tell application id \"$BUNDLE\" to quit" -e "end timeout" >/dev/null 2>"$STATE/osa.err"
  rc=$?
  [ $rc -ne 0 ] && log "restart: osascript quit rc=$rc $(head -c 160 "$STATE/osa.err" | tr '\n' ' ')"
  i=0
  while [ $i -lt 15 ] && kill -0 "$pid" 2>/dev/null; do sleep 1; i=$((i + 1)); done
  if kill -0 "$pid" 2>/dev/null; then
    clients_clear || return 0
    log "restart: still alive after 15 s, SIGTERM"
    kill -TERM "$pid" 2>/dev/null; sleep 3
  fi
  if kill -0 "$pid" 2>/dev/null; then
    clients_clear || return 0
    log "restart: SIGKILL"
    kill -KILL "$pid" 2>/dev/null; sleep 2
  fi
  if kill -0 "$pid" 2>/dev/null; then log "restart: pid $pid would not die"; return 1; fi
  sleep 2
  open_mirage || return 0
  if wait_listening 45; then
    log "restart: OK, pid $(mirage_pid) answering on 9852/9853"
  else
    log "restart: pid $(mirage_pid) not answering yet after 45 s (will keep checking)"
  fi
  rm -f "$STATE/last_hold_log"
  echo 0 >"$STATE/fails"
}
