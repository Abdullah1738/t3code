import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rollup } from "../src/toollog.ts";

const dirs: string[] = [];
const day = "2026-11-13";
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "rollup-breakdown-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("slot waits, late starts, busy minutes and top holders include partial holdings across midnight", async () => {
  const dir = fixture();
  const start = Date.parse(`${day}T00:00:00Z`), end = start + 86400_000;
  const row = (name: string, at: number, watcher?: string, props = {}, durationMs?: number) => ({ tool: "watchers", component: "runner", kind: "perf", name,
    ts: new Date(at).toISOString(), ids: watcher ? { watcher } : {}, props, durationMs });
  const rows = [
    ...[0, 10_000, 60_001, 120_000].map((wait, i) => row("slot.start", start + i * 60_000, "flighty", { slotWaitMs: wait, startLateMs: wait, intervalMs: 60_000 })),
    row("slot.start", start, "bad", { slotWaitMs: -1, startLateMs: 1, intervalMs: 0 }),
    row("slot.hold", start + 30_000, "slow", {}, 60_000),
    row("slot.hold", start + 90_000, "slow", {}, 60_000),
    row("slot.hold", start + 60_000, "fast", {}, 1000),
    row("slot.busy", start + 30_000, undefined, {}, 60_000),
    row("slot.busy", start + 90_000, undefined, {}, 60_000),
  ];
  writeFileSync(join(dir, `${day}.ndjson`), rows.map(row => JSON.stringify(row)).join("\n"));
  writeFileSync(join(dir, "2026-11-14.ndjson"), [row("slot.hold", end + 30_000, "slow", {}, 60_000), row("slot.busy", end + 30_000, undefined, {}, 60_000)].map(row => JSON.stringify(row)).join("\n"));
  const result = await rollup(day, dir);
  expect(result?.byWatcher.flighty).toMatchObject({ slotWaitMs: { count: 4, total: 190_001, p95: 120_000 }, lateRuns: 2 });
  expect(result?.byWatcher.bad).toMatchObject({ slotWaitMs: { count: 0, total: 0, p95: null }, lateRuns: 0 });
  expect(result?.slots).toEqual({ allSlotsBusyMinutes: 2, topHolders: [{ watcher: "slow", slotSeconds: 120 }, { watcher: "fast", slotSeconds: 1 }] });
  const window = await rollup({ since: new Date(start + 10_000).toISOString(), until: new Date(start + 50_000).toISOString() }, dir);
  expect(window?.slots).toEqual({ allSlotsBusyMinutes: 40_000 / 60_000, topHolders: [{ watcher: "slow", slotSeconds: 40 }] });
});

test("ndjson rollup attributes watcher runs, helper failures, tags and wakes without double counting", async () => {
  const dir = fixture();
  copyFileSync(join(import.meta.dir, "fixtures/rollup.ndjson"), join(dir, `${day}.ndjson`));
  const result = await rollup(day, dir);
  expect(result?.byWatcher).toEqual({
    "ride-share-updates": { runs: 5, outcomes: { no_change: 1, fire: 1, fail: 2, timeout: 1, busy: 0 }, fires: 1,
      durationMs: { p50: 30, p95: 70, max: 70 }, queuedMs: { p95: 100 }, slotWaitMs: { count: 0, total: 0, p95: null }, lateRuns: 0, longestFailStreak: 2, lastFailureTag: "watch.check_failed" },
    "flighty-bookings": { runs: 3, outcomes: { no_change: 1, fire: 1, fail: 0, timeout: 1, busy: 0 }, fires: 1,
      durationMs: { p50: 50, p95: 60, max: 60 }, queuedMs: { p95: 5 }, slotWaitMs: { count: 0, total: 0, p95: null }, lateRuns: 0, longestFailStreak: 1, lastFailureTag: "watch.timeout" },
    "inbox-triage": { runs: 1, outcomes: { no_change: 1, fire: 0, fail: 0, timeout: 0, busy: 0 }, fires: 0,
      durationMs: { p50: 25, p95: 25, max: 25 }, queuedMs: { p95: 1 }, slotWaitMs: { count: 0, total: 0, p95: null }, lateRuns: 0, longestFailStreak: 0, lastFailureTag: null },
  });
  expect(result?.watcherTotals).toEqual({ watchers: 3, runs: 9, outcomes: { no_change: 3, fire: 2, fail: 2, timeout: 2, busy: 0 }, fires: 2 });
  expect(result?.byHelper).toEqual({
    "ride-card": { runs: 3, failures: 2, exitCodes: { "0": 1, "1": 1, "-9": 1 }, durationMs: { p95: 9 } },
    "convo-card": { runs: 2, failures: 1, exitCodes: { "0": 1, null: 1 }, durationMs: { p95: 100 } },
  });
  expect(result?.helperTotals).toEqual({ helpers: 2, runs: 5, failures: 3, exitCodes: { "0": 2, "1": 1, "-9": 1, null: 1 } });
  expect(result?.errorsByTagAndSource).toEqual([
    { tag: "helper.exit_failed", source: "helper", id: "ride-card", count: 2 },
    { tag: "watch.check_failed", source: "watcher", id: "ride-share-updates", count: 2 },
    { tag: "helper.timeout", source: "helper", id: "convo-card", count: 1 },
    { tag: "wake.delivery_failed", source: "watcher", id: "flighty-bookings", count: 1 },
    { tag: "wake.delivery_failed", source: "watcher", id: "ride-share-updates", count: 1 },
    { tag: "watch.timeout", source: "watcher", id: "flighty-bookings", count: 1 },
    { tag: "watch.timeout", source: "watcher", id: "ride-share-updates", count: 1 },
  ]);
  expect(result?.wake).toEqual({ attempts: 3, sent: 2, failed: 1, replyGuard: { total: 3, accepted: 1, blocked: 2 } });
  expect(result).toMatchObject({ total: 23, counts: { "watch.run": 9, "helper.run": 5, "watch.retry": 1, "wake.sent": 3, "watch.fire": 2, "wake.reply_guard": 3 },
    kinds: { perf: 9, error: 9, event: 5 }, ok: 14, failed: 9, okRate: 14 / 23, errorRate: 9 / 23,
    durations: { "watch.run": { count: 9, p50: 30, p95: 70, max: 70 } },
    errors: [ { tag: "watch.check_failed", count: 2, topSources: [{ source: "watcher", id: "ride-share-updates", count: 2 }] }, { tag: "watch.timeout", count: 2, topSources: [{ source: "watcher", id: "flighty-bookings", count: 1 }, { source: "watcher", id: "ride-share-updates", count: 1 }] },
      { tag: "helper.exit_failed", count: 2, topSources: [{ source: "helper", id: "ride-card", count: 2 }] }, { tag: "wake.delivery_failed", count: 2, topSources: [{ source: "watcher", id: "flighty-bookings", count: 1 }, { source: "watcher", id: "ride-share-updates", count: 1 }] },
      { tag: "helper.timeout", count: 1, topSources: [{ source: "helper", id: "convo-card", count: 1 }] } ],
  });
  expect(JSON.parse(readFileSync(join(dir, `rollup-${day}.json`), "utf8"))).toEqual(result);
});

test("top sources and error pairs are bounded with full totals and a report under 50 KB", async () => {
  const dir = fixture(), rows = [];
  for (let source = 0; source < 60; source++) {
    const id = `source-${String(source).padStart(2, "0")}-${"x".repeat(69)}`;
    rows.push({ tool: "watchers", kind: "event", name: "watch.fire", ok: true, ids: { watcher: id } });
    for (let run = 0; run <= source; run++) for (const name of ["watch.run", "helper.run"]) rows.push({
      tool: "watchers", kind: "error", name, ok: false, durationMs: run, ids: { [name === "watch.run" ? "watcher" : "helper"]: id },
      props: { outcome: "fail", queuedMs: run, exitCode: 1 }, error: { tag: `failure.${"x".repeat(72)}` },
    });
  }
  writeFileSync(join(dir, `${day}.ndjson`), rows.map(row => JSON.stringify(row)).join("\n"));
  const result = await rollup(day, dir);
  expect(Object.keys(result!.byWatcher)).toHaveLength(40);
  expect(Object.keys(result!.byHelper)).toHaveLength(40);
  expect(Object.keys(result!.byWatcher)[0]).toStartWith("source-59-");
  expect(Object.keys(result!.byWatcher).at(-1)).toStartWith("source-20-");
  expect(Object.values(result!.byWatcher)[0]?.durationMs).toEqual({ p50: 29, p95: 56, max: 59 });
  expect(Object.values(result!.byWatcher)[0]?.queuedMs.p95).toBe(56);
  expect(Object.values(result!.byHelper)[0]?.durationMs.p95).toBe(56);
  expect(result?.watcherTotals).toEqual({ watchers: 60, runs: 1830, outcomes: { no_change: 0, fire: 0, fail: 1830, timeout: 0, busy: 0 }, fires: 60 });
  expect(Object.values(result!.byWatcher).reduce((sum, watcher) => sum + watcher.fires, 0)).toBe(40);
  expect(result?.helperTotals).toEqual({ helpers: 60, runs: 1830, failures: 1830, exitCodes: { "1": 1830 } });
  expect(result?.errorsByTagAndSource).toHaveLength(20);
  expect(result?.errorsByTagAndSource[0]?.count).toBe(60);
  expect(readFileSync(join(dir, `rollup-${day}.json`)).byteLength).toBeLessThan(50 * 1024);
});

test("failed and quiet-held sends count only when their retries complete on the next UTC day", async () => {
  const dir = fixture(), nextDay = "2026-11-14";
  copyFileSync(join(import.meta.dir, "fixtures/delivery-pending.ndjson"), join(dir, `${day}.ndjson`));
  copyFileSync(join(import.meta.dir, "fixtures/delivery-retried.ndjson"), join(dir, `${nextDay}.ndjson`));
  const pending = await rollup(day, dir), retried = await rollup(nextDay, dir);
  const cases = [
    { watcher: "failed-send", outcome: "fire", completed: true },
    { watcher: "quiet-held", outcome: "fire", completed: true },
    { watcher: "escalated", outcome: "fail", completed: false },
  ] as const;
  for (const { watcher, outcome, completed } of cases) {
    expect(pending?.byWatcher[watcher]).toMatchObject({ runs: 1, outcomes: { [outcome]: 1, busy: 0 }, fires: 0 });
    if (completed) expect(retried?.byWatcher[watcher]).toEqual({ runs: 0, outcomes: { no_change: 0, fire: 0, fail: 0, timeout: 0, busy: 0 }, fires: 1,
      durationMs: { p50: null, p95: null, max: null }, queuedMs: { p95: null }, slotWaitMs: { count: 0, total: 0, p95: null }, lateRuns: 0, longestFailStreak: 0, lastFailureTag: null });
    else expect(retried?.byWatcher[watcher]).toBeUndefined();
  }
  expect(pending?.watcherTotals).toEqual({ watchers: 3, runs: 3, outcomes: { no_change: 0, fire: 2, fail: 1, timeout: 0, busy: 0 }, fires: 0 });
  expect(retried?.watcherTotals).toEqual({ watchers: 2, runs: 0, outcomes: { no_change: 0, fire: 0, fail: 0, timeout: 0, busy: 0 }, fires: 2 });
  expect(retried?.wake).toMatchObject({ attempts: 4, sent: 3, failed: 1 });
});

test.each(["legacy wake", "failed completion", "missing completion status"])("%s is not a confirmed event fire", async scenario => {
  const dir = fixture();
  const rows = [
    { tool: "watchers", kind: "perf", name: "watch.run", ok: true, ids: { watcher: "demo" }, props: { outcome: "fire" } },
    scenario === "legacy wake"
      ? { tool: "watchers", kind: "perf", name: "wake.sent", ok: true, ids: { watcher: "demo" } }
      : { tool: "watchers", kind: "event", name: "watch.fire", ...(scenario === "failed completion" ? { ok: false } : {}), ids: { watcher: "demo" } },
  ];
  writeFileSync(join(dir, `${day}.ndjson`), rows.map(row => JSON.stringify(row)).join("\n"));
  const result = await rollup(day, dir);
  expect(result?.byWatcher.demo).toMatchObject({ runs: 1, outcomes: { fire: 1, busy: 0 }, fires: 0 });
  expect(result?.watcherTotals.fires).toBe(0);
});

test("unsafe IDs and malformed optional fields cannot leak text, poison timings or break aggregation", async () => {
  const dir = fixture(), secret = "private subject OTP 123456 /Users/private/file.txt";
  const base = { tool: "watchers", kind: "error", name: "watch.run", ok: false };
  const rows = [
    { ...base, ids: { watcher: secret }, error: { tag: "watch.failed", message: secret }, durationMs: -1, props: { queuedMs: -1, outcome: "fail" } },
    { ...base, ids: { watcher: "a".repeat(24) }, error: { tag: "watch.failed" }, durationMs: "100", props: { queuedMs: "10", outcome: "timeout" } },
    { ...base, ids: { watcher: "__proto__" }, error: { tag: "watch.failed" }, props: { outcome: "fail" } },
    { ...base, ids: { watcher: "constructor" }, error: { tag: "watch.failed" }, props: { outcome: "fail" } },
    { ...base, name: "helper.run", ids: { helper: secret }, props: { exitCode: secret } },
    { ...base, name: "helper.run", ids: null, props: { exitCode: 1.5 } },
    { ...base, name: "helper.run", ids: [], props: { exitCode: null } },
    { ...base, name: "helper.run", ids: { helper: "ride-card" }, props: [] },
    { ...base, name: "wake.reply_guard", props: { accepted: "false" } },
    { ...base, ids: "bad", props: null, error: [] },
  ];
  writeFileSync(join(dir, `${day}.ndjson`), ["", "broken", "{}", "null", "42", ...rows.map(row => JSON.stringify(row))].join("\n"));
  const result = await rollup(day, dir);
  expect(result?.total).toBe(rows.length);
  expect(result?.watcherTotals.runs).toBe(5);
  expect(result?.byWatcher.unknown).toMatchObject({ runs: 3, durationMs: { p50: null, p95: null, max: null }, queuedMs: { p95: null } });
  expect(result?.byWatcher["a".repeat(24)]?.durationMs).toEqual({ p50: null, p95: null, max: null });
  expect(result?.byHelper.unknown).toEqual({ runs: 3, failures: 3, exitCodes: { null: 1 }, durationMs: { p95: null } });
  expect(result?.wake.replyGuard).toEqual({ total: 1, accepted: 0, blocked: 0 });
  expect(JSON.stringify(result)).not.toContain(secret);
});

test("a day with only empty and malformed lines still has empty aggregates", async () => {
  const dir = fixture();
  writeFileSync(join(dir, `${day}.ndjson`), '\nmalformed\nnull\n{}\n[]\n{"tool":"watchers","kind":"perf"}\n');
  expect(await rollup(day, dir)).toEqual({ day, tool: "watchers", total: 0, counts: {}, kinds: {}, ok: 0, failed: 0, okRate: null, errorRate: 0, durations: {}, errors: [],
    byDependency: {}, dependencyTotals: { dependencies: 0, busyRuns: 0 },
    slots: { allSlotsBusyMinutes: 0, topHolders: [] }, byWatcher: {}, watcherTotals: { watchers: 0, runs: 0, outcomes: { no_change: 0, fire: 0, fail: 0, timeout: 0, busy: 0 }, fires: 0 },
    byHelper: {}, helperTotals: { helpers: 0, runs: 0, failures: 0, exitCodes: {} }, errorsByTagAndSource: [], hourly: [], markers: [],
    wake: { attempts: 0, sent: 0, failed: 0, replyGuard: { total: 0, accepted: 0, blocked: 0 } },
  });
});

test("busy runs count per watcher and dependency without helper double counting", async () => {
  const dir = fixture();
  const rows = [
    { name: "watch.run", ids: { watcher: "one" }, props: { outcome: "busy", dependency: "msgs" } },
    { name: "watch.run", ids: { watcher: "two" }, props: { outcome: "busy", dependency: "msgs" } },
    { name: "watch.run", ids: { watcher: "one" }, props: { outcome: "busy", dependency: "archive" } },
    { name: "helper.run", ids: { helper: "one" }, props: { stderrClass: "dependency_busy", dependency: "msgs" } },
    { name: "watch.run", ids: { watcher: "one" }, props: { outcome: "fail", dependency: "msgs" } },
    { name: "watch.run", ids: { watcher: "two" }, props: { outcome: "timeout" } },
  ];
  writeFileSync(join(dir, `${day}.ndjson`), rows.map(row => JSON.stringify({ tool: "watchers", kind: "error", ok: false, ts: day+"T01:00:00Z", ...row })).join("\n"));
  const result = await rollup(day, dir);
  expect(result?.watcherTotals.outcomes).toEqual({ no_change: 0, fire: 0, fail: 1, timeout: 1, busy: 3 });
  expect(result?.byWatcher.one?.outcomes.busy).toBe(2);
  expect(result?.byWatcher.two?.outcomes.busy).toBe(1);
  expect(result?.byDependency).toEqual({ msgs: { busyRuns: 2, watchers: 2 }, archive: { busyRuns: 1, watchers: 1 } });
  expect(result?.dependencyTotals).toEqual({ dependencies: 2, busyRuns: 3 });
  expect(result?.hourly[0]?.watchRun).toMatchObject({ count: 5, fail: 1, timeout: 1 });
});
