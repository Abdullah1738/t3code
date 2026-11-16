import { createPublicKey, createHmac } from "node:crypto";
import { toolLog } from "./toollog.ts";
import { readFileSync } from "node:fs";
import { Store } from "./store.ts";
import { jsonBody, opaqueId, seal, tokenMatches, validId, type Fetch, type Sealed } from "./remote-protocol.ts";
import type { AgentAnswerReceipt } from "./agent-bus.ts";
import { LineError, type ChatKey, type Line } from "./line.ts";

export type RemoteBoxConfig = { kind: "remote-box"; url: string; tokenFile: string; callbackTokenFile: string;
  publicKeyFile: string; boxRouterPort?: number; macRouterPort?: number; callbackPort: number; epoch: string; boxId: string;
  noticeAfterMs?: number; outageClearMs?: number; noticeMinGapMs?: number };
type Outage = { id: string; unreachableSince: number | null; reachableSince: number | null; noticeAttempted?: boolean };
type Fence = { id: string; since: number; queuedBehind: number };
type BoxEvent = { id: string; state: string; failure: string | null; kind: "inbound" | "wake"; interruptedAt: number | null; hasSend: boolean };
export class RemoteRequestError extends Error {
  constructor(readonly status: number) { super("Box request failed"); }
}
export function remoteBoxConfig(config: { chatBackends?: unknown }, slug: string): RemoteBoxConfig | undefined {
  const entries = config.chatBackends as Record<string, unknown> | undefined;
  const entry = entries?.[slug] as RemoteBoxConfig | undefined;
  if (entry === undefined || entry.kind === ("robob" as string)) return;
  if (slug !== "moni" || entry.kind !== "remote-box" || !/^http:\/\/127\.0\.0\.1:\d+$/.test(entry.url)
    || ![entry.tokenFile, entry.callbackTokenFile, entry.publicKeyFile].every(p => typeof p === "string" && p.startsWith("/"))
    || [entry.boxRouterPort, entry.macRouterPort].some(p => p !== undefined && (!Number.isInteger(p) || p < 1024 || p > 65535))
    || [entry.noticeAfterMs, entry.outageClearMs, entry.noticeMinGapMs].some(ms => ms !== undefined && (!Number.isSafeInteger(ms) || ms < 0))
    || !Number.isInteger(entry.callbackPort) || entry.callbackPort < 1024 || entry.callbackPort > 65535
    || !/^[a-zA-Z0-9_-]{1,64}$/.test(entry.epoch) || !/^bx_[a-zA-Z0-9]+$/.test(entry.boxId)) throw new Error("Invalid remote box configuration");
  return entry;
}

class RemoteSendError extends Error {
  constructor(readonly status: number) { super("Send requires recovery"); }
}

export class RemoteBox {
  readonly sessionId: string;
  private readonly publicKey: string;
  private readonly token: string;
  private readonly callbackToken: string;
  private busy = false;
  private nextProbe = 0;
  private failures = 0;
  constructor(readonly config: RemoteBoxConfig, readonly store: Store, private readonly io: {
    fetch?: Fetch; now?: () => number; log: (event: string, code?: string) => void;
    notice: (id: string, text: string) => Promise<void>; active: () => boolean;
    ownerAlert?: (severity: "attention", text: string, key: string) => Promise<boolean>;
  }) {
    this.sessionId = `remote:moni:${config.epoch}`;
    this.publicKey = readFileSync(config.publicKeyFile, "utf8");
    if (createPublicKey(this.publicKey).asymmetricKeyType !== "rsa") throw new Error("RSA box key required");
    this.token = readFileSync(config.tokenFile, "utf8").trim();
    this.callbackToken = readFileSync(config.callbackTokenFile, "utf8").trim();
    if (this.token.length < 32 || this.callbackToken.length < 32) throw new Error("Invalid remote credentials");
    store.db.exec(`CREATE TABLE IF NOT EXISTS remote_inbox (seq INTEGER PRIMARY KEY, id TEXT UNIQUE, sealed TEXT, receipt TEXT);
      CREATE TABLE IF NOT EXISTS remote_sends (id TEXT PRIMARY KEY, at INTEGER, state TEXT, handle TEXT);`);
    if (!store.db.query<{ name: string }, []>("PRAGMA table_info(remote_inbox)").all().some(c => c.name === "kind")) {
      // Old ciphertext cannot be classified on the relay. Unknown rows never cause a notice.
      store.db.exec("ALTER TABLE remote_inbox ADD COLUMN kind TEXT NOT NULL DEFAULT 'unknown'");
    }
    if (store.get("remoteNoticeAt") === undefined) {
      // Older sends have no kind. Conservatively count the newest send during the upgrade.
      const at = store.db.query<{ at: number | null }, []>("SELECT max(at) at FROM remote_sends").get()?.at;
      if (at !== null && at !== undefined) store.set("remoteNoticeAt", at);
    }
    const outage = store.get<Outage | null>("remoteOutage");
    if (outage) {
      // Neither continuous downtime nor recovery can include time the bridge was stopped.
      outage.unreachableSince = null; outage.reachableSince = null; store.set("remoteOutage", outage);
    }
  }
  private emit(event: string, code?: string, durationMs?: number, props?: Record<string, string | number | boolean>) {
    this.io.log(event, props ? JSON.stringify(props) : code);
    toolLog.capture(() => toolLog.write({ component: "remote-box", kind: durationMs === undefined ? "event" : "perf",
      name: event, ids: { chat: "moni" }, ...(durationMs === undefined ? {} : { durationMs }),
      ...(props ? { props } : code?.startsWith("n=") ? { props: { count: Number(code.slice(2)) } }
        : event === "moni-notice-suppressed" && code ? { props: { reason: code } } : {}) }));
  }
  private now() { return (this.io.now ?? Date.now)(); }
  accept(id: string, input: unknown, receipt?: AgentAnswerReceipt, kind: "inbound" | "wake" = "inbound"): boolean {
    const key = opaqueId(id);
    return this.store.db.query("INSERT OR IGNORE INTO remote_inbox(id,sealed,receipt,kind) VALUES (?,?,?,?)")
      .run(key, JSON.stringify(seal(this.publicKey, typeof input === "object" && input !== null ? { ...input, kind } : input)), receipt ? JSON.stringify(receipt) : null, kind).changes === 1;
  }
  receipt(id: string): AgentAnswerReceipt | undefined {
    const row = this.store.db.query<{ receipt: string | null }, [string]>("SELECT receipt FROM remote_inbox WHERE id=?").get(opaqueId(id));
    return row?.receipt ? JSON.parse(row.receipt) : undefined;
  }
  hasMessage(id: string): boolean {
    return !!this.store.db.query("SELECT 1 FROM remote_inbox WHERE id=?").get(opaqueId(id));
  }
  async request(path: string, body: unknown): Promise<Record<string, unknown>> {
    const response = await (this.io.fetch ?? fetch)(this.config.url + path, { method: "POST", redirect: "error",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(path === "/lease" ? 12_000 : 10_000) });
    if (!response.ok) throw new RemoteRequestError(response.status);
    return jsonBody(response as unknown as Request);
  }
  async events(after?: string, headOnly = false): Promise<{ events: BoxEvent[]; nextCursor?: string; remaining?: number }> {
    const response = await this.request("/events", { ...(after ? { after } : {}), ...(headOnly ? { headOnly: true } : {}) });
    if (!Array.isArray(response.events)) throw new Error("Invalid box events");
    if (response.remaining !== undefined && (!Number.isSafeInteger(response.remaining) || Number(response.remaining) < 1 || !validId(response.nextCursor))) throw new Error("Invalid event cursor");
    const events = response.events.map((row: unknown): BoxEvent => {
      if (typeof row !== "object" || row === null || !("id" in row) || !validId(row.id)
        || !("state" in row) || !["pending", "running", "interrupted", "attachment-failed"].includes(String(row.state))
        || !("kind" in row) || !["inbound", "wake"].includes(String(row.kind))
        || !("interruptedAt" in row) || row.interruptedAt !== null && (!Number.isSafeInteger(row.interruptedAt) || Number(row.interruptedAt) < 0)
        || !("hasSend" in row) || typeof row.hasSend !== "boolean") throw new Error("Invalid box event");
      return { id: row.id, state: row.state as string, kind: row.kind as BoxEvent["kind"], interruptedAt: row.interruptedAt as number | null,
        hasSend: row.hasSend, failure: "failure" in row && ["invalid", "unavailable", "too-large"].includes(String(row.failure)) ? String(row.failure) : null };
    });
    return { events, ...(response.remaining === undefined ? {} : { remaining: response.remaining as number, nextCursor: response.nextCursor as string }) };
  }
  async resolve(id: string, state: "done" | "pending") {
    const result = await this.request("/resolve", { id, state, reconciled: true });
    if (result.accepted !== true) throw new Error("Invalid box acknowledgement");
    return { accepted: true };
  }
  private async probeFence() {
    // An interrupted turn may have used a tool. Surface the fence; only an owner reconciles it.
    // Probe failures are observational and must never enter the link-outage notice path.
    let events: BoxEvent[], remaining: number | undefined;
    try { ({ events, remaining } = await this.events(undefined, true)); } catch { this.emit("moni-box-events-error"); return; }
    const saved = this.store.get<Fence | null>("remoteFence");
    const head = events.find(row => row.state !== "attachment-failed");
    if (saved && (head?.state !== "interrupted" || head.id !== saved.id)) {
      this.store.set("remoteFence", null);
      this.emit("moni-box-unfenced", undefined, undefined, { event: saved.id.slice(0, 12), fencedMs: Math.max(0, this.now() - saved.since) });
    }
    if (head?.state !== "interrupted") return;
    const queuedBehind = remaining ?? 0;
    const fence = saved?.id === head.id ? saved : { id: head.id, since: head.interruptedAt ?? this.now(), queuedBehind: -1 };
    const ageMs = Math.max(0, this.now() - fence.since), event = head.id.slice(0, 12);
    if (queuedBehind > fence.queuedBehind) {
      fence.queuedBehind = queuedBehind;
      this.store.set("remoteFence", fence);
      this.emit("moni-box-fenced", undefined, undefined, { event, kind: head.kind, ageMs, hasSend: head.hasSend, queuedBehind });
    }
    const key = `moni-box-fenced:${event}`;
    if (this.io.ownerAlert && !this.store.get<boolean>(`remoteFenceAlert:${head.id}`)) {
      // Reserve before notifying: a lost response or restart must not send a second alert.
      this.store.set(`remoteFenceAlert:${head.id}`, true);
      const age = ageMs < 60_000 ? `${Math.floor(ageMs / 1000)}s` : `${Math.floor(ageMs / 60_000)}m`;
      try {
        const sent = await this.io.ownerAlert("attention", `Moni's box agent is stuck on one interrupted ${head.kind} (${age}); ${queuedBehind} later messages waiting. Resolve: spectrum-bridge remote-resolve --chat moni --id ${head.id} --state done|pending --session <owner-session>`, key);
        if (!sent) this.emit("moni-box-fence-alert-error");
      } catch { this.emit("moni-box-fence-alert-error"); }
    }
  }
  async tick(): Promise<void> {
    if (this.busy || this.now() < this.nextProbe || !this.io.active()) return;
    this.busy = true;
    try {
      const status = await this.request("/lease", { epoch: this.config.epoch, boxId: this.config.boxId });
      if (status.boxId !== this.config.boxId || status.epoch !== this.config.epoch) throw new Error("Box identity mismatch");
      this.failures = 0;
      const rows = this.store.db.query<{ id: string; seq: number; sealed: string }, []>("SELECT id,seq,sealed FROM remote_inbox WHERE sealed IS NOT NULL ORDER BY seq LIMIT 50").all();
      let delivered = 0;
      for (const row of rows) {
        const ack = await this.request("/deliver", { id: row.id, sealed: JSON.parse(row.sealed) as Sealed, epoch: this.config.epoch });
        if (ack.id !== row.id || ack.accepted !== true) throw new Error("Invalid box acknowledgement");
        this.store.db.query("UPDATE remote_inbox SET sealed=NULL WHERE id=?").run(row.id);
        delivered++;
      }
      const outage = this.store.get<Outage | null>("remoteOutage");
      if (outage) {
        outage.unreachableSince = null;
        outage.reachableSince ??= this.now();
        if (this.now() - outage.reachableSince >= (this.config.outageClearMs ?? 300_000)) {
          this.emit("moni-box-up"); this.store.set("remoteOutage", null);
        } else this.store.set("remoteOutage", outage);
      }
      if (delivered) this.emit("moni-queue-delivered", `n=${delivered}`);
      this.emit("moni-queue-depth", `n=${this.store.db.query<{ n: number }, []>("SELECT count(*) n FROM remote_inbox WHERE sealed IS NOT NULL").get()!.n}`);
      await this.probeFence();
      this.nextProbe = this.now() + 5_000;
    } catch {
      const saved = this.store.get<Outage | null>("remoteOutage");
      const outage: Outage = saved ?? { id: opaqueId(String(this.now())), unreachableSince: this.now(), reachableSince: null };
      outage.unreachableSince ??= this.now(); outage.reachableSince = null;
      this.store.set("remoteOutage", outage);
      if (!saved) this.emit("moni-box-down");
      const lastNotice = this.store.get<number | null>("remoteNoticeAt");
      const reason = this.now() - outage.unreachableSince < (this.config.noticeAfterMs ?? 120_000) ? "grace"
        : !this.store.db.query("SELECT 1 FROM remote_inbox WHERE sealed IS NOT NULL AND kind='inbound' LIMIT 1").get() ? "not-waiting"
        : outage.noticeAttempted ? "already-sent"
        : lastNotice !== undefined && lastNotice !== null && this.now() - lastNotice < (this.config.noticeMinGapMs ?? 21_600_000) ? "rate-limited" : undefined;
      if (reason) this.emit("moni-notice-suppressed", reason);
      else {
        // Reserve before the side effect: an ambiguous send or process exit must not reset the cap.
        this.store.db.transaction(() => {
          this.store.set("remoteNoticeAt", this.now()); outage.noticeAttempted = true; this.store.set("remoteOutage", outage);
        })();
        try { await this.io.notice(outage.id, "I’m temporarily offline. I’ll reply when I’m back."); } catch { this.emit("moni-notice-error"); }
      }
      this.nextProbe = this.now() + Math.min(60_000, 1_000 * 2 ** Math.min(++this.failures, 6));
      this.emit("moni-runner-error", "unreachable");
    } finally { this.busy = false; }
  }
  async send(id: string, text: string, mediaUrl: string | undefined, line: Line, chat: ChatKey): Promise<{ id: string; handle: string }> {
    const row = this.store.db.query<{ at: number; state: string; handle: string }, [string]>("SELECT * FROM remote_sends WHERE id=?").get(id);
    if (row?.state === "sent") return { id, handle: row.handle };
    if (row?.state === "failed") throw new RemoteSendError(422);
    if (row?.state === "uncertain") {
      const sent = (await line.outbound(chat, row.at - 5_000)).find(m => m.text === text && m.mediaUrl === mediaUrl && m.sentAt >= row.at
        && !/^(?:error|declined|failed)$/i.test(m.status)
        && !this.store.db.query("SELECT 1 FROM remote_sends WHERE handle=? AND id!=?").get(m.handle, id));
      if (!sent) throw new RemoteSendError(409);
      this.store.db.query("UPDATE remote_sends SET state='sent',handle=? WHERE id=?").run(sent.handle, id);
      return { id, handle: sent.handle };
    }
    this.store.db.query("INSERT INTO remote_sends VALUES (?,?,'uncertain',NULL) ON CONFLICT(id) DO UPDATE SET at=excluded.at,state='uncertain'").run(id, this.now());
    try {
      const sent = await line.sendText(chat, text, mediaUrl ? { mediaUrl } : undefined);
      this.store.db.query("UPDATE remote_sends SET state='sent',handle=? WHERE id=?").run(sent.handle, id);
      this.emit("moni-reply-sent"); return { id, handle: sent.handle };
    } catch (error) {
      if (error instanceof LineError && !error.uncertain) {
        this.store.db.query("UPDATE remote_sends SET state=? WHERE id=?").run(error.retryable ? "unsent" : "failed", id);
        if (!error.retryable) throw new RemoteSendError(422);
      }
      throw error;
    }
  }
  async callback(request: Request, io: { line: Line; chat: ChatKey; bus: (path: string, body: Record<string, unknown>, id: string, fingerprint: string) => Promise<Response> }): Promise<Response> {
    const reply = (status: number, body: unknown) => Response.json(body, { status });
    // This entry is used by a dedicated loopback listener, never by the trusted Unix socket.
    if (!tokenMatches(request.headers.get("authorization"), this.callbackToken)) return reply(403, { error: "Forbidden" });
    if (!this.io.active()) return reply(503, { error: "Backend paused" });
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || !["/send", "/files", "/react", "/agent-ask", "/agent-answer", "/agent-requests", "/share", "/unshare", "/shares", "/ready", "/metrics"].includes(path)) return reply(403, { error: "Forbidden" });
    try {
      const body = await jsonBody(request);
      if (body.epoch !== this.config.epoch || (!path.startsWith("/agent-") && body.to !== undefined) || body.chat !== undefined || body.sessionId !== undefined) return reply(403, { error: "Forbidden" });
      delete body.epoch;
      const operation = body.operationId; delete body.operationId;
      if (path === "/metrics") {
        if (typeof body.durationMs !== "number" || !Number.isFinite(body.durationMs) || body.durationMs < 0) return reply(400, { error: "Invalid metrics" });
        if (body.status === "error") this.emit("moni-runner-error", "harness");
        this.emit("moni-turn-latency", undefined, body.durationMs); return reply(200, { accepted: true });
      }
      if (path === "/ready") return reply(200, { epoch: this.config.epoch });
      if (path.startsWith("/agent-")) {
        if (!validId(operation)) return reply(400, { error: "Operation id required" });
        return io.bus(path, { ...body, sessionId: this.sessionId }, opaqueId(`moni:${operation}`),
          createHmac("sha256", this.callbackToken).update(JSON.stringify([path, body])).digest("hex"));
      }
      if (["/share", "/unshare", "/shares"].includes(path)) return reply(200, await this.request(path, body));
      if (path === "/react") {
        if (typeof body.target !== "string" || !this.hasMessage(body.target) || typeof body.kind !== "string" || !["like", "love", "dislike", "laugh", "emphasize", "question"].includes(body.kind)) return reply(403, { error: "Forbidden" });
        await io.line.react(body.target, body.kind); return reply(200, { accepted: true });
      }
      if (path === "/files") {
        if (typeof body.data !== "string" || body.data.length > 28_000_000 || typeof body.name !== "string" || typeof body.mime !== "string") return reply(400, { error: "Invalid file" });
        return reply(200, { mediaUrl: await io.line.upload({ data: Buffer.from(body.data, "base64"), name: body.name, mimeType: body.mime }) });
      }
      if (!validId(body.id) || typeof body.text !== "string" || body.text.length > 12_000 || (body.mediaUrl !== undefined && (typeof body.mediaUrl !== "string" || !body.mediaUrl.startsWith("https://")))) return reply(400, { error: "Invalid send" });
      return reply(200, await this.send(body.id, body.text, typeof body.mediaUrl === "string" ? body.mediaUrl : undefined, io.line, io.chat));
    } catch (error) { this.emit("moni-runner-error", "callback"); return reply(error instanceof RemoteSendError ? error.status : 502, { error: "Operation failed" }); }
  }
}
