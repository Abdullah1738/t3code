// I/O for stream-recovery: Robob state DB (read-only), Robob control API,
// Robob orchestration WebSocket RPC, OpenCode service API, Telegram, state file.
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assertRecoveryActive, loadControl, recoveryElapsed } from './pause.mjs';
import { isOpenCodeSessionId, parseCutoverStatus } from './harness.mjs';
import { assertReplicaPath, guardReplica, registerReplica, replicaPath } from './readonly-db.mjs';
export { assertReplicaFresh, assertThreadInReplica } from './readonly-db.mjs';

const HOME = process.env.HOME || homedir();
export const PATHS = {
  db: replicaPath(),
  ocPassword: join(HOME, ".config/opencode-service/password"),
  dataDir: process.env.STREAM_RECOVERY_DATA || join(HOME, ".local/share/stream-recovery/data"),
  bun: join(HOME, ".bun/bin/bun"),
  telegramCli: join(HOME, ".local/share/telegram-bridge/src/cli.ts"),
};
export const OC_URL = process.env.OPENCODE_SERVICE_URL || "http://127.0.0.1:49374";

const parse = (text) => {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
};

// ---------- Robob state DB (read-only, indexed lookups only) ----------

export function openDb(path = PATHS.db) {
  const safePath = assertReplicaPath(path);
  const db = new DatabaseSync(safePath, { readOnly: true });
  try {
    // Pin readiness and all dependent rows to one complete export.
    db.exec('BEGIN');
    registerReplica(db, safePath);
    return guardReplica(db);
  } catch (e) {
    db.close();
    throw e;
  }
}

export function failedRunsSince(db, sinceIso) {
  const rows = db
    .prepare(
      `select run_id, thread_id, ordinal, requested_at, completed_at,
              json_extract(payload_json,'$.activeAttemptId') attempt,
              json_extract(payload_json,'$.userMessageId') user_message_id,
              json_extract(payload_json,'$.startedAt') started_at
         from orchestration_v2_projection_runs
        where status='failed' and completed_at >= ? order by completed_at`,
    )
    .all(sinceIso);
  const err = db.prepare(
    `select json_extract(payload_json,'$.failure.message') m from orchestration_v2_projection_turn_items
      where run_id=? and type='error' limit 1`,
  );
  return rows.map((r) => ({ ...r, error: err.get(r.run_id)?.m ?? null }));
}

export function failedSubagentsSince(db, sinceIso) {
  return db
    .prepare(
      `select subagent_id, thread_id, run_id, provider_thread_id, child_thread_id, completed_at,
              json_extract(payload_json,'$.result') result, json_extract(payload_json,'$.title') title
         from orchestration_v2_projection_subagents
        where status='failed' and completed_at >= ? order by completed_at`,
    )
    .all(sinceIso);
}

// Native subagents Robob closed as cancelled (restart recovery does this), or
// interrupted with their parent's turn when OpenCode crashed: no Stop was
// requested on that turn.
export function cancelledSubagentsSince(db, sinceIso) {
  return db
    .prepare(
      `select subagent_id, thread_id, run_id, provider_thread_id, child_thread_id, started_at, completed_at,
              json_extract(payload_json,'$.result') result, json_extract(payload_json,'$.title') title,
              json_extract(payload_json,'$.prompt') prompt, json_extract(payload_json,'$.model') model
         from orchestration_v2_projection_subagents s
        where origin='provider_native' and completed_at >= ?
          and status in ('cancelled','interrupted')
          and not exists(select 1 from orchestration_v2_projection_turn_items i
            where i.run_id=s.run_id and i.type='run_interrupt_request')
        order by completed_at`,
    )
    .all(sinceIso);
}

// A delegated task can also be stopped directly in its child thread, without
// interrupting the parent run. Only the child run current at the cut matters.
export function cancelledDelegatedTasksSince(db, sinceIso) {
  return db.prepare(
    `select s.subagent_id, s.thread_id, s.run_id, s.provider_thread_id, s.child_thread_id, s.started_at, s.completed_at,
            json_extract(s.payload_json,'$.result') result, json_extract(s.payload_json,'$.title') title,
            json_extract(s.payload_json,'$.prompt') prompt, json_extract(s.payload_json,'$.model') model,
            json_extract(s.payload_json,'$.clientRequestId') client_request_id
       from orchestration_v2_projection_subagents s
      where s.origin='app_owned' and s.subagent_id glob 'node:delegated-task:*'
        and s.completed_at >= ? and s.status in ('cancelled','interrupted')
        and coalesce(json_extract(s.payload_json,'$.completionDelivery.state'),'') != 'disposed'
        and not exists(select 1 from orchestration_v2_projection_turn_items i
          where i.run_id=s.run_id and i.type='run_interrupt_request' and i.updated_at >= s.started_at)
      order by s.completed_at`,
  ).all(sinceIso).map(({ client_request_id, ...row }) => ({
    ...row, kind: 'delegated', childThreadId: row.child_thread_id,
    // task_status takes a node ID, not the client request ID used to make it.
    taskRef: row.subagent_id,
    clientRequestId: client_request_id ?? null,
  })).filter((row) => {
    const runs = taskChildRuns(db, row.childThreadId, row.taskRef);
    // Buffered notifications can be cancelled without ever starting; they
    // must not hide the Stop on the task's last executed run.
    const last = runs.findLast((r) => r.requested_at <= row.completed_at && r.status !== 'queued'
      && (r.status !== 'cancelled' || r.started_at != null || r.continued_from != null || r.stop_requested));
    return !last?.stop_requested;
  });
}

function taskChildRuns(db, childThreadId, taskRef) {
  if (!childThreadId) return [];
  const rows = db.prepare(
    `select run_id, ordinal, status, requested_at, completed_at,
            json_extract(payload_json,'$.delegatedTaskId') task_id,
            json_extract(payload_json,'$.restartContinuationOfRunId') continued_from,
            json_extract(payload_json,'$.queueHeld') queue_held,
            json_extract(payload_json,'$.startedAt') started_at,
            json_extract(payload_json,'$.restartCancelledBackgroundWork') cancelled_work,
            exists(select 1 from orchestration_v2_projection_turn_items i
              where i.run_id=r.run_id and i.type='run_interrupt_request') stop_requested
       from orchestration_v2_projection_runs r where thread_id=? order by ordinal`,
  ).all(childThreadId);
  // The original delegate has no delegatedTaskId. Until its result is
  // published, additional child turns can also be uncorrelated. Limit those
  // turns to the original task's lifetime; separately correlated tasks keep
  // their own runs.
  const initial = rows.filter((r) => r.task_id === taskRef);
  const first = rows[0];
  const legacyTask = childThreadId.startsWith('thread:delegated-task:')
    ? `node:delegated-task:${childThreadId.slice('thread:delegated-task:'.length)}` : null;
  if (!initial.length && taskRef === legacyTask && first && !first.task_id) {
    const task = db.prepare(
      `select completed_at from orchestration_v2_projection_subagents where subagent_id=?`,
    ).get(taskRef);
    initial.push(...rows.filter((r) => !r.task_id && r.requested_at <= (task?.completed_at ?? '9999')));
  }
  if (!initial.length) return [];
  const ids = new Set(initial.map((r) => r.run_id));
  for (const r of rows) if (ids.has(r.continued_from)) ids.add(r.run_id);
  return rows.filter((r) => ids.has(r.run_id));
}

export function childRunOutcomeSince(db, childThreadId, taskRef, sinceIso) {
  const owned = taskChildRuns(db, childThreadId, taskRef);
  const active = owned.findLast((r) => ['preparing', 'starting', 'running', 'waiting'].includes(r.status)
    || (r.status === 'queued' && r.queue_held !== 1 && r.queue_held !== true));
  if (active) return { status: 'running', run_id: active.run_id };
  const completed = owned.findLast((r) => r.status === 'completed' && r.completed_at > sinceIso
    && !parse(r.cancelled_work)?.some?.((work) => work.kind !== 'shell'));
  return completed ? { status: 'finished', run_id: completed.run_id, completed_at: completed.completed_at } : null;
}

export function delegatedStoppedSince(db, sub) {
  const task = db.prepare(
    `select json_extract(payload_json,'$.completionDelivery.state') delivery
       from orchestration_v2_projection_subagents where subagent_id=?`,
  ).get(sub.subagent_id);
  if (task?.delivery === 'disposed') return true;
  return Boolean(sub.childThreadId && stoppedSince(db, sub.childThreadId, sub.completed_at));
}

export function childNativeSession(db, childThreadId) {
  if (!childThreadId) return null;
  const providerThread = db.prepare(
    `select provider_thread_id from orchestration_v2_projection_runs
      where thread_id=? and provider_thread_id is not null order by ordinal desc limit 1`,
  ).get(childThreadId)?.provider_thread_id;
  return /^provider-thread:provider:opencode:.*:native-thread:(ses_[A-Za-z0-9]+)$/.exec(providerThread ?? '')?.[1] ?? null;
}

// A user_message turn item materializes when a queued turn starts, before
// startedAt is set. It distinguishes cancelled starts from cancelled queues.
// An OpenCode crash leaves Robob's turns 'interrupted' with no
// run_interrupt_request item (31 Oct, SIGBUS); a Stop always writes one.
export function restartRunsSince(db, sinceIso) {
  return db.prepare(
    `select r.run_id, r.thread_id, r.ordinal, r.status, r.requested_at, r.completed_at,
            json_extract(r.payload_json,'$.modelSelection.instanceId') instance_id,
            json_extract(r.payload_json,'$.startedAt') started_at,
            exists(select 1 from orchestration_v2_projection_turn_items i
              where i.run_id=r.run_id and i.type='user_message') dispatched,
            exists(select 1 from orchestration_v2_projection_turn_items i
              where i.run_id=r.run_id and i.type='run_interrupt_request') stop_requested
       from orchestration_v2_projection_runs r
       join orchestration_v2_projection_threads t on t.thread_id=r.thread_id
      where r.completed_at >= ? and r.status in ('cancelled','failed','interrupted')
        and (r.status='failed' or json_extract(r.payload_json,'$.startedAt') is not null
          or exists(select 1 from orchestration_v2_projection_turn_items i
            where i.run_id=r.run_id and i.type='user_message'))
        and json_extract(t.payload_json,'$.lineage.parentThreadId') is null
        and r.thread_id not like 'thread:provider:%'
      order by r.completed_at`,
  ).all(sinceIso);
}

export function stoppedSince(db, threadId, sinceIso) {
  // A later explicit Stop is a barrier even if other turns ran in between.
  // Any requested interrupt is a Stop, whatever the run's status: an idle
  // thread's Stop marks its last run without changing that run's status.
  // A crash-interrupted turn has no request item, so it is not a barrier.
  return Boolean(db.prepare(
    `select 1 from orchestration_v2_projection_turn_items
      where thread_id=? and type='run_interrupt_request' and updated_at >= ? limit 1`,
  ).get(threadId, sinceIso));
}

export function restartNoteRun(db, threadId, incidentId) {
  const messageId = `ardud-control:send:${threadId}:${encodeURIComponent(incidentId)}`;
  return db.prepare(
    `select run_id from orchestration_v2_projection_messages where thread_id=? and message_id=?`,
  ).get(threadId, messageId)?.run_id ?? null;
}

export function threadRoot(db, threadId) {
  return (
    db
      .prepare(`select json_extract(payload_json,'$.lineage.rootThreadId') r from orchestration_v2_projection_threads where thread_id=?`)
      .get(threadId)?.r ?? null
  );
}

export function subagentsStartedSince(db, threadId, sinceIso) {
  return db
    .prepare(
      `select subagent_id, provider_thread_id, started_at, status, json_extract(payload_json,'$.title') title
         from orchestration_v2_projection_subagents where thread_id=? and started_at >= ? order by started_at`,
    )
    .all(threadId, sinceIso);
}

export function runStartedSince(db, threadId, sinceIso) {
  return Boolean(
    db
      .prepare(
        `select 1 from orchestration_v2_projection_runs
          where thread_id=? and json_extract(payload_json,'$.startedAt') >= ? limit 1`,
      )
      .get(threadId, sinceIso),
  );
}

// Whether the thread's own turn was cancelled between fromIso and toIso and
// nothing ran on it since.
export function turnCutAndIdle(db, threadId, fromIso, toIso) {
  const cut = db
    .prepare(
      `select ordinal from orchestration_v2_projection_runs
        where thread_id=? and status='cancelled' and completed_at between ? and ?
          and json_extract(payload_json,'$.startedAt') is not null
        order by ordinal desc limit 1`,
    )
    .get(threadId, fromIso, toIso);
  if (!cut) return false;
  return !db
    .prepare(`select 1 from orchestration_v2_projection_runs where thread_id=? and ordinal > ? and status != 'queued' limit 1`)
    .get(threadId, cut.ordinal);
}

// Whether a subagent's completion reached the thread (OpenCode delivers it as
// a "<subagent sessionID=...>" user message), optionally only up to untilIso.
export function subagentResultSeen(db, threadId, sinceIso, ses, untilIso = "9999") {
  return Boolean(
    db
      .prepare(
        `select 1 from orchestration_v2_projection_messages
          where thread_id=? and created_at >= ? and created_at <= ? and role='user'
            and json_extract(payload_json,'$.text') like ? limit 1`,
      )
      .get(threadId, sinceIso, untilIso, `<subagent sessionID="${ses}"%`),
  );
}

// Parent of a nested child thread id ("thread:provider:...native-thread:ses_X").
export function subagentParent(db, providerThreadId) {
  return (
    db
      .prepare(`select thread_id from orchestration_v2_projection_subagents where provider_thread_id=? limit 1`)
      .get(providerThreadId)?.thread_id ?? null
  );
}

export function laterRuns(db, threadId, ordinal) {
  return db
    .prepare(
      `select ordinal, status, requested_at from orchestration_v2_projection_runs
        where thread_id=? and ordinal > ? order by ordinal`,
    )
    .all(threadId, ordinal);
}

export function queuedRuns(db, threadId) {
  return db
    .prepare(
      `select run_id, ordinal, requested_at, json_extract(payload_json,'$.queueHeld') held,
              json_extract(payload_json,'$.userMessageId') user_message_id
         from orchestration_v2_projection_runs where thread_id=? and status='queued' order by ordinal`,
    )
    .all(threadId)
    .map((r) => ({ ...r, held: r.held === 1 || r.held === true || r.held === "true" }));
}

export function runMessages(db, runId) {
  return db
    .prepare(
      `select message_id, role, created_at, json_extract(payload_json,'$.text') text,
              json_extract(payload_json,'$.createdBy') created_by,
              json_extract(payload_json,'$.creationSource') creation_source
         from orchestration_v2_projection_messages where run_id=? order by created_at`,
    )
    .all(runId);
}

export function messageText(db, messageId) {
  return (
    db
      .prepare(`select json_extract(payload_json,'$.text') t from orchestration_v2_projection_messages where message_id=?`)
      .get(messageId)?.t ?? null
  );
}

export function threadMessageIdsSince(db, threadId, sinceIso) {
  return db
    .prepare(
      `select message_id from orchestration_v2_projection_messages
        where thread_id=? and created_at >= ? and role='assistant'`,
    )
    .all(threadId, sinceIso)
    .map((r) => r.message_id);
}

// ---------- Robob control API ----------

// Robob's address and credential: T3_CONTROL_URL/T3_CONTROL_TOKEN, else
// T3_CONTROL_TOKEN_FILE, else the component credential
// ~/.robob/components/stream-recovery.json (from `t3 ardud component-token
// issue stream-recovery`). Token files must be chmod 600.
export function controlConfig(env = process.env, home = HOME) {
  // A named file must exist; only the default is skipped when missing.
  const named = env.T3_CONTROL_TOKEN_FILE;
  const path = named || join(home, ".robob/components/stream-recovery.json");
  let file = {};
  if (!(env.T3_CONTROL_TOKEN && env.T3_CONTROL_URL)) {
    let mode;
    try {
      mode = statSync(path).mode;
    } catch (e) {
      if (e.code !== "ENOENT" || named) throw e;
    }
    if (mode !== undefined) {
      if (mode & 0o077) throw new Error(`${path} must be chmod 600`);
      try {
        file = JSON.parse(readFileSync(path, "utf8"));
      } catch (e) {
        throw new Error(`${path} is not valid JSON: ${e.message}`);
      }
    }
  }
  file ??= {};
  const token = env.T3_CONTROL_TOKEN || file.token;
  if (!token) throw new Error(`no control token (${path})`);
  return {
    url: (env.T3_CONTROL_URL || file.url || "http://127.0.0.1:3773").replace(/\/+$/, ""),
    token,
  };
}

let controlCfg;
function control() {
  controlCfg ??= controlConfig();
  return controlCfg;
}

export async function ctl(method, path, body) {
  return api(method, `/api/ardud/control${path}`, body);
}

export async function harnessCutoverStatus() {
  return parseCutoverStatus(await ctl('GET', '/harness-cutover/status'));
}

async function api(method, path, body) {
  const { url, token } = control();
  if (method !== "GET") assertRecoveryActive({ readControl });
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const data = parse(await res.text());
  if (!res.ok || data.ok === false) {
    const e = new Error(`control ${method} ${path}: ${res.status} ${data.error?.message || data.message || ""}`.trim());
    e.status = res.status;
    throw e;
  }
  return data;
}

export async function getThread(threadId) {
  try {
    return (await ctl("GET", `/threads/${encodeURIComponent(threadId)}`)).thread ?? null;
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

export async function robobHealthy() {
  try {
    await ctl("GET", "/health");
    return true;
  } catch {
    return false;
  }
}

// The running Robob server: server-runtime.json is published once startup
// recovery is done (startedAt = ready time) and removed on shutdown. The
// process start comes from ps, as serverOwnership.ts reads it.
export function serverRuntime() {
  const path = join(HOME, ".robob/userdata/server-runtime.json");
  if (!existsSync(path)) return null;
  const s = parse(readFileSync(path, "utf8"));
  const readyMs = Date.parse(s.startedAt);
  if (!Number.isInteger(s.pid) || !Number.isFinite(readyMs)) return null;
  try {
    process.kill(s.pid, 0);
  } catch {
    return null;
  }
  const r = spawnSync("ps", ["-p", String(s.pid), "-o", "lstart="], {
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    encoding: "utf8",
    timeout: 5_000,
  });
  const procStartMs = r.status === 0 ? Date.parse(`${r.stdout.trim()} UTC`) : NaN;
  return { pid: s.pid, readyMs, procStartMs: Number.isFinite(procStartMs) ? procStartMs : null };
}

// OpenCode can restart without Robob. Its LaunchAgent PID plus process start
// supplies a restart window even when no native children were in flight.
export function openCodeRuntime() {
  const agent = spawnSync('launchctl', ['list', 'com.ardud.opencode-service'], { encoding: 'utf8', timeout: 5_000 });
  const pid = Number(/"PID"\s*=\s*(\d+)/.exec(agent.stdout ?? '')?.[1]);
  if (!pid) return null;
  const proc = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], {
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, encoding: 'utf8', timeout: 5_000,
  });
  const ms = proc.status === 0 ? Date.parse(`${proc.stdout.trim()} UTC`) : NaN;
  return Number.isFinite(ms) ? { service: 'opencode', pid, readyMs: ms, procStartMs: ms } : null;
}

// install-robob-resume.zsh keeps pending.json until it has sent its own
// "resume" message to the threads it snapshotted. Returns its mtime or null.
export function installerResumePendingMs() {
  const path = join(HOME, ".robob/restart-snapshots/pending.json");
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

export async function sendToThread(threadId, text, { clientRequestId, mode = "auto" } = {}) {
  assertRecoveryActive({ readControl });
  return ctl("POST", `/threads/${encodeURIComponent(threadId)}/send`, { text, mode, clientRequestId });
}

export async function threadByNative(ses) {
  try {
    return (await ctl("GET", `/threads/by-native/${encodeURIComponent(ses)}`)).thread ?? null;
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

export async function interruptThread(threadId, { clientRequestId, reason, expectedRunId } = {}) {
  assertRecoveryActive({ readControl });
  return ctl("POST", `/threads/${encodeURIComponent(threadId)}/interrupt`, { clientRequestId, reason, expectedRunId });
}

// Live top-level threads (running, waiting, queued, needs-input).
export async function activeThreads() {
  return (await ctl("GET", "/threads?active=true&limit=500")).threads ?? [];
}

// Orchestration command over the Robob WebSocket RPC (same path the web app uses).
export function dispatchCommand(command, { timeoutMs = 20_000 } = {}) {
  assertRecoveryActive({ readControl });
  const { url, token } = control();
  const wsUrl = `${url.replace(/^http/, "ws")}/ws?orchestrationProtocol=2`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${token}` } });
    ws.binaryType = "arraybuffer";
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      fn(v);
    };
    const timer = setTimeout(() => finish(reject, new Error(`ws ${command.type}: timeout`)), timeoutMs);
    ws.addEventListener("open", () => {
      try {
        assertRecoveryActive({ readControl });
        ws.send(JSON.stringify({ _tag: "Request", id: "1", tag: "orchestration.dispatchCommand", payload: command, headers: [] }));
      } catch (err) { finish(reject, err); }
    });
    ws.addEventListener("message", (ev) => {
      const raw = typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8");
      const parsed = parse(raw);
      for (const msg of Array.isArray(parsed) ? parsed : [parsed]) {
        if (msg._tag === "Ping") ws.send(JSON.stringify({ _tag: "Pong" }));
        else if (msg._tag === "Exit") {
          if (msg.exit?._tag === "Success") finish(resolve, msg.exit.value);
          else finish(reject, new Error(`ws ${command.type}: ${JSON.stringify(msg.exit).slice(0, 300)}`));
        } else if (msg._tag === "Defect") finish(reject, new Error(`ws ${command.type}: defect ${JSON.stringify(msg).slice(0, 300)}`));
      }
    });
    ws.addEventListener("error", (ev) => finish(reject, new Error(`ws ${command.type}: ${ev.message || "error"}`)));
    ws.addEventListener("close", () => finish(reject, new Error(`ws ${command.type}: closed before reply`)));
  });
}

// ---------- OpenCode service API ----------

let ocAuth;
async function oc(path, init = {}) {
  const session = /^\/api\/session\/([^/?]+)/.exec(path)?.[1];
  if (session && session !== 'active' && !isOpenCodeSessionId(session)) {
    throw new Error('refusing OpenCode request for a non-OpenCode session ID');
  }
  ocAuth ??= "Basic " + Buffer.from(`opencode:${readFileSync(PATHS.ocPassword, "utf8").trim()}`).toString("base64");
  if (init.method && init.method !== "GET") assertRecoveryActive({ readControl });
  const res = await fetch(`${OC_URL}${path}`, {
    ...init,
    headers: { authorization: ocAuth, ...(init.headers || {}) },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`opencode ${path}: ${res.status}`);
  return parse(await res.text());
}

export async function activeSessions() {
  return new Set(Object.keys((await oc("/api/session/active"))?.data ?? {}).filter(isOpenCodeSessionId));
}

export async function ocSession(ses) {
  return (await oc(`/api/session/${ses}`))?.data ?? null;
}

// Newest-first messages of one type, paging until older than stopBeforeMs.
// Returns { messages, complete } where complete means the window was fully covered.
export async function ocMessages(ses, { type, stopBeforeMs = 0, limit = 200, maxPages = 6 } = {}) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (type) q.set("type", type);
    if (cursor) q.set("cursor", cursor);
    const res = await oc(`/api/session/${ses}/message?${q}`);
    const data = res?.data ?? [];
    out.push(...data);
    const oldest = data.at(-1)?.time?.created ?? 0;
    cursor = res?.cursor?.next ?? null;
    if (!cursor || data.length < limit || oldest < stopBeforeMs) return { messages: out, complete: true };
  }
  return { messages: out, complete: false };
}

export async function ocForms(ses) {
  return (await oc(`/api/session/${ses}/form`))?.data ?? [];
}

export async function ocPermissions(ses) {
  return (await oc(`/api/session/${ses}/permission`))?.data ?? [];
}

// Newest messages only (newest first), for the stall watch.
export async function ocTail(ses, limit = 2) {
  return (await oc(`/api/session/${ses}/message?limit=${limit}`))?.data ?? null;
}

export async function ocChildren(ses) {
  if (!isOpenCodeSessionId(ses)) throw new Error('refusing OpenCode request for a non-OpenCode session ID');
  return ((await oc(`/api/session?parentID=${encodeURIComponent(ses)}&limit=200`))?.data ?? []).map((s) => s.id);
}

// Returns true when OpenCode stopped an active execution, false when idle.
export async function ocInterrupt(ses) {
  assertRecoveryActive({ readControl });
  const res = await oc(`/api/session/${ses}/interrupt`, { method: "POST" });
  return Boolean(res?.interrupted ?? res?.data?.interrupted);
}

// ---------- Telegram ----------

export function telegram({ text, severity = "info", key }) {
  assertRecoveryActive({ readControl });
  const env = { ...process.env };
  delete env.BUN_INSPECT;
  const r = spawnSync(
    PATHS.bun,
    [PATHS.telegramCli, "notify", "--source", "stream-recovery", "--severity", severity, "--text", text, "--key", key],
    { env, timeout: 30_000, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`telegram notify failed: ${(r.stderr || r.error?.message || "").slice(0, 300)}`);
}

// ---------- State + lock ----------

export const readControl = () => loadControl(PATHS.dataDir);

const statePath = () => join(PATHS.dataDir, "state.json");

export function loadState() {
  if (!existsSync(statePath())) return { handled: {}, lastScan: null, lastStallScan: null, watch: {}, stalls: {}, servers: [], ghosts: {} };
  const s = parse(readFileSync(statePath(), "utf8"));
  return {
    handled: s.handled ?? {}, lastScan: s.lastScan ?? null, lastStallScan: s.lastStallScan ?? null, watch: s.watch ?? {}, stalls: s.stalls ?? {},
    servers: s.servers ?? [], ghosts: s.ghosts ?? {},
  };
}

export function saveState(state, now = Date.now()) {
  mkdirSync(PATHS.dataDir, { recursive: true });
  for (const key of ["handled", "stalls"]) {
    for (const [id, v] of Object.entries(state[key] ?? {})) {
      if (v.done && recoveryElapsed({ readControl }, Date.parse(v.at), now) > 14 * 86_400_000) delete state[key][id];
    }
  }
  const tmp = `${statePath()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, statePath());
}

export function acquireLock(now = Date.now()) {
  mkdirSync(PATHS.dataDir, { recursive: true });
  const lock = join(PATHS.dataDir, "scan.lock");
  if (existsSync(lock)) {
    const { pid, at } = parse(readFileSync(lock, "utf8"));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {}
    if (alive && now - at < 10 * 60_000) return null;
  }
  writeFileSync(lock, JSON.stringify({ pid: process.pid, at: now }));
  return () => rmSync(lock, { force: true });
}
