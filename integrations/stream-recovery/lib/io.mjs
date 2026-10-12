// I/O for stream-recovery: Robob state DB (read-only), Robob control API,
// Robob orchestration WebSocket RPC, OpenCode service API, Telegram, state file.
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = process.env.HOME || homedir();
export const PATHS = {
  db: process.env.STREAM_RECOVERY_DB || join(HOME, ".robob/userdata/statev2.sqlite"),
  control: join(HOME, ".robob/ardud-control.json"),
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
  return new DatabaseSync(path, { readOnly: true });
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

let controlCfg;
function control() {
  if (!controlCfg) {
    const cfg = parse(readFileSync(PATHS.control, "utf8"));
    controlCfg = {
      url: (process.env.T3_CONTROL_URL || cfg.url || "http://127.0.0.1:3773").replace(/\/$/, ""),
      token: process.env.T3_CONTROL_TOKEN || cfg.token,
    };
  }
  return controlCfg;
}

export async function ctl(method, path, body) {
  const { url, token } = control();
  const res = await fetch(`${url}/api/ardud/control${path}`, {
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

export async function sendToThread(threadId, text, { clientRequestId, mode = "auto" } = {}) {
  return ctl("POST", `/threads/${encodeURIComponent(threadId)}/send`, { text, mode, clientRequestId });
}

// Orchestration command over the Robob WebSocket RPC (same path the web app uses).
export function dispatchCommand(command, { timeoutMs = 20_000 } = {}) {
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
    ws.addEventListener("open", () =>
      ws.send(JSON.stringify({ _tag: "Request", id: "1", tag: "orchestration.dispatchCommand", payload: command, headers: [] })),
    );
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
  ocAuth ??= "Basic " + Buffer.from(`opencode:${readFileSync(PATHS.ocPassword, "utf8").trim()}`).toString("base64");
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
  return new Set(Object.keys((await oc("/api/session/active"))?.data ?? {}));
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

// ---------- Telegram ----------

export function telegram({ text, severity = "info", key }) {
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

const statePath = () => join(PATHS.dataDir, "state.json");

export function loadState() {
  if (!existsSync(statePath())) return { handled: {}, lastScan: null };
  const s = parse(readFileSync(statePath(), "utf8"));
  return { handled: s.handled ?? {}, lastScan: s.lastScan ?? null };
}

export function saveState(state, now = Date.now()) {
  mkdirSync(PATHS.dataDir, { recursive: true });
  for (const [id, v] of Object.entries(state.handled)) {
    if (now - Date.parse(v.at) > 14 * 86_400_000) delete state.handled[id];
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
