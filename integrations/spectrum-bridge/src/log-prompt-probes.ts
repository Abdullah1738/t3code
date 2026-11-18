import type { LogLine } from "./toollog.ts";
import { percentiles } from "./log-calls.ts";

const outcomes = ["accepted", "notAcceptedYet", "timeout", "http", "transport"] as const;
type Outcome = typeof outcomes[number];
type Histogram = [number, number][];
export type PromptProbeStats = Record<Outcome | "calls", number> & {
  httpByStatus: Record<string, number>; elapsedMs: Histogram; attempts: Histogram; msUntilAccepted: Histogram;
};
export function emptyPromptProbe(): PromptProbeStats {
  return { calls: 0, accepted: 0, notAcceptedYet: 0, timeout: 0, http: 0, transport: 0,
    httpByStatus: {}, elapsedMs: [], attempts: [], msUntilAccepted: [] };
}
function mergeBins(target: Histogram, source: Histogram) {
  const bins = new Map(target);
  for (const [value, count] of source) bins.set(value, (bins.get(value) ?? 0) + count);
  target.splice(0, target.length, ...bins);
}
export function mergePromptProbe(target: PromptProbeStats, source: PromptProbeStats) {
  for (const field of ["calls", ...outcomes] as const) target[field] += source[field];
  for (const [status, count] of Object.entries(source.httpByStatus)) target.httpByStatus[status] = (target.httpByStatus[status] ?? 0) + count;
  for (const field of ["elapsedMs", "attempts", "msUntilAccepted"] as const) mergeBins(target[field], source[field]);
}
export function summarizePromptProbe(stats: PromptProbeStats) {
  const { elapsedMs, attempts, msUntilAccepted, ...counts } = stats;
  const summary = (bins: Histogram) => ({ count: bins.reduce((n, [, count]) => n + count, 0), ...percentiles(new Map(bins)) });
  return { ...counts, elapsedMs: summary(elapsedMs), attempts: summary(attempts), msUntilAccepted: summary(msUntilAccepted) };
}
export function cleanPromptProbe(value: unknown): PromptProbeStats | undefined {
  if (!value || typeof value !== "object") return;
  const input = value as Partial<PromptProbeStats>;
  const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 10_000_000;
  if (!["calls", ...outcomes].every(field => integer(input[field as keyof PromptProbeStats]))) return;
  if (input.calls !== outcomes.reduce((n, field) => n + input[field]!, 0)) return;
  const result = emptyPromptProbe();
  for (const field of ["calls", ...outcomes] as const) result[field] = input[field]!;
  if (!input.httpByStatus || typeof input.httpByStatus !== "object") return;
  for (const [status, count] of Object.entries(input.httpByStatus)) {
    if (!/^[1-5]\d{2}$/.test(status) || !integer(count)) return;
    result.httpByStatus[status] = count;
  }
  if (Object.values(result.httpByStatus).reduce((a, b) => a + b, 0) !== result.http) return;
  for (const field of ["elapsedMs", "attempts", "msUntilAccepted"] as const) {
    const bins = input[field];
    if (!Array.isArray(bins) || bins.length > 100_000) return;
    const counts = new Map<number, number>();
    for (const pair of bins) {
      if (!Array.isArray(pair) || pair.length !== 2 || !Number.isSafeInteger(pair[0]) || pair[0] < 0 || !integer(pair[1]) || pair[1] < 1) return;
      counts.set(pair[0], (counts.get(pair[0]) ?? 0) + pair[1]);
    }
    result[field] = [...counts];
  }
  const samples = (field: "elapsedMs" | "attempts" | "msUntilAccepted") => result[field].reduce((n, [, count]) => n + count, 0);
  if (samples("elapsedMs") !== result.calls || samples("attempts") > result.accepted || samples("attempts") !== samples("msUntilAccepted")) return;
  return result;
}
export function createPromptProbeAggregation() {
  const groups = new Map<string, LogLine>();
  function flush(before = Infinity) {
    const result: LogLine[] = [];
    for (const [key, line] of groups) if (Date.parse(line.ts) < before) { result.push(line); groups.delete(key); }
    return result;
  }
  function accept(line: LogLine): LogLine[] {
    const minute = Math.floor(Date.parse(line.ts) / 60_000) * 60_000;
    const result = flush(line.name === "bridge.stop" ? Infinity : minute);
    if (line.name !== "router.prompt_probe" || line.component !== "router" || !line.ids?.threadId) return [...result, line];
    const outcome = line.props?.probeOutcome as Outcome;
    if (!outcomes.includes(outcome)) return result;
    const key = `${minute}\0${line.ids.threadId}`;
    let group = groups.get(key);
    if (!group) {
      group = { ts: new Date(minute).toISOString(), tool: "imessage", component: "router", kind: "perf",
        name: "router.prompt_probes", ids: { threadId: line.ids.threadId }, promptProbe: emptyPromptProbe() };
      groups.set(key, group);
    }
    const stats = group.promptProbe!;
    stats.calls++; stats[outcome]++;
    mergeBins(stats.elapsedMs, [[Math.round(Number(line.props?.elapsedMs ?? 0)), 1]]);
    if (outcome === "http") {
      const status = String(line.props?.status);
      stats.httpByStatus[status] = (stats.httpByStatus[status] ?? 0) + 1;
    }
    if (outcome === "accepted" && typeof line.props?.attempt === "number" && typeof line.props.msUntilAccepted === "number") {
      mergeBins(stats.attempts, [[line.props.attempt, 1]]);
      mergeBins(stats.msUntilAccepted, [[Math.round(line.props.msUntilAccepted), 1]]);
    }
    return result;
  }
  return { accept, flush };
}
