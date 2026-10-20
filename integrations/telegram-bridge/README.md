# Telegram OpenChamber Bridge

This directory documents the private Telegram bot bridge used with OpenChamber
for alerts: notifications, reminders, and interactive prompts.
The bridge is intentionally kept as a separate package. It talks to OpenChamber
through the authenticated loopback HTTP/SSE API and does not start a second
OpenChamber or OpenCode backend.

The bridge source and tests are vendored here for reproducible maintenance. Do
not add credentials, SQLite state, sockets, generated dependencies, or local
verification artifacts to this repository. Runtime credentials and state remain
under `~/.config/telegram-bridge/`.

## Relationship to OpenChamber

- OpenChamber owns session state, including the Sessions review board.
- The bridge never creates sessions. Alerts are one-way notifications and
  prompts; there is no Telegram conversation router.
- The bot token lives in `~/.config/telegram-bridge/credentials.env`
  (`TELEGRAM_BOT_TOKEN=...`, mode 600). The numeric owner chat id is configured
  once through the bridge API by sending `/start` to the bot and approving it
  from the bridge; every other sender is ignored.
- The local CLI (`bun run src/cli.ts <command>`) sends notifications, files,
  and reminder mutations to the bridge unix socket. Files are read locally,
  byte-capped at 20 MiB, and never resolved from bridge credentials or state
  paths.
- Deliveries are at-least-once: long messages chunk at 3,900 characters with
  800 ms pacing; sends are checkpointed, retried with capped exponential
  backoff, and a send that may have reached Telegram stays `uncertain` until
  Telegram itself acknowledges it through a later message id collision or the
  operator resolves it.
- Questions and approvals arrive as prompts with inline buttons. Single-choice
  questions answer from one tap; multiple-choice accumulate selections and
  submit atomically; custom text answers use a plain reply to the prompt.
  Forms with several questions are asked one question at a time in the same
  message ("Question 2 of 3"), with progress kept in SQLite so a restart
  resumes where it stopped; every answer is sent together after the last
  question. Multi-select steps toggle options and continue with Done. Requests
  are revalidated
  against the live OpenChamber request before any answer is sent, so changed
  or resolved prompts cancel instead of answering stale state. OpenCode forms
  with fields a chat reply cannot answer (numbers, booleans, external links,
  conditional fields) still alert, without buttons, and are answered in
  OpenChamber.
- Settled sessions are not announced. "Ready for review" notices were retired
  (2026-10-08) as noise; agents send a `notify` alert themselves when they need
  the owner. Any review notice left in the store is cancelled, never sent.
- An iMessage conversation that owns a pending request keeps Telegram silent:
  the bridge asks the spectrum bridge `GET /router` over its unix socket and
  defers while the route matches the request. Unreachable or malformed answers
  never block a Telegram prompt.
- Sessions the iMessage bridge created carry `metadata.openchamber.origin:
  "imessage"`. Their questions and approvals (including those of their subagents, found
  through the parent chain) are never prompted on Telegram, even while the
  iMessage bridge is down.
- Reminders are durable: `remind` stores an explicit-offset ISO timestamp and
  IANA timezone; due reminders are enqueued once, survive restarts, and refuse
  mutation while their delivery is uncertain. `cancel` and `snooze` apply from
  the CLI or chat commands.
- Unsolicited chat messages get a short alerts-only notice; the bot is not a
  conversation endpoint.
- A bridge restart never restarts OpenChamber.

## Robob backend

`src/robob.ts` implements the same `AlertBackend` interface on Robob's control
API. Switch it on with `BRIDGE_BACKEND=robob` or `"backend": "robob"` in
config.json (default `openchamber`). The token comes from
`T3_CONTROL_URL`/`T3_CONTROL_TOKEN`, else the chmod 600 file named by
`T3_CONTROL_TOKEN_FILE` (which must exist), else
`~/.robob/components/telegram-bridge.json` (its own component credential),
else the old shared `~/.robob/ardud-control.json`.

- Events: one `GET /events` stream, resumed with `Last-Event-ID` across
  reconnects, decoded into the same notification events as before
  (`request.opened`/`resolved` to asked/resolved, `thread.status` to busy/idle,
  user `message.completed` to changed, runtime-mode changes to invalidate).
- Requests: `GET /requests`, scoped to a directory by each thread's folder.
  Replies use the respond route.
- Board: read from Robob's session board (`GET /api/ardud/board`, same
  bearer token) only to find directories with running or attention-needing
  threads. It no longer produces review notices.
- iMessage family: every thread reports its root's origin, so subagents of an
  iMessage chat stay quiet without a parent walk.

## OpenCode 2 API

OpenChamber v2 forwards `/api/*` to OpenCode 2 unchanged, so the bridge calls
OpenCode routes on the OpenChamber origin. Location-scoped reads carry the
directory in the percent-encoded `x-opencode-directory` header.

- Pending requests per directory: `GET /api/permission/request` and
  `GET /api/form` (`{ location, data }`). Forms owned by `global` are MCP
  elicitations with no session and are skipped.
- Running sessions: `GET /api/session/active` is global and lists only running
  sessions; absent means idle.
- Replies: `POST /api/session/:id/permission/:requestID/reply` with
  `{ decision: "once" | "reject" }` and
  `POST /api/session/:id/form/:formID/reply` with `{ answer }` keyed by field,
  using option values.
- Events: `/api/event` is the raw OpenCode 2 stream (`{ id, type, created,
  location, data }`), not the translated vocabulary OpenChamber uses
  internally. The bridge wakes on `form.created|replied|cancelled`,
  `permission.asked|replied`, `session.execution.*` and user
  `session.inbox.enqueued`. There are no `question.*`, `session.status` or
  `session.idle` events any more. Execution events carry no location; the
  bridge uses the directory it last saw for that session on a located event,
  and otherwise only rechecks. OpenChamber-owned events (`session-board.updated`,
  `permission-auto-accept.updated`) come from `/api/openchamber/events`.
  `/api/global/event` still works as an alias of `/api/event`.

The operational setup and private credential handling remain in the local
`telegram-notifications` skill. Use `bun run check` and `bun test` from this
directory when changing the bridge.

## Upstream

The main OpenChamber repository remains the `upstream` Git remote. This fork is
owned by `Abdullah1738` so cumulative OpenChamber changes and the companion
bridges can be synchronized without losing local work.
