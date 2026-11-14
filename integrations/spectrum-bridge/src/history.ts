import { formatText } from "./formatting.ts";
import { inboundTime, inboundWords } from "./group-judge.ts";
import type { NormalizedInbound } from "./photon.ts";
import type { Swipe } from "./router.ts";
import type { OutboxRecord, Store } from "./store.ts";

export type HistoryMessage = {
  id: string; at: string; from: string; text: string;
  replyTo?: { id?: string; from: string; text: string } | { unknown: true };
  thread?: string;
};
type Line = Omit<HistoryMessage, "at"> & { at: number; robob: boolean };
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
const validTime = (at: unknown): at is number => typeof at === "number" && Number.isFinite(at) && Math.abs(at) <= 8.64e15;
const synthetic = (id: string) => /^(secret:|wake:|reset:)/.test(id);
const robobText = (op: Pick<OutboxRecord, "text" | "attachment">) =>
  formatText(op.text).text || (op.attachment ? `[file: ${op.attachment.name}]` : "");

/** Reads only the chat's bridge store; resolving a missing quote never does a live lookup or caches a result. */
export function chatHistory(store: Store, nameOf: (address: string) => string, owner: string,
  query: { limit: number; before?: string } | { id: string }, ownerChat = false,
): { messages: HistoryMessage[]; more: boolean } | undefined {
  const inbound = (id: string) => {
    const row = store.db.query<{ payload: string }, [string]>("SELECT payload FROM inbound WHERE id = ?").get(id);
    return row ? JSON.parse(row.payload) as NormalizedInbound : undefined;
  };
  const from = (input: NormalizedInbound) => input.sender ? nameOf(input.sender) : ownerChat ? nameOf(owner) : "Someone";
  const replyTo = (id: string, input: NormalizedInbound): HistoryMessage["replyTo"] => {
    // This is the same per-row cache populated by the router for observed group swipes (#282).
    const swipe = store.get<Swipe>(`swipe:${id}`);
    if (swipe && swipe.kind !== "unknown") {
      if (swipe.kind === "robob") return { ...(swipe.outboxId ? { id: swipe.outboxId } : {}), from: "Robob", text: clip(formatText(swipe.text).text, 300) };
      return { from: swipe.kind === "owner" ? nameOf(owner) : nameOf(swipe.sender), text: clip(swipe.text, 300) };
    }
    if (input.threadOrigin) {
      const op = store.byProviderId(input.threadOrigin);
      if (op?.state === "sent" && (op.kind === "conversation" || op.kind === "notification")) {
        return { id: op.id, from: "Robob", text: clip(robobText(op), 300) };
      }
      const target = inbound(input.threadOrigin);
      if (target && !synthetic(input.threadOrigin) && !target.text?.startsWith("/")) {
        return { id: input.threadOrigin, from: from(target), text: clip(inboundWords(target), 300) };
      }
    }
    return input.replyTo || input.threadOrigin ? { unknown: true } : undefined;
  };
  const person = (id: string, input: NormalizedInbound): Line | undefined => {
    const at = inboundTime(input);
    if (synthetic(id) || input.text?.startsWith("/") || !validTime(at)) return;
    const text = inboundWords(input);
    if (!text) return;
    const target = replyTo(id, input);
    return { id, at, from: from(input), text: clip(text, 1000), robob: false, ...(target ? { replyTo: target } : {}) };
  };
  const robob = (op: OutboxRecord, at: unknown = store.get(`sent-at:${op.id}`)): Line | undefined => {
    if (op.state !== "sent" || (op.kind !== "conversation" && op.kind !== "notification") || !validTime(at)) return;
    const text = robobText(op);
    if (!text) return;
    return { id: op.id, at, from: "Robob", text: clip(text, 1000), robob: true, ...(op.replyTo ? { thread: op.replyTo } : {}) };
  };
  const find = (id: string) => {
    const input = inbound(id);
    if (input) return person(id, input);
    const op = store.findOutbox(id);
    return op ? robob(op) : undefined;
  };
  const output = ({ at, robob: _, ...line }: Line): HistoryMessage => ({ ...line, at: new Date(at).toISOString() });
  if ("id" in query) {
    const line = find(query.id);
    return line ? { messages: [output(line)], more: false } : undefined;
  }
  const before = query.before === undefined ? undefined : find(query.before);
  if (query.before !== undefined && !before) return;
  const until = before?.at ?? Infinity;
  const lines: Line[] = [];
  // Backfills can arrive out of sent-time order. Rank the bounded scan by time before cutting the page.
  const rows = store.db.query<{ id: string; payload: string }, []>(
    "SELECT id, payload FROM inbound ORDER BY rowid DESC LIMIT 2000",
  ).all();
  for (const row of rows) {
    const line = person(row.id, JSON.parse(row.payload) as NormalizedInbound);
    if (line && line.at < until) lines.push(line);
  }
  // A cached statement's iterator can resume after an early break on the next page.
  const sent = store.db.prepare<{ payload: string; at: number }, [number]>(
    "SELECT o.payload, CAST(k.value AS INTEGER) AS at FROM kv k JOIN outbox o ON o.id = substr(k.key, 9) "
    + "WHERE substr(k.key, 1, 8) = 'sent-at:' AND CAST(k.value AS INTEGER) < ? "
    + "AND k.value != '' AND k.value NOT GLOB '*[^0-9]*' AND o.state = 'sent' "
    + "AND json_extract(o.payload, '$.kind') IN ('conversation', 'notification') "
    + "AND (length(trim(json_extract(o.payload, '$.text'))) > 0 OR json_extract(o.payload, '$.attachment') IS NOT NULL) "
    + "ORDER BY CAST(k.value AS INTEGER) DESC, o.rowid DESC",
  );
  let kept = 0;
  try {
    for (const row of sent.iterate(until)) {
      const line = robob({ ...JSON.parse(row.payload), state: "sent" } as OutboxRecord, row.at);
      if (line) { lines.push(line); kept++; }
      if (kept === query.limit + 1) break;
    }
  } finally { sent.finalize(); }
  lines.sort((a, b) => b.at - a.at || Number(b.robob) - Number(a.robob));
  return { messages: lines.slice(0, query.limit).reverse().map(output), more: lines.length > query.limit };
}
