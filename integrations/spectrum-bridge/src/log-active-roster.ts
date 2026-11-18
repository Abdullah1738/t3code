import type { LogLine } from "./toollog.ts";

export const ROSTER_ACTIONS = ["fetches", "startup", "roster_event", "safety", "stream_down", "incomplete", "error_retry", "joins", "hits", "patches", "misses", "streamUp", "streamDown", "errors", "children", "duration"] as const;
const COUNTS = [...ROSTER_ACTIONS.filter(key => key !== "duration"), "rows", "total", "fetchMsP50", "fetchMsMax", "generation", "lastFetchAt", "retryAt"];

/** Health and log fields are code-owned scalars; no thread/event payload crosses this boundary. */
export function cleanRosterHealth(value: unknown): Record<string, string | number | boolean | null> | undefined {
  if (!value || typeof value !== "object") return;
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, field] of Object.entries(value)) {
    if (COUNTS.includes(key) && typeof field === "number" && Number.isFinite(field) && field >= 0) result[key] = field;
    else if (["complete", "streamHealthy"].includes(key) && typeof field === "boolean") result[key] = field;
    else if (key === "lastFetchReason" && (field === null || typeof field === "string" && ["startup", "roster_event", "safety", "stream_down", "incomplete", "error_retry"].includes(field))) result[key] = field;
    else if (key === "lastFetchAt" && field === null) result[key] = field;
  }
  return result;
}

export function createRosterAggregation() {
  let group: LogLine | undefined;
  let durations = new Map<number, number>();
  function flush(before = Infinity): LogLine[] {
    if (!group || Date.parse(group.ts) >= before) return [];
    const output = group;
    const sorted = [...durations].sort((a, b) => a[0] - b[0]);
    const halfway = Math.ceil([...durations.values()].reduce((a, b) => a + b, 0) / 2);
    let seen = 0;
    output.props!.fetchMsP50 = sorted.find(([, count]) => (seen += count) >= halfway)?.[0] ?? 0;
    output.props!.fetchMsMax = sorted.at(-1)?.[0] ?? 0;
    group = undefined; durations = new Map();
    return [output];
  }
  function accept(line: LogLine): LogLine[] {
    const minute = Math.floor(Date.parse(line.ts) / 60_000) * 60_000;
    const output = flush(line.name === "bridge.stop" ? Infinity : minute);
    if (line.component !== "robob" || line.name !== "robob.roster_action") return [...output, line];
    if (!group) group = { ts: new Date(minute).toISOString(), tool: "imessage", component: "robob", kind: "perf", name: "robob.active_roster", ids: line.ids,
      props: Object.fromEntries(ROSTER_ACTIONS.filter(key => key !== "duration").map(key => [key, 0])) };
    const key = String(line.props?.rosterAction);
    if (key === "duration") {
      const ms = Math.min(86_400_000, Math.round(line.durationMs ?? 0));
      durations.set(ms, (durations.get(ms) ?? 0) + 1);
    } else if (ROSTER_ACTIONS.includes(key as typeof ROSTER_ACTIONS[number])) group.props![key] = Number(group.props![key] ?? 0) + 1;
    group.props!.rows = Number(line.props?.rows ?? 0);
    group.props!.total = Number(line.props?.total ?? 0);
    return output;
  }
  return { accept, flush };
}
