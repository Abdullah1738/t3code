import { createHash } from "node:crypto";
import { redact } from "./redact.ts";
import type { OutboxRecord, Store } from "./store.ts";
import { toolError, toolLog } from "./toollog.ts";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type Ask = { firstAt: number; count: number; lastId: string };
type Burst = { source: string; nextAt: number; count: number; latest: string; includesFirst: boolean;
  lastId: string; lastTotal: number; carried?: boolean };
type Notice = { id: string; source: string; text: string; severity: string; askKey?: string; burstKey?: string };

function saveLogSeverity(store: Store, id: string, severity: string): void {
  // Delivery can happen after a restart, so retain only the severity alongside the immutable operation.
  try { store.set(`log:severity:${id}`, severity); }
  catch { toolError("telegram", "tg.send.severityStore", { operation: id }); }
}

const hasAcceptedChunk = (store: Store, id: string) => store.db.query<{ key: string }, [string, string]>(
  "SELECT key FROM kv WHERE key >= ? AND key < ? AND json_extract(value, '$.accepted') = 1 LIMIT 1",
).get(`chunk:${id}:`, `chunk:${id};`) !== null;
const definiteFailure = (store: Store, id: string) => store.getOperation(id)?.state === "failed"
  && store.get<boolean>(`sendAmbiguous:${id}`) === false;
const rejected = (store: Store, id: string) => definiteFailure(store, id) && !hasAcceptedChunk(store, id);
// Terminal uncertainty keeps this operation deduplicated, but must not mute future incidents forever.
const held = (store: Store, id: string) => {
  const state = store.getOperation(id)?.state;
  return state !== "sent" && state !== "uncertain" && !definiteFailure(store, id);
};
const burstDeadline = (store: Store, burst: Burst) => Math.max(burst.nextAt,
  (store.get<number>(`acceptedAt:${burst.lastId}`) ?? burst.nextAt - HOUR) + HOUR);

export const runCloudUp = (source: string, text: string) =>
  source.toLowerCase() === "run.cloud" && /^Run Cloud\b[^\n]*\bup:/i.test(text);

// Older evaluator calls carry the ask identity in the source and text, rather than a structured field.
export function boardAskKey(source: string, text: string): string | undefined {
  const board = /^(.*?)\s+board(?:\s*[-#]?\s*(\d+))?$/i.exec(source);
  const card = board?.[2] ?? /#(\d+)\b/.exec(text)?.[1];
  const ask = /\bq(\d+)\b/i.exec(text)?.[1];
  return board && card && ask ? `${board[1]!.toLowerCase()}:${card}:q${ask}` : undefined;
}

function reserveAsk(store: Store, key: string, id: string, now: number): boolean {
  const saved = store.get<Ask>(key);
  if (saved?.lastId === id) return true;
  const ask = saved && rejected(store, saved.lastId) ? { ...saved, count: saved.count - 1 } : saved;
  const firstAt = ask ? Math.max(ask.firstAt, store.get<number>(`acceptedAt:${ask.lastId}`) ?? ask.firstAt) : now;
  if (ask && ask.count > 0 && (ask.count >= 2 || held(store, ask.lastId) || now - firstAt < DAY)) {
    toolLog({ component: "telegram", kind: "event", name: "tg.dedupe", ok: true,
      ids: { operation: id, key }, props: { action: "check", deduped: true, count: ask.count } });
    return false;
  }
  store.set(key, { firstAt: ask?.count ? firstAt : now, count: (ask?.count ?? 0) + 1, lastId: id } satisfies Ask);
  store.set(`notice-ask-id:${id}`, key);
  return true;
}

/** Pending operations from an older installation also pass through the ask limit at dispatch. */
export function allowQueuedAsk(store: Store, item: OutboxRecord, now = Date.now()): boolean {
  if (item.kind !== "notification") return true;
  const envelope = /^\[([^\]\n]+)\] ([\s\S]*)$/.exec(item.text);
  const identity = envelope ? boardAskKey(envelope[1]!, envelope[2]!) : undefined;
  const key = store.get<string>(`notice-ask-id:${item.id}`) ?? (identity ? `notice-ask:${hash(identity)}` : undefined);
  return key === undefined || store.db.transaction(() => reserveAsk(store, key, item.id, now)).immediate();
}

/** Admission and deferred summaries share the outbox transaction, so retries and restarts cannot double-count. */
export function enqueueNotice(store: Store, notice: Notice, now = Date.now()): boolean {
  return store.db.transaction(() => {
    const receiptKey = `notice-receipt:${notice.id}`;
    const spec = hash(JSON.stringify(notice));
    const receipt = store.get<string>(receiptKey);
    if (receipt !== undefined) {
      if (receipt !== spec) {
        toolLog({ component: "telegram", kind: "error", name: "tg.dedupe", ok: false,
          ids: { operation: notice.id, key: notice.id }, props: { action: "conflict" }, error: { tag: "tg.dedupe.noticeConflict" } });
        throw new Error("Notification content mismatch");
      }
      toolLog({ component: "telegram", kind: "event", name: "tg.dedupe", ok: true,
        ids: { operation: notice.id, key: notice.id }, props: { action: "check", deduped: true } });
      return false;
    }
    if (runCloudUp(notice.source, notice.text)) {
      store.set(receiptKey, spec);
      toolLog({ component: "telegram", kind: "event", name: "tg.dedupe", ok: true,
        ids: { operation: notice.id, key: notice.id }, props: { action: "cancel", deduped: true } });
      return false;
    }
    // Pre-policy operations retain their immutable identity on retry.
    const existing = store.getOperation(notice.id);
    if (existing) {
      if (existing.kind !== "notification" || existing.attachment || existing.keyboard || existing.replyTo !== undefined
        || redact(existing.text) !== redact(`[${notice.source}] ${notice.text}`)) {
        toolLog({ component: "telegram", kind: "error", name: "tg.dedupe", ok: false,
          ids: { operation: notice.id, key: notice.id }, props: { action: "conflict" }, error: { tag: "tg.dedupe.noticeConflict" } });
        throw new Error("Notification content mismatch");
      }
      store.set(receiptKey, spec);
      toolLog({ component: "telegram", kind: "event", name: "tg.dedupe", ok: true,
        ids: { operation: notice.id, key: notice.id }, props: { action: "check", deduped: true } });
      return false;
    }
    const askKey = notice.askKey ?? boardAskKey(notice.source, notice.text);
    if (askKey !== undefined) {
      const key = `notice-ask:${hash(askKey)}`;
      if (!reserveAsk(store, key, notice.id, now)) {
        store.set(receiptKey, spec);
        return false;
      }
    }
    if (notice.burstKey !== undefined) {
      flushBursts(store, now);
      const key = `notice-burst:${hash(JSON.stringify([notice.source, notice.burstKey]))}`;
      const burst = store.get<Burst>(key);
      if (burst && !rejected(store, burst.lastId) && (held(store, burst.lastId) || now < burstDeadline(store, burst))) {
        store.set(key, { ...burst, count: burst.count + 1, latest: notice.text });
        store.set(receiptKey, spec);
        toolLog({ component: "telegram", kind: "event", name: "tg.dedupe", ok: true,
          ids: { operation: notice.id, key }, props: { action: "coalesce", deduped: true, count: burst.count + 1 } });
        return false;
      }
      const count = burst && rejected(store, burst.lastId) ? burst.count + burst.lastTotal : 0;
      store.set(key, { source: notice.source, nextAt: now + HOUR, count,
        latest: notice.text, includesFirst: true, lastId: notice.id, lastTotal: 1, carried: count > 0 } satisfies Burst);
    }
    const created = store.enqueue({ id: notice.id, kind: "notification", text: `[${notice.source}] ${notice.text}` });
    if (created) saveLogSeverity(store, notice.id, notice.severity);
    store.set(receiptKey, spec);
    return created;
  }).immediate();
}

/** Called by the delivery tick even when no further failure arrives. */
export function flushBursts(store: Store, now = Date.now()): void {
  store.db.transaction(() => {
    const rows = store.db.query<{ key: string; value: string }, []>(
      "SELECT key, value FROM kv WHERE key >= 'notice-burst:' AND key < 'notice-burst;'",
    ).all();
    for (const row of rows) {
      const burst = JSON.parse(row.value) as Burst;
      if (held(store, burst.lastId) || now < burstDeadline(store, burst) || burst.count === 0) continue;
      const total = burst.count + (rejected(store, burst.lastId) ? burst.lastTotal : Number(burst.includesFirst));
      const id = `${row.key}:${burst.nextAt}`;
      const period = burst.carried ? "in this failure burst"
        : now - burst.nextAt < 60_000 ? "in the last hour" : "since the last alert";
      store.enqueue({ id, kind: "notification",
        text: redact(`[${burst.source}] ${total} ${total === 1 ? "failure" : "failures"} ${period}, latest: ${burst.latest}`) });
      saveLogSeverity(store, id, "error");
      store.set(row.key, { ...burst, nextAt: now + HOUR, count: 0, includesFirst: false, lastId: id,
        lastTotal: total, carried: false });
      toolLog({ component: "telegram", kind: "event", name: "tg.dedupe", ok: true,
        ids: { operation: id, key: row.key }, props: { action: "coalesce", deduped: true, count: total, state: "queued" } });
    }
  }).immediate();
}
