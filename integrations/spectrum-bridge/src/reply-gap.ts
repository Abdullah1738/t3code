import type { Store } from "./store.ts";
import { toolLog } from "./toollog.ts";
import { replyLatency } from "./reply-latency.ts";

const CHECK_EVERY = 30_000;
const HOUR = 60 * 60_000;
const LIMIT = 200;
const CURSOR = "reply-gap-cursor";
const ALERT = "reply-gap-alert";
type Alert = { lastSentAt?: number; pending?: { key: string; gapMs: number } };

/** Checks newly accepted replies, retaining the same Telegram key across uncertain retries. */
export class ReplyGapMonitor {
  private ticking?: Promise<void>;
  private nextCheck = 0;

  constructor(private readonly store: Store, private readonly options: {
    chat: string;
    notify: (severity: "attention", text: string, key: string) => Promise<boolean>;
    /** gapMs is undefined when the gap is too long to be a reply latency (#136). */
    log?: (chat: string, gapMs: number | undefined) => void;
  }) {
    // Starting this monitor must not page about historical replies on its first deployment.
    if (store.get<number>(CURSOR) === undefined) store.set(CURSOR, this.highWater());
  }

  tick(): Promise<void> {
    return this.ticking ??= this.run().finally(() => { this.ticking = undefined; });
  }

  private highWater(): number {
    return this.store.db.query<{ id: number }, []>("SELECT COALESCE(MAX(rowid), 0) AS id FROM kv WHERE substr(key, 1, 8) = 'sent-at:'").get()!.id;
  }

  private async run(): Promise<void> {
    const chat = this.options.chat;
    if (chat !== "owner" && chat !== "moni") return;
    const now = Date.now();
    if (now < this.nextCheck) return;
    this.nextCheck = now + CHECK_EVERY;
    const high = this.highWater();
    const rows = this.store.db.query<{ rowid: number; key: string; value: string }, [number, number, number]>(
      "SELECT rowid, key, value FROM kv WHERE rowid > ? AND rowid <= ? AND substr(key, 1, 8) = 'sent-at:' ORDER BY rowid LIMIT ?",
    ).all(this.store.get<number>(CURSOR)!, high, LIMIT);
    const rechecks = this.store.db.query<{ key: string }, []>(
      "SELECT key FROM kv WHERE key GLOB 'reply-gap-recheck:*' LIMIT 200",
    ).all();
    const receipts = new Map(rows.map(row => [row.key, row]));
    for (const recheck of rechecks) {
      const key = `sent-at:${recheck.key.slice("reply-gap-recheck:".length)}`;
      const row = this.store.db.query<{ rowid: number; key: string; value: string }, [string]>("SELECT rowid, key, value FROM kv WHERE key = ?").get(key);
      if (row) receipts.set(key, row);
    }
    const alert = this.store.get<Alert>(ALERT) ?? {};
    let largest = 0;
    for (const row of receipts.values()) {
      const id = row.key.slice(8);
      const item = this.store.getOperation(id);
      if (item?.state !== "sent" || item.kind !== "conversation" || !item.sessionId) continue;
      const inboundId = this.store.get<string>(`log-inbound-id:${id}`) ?? item.replyTo;
      if (!inboundId || /^(?:secret|wake|reset):/.test(inboundId)) continue;
      const inbound = this.store.db.query<{ payload: string }, [string]>("SELECT payload FROM inbound WHERE id = ?").get(inboundId);
      if (!inbound) continue;
      const input = JSON.parse(inbound.payload) as { source?: string; isAudioMessage?: boolean; sentAt?: number; receivedAt?: number };
      if (input.source !== undefined && input.source !== "typed" && !(input.source === "composed" && input.isAudioMessage === true)) continue;
      const sentAt: unknown = JSON.parse(row.value);
      const receivedAt = input.sentAt ?? input.receivedAt;
      if (typeof sentAt !== "number" || !Number.isSafeInteger(sentAt) || sentAt > now
        || typeof receivedAt !== "number" || !Number.isSafeInteger(receivedAt) || receivedAt < 0 || receivedAt > sentAt) continue;
      const gapMs = sentAt - receivedAt;
      if (gapMs <= 60_000) continue;
      const latency = replyLatency(sentAt, receivedAt, "received");
      if (this.options.log) this.options.log(chat, latency.durationMs);
      else toolLog.capture(() => toolLog.write({ component: "delivery", kind: "perf", name: "reply.gap", ...latency, ids: { chat } }));
      largest = Math.max(largest, gapMs);
    }
    if (largest && !alert.pending && (alert.lastSentAt === undefined || now - alert.lastSentAt >= HOUR)) {
      alert.pending = { key: `reply-gap:${chat}:${now}`, gapMs: largest };
    }
    this.store.db.transaction(() => {
      this.store.set(CURSOR, rows.length === LIMIT ? rows.at(-1)!.rowid : high);
      this.store.set(ALERT, alert);
      for (const recheck of rechecks) this.store.db.query("DELETE FROM kv WHERE key = ?").run(recheck.key);
    }).immediate();
    const pending = alert.pending;
    if (pending && await this.options.notify("attention",
      `iMessage ${chat}: a reply was accepted ${Math.ceil(pending.gapMs / 1000)} s after the incoming message (over 60 s).`, pending.key)) {
      this.store.set(ALERT, { lastSentAt: Date.now() } satisfies Alert);
    }
  }
}
