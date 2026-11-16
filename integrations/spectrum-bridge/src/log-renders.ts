import type { LogLine } from "./toollog.ts";

// Renderers can receive arbitrary recipient names; only configured personal slugs are diagnostic.
export function renderChat(value: unknown): string {
  return value === "owner" || value === "moni" || value === "unknown" || value === "other" ? value : value ? "other" : "unknown";
}

export function cleanRenders(value: unknown): LogLine["renders"] {
  if (!value || typeof value !== "object") return;
  const stats = value as NonNullable<LogLine["renders"]>;
  if (!Number.isSafeInteger(stats.count) || stats.count < 1 || stats.count > 10_000_000 || !Array.isArray(stats.histogram) || stats.histogram.length > 1001) return;
  const histogram: [number, number][] = [];
  for (const pair of stats.histogram) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const [ms, count] = pair;
    if (Number.isSafeInteger(ms) && ms >= 0 && ms <= 1_000 && Number.isSafeInteger(count) && count > 0 && count <= 10_000_000) histogram.push([ms, count]);
  }
  if (histogram.reduce((sum, [, n]) => sum + n, 0) === stats.count) return { count: stats.count, histogram };
}

export function createRenderAggregation() {
  const groups = new Map<string, { line: LogLine; histogram: Map<number, number>; count: number }>();
  let minute = "";
  function flush(): LogLine[] {
    const result = [...groups.values()].map(({ line, histogram, count }) => ({
      ...line, name: "card.renders", durationMs: undefined, props: { cardKind: line.props?.cardKind ?? "other" },
      renders: { count, histogram: [...histogram] },
    }));
    groups.clear();
    return result;
  }
  function accept(line: LogLine): LogLine[] {
    const output = minute && minute !== line.ts.slice(0, 16) ? flush() : [];
    minute = line.ts.slice(0, 16);
    if (line.name === "turn.end" || line.name === "bridge.stop") output.push(...flush());
    if (line.name !== "card.render" || line.ok !== true || line.kind !== "perf" || line.props?.outcome !== "ok"
      || line.durationMs === undefined || line.durationMs > 1_000) return [...output, line];
    const key = `${line.component}\0${line.props.cardKind}\0${line.ids?.chat}`;
    const group = groups.get(key) ?? { line, count: 0, histogram: new Map<number, number>() };
    const ms = Math.round(line.durationMs);
    group.count++;
    group.histogram.set(ms, (group.histogram.get(ms) ?? 0) + 1);
    groups.set(key, group);
    if (group.count >= 100 || groups.size >= 100) output.push(...flush());
    return output;
  }
  return { accept, flush };
}
