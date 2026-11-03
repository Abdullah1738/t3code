# Message archive (msgs)

A local, searchable copy of Abdullah's email (icloud, gmail, fund, outlook,
juno), iMessage/SMS and WhatsApp. One query covers every source, answers in
well under a second and works offline. The archive only adds: a message
deleted at the source stays searchable. `is:deleted` finds only the deletions
and unsends the source still records (iMessage retractions, WhatsApp revokes),
not messages that simply vanished from chat.db or wacli.db.

This directory holds only the code. The data lives on the external SSD.

## Layout

- `src/msgs.py` - the CLI and the daemon (`msgs --help`). Each source has its
  own flock in `locks/`, so a manual `msgs sync` of a source the daemon is
  working on prints `busy` and exits.
- `src/search.py` - Gmail-like query parsing and ranked search (`msgs help-query`).
  `--since`, `after:` or `newer_than:` prunes full-text search by row ID for watchers; out-of-order inserts or updates can still leave a broad scan.
- `src/store.py` - `index.db` schema: one `items` row per message, an
  external-content FTS5 index and `sync_state` (cursor and `last_ok` per
  source). Writes go through a FIFO lock because SQLite's busy wait starves
  threads.
- `src/gmail_sync.py` - gmail, fund and juno through the Gmail REST API
  (`history.list` for changes, no IMAP download cap). Tokens come from ortie
  via `~/.local/libexec/mail/mail_oauth.py` and are never printed.
- `src/imap_sync.py` - icloud and outlook by IMAP UID, folder by folder.
- `src/mailparse.py` - raw RFC822 to index fields; raw bytes kept as `.eml.zst`.
- `src/imessage_sync.py` - reads `~/Library/Messages/chat.db` read-only and
  decodes `attributedBody`, where most message text lives.
- `src/whatsapp_sync.py` - copies rows from the wacli store (`~/.wacli/wacli.db`,
  read-only).
- `src/common.py` - paths, the external volume guard, logging.
- `scripts/msgs` - CLI wrapper, linked from `~/.local/bin/msgs`.
- `scripts/com.ardud.message-archive.plist` - LaunchAgent reference copy.

## Data

```
/Volumes/ExternalSSD/message-archive/   (mode 700)
  index.db                       SQLite (WAL) + FTS5
  mail/<account>/YYYY/MM/*.eml.zst
  locks/
```

Nothing is written while the SSD is unmounted; the daemon waits for it.
`MSGS_VOLUME`, `MSGS_ROOT`, `MSGS_CHAT_DB`, `MSGS_WACLI_DB` and
`MSGS_ADDRESSBOOK` override the paths (tests use them).

## Daemon

LaunchAgent `com.ardud.message-archive` runs `msgs daemon`: chats every 30 s,
mail every 3 min, a full chat pass every 6 h and a full relist of the Gmail API
accounts daily.
A failing source logs `<source>: ERROR ...` and backs off up to 1 h, then
retries. Log: `~/.local/share/message-archive/logs/daemon.log`.

The memory-system health check (`msgs` in `health_check.py`, every 15 min)
sends a Telegram alert when the archive's last good iMessage pass hasn't
changed for an hour of awake time since the check first saw it. Sleep doesn't
count, so a wake gets time to catch up; a reboot keeps the time already
counted. Once reported, the alert holds until a new pass lands.

## Full Disk Access

Reading chat.db needs Full Disk Access, and macOS grants it to the resolved
binary, not the Homebrew symlink:
`/opt/homebrew/Cellar/python@3.14/<version>/Frameworks/Python.framework/Versions/3.14/bin/python3.14`.
A `brew upgrade python@3.14` changes that path. iMessage then fails to open
chat.db until Full Disk Access is granted again to the new binary in System
Settings (Abdullah does that), followed by
`launchctl kickstart -k gui/$(id -u)/com.ardud.message-archive`.

## Tests and deploy

Tests: `/opt/homebrew/opt/python@3.14/bin/python3.14 tests/test_archive.py`
(temporary paths, no real data).

Deploy: `integrations/deploy.zsh message-archive`, then
`launchctl kickstart -k gui/$(id -u)/com.ardud.message-archive`.
