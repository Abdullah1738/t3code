import type { LogLine } from "./toollog.ts";
import { callName, percentiles } from "./log-calls.ts";

export async function summarizeLog(lines: AsyncIterable<LogLine>) {
  const countsByName: Record<string, number> = Object.create(null);
  const countsByKind: Record<string, number> = { event: 0, perf: 0, error: 0 };
  const durations = new Map<string, Map<number, number>>();
  const components = new Map<string, Map<string, { count: number; ok: number; failed: number; histogram: Map<number, number> }>>();
  const errors = new Map<string, { tag: string; name: string; count: number; sampleId?: string; site?: string }>();
  const represented = new Set<string>();
  const individualCalls: LogLine[] = [];
  let total = 0, ok = 0, failed = 0, recordedRows = 0;
  function merge(target: Map<number, number>, values: Iterable<[number, number]>) {
    for (const [ms, count] of values) target.set(ms, (target.get(ms) ?? 0) + count);
  }
  function component(component: string, name: string, count: number, oks: number, failures: number, histogram: Iterable<[number, number]>) {
    const names = components.get(component) ?? new Map();
    const stats = names.get(name) ?? { count: 0, ok: 0, failed: 0, histogram: new Map<number, number>() };
    stats.count += count; stats.ok += oks; stats.failed += failures; merge(stats.histogram, histogram);
    names.set(name, stats); components.set(component, names);
  }
  function consume(line: LogLine, count = 1, oks = Number(line.ok === true), failures = Number(line.ok === false), histogram?: Iterable<[number, number]>) {
    total += count; ok += oks; failed += failures;
    countsByName[line.name] = (countsByName[line.name] ?? 0) + count;
    countsByKind[line.kind] += count;
    const values = histogram ? [...histogram] : line.durationMs === undefined ? [] : [[Math.round(line.durationMs), 1] as [number, number]];
    if (values.length) {
      const all = durations.get(line.name) ?? new Map<number, number>();
      merge(all, values); durations.set(line.name, all);
    }
    component(line.component, line.name, count, oks, failures, values);
    if (line.name === "turn.robob_call") {
      const name = callName(line);
      if (name) component("robob", name, count, oks, failures, values);
    }
    if (line.error) {
      const name = "name" in line.error && typeof line.error.name === "string" ? line.error.name : "UnknownError";
      const key = `${line.error.tag}\0${name}`;
      const item = errors.get(key) ?? { tag: line.error.tag, name, count: 0,
        sampleId: line.ids?.messageId ?? line.ids?.operationId ?? line.ids?.threadId ?? line.ids?.formId ?? line.ids?.runId,
        ...("site" in line && typeof line.site === "string" ? { site: line.site } : {}) };
      item.count++; errors.set(key, item);
    }
  }
  for await (const line of lines) {
    recordedRows++;
    if (line.name === "turn.robob_calls" && line.calls) {
      for (const [name, stats] of Object.entries(line.calls)) {
        if (line.ids?.callBatchId) represented.add(`${line.ids.callBatchId}\0${name}`);
        consume({ ...line, name: "turn.robob_call", calls: undefined }, stats.count, stats.ok, stats.failed, stats.histogram);
        component("robob", name, stats.count, stats.ok, stats.failed, stats.histogram);
      }
    } else if (line.name === "turn.robob_call" && line.kind === "perf") individualCalls.push(line);
    else consume(line);
  }
  // Slow/failed rows remain readable, but their batch histogram already counts them.
  for (const line of individualCalls) if (!line.ids?.callBatchId || !represented.has(`${line.ids.callBatchId}\0${callName(line)}`)) consume(line);
  const durationMs: Record<string, ReturnType<typeof percentiles>> = Object.create(null);
  for (const [name, histogram] of durations) durationMs[name] = percentiles(histogram);
  const byComponent: Record<string, Record<string, { count: number; ok: number; failed: number; errorRate: number; durationMs?: ReturnType<typeof percentiles> }>> = Object.create(null);
  for (const [component, names] of components) {
    byComponent[component] = Object.create(null);
    for (const [name, stats] of names) byComponent[component]![name] = {
      count: stats.count, ok: stats.ok, failed: stats.failed, errorRate: stats.count ? stats.failed / stats.count : 0,
      ...(stats.histogram.size ? { durationMs: percentiles(stats.histogram) } : {}),
    };
  }
  return { total, recordedRows, countsByName, countsByKind, ok, failed,
    okRate: ok + failed ? ok / (ok + failed) : 0, errorRate: total ? countsByKind.error / total : 0,
    durationMs, byComponent,
    topErrorTags: [...errors.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag) || a.name.localeCompare(b.name)).slice(0, 20) };
}
