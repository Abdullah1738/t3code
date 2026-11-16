import { createPublicKey, createHmac } from "node:crypto";
import { toolLog } from "./toollog.ts";
import { readFileSync } from "node:fs";
import { Store } from "./store.ts";
import { jsonBody, opaqueId, seal, tokenMatches, validId, type Fetch, type Sealed } from "./remote-protocol.ts";
import type { AgentAnswerReceipt } from "./agent-bus.ts";
import { LineError, type ChatKey, type Line } from "./line.ts";

export type RemoteBoxConfig = { kind: "remote-box"; url: string; tokenFile: string; callbackTokenFile: string;
  publicKeyFile: string; boxRouterPort?: number; macRouterPort?: number; callbackPort: number; epoch: string; boxId: string };
export function remoteBoxConfig(config: { chatBackends?: unknown }, slug: string): RemoteBoxConfig | undefined {
  const entries = config.chatBackends as Record<string, unknown> | undefined;
  const entry = entries?.[slug] as RemoteBoxConfig | undefined;
  if (entry === undefined || entry.kind === ("robob" as string)) return;
  if (slug !== "moni" || entry.kind !== "remote-box" || !/^http:\/\/127\.0\.0\.1:\d+$/.test(entry.url)
    || ![entry.tokenFile, entry.callbackTokenFile, entry.publicKeyFile].every(p => typeof p === "string" && p.startsWith("/"))
    || [entry.boxRouterPort, entry.macRouterPort].some(p => p !== undefined && (!Number.isInteger(p) || p < 1024 || p > 65535))
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
  }) {
    this.sessionId = `remote:moni:${config.epoch}`;
    this.publicKey = readFileSync(config.publicKeyFile, "utf8");
    if (createPublicKey(this.publicKey).asymmetricKeyType !== "rsa") throw new Error("RSA box key required");
    this.token = readFileSync(config.tokenFile, "utf8").trim();
    this.callbackToken = readFileSync(config.callbackTokenFile, "utf8").trim();
    if (this.token.length < 32 || this.callbackToken.length < 32) throw new Error("Invalid remote credentials");
    store.db.exec(`CREATE TABLE IF NOT EXISTS remote_inbox (seq INTEGER PRIMARY KEY, id TEXT UNIQUE, sealed TEXT, receipt TEXT);
      CREATE TABLE IF NOT EXISTS remote_sends (id TEXT PRIMARY KEY, at INTEGER, state TEXT, handle TEXT);`);
  }
  private emit(event: string, code?: string, durationMs?: number) {
    this.io.log(event, code);
    toolLog.capture(() => toolLog.write({ component: "remote-box", kind: durationMs === undefined ? "event" : "perf",
      name: event, ids: { chat: "moni" }, ...(durationMs === undefined ? {} : { durationMs }),
      ...(code?.startsWith("n=") ? { props: { count: Number(code.slice(2)) } } : {}) }));
  }
  private now() { return (this.io.now ?? Date.now)(); }
  accept(id: string, input: unknown, receipt?: AgentAnswerReceipt): boolean {
    const key = opaqueId(id);
    return this.store.db.query("INSERT OR IGNORE INTO remote_inbox(id,sealed,receipt) VALUES (?,?,?)")
      .run(key, JSON.stringify(seal(this.publicKey, input)), receipt ? JSON.stringify(receipt) : null).changes === 1;
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
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("Box request failed");
    return jsonBody(response as unknown as Request);
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
      if (this.store.get("remoteOutage")) { this.emit("moni-box-up"); this.store.set("remoteOutage", null); }
      if (delivered) this.emit("moni-queue-delivered", `n=${delivered}`);
      this.emit("moni-queue-depth", `n=${this.store.db.query<{ n: number }, []>("SELECT count(*) n FROM remote_inbox WHERE sealed IS NOT NULL").get()!.n}`);
      this.nextProbe = this.now() + 5_000;
    } catch {
      const outage = this.store.get<{ id: string } | null>("remoteOutage") ?? { id: opaqueId(String(this.now())) };
      if (!this.store.get("remoteOutage")) { this.store.set("remoteOutage", outage); this.emit("moni-box-down"); }
      try { await this.io.notice(outage.id, "I’m temporarily offline. I’ll reply when I’m back."); } catch { this.emit("moni-notice-error"); }
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
