# Spectrum Photon Bridge

This directory documents the companion private Photon Cloud Pro bridge used with
OpenChamber. The bridge is intentionally kept as a separate package: it talks to
OpenChamber through the authenticated loopback HTTP/SSE API and does not start a
second OpenChamber or OpenCode backend.

The bridge source and tests are vendored here for reproducible maintenance. Do
not add credentials, SQLite state, sockets, generated dependencies, or local
verification artifacts to this repository. Runtime credentials and state remain
under `~/.config/spectrum-bridge/`.

## Relationship to OpenChamber

- OpenChamber owns session state, including the Sessions review board.
- The bridge creates or reuses a Chats session and sends prompts through the
  authenticated loopback API.
- The bridge is conversations only. Notifications, reminders, review notices,
  and interactive alerts live on the telegram bridge; the CLI here is
  `health`, the session-bound sends, `react`, and `wake`. Reminder and alert commands
  are rejected with a pointer to the telegram bridge.
- The conversation model is a private `imessage` key in the OpenCode config
  (`~/.config/opencode/opencode.jsonc`), deliberately separate from
  OpenChamber's desktop default and OpenCode's global `model` default:
  `"imessage": { "model": "provider/model", "variant": "...", "prompt": "..." }`.
  Every prompt carries the model to OpenCode explicitly; a missing or malformed
  key falls back to OpenCode's own default resolution. Every conversational
  turn also opens with built-in iMessage guidance so the agent knows it is
  texting over iMessage: it may use the Photon message features (send-file,
  react) when they serve the conversation, and it must format replies as plain,
  text-like messages without Markdown tables, headers, or code fences. An
  optional `prompt` string (trimmed, at most 2000 characters, no control
  characters beyond newlines) replaces that built-in guidance at prompt time;
  any malformed value falls back to the built-in text.
- Every outbound text (relayed replies, CLI `send`, send-file captions,
  question/approval prompts and notices) and every app-card caption passes
  through one sanitizer in `formatting.ts` at delivery time. It removes leaked
  model-internal blocks (`<think>` and similar) and DCP context-management
  metadata: `<dcp-...>` tags and blocks such as `<dcp-system-reminder>`, lines
  that are exactly `[Compressed conversation section]`, and bare boundary ids
  (`@162@`, `@b7@`, `@blocked@`) that stand alone as a token. Emails,
  `@mentions`, URLs and code spans are left untouched. A message or card left
  empty is cancelled and logged as `outbound-skipped`/`emptyAfterSanitize`
  instead of sending an empty bubble.
- A send the provider fails transiently is retried under the same idempotency
  id, backing off from 10 seconds to every 5 minutes, for up to 24 hours from
  its first attempt. A text reply that fails once is resent without its thread
  target (SMS refuses threaded replies) under its own id, and stays unthreaded.
  When sends keep failing for 10 minutes, one Telegram alert goes out through
  the telegram bridge, and one more when they work again. Images and app cards
  iMessage refuses, or still can't send after 10 minutes, are sent to Telegram
  instead (the card's HTML file when it is published here, otherwise its link)
  and their row moves to state `fallback`. Secure form links never leave
  iMessage.
- Sendblue app cards open in the iMessage app named by `cardApp` in
  config.json (`appName`, `extensionBundleId`, `teamId`, optional
  `appStoreId`), defaulting to Photon's Spectrum app. Photon mode always uses
  Spectrum. Card text loses times, dates and day words such as "today"
  because iMessage turns a card whose text holds one into a plain text bubble;
  put those details in the page.
- Questions (OpenCode forms) and approvals raised in the active chat, or by
  any running subagent below it at any depth, are sent into the conversation.
  This is the only place they are asked: OpenChamber and the telegram bridge
  stay silent for the whole family. The router rechecks the live request before every
  send and before answering, so resolved or changed requests are never
  answered. Forms with fields a text reply cannot answer (numbers, booleans,
  external links, conditional fields) are announced but must be answered in
  OpenChamber. Review notices and alerts for every other session live on the
  telegram bridge.
- The router answers `GET /router` on its unix socket so the telegram bridge
  can defer alerting for requests this conversation owns.
- Every chat session is created with `metadata.openchamber.origin: "imessage"`;
  subagents inherit it. OpenChamber keeps these sessions off the Sessions board
  and out of its review, question and approval notifications, and the telegram
  bridge never prompts for them. Sessions from before the marker existed are
  backfilled in the background, beside the router and never inside its tick:
  the current route, rotated routes (their continuity seed) and every session
  named by a conversation or control outbox row, at most 10 per pass. Each is
  read; one without the origin gets a merge patch through OpenChamber's
  metadata route, the same serialized queue OpenChamber's own goal, assist and
  context writers use, so every other key is kept. A write is read back on the
  next pass (a minute later); once a read shows the marker, or OpenCode answers
  `SessionNotFoundError` for that exact session, it is recorded as
  `origin-marked:<id>` in the kv table and never asked again. A failed pass is
  logged and retried with backoff (30 seconds doubling to 30 minutes); it never
  stops the bridge.
- Incoming batches wait 15 seconds after the latest message. Photon 2.1 exposes
  outgoing typing only, so text still being composed cannot extend the quiet window.
- Incoming attachments are limited to 10 files and 100 MiB total per batch. Every
  file is saved under the chat's `attachments/` folder and passed to the agent by
  absolute path. Only images (PNG, JPEG, GIF, WebP, plus a JPEG preview of HEIC)
  are also attached natively, since a part the model provider rejects leaves the
  whole chat stuck. PDFs, archives and everything else are path-only. An image
  over 3.5 MiB or 2000 px per side gets a JPEG preview from `/usr/bin/sips`, at
  most 2000 px; if that fails or is still too big, it is path-only. Anthropic
  allows 5 MB per image, and 8000 px per side, but only 2000 px once a request
  carries more than 20 images, and earlier turns count. Headers claiming over
  100 megapixels are never decoded. Native previews share a 10 MiB budget per
  batch.
- 100 MiB is about iMessage's own ceiling. Files are buffered whole in memory,
  and the download deadline grows with size: 30 seconds plus one per MiB. Only
  files up to 20 MiB are checkpointed as SQLite blobs, which are never pruned;
  a larger file is downloaded again if its batch is retried, so such a batch
  waits for a busy conversation before downloading. Transient failures
  retry twice before producing a clear failure response. A Live Photo's unused
  companion video does not count against the still image's budget.
- A bridge restart never restarts OpenChamber.
- Mini apps are served on loopback (`appsPort`, default 18791) from `appsRoot`.
  They reach the tailnet on demand: `publish --app SLUG` or `publish --port N`
  runs `tailscale serve` for a free HTTPS port in 18400-18499 (or reuses an
  existing mapping) and prints the URL; `unpublish --port N` removes one. Only
  ports in that range are ever created or removed.
- Public links for people off the tailnet: `share --app SLUG [--days N]`
  (default 7, max 30) serves only that app's folder from its own loopback
  server through a Cloudflare quick tunnel (`cloudflared`, no account) and
  prints the `trycloudflare.com` URL. The bridge owns the tunnels: at most 10
  live, stopped at expiry, killed with the bridge, and re-created with a new
  URL when the bridge starts again (`share-restarted` log). `unshare --app SLUG`
  ends one; `shares` lists them. `share` and `publish --app` return
  `metadataWarnings` for a missing `<title>`, `og:title`, `og:description` or
  `og:image`, and served pages get relative `og:image`/`og:url` made absolute
  so link previews load.
- In Sendblue mode, `app --to moni --session OWNER_SESSION --key KEY --url PUBLIC_HTTPS_URL --caption "Your ride"`
  queues a card in that chat, like `send --to`. Cross-chat sends require the
  current owner's session, including when the recipient is an admin. Omit
  `--to` to send to the session's own chat. Use a publicly reachable URL for
  Moni and other recipients (`share`, rather than the owner's tailnet-only
  `publish` URL). Reuse the key only for an identical card to the same recipient;
  the acknowledgement confirms queueing, not delivery.
- Secure forms: `secret-request --session S --key K --purpose P --field name:Label[:type]`
  sends a one-time app card (15 minutes) for credentials. Submitted values are
  stored in `~/.config/spectrum-bridge/secrets/` (0600, never in the chat,
  the database, or the apps root) and the agent is told which fields were
  filled. `secret --token T --field NAME` prints one raw value;
  `secret --token T --forget` deletes them, and they expire 30 minutes after
  submission.
- Watcher wakes: `wake --text T --source S --key K` (`POST /wake`) queues
  `T` as a synthetic inbound row `wake:<sha256(K)>`, framed as
  `[Watcher event from S, not typed by the owner. ...]`, so the agent handles
  it as a new turn in whichever session is live. It is not session-bound, so it
  follows rotation and `/new` (a pending wake carries over into the fresh chat).
  The same key with different content is rejected. Like secure-form notices,
  wakes are never taken as answers to pending questions or approvals, never
  batched with owner texts, never used as quoted-reply or reaction targets, and
  a turn that ends without text (or with `NO_REPLY`) simply closes. The
  robob-watch runner (`~/.local/share/robob-watch`) is the intended caller.
- Synthetic rows (wakes and secure-form notices) never get an owner-facing
  "mind sending it again?" notice: nobody typed them. A turn for one that is
  never accepted, or is interrupted before it starts, goes back to `pending`
  with a backoff (30 s, then 60 s; the state is in kv `synthetic-retry:<id>`).
  A turn that was accepted and then failed while running is not retried, since
  its work may be partly done. The owner gets one notice naming the watcher. Owner texts queued behind it are not held up. Before
  any retry POSTs, every earlier prompt for the row is checked with
  `promptAccepted`. If one landed late, it is adopted instead of being sent
  again. If the check itself fails, the retry waits. After 3 attempts the row
  is marked `failed`, the owner gets one notice naming the watcher or form
  (`synthetic-dropped:<hash>`), and the text rides along as quoted data in the
  next submitted turn's system context (kv `missedSynthetic`) until a prompt
  carrying it is accepted. A row going back to `pending` does not re-arm
  robob-watch's heads-up: the runner stops tracking a wake once it sees any
  state other than `pending`.
- Owner texts whose prompt OpenCode never confirms (for example while it is
  briefly unresponsive) are sent again before the owner is asked to resend:
  3 attempts, re-sent after 1 and then 2 more minutes, with the "didn't catch
  that" notice 2 minutes after the third (`OWNER_RESEND_MS`). Each attempt has
  its own record id, and before every POST all earlier attempts are checked
  with `promptAccepted`; one that landed late becomes the turn's prompt instead
  of being duplicated. A failed read is never treated as absence: nothing is
  re-sent until a read confirms none landed. A text still unconfirmed 10
  minutes after it was first sent is given up on instead of being delivered
  late (`OWNER_GIVE_UP_MS`). The exact prompt (text, guidance, files, model)
  is kept in kv `resendBody` only while delivery is uncertain. Logged as
  `owner-text-resent`, `owner-text-adopted` and `owner-text-undelivered`.
- `batched` is a terminal inbound state: a non-leader member of a batch whose
  text travelled inside the leader's prompt. The batch outcome is on the
  leader row; the aggregate is kept in kv `batch:<leaderId>`.

## Scoped third parties (Sendblue mode, 2026-10-21)

Owner rule: someone the owner told to text the line may be answered, but only
for that one purpose, and the owner's own words are the only approval.

- An unknown 1:1 sender is never answered by an agent. `guest-desk.ts` holds
  the message (owner store `guest-held:<address>`) and wakes the owner's chat
  once per sender per 6 hours, at most 6 such wakes an hour (beyond that a
  Telegram note). The wake quotes their text as data, says whether they are in
  Contacts (`guest-evidence.ts` reads the AddressBook read-only) and lists
  evidence: the owner's own outgoing messages (`from_me = 1`) in that person's
  1:1 iMessage/WhatsApp chat or email to them, last 30 days, that name the line
  number or "Robob" (message-archive `index.db`, read-only). Groups keep the
  old Telegram note.
- `guest-allow` (owner chat session only, never a bare shell or another chat)
  stores a grant in `~/.config/spectrum-bridge/guests.json`: purpose, actions
  (`meeting`, `create-hold`), expiry (default 7 d, max 30 d) and the evidence.
  The bridge checks the evidence itself: `msgs:<id>` must be the owner's
  outgoing message to that exact address that names the line, or
  `owner:<inbound id>` must be something he typed in his chat. `create-hold`
  also needs calendar wording in his message. A new grant replaces the old one;
  scope never merges. Held messages are released to the responder, and the
  owner gets a plain notice of the scope.
- Granted senders are answered by `guest-responder.ts`, not by an agent: one
  OpenRouter call (`guestModel`, default `anthropic/claude-sonnet-5.5`) with no
  tools. The bridge works out free windows from `applecal` (start/end only,
  all-day entries ignored, 10:00-18:00 Mon-Fri, 15 min buffers, 14 days) and
  puts only those in the prompt. Nothing else about the owner is in it. The
  model returns JSON (`reply`, `action`, `slot`, `ownerNote`); code checks it:
  replies with links, emails or phone numbers are replaced and escalated, a
  `book` slot must fit a free window (max 2 h). Without `create-hold` a booking
  wakes the owner to confirm; with it the bridge writes a tentative hold and
  tells him. `escalate`/`decline` wake the owner. Each inbound gets at most one
  reply (marked before sending), 25 replies a day per guest, and Robob's
  name and photo are shared after the first reply.
- `guest-send` relays the owner's decision to someone who has texted the line;
  `guest-revoke`, `guests` and `share-contact --chat|--address` (Name & Photo
  Sharing) are owner-only. Every step goes to `guests-audit.jsonl` (0600, no
  message bodies).

## Robob backend

The bridge can run on Robob's control API (`/api/ardud/control/*`) instead of
OpenChamber. `src/robob.ts` implements the same `ChatBackend` interface the
router uses, so the router is unchanged.

- Switch: `BRIDGE_BACKEND=robob` in the environment, or `"backend": "robob"`
  in `~/.config/spectrum-bridge/config.json`. The default is `openchamber`; any
  other value stops the bridge at startup.
- Server and token: `T3_CONTROL_URL` + `T3_CONTROL_TOKEN`, else the JSON file
  `T3_CONTROL_TOKEN_FILE` or `~/.robob/ardud-control.json`
  (`{"url":"http://127.0.0.1:<port>","token":"..."}`, chmod 600, loopback URL only).
  Issue the token with `t3 auth session issue --base-dir <t3 home> --label bridges --ttl 365d --json`.
- Chat root: `ROBOB_IMESSAGE_CHAT_ROOT`, else `robobChatRoot` in config.json,
  else `~/.robob/imessage`. It must be a registered Robob project
  (`t3 project add <root> --title iMessage`); `check` fails otherwise. Each new
  chat is a thread in `<root>/<YYYY-MM-DD>/session-<uuid>`, which Robob
  creates, with origin `imessage` and runtime mode `full-access`.
- Model: the `imessage` preference from the OpenCode config, sent as
  `provider/model` plus `variant` on create and on every send.
- Channel guidance: the control API has no system record, so the guidance is
  prepended to the message between two marker lines and stripped again when
  the bridge reads messages back.
- Ids: new routes store Robob thread ids. Stored `ses_` ids resolve through
  `GET /threads/by-native/:ses`. A stored route the mapping does not know (404)
  is dropped while idle, so the next text starts a fresh chat.
- Context reset: Robob threads keep one thread across `/new` and rotation.
  The bridge doesn't reset anything itself; it queues a `reset:` row asking
  the agent to call `t3_context_reset` (`NEW_CHAT_NUDGE` / `ROTATE_NUDGE` in
  `src/router.ts`), so the server's own rules (background work, one reset at a
  time) decide. `/new` stops the running turn, drops queued texts, bumps the
  generation and acknowledges right away; the nudge carries no recap. Rotation
  waits until the context is due (4 hours or 256k tokens) and the chat has
  been quiet for 10 minutes; the agent writes its own resume note. Both nudges
  end in `NO_REPLY`, so only a refusal reason reaches the owner, and a nudge
  that fails is dropped quietly. A new thread is still used for `ses_` routes,
  threads 8 hours old (`threadAt`, so one thread never grows forever), a `/new`
  that can't stop the old turn, and a second `/new` while the first nudge is
  unfinished. That new thread's recap starts after the latest reset prompt.
  `CURRENT_SESSION_ID` is `<thread id>@<generation>`; the session-bound CLI
  commands take that or the bare thread id.
- Auto-accept: a thread counts as auto-accepting when its `runtimeMode` is
  `full-access`. Approvals and questions are read from the thread detail and
  answered with `POST /threads/:id/requests/:rid/respond`.
- Origin backfill marks owned threads with `PUT /threads/:id/origin`, under
  its own `robob-origin-marked:` keys.

## OpenCode 2 API

OpenChamber v2 forwards `/api/*` to OpenCode 2 unchanged (OpenCode 2 serves
its own routes under `/api`), so the bridge calls OpenCode routes on the
OpenChamber origin with the desktop client token. The chat directory travels
in the `x-opencode-directory` header, percent-encoded; answers come wrapped in
`{ data }` envelopes. What the router relies on:

- New chats: `POST /api/session` with `location.directory` and
  `metadata: { openchamber: { origin: "imessage" } }` in the body.
- Origin backfill: `GET /api/session/:id`, then OpenChamber's own
  `POST /api/openchamber/sessions/:id/metadata` with
  `{ patch: { openchamber: { origin: "imessage" } }, directory }`. It answers
  `{ metadata }`, the full merged object, which must name the origin.
- A turn: `POST /api/session/:id/model` when a preferred model is configured
  (the model is a session property now), `POST /api/session/:id/synthetic`
  with `resume: false` for the iMessage guidance, then
  `POST /api/session/:id/prompt` with the bridge's own message id, the text,
  and image attachments as data URI files. The prompt is admitted to the session
  inbox and returns at once.
- Acceptance after a lost response: `GET /api/session/:id/message/:messageID`
  (promoted) or `GET /api/session/:id/inbox` (still queued). Neither ever
  resends the prompt; only a confirmed absence of every attempt does (owner
  text only, see above).
- Completion: session records are flat and have no parent link, so a turn is
  every record after its prompt up to the `idle` record OpenCode appends when
  execution settles. Only a succeeded turn whose last assistant step finished
  with visible text is forwarded. A final text that is exactly `NO_REPLY`, or
  has it alone on its last line, is a deliberate silent turn: nothing is sent,
  and the inbound row and watermark advance as for an empty turn. A failed or
  interrupted turn is reported as a response error. `GET /api/session/active` must also no longer list the
  session.
- Requests: `GET /api/session/:id/permission` and `/form`; replies go to
  `POST /api/session/:id/permission/:requestID/reply` with `{ decision }` and
  `POST /api/session/:id/form/:formID/reply` with an answer keyed by field.
- Stopping a turn: `POST /api/session/:id/interrupt`.

The operational setup and private credential handling remain in the local
`imessage-notifications` skill. Use `bun run check` and `bun test` from this
directory when changing the bridge.

## Upstream

The main OpenChamber repository remains the `upstream` Git remote. This fork is
owned by `Abdullah1738` so cumulative OpenChamber changes and the companion
bridge can be synchronized without losing local work.
