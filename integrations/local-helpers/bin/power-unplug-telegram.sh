#!/bin/zsh -f
# Telegram alert the moment the MacBook is unplugged, and when it is plugged back in (owner request 23 Oct 2026).
# launchd (com.ardud.power-unplug-telegram) runs it every 20s. ~/.local/state/power-source holds the source he was
# last told about; a change that couldn't be sent waits in power-source.pending (with its Telegram dedupe key) and
# is retried on the next run. `--test` sends one "alert works" message without touching either file.
pmset=${POWER_PMSET:-/usr/bin/pmset}
notify=(${POWER_NOTIFY:-$HOME/.bun/bin/bun} $HOME/.local/share/telegram-bridge/src/cli.ts notify)
state=$HOME/.local/state/power-source
pending=$state.pending
out=$("$pmset" -g batt) || exit 1
# Only a source pmset names counts; anything else (empty, a diagnostic) leaves the state alone.
if [[ $out == *"'AC Power'"* ]]; then now=ac
elif [[ $out == *"'Battery Power'"* ]]; then now=batt
else exit 0; fi
pct=''; [[ $out =~ '([0-9]+)%' ]] && pct="$match[1]%"
# The OpenCode server's inspector port leaks into children; bun can't bind it twice.
unset BUN_INSPECT
if [[ ${1:-} == --test ]]; then
  exec "${notify[@]}" --source Battery --severity info \
    --text "Test: the unplug alert works (now on ${${now/ac/AC power}/batt/battery}, ${pct:-unknown})." \
    --key "power-test:$(date +%Y%m%d%H%M%S)"
fi
# Write a file whole or not at all (a cut-off state or key would lose the retry).
save() { print -r -- "$2" > "$1.tmp.$$" && mv -f "$1.tmp.$$" "$1" || { rm -f "$1.tmp.$$"; return 1; } }
mkdir -p "${state:h}" || exit 1
prev=$(cat "$state" 2>/dev/null)
if [[ -z $prev ]]; then save "$state" $now; exit; fi
if [[ $prev == $now ]]; then rm -f "$pending"; exit 0; fi
# The pending change keeps its key and its text: the bridge only dedupes a resend with the same key AND the same
# text, so a retry after a lost reply must not pick up a newer battery percentage.
lines=(); [[ -f $pending ]] && lines=("${(@f)$(cat -- "$pending")}")
if [[ ${lines[1]:-} == power-$now:* && -n ${lines[3]:-} ]]; then
  key=$lines[1] sev=$lines[2] txt=$lines[3]
else
  key="power-$now:$(date +%Y%m%d%H%M%S)-$$"
  if [[ $now == batt ]]; then
    txt="MacBook was just UNPLUGGED (battery ${pct:-unknown}). Plug it back in."; sev=attention
  else
    txt="MacBook plugged back in (battery ${pct:-unknown})."; sev=info
  fi
  # No send without a saved key: a retry under a new key could repeat an alert that went through.
  save "$pending" "$key"$'\n'"$sev"$'\n'"$txt" || exit 1
fi
"${notify[@]}" --source Battery --severity $sev --text "$txt" --key "$key" || exit 1
# Pending goes only once the new source is saved; otherwise the next run retries under the same key.
save "$state" $now || exit 1
rm -f "$pending"
