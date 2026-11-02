#!/bin/zsh
# robob-watch check: warn before the Data volume or the user TMPDIR fills up.
# Background: 2026-10-16 the Mac hard-hung (watchdog reset) with ~57 GB free and
# then hung after FileVault unlock while ~280 GB of temp/orphaned files were
# cleaned up at boot. Fires once per low episode, repeats every 12h while low.
emulate -L zsh
FREE_MIN_GB=${FREE_MIN_GB:-150}
TMP_MAX_GB=${TMP_MAX_GB:-100}
REPEAT_S=$((12*3600))
W=${WATCH_DIR:-$PWD}
now=$(date +%s)
free_kb=$(/bin/df -k /System/Volumes/Data | /usr/bin/awk 'NR==2{print $4}')
[[ -z "$free_kb" ]] && { echo "df failed" >&2; exit 1; }
free_gb=$(( free_kb / 1024 / 1024 ))
T=$(/usr/bin/getconf DARWIN_USER_TEMP_DIR)
# du over TMPDIR takes >60s (millions of agent scratch files) and blew the
# watcher timeout on 2026-10-20. Measure it in a detached job at most every
# 6h and use the last finished value here, so the check itself stays instant.
TMP_EVERY_S=$((6*3600))
tmp_at=$(/usr/bin/stat -f %m "$W/tmp_kb" 2>/dev/null || echo 0)
if (( now - tmp_at > TMP_EVERY_S )) && ! { [[ -f "$W/tmp_du.pid" ]] && kill -0 "$(cat "$W/tmp_du.pid")" 2>/dev/null; }; then
  # one du over the dir (TMPDIR has 160k+ top-level entries, too many for a glob)
  ( cd "$T" 2>/dev/null && /usr/bin/du -k -d 1 . 2>/dev/null | /usr/bin/sort -rn > "$W/tmp_du.new"
    /usr/bin/awk '$2=="."{print $1; f=1} END{if(!f) print 0}' "$W/tmp_du.new" > "$W/tmp_kb.new"
    /usr/bin/awk '$2!="."' "$W/tmp_du.new" | /usr/bin/head -5 | /usr/bin/awk '{n=$2; sub(".*/","",n); printf "%s %.1fG; ", n, $1/1048576}' > "$W/tmp_top"
    /bin/mv "$W/tmp_kb.new" "$W/tmp_kb"; rm -f "$W/tmp_du.new" "$W/tmp_du.pid" ) </dev/null >/dev/null 2>&1 &!
  echo $! > "$W/tmp_du.pid"
fi
tmp_kb=$(cat "$W/tmp_kb" 2>/dev/null)
tmp_gb=$(( ${tmp_kb:-0} / 1024 / 1024 ))
low=0; why=()
(( free_gb < FREE_MIN_GB )) && { low=1; why+=("Data volume free ${free_gb} GB (< ${FREE_MIN_GB})"); }
(( tmp_gb > TMP_MAX_GB )) && { low=1; why+=("TMPDIR ${tmp_gb} GB (> ${TMP_MAX_GB})"); }
last=$(cat "$W/last_fire" 2>/dev/null || echo 0)
if (( low == 0 )); then
  # re-arm only after a healthy margin so we don't flap around the threshold
  (( free_gb >= FREE_MIN_GB + 20 )) && rm -f "$W/last_fire"
  exit 0
fi
(( now - last < REPEAT_S )) && exit 0
top=$(cat "$W/tmp_top" 2>/dev/null)  # from the detached du job above
msg="Disk space warning: ${(j:, :)why}. TMPDIR top: ${top:-n/a}. Low free space preceded the 2026-10-16 hang/reboot. Free space (old agent scratch in \$TMPDIR/opencode, caches) or reboot when idle."
# Owner rule 2026-10-20: deliver on Telegram only, never iMessage (prints nothing to robob-watch).
unset BUN_INSPECT
/Users/ardud/.bun/bin/bun /Users/ardud/.local/share/telegram-bridge/src/cli.ts notify --source "Disk space guard" --severity attention --text "$msg" --key "disk-space-guard:$now" >/dev/null 2>&1 || { echo "telegram notify failed" >&2; exit 1; }
echo "$now" > "$W/last_fire"
exit 0
