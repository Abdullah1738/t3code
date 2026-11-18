# robob-watch

Durable watcher runner for Robob. Watchers run a check command on an interval (default every 15s, minimum 5s) or within about a second of a trigger file changing.

Wake events go to the creating Robob thread (`created_by_session`) in queue mode. Watchers created in iMessage follow the live chat through rotation and `/new`; an explicit `chat` still wakes only that chat. Missing or archived creators fall back to the owner route. Slow status checks retry once with a longer timeout, then try the known thread anyway. Native lookup timeouts retry once and remain pending if the thread cannot yet be identified.

A queued wake remains `confirmed=pending` until the thread reports a new run, or the owner-chat router consumes its inbound row. A send timeout also stays pending: it may have queued on the server. After ten minutes without confirmation, the runner alerts once and tries the owner fallback with the same event key. `robob-watch show ID` includes `last_delivery` and pending confirmations. Owner fallbacks use spectrum-bridge `wake`, then bridge `send`, then Telegram `notify`. Explicit chat watchers and opt-in 120s heads-ups keep their existing behavior.

Failed checks back off, with a failure notice from the 2nd failure in a row (`failure_notice_after`), pause and alert after 5 (`max_consecutive_failures`). Set `failure_notice_after` to 1 to notify on every failure, or `max_consecutive_failures` to 0 to keep retrying without pausing. Timed-out checks need 10 minutes of failures before either notice or pause; host-load timeout grace still applies. Wake watchers escalate at pause or after 15 minutes of failures. A successful check resets the streak.

Layout (runtime lives at `~/.local/share/robob-watch`; this directory is the canonical source):
- `src/runner.ts` runner loop (1s tick), `src/cli.ts` CLI (add/list/show/remove/pause/resume/test/fire-test/relay-ok/relays-off), `src/lib.ts` shared logic
- `helpers/` check helpers: whatsapp-new-message, output-changed, email-new-message, wa-lock; plus `ride-card` and `card-check` (compact-bubble acceptance checks for ride, delivery and quick cards, linked as `~/.local/bin/card-check`; `card-check reply` lints a chat reply for structured data that has to go as a card)
- `helpers/wa`, `helpers/mailsend`: the agent send paths for WhatsApp and email (symlinked as `~/.local/bin/wa` and `~/.local/bin/mailsend`). They send without waiting for Abdullah's OK (27 Oct 2026: tools suggest, they don't block). A draft prints its preview: where his OK makes sense, the agent shows it to him, then sends with `send --approved <id>`. Still refused: a draft sent twice, a draft older than 24h, a file or stored email changed since its draft, mailsend's Bcc. `helpers/send-approval` is no longer called by either helper (its `check` has no callers; `visible` still runs at draft time to keep text the chat would hide out of previews). Tests: `test/wa-gate.test.ts`, `test/test_send_approval.py`, `test/test_mailsend.py`
- `test/` Bun and Python tests (see Tests below)
- `scripts/com.ardud.robob-watch.plist` LaunchAgent, `scripts/robob-watch` CLI wrapper for `~/.local/bin`
- `skill/SKILL.md` the `robob-watchers` agent skill (installed at `~/.config/opencode/skills/robob-watchers`)

Runtime state (`watchers/`, `archive/`, `runner.log`, `runner.pid`, `wa.lock`) is not tracked.

Versioned check packages live under `checks/`. The [inbox triage installer](checks/inbox-triage/README.md) deploys its five-minute check and definition separately, preserving the live watcher's cursors and private preferences. The [money cases installer](checks/money-cases/README.md) does the same for the open-money-case deadline check and its `money-cases` CLI.

Robob projection reads use the server-owned `~/.robob/userdata/readonly/state.sqlite`
snapshot, with `ROBOB_READONLY_DB` or the component override (`MONEY_CASES_STATE_DB`,
`SEND_APPROVAL_STATE_DB`). Live-writer paths, symlink and hardlink aliases are
refused before connecting. Missing/not-ready snapshots and exports older than
120 seconds fail closed; key/value metadata must include `ready='1'` and
`schema_version='1'`. Each request opens a read transaction before checking
metadata, so projection rows cannot come from a partial generation. There is no
live-database fallback.
Protected writers include both `state.sqlite` and `statev2.sqlite` under
`~/.robob`, `~/.t3`, and configured `ROBOB_HOME`/`T3CODE_HOME`, plus native
OpenCode's default/XDG path. Watcher check children inherit those configured
homes so explicit overrides cannot bypass the same protections.
`send-approval --app` uses current control-API messages by default so a later veto is not hidden by
replication lag; explicit snapshot overrides select offline inspection instead.
Approval against an explicit snapshot still revalidates current owner messages
through the control API before succeeding.

Install/sync: copy `src test helpers package.json tsconfig.json` to `~/.local/share/robob-watch`, the wrapper to `~/.local/bin/robob-watch`, the plist to `~/Library/LaunchAgents/`, the skill to `~/.config/opencode/skills/robob-watchers/`, then `launchctl kickstart -k gui/$(id -u)/com.ardud.robob-watch`.

Log analysis: `robob-watch log-rollup --day YYYY-MM-DD` keeps the daily report.
The runner writes yesterday’s report after 00:30 UTC so late-day markers have their full comparison window. Reports written before the UTC day ended are redone; reports written at or after day end are kept.
For a release window use `robob-watch log-rollup --since 2026-11-13T18:24:00Z --until 2026-11-14T00:00:00Z [--out /path/window.json]`.
Windows include the start and exclude the end, require a timezone, and print JSON without writing a daily report.
Reports include hourly error sources, run failures/timeouts and p95 durations. Each release marker compares error events in the 30 minutes before and after it; a comparison has `complete: false` until its end time has passed; missing log periods contribute zero, so use complete logs for release readback.
For manual release/restart scripts, call `robob-watch log-marker --service robob-watch --sha <git-sha> --step restart.complete || true` after success. Service/step are short identifiers; SHA is hex. Markers retain no IDs or free text and failures never interrupt the script.

## Tests

`ride-card send` relays public link text through `agent-ask` for chats configured with
`chatBackends.<slug>.kind = remote-box`, with a fallback for the bridge's explicit remote-chat
403 refusal. The journal records `relayed` after bus acceptance, not final delivery. The same
trip/recipient key is used by the bus and the recipient's send; unresolved direct attempts
block a transport switch. `--dry-run` reports the route without sending or publishing.
`bridge.error` and `relay` tool events retain command/error classifications and hashed
recipient, key and acknowledgement identifiers. Abdullah's card still uses `app`.

Run from `integrations/robob-watch`. Bun: `bun test test/`. Python uses unittest; pytest is not installed on the Mac.

```sh
ROBOB_TEST=1 python3 -I -m unittest discover -s <dir> -t <top> -p '<file or test_*.py>'
```

Examples: one top-level file, meds-nag, and a check directory:

```sh
ROBOB_TEST=1 python3 -I -m unittest discover -s test -t . -p 'test_send_guard.py'
ROBOB_TEST=1 python3 -I -m unittest discover -s test/meds-nag -p 'test_*.py'
ROBOB_TEST=1 python3 -I -m unittest discover -s checks/money-cases -p 'test_install.py'
```

For all top-level Python suites, use `-p 'test_*.py'` in the first example; it does not recurse into `meds-nag/` or `morning-brief/`. The same commands work with `/usr/bin/python3`.

Discovery inserts its top directory into `sys.path` under `-I`; `-t .` lets top-level suites use this repo's `test` package instead of the stdlib package. For meds-nag and check directories, the top defaults to the start directory so sibling imports work.

Always set `ROBOB_TEST=1` for the send guards: `conftest.py` sets it only under pytest, and unittest does not load that file.
