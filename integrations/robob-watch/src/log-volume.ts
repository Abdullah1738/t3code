import { timingKeys } from "./log-format.ts";
export { expandTelemetry } from "./log-format.ts";
export type TelemetryRow = {
  ts: string; tool: string; component: string; kind: "event" | "perf" | "error"; name: string;
  durationMs?: number; ok?: boolean; ids?: Record<string, string>; props?: Record<string, unknown>;
  error?: { tag: string; message: string };
  v?: number;
};
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const ms = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
type Pending = { start: TelemetryRow; written: boolean; holds: TelemetryRow[] };

// Keep unfinished/skipped runs bounded. Long checks and pending checks retain their own slot records.
export class LogCompactor {
  private slots = new Map<string, Pending>();
  constructor(private readonly write: (row: TelemetryRow) => void) {}
  private flushSlot(key: string, slot: Pending): void {
    if (!slot.written) this.write(packTelemetry(slot.start));
    for (const hold of slot.holds) this.write(packTelemetry(hold));
    this.slots.delete(key);
  }
  flush(at: number, force = false): void {
    for (const [key, slot] of this.slots) {
      const start = Date.parse(slot.start.ts), interval = slot.start.props?.intervalMs;
      if (force || !ms(interval) || at - start > interval || new Date(at).toISOString().slice(0, 10) !== slot.start.ts.slice(0, 10)) this.flushSlot(key, slot);
    }
  }
  push(row: TelemetryRow): void {
    this.flush(Date.parse(row.ts));
    const key = row.ids?.run && JSON.stringify([row.ids.watcher, row.ids.run]);
    const props = row.props ?? {};
    if (row.name === "slot.start" && key && props.operation === "check" && ms(props.intervalMs) && this.slots.size < 200) {
      const prior = this.slots.get(key);
      if (prior) this.flushSlot(key, prior);
      const written = ms(props.slotWaitMs) && props.slotWaitMs > 5_000;
      this.slots.set(key, { start: row, written, holds: [] });
      if (written) this.write(packTelemetry(row));
      return;
    }
    const slot = key ? this.slots.get(key) : undefined;
    if (row.name === "slot.hold" && slot && key) {
      if (slot.holds.length < 16) { slot.holds.push(row); return; }
      this.flushSlot(key, slot);
    }
    if (row.name === "watch.run" && slot && key) {
      this.slots.delete(key);
      row = { ...row, props: { ...props, slotAt: Date.parse(slot.start.ts),
        ...(slot.written ? { slotWritten: true } : {}),
        ...(slot.holds.length === 1 ? { holdMs: slot.holds[0]!.durationMs, holdAt: Date.parse(slot.holds[0]!.ts) }
          : slot.holds.length ? { holdParts: slot.holds.map(hold => [Date.parse(hold.ts), hold.durationMs]) } : {}) } };
    }
    this.write(packTelemetry(compactHelper(row)));
  }
}

// Versioned defaults apply only to compact helper records; old and failed records keep their shape.
export function compactHelper(row: TelemetryRow): TelemetryRow {
  if (row.name !== "helper.run" || row.ok !== true) return row;
  const props = { ...row.props }, ids = { ...row.ids };
  if (props.exitCode !== 0) return row;
  delete props.exitCode;
  const defaults: string[] = [];
  if (props.signal === null) { delete props.signal; defaults.push("s"); }
  if (props.timedOut === false) { delete props.timedOut; defaults.push("t"); }
  if (ids.watcher !== undefined && ids.watcher === ids.helper) { delete ids.watcher; defaults.push("w"); }
  return { ...row, ok: undefined, ids, props: { ...props, compact: defaults.join("") || "1" } };
}

// v1 omits the fixed envelope on frequent perf records and packs their numeric timing keys.
// The name is still readable; both the daily reader and replay restore the ordinary schema.
export function packTelemetry(row: TelemetryRow): TelemetryRow {
  const component = row.name === "watch.run" || row.name.startsWith("slot.") ? "runner" : row.name === "helper.run" ? "helpers" : undefined;
  if (!component || row.kind !== "perf") return row;
  const props = { ...row.props };
  if (row.name !== "helper.run" && timingKeys.some(key => key in props)) {
    let mask = 0;
    const timing: unknown[] = [];
    timingKeys.forEach((key, i) => { if (key in props) { mask |= 1 << i; timing.push(props[key]); } });
    props.timing = [mask, ...timing];
    for (const key of timingKeys) delete props[key];
  }
  const ids = Object.fromEntries(Object.entries(row.ids ?? {}).map(([key, value]) => [key === "watcher" ? "w" : key === "run" ? "r" : key === "helper" ? "h" : key, value]));
  const result: Record<string, unknown> = { ...row, ids, props, v: 1 };
  delete result.tool;
  delete result.kind;
  if (row.component === component) delete result.component;
  return result as TelemetryRow;
}
