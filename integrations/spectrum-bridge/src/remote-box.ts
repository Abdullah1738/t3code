import { enqueueOperationalNotice, flushOperationalNotices, operationalKey } from "./operational-notice.ts";
import { socketPost } from "./telegram-fallback.ts";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { createPublicKey, createHmac } from "node:crypto";
import { toolLog } from "./toollog.ts";
import { traceLoopOperation } from "./loop-stall.ts";
import { readFileSync } from "node:fs";
import { Store } from "./store.ts";
import { jsonBody, opaqueId, seal, tokenMatches, validId, type Fetch, type Sealed } from "./remote-protocol.ts";
import type { AgentAnswerReceipt } from "./agent-bus.ts";
import { LineError, safeLineFailureCode, type ChatKey, type Line } from "./line.ts";
import { RemoteUnanswered } from "./unanswered.ts";
import type { ChatMirror } from "./mirror.ts";

export type RemoteBoxConfig = { kind: "remote-box"; url: string; tokenFile: string; callbackTokenFile: string;
  publicKeyFile: string; boxRouterPort?: number; macRouterPort?: number; callbackPort: number; epoch: string; boxId: string;
  noticeAfterMs?: number; outageClearMs?: number; noticeMinGapMs?: number; wakeFenceAutoFailMs?: number; mirror?: boolean };
type Outage = { id: string; unreachableSince: number | null; reachableSince: number | null; noticeAttempted?: boolean; downAt?: number; failedProbes?: number };
type Fence = { id: string; since: number; queuedBehind: number };
type FenceAlert = { key: string; text: string };
type WaitingNotice = { id: string; since: number; attempted?: boolean };
type BoxEvent = { id: string; state: string; failure: string | null; kind: "inbound" | "wake"; interruptedAt: number | null; hasSend: boolean; watcher?: string };
type BoxAction = { id: string; path: string; attempts: number; lastStatus: number | null; nextAt: number | null; inboxId: string | null };
const ACTION_PATHS = ["/send", "/files", "/react", "/agent-ask", "/agent-answer", "/agent-requests", "/share", "/unshare", "/shares"];
export class RemoteRequestError extends Error {
  constructor(readonly status: number) { super("Box request failed"); }
}
export function remoteBoxConfig(config: { chatBackends?: unknown }, slug: string): RemoteBoxConfig | undefined {
  const entries = config.chatBackends as Record<string, unknown> | undefined;
  const entry = entries?.[slug] as RemoteBoxConfig | undefined;
  if (entry === undefined || entry.kind === ("robob" as string)) return;
  if (slug !== "moni" || entry.kind !== "remote-box" || !/^http:\/\/127\.0\.0\.1:\d+$/.test(entry.url)
    || entry.mirror !== undefined && typeof entry.mirror !== "boolean"
    || ![entry.tokenFile, entry.callbackTokenFile, entry.publicKeyFile].every(p => typeof p === "string" && p.startsWith("/"))
    || [entry.boxRouterPort, entry.macRouterPort].some(p => p !== undefined && (!Number.isInteger(p) || p < 1024 || p > 65535))
    || [entry.noticeAfterMs, entry.outageClearMs, entry.noticeMinGapMs, entry.wakeFenceAutoFailMs].some(ms => ms !== undefined && (!Number.isSafeInteger(ms) || ms < 0))
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
  private fenceBusy = false;
  private deliveryBusy = false;
  private nextProbe = 0;
  private failures = 0;
  private nextStateLog = 0;
  private readonly callbackErrors = new Map<string, { at: number; count: number; props: Record<string, string | number | boolean> }>();
  private readonly unanswered: RemoteUnanswered;
  private readonly callbackLoopDelay = monitorEventLoopDelay({ resolution: 100 });
  constructor(readonly config: RemoteBoxConfig, readonly store: Store, private readonly io: {
    fetch?: Fetch; now?: () => number; log: (event: string, code?: string) => void;
    alertSocketPath?: string; active: () => boolean;
    ownerAlert?: (severity: "attention", text: string, key: string) => Promise<boolean>;
    mirror?: ChatMirror;
  }) {
    this.sessionId = `remote:moni:${config.epoch}`;
    this.publicKey = readFileSync(config.publicKeyFile, "utf8");
    if (createPublicKey(this.publicKey).asymmetricKeyType !== "rsa") throw new Error("RSA box key required");
    this.token = readFileSync(config.tokenFile, "utf8").trim();
    this.callbackToken = readFileSync(config.callbackTokenFile, "utf8").trim();
    if (this.token.length < 32 || this.callbackToken.length < 32) throw new Error("Invalid remote credentials");
    store.db.exec(`CREATE TABLE IF NOT EXISTS remote_inbox (seq INTEGER PRIMARY KEY, id TEXT UNIQUE, sealed TEXT, receipt TEXT);
      CREATE TABLE IF NOT EXISTS remote_sends (id TEXT PRIMARY KEY, at INTEGER, state TEXT, handle TEXT);`);
    this.unanswered = new RemoteUnanswered(store, (severity, text, key) => io.ownerAlert?.(severity, text, key) ?? Promise.resolve(false));
    if (!store.db.query<{ name: string }, []>("PRAGMA table_info(remote_inbox)").all().some(c => c.name === "kind")) {
      // Old ciphertext cannot be classified on the relay. Unknown rows never cause a notice.
      store.db.exec("ALTER TABLE remote_inbox ADD COLUMN kind TEXT NOT NULL DEFAULT 'unknown'");
    }
    for (const name of ["received_at", "delivered_at", "finished_at"]) {
      if (!store.db.query<{ name: string }, []>("PRAGMA table_info(remote_inbox)").all().some(c => c.name === name)) store.db.exec(`ALTER TABLE remote_inbox ADD COLUMN ${name} INTEGER`);
    }
    // Historical ciphertext has no receipt timestamp. Begin a conservative observation window at upgrade.
    store.db.query("UPDATE remote_inbox SET received_at=? WHERE kind='inbound' AND received_at IS NULL").run(this.now());
    store.db.query("UPDATE remote_inbox SET delivered_at=received_at WHERE kind='inbound' AND sealed IS NULL AND delivered_at IS NULL").run();
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
    this.backendState();
    const columns = store.db.query<{ name: string }, []>("PRAGMA table_info(remote_inbox)").all();
    for (const column of ["expires_at", "picked_up_at", "delivery_checked_at", "delivery_final"]) if (!columns.some(c => c.name === column)) store.db.exec(`ALTER TABLE remote_inbox ADD COLUMN ${column} INTEGER`);
    this.callbackLoopDelay.enable();
  }
  private backendState() {
    this.nextStateLog = this.now() + 300_000;
    this.emit("moni-box-backend-state", undefined, undefined, { backend: "remote-box", active: this.io.active(), busy: this.busy,
      queuedBehind: traceLoopOperation("remote.queue-depth", () => this.store.db.query<{ n: number }, []>("SELECT count(*) n FROM remote_inbox WHERE sealed IS NOT NULL").get()!.n),
      fenced: !!this.store.get("remoteFence"), count: this.failures });
  }
  checkUnanswered(now = this.now()): Promise<void> { return this.unanswered.check(now); }
  private emit(event: string, code?: string, durationMs?: number, props?: Record<string, string | number | boolean>) {
    this.io.log(event, props ? JSON.stringify(props) : code);
    const error = event.endsWith("-error") || event === "moni-box-fenced" || event === "moni-box-down";
    toolLog.capture(() => toolLog.write({ component: "remote-box", kind: error ? "error" : durationMs === undefined ? "event" : "perf",
      name: event, ids: { chat: "moni" }, ...(durationMs === undefined ? {} : { durationMs }),
      ...(props ? { props } : code?.startsWith("n=") ? { props: { count: Number(code.slice(2)) } }
        : event === "moni-notice-suppressed" && code ? { props: { reason: code } } : {}) }));
  }
  private emitCallbackError(key: string) {
    const window = this.callbackErrors.get(key);
    if (!window) return;
    this.callbackErrors.delete(key);
    this.emit("moni-runner-error", undefined, undefined, { ...window.props, count: window.count - 1 });
  }
  private flushCallbackErrors(all = false) {
    for (const [key, window] of this.callbackErrors) {
      if (all || this.now() - window.at >= 60_000) this.emitCallbackError(key);
    }
  }
  stop() { this.callbackLoopDelay.disable(); this.flushCallbackErrors(true); }
  private callbackError(path: string, status: number, error: unknown) {
    // Emit the completed window so count includes every suppressed repeat, even if the failure stops.
    this.flushCallbackErrors();
    const key = `${path}:${status}`, window = this.callbackErrors.get(key);
    if (window) { window.count++; return; }
    this.callbackErrors.set(key, { at: this.now(), count: 1, props: { path, status,
      errorClass: error instanceof LineError ? "LineError" : error instanceof RemoteSendError ? "RemoteSendError" : error instanceof Error ? "Error" : "UnknownError",
      ...(error instanceof LineError ? { code: safeLineFailureCode(error.code) } : {}),
      retryable: error instanceof LineError ? error.retryable : !(error instanceof RemoteSendError) || status !== 422 } });
  }
  private now() { return (this.io.now ?? Date.now)(); }
  accept(id: string, input: unknown, receipt?: AgentAnswerReceipt, kind: "inbound" | "wake" = "inbound"): boolean {
    const key = opaqueId(id);
    return this.store.db.transaction(() => {
      const created = this.store.db.query("INSERT OR IGNORE INTO remote_inbox(id,sealed,receipt,kind,received_at,expires_at) VALUES (?,?,?,?,?,?)")
        .run(key, JSON.stringify(seal(this.publicKey, typeof input === "object" && input !== null ? { ...input, kind } : input)), receipt ? JSON.stringify(receipt) : null, kind, this.now(),
          typeof input === "object" && input !== null && "agentExpiresAt" in input && Number.isSafeInteger(input.agentExpiresAt) ? input.agentExpiresAt as number : null).changes === 1;
      if (created && kind === "inbound") this.unanswered.accept(key, this.now());
      if (kind === "inbound") this.io.mirror?.inbound(id, input);
      return created;
    })();
  }
  receipt(id: string): AgentAnswerReceipt | undefined {
    const row = this.store.db.query<{ receipt: string | null }, [string]>("SELECT receipt FROM remote_inbox WHERE id=?").get(opaqueId(id));
    return row?.receipt ? JSON.parse(row.receipt) : undefined;
  }
  hasMessage(id: string): boolean {
    return !!this.store.db.query("SELECT 1 FROM remote_inbox WHERE id=?").get(opaqueId(id));
  }
  delivery(id: string): { retained: boolean; confirmed: boolean; deliveredAt?: number } {
    const row = this.store.db.query<{ sealed: string | null; picked_up_at: number | null }, [string]>("SELECT sealed,picked_up_at FROM remote_inbox WHERE id=?").get(opaqueId(id));
    return { retained: !!row, confirmed: row?.sealed === null, ...(row?.picked_up_at == null ? {} : { deliveredAt: row.picked_up_at }) };
  }
  async request(path: string, body: unknown): Promise<Record<string, unknown>> {
    // No pooled sockets: the box's Bun.serve closes idle keep-alive sockets at 10 s, twice the probe interval,
    // and that close crosses the ssh -L forward too late, so a reused socket reset under /lease or /deliver.
    const response = await (this.io.fetch ?? fetch)(this.config.url + path, { method: "POST", redirect: "error", keepalive: false,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(path === "/lease" ? 12_000 : 10_000) });
    if (!response.ok) throw new RemoteRequestError(response.status);
    return jsonBody(response as unknown as Request);
  }
  async events(after?: string, headOnly = false): Promise<{ events: BoxEvent[]; actions?: BoxAction[]; nextCursor?: string; remaining?: number }> {
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
        hasSend: row.hasSend, ...("watcher" in row && typeof row.watcher === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(row.watcher) ? { watcher: row.watcher } : {}),
        failure: "failure" in row && ["invalid", "unavailable", "too-large"].includes(String(row.failure)) ? String(row.failure) : null };
    });
    let actions: BoxAction[] | undefined;
    if (response.actions !== undefined) {
      if (!Array.isArray(response.actions)) throw new Error("Invalid box actions");
      actions = response.actions.map((row: unknown): BoxAction => {
        if (typeof row !== "object" || row === null || !("id" in row) || typeof row.id !== "string" || !/^[a-f0-9]{12}$/.test(row.id)
          || !("path" in row) || !ACTION_PATHS.includes(String(row.path))
          || !("attempts" in row) || !Number.isSafeInteger(row.attempts) || Number(row.attempts) < 0
          || !("lastStatus" in row) || row.lastStatus !== null && (!Number.isSafeInteger(row.lastStatus) || Number(row.lastStatus) < 100 || Number(row.lastStatus) > 599)
          || !("nextAt" in row) || row.nextAt !== null && (!Number.isSafeInteger(row.nextAt) || Number(row.nextAt) < 0)
          || !("inboxId" in row) || row.inboxId !== null && (typeof row.inboxId !== "string" || !/^[a-f0-9]{12}$/.test(row.inboxId))) throw new Error("Invalid box action");
        return { id: row.id, path: row.path as string, attempts: row.attempts as number, lastStatus: row.lastStatus as number | null,
          nextAt: row.nextAt as number | null, inboxId: row.inboxId as string | null };
      });
    }
    return { events, ...(actions ? { actions } : {}), ...(response.remaining === undefined ? {} : { remaining: response.remaining as number, nextCursor: response.nextCursor as string }) };
  }
  async resolve(id: string, state: "done" | "pending" | "failed", autoFailMs?: number) {
    // The runner's done tombstone is its existing terminal, no-replay resolution.
    const result = await this.request("/resolve", { id, state: state === "failed" ? "done" : state, reconciled: true,
      ...(autoFailMs === undefined ? {} : { autoFailMs }) });
    if (result.accepted !== true) throw new Error("Invalid box acknowledgement");
    return { accepted: true };
  }
  private async probeFence() {
    // Only a no-send wake may be retired automatically; other interrupted turns need reconciliation.
    // Probe failures are observational and must never enter the link-outage notice path.
    let events: BoxEvent[], remaining: number | undefined;
    try { ({ events, remaining } = await this.events(undefined, true)); } catch { this.emit("moni-box-events-error"); return; }
    const saved = this.store.get<Fence | null>("remoteFence");
    const head = events.find(row => row.state !== "attachment-failed");
    if (saved && (head?.state !== "interrupted" || head.id !== saved.id)) {
      this.store.set("remoteFence", null);
      this.emit("moni-box-unfenced", undefined, undefined, { event: saved.id.slice(0, 12), fencedMs: Math.max(0, this.now() - saved.since) });
    }
    if (head?.state !== "interrupted") {
      return !!head && (remaining ?? 0) > 0 && !!await this.inboundBehind(head.id);
    }
    const queuedBehind = remaining ?? 0;
    const fence = saved?.id === head.id ? saved : { id: head.id, since: head.interruptedAt ?? this.now(), queuedBehind: -1 };
    const ageMs = Math.max(0, this.now() - fence.since), event = head.id.slice(0, 12);
    const autoKey = `remoteWakeAutoFail:${head.id}`;
    if (head.kind === "wake" && !head.hasSend && ageMs >= (this.config.wakeFenceAutoFailMs ?? 600_000)) {
      if (await this.inboundBehind(head.id)) {
        const alert = { key: `moni-box-wake-autofailed:${event}`,
          text: `Moni's interrupted watcher wake${head.watcher ? ` (${head.watcher})` : ""} (${event}) sent nothing and was retired after ${Math.floor(ageMs / 60_000)} min; ${queuedBehind} later items can continue.` };
        // Persist the exact notification before resolving, including an ambiguous resolve acknowledgement.
        if (!this.store.get(autoKey)) this.store.set(autoKey, { alert, event, ageMs, queuedBehind });
        return;
      }
    }
    if (queuedBehind > fence.queuedBehind) {
      fence.queuedBehind = queuedBehind;
      this.store.set("remoteFence", fence);
      this.emit("moni-box-fenced", undefined, undefined, { event, kind: head.kind, ageMs, hasSend: head.hasSend, queuedBehind });
    }
    const alertKey = `remoteFenceAlert:${head.id}`;
    const savedAlert = this.store.get<true | FenceAlert>(alertKey);
    const firstInbound = await this.inboundBehind(head.id);
    const initialInboundKey = `remoteFenceInitialInbound:${head.id}`;
    if (!savedAlert) this.store.set(initialInboundKey, !!firstInbound);
    if (this.io.ownerAlert && savedAlert !== true) {
      const age = ageMs < 60_000 ? `${Math.floor(ageMs / 1000)}s` : `${Math.floor(ageMs / 60_000)}m`;
      const alert = savedAlert ?? { key: `moni-box-fenced:${event}`,
        text: `Moni's box agent is stuck on one interrupted ${head.kind} (${age}); ${queuedBehind} later messages waiting. Resolve: spectrum-bridge remote-resolve --chat moni --id ${head.id} --state done|pending --session <owner-session>` };
      // Telegram deduplicates immutable requests. Keep the original text across retries and restarts.
      if (!savedAlert) this.store.set(alertKey, alert);
      try {
        if (await this.io.ownerAlert("attention", alert.text, alert.key)) this.store.set(alertKey, true);
        else this.emit("moni-box-fence-alert-error");
      } catch { this.emit("moni-box-fence-alert-error"); }
    }
    if (savedAlert === true && firstInbound && !this.store.get(initialInboundKey)) {
      const key = `remoteFenceInboundAlert:${head.id}`;
      const saved = this.store.get<true | FenceAlert>(key);
      if (saved !== true && this.io.ownerAlert) {
        const alert = saved ?? { key: `moni-box-fenced:${event}:inbound:${firstInbound.id}`,
          text: `Moni's interrupted ${head.kind} (${event}) is now holding her messages; ${queuedBehind} later items are waiting. Check her box queue.` };
        if (!saved) this.store.set(key, alert);
        try { if (await this.io.ownerAlert("attention", alert.text, alert.key)) this.store.set(key, true); }
        catch { this.emit("moni-box-fence-alert-error"); }
      }
    }
  }
  private async inboundBehind(id: string) {
    let page = await this.events(id);
    for (;;) {
      const inbound = page.events.find(row => row.kind === "inbound");
      if (inbound || !page.nextCursor) return inbound;
      page = await this.events(page.nextCursor);
    }
  }
  private waiting() {
    return traceLoopOperation("remote.unanswered", () => this.store.db.query<{ id: string; received_at: number }, []>(`SELECT id,received_at FROM remote_inbox
      WHERE kind='inbound' AND finished_at IS NULL ORDER BY received_at,seq LIMIT 1`).get());
  }
  private finish(id: string) {
    this.store.db.transaction(() => {
      this.store.db.query("UPDATE remote_inbox SET finished_at=COALESCE(finished_at,?) WHERE id=?").run(this.now(), id);
      // Retiring the final DM ends its episode before a new arrival can inherit its reservation.
      if (!this.waiting()) this.store.set("remoteWaitingNotice", null);
    }).immediate();
  }
  private async reconcileDelivered() {
    const after = this.store.get<number>("remoteStatusCursor") ?? 0;
    const rows = this.store.db.query<{ id: string; seq: number }, [number]>(`SELECT id,seq FROM remote_inbox
      WHERE kind='inbound' AND delivered_at IS NOT NULL AND finished_at IS NULL AND seq>? ORDER BY seq LIMIT 100`).all(after);
    if (!rows.length) { this.store.set("remoteStatusCursor", 0); return; }
    const result = await this.request("/events", { ids: rows.map(row => row.id) });
    if (result.lookup !== true || !Array.isArray(result.events)) throw new Error("Invalid event lookup");
    const ids = new Set(rows.map(row => row.id));
    for (const event of result.events) {
      if (!event || typeof event !== "object" || !validId(event.id) || !ids.has(event.id)
        || !["pending", "running", "interrupted", "attachment-failed", "done"].includes(String(event.state)) || typeof event.hasReply !== "boolean") throw new Error("Invalid event lookup");
    }
    this.store.db.transaction(() => {
      for (const event of result.events as { id: string; state: string; hasReply: boolean }[]) if (event.state === "done" || event.hasReply) this.finish(event.id);
      this.store.set("remoteStatusCursor", rows.length === 100 ? rows.at(-1)!.seq : 0);
    })();
  }
  private async noticeWaiting() {
    const waiting = this.waiting();
    if (!waiting) { this.store.set("remoteWaitingNotice", null); this.emit("moni-notice-suppressed", "not-waiting"); return; }
    const previous = this.store.get<WaitingNotice | null>("remoteWaitingNotice");
    const outage = this.store.get<Outage | null>("remoteOutage");
    const state = previous ?? { id: outage?.id ?? opaqueId(`waiting:${waiting.id}`), since: waiting.received_at };
    state.since = Math.max(state.since, waiting.received_at);
    const lastNotice = this.store.get<number | null>("remoteNoticeAt");
    const reason = this.now() - state.since < (this.config.noticeAfterMs ?? 120_000) ? "grace"
      : state.attempted || outage?.noticeAttempted ? "already-sent"
      : lastNotice !== undefined && lastNotice !== null && this.now() - lastNotice < (this.config.noticeMinGapMs ?? 21_600_000) ? "rate-limited" : undefined;
    if (reason) { if (!previous) this.store.set("remoteWaitingNotice", state); this.emit("moni-notice-suppressed", reason); return; }
    if (!this.io.active()) return;
    this.store.db.transaction(() => {
      this.queueNotice("outage", state.id, "Moni chat: the agent is temporarily unavailable. Incoming messages are queued.");
      this.store.set("remoteNoticeAt", this.now()); this.store.set("remoteWaitingNotice", { ...state, attempted: true });
      if (outage) this.store.set("remoteOutage", { ...outage, noticeAttempted: true });
    }).immediate();
  }
  private queueNotice(kind: "outage" | "attachment_failed", id: string, text: string): void {
    enqueueOperationalNotice(this.store, {
      id: operationalKey(kind.replaceAll("_", "-"), "moni", id), chat: "moni", kind, text, now: this.now(),
    });
  }
  async flushNotices(): Promise<void> {
    if (this.io.alertSocketPath) await flushOperationalNotices(this.store, socketPost(this.io.alertSocketPath, 1_000), { now: () => this.now() });
  }
  async tick(): Promise<void> {
    this.flushCallbackErrors();
    if (this.now() >= this.nextStateLog) this.backendState();
    if (this.busy || this.now() < this.nextProbe || !this.io.active()) return;
    this.busy = true;
    let healthy = false, dependenciesReady = true;
    let step = "lease", requestStarted = this.now(), requestEnded: number | undefined;
    try {
      const status = await this.request("/lease", { epoch: this.config.epoch, boxId: this.config.boxId });
      requestEnded = this.now(); step = "identity";
      if (status.boxId !== this.config.boxId || status.epoch !== this.config.epoch) throw new Error("Box identity mismatch");
      dependenciesReady = status.routerReady !== false && status.callbackReady !== false;
      this.failures = 0;
      const rows = traceLoopOperation("remote.pending", () => this.store.db.query<{ id: string; seq: number; sealed: string; expires_at: number | null }, [number]>("SELECT id,seq,sealed,expires_at FROM remote_inbox WHERE sealed IS NOT NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY seq LIMIT 50").all(this.now()));
      let delivered = 0;
      for (const row of rows) {
        step = "deliver"; requestStarted = this.now(); requestEnded = undefined;
        const ack = await this.request("/deliver", { id: row.id, sealed: JSON.parse(row.sealed) as Sealed, epoch: this.config.epoch, expiresAt: row.expires_at });
        requestEnded = this.now(); step = "ack";
        if (ack.id !== row.id || ack.accepted !== true) throw new Error("Invalid box acknowledgement");
        this.store.db.query("UPDATE remote_inbox SET sealed=NULL,delivered_at=COALESCE(delivered_at,?) WHERE id=?").run(this.now(), row.id);
        delivered++;
      }
      const outage = this.store.get<Outage | null>("remoteOutage");
      if (outage) {
        outage.unreachableSince = null;
        outage.reachableSince ??= this.now();
        const clearMs = this.config.outageClearMs ?? 300_000;
        if (this.now() - outage.reachableSince >= clearMs) {
          this.emit("moni-box-up", undefined, undefined, { clearMs,
            ...(outage.downAt === undefined ? {} : { unreachableMs: outage.reachableSince - outage.downAt }),
            ...(outage.failedProbes === undefined ? {} : { failedProbes: outage.failedProbes }) });
          this.store.set("remoteOutage", null);
        } else this.store.set("remoteOutage", outage);
      }
      if (delivered) this.emit("moni-queue-delivered", `n=${delivered}`);
      this.emit("moni-queue-depth", `n=${traceLoopOperation("remote.queue-depth", () => this.store.db.query<{ n: number }, []>("SELECT count(*) n FROM remote_inbox WHERE sealed IS NOT NULL").get()!.n)}`);
      this.nextProbe = this.now() + 5_000;
      healthy = true;
    } catch (error) {
      const cause = error !== null && typeof error === "object" && "cause" in error ? error.cause : undefined;
      const errorCode = [
        error !== null && typeof error === "object" && "code" in error ? error.code : undefined,
        cause !== null && typeof cause === "object" && "code" in cause ? cause.code : undefined,
        cause !== null && typeof cause === "object" && "name" in cause ? cause.name : undefined,
      ].find((value): value is string => typeof value === "string" && /^[A-Za-z0-9_]{1,40}$/.test(value));
      const props = { step, ...(error instanceof RemoteRequestError ? { status: error.status } : {}),
        errorClass: error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name) ? "Timeout" : error?.constructor?.name ?? typeof error,
        ...(errorCode === undefined ? {} : { errorCode }),
        // /ready owns the reset so probe diagnostics preserve its sampling window.
        loopDelayMs: Math.round(this.callbackLoopDelay.max / 1_000_000),
        latencyMs: (requestEnded ?? this.now()) - requestStarted };
      const saved = this.store.get<Outage | null>("remoteOutage");
      // A stall notice reserves the transport outage too, even after its waiting episode ends.
      const outage: Outage = saved ?? { id: opaqueId(String(this.now())), unreachableSince: this.now(), reachableSince: null,
        downAt: this.now(),
        noticeAttempted: this.store.get<WaitingNotice | null>("remoteWaitingNotice")?.attempted === true };
      outage.unreachableSince ??= this.now(); outage.reachableSince = null;
      outage.failedProbes = (outage.failedProbes ?? 0) + 1;
      this.store.set("remoteOutage", outage);
      if (!saved) this.emit("moni-box-down", undefined, undefined, props);
      await this.noticeWaiting();
      this.nextProbe = this.now() + Math.min(60_000, 1_000 * 2 ** Math.min(++this.failures, 6));
      this.emit("moni-runner-error", undefined, undefined, { code: "unreachable", ...props, failures: this.failures });
    } finally { this.busy = false; }
    // Observational requests must not hold up lease renewal, including while Telegram is stalled.
    const delivery = healthy ? this.checkDeliveries() : undefined;
    if (healthy && !this.fenceBusy) {
      this.fenceBusy = true;
      try {
        try { await this.reconcileDelivered(); } catch { this.emit("moni-box-status-error"); }
        const heldInbound = await this.probeFence(); await this.flushAutoFailAlerts();
        if (!this.waiting()) this.store.set("remoteWaitingNotice", null);
        else if (!dependenciesReady || heldInbound || this.store.get("remoteFence")) await this.noticeWaiting();
      } catch { this.emit("moni-box-events-error"); }
      finally { this.fenceBusy = false; }
    }
    await delivery;
  }
  private async checkDeliveries(): Promise<void> {
    if (this.deliveryBusy || !this.io.active()) return;
    this.deliveryBusy = true;
    try {
      const waiting = traceLoopOperation("remote.expiry", () => this.store.db.query<{ id: string; expires_at: number }, []>("SELECT id,expires_at FROM remote_inbox WHERE picked_up_at IS NULL AND expires_at IS NOT NULL AND delivery_final IS NULL ORDER BY COALESCE(delivery_checked_at,0),seq LIMIT 50").all());
      if (!waiting.length) return;
      const probedAt = this.now();
      const status = await this.request("/delivery-status", { ids: waiting.map(r => r.id), deadlines: waiting.map(r => ({ id: r.id, expiresAt: r.expires_at })), epoch: this.config.epoch });
      if (!Array.isArray(status.deliveries)) throw new Error("Invalid delivery status");
      for (const receipt of status.deliveries) {
        if (!receipt || !waiting.some(r => r.id === receipt.id) || typeof receipt.accepted !== "boolean"
          || receipt.deliveredAt !== null && (!Number.isSafeInteger(receipt.deliveredAt) || receipt.deliveredAt < 0)) throw new Error("Invalid delivery receipt");
        this.store.db.query(`UPDATE remote_inbox SET picked_up_at=?,
          sealed=CASE WHEN ? THEN NULL ELSE sealed END, delivery_checked_at=?,
          delivery_final=CASE WHEN expires_at<=? THEN 1 ELSE NULL END WHERE id=?`)
          .run(receipt.deliveredAt, Number(receipt.accepted), this.now(), probedAt, receipt.id);
      }
    } catch { this.emit("moni-box-delivery-status-error"); }
    finally { this.deliveryBusy = false; }
  }
  private async flushAutoFailAlerts() {
    const rows = this.store.db.query<{ key: string; value: string }, []>("SELECT key,value FROM kv WHERE key GLOB 'remoteWakeAutoFail:*'").all();
    for (const row of rows) {
      if (!this.io.active()) return;
      const saved = JSON.parse(row.value) as { alert: FenceAlert; sent?: boolean; resolved?: boolean; event: string; ageMs: number; queuedBehind: number };
      if (saved.sent) continue;
      // An ambiguous /resolve is retried idempotently before announcing success.
      if (!saved.resolved) {
        try { await this.resolve(row.key.slice("remoteWakeAutoFail:".length), "failed", this.config.wakeFenceAutoFailMs ?? 600_000); }
        catch (error) {
          if (error instanceof RemoteRequestError && error.status === 409) this.store.db.query("DELETE FROM kv WHERE key=?").run(row.key);
          throw error;
        }
        saved.resolved = true; this.store.set(row.key, saved);
        this.store.set("remoteFence", null);
        this.emit("moni-box-wake-autofailed", undefined, undefined, { event: saved.event, ageMs: saved.ageMs, queuedBehind: saved.queuedBehind });
      }
      if (!this.io.ownerAlert) continue;
      try {
        if (await this.io.ownerAlert("attention", saved.alert.text, saved.alert.key)) this.store.set(row.key, { ...saved, sent: true });
      } catch { this.emit("moni-box-fence-alert-error"); }
    }
  }
  async send(id: string, text: string, mediaUrl: string | undefined, line: Line, chat: ChatKey): Promise<{ id: string; handle: string }> {
    const row = traceLoopOperation("remote.reply", () => this.store.db.query<{ at: number; state: string; handle: string }, [string]>("SELECT * FROM remote_sends WHERE id=?").get(id));
    if (row?.state === "sent") {
      this.io.mirror?.outbound(id, text, mediaUrl, row.at);
      return { id, handle: row.handle };
    }
    if (row?.state === "failed") throw new RemoteSendError(422);
    if (row?.state === "uncertain") {
      const sent = (await line.outbound(chat, row.at - 5_000)).find(m => m.text === text && m.mediaUrl === mediaUrl && m.sentAt >= row.at
        && !/^(?:error|declined|failed)$/i.test(m.status)
        && !this.store.db.query("SELECT 1 FROM remote_sends WHERE handle=? AND id!=?").get(m.handle, id));
      if (!sent) throw new RemoteSendError(409);
      this.store.db.query("UPDATE remote_sends SET state='sent',handle=? WHERE id=?").run(sent.handle, id);
      this.io.mirror?.outbound(id, text, mediaUrl, sent.sentAt);
      return { id, handle: sent.handle };
    }
    this.store.db.query("INSERT INTO remote_sends VALUES (?,?,'uncertain',NULL) ON CONFLICT(id) DO UPDATE SET at=excluded.at,state='uncertain'").run(id, this.now());
    try {
      const sent = await line.sendText(chat, text, mediaUrl ? { mediaUrl } : undefined);
      this.store.db.query("UPDATE remote_sends SET state='sent',handle=? WHERE id=?").run(sent.handle, id);
      this.io.mirror?.outbound(id, text, mediaUrl, this.now());
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
    const started = performance.now();
    const path = new URL(request.url).pathname;
    const authorized = tokenMatches(request.headers.get("authorization"), this.callbackToken);
    const reply = (status: number, body: unknown) => {
      const response = Response.json(body, { status });
      if (authorized && path === "/ready") {
        toolLog.capture(() => {
          const handlerMs = Math.max(0, performance.now() - started);
          // Max sampled loop delay since the preceding /ready, including stalls outside this handler.
          const loopDelayMs = this.callbackLoopDelay.max / 1_000_000;
          this.callbackLoopDelay.reset();
          this.emit("moni-callback-ready", undefined, handlerMs, { status, handlerMs, loopDelayMs });
        });
      }
      return response;
    };
    // This entry is used by a dedicated loopback listener, never by the trusted Unix socket.
    if (!authorized) return reply(403, { error: "Forbidden" });
    if (!this.io.active()) return reply(503, { error: "Backend paused" });
    if (request.method !== "POST" || !["/send", "/files", "/react", "/agent-ask", "/agent-answer", "/agent-requests", "/share", "/unshare", "/shares", "/ready", "/metrics"].includes(path)) return reply(403, { error: "Forbidden" });
    try {
      const body = await jsonBody(request);
      if (body.epoch !== this.config.epoch || (!path.startsWith("/agent-") && body.to !== undefined) || body.chat !== undefined || body.sessionId !== undefined) return reply(403, { error: "Forbidden" });
      delete body.epoch;
      const operation = body.operationId; delete body.operationId;
      if (path === "/metrics") {
        if (typeof body.durationMs !== "number" || !Number.isFinite(body.durationMs) || body.durationMs < 0) return reply(400, { error: "Invalid metrics" });
        if (body.kind === "swipe") {
          if (typeof body.source !== "string" || !["inbox", "action", "missing", "none"].includes(body.source)
            || typeof body.hasThreadOrigin !== "boolean" || typeof body.hasReplyTo !== "boolean") return reply(400, { error: "Invalid metrics" });
          this.emit("moni-swipe-resolved", undefined, undefined, { source: body.source, hasThreadOrigin: body.hasThreadOrigin, hasReplyTo: body.hasReplyTo });
          return reply(200, { accepted: true });
        }
        if (body.status === "error") this.emit("moni-runner-error", undefined, undefined, { code: "harness" });
        this.emit("moni-turn-latency", undefined, body.durationMs); return reply(200, { accepted: true });
      }
      if (path === "/ready") return reply(200, { epoch: this.config.epoch });
      if (path.startsWith("/agent-")) {
        if (!validId(operation)) return reply(400, { error: "Operation id required" });
        return await io.bus(path, { ...body, sessionId: this.sessionId }, opaqueId(`moni:${operation}`),
          createHmac("sha256", this.callbackToken).update(JSON.stringify([path, body])).digest("hex"));
      }
      if (["/share", "/unshare", "/shares"].includes(path)) return reply(200, await this.request(path, body));
      if (path === "/react") {
        if (typeof body.target !== "string" || !this.hasMessage(body.target) || typeof body.kind !== "string" || !["like", "love", "dislike", "laugh", "emphasize", "question"].includes(body.kind)) return reply(403, { error: "Forbidden" });
        await io.line.react(body.target, body.kind); this.unanswered.answered(opaqueId(body.target), this.now()); this.finish(opaqueId(body.target)); return reply(200, { accepted: true });
      }
      if (path === "/files") {
        if (typeof body.data !== "string" || body.data.length > 28_000_000 || typeof body.name !== "string" || typeof body.mime !== "string") return reply(400, { error: "Invalid file" });
        const file = { data: Buffer.from(body.data, "base64"), name: body.name, mimeType: body.mime };
        const mediaUrl = await io.line.upload(file);
        this.io.mirror?.rememberFile(mediaUrl, file);
        return reply(200, { mediaUrl });
      }
      if (!validId(body.id) || typeof body.text !== "string" || body.text.length > 12_000 || (body.mediaUrl !== undefined && (typeof body.mediaUrl !== "string" || !body.mediaUrl.startsWith("https://")))) return reply(400, { error: "Invalid send" });
      if (body.inboxId !== undefined && !validId(body.inboxId)) return reply(400, { error: "Invalid inbox id" });
      // The box runner reserves this operation ID for its own attachment error.
      // Agent sends use a different ID and retain their normal iMessage path.
      if (validId(body.inboxId) && body.id === opaqueId(`attachment-failed:${body.inboxId}`)) {
        this.queueNotice("attachment_failed", body.inboxId, "Moni chat: the agent could not read an incoming attachment.");
        this.finish(body.inboxId);
        await this.flushNotices();
        return reply(200, { id: body.id });
      }
      const result = await this.send(body.id, body.text, typeof body.mediaUrl === "string" ? body.mediaUrl : undefined, io.line, io.chat);
      if (validId(body.inboxId)) { this.unanswered.answered(body.inboxId, this.now()); this.finish(body.inboxId); }
      return reply(200, result);
    } catch (error) {
      // send() alone decides a terminal send; an outbound-history lookup cannot settle uncertain delivery.
      const status = error instanceof RemoteSendError ? error.status : path !== "/send" && error instanceof LineError && !error.retryable && !error.uncertain ? 422 : 502;
      this.callbackError(path, status, error);
      return reply(status, { error: "Operation failed" });
    }
  }
}
