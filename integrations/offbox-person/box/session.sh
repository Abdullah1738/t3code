#!/usr/bin/env bash
# The person's desktop on her box, brought up idempotently by `offbox-person up`: Xvfb :99, openbox, a D-Bus
# session bus with AT-SPI (so cua-driver can read the browser's accessibility tree), the cua-driver daemon and
# the CloakBrowser launcher. Long-lived processes are setsid + nohup so they outlive the offbox run that started
# them; their pids live in ~/person/run. `session.sh stop-browser` closes the browser cleanly before a save.
# HOME_ROUTE=1: fail unless the reverse tunnel to the owner's home connection answers on 127.0.0.1:1055.
set -euo pipefail

P="$HOME/person"
RUN="$P/run"
mkdir -p "$RUN" "$P/work"

cat > "$P/session.env" <<EOF
export DISPLAY=:99
export DBUS_SESSION_BUS_ADDRESS=unix:path=$RUN/bus
export ACCESSIBILITY_ENABLED=1
export GTK_MODULES=gail:atk-bridge
export CUA_DRIVER_RS_TELEMETRY_ENABLED=0
export CUA_TELEMETRY_ENABLED=0
export PATH=$HOME/.local/bin:\$PATH
EOF
# shellcheck disable=SC1091
. "$P/session.env"

# Pid files from before a box stop/resume point at nothing, or at an unrelated reused pid.
boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo unknown)
if [ "$(cat "$RUN/boot" 2>/dev/null)" != "$boot" ]; then
  rm -f "$RUN"/*.pid
  echo "$boot" > "$RUN/boot"
fi

alive() { [ -f "$RUN/$1.pid" ] && kill -0 "$(cat "$RUN/$1.pid")" 2>/dev/null; }

# No job control in a script, so the background child is not a group leader and setsid execs in place: $! is the
# daemon's own pid.
start() {
  local name=$1; shift
  setsid nohup "$@" >>"$P/$name.log" 2>&1 </dev/null &
  echo $! > "$RUN/$name.pid"
}

wait_for() {
  local secs=$1 what=$2; shift 2
  for _ in $(seq 1 "$secs"); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done
  echo "session: $what did not come up" >&2
  return 1
}

port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
cdp_up() { curl -fsS http://127.0.0.1:9242/json/version >/dev/null 2>&1; }

if [ "${1:-}" = stop-browser ]; then
  if alive browser; then
    kill -TERM "$(cat "$RUN/browser.pid")"
    for _ in $(seq 1 30); do alive browser || exit 0; sleep 1; done
    echo "session: browser did not exit within 30s" >&2
    exit 1
  fi
  exit 0
fi

if ! alive xvfb; then
  # A resumed box keeps /tmp from before the stop, including the dead server's lock.
  rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
  start xvfb Xvfb :99 -screen 0 1440x900x24 -nolisten tcp
fi
wait_for 20 Xvfb xdpyinfo -display :99

if ! alive dbus; then
  rm -f "$RUN/bus"
  start dbus dbus-daemon --session --nofork --nopidfile --address="$DBUS_SESSION_BUS_ADDRESS"
fi
wait_for 10 D-Bus dbus-send --session --dest=org.freedesktop.DBus --type=method_call --print-reply / org.freedesktop.DBus.ListNames

alive atspi || start atspi /usr/libexec/at-spi-bus-launcher --launch-immediately
alive wm || start wm openbox

if ! alive cua; then
  start cua cua-driver serve
fi
wait_for 20 cua-driver cua-driver status

if [ "${HOME_ROUTE:-0}" = 1 ]; then
  wait_for 20 "home route (127.0.0.1:1055)" port_open 1055
fi

if ! cdp_up && ! alive browser; then
  start browser "$P/venv/bin/python" "$P/launch.py"
fi
for _ in $(seq 1 90); do
  cdp_up && exit 0
  alive browser || break
  sleep 2
done
echo "session: browser CDP did not come up; last launcher log lines:" >&2
tail -20 "$P/browser.log" >&2 || true
exit 1
