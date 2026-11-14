# External status template

For waits such as Apple's re-sign status, register a durable watcher instead of
re-running the same lookup in a conversation. Deploying the package does not
register this template as a watcher.

After installation is approved:

1. Copy `read-status.sh` into the new watcher's directory. Replace its placeholder
   with the task's existing **read-only** lookup, bounded to 30 seconds. Print only
   a stable status for the exact item; omit timestamps, elapsed time, cookies and
   other credentials. Exit nonzero on lookup, authentication or parsing failure.
2. Copy `watcher.template.json` to a private file. Set a unique `id`, `title`,
   `created_by_session`, a useful expiry, and context naming the exact item/source,
   the current status and what to do next. Use that id for the directory too.
   Keep `mode: wake` and `relays: []`. Leave `max_fires: 1` to stop on the first
   change; a follow-up can register another watcher if further changes matter.
3. Make `read-status.sh` executable, then run
   `robob-watch add --json /absolute/path/to/filled-watcher.json`. The prime run
   must succeed silently: it records the current status as the baseline. The
   shipped placeholder fails deliberately until the lookup is configured.
4. Run `robob-watch test <id>` and read `robob-watch show <id>` to verify the check,
   expiry and destination. A failed lookup leaves the last good baseline intact
   and follows the runner's normal failure/backoff handling.

The existing `output-changed` helper compares successful outputs and fires once
the status differs from its baseline. A status already changed before registration
is the baseline; handle it immediately rather than waiting for another change.
For email replies use `email-new-message` instead. Nothing here performs a re-sign,
opens a login flow or starts an external action.
