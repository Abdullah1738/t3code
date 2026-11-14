import { createHash, randomUUID } from "node:crypto";
import type { LogLine } from "./toollog.ts";

const CALLS: Record<string, string> = {
  "GET /health": "health", "GET /projects": "projects", "GET /threads": "threads",
  "POST /threads": "createThread", "GET /threads/:id": "thread", "PATCH /threads/:id": "settle",
  "GET /threads/by-native/:id": "byNative", "GET /threads/:id/messages": "messages",
  "GET /threads/:id/runs/:id/evidence": "runEvidence", "POST /threads/:id/requests/:id/respond": "respond",
  "POST /attachments": "attachment", "PUT /threads/:id/origin": "origin",
  "POST /threads/:id/send": "send", "POST /threads/:id/interrupt": "interrupt",
};
const NAMES = new Set(Object.values(CALLS));
const MAX_MS = 86_400_000;
export type CallStats = { count: number; ok: number; failed: number; p50: number; p95: number; max: number; histogram: [number, number][] };
export type CallSummary = Record<string, CallStats>;

export function callName(line: LogLine): string | undefined {
  return CALLS[`${line.props?.method} ${line.props?.route}`];
}

export function percentiles(histogram: Map<number, number>) {
  const values = [...histogram].sort((a, b) => a[0] - b[0]);
  const count = values.reduce((sum, [, n]) => sum + n, 0);
  const at = (fraction: number) => {
    let seen = 0;
    for (const [ms, n] of values) { seen += n; if (seen >= Math.ceil(count * fraction)) return ms; }
    return 0;
  };
  return { p50: at(.5), p95: at(.95), max: values.at(-1)?.[0] ?? 0 };
}

export function cleanCalls(value: unknown): CallSummary | undefined {
  if (!value || typeof value !== "object") return;
  const result: CallSummary = {};
  for (const [name, input] of Object.entries(value)) {
    if (!NAMES.has(name) || !input || typeof input !== "object") continue;
    const stats = input as Partial<CallStats>;
    if (!Number.isSafeInteger(stats.ok) || !Number.isSafeInteger(stats.failed) || stats.ok! < 0 || stats.failed! < 0
      || stats.ok! + stats.failed! < 1 || stats.ok! + stats.failed! > 10_000_000 || !Array.isArray(stats.histogram) || stats.histogram.length > 100_000) continue;
    const histogram = new Map<number, number>();
    for (const pair of stats.histogram) {
      if (!Array.isArray(pair) || pair.length !== 2) continue;
      const [ms, count] = pair;
      if (Number.isSafeInteger(ms) && ms >= 0 && ms <= MAX_MS && Number.isSafeInteger(count) && count > 0 && count <= 10_000_000) histogram.set(ms, (histogram.get(ms) ?? 0) + count);
    }
    const count = [...histogram.values()].reduce((a, b) => a + b, 0);
    if (count !== stats.ok! + stats.failed!) continue;
    result[name] = { count, ok: stats.ok!, failed: stats.failed!, ...percentiles(histogram), histogram: [...histogram] };
  }
  if (Object.keys(result).length) return result;
}

type Group = { ids: Record<string, string>; ts: string; calls: Map<string, { ok: number; failed: number; histogram: Map<number, number> }> };

export function createCallAggregation(processRunId: string) {
  const active = new Map<string, { runId: string; messageId?: string }>();
  const groups = new Map<string, Group>();
  let day = "";
  const turnId = (thread: string, message: string) => createHash("sha256").update(thread).update("\0").update(message).digest("hex").slice(0, 32);
  function ids(threadId?: string): Record<string, string> {
    return { runId: threadId ? active.get(threadId)?.runId ?? processRunId : processRunId, ...(threadId ? { threadId } : {}) };
  }
  function flush(runId?: string): LogLine[] {
    const lines: LogLine[] = [];
    for (const [key, group] of groups) {
      if (runId && key !== runId) continue;
      const calls: CallSummary = {};
      for (const [name, stats] of group.calls) calls[name] = {
        count: stats.ok + stats.failed, ok: stats.ok, failed: stats.failed,
        ...percentiles(stats.histogram), histogram: [...stats.histogram],
      };
      lines.push({ ts: group.ts, tool: "imessage", component: "robob", kind: "perf", name: "turn.robob_calls", ids: group.ids, calls });
      groups.delete(key);
    }
    return lines;
  }
  function accept(line: LogLine, explicitRun: boolean): LogLine[] {
    const output: LogLine[] = [];
    if (day && day !== line.ts.slice(0, 10)) output.push(...flush());
    day = line.ts.slice(0, 10);
    const thread = line.ids?.threadId;
    if (line.name === "turn.start" && thread) {
      const current = active.get(thread);
      if (!current || current.messageId !== line.ids?.messageId) {
        if (current) output.push(...flush(current.runId));
        active.set(thread, { runId: line.ids?.messageId ? turnId(thread, line.ids.messageId) : randomUUID(), messageId: line.ids?.messageId });
      }
    }
    if (!explicitRun && thread) {
      const ending = line.name === "turn.end" && line.ids?.messageId ? turnId(thread, line.ids.messageId) : undefined;
      line.ids = { ...line.ids, ...ids(thread), ...(ending ? { runId: ending } : {}) };
    }
    if (line.component === "robob" && line.kind === "perf" && line.name === "turn.robob_call" && line.durationMs !== undefined && typeof line.ok === "boolean") {
      const name = callName(line);
      if (name && line.durationMs <= MAX_MS) {
        const runId = line.ids?.runId ?? processRunId;
        let group = groups.get(runId);
        if (!group) {
          group = { ids: { ...(runId === processRunId ? {} : line.ids), runId, callBatchId: randomUUID() }, ts: line.ts, calls: new Map() };
          groups.set(runId, group);
        }
        group.ts = line.ts;
        const stats = group.calls.get(name) ?? { ok: 0, failed: 0, histogram: new Map<number, number>() };
        if (line.ok) stats.ok++; else stats.failed++;
        // Millisecond bins merge exactly across turns and days without keeping raw fast calls.
        const ms = Math.round(line.durationMs);
        stats.histogram.set(ms, (stats.histogram.get(ms) ?? 0) + 1);
        group.calls.set(name, stats);
        line.ids = { ...line.ids, callBatchId: group.ids.callBatchId! };
        if (line.durationMs <= 1_000 && line.ok) return output;
      }
    }
    if (line.name === "turn.end") {
      output.push(...flush(line.ids?.runId));
      if (thread && active.get(thread)?.runId === line.ids?.runId) active.delete(thread);
    }
    if (line.name === "bridge.stop") { output.push(...flush()); active.clear(); }
    output.push(line);
    return output;
  }
  return { accept, flush, ids };
}
