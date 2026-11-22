import { expect, test } from "bun:test";
import capture from "./fixtures/flapping-cadence.json";
import { replaySlots } from "./slot-replay.ts";
import { borrowedStallOptions, cadenceSummary, flappingReplay } from "./flapping-replay.ts";
import { healthChecks } from "./sustained-replay.ts";
import { DeadlineSlots } from "./deadline-slots.ts";

test.each([
  { at: 5000, ms: 420_000 },
  { at: 5000.2, ms: 420_000.2 },
  { at: 3595_000, ms: 20_000 },
])("hourly capacity and holdings exclude the same frozen ticks: %j", async freeze => {
  const result = await replaySlots(undefined, 1, 2, {
    freeze, mix: { source: "one holder spans the freeze, including an hour boundary", watchers: [
      { watcher: "holder", intervalMs: 86400_000, checkMs: freeze.at + 60_000 },
    ] },
  });
  const end = result.completions[0]!.at;
  const frozenFrom = Math.ceil(freeze.at / 1000) * 1000;
  const frozenUntil = Math.ceil((freeze.at + freeze.ms) / 1000) * 1000;
  for (let hour = 0; hour < 2; hour++) {
    const start = hour * 3600_000, until = start + 3600_000;
    const unavailable = Math.max(0, Math.min(until, frozenUntil) - Math.max(start, frozenFrom));
    expect(result.hourlySupplyMs[hour]).toBe(3600_000 - unavailable);
    expect(result.hourlyHolds[hour]!.holder?.slow ?? 0).toBe(Math.max(0, Math.min(until, end) - start) - unavailable);
  }
});

test("deadline experiment admits the imminent cadence deadline ahead of an unaged long interval", async () => {
  let release!: () => void;
  const starts: string[] = [];
  const slots = new DeadlineSlots(() => 1, { now: () => 0 });
  const holder = slots.run(() => new Promise<void>(resolve => { release = resolve; }));
  for (let i = 0; i < 8; i++) await Promise.resolve();
  const jobs = [["long", 3600_000], ["short", 300_000]].map(([watcher, intervalMs]) => slots.run(async () => {
    starts.push(String(watcher));
  }, { watcher: String(watcher), lane: "slow", dueAt: 0, intervalMs: Number(intervalMs), operation: "check" }));
  release();
  await holder;
  await Promise.all(jobs);
  expect(starts).toEqual(["short", "long"]);
});

test("21 Nov observed-release live baseline stays within ten percent of complete health schedule counts", async () => {
  const result = await flappingReplay("raw", "observed", "live");
  expect(result.switches).toBe(31);
  for (const row of cadenceSummary(result).target) {
    const live = capture.liveCompleted[row.watcher as keyof typeof capture.liveCompleted];
    expect(Math.abs(row.completed - live) / live).toBeLessThanOrEqual(.1);
  }
  const forge = cadenceSummary(result).target.find(row => row.watcher === "forge-workouts")!;
  expect(forge.lateWindowCompleted).toBe(0);
  // Successful helper emissions inside shells that later timed out make live's gap shorter.
  expect(forge.completedMaxGapS).toBeGreaterThan(capture.liveForgeGapS);
}, 60_000);

test("21 Nov flaps preserve sticky recovery and bound the pessimistic floor without worsening long tails", async () => {
  const before = await flappingReplay("raw", "deadline", "baseline");
  const after = await flappingReplay("raw", "deadline", "borrow");
  expect(after.switches).toBe(before.switches);
  for (const id of healthChecks) {
    const old = before.byWatcher.find(row => row.watcher === id)!;
    const row = after.byWatcher.find(row => row.watcher === id)!;
    expect(row.completed).toBeGreaterThan(old.completed);
    expect(row.completed).toBeGreaterThanOrEqual(id === "forge-workouts" ? 100 : 210);
    // Sparse slow-only samples do not meet the cadence target; do not turn attempts into completions.
    expect(row.completed).toBeLessThan(id === "forge-workouts" ? 135 : 270);
  }
  for (const row of after.byWatcher) {
    const old = before.byWatcher.find(watcher => watcher.watcher === row.watcher)!;
    const interval = capture.watchers.find(watcher => watcher.watcher === row.watcher)!.intervalMs;
    expect(row.runs).toBeGreaterThan(0);
    expect(row.maxS).toBeLessThan(7200);
    if (interval > 600_000) expect(row.p95S).toBeLessThanOrEqual(old.p95S * 2);
    if (interval < 300_000) {
      expect(row.p95S).toBeLessThanOrEqual(old.p95S + Math.max(5, old.p95S * .1));
      expect(row.maxS).toBeLessThanOrEqual(old.maxS + Math.max(5, old.maxS * .1));
    }
  }
}, 90_000);

test("21 Nov pre-cap sensitivity clears cadence across the same load flaps", async () => {
  const result = await flappingReplay("precap", "deadline", "borrow");
  for (const row of cadenceSummary(result).target) {
    expect(row.completed).toBeGreaterThanOrEqual(row.watcher === "forge-workouts" ? 135 : 270);
    expect(row.completedMaxGapS).toBeLessThanOrEqual(900);
  }
}, 60_000);

test.each([0, 324200, 1482100, 2302500])("a frozen borrower releases native fast capacity even with %i ms late timeout release", async releaseDelayMs => {
  const result = await replaySlots(undefined, 2, 1, borrowedStallOptions(releaseDelayMs));
  const first = result.completions.find(row => row.watcher === "borrowed")!;
  expect(first.borrowed).toBe(true);
  expect(first.timedOut).toBe(true);
  expect(first.at).toBe(Math.ceil(Math.max(425_000, 180_000 + releaseDelayMs) / 1000) * 1000);
  for (const row of result.byWatcher.filter(watcher => healthChecks.includes(watcher.watcher))) {
    expect(row.firstAfterFreezeS!).toBeLessThanOrEqual(300);
    expect(row.minGapS).toBeGreaterThanOrEqual(300);
    expect(row.lateRuns).toBe(0);
  }
});
