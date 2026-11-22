import { redact } from "./redact.ts";
import type { Store } from "./store.ts";
import { toolLog } from "./toollog.ts";

export type AskDetail = {
  cardId: string; boardName?: string; title?: string; text: string;
  blocking: boolean; kind?: string; closedAt: string | null; answer?: unknown;
};
export type AskLookup = (key: string, signal?: AbortSignal) => Promise<AskDetail | undefined>;
export type Admission = { digest: true; ask: AskDetail; drop?: never } | { drop: true; digest?: never } | undefined;
export type DigestItem = {
  askKey: string; cardId: string; board: string; title: string; kind?: string; queuedAt: number; revision: number;
  noticeId: string; source: string; text: string; severity: string;
};
export const parseAskKey = (key: string) => {
  const match = /^([a-z0-9-]+):(\d+):(q\d+)$/.exec(key.toLowerCase());
  return match ? { board: match[1]!, card: match[2]!, ask: match[3]! } : undefined;
};

export function validateAsk(value: unknown): AskDetail {
  if (!value || typeof value !== "object") throw new Error("ask_shape");
  const ask = value as Partial<AskDetail>;
  if (typeof ask.cardId !== "string" || !/^card-[a-zA-Z0-9-]+$/.test(ask.cardId)
    || typeof ask.text !== "string" || typeof ask.blocking !== "boolean"
    || !(ask.closedAt === null || (typeof ask.closedAt === "string" && Number.isFinite(Date.parse(ask.closedAt))))
    || (ask.title !== undefined && typeof ask.title !== "string")
    || (ask.boardName !== undefined && typeof ask.boardName !== "string")
    || (ask.kind !== undefined && typeof ask.kind !== "string")) throw new Error("ask_shape");
  return ask as AskDetail;
}
const closed = (ask: AskDetail) => ask.closedAt !== null || ask.answer != null;
const blocking = (ask: AskDetail) => ask.blocking && ask.kind !== "notice";
export const digestLabel = (text: string) => Array.from(redact(text).replace(/\s+/g, " ").trim()).slice(0, 90).join("");

function digestLog(action: string, props: Record<string, unknown> = {}, tag?: string) {
  toolLog({ component: "telegram", name: "tg.digest", kind: tag ? "error" : "event", ok: !tag,
    props: { action, ...props }, ...(tag ? { error: { tag } } : {}) });
}

// The deadline covers injected lookups too, including ones that ignore AbortSignal.
async function boundedLookup(lookup: AskLookup, key: string, signal: AbortSignal) {
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const value = await Promise.race([Promise.resolve().then(() => lookup(key, signal)), aborted]);
    return value === undefined ? undefined : validateAsk(value);
  } finally { signal.removeEventListener("abort", onAbort); }
}

export async function classifyAsk(key: string | undefined, lookup?: AskLookup): Promise<Admission> {
  if (!key || !parseAskKey(key)) return;
  try {
    if (!lookup) throw new Error("lookup_unavailable");
    const ask = await boundedLookup(lookup, key.toLowerCase(), AbortSignal.timeout(3_000));
    if (!ask || closed(ask)) {
      digestLog("dropClosed");
      return { drop: true };
    }
    return blocking(ask) ? undefined : { digest: true, ask };
  } catch (error) {
    const tag = error instanceof Error && error.message === "ask_shape" ? "tg.digest.shape"
      : error instanceof Error && error.name === "TimeoutError" ? "tg.digest.timeout" : "tg.digest.lookup";
    digestLog("classifyFailed", {}, tag);
    return;
  }
}

const DAY = 86_400_000;
export function latestDigestSlot(now: number): number {
  const midnight = Math.floor(now / DAY) * DAY;
  for (const hour of [15, 10, 5]) {
    const slot = midnight + hour * 3_600_000;
    if (slot <= now) return slot;
  }
  return midnight - DAY + 15 * 3_600_000;
}

export function formatDigest(items: DigestItem[], slot: number): { text: string; boards: number; truncated: number } {
  const groups = new Map<string, DigestItem[]>();
  for (const item of items) groups.set(item.board, [...(groups.get(item.board) ?? []), item]);
  const boards = [...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const hour = String((new Date(slot).getUTCHours() + 4) % 24).padStart(2, "0");
  const header = `[Robob] Asks digest, ${hour}:00 Dubai: ${items.length} open (${boards.length} boards)`;
  const footer = "\nAll: https://robob.tail/needs-you";
  const blocks = boards.map(([board, entries]) => ({ board, entries: entries.sort((a, b) => b.queuedAt - a.queuedAt || a.askKey.localeCompare(b.askKey)), lines: [] as string[] }));
  const render = () => header + blocks.map(({ board, entries, lines }) =>
    `\n\n${board}\n` + lines.join("\n") + (lines.length < entries.length ? `${lines.length ? "\n" : ""}+${entries.length - lines.length} more on ${board}` : "")).join("") + footer;
  // Reserve all overflow summaries first, then spend the remaining budget on newest asks in board order.
  for (const block of blocks) {
    for (const item of block.entries) {
      const identity = parseAskKey(item.askKey)!;
      block.lines.push(`• #${identity.card} ${digestLabel(item.title || item.text)} — https://robob.tail/needs-you?ask=${item.cardId}:${identity.ask}`);
      if (render().length >= 3_800) { block.lines.pop(); break; }
    }
  }
  let text = render();
  // An extreme number of boards can exhaust the budget even without individual lines.
  while (text.length >= 3_800 && blocks.length) {
    blocks.pop();
    const omitted = items.length - blocks.reduce((n, b) => n + b.entries.length, 0);
    text = render().slice(0, -footer.length) + `\n+${omitted} more boards' asks` + footer;
  }
  const shown = blocks.reduce((n, b) => n + b.lines.length, 0);
  return { text, boards: boards.length, truncated: items.length - shown };
}

export async function flushDigest(store: Store, now: number, lookup: AskLookup): Promise<void> {
  const slot = latestDigestSlot(now);
  if ((store.get<number>("digest-last-slot") ?? -Infinity) >= slot) return;
  const rows = store.db.query<{ key: string; value: string }, []>(
    "SELECT key, value FROM kv WHERE key >= 'digest-item:' AND key < 'digest-item;'",
  ).all().map(row => ({ ...row, item: JSON.parse(row.value) as DigestItem }))
    .filter(row => row.item.queuedAt <= slot);
  if (!rows.length) return;
  const signal = AbortSignal.timeout(3_000);
  const results = new Map<string, AskDetail | undefined>();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, rows.length) }, async () => {
    while (next < rows.length && !signal.aborted) {
      const row = rows[next++]!;
      try { results.set(row.key, await boundedLookup(lookup, row.item.askKey, signal)); }
      catch { digestLog("classifyFailed", {}, "tg.digest.refresh"); }
    }
  }));
  store.db.transaction(() => {
    if ((store.get<number>("digest-last-slot") ?? -Infinity) >= slot) return;
    let dropped = 0;
    let promoted = 0;
    const included: DigestItem[] = [];
    for (const row of rows) {
      const item = store.get<DigestItem>(row.key);
      if (!item || item.queuedAt > slot) continue;
      // A newer admission already classified this ask as digestible. Keep its latest text
      // in this slot instead of delaying it or applying an older lookup's state.
      const refreshed = JSON.stringify(item) === row.value && results.has(row.key);
      const ask = refreshed ? results.get(row.key) : undefined;
      if (refreshed && (!ask || closed(ask))) {
        store.db.query("DELETE FROM kv WHERE key = ?").run(row.key);
        dropped++;
      } else if (ask && blocking(ask)) {
        store.enqueue({ id: item.noticeId, kind: "notification", text: `[${item.source}] ${item.text}` });
        store.set(`ask-timing-key:${item.noticeId}`, item.askKey);
        store.set(`log:severity:${item.noticeId}`, item.severity);
        store.db.query("DELETE FROM kv WHERE key = ?").run(row.key);
        promoted++;
      } else {
        included.push(ask ? { ...item, title: digestLabel(ask.title || ask.text), kind: ask.kind } : item);
      }
    }
    const id = `digest:${slot}`;
    const formatted = formatDigest(included, slot);
    if (included.length) {
      store.enqueue({ id, kind: "notification", text: formatted.text });
      store.set(`log:severity:${id}`, "info");
      store.set(`ask-timing-keys:${id}`, included.map(item => item.askKey));
      for (const item of included) {
        // Keep the ask's reservation tied to the operation that actually delivers it.
        const reservation = store.get<string>(`notice-ask-id:${item.noticeId}`);
        if (reservation) {
          const saved = store.get<Record<string, unknown>>(reservation);
          if (saved) store.set(reservation, { ...saved, lastId: id });
        }
        store.db.query("DELETE FROM kv WHERE key = ?").run(`digest-item:${item.askKey}`);
      }
    }
    store.set("digest-last-slot", slot);
    digestLog("flush", { slot, items: included.length, boards: formatted.boards, dropped, promoted,
      chars: included.length ? formatted.text.length : 0, truncated: formatted.truncated });
  }).immediate();
}
