import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogCompactor, expandTelemetry, type TelemetryRow } from "../src/log-volume.ts";
import { rollup, toolLog } from "../src/toollog.ts";
const previous = process.env.TOOLLOG_DIR;
const dirs: string[] = [];
const start = Date.parse("2026-11-20T00:00:00Z");
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), "watch-volume-")); dirs.push(dir); process.env.TOOLLOG_DIR = dir; return dir; };
afterEach(() => { setSystemTime(); if (previous === undefined) delete process.env.TOOLLOG_DIR; else process.env.TOOLLOG_DIR = previous; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const row = (name: string, at: number, props: Record<string, unknown> = {}, durationMs?: number): TelemetryRow => ({ ts: new Date(start + at).toISOString(), tool: "watchers", component: "runner", kind: "perf", name, ids: { watcher: "fixture", run: "abc" }, props, ...(durationMs === undefined ? {} : { durationMs }) });
test("folded starts and multiple partial holds preserve every daily/window rollup field", async () => {
  const old = fixture(), slim = fixture();
  const timing = { slotWaitMs: 50, slotQueueDepth: 0, slotActiveAtEnqueue: 1, startLateMs: 200, intervalMs: 60_000 };
  const rows = [row("slot.start", 100, { ...timing, operation: "check" }), row("slot.hold", 500, { operation: "check", lane: "fast" }, 400), row("slot.hold", 900, { operation: "check", lane: "fast" }, 400),
    { ...row("watch.run", 910, { ...timing, queuedMs: 100, dueAt: start - 100, lateMs: 180, lane: "fast", loadMode: true, trigger: "schedule", outcome: "no_change", exitCode: 0, signal: null, timedOut: false }, 800), ok: true },
    { ...row("helper.run", 920, { exitCode: 0, signal: null, timedOut: false }, 5), component: "helpers", ids: { watcher: "fixture", helper: "fixture" }, ok: true }];
  const output: TelemetryRow[] = [], compact = new LogCompactor(row => output.push(row));
  rows.forEach(row => compact.push(row)); compact.flush(start + 1000, true);
  expect(output).toHaveLength(2);
  expect(output[0].props?.holdParts).toEqual([[start + 500, 400], [start + 900, 400]]);
  expect(JSON.stringify(output)).not.toContain('"slot.start"');
  writeFileSync(join(old, "2026-11-20.ndjson"), rows.map(row => JSON.stringify(row)).join("\n"));
  writeFileSync(join(slim, "2026-11-20.ndjson"), output.map(row => JSON.stringify(row)).join("\n"));
  expect(await rollup("2026-11-20", slim)).toEqual(await rollup("2026-11-20", old));
  const window = { since: new Date(start + 200).toISOString(), until: new Date(start + 800).toISOString() };
  expect(await rollup(window, slim)).toEqual(await rollup(window, old));
});
test.each([5000, 5001])("wait threshold %s retains prompt diagnostics only above five seconds", wait => {
  const output: TelemetryRow[] = [], compact = new LogCompactor(row => output.push(row));
  const timing = { slotWaitMs: wait, intervalMs: 60_000, operation: "check" };
  compact.push(row("slot.start", 100, timing)); expect(output.length).toBe(wait > 5000 ? 1 : 0);
  compact.push(row("watch.run", 200, timing));
  expect(output.flatMap(row => expandTelemetry(row)).filter(row => row.name === "slot.start")).toHaveLength(1);
});
test("overdue, interrupted, midnight, pending, and overflow slots fall back without unbounded state", () => {
  const output: TelemetryRow[] = [], compact = new LogCompactor(row => output.push(row));
  for (let i = 0; i < 205; i++) compact.push({ ...row("slot.start", 0, { operation: "check", intervalMs: 60_000 }), ids: { watcher: "fixture", run: String(i) } });
  expect(output).toHaveLength(5); compact.flush(start + 60_001); expect(output).toHaveLength(205);
  compact.push(row("slot.start", 86_399_000, { operation: "check", intervalMs: 60_000 }));
  compact.flush(start + 86_400_000); expect(output).toHaveLength(206);
  compact.push(row("slot.start", 86_401_000, { operation: "pending", intervalMs: 60_000 })); expect(output).toHaveLength(207);
});
test("cap keeps errors and emits one private, bounded dropped-count line each hour", () => {
  const dir = fixture(); setSystemTime(start); toolLog({ component: "runner", kind: "event", name: "start" });
  const file = join(dir, "2026-11-20.ndjson"), cap = 50 * 1024 * 1024 + 1; truncateSync(file, cap);
  for (let i = 0; i < 55; i++) toolLog({ component: "runner", kind: "perf", name: `drop.${i}`, ids: { key: "PRIVATE" } });
  const tail = () => readFileSync(file).subarray(cap).toString().trim().split("\n").map(line => JSON.parse(line));
  setSystemTime(start + 3_600_000); toolLog({ component: "runner", kind: "error", name: "kept" });
  const summary = tail().find(row => row.name === "log.capDropped");
  expect(summary.props.dropped.other).toBe(5); expect(Object.keys(summary.props.dropped)).toHaveLength(51); expect(summary.ids).toBeUndefined();
  expect(JSON.stringify(summary)).not.toContain("PRIVATE");
  toolLog({ component: "runner", kind: "event", name: "next" }); toolLog({ component: "runner", kind: "error", name: "kept.again" });
  expect(tail().filter(row => row.name === "log.capDropped")).toHaveLength(1);
  setSystemTime(start + 7_200_000); toolLog({ component: "runner", kind: "error", name: "kept.later" });
  expect(tail().filter(row => row.name === "log.capDropped")).toHaveLength(2);
  expect(tail().some(row => row.name === "kept")).toBe(true);
});
