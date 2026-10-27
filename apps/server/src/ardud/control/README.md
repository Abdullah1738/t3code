# ardud control API

A small local HTTP API on the t3 server for the things that used to talk to
OpenChamber: the iMessage bridge (spectrum-bridge), the Telegram bridge, crw,
and shell scripts or skills. It wraps the same services the web app and the T3
MCP tools use (thread launch, thread management, runtime request responses,
the orchestration event log). It adds no orchestration logic of its own.

- Server code: `http.ts` (routes), `model.ts` (pure mapping), `ControlStore.ts`
  (fork tables `ardud_thread_origin` and `ardud_opencode_import`).
- Client: `client.mjs` (ESM, no dependencies, Node 18+). CLI: `t3ctl.mjs`.
- Wiring: one line in `apps/server/src/server.ts` (`controlRouteLayer`).

## Auth

Same EnvironmentAuth as `/api/orchestration/*`. Send `Authorization: Bearer <token>`.
Read routes need `orchestration:read`; mutating routes need `orchestration:operate`.

Issue a token on the machine running the server. The token is shown once, and
`--json` is the reliable output mode:

```sh
t3 auth session issue --base-dir <t3 home> --label "bridges" --ttl 365d --json
# dev worktree: node apps/server/src/bin.ts auth session issue --base-dir <home> ...
```

This issues a bearer session with the administrative scopes (the CLI has no
narrower option). `t3 auth session list` / `revoke` manage it. Default TTL is 30 days.

Clients find the server and token in this order: explicit options, then
`T3_CONTROL_URL` and `T3_CONTROL_TOKEN`, then the file named by
`T3_CONTROL_TOKEN_FILE` (it must exist), else the first that exists of the
tool's own component credential (`~/.robob/components/<name>.json`, e.g.
`t3ctl` for t3ctl) and the old shared
`~/.robob/ardud-control.json`. Each holds
`{"url":"http://127.0.0.1:<port>","token":"..."}` and must be chmod 600, or
the client refuses it. `t3 ardud component-token issue <name>` issues the
token for a component file; `t3ctl login --url URL --token TOKEN` writes
t3ctl's.

## Conventions

- JSON in and out. Success is `{ "ok": true, ... }`. Failure is
  `{ "ok": false, "error": { "code", "message" } }` with HTTP 400 `invalid_request`,
  401 `unauthorized`, 403 `forbidden`, 404 `not_found`, 409 `conflict` (the
  orchestrator rejected the command; the message says why), 503 `unavailable`,
  or 500 `internal`.
- Ids are opaque strings and can contain `:` and `%`. Always `encodeURIComponent`
  them in paths (the client does).
- `clientRequestId` (optional on every mutation) makes retries safe: the same
  id replays the first result instead of acting twice.
- Models are OpenCode slugs, `provider/model` (for example `opus/claude-opus-5-5`),
  with the reasoning level as `variant` (`low`, `medium`, `high`, `xhigh`, ...).
  They map to `modelSelection { instanceId: "opencode", model, options: [{ id: "variant", value }] }`.
- Thread `state` is the field to act on:
  - `running`: a turn is starting or running.
  - `needs-input`: blocked on an approval or a question (see `pendingRequests`).
  - `waiting`: the agent's reply is done, but background work (subagents,
    background shells) is still draining and may wake it again. Treat the reply as
    delivered.
  - `queued`: queued messages only.
  - `idle`: nothing in flight.

  `status` is the raw t3 run status (`preparing`, `queued`, `starting`, `running`,
  `waiting`, `completed`, `failed`, `cancelled`, `interrupted`, `rolled_back`, `idle`).

- `origin` is a free string (`imessage`, `telegram`, `crw`, `watcher`, `automation`,
  ...). It lives in `ardud_thread_origin`. Subagent and fork children inherit the
  root's origin in every response and event.

## Endpoints

All paths are under `/api/ardud/control`.

| Method | Path                                       | What it does                                                                                |
| ------ | ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| GET    | `/health`                                  | Token check plus the latest event sequence.                                                 |
| GET    | `/projects`                                | Registered projects (`projectId`, `title`, `workspaceRoot`, `scratch`).                     |
| GET    | `/models`                                  | Default model and runtime mode, plus each provider's models and variants.                   |
| GET    | `/threads`                                 | List threads (see filters below).                                                           |
| POST   | `/threads`                                 | Create a thread, optionally with a first prompt.                                            |
| GET    | `/threads/by-native/:sesId`                | Thread for an OpenCode session id (`ses_...`).                                              |
| GET    | `/threads/:id`                             | Detail: state, current run, recent runs, pending requests.                                  |
| PATCH  | `/threads/:id`                             | Change `runtimeMode`, `interactionMode`, `model`/`variant`, `title`, `archived`, `settled`. |
| POST   | `/threads/:id/archive-if-idle`             | Archive only if the thread is still idle; otherwise refuse and leave it alone.              |
| GET    | `/threads/:id/messages`                    | Messages plus `lastAssistant`.                                                              |
| GET    | `/threads/:id/wait`                        | Long-poll until not running (or needs input).                                               |
| POST   | `/threads/:id/send`                        | Send a message.                                                                             |
| POST   | `/threads/:id/interrupt`                   | Stop the active turn.                                                                       |
| POST   | `/threads/:id/requests/:requestId/respond` | Answer an approval or a question.                                                           |
| PUT    | `/threads/:id/origin`                      | Set or clear the origin.                                                                    |
| GET    | `/requests`                                | Every pending approval and question across active threads.                                  |
| POST   | `/attachments`                             | Get a signed upload URL for a file to attach.                                               |
| GET    | `/events`                                  | Server-sent events (SSE).                                                                   |

### GET /threads

Query: `origin` (a value, or `none` for threads without one), `active=true|false`
(not idle / idle), `state=running,needs-input,...`, `updatedSince` (ISO time or
epoch ms), `projectId`, `parentThreadId`, `ids=a,b`, `includeSubagents=true`,
`archived=true` (the archive instead of active threads), `limit` (default 50,
max 500). Newest first. Each item is a thread summary: `threadId`, `projectId`,
`title`, `state`, `status`, `origin`, `nativeSessionId`, `model`, `runtimeMode`,
`interactionMode`, `parentThreadId`, `rootThreadId`, `worktreePath`,
`pendingRequest`, `latestMessage`, `lastError`, `archived`, `settled`,
`createdAt`, `updatedAt`.

### POST /threads

```json
{
  "prompt": "reply PONG",
  "title": "optional; generated from the prompt when omitted",
  "directory": "/abs/path",
  "model": "opus/claude-opus-5-5",
  "variant": "high",
  "runtimeMode": "full-access",
  "interactionMode": "default",
  "origin": "imessage",
  "attachments": [
    { "attachmentId": "...", "name": "a.png", "mimeType": "image/png", "sizeBytes": 123 }
  ],
  "clientRequestId": "optional"
}
```

Where it runs (pick at most one):

- `projectId`: that project's root.
- `directory`: a registered project root runs there. A folder inside a
  registered project runs in that folder, which is created if missing. That
  makes per-chat folders under one registered "Chats" root work like
  OpenChamber's `chatsRoot/<date>/session-<uuid>`. Any other folder is registered
  as a new project.
- Neither: the Scratch project ("No project"), which gives every thread a fresh
  folder of its own under `<t3 home>/scratch/`.
- `worktree: { baseRef, branch?, startFromOrigin? }` puts it in a new git worktree.

Defaults: the project's or environment's default model and runtime mode.
Response (201): `threadId`, `projectId`, `directory`, `messageId`, `runId`,
`status`, `model`, `runtimeMode`, `resumed` (true and HTTP 200 when
`clientRequestId` replayed an earlier create).

### POST /threads/:id/archive-if-idle

`{ "expectedSession"?: "ses_..." }`. The server decides inside the archive's
commit transaction, so nothing can land in between (a plain
`PATCH { archived: true }` cancels whatever is queued). Idle means no live or
queued run, no pending approval or question, no running subagent, background
task, runless provider turn or work its live provider session still holds, no
pending wake (restart continuation, provider continuation not yet started, owed
delegated task report, armed usage-limit auto resume, watched pull request, or a
snooze not yet due) and, with `expectedSession`, the thread's latest run ran on
that native session on its active provider thread. Any thread event between
planning and commit refuses with `changed`; try again later.

- 200 `{ "ok": true, "archived": true, "thread": <detail> }`
- 409 `{ "ok": false, "archived": false, "error": { "code": "not_idle", "reason", "message" } }`
  with `reason` one of `archived`, `running`, `queued`, `pending-request`,
  `background-work`, `pending-wake`, `session-changed`, `changed`. The thread is
  unchanged.
- 409 `conflict` when the orchestrator rejects the archive for another reason.
- 404 `not_found` for an unknown or deleted thread, also when it was deleted
  while the archive ran.
- 503 `unavailable` when the server failed to become ready for commands or is
  shutting down; 500 `internal` when storage or a read failed. Neither means
  the thread is busy.

`t3ctl archive-if-idle THREAD [--session ses_...]` exits 3 when refused.

### GET /threads/:id/messages

Query: `limit` (default 50, newest kept), `all=true`, `role=user|assistant|all`,
`runId`, `since` (ISO/epoch ms on `updatedAt`), `afterMessageId`. System messages
are left out. Returns `messages[]` (`messageId`, `runId`, `role`, `text`,
`streaming`, `createdBy`, `creationSource`, `attachments`, timestamps),
`state`, `status`, `runId`, and `lastAssistant: { text, messageId, runId } | null`.
`lastAssistant` is the newest non-empty assistant text, scoped to `runId` when
given. Reasoning and tool output never count.

### GET /threads/:id/wait

Query: `timeoutMs` (default 10 min, max 60 min), `runId` (wait for that run),
`drain=1` (also wait out `waiting`, meaning background work). Returns
`timedOut`, `thread` (detail), and `lastAssistant`. It returns early when the
thread needs input, so a caller can answer and wait again.

### POST /threads/:id/send

`{ "text", "mode"?: "auto"|"queue"|"steer"|"restart", "model"?, "variant"?, "attachments"?, "clientRequestId"? }`.
`auto` (default) starts an idle thread, steers a running turn, or queues behind a
turn that cannot take steering yet. `queue` always waits for a separate turn.
`model`/`variant` apply to this message's run (OpenCode switches the session
model). Use `PATCH` to change the thread's default. Response: `messageId`,
`runId`, `status`, `delivery` (`started`, `queued`, `steered`, `restarted`).

### POST /threads/:id/requests/:requestId/respond

- Approval: `{ "decision": "approve" | "deny" | "always" }`, or a t3 decision
  (`accept`, `acceptForSession`, `acceptAlways`, `decline`, `cancel`). `deny`
  declines the call, and the agent is told not to retry. `cancel` ends the turn.
- Question: `{ "answers": { "<questionId>": "Label" | ["A","B"] } }`. Ids, options
  (`label`, `value`) and `multiSelect`/`allowCustomAnswer` come from
  `pendingRequests[].questions`. Values are option labels or values; free text is
  allowed where `allowCustomAnswer` is true. `{ "dismiss": true }` dismisses it.

### Runtime mode and auto-accept

`runtimeMode` replaces OpenChamber's per-session permission auto-accept:

- `full-access`: the OpenCode adapter writes an allow-all permission rule for
  the session, so nothing asks.
- `auto-accept-edits`: edits are allowed; shell and external directories ask.
- `approval-required`: shell, edits and external directories ask.

Set it at create time (`runtimeMode`) or later with `PATCH /threads/:id`
(`thread.runtime-mode.set`; it applies from the next turn). Subagents inherit
it. There is no per-rule permission list like crw's `PATCH /api/session`
permissions (see gaps).

### GET /events (SSE)

`text/event-stream`, sent `Cache-Control: no-cache, no-transform` so the
server's compression middleware leaves it alone. Frames go out as they happen,
with a `: ping` comment every 15 s. Each frame carries `id: <sequence>` and
`event: <type>`. `data` is JSON with `type`, `threadId`, and `origin`.

Start: the stream opens at the live head with an `event: ready` frame carrying
`sequence`. Resume with the `Last-Event-ID` header or `?after=<sequence>` to
replay everything since. The client reconnects and resumes on its own.

Filters: `threadId`, `origin` (or `none`), `types=a,b`.

| type                                  | data                                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------- |
| `thread.created`                      | `projectId`, `title`, `parentThreadId`                                                    |
| `thread.status`                       | `runId`, `status` (raw run status), `state`                                               |
| `message.completed`                   | `runId`, `messageId`, `role` (`user` or `assistant`), `text` (final, not streamed deltas) |
| `request.opened` / `request.resolved` | `requestId`, `kind` (`approval` or `question`), `requestKind`, `status`                   |
| `thread.updated`                      | `change`: archived, settled, renamed, runtime mode or model changed, ...                  |

A turn is finished when `thread.status` arrives with `state` `waiting` or
`idle`. Read the reply from `message.completed` or `/messages`.

### POST /attachments

`{ "name", "mimeType", "sizeBytes", "type"?: "image"|"file" }` returns
`{ attachmentId, relativeUrl, expiresAt }`. `POST` the raw bytes to
`<server origin><relativeUrl>`, with `Content-Length` equal to `sizeBytes`
(no auth; the URL is signed). Then pass
`{ attachmentId, name, mimeType, sizeBytes, type }` in `attachments` on create
or send. `client.upload({ name, mimeType, bytes })` does all of this.

## Client and CLI

```js
import { ControlClient } from "<fork>/apps/server/src/ardud/control/client.mjs";
const t3 = new ControlClient({ component: "t3ctl" }); // reads ~/.robob/components/t3ctl.json
const { threadId } = await t3.createThread({ prompt: "reply PONG", origin: "imessage" });
const done = await t3.wait(threadId);
console.log(done.lastAssistant?.text);
for await (const event of t3.events({ origin: "imessage", signal })) { ... }
```

```sh
alias t3ctl="node <fork>/apps/server/src/ardud/control/t3ctl.mjs"
t3ctl create --prompt "reply PONG" --origin crw --wait --text
t3ctl threads --active --text
t3ctl send <thread> "follow up" --wait --text
t3ctl respond <thread> <request> --approve
t3ctl events --origin imessage
t3ctl native ses_...
```

## OpenChamber to t3 mapping

### spectrum-bridge (`src/openchamber.ts`)

| OpenChamber call                                                                                                     | t3 control API                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                                                                                                        | `GET /health`                                                                                                                                                                                                           |
| `GET /api/fs/home` + `POST /api/fs/mkdir` + `POST /api/session {location, metadata.openchamber.origin}` (createChat) | `POST /threads { directory: "<chat root>/<date>/session-<uuid>", origin: "imessage", title? }`. Register the chat root once as a project; subfolders are created on demand. Or omit `directory` to use Scratch folders. |
| `POST /api/openchamber/sessions/:id/metadata` (markImessageOrigin)                                                   | `PUT /threads/:id/origin { origin: "imessage" }`                                                                                                                                                                        |
| `GET /api/session/:id`, `?parentID=` (children)                                                                      | `GET /threads/:id`, `GET /threads?parentThreadId=:id&includeSubagents=true`                                                                                                                                             |
| `GET /api/session/:id/message?...` (messages, turn reconstruction from `idle` markers)                               | `GET /threads/:id/messages` plus `state`. A turn is `send.runId`; it is done when its run leaves `running`. `lastAssistant` scoped by `runId` gives the reply.                                                          |
| `promptAccepted` (message or inbox lookup)                                                                           | Not needed: `send` returns only after the message is durably accepted. Use `clientRequestId` for retries.                                                                                                               |
| `POST /api/session/:id/model` + `/synthetic` (channel guidance) + `/prompt`                                          | `POST /threads/:id/send { text, model, variant, attachments }`. Channel guidance has no separate record: prepend it to `text`, or put it in the project's agent instructions (gap).                                     |
| `POST /api/session/:id/interrupt`                                                                                    | `POST /threads/:id/interrupt`                                                                                                                                                                                           |
| `GET /api/session/active` (statuses)                                                                                 | `GET /threads?active=true` (or `state=`)                                                                                                                                                                                |
| `GET /api/session/:id/permission`, `/form`                                                                           | `GET /threads/:id` gives `pendingRequests`; `GET /requests` lists them across threads                                                                                                                                   |
| `POST .../permission/:rid/reply {decision: once                                                                      | reject}`                                                                                                                                                                                                                | `POST /threads/:id/requests/:rid/respond { decision: "approve" | "deny" }` |
| `POST .../form/:fid/reply {answer}`, `DELETE .../form/:fid`                                                          | `respond { answers: { [questionId]: label                                                                                                                                                                               | labels } }`, `respond { dismiss: true }`                       |
| `isSessionAutoAccepting` (`/api/permission-auto-accept` + parent walk)                                               | `thread.runtimeMode === "full-access"`. Subagents inherit the parent's mode.                                                                                                                                            |
| `files` as data URLs                                                                                                 | `POST /attachments` + upload, then `attachments` on send                                                                                                                                                                |
| `/api/event`, `/api/openchamber/events` SSE                                                                          | `GET /events` (one stream)                                                                                                                                                                                              |
| Session ids `ses_...` stored in bridge state                                                                         | `GET /threads/by-native/:ses` maps them (live provider threads, plus `ardud_opencode_import` after import)                                                                                                              |

### telegram-bridge (`src/openchamber.ts`, `attention.ts`, `notification-events.ts`)

| OpenChamber                                                                                        | t3 control API                                                                                                                                  |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/session-board` (+ `openchamber:session-board.updated`)                                   | `GET /threads` with `state` and `pendingRequest` covers running, waiting and attention. |
| `GET /api/permission/request`, `GET /api/form` (directory-wide)                                    | `GET /requests` (all threads; `?origin=none` excludes iMessage)                                                                                 |
| reply/cancel permission and form                                                                   | `respond` as above                                                                                                                              |
| `GET /api/session/active`                                                                          | `GET /threads?active=true`                                                                                                                      |
| `GET /api/permission-auto-accept` (+ `.updated` event)                                             | `runtimeMode` on each thread; `thread.updated` with `change: thread.runtime-mode-updated`                                                       |
| Events `form.created`, `permission.asked` / `form.replied`, `form.cancelled`, `permission.replied` | `request.opened` / `request.resolved`                                                                                                           |
| `session.execution.started` / `succeeded`, `failed`, `interrupted`                                 | `thread.status` (`state` running, or waiting/idle; `status` failed, interrupted, ...)                                                           |
| `session.inbox.enqueued` (user), `session.renamed`                                                 | `message.completed` with `role: "user"`; `thread.updated`                                                                                       |
| `sessionOrigin` / `IMESSAGE_ORIGIN` filtering                                                      | `origin` on every summary and event                                                                                                             |

### crw (`lib/sessions.mjs`, `lib/util.mjs`)

| crw call                                                                                 | t3 control API                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api('/api/session', {title, location:{directory}, permissions})`                        | `POST /threads { title, directory: thread_directory, origin: "crw", runtimeMode }` (no prompt)                                                                                                |
| `PUT /api/permission-auto-accept/sessions/:id {enabled:true}` + policy check             | `runtimeMode: "full-access"` at create, or `PATCH /threads/:id { runtimeMode: "full-access" }`; `GET /threads/:id` confirms it                                                                |
| `PATCH /api/session/:id {permissions: reviewerPermissions()}` (read-only reviewer rules) | Gap: t3 has no per-thread rule list. Nearest: `approval-required` (shell and edits ask; crw would answer through `/respond`), or `interactionMode: "plan"` (OpenCode's read-only plan agent). |
| `control('session.send', {sessionId, prompt, model, variant})`                           | `POST /threads/:id/send { text, model, variant, mode: "queue" }`. A rejected send is a 409 instead of `promptDispatched: false`.                                                              |
| `control('session.status', ...)` -> `sessionStatus.type`                                 | `GET /threads/:id` gives `state` (`busy` maps to `running`/`needs-input`, `idle` to `idle`/`waiting`)                                                                                         |
| `messages(id)` paging, `lastAssistant`, `complete(m)`                                    | `GET /threads/:id/messages?all=true` (`role`, `text`); `lastAssistant`; completion is `state !== "running"` plus `thread.run.status === "completed"`/`"waiting"`                              |
| `PATCH /api/session/:id {title}` (rename)                                                | `PATCH /threads/:id { title }`                                                                                                                                                                |
| stored `session_id` (`ses_...`)                                                          | `GET /threads/by-native/:ses`, then use the `threadId`                                                                                                                                        |

### robob-watch

Does not call OpenChamber. It wakes agents through the spectrum and telegram
bridge CLIs (`wake`, `send --session <ses>`), and reads the bridge's own sqlite
for the live route session. Nothing here is needed beyond the bridge port; its
stored `ses_` route ids resolve with `/threads/by-native`.

### OpenChamber agent tool (`openchamber` tool inside sessions) to T3 MCP

Agents inside t3 threads already get the T3 MCP server. Equivalents:

| openchamber action                             | T3 MCP tool                                                                                                                     | Notes                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `projects.list`                                | `t3_project_list`                                                                                                               |                                                                                       |
| `models.list`                                  | `orchestrator_capabilities`                                                                                                     | Lists providers, models and options. No favourites or recents.                        |
| `session.list`                                 | `t3_thread_list`                                                                                                                | Calling project only. `t3_thread_search` searches titles and content.                 |
| `session.create`                               | `t3_thread_launch` (`message` optional, `scratch`, `workspaceStrategy`) or `create_threads`                                     |                                                                                       |
| `session.dispatch`                             | `t3_thread_launch` with `message`, or `create_threads` with `prompt`                                                            | Both return without waiting.                                                          |
| `session.send`                                 | `t3_thread_send`                                                                                                                | `mode` auto, queue, steer, restart                                                    |
| `session.fork`                                 | `t3_thread_fork`                                                                                                                | Forks the calling thread only.                                                        |
| `session.status`                               | `t3_thread_read` (thread detail)                                                                                                |                                                                                       |
| `session.messages` (+ `wait`, `lastAssistant`) | `t3_thread_read` (+ `t3_thread_wait`)                                                                                           |                                                                                       |
| `schedule.list/create/delete/toggle/run`       | `list_scheduled_tasks`, `schedule_task`, `delete_scheduled_task`, `update_scheduled_task { enabled }`, `run_scheduled_task_now` | Calling project only. Cron and timezone schedules come from the schedule-cron branch. |
| `file.open`                                    | Gap; `preview_open` covers web pages only.                                                                                      |                                                                                       |
| goal mode                                      | dropped (owner decision)                                                                                                        |                                                                                       |
| `openchamber_web` `browser.*`                  | `preview_*` tools                                                                                                               |                                                                                       |
| `memory.*`                                     | memory MCP (separate)                                                                                                           |                                                                                       |

Gaps for the agent tool: cross-project thread listing and sending (MCP is scoped
to the calling project; outside a thread, use `t3ctl`), `file.open`, model
favourites and recents, `session.send` to a thread in another project, and
`agent` selection (t3 picks OpenCode's build or plan agent from
`interactionMode`).

## Known gaps

- No per-thread permission rule lists (crw's reviewer rules). Runtime mode is
  all t3 has.
- No synthetic or system context record before a prompt (spectrum's channel
  guidance). Prepend it to the message.
- No session board. `GET /api/ardud/board` was removed; use `GET /threads`
  and `GET /requests`.
- `ardud_opencode_import` is only filled by the importer (opencode-import
  branch). Before that, `by-native` resolves only sessions t3 itself created.
- Tokens come from `t3 auth session issue` with administrative scopes. There is
  no read-only option in the CLI.
