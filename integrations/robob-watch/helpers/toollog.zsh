# Re-enter the helper once under the metadata logger. The child clears the guard so nested helpers log too.
if [[ ${_ROBOB_TOOLLOG_SHELL:-} == ${2:A} ]]; then
  unset _ROBOB_TOOLLOG_SHELL
  return 0
fi
[[ -f ${2:-} && -x /usr/bin/python3 ]] || return 0
export _ROBOB_TOOLLOG_SHELL=${2:A}
exec /usr/bin/python3 -I -B "${${(%):-%x}:A:h}/toollog.py" --shell-helper "$1" -- "${@:2}"
