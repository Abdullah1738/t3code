# scribe

Reads mission lane transcripts and writes notes about them, so lanes don't have
to decide what is worth writing down. The scribe is a clerk: it records
decisions, assumptions, deviations, risks, blockers, claims of done and open
questions, each with a verbatim quote and the event range it came from. It
never blames, never marks work done and never tells a lane what to do.

The model writes notes; the Robob server checks them. Every quote must appear
verbatim in the cited events (`citation: verified|failed`), and claims of done
are compared with PR state and observed tool output (`evidence:
matched|mismatch|missing`). That code lives in
`apps/server/src/ardud/missions/scribe/`.

## How it works

- Source: Robob's own thread events (`orchestration_v2_projection_turn_items`
  in `~/.robob/userdata/statev2.sqlite`, opened read-only). The turn item
  ordinal is the event number notes cite.
- Cursor: the server keeps one cursor per mission lane. A pass reads settled
  events after it, cuts them into slices (about 24k characters), and posts one
  batch per slice. The server stores the notes and moves the cursor in the same
  transaction, so a retried batch is a no-op.
- Model: Claude Haiku 5.5 through 9router (`cc/claude-haiku-5-5` on
  `127.0.0.1:20128`), the same route recall uses. The editor pass uses
  `cc/claude-opus-5-5`. Bulky tool output is cut to its head and tail before it
  reaches the model; anything that looks like a credential is redacted.
- The model sees events numbered `e1..eN` per slice and the runner maps them
  back to real ordinals, because models shorten long numbers.

## Commands

```bash
node cli.mjs run [--mission ID] [--slices 10]       # every mission lane, via the server
node cli.mjs dry-run --thread THREAD_ID [--from EVENT | --since ISO] [--slices 3] [--out DIR]
node cli.mjs editor --mission ID [--out FILE]      # one Opus editor pass, by hand
node cli.mjs report --mission ID --kind update|daily [--since ISO] [--to ISO] [--save] [--live] [--out FILE]
node cli.mjs watch --mission ID [--sweep-minutes 15]  # a pass whenever a lane's run settles
```

`run`, `dry-run` and `watch` take `--min-severity low|medium|high|critical`:
notes under it are not posted, except updates that replace an open note shown
in the prompt (so a blocker can still be closed), and the model is told the
floor. Without it
every note is kept.

`dry-run` never touches the server: cursors and notes go to `DIR/state.json`,
batches to `DIR/batches.jsonl` and raw model replies to `DIR/replies.jsonl`.
The default output directory is `$TMPDIR/opencode/missions-scribe/`.

`report` asks the server to build the 4h update or the daily summary from
mission data (records, verified notes, events; no model call). `--save` keeps
it so the next report of that kind starts where it ended and closes out what it
left open. `--kind update` exports in the `OWNER-UPDATES.md` format: the new
section goes below the `UPDATES-INSERT-BELOW` marker of the target file
(created when missing), the story block is left alone, and a section already in
the file is not written twice. The default target is scratch. The live Crpko
status files take `--live`, which only the report jobs pass.

Environment: `SCRIBE_DB`, `SCRIBE_ROUTER_URL`, `SCRIBE_MODEL`,
`SCRIBE_EDITOR_MODEL`, `SCRIBE_OUT`, `SCRIBE_CONTROL_FILE` (defaults to
`~/.robob/ardud-control.json`), `T3_CONTROL_URL`, `T3_CONTROL_TOKEN`.

`watch` follows the control API's run events and runs one `run` pass when a
lane's run settles, plus a sweep every 15 minutes for lanes running long. Passes
never overlap; settles during a pass fold into one more pass. It reconnects on
its own and resumes from the last event it saw.

Nothing here starts itself. At cutover four LaunchAgents run it: `watch`, the
editor hourly, the 4h update and the daily summary. Their definitions live in
the Robob checkout at `tmp/memory/cutover/scribe-schedules.json`. Deploy with
`integrations/deploy.zsh scribe`.

## Tests

```bash
node --test test/*.test.mjs
```
