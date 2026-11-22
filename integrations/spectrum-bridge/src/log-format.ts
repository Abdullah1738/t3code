const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const ms = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8.64e15;
export const timingKeys = ["slotWaitMs", "slotQueueDepth", "slotActiveAtEnqueue", "startLateMs", "intervalMs", "queuedMs", "outcome", "exitCode", "signal", "timedOut", "dueAt", "lateMs", "lane", "loadMode", "trigger"] as const;
export function unpackTelemetry(row: Record<string, unknown>): Record<string, unknown> {
  if (row.v !== 1 || typeof row.name !== "string" || !(row.name === "watch.run" || row.name === "helper.run" || row.name.startsWith("slot."))) return row;
  const props = { ...record(row.props) };
  const timing = props.timing;
  if (Array.isArray(timing)) {
    const mask = timing[0];
    if (typeof mask === "number" && Number.isSafeInteger(mask) && mask >= 0 && mask < 1 << timingKeys.length) {
      let at = 1;
      timingKeys.forEach((key, i) => { if (mask & 1 << i) props[key] = timing[at++]; });
    }
    delete props.timing;
  }
  const ids = Object.fromEntries(Object.entries(record(row.ids)).map(([key, value]) => [key === "w" ? "watcher" : key === "r" ? "run" : key === "h" ? "helper" : key, value]));
  const { v, ...rest } = row;
  return { tool: "watchers", component: row.name === "helper.run" ? "helpers" : "runner", kind: "perf", ...rest, ids, props };
}

// Expand logical samples before aggregation so existing daily and window reports remain comparable.
export function expandTelemetry(input: Record<string, unknown>): Record<string, unknown>[] {
  let row = unpackTelemetry(input);
  const props = record(row.props), ids = record(row.ids);
  if (row.name === "helper.run" && typeof props.compact === "string" && /^(?:s?t?w?|1)$/.test(props.compact)) {
    const { compact, ...rest } = props;
    row = { ...row, ok: true, ids: { ...ids, ...(compact.includes("w") ? { watcher: ids.helper } : {}) },
      props: { ...rest, exitCode: 0, ...(compact.includes("s") ? { signal: null } : {}), ...(compact.includes("t") ? { timedOut: false } : {}) } };
  }
  if (row.name !== "watch.run" || !ms(props.slotAt)) return [row];
  const slot = { tool: row.tool, component: "runner", kind: "perf", ids: row.ids };
  const rows: Record<string, unknown>[] = [];
  if (props.slotWritten !== true) rows.push({ ...slot, ts: new Date(props.slotAt).toISOString(), name: "slot.start",
    props: Object.fromEntries(["slotWaitMs", "slotQueueDepth", "slotActiveAtEnqueue", "startLateMs", "intervalMs"].map(key => [key, props[key]]).concat([["operation", "check"]])) });
  const parts = ms(props.holdMs) && ms(props.holdAt) ? [[props.holdAt, props.holdMs]] : Array.isArray(props.holdParts) ? props.holdParts.slice(0, 16) : [];
  for (const part of parts) if (Array.isArray(part) && ms(part[0]) && ms(part[1])) rows.push({ ...slot, ts: new Date(part[0]).toISOString(), name: "slot.hold", durationMs: part[1], props: { operation: "check", lane: props.lane ?? "slow" } });
  rows.push(row);
  return rows;
}
