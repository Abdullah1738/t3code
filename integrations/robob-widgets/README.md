# Robob Widgets

This loopback server supplies widget descriptions, live data and button actions
to the generic Robob Cards widget. Definitions are re-read on every request, so
adding or changing a widget does not restart the server or rebuild the app. The
WidgetKit client, its Moni-free ad hoc build and push refresh are separate work.

## Install (after approval)

From the reviewed, merged fork:

```sh
./integrations/deploy.zsh robob-widgets --dry-run
./integrations/deploy.zsh robob-widgets
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.ardud.robob-widgets.plist"
tailname add widgets 8495 --note "Robob Widgets server"
```

The installer copies the server, sources, executable and LaunchAgent, and makes
the log directory. It does **not** load or restart the agent, or configure the
gateway. If the agent was already loaded, follow the usual approved launchd
reload procedure instead of bootstrapping it again. Installation keeps existing
files in `~/.local/share/robob-widgets/widgets/`, including changes to the
shipped definitions; review and update those explicitly when needed.

The default listener is `127.0.0.1:8495`; set `ROBOB_WIDGETS_PORT` to change
the port and `ROBOB_WIDGETS_HOME` to change the state and definitions home.
The packaged definitions point to the default installed source paths. When
using a different home, change those paths in the copied definitions too.
LaunchAgent logs go to `~/Library/Logs/robob-widgets/server.log`.

## Routes

- `GET /api/widgets`: `{ "widgets": [{ "id", "title", "families", "refreshMinutes" }] }`.
- `GET /api/widgets/:id`: `{ "id", "title", "asOf", "refreshMinutes", "blocks", "actions" }`.
- `POST /api/widgets/:id/actions/:action`: `{ "ok": true, "message": "..." }`.

Errors are JSON `{ "error": "..." }` and have a 4xx or 5xx status. Rendered
results are cached for 60 seconds. A failed source returns its last good render
with `stale: true` and its original `asOf`; with no last good render, it returns
502. GET and action responses wait at most 8 seconds for source or action work.
If a source is still running, GET returns the last good render with `stale: true`,
or 503 `{ "error": "source still running" }` when no render is cached. The
source continues in the background to fill the cache; concurrent GETs and
refreshes share one in-flight source per widget.

`refresh` reruns the source and returns an error if it fails. Other actions
invalidate the cache so the next render runs the source again. If an action
(including refresh) is still running at the response deadline, POST returns
202 `{ "ok": true, "pending": true, "message": "Still running" }`; the
command continues until completion or its configured execution timeout.

For safe retries, send an opaque `Idempotency-Key` header on the POST. A first
tap sends a new key without a replay header. Every manual retry of that same
tap must send the same key **and** `Idempotency-Replay: 1`. A replay attaches
to running work or returns its saved final status and body, but never starts
an action. If the key is absent (including after restart, expiry or eviction),
the server responds 409 with `ok: false`, `error: "unknown_key"` and
`replayable: false`. The effect must be checked before a new tap. Replay without
a key is a 400 error. Keys are scoped to widget and action and may contain up
to 200 printable ASCII characters. Results stay in memory for 10 minutes after
completion, subject to eviction of the oldest
completed entries when the 1,000-key capacity is reached. Running entries are
never evicted; if all slots are running, a new keyed action gets 503
`{ "error": "busy" }` without starting. A restart loses all keys and results.
Without the replay header, a missing or expired key is treated as a new tap and
can execute. Without a key, every POST may execute; never blindly retry an
unkeyed action after a timeout or 202 response.

Commands and their stdout/stderr are not sent to the client. Mutating requests
with an `Origin` other than `https://widgets.tail` are rejected; native widget
requests do not send one.

The server itself has no authentication; the tailnet gateway is the access
boundary. Every tailnet device that can reach it can read these widgets and
invoke their defined actions. Do not publish this service to the public internet
or add destructive actions without considering that trust boundary.

## Add a widget

1. Write a source executable that prints exactly one JSON object with a
   `blocks` array to stdout. It may be any executable already on the Mac. Use
   stable absolute paths, and keep diagnostics and secrets off stdout.
2. Add `~/.local/share/robob-widgets/widgets/<id>.json`, e.g.:

```json
{
  "id": "example",
  "title": "Example",
  "families": ["systemSmall", "systemMedium"],
  "refreshMinutes": 15,
  "source": { "command": ["/usr/bin/python3", "/absolute/path/to/source.py"], "timeoutSec": 20 },
  "actions": [
    { "id": "refresh", "label": "Refresh", "symbol": "arrow.clockwise" },
    { "id": "do-it", "label": "Do it", "symbol": "checkmark", "command": ["/absolute/path/to/action"] }
  ]
}
```

IDs and action IDs match `^[a-z0-9-]{1,40}$`. The source and actions run as
argument arrays via `execFile`, never through a shell. Timeout defaults to 20
seconds and is capped at 60; action commands use the same timeout. Only trusted
local writers should be allowed to modify definitions or their executables:
they can run commands as the server user. To remove a widget, remove its
definition. Invalid files and duplicate IDs are skipped.

Sources can emit `rings` (`items` with label/value/max/unit), `stat`
(label/value/optional delta), `progress` (label/value/max), `list` (rows with
label/value), and `sparkline` (label/points) blocks. Unknown block types are
for the client to skip. Actions published to the client contain only id, label
and symbol; `refresh` takes no command. It is available even if not advertised
in the definition.

The included widgets are macros from `food.py today --json` (food day rolls
over at 04:00 Dubai) and progress for the Crpko native v1 goal. The macro
source opens the nutrition database in SQLite read-only mode; SQLite can still
update its `-shm` WAL coordination file. The board source takes a board ID or
slug and an optional `--goal <id>`; priority 5 is backlog and is excluded from
its counts. The native v1 rebuild is a goal on `board-crpko`, not its own
board. The source reads the local Robob API using
`~/.robob/components/t3ctl.json`; never print or copy that token into a
definition. After changing a definition, request the widget again; a changed
source command invalidates its render cache.

## Tests

```sh
node --test integrations/robob-widgets/test/*.test.mjs
python3 -m py_compile integrations/robob-widgets/sources/*.py
```
