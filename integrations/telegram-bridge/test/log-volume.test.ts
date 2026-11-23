import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flushToolErrors, rollup, toolError, toolLog } from "../src/toollog.ts";
import { LogCompactor, type TelemetryRow } from "../../robob-watch/src/log-volume.ts";
const previous = process.env.TOOLLOG_DIR;
const dirs: string[] = [];
const start = Date.parse("2026-11-20T00:00:00Z");
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), "tg-volume-")); dirs.push(dir); process.env.TOOLLOG_DIR = dir; setSystemTime(start); return dir; };
const rows = (dir: string, day = "2026-11-20") => readFileSync(join(dir, `${day}.ndjson`), "utf8").trim().split("\n").map(line => JSON.parse(line));
afterEach(() => { flushToolErrors(Date.now(), true); setSystemTime(); if (previous === undefined) delete process.env.TOOLLOG_DIR; else process.env.TOOLLOG_DIR = previous; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
test("1000 refused connections in 120 seconds produce four lines and 1000 errors in every reader", async () => {
  const dir = fixture();
  for (let i = 0; i < 1000; i++) { setSystemTime(start + i * 120); toolError("telegram", "tg.attention.pendingRequests", { directory: "PRIVATE" }, { code: "ECONNREFUSED" }); }
  flushToolErrors(start + 120_000, true);
  const all = rows(dir);
  expect(all).toHaveLength(4);
  expect(all.reduce((sum, row) => sum + (row.props.repeats ?? 1), 0)).toBe(1000);
  expect(all.filter(row => row.props.repeats).every(row => !row.ids && row.props.windowMs <= 60_000)).toBe(true);
  expect(all[0].ids.directory).toMatch(/^[a-f0-9]{24}$/);
  expect(await rollup("2026-11-20", dir)).toMatchObject({ total: 1000, failed: 1000, errors: [{ count: 1000 }] });
  const watch = await import("../../robob-watch/src/toollog.ts");
  expect(await watch.rollup("2026-11-20", dir)).toMatchObject({ total: 1000, errors: [{ count: 1000 }], hourly: [{ errors: [{ count: 1000 }] }] });
  const spectrum = await import("../../spectrum-bridge/src/watcherlog.ts");
  expect(await spectrum.rollup("2026-11-20", dir)).toMatchObject({ total: 1000, errors: [{ count: 1000 }] });
});
test("tags, causes, HTTP statuses and safe details each retain their first occurrence", () => {
  const dir = fixture();
  const cases = [["one", { code: "ECONNREFUSED" }], ["two", { code: "ECONNREFUSED" }], ["one", { code: "ENOENT" }], ["one", { status: 503 }], ["one", { status: 502 }], ["one", { code: "ConnectionRefused" }]] as const;
  for (const [tag, error] of cases) { toolError("telegram", tag, undefined, error); toolError("telegram", tag, undefined, error); }
  expect(rows(dir)).toHaveLength(cases.length);
  flushToolErrors(start + 60_000, true);
  expect(rows(dir)).toHaveLength(cases.length * 2);
});
test("200 key limit writes overflow keys directly and expiry frees capacity", () => {
  const dir = fixture();
  for (let i = 0; i < 200; i++) toolError("telegram", `fixture.${i}`, undefined, { code: "ECONNREFUSED" });
  for (let i = 0; i < 3; i++) toolError("telegram", "overflow", undefined, { code: "ECONNREFUSED" });
  expect(rows(dir)).toHaveLength(203);
  setSystemTime(start + 61_000);
  toolError("telegram", "overflow", undefined, { code: "ECONNREFUSED" }); toolError("telegram", "overflow", undefined, { code: "ECONNREFUSED" });
  expect(rows(dir)).toHaveLength(204);
});
test("flush keeps suppressed errors on their original UTC day and hour", async () => {
  const dir = fixture(); setSystemTime(start - 500);
  toolError("telegram", "boundary", undefined, { code: "ECONNREFUSED" }); toolError("telegram", "boundary", undefined, { code: "ECONNREFUSED" });
  setSystemTime(start + 500); toolError("telegram", "boundary", undefined, { code: "ECONNREFUSED" });
  expect(rows(dir, "2026-11-19").reduce((n, row) => n + (row.props.repeats ?? 1), 0)).toBe(2);
  expect(rows(dir)).toHaveLength(1);
});
test("cap drops are bounded, hourly, private and flushed on day rollover", () => {
  const dir = fixture(); toolLog({ component: "fixture", kind: "event", name: "start" });
  truncateSync(join(dir, "2026-11-20.ndjson"), 50 * 1024 * 1024 + 1);
  for (let i = 0; i < 55; i++) toolLog({ component: "fixture", kind: "perf", name: `drop.${i}`, ids: { key: "PRIVATE" } });
  const tail = () => readFileSync(join(dir, "2026-11-20.ndjson")).subarray(50 * 1024 * 1024 + 1).toString().trim().split("\n").map(line => JSON.parse(line));
  expect(tail().filter(row => row.name === "log.capDropped")).toHaveLength(0);
  setSystemTime(start + 3_600_000); toolLog({ component: "fixture", kind: "error", name: "kept" });
  const summary = tail().find(row => row.name === "log.capDropped");
  expect(Object.keys(summary.props.dropped)).toHaveLength(51); expect(summary.props.dropped.other).toBe(5);
  expect(summary.ids).toBeUndefined(); expect(JSON.stringify(summary)).not.toContain("PRIVATE");
  toolLog({ component: "fixture", kind: "event", name: "next" });
  toolLog({ component: "fixture", kind: "error", name: "kept.again" });
  expect(tail().filter(row => row.name === "log.capDropped")).toHaveLength(1);
  setSystemTime(start + 86_400_000); toolLog({ component: "fixture", kind: "error", name: "tomorrow" });
  expect(tail().filter(row => row.name === "log.capDropped")).toHaveLength(2);
  expect(tail().at(-1).props.dropped).toEqual({ "fixture:event:next": 1 });
});


test("standalone readers ship the identical compact format decoder", () => {
  const source = readFileSync(join(import.meta.dir, "../src/log-format.ts"), "utf8");
  for (const pkg of ["robob-watch", "spectrum-bridge"]) expect(readFileSync(join(import.meta.dir, `../../${pkg}/src/log-format.ts`), "utf8")).toBe(source);
});

test("bridge rollups preserve slot timings and run results when slots are folded", async () => {
  const dir = fixture(), day = "2026-11-20";
  const spectrum = await import("../../spectrum-bridge/src/watcherlog.ts");
  for (const failed of [false, true]) {
    const base = { tool: "watchers", component: "runner", kind: "perf" as const, ids: { watcher: "fixture", run: "abc" } };
    const input: TelemetryRow[] = [
      { ...base, ts: new Date(start).toISOString(), name: "slot.start", props: { operation: "check", slotWaitMs: 12, slotQueueDepth: 2, slotActiveAtEnqueue: 1, startLateMs: 20, intervalMs: 60_000 } },
      { ...base, ts: new Date(start + 12).toISOString(), name: "slot.hold", durationMs: 12, props: { operation: "check", lane: "slow" } },
      { ...base, ts: new Date(start + 24).toISOString(), name: "watch.run", kind: failed ? "error" : "perf", ok: !failed, durationMs: 24,
        props: { slotWaitMs: 12, slotQueueDepth: 2, slotActiveAtEnqueue: 1, startLateMs: 20, intervalMs: 60_000, lane: "slow" },
        ...(failed ? { error: { tag: "watch.check_failed", message: "watch.check_failed" } } : {}) },
    ];
    const packed: TelemetryRow[] = [], compact = new LogCompactor(row => packed.push(row));
    input.forEach(row => compact.push(row));
    expect(packed).toHaveLength(1);
    const write = (rows: TelemetryRow[]) => writeFileSync(join(dir, `${day}.ndjson`), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    for (const read of [rollup, spectrum.rollup]) {
      write(input);
      const before = await read(day, dir);
      expect(before).toMatchObject({ total: 3, ok: failed ? 0 : 1, failed: failed ? 1 : 0,
        durations: { "slot.hold": { count: 1, p50: 12, p95: 12, max: 12 }, "watch.run": { count: 1, p50: 24, p95: 24, max: 24 } } });
      expect(before?.durations["slot.start"]).toBeUndefined();
      write(packed);
      expect(await read(day, dir)).toEqual(before);
    }
  }
});
