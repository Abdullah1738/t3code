# Sourced with a fixed helper basename; no command arguments or output enter the log.
zmodload zsh/datetime 2>/dev/null || return 0
zmodload zsh/system 2>/dev/null || return 0
zmodload zsh/stat 2>/dev/null || return 0
_toollog_started=$EPOCHREALTIME
_toollog_name=$1
_toollog_subshell=$ZSH_SUBSHELL

_toollog_finish() {
  local helper_exit=$1
  zmodload zsh/files 2>/dev/null || return 0
  [[ -n ${ROBOB_TEST:-}${PYTEST_CURRENT_TEST:-} || ${NODE_ENV:-} == test ]] && [[ -z ${TOOLLOG_DIR:-} ]] && return 0
  [[ $_toollog_name =~ '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$' ]] || return 0
  local log_dir=${TOOLLOG_DIR:-$HOME/.robob/logs/tools/watchers}
  local log_day log_ts log_cutoff log_file log_old log_date log_fd cap_fd
  local log_now=$EPOCHREALTIME
  local log_seconds=${log_now%%.*}
  local log_kind=perf log_ok=true log_error='' log_ids="\"helper\":\"$_toollog_name\""
  local -F 3 log_ms=$(( (log_now - _toollog_started) * 1000 ))
  (( log_ms < 0 )) && log_ms=0
  TZ=UTC strftime -s log_day '%Y-%m-%d' $log_seconds || return 0
  TZ=UTC strftime -s log_ts '%Y-%m-%dT%H:%M:%S' $log_seconds || return 0
  local fraction=${log_now#*.}
  log_ts+=".${fraction[1,3]}Z"
  log_file=$log_dir/$log_day.ndjson
  if [[ ! -f $log_file ]]; then
    mkdir -p -m 700 "$log_dir" || return 0
    /bin/chmod 700 "$log_dir" || return 0
    TZ=UTC strftime -s log_cutoff '%Y-%m-%d' $(( log_seconds - 30 * 86400 )) || return 0
    for log_old in "$log_dir"/*(N); do
      log_date=${log_old:t}
      if [[ $log_date =~ '^(rollup-)?([0-9]{4}-[0-9]{2}-[0-9]{2})\.(ndjson|json|cap)$' && ${match[2]} < $log_cutoff ]]; then
        rm -f -- "$log_old" || true
      fi
    done
  fi
  [[ ${WATCH_ID:-} =~ '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$' && ! ${WATCH_ID:-} =~ '[0-9]{5}' ]] && log_ids+=",\"watcher\":\"$WATCH_ID\""
  if (( helper_exit )); then
    log_kind=error log_ok=false log_error=',"error":{"tag":"helper.exit_failed","message":"helper.exit_failed"}'
  fi
  local -A log_stat
  zstat -H log_stat "$log_file" 2>/dev/null || log_stat=(size 0)
  if [[ -f $log_file ]] && (( (log_stat[mode] & 0777) != 0600 )); then
    /bin/chmod 600 "$log_file" || return 0
  fi
  if (( log_stat[size] > 50 * 1024 * 1024 )); then
    if sysopen -w -o creat,excl -m 600 -u cap_fd "$log_dir/$log_day.cap" 2>/dev/null; then
      exec {cap_fd}>&-
      if sysopen -w -a -o creat -m 600 -u log_fd "$log_file"; then
        print -r -u $log_fd -- "{\"ts\":\"$log_ts\",\"tool\":\"watchers\",\"component\":\"logger\",\"kind\":\"error\",\"name\":\"log.cap\",\"ok\":false,\"error\":{\"tag\":\"log.cap\",\"message\":\"log.cap\"}}"
        exec {log_fd}>&-
      fi
    fi
    (( helper_exit == 0 )) && return 0
  fi
  sysopen -w -a -o creat -m 600 -u log_fd "$log_file" || return 0
  print -r -u $log_fd -- "{\"ts\":\"$log_ts\",\"tool\":\"watchers\",\"component\":\"helpers\",\"kind\":\"$log_kind\",\"name\":\"helper.run\",\"durationMs\":$log_ms,\"ok\":$log_ok,\"ids\":{$log_ids},\"props\":{\"exitCode\":$helper_exit}$log_error}"
  exec {log_fd}>&-
  return 0
}
TRAPEXIT() {
  local helper_exit=$?
  (( ZSH_SUBSHELL == _toollog_subshell )) || return $helper_exit
  _toollog_finish "$helper_exit" </dev/null >/dev/null 2>&1 || true
  return $helper_exit
}
