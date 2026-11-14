import type { LogLine } from "./toollog.ts";
import { percentiles } from "./log-calls.ts";

export function createChainAggregation() {
  const chainsById = new Map<string, { chat: string; received?: number; started?: number; replied?: number }>();
  function accept(line: LogLine, followupOnly = false) {
    const field = line.name === "msg.received" ? "received" : line.name === "turn.start" ? "started" : line.name === "reply.sent" && line.ok === true ? "replied" : undefined;
    const chat = line.ids?.chat;
    const id = field === "received" ? line.ids?.messageId : line.ids?.inboundId;
    if (followupOnly && (field === "received" || !chainsById.has(`${chat}\0${id}`))) return;
    const at = Date.parse(line.ts);
    if (!field || !chat || !id || !Number.isFinite(at)) return;
    const key = `${chat}\0${id}`;
    const item = chainsById.get(key) ?? { chat };
    item[field] = Math.min(item[field] ?? Infinity, at);
    chainsById.set(key, item);
  }
  function merge(target: Map<number, number>, values: Iterable<[number, number]>) {
    for (const [ms, count] of values) target.set(ms, (target.get(ms) ?? 0) + count);
  }
  function summary(day?: string) {
    const chainStats = new Map<string, { received: number; turnStarted: number; replySent: number; completed: number; starts: Map<number, number>; replies: Map<number, number> }>();
    for (const item of chainsById.values()) {
      if (item.received === undefined || (day && new Date(item.received).toISOString().slice(0, 10) !== day)) continue;
      const stats = chainStats.get(item.chat) ?? { received: 0, turnStarted: 0, replySent: 0, completed: 0, starts: new Map(), replies: new Map() };
      stats.received++;
      const started = item.started !== undefined && item.started >= item.received;
      const replied = item.replied !== undefined && item.replied >= item.received;
      if (started) { stats.turnStarted++; merge(stats.starts, [[item.started! - item.received, 1]]); }
      if (replied) { stats.replySent++; merge(stats.replies, [[item.replied! - item.received, 1]]); }
      if (started && replied) stats.completed++;
      chainStats.set(item.chat, stats);
    }
    return Object.fromEntries([...chainStats].map(([chat, { starts, replies, ...stats }]) => [chat, {
      ...stats,
      ...(starts.size ? { receivedToStartMs: percentiles(starts) } : {}),
      ...(replies.size ? { receivedToReplyMs: percentiles(replies) } : {}),
    }]));
  }
  return { accept, summary };
}
