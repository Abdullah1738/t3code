import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { jsonBody, object, opaqueId, tokenMatches, unseal, validId, type Fetch, type Sealed } from "../../spectrum-bridge/src/remote-protocol.ts";
import { HarnessFailure } from "./harness-failure.ts";

export type Harness = { ready?(): boolean; run(input: { id: string; session: string; resume: boolean; text: string; system: string; signal?: AbortSignal }): Promise<string> };
export type RunnerConfig = { root: string; boxId: string; epoch: string; token: string; privateKey: string;
  callbackToken: string; callbackUrl: string; system: string };
class AttachmentFailure extends Error {
  constructor(readonly code: "invalid" | "unavailable" | "too-large") { super("Attachment failed"); }
}
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
export class BoxRunner {
  readonly db: Database;
  watch?: (body: Record<string, unknown>) => Promise<void>;
  private working = false;
  private turnAbort?: AbortController;
  private flushing = false;
  private leaseUntil = 0;
  private lastLeaseAt: number | null = null;
  constructor(readonly config: RunnerConfig, private readonly harness: Harness, private readonly io: {
    fetch?: Fetch; now?: () => number; log?: (code: string, ms?: number, detail?: Record<string, string | number | boolean | null>) => void;
    callbackReady?: () => Promise<boolean>;
    modelReady?: () => Promise<boolean>;
    share?: (path: string, body: Record<string, unknown>) => Promise<unknown>;
  } = {}) {
    mkdirSync(config.root, { recursive: true, mode: 0o700 });
    this.db = new Database(join(config.root, "agent.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS inbox(seq INTEGER PRIMARY KEY, id TEXT UNIQUE, payload TEXT, state TEXT);
      CREATE TABLE IF NOT EXISTS inbox_errors(id TEXT PRIMARY KEY, code TEXT);
      CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY, path TEXT, payload TEXT, result TEXT, state TEXT);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE IF NOT EXISTS interruptions(id TEXT PRIMARY KEY, reason TEXT, at INTEGER, last_lease_at INTEGER,
        exit_code INTEGER, signal TEXT, stderr_bytes INTEGER, sends INTEGER, bus_actions INTEGER, tool_actions INTEGER, retried INTEGER);`);
    const previousLease = this.db.query<{ value: string }, []>("SELECT value FROM settings WHERE key='last-lease-at'").get();
    if (previousLease) this.lastLeaseAt = Number(previousLease.value);
    this.db.query("INSERT OR IGNORE INTO settings VALUES ('session',?)").run(randomUUID());
    if (!this.db.query<{ name: string }, []>("PRAGMA table_info(inbox)").all().some(c => c.name === "interrupted_at")) this.db.exec("ALTER TABLE inbox ADD COLUMN interrupted_at INTEGER");
    if (!this.db.query<{ name: string }, []>("PRAGMA table_info(actions)").all().some(c => c.name === "inbox_id")) {
      this.db.transaction(() => this.db.exec(`ALTER TABLE actions ADD COLUMN inbox_id TEXT;
        INSERT OR IGNORE INTO settings(key,value) SELECT 'legacy-send:' || id,'true' FROM inbox
        WHERE state IN ('running','interrupted') AND EXISTS (SELECT 1 FROM actions WHERE path='/send');`))();
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS actions_inbox ON actions(inbox_id)");
    for (const [name, type] of [["attempts", "INTEGER DEFAULT 0"], ["last_status", "INTEGER"], ["next_at", "INTEGER"]]) {
      if (!this.db.query<{ name: string }, []>("PRAGMA table_info(actions)").all().some(c => c.name === name)) this.db.exec(`ALTER TABLE actions ADD COLUMN ${name} ${type}`);
    }
    // A killed harness might already have used a tool. An operator reconciles it; never replay it automatically.
    this.interrupt();
  }
  now() { return (this.io.now ?? Date.now)(); }
  private interrupt(reason: "authority-expired" | "disabled" | "harness-exit" = "harness-exit", error?: unknown) {
    const row = this.db.query<{ id: string }, []>("SELECT id FROM inbox WHERE state='running' LIMIT 1").get();
    if (!row) return null;
    this.db.transaction(() => {
      // Pending/ambiguous effects also forbid replay, even if their acknowledgement never reached the box.
      const effects = this.db.query<{ sends: number; bus: number; tools: number }, [string]>(`SELECT
        COALESCE(sum(path='/send' AND state='done'),0) sends,
        COALESCE(sum(path IN ('/agent-ask','/agent-answer') AND state='done'),0) bus,
        COALESCE(sum(path NOT IN ('/metrics','/agent-requests')),0) tools FROM actions WHERE inbox_id=?`).get(row.id)!;
      const extra = this.db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key=?").get(`side-effects:${row.id}`);
      const legacy = this.db.query("SELECT 1 FROM settings WHERE key=?").get(`legacy-send:${row.id}`);
      effects.tools += Number(extra?.value ?? 0) + Number(!!legacy);
      const retry = reason === "authority-expired" && effects.tools === 0
        && !this.db.query("SELECT 1 FROM settings WHERE key=?").get(`authority-retry:${row.id}`);
      if (retry) this.db.query("INSERT INTO settings VALUES (?,'true')").run(`authority-retry:${row.id}`);
      const detail = error instanceof HarnessFailure ? error.detail : { exitCode: null, signal: null, stderrBytes: 0 };
      this.db.query("INSERT OR REPLACE INTO interruptions VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(row.id, reason, this.now(), this.lastLeaseAt, detail.exitCode, detail.signal, detail.stderrBytes, effects.sends, effects.bus, effects.tools, Number(retry));
      this.db.query("UPDATE inbox SET state=?,interrupted_at=? WHERE id=? AND state='running'").run(retry ? "pending" : "interrupted", this.now(), row.id);
      this.io.log?.("turn-interrupted", undefined, { reason, lastLeaseAt: this.lastLeaseAt, ...detail,
        sends: effects.sends, busActions: effects.bus, toolActions: effects.tools, retried: retry });
    }).immediate();
    return row?.id ?? null;
  }
  private events(after?: string, headOnly = false) {
    const rows = this.db.query<{ id: string; seq: number; state: string; failure: string | null; kind: "inbound" | "wake"; interruptedAt: number | null; watcher: string | null }, [string | null, number, number]>(`SELECT inbox.id,seq,state,inbox_errors.code AS failure,
      json_extract(payload,'$.watcher') AS watcher,
      CASE WHEN json_extract(payload,'$.kind')='wake' OR (json_extract(payload,'$.kind') IS NULL AND json_extract(payload,'$.id') LIKE 'wake:%') THEN 'wake' ELSE 'inbound' END AS kind,
      interrupted_at AS interruptedAt FROM inbox LEFT JOIN inbox_errors ON inbox.id=inbox_errors.id
      WHERE state!='done' AND seq>COALESCE((SELECT seq FROM inbox WHERE id=?),0) AND (?=0 OR state!='attachment-failed') ORDER BY seq LIMIT ?`).all(after ?? null, Number(headOnly), headOnly ? 1 : 100);
    const sent = this.db.query("SELECT 1 FROM actions WHERE path='/send' AND (inbox_id=? OR id=? OR id=?) LIMIT 1");
    // Legacy tool sends have no attribution. Conservatively flag only work interrupted at migration.
    const legacy = this.db.query("SELECT 1 FROM settings WHERE key=?");
    const events = rows.map(({ seq, watcher, ...row }) => ({ ...row,
      ...(typeof watcher === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(watcher) ? { watcher } : {}), hasSend: !!legacy.get(`legacy-send:${row.id}`)
      || !!sent.get(row.id, opaqueId(`reply:${row.id}:0`), opaqueId(`attachment-failed:${row.id}`)) }));
    const last = rows.at(-1);
    const remaining = last ? this.db.query<{ n: number }, [number]>("SELECT count(*) n FROM inbox WHERE state!='done' AND seq>?").get(last.seq)!.n : 0;
    const actions = headOnly ? [] : this.db.query<{ id: string; path: string; attempts: number; lastStatus: number | null; nextAt: number | null; inboxId: string | null }, []>(`SELECT
      substr(id,1,12) id,path,attempts,last_status lastStatus,next_at nextAt,substr(inbox_id,1,12) inboxId
      FROM actions WHERE state='pending' AND path IN ('/send','/files','/react','/agent-ask','/agent-answer','/agent-requests','/share','/unshare','/shares') ORDER BY rowid`).all();
    return { events, ...(actions.length ? { actions } : {}), ...(remaining ? { nextCursor: last!.id, remaining } : {}) };
  }
  active() { return this.now() < this.leaseUntil; }
  pause() { this.leaseUntil = 0; this.turnAbort?.abort("disabled"); }
  private async modelReady() {
    try { return !this.io.modelReady || await this.io.modelReady(); } catch { return false; }
  }
  private async callbackReady() {
    try {
      if (this.io.callbackReady) return await this.io.callbackReady();
      const response = await (this.io.fetch ?? fetch)(this.config.callbackUrl + "/ready", { method: "POST", redirect: "error",
        headers: { authorization: `Bearer ${this.config.callbackToken}`, "content-type": "application/json" },
        body: JSON.stringify({ epoch: this.config.epoch }), signal: AbortSignal.timeout(5_000) });
      const ack = await jsonBody(response as unknown as Request); return response.ok && ack.epoch === this.config.epoch;
    } catch { return false; }
  }
  enqueue(id: string, payload: unknown): boolean {
    if (!validId(id)) throw new Error("Invalid event id");
    return this.db.query("INSERT OR IGNORE INTO inbox(id,payload,state) VALUES (?,?,'pending')").run(id, JSON.stringify(payload)).changes === 1;
  }
  async action(id: string, path: string, body: Record<string, unknown>): Promise<unknown> {
    if (!validId(id) || !["/send", "/files", "/react", "/agent-ask", "/agent-answer", "/agent-requests", "/metrics"].includes(path)) throw new Error("Invalid action");
    const existing = this.db.query<{ path: string; payload: string }, [string]>("SELECT path,payload FROM actions WHERE id=?").get(id);
    const payload = JSON.stringify(body);
    if (existing && (existing.path !== path || existing.payload !== payload)) throw new Error("Action id reused");
    const running = this.db.query<{ id: string }, []>("SELECT id FROM inbox WHERE state='running' LIMIT 1").get();
    this.db.query("INSERT OR IGNORE INTO actions(id,path,payload,result,state,inbox_id) VALUES (?,?,?,NULL,'pending',?)").run(id, path, payload, running?.id ?? null);
    await this.flush();
    const result = this.db.query<{ result: string | null }, [string]>("SELECT result FROM actions WHERE id=?").get(id)?.result;
    return result ? JSON.parse(result) : { id, pending: true };
  }
  async flush(): Promise<void> {
    if (!this.active() || this.flushing) return;
    this.flushing = true;
    try {
    const rows = this.db.query<{ id: string; path: string; payload: string; inbox_id: string | null; attempts: number; next_at: number | null }, []>("SELECT * FROM actions WHERE state='pending' ORDER BY rowid").all();
    for (const row of rows) {
      if (!this.active()) return;
      const nonessential = row.path === "/react" || row.path === "/metrics";
      if (nonessential && row.next_at !== null && row.next_at > this.now()) continue;
      let status: number | null = null;
      try {
      const payload = JSON.parse(row.payload);
      const response = await (this.io.fetch ?? fetch)(this.config.callbackUrl + row.path, { method: "POST", redirect: "error",
        headers: { authorization: `Bearer ${this.config.callbackToken}`, "content-type": "application/json" },
        body: JSON.stringify({ ...payload, operationId: row.id, ...(row.path === "/send" ? { id: row.id, ...(row.inbox_id ? { inboxId: row.inbox_id } : {}) } : {}), epoch: this.config.epoch }), signal: AbortSignal.timeout(15_000) });
      status = response.status;
      if (!response.ok) {
        if (([400, 403, 404, 413, 422].includes(response.status) || response.status === 409 && row.path !== "/send") && row.path !== "/metrics") {
          this.db.query("UPDATE actions SET state='failed',result=? WHERE id=?").run(JSON.stringify({ error: "Action refused", status: response.status }), row.id); continue;
        }
        if (row.path === "/metrics") { this.db.query("UPDATE actions SET state='done' WHERE id=?").run(row.id); continue; }
        throw new Error("Callback unavailable");
      }
      const result = await jsonBody(response as unknown as Request);
      this.db.query("UPDATE actions SET result=?,state='done' WHERE id=?").run(JSON.stringify(result), row.id);
      } catch (error) {
        if (row.path === "/metrics") { this.db.query("UPDATE actions SET state='done' WHERE id=?").run(row.id); continue; }
        if (!nonessential) throw error;
        const attempts = row.attempts + 1;
        this.db.query("UPDATE actions SET attempts=?,last_status=?,next_at=?,state=?,result=? WHERE id=?")
          .run(attempts, status, this.now() + [5_000, 30_000, 120_000][Math.min(attempts - 1, 2)]!, attempts >= 3 ? "failed" : "pending",
            attempts >= 3 ? JSON.stringify({ error: "Nonessential action gave up", status, attempts }) : null, row.id);
      }
    }
    } finally { this.flushing = false; }
  }
  async tick(): Promise<void> {
    if (!this.active()) { this.turnAbort?.abort("authority-expired"); return; }
    if (this.working) return;
    this.working = true;
    const started = this.now();
    try {
      await this.flush();
      const row = this.db.query<{ id: string; payload: string; state: string }, []>("SELECT * FROM inbox WHERE state NOT IN ('done','attachment-failed') ORDER BY seq LIMIT 1").get();
      if (!row || row.state !== "pending") return;
      if (this.harness.ready && !this.harness.ready()) return;
      const input = JSON.parse(row.payload);
      let text: string;
      try { text = await this.prepare(input); }
      catch (error) {
        if (error instanceof AttachmentFailure) {
          this.db.transaction(() => {
            this.db.query("UPDATE inbox SET state='attachment-failed' WHERE id=?").run(row.id);
            this.db.query("INSERT OR REPLACE INTO inbox_errors VALUES (?,?)").run(row.id, error.code);
            this.db.query("INSERT OR IGNORE INTO actions(id,path,payload,result,state,inbox_id) VALUES (?,'/send',?,NULL,'pending',?)").run(opaqueId(`attachment-failed:${row.id}`), JSON.stringify({ text: "I couldn’t read an attachment. Please send it again." }), row.id);
            this.db.query("INSERT OR IGNORE INTO actions(id,path,payload,result,state,inbox_id) VALUES (?,'/metrics',?,NULL,'pending',?)").run(opaqueId(`attachment-error:${row.id}`), JSON.stringify({ durationMs: Math.max(0, this.now() - started), status: "error" }), row.id);
          })();
          this.io.log?.(`attachment-${error.code}`);
          await this.flush();
        } else this.io.log?.("attachment-error");
        return;
      }
      if (!this.active()) return;
      const [modelReady, callbackReady] = await Promise.all([this.modelReady(), this.callbackReady()]);
      if (!modelReady || !callbackReady || !this.active()) return;
      if (this.harness.ready && !this.harness.ready()) return;
      this.db.query("UPDATE inbox SET state='running' WHERE id=?").run(row.id);
      const session = this.db.query<{ value: string }, []>("SELECT value FROM settings WHERE key='session'").get()!.value;
      const resume = !!this.db.query("SELECT 1 FROM settings WHERE key='started'").get();
      this.db.exec("INSERT OR IGNORE INTO settings VALUES ('started','true')");
      this.turnAbort = new AbortController();
      const output = await this.harness.run({ id: row.id, session, resume, text, system: this.config.system, signal: this.turnAbort.signal });
      // A harness that races its abort must not commit a result after losing authority.
      if (!this.active()) this.turnAbort.abort("authority-expired");
      this.turnAbort.signal.throwIfAborted();
      const reply = output.trim();
      this.db.transaction(() => {
        if (reply && reply !== "NO_REPLY" && !reply.endsWith("\nNO_REPLY")) {
          const points = Array.from(reply);
          for (let start = 0; start < points.length; start += 6000) {
            this.db.query("INSERT OR IGNORE INTO actions(id,path,payload,result,state,inbox_id) VALUES (?,'/send',?,NULL,'pending',?)").run(opaqueId(`reply:${row.id}:${start}`), JSON.stringify({ text: points.slice(start, start + 6000).join("") }), row.id);
          }
        }
        this.db.query("UPDATE inbox SET state='done' WHERE id=?").run(row.id);
        this.db.query("INSERT OR IGNORE INTO actions(id,path,payload,result,state,inbox_id) VALUES (?,'/metrics',?,NULL,'pending',?)").run(opaqueId(`metric:${row.id}`), JSON.stringify({ durationMs: Math.max(0, this.now() - (typeof input.receivedAt === "number" ? input.receivedAt : started)) }), row.id);
      })();
      await this.flush();
      this.io.log?.("turn-done", this.now() - started);
    } catch (error) {
      const reason = this.turnAbort?.signal.reason;
      const inboxId = this.interrupt(reason === "disabled" || reason === "authority-expired" ? reason : "harness-exit", error);
      this.db.query("INSERT OR IGNORE INTO actions(id,path,payload,result,state,inbox_id) VALUES (?,'/metrics',?,NULL,'pending',?)").run(opaqueId(`error:${started}`), JSON.stringify({ durationMs: Math.max(0, this.now() - started), status: "error" }), inboxId);
      try { await this.flush(); } catch { /* Keep metadata queued on the box until its bridge is back. */ }
      this.io.log?.("runner-error", this.now() - started);
    } finally { this.turnAbort = undefined; this.working = false; }
  }
  private async prepare(input: Record<string, unknown>): Promise<string> {
    let text = typeof input.text === "string" ? input.text : "";
    const references = ["id", "replyTo", "threadOrigin"].filter(key => typeof input[key] === "string")
      .map(key => `${key}: ${String(input[key])}`).join("\n");
    if (references) text = `${references}\n${text}`;
    if (typeof input.replyTo === "string") {
      const quoted = this.db.query<{ payload: string }, [string]>("SELECT payload FROM inbox WHERE json_extract(payload,'$.id')=? ORDER BY seq DESC LIMIT 1").get(input.replyTo)
        ?? this.db.query<{ payload: string }, [string]>("SELECT payload FROM actions WHERE json_extract(result,'$.handle')=? ORDER BY rowid DESC LIMIT 1").get(input.replyTo);
      if (quoted) { const previous = JSON.parse(quoted.payload); if (typeof previous.text === "string") text += `\n[Quoted reply context]\n${previous.text.slice(0, 12000)}`; }
    }

    if (Array.isArray(input.attachments)) for (const file of input.attachments) {
      if (!object(file) || typeof file.guid !== "string" || (!file.guid.startsWith("https://") || !URL.canParse(file.guid))) throw new AttachmentFailure("invalid");
      const response = await (this.io.fetch ?? fetch)(file.guid, { redirect: "error", signal: AbortSignal.timeout(60_000) });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (response.status >= 400 && response.status < 500 && ![408, 425, 429].includes(response.status)) throw new AttachmentFailure(response.status === 413 ? "too-large" : "unavailable");
        throw new Error("Attachment unavailable");
      }
      if (Number(response.headers.get("content-length")) > MAX_ATTACHMENT_BYTES) { await response.body?.cancel().catch(() => {}); throw new AttachmentFailure("too-large"); }
      const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
      try { if (reader) for (;;) { const { value, done } = await reader.read(); if (done) break;
        bytes += value.length; if (bytes > MAX_ATTACHMENT_BYTES) throw new AttachmentFailure("too-large"); chunks.push(value); }
      } finally { await reader?.cancel().catch(() => {}); }
      const name = typeof file.fileName === "string" ? file.fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100) : "file";
      const dir = join(this.config.root, "files"); mkdirSync(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, `${opaqueId(file.guid)}-${name}`); writeFileSync(path, Buffer.concat(chunks), { mode: 0o600 });
      text += `\nAttachment: ${path}`;
    }
    return text;
  }
  handle = async (request: Request): Promise<Response> => {
    const reply = (status: number, body: unknown) => Response.json(body, { status });
    if (!tokenMatches(request.headers.get("authorization"), this.config.token) || request.method !== "POST") return reply(403, { error: "Forbidden" });
    try {
      const body = await jsonBody(request); const path = new URL(request.url).pathname;
      if (path === "/lease") {
        if (body.epoch !== this.config.epoch || body.boxId !== this.config.boxId) return reply(409, { error: "Identity mismatch" });
        // Authority is renewed before dependency probes; model latency never revokes a running turn.
        this.lastLeaseAt = this.now();
        this.leaseUntil = this.now() + 20_000;
        this.db.query("INSERT OR REPLACE INTO settings VALUES ('last-lease-at',?)").run(String(this.lastLeaseAt));
        const [routerReady, callbackReady] = await Promise.all([this.modelReady(), this.callbackReady()]);
        return reply(200, { boxId: this.config.boxId, epoch: this.config.epoch, routerReady, callbackReady });
      }
      if (path === "/pause") { this.pause(); return reply(200, { paused: true }); }
      if (!this.active()) return reply(503, { error: "Runner paused" });
      if (path === "/deliver") {
        if (!validId(body.id) || body.epoch !== this.config.epoch || !object(body.sealed)) return reply(400, { error: "Invalid envelope" });
        this.enqueue(body.id, unseal(this.config.privateKey, body.sealed as Sealed));
        return reply(200, { id: body.id, accepted: true });
      }
      if (path === "/events") {
        if (body.ids !== undefined) {
          if (!Array.isArray(body.ids) || body.ids.length > 100 || !body.ids.every(validId) || body.after !== undefined || body.headOnly !== undefined) return reply(400, { error: "Invalid event lookup" });
          const events = this.db.query<{ id: string; state: string; hasReply: number }, [string]>(`SELECT id,state,
            EXISTS(SELECT 1 FROM actions WHERE actions.inbox_id=inbox.id AND path='/send' AND actions.state='done') AS hasReply
            FROM inbox WHERE id IN (SELECT value FROM json_each(?)) ORDER BY seq`).all(JSON.stringify(body.ids))
            .map(row => ({ ...row, hasReply: !!row.hasReply }));
          return reply(200, { lookup: true, events });
        }
        if (body.after !== undefined && !validId(body.after) || body.headOnly !== undefined && typeof body.headOnly !== "boolean") return reply(400, { error: "Invalid event query" });
        return reply(200, this.events(body.after as string | undefined, body.headOnly === true));
      }
      if (path === "/resolve") {
        if (!validId(body.id) || body.reconciled !== true || !["done", "pending"].includes(String(body.state))) return reply(400, { error: "Reconcile the failed event first" });
        if (body.autoFailMs !== undefined && (!Number.isSafeInteger(body.autoFailMs) || Number(body.autoFailMs) < 0 || body.state !== "done")) return reply(400, { error: "Invalid auto-fail guard" });
        const id = body.id;
        const accepted = this.db.transaction(() => {
          const state = this.db.query<{ state: string }, [string]>("SELECT state FROM inbox WHERE id=?").get(id)?.state;
          if (state !== "interrupted" && state !== "attachment-failed" && state !== body.state) return false;
          if (body.autoFailMs !== undefined) {
            // A done row alone cannot prove this request won a race with an operator's resumed turn.
            if (state === "done") return !!this.db.query("SELECT 1 FROM settings WHERE key=?").get(`wake-autofailed:${id}`);
            const head = this.events(undefined, true).events[0];
            let page = this.events(id);
            while (!page.events.some(row => row.kind === "inbound") && page.nextCursor) page = this.events(page.nextCursor);
            if (head?.id !== id || head.state !== "interrupted" || head.kind !== "wake" || head.hasSend
              || head.interruptedAt === null || this.now() - head.interruptedAt < Number(body.autoFailMs)
              || !page.events.some(row => row.kind === "inbound")) return false;
            this.db.query("INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)").run(`wake-autofailed:${id}`, String(this.now()));
          }
          this.db.query("UPDATE inbox SET state=? WHERE id=? AND state IN ('interrupted','attachment-failed')").run(String(body.state), id);
          this.db.query("DELETE FROM inbox_errors WHERE id=?").run(id);
          return true;
        }).immediate();
        if (!accepted) return reply(409, { error: "Event cannot be resolved" });
        return reply(200, { accepted: true });
      }
      if (path === "/watch" && this.watch) { await this.watch(body); return reply(200, { accepted: true }); }
      if (path === "/action") return reply(200, { result: await this.action(String(body.id), String(body.path), object(body.body) ? body.body : {}) });
      if (["/share", "/unshare", "/shares"].includes(path) && this.io.share) {
        if (path !== "/shares") this.db.query(`INSERT INTO settings(key,value) SELECT 'side-effects:' || id,'1' FROM inbox WHERE state='running'
          ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1`).run();
        return reply(200, await this.io.share(path, body));
      }
      return reply(404, { error: "Not found" });
    } catch { this.io.log?.("request-error"); return reply(400, { error: "Operation failed" }); }
  };
}
