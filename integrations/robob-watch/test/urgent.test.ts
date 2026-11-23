import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckSlots, type SlotTiming } from "../src/host.ts";
import { normalize, type State } from "../src/lib.ts";
import { cadenceStale, completeCadence, isStarved, starvedText, suspendCadence, syncCadenceSuspension, urgentLoadRetry } from "../src/cadence.ts";
import { rollup, toolLog } from "../src/toollog.ts";

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const watcher = normalize({ id: "urgent-test", title: "test", check: "true", mode: "notify", interval_s: 600, urgent: true });
const state = (): State => ({ status: "active", fires: 0, consecutive_failures: 0, failure_alerted: false });

test("a failed queue snapshot cannot strand a slot or prevent later admissions", async () => {
  const slots = new CheckSlots(() => 1, { queueChanged: () => { throw new Error("disk full"); } });
  const completed: number[] = [];
  await Promise.all([1, 2, 3].map(n => slots.run(async () => { completed.push(n); }, { watcher: `watcher-${n}` })));
  expect(completed).toEqual([1, 2, 3]);
  expect(slots.queue()).toEqual([]);
});

test("two slow slots serve urgent FIFO ahead of thirty older slow waiters, then drain regular FIFO", async () => {
  const slots = new CheckSlots(() => 2, {}, 2);
  const starts: string[] = [], releases = new Map<string, () => void>(), timings = new Map<string, SlotTiming>();
  const hold = (id: string, urgent = false, lane: "slow" | "fast" = "slow") => slots.run(async timing => {
    starts.push(id); timings.set(id, timing);
    await new Promise<void>(resolve => releases.set(id, resolve));
  }, { watcher: id, urgent, lane });
  const ordinary = Array.from({ length: 30 }, (_, i) => `slow-${i}`);
  const jobs = [hold("holder-a"), hold("holder-b"), ...ordinary.map(id => hold(id)), hold("urgent-a", true), hold("urgent-b", true), hold("fast", false, "fast")];
  await flush();
  expect(starts).toEqual(["holder-a", "holder-b", "fast"]);
  releases.get("holder-a")!(); await flush();
  expect(starts.at(-1)).toBe("urgent-a");
  releases.get("holder-b")!(); await flush();
  expect(starts.at(-1)).toBe("urgent-b");
  expect(timings.get("urgent-a")?.slotPickReason).toBe("urgent");
  expect(timings.get("fast")?.slotPickReason).toBe("fifo");
  for (let i = 0; i < 32; i++) { for (const release of releases.values()) release(); await flush(); }
  await Promise.all(jobs);
  expect(starts.filter(id => id.startsWith("slow-"))).toEqual(ordinary);
  expect(slots.queue()).toEqual([]);
});

test("urgent load timeout retries at once only once per interval; ordinary never does", () => {
  const s = state();
  expect(urgentLoadRetry(watcher, s, 1000)).toBe(true);
  expect(s.next_at).toBe(1000);
  for (const at of [1001, 120_000, 600_999]) expect(urgentLoadRetry(watcher, s, at)).toBe(false);
  expect(urgentLoadRetry(watcher, s, 601_000)).toBe(true);
  const ordinary = state();
  expect(urgentLoadRetry({ ...watcher, urgent: false }, ordinary, 1000)).toBe(false);
  expect(ordinary.next_at).toBeUndefined();
});

test("cadence uses completed checks, recovers even after a starved success, and re-arms", () => {
  const s = state();
  expect(cadenceStale(watcher, s, 0)).toBeUndefined();
  expect(cadenceStale(watcher, s, 30 * 60_000)).toBeUndefined();
  expect(cadenceStale(watcher, s, 31 * 60_000)).toEqual({ staleMs: 31 * 60_000, lastOutcome: "queued" });
  s.cadence!.staleAt = 31 * 60_000; s.cadence!.alerted = true; s.cadence!.lastOutcome = "starved";
  expect(completeCadence(s, 32 * 60_000, "no_change", 500_000, true)).toMatchObject({ staleMs: 32 * 60_000, lastOutcome: "starved" });
  expect(s.cadence!.alerted).toBeUndefined();
  expect(cadenceStale(watcher, s, 62 * 60_000)).toBeUndefined();
  expect(cadenceStale(watcher, s, 63 * 60_000)).toMatchObject({ lastOutcome: "starved" });
  expect(cadenceStale({ ...watcher, urgent: false }, state(), 99999999)).toBeUndefined();
});

test("cadence excludes repeated intentional holds without losing completed-check timestamps or active stalls", () => {
  const s = state(), minute = 60_000;
  completeCadence(s, 0, "no_change", 0, false);
  suspendCadence(s, minute, true);
  expect(suspendCadence(s, 20 * minute, true)).toBe(false);
  expect(cadenceStale(watcher, s, 41 * minute)).toBeUndefined();
  suspendCadence(s, 41 * minute, false);
  expect(s.cadence!.lastCompleted).toBe(0);
  expect(cadenceStale(watcher, s, 70 * minute)).toBeUndefined();
  suspendCadence(s, 70 * minute, true);
  suspendCadence(s, 80 * minute, false);
  expect(cadenceStale(watcher, s, 81 * minute)).toMatchObject({ staleMs: 31 * minute });
  s.cadence!.staleAt = 81 * minute;
  expect(completeCadence(s, 82 * minute, "no_change", 0, false)).toMatchObject({ staleMs: 32 * minute });
  expect(cadenceStale(watcher, s, 113 * minute)).toMatchObject({ staleMs: 31 * minute });
});

test("maintenance expiry excludes only the hold before a long runner outage ends", () => {
  const s = state(), minute = 60_000;
  completeCadence(s, 0, "no_change", 0, false);
  suspendCadence(s, minute, true, 41 * minute);
  suspendCadence(s, 81 * minute, false);
  expect(cadenceStale(watcher, s, 81 * minute)).toMatchObject({ staleMs: 41 * minute });
});

test.each([
  { name: "resume during maintenance", steps: [[1, true, 41], [21, false, 41], [31, false, 0]], eligible: 51 },
  { name: "maintenance off during pause", steps: [[1, false, 41], [11, true, 41], [21, true, 0], [41, false, 0]], eligible: 41 },
  { name: "maintenance extended before expiry", steps: [[1, false, 21], [11, false, 41]], eligible: 41 },
  { name: "maintenance renewed after expiry", steps: [[1, false, 21], [31, false, 41]], eligible: 51 },
])("overlapping holds retain eligible downtime: $name", ({ steps, eligible }) => {
  const s = state(), minute = 60_000, w = { ...watcher, depends: ["phone" as const] };
  completeCadence(s, 0, "no_change", 0, false);
  for (const [at, paused, until] of steps) {
    syncCadenceSuspension({ ...w, paused: !!paused }, s, Number(at) * minute,
      until ? { until: new Date(Number(until) * minute).toISOString(), depends: ["phone"], reason: "test" } : undefined, true);
  }
  syncCadenceSuspension(w, s, 81 * minute, undefined, true);
  expect(cadenceStale(w, s, 81 * minute)).toMatchObject({ staleMs: eligible * minute });
});

test.each([
  [60, 300_000, false], [60, 300_001, true], [600, 600_000, false], [600, 600_001, true],
])("starvation threshold interval=%s wait=%s", (interval, wait, expected) => expect(isStarved(interval, wait)).toBe(expected));

test("starved log names timeout or completion and includes queue cause", () => {
  const timing = { slotWaitMs: 601_000, slotQueueDepth: 30, slotActiveAtEnqueue: 2 };
  expect(starvedText(602_000, timing, 4, 180_000, 180_000)).toBe("starved: queued 602.0s, slot_wait 601.0s, depth 30, active 2/4, then load timeout after 180.0s");
  expect(starvedText(602_000, timing, 4, 40_000)).toEndWith("then check 40.0s");
});

test("urgent validates booleans only and defaults false", () => {
  const base = { id: "valid", title: "test", check: "true", mode: "notify" as const };
  expect(normalize(base).urgent).toBe(false);
  for (const urgent of [true, false]) expect(normalize({ ...base, urgent }).urgent).toBe(urgent);
  for (const urgent of [null, "true", "false", 1, 0, [], {}]) expect(() => normalize({ ...base, urgent } as never)).toThrow("urgent must be a boolean");
});

test("existing run rows retain urgent/pick/starved props and rollup counts per watcher", async () => {
  const dir = mkdtempSync(join(tmpdir(), "urgent-rollup-")), previous = process.env.TOOLLOG_DIR;
  process.env.TOOLLOG_DIR = dir;
  try {
    toolLog({ component: "runner", kind: "perf", name: "watch.run", ids: { watcher: "pool-low" }, props: { urgent: true, starved: true, slotPickReason: "urgent", outcome: "no_change", loadMode: true } });
    const day = new Date().toISOString().slice(0, 10);
    const { readFileSync } = await import("node:fs");
    const row = readFileSync(join(dir, `${day}.ndjson`), "utf8").trim().split("\n").map(line => JSON.parse(line)).find(row => row.name === "watch.run");
    expect(row.props).toMatchObject({ urgent: true, starved: true, slotPickReason: "urgent" });
    const result = await rollup(day, dir);
    expect(result?.byWatcher["pool-low"]).toMatchObject({ runs: 1, starvedRuns: 1, loadModeRuns: 1 });
  } finally { if (previous === undefined) delete process.env.TOOLLOG_DIR; else process.env.TOOLLOG_DIR = previous; rmSync(dir, { recursive: true, force: true }); }
});
