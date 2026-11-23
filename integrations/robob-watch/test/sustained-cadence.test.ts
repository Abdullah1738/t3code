import { expect, test } from "bun:test";
import { CheckSlots, checkClassification, recentCheckRuntimes, LoadMode, type SlotRequest, type SlotEvent } from "../src/host.ts";
import { replaySlots } from "./slot-replay.ts";
import { healthChecks, sustainedReplay, sustainedOptions } from "./sustained-replay.ts";

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test("runtime history tolerates one slow sample and evicts three genuinely slow samples", () => {
  let history = [500];
  for (const ms of [12_000, 20_000, 20_000, 20_000]) {
    history = recentCheckRuntimes(history, ms);
    const result = checkClassification(ms, history);
    expect(result.lane).toBe(history.includes(500) ? "fast" : "slow");
    expect(history.length).toBeLessThanOrEqual(3);
  }
  expect(checkClassification(undefined, undefined)).toMatchObject({ lane: "slow", reason: "slow:new" });
  expect(checkClassification(15_000, [15_000])).toMatchObject({ lane: "slow" });
  expect(checkClassification(12_000, [500, 12_000])).toMatchObject({ lane: "fast", reason: "fast:sticky", recentMinMs: 500 });
});

test("load heartbeat emits once per hour, with a fresh duration after exit and reentry", () => {
  const mode = new LoadMode({ high: 1.5, low: 1.2, dwellMs: 0 });
  mode.sample(2, 0);
  expect(mode.report(3599_999)).toBeUndefined();
  expect(mode.report(3600_000)).toBe(3600_000);
  expect(mode.report(3600_001)).toBeUndefined();
  mode.sample(0, 4000_000);
  expect(mode.report(8000_000)).toBeUndefined();
  mode.sample(2, 8000_000);
  expect(mode.report(11600_000)).toBe(3600_000);
});

test("idle fast capacity uses earliest short-check deadline while slow FIFO and overrun remain bounded", async () => {
  let clock = 0, borrowing = false;
  const starts: string[] = [], releases: (() => void)[] = [], events: SlotEvent[] = [];
  const slots = new CheckSlots(() => 2, { now: () => clock, emit: e => events.push(e) }, 2, () => borrowing);
  const hold = (watcher: string, intervalMs = 3600_000, dueAt = 0) => slots.run(async timing => {
    starts.push(watcher);
    if (watcher === "urgent") expect(timing.slotLane).toBe("fast");
    await new Promise<void>(resolve => releases.push(resolve));
  }, { watcher, operation: "check", lane: "slow", recentMinMs: 60_000, dueAt, intervalMs });
  const jobs = [hold("slow-a"), hold("slow-b"), hold("old-long"), hold("other-short", 600_000), hold("urgent", 300_000)];
  await flush();
  expect(starts).toEqual(["slow-a", "slow-b"]);
  borrowing = true; slots.drain(); await flush();
  expect(starts).toEqual(["slow-a", "slow-b", "urgent"]);
  clock = 10_000; slots.drain(); await flush();
  expect(events.filter(e => e.name === "slot.overrun")).toHaveLength(1);
  expect(starts).not.toContain("old-long");
  for (let i = 0; i < 3; i++) { for (const release of releases.splice(0)) release(); await flush(); }
  await Promise.all(jobs);
  expect(starts).toContain("old-long");
});

test.each([
  { recentMinMs: undefined }, { recentMinMs: NaN }, { recentMinMs: -1 }, { recentMinMs: 19_999 },
  { operation: "pending" }, { dueAt: undefined }, { dueAt: NaN }, { dueAt: Infinity }, { dueAt: 1 },
  { intervalMs: undefined }, { intervalMs: NaN }, { intervalMs: Infinity }, { intervalMs: 0 }, { intervalMs: -1 }, { intervalMs: 299_999 }, { intervalMs: 600_001 },
] satisfies Partial<SlotRequest>[])("ineligible reserved-capacity request %j stays in FIFO", async patch => {
  const slots = new CheckSlots(() => 1, {}, 1, () => true);
  let release!: () => void, started = false;
  const holder = slots.run(() => new Promise<void>(resolve => { release = resolve; }), { watcher: "holder" });
  await flush();
  const job = slots.run(async () => { started = true; }, { watcher: "candidate", operation: "check", lane: "slow", recentMinMs: 60_000, dueAt: Date.now(), intervalMs: 300_000, ...patch,
    ...(patch.dueAt === 1 ? { dueAt: Date.now() + 1000 } : {}) });
  await flush();
  expect(started).toBe(false);
  release(); await holder; await job;
  expect(started).toBe(true);
});

test.each([0, 1, 9000])("a borrower ahead of a native holder by %i ms releases fast capacity at ten seconds", async nativeAt => {
  let clock = 0, releaseNative!: () => void, releaseBorrowed!: () => void;
  const slots = new CheckSlots(() => 0, { now: () => clock }, 2, () => true);
  const borrowed = slots.run(() => new Promise<void>(resolve => { releaseBorrowed = resolve; }), { watcher: "borrowed", lane: "slow", operation: "check", intervalMs: 300_000, dueAt: 0, recentMinMs: 60_000 });
  clock = nativeAt;
  const native = slots.run(() => new Promise<void>(resolve => { releaseNative = resolve; }), { watcher: "native", lane: "fast" });
  await flush();
  let cheapStarted = false, anotherStarted = false;
  const cheap = slots.run(async () => { cheapStarted = true; }, { watcher: "cheap", lane: "fast" });
  const another = slots.run(async () => { anotherStarted = true; }, { watcher: "another-borrower", lane: "slow", operation: "check", intervalMs: 300_000, dueAt: 0, recentMinMs: 60_000 });
  clock = 9999; slots.drain(); await flush(); expect(cheapStarted).toBe(false);
  clock = 10_000; slots.drain(); await cheap;
  expect(cheapStarted).toBe(true); expect(anotherStarted).toBe(false);
  releaseBorrowed(); await borrowed; await flush();
  expect(anotherStarted).toBe(false);
  releaseNative(); await native; await another;
});

test.each([0, 1, 1000, 5000, 9000, 9999, 10000, 10001])("a loan at %i ms cannot delay an older native fast holder", async loanAt => {
  const run = async (borrowing: boolean) => {
    let clock = 0;
    const releases: (() => void)[] = [];
    const slots = new CheckSlots(() => 2, { now: () => clock }, 2, () => borrowing);
    const hold = (watcher: string, lane: "fast" | "slow", loan = false) => slots.run(() => new Promise<void>(resolve => {
      releases.push(resolve);
    }), { watcher, lane, ...(loan ? { operation: "check" as const, intervalMs: 300_000, dueAt: 0, recentMinMs: 60_000 } : {}) });
    const holders = [hold("slow-a", "slow"), hold("slow-b", "slow"), hold("older-native", "fast")];
    await flush();
    clock = loanAt;
    const borrower = hold("borrower", "slow", true);
    await flush();
    clock = Math.max(10_000, loanAt);
    let started: number | undefined;
    const fast = slots.run(async () => { started = clock; }, { watcher: "native-fast", lane: "fast", dueAt: clock });
    await flush();
    clock = loanAt + 10_000;
    slots.drain(); await flush();
    const admittedAt = started;
    for (let i = 0; i < 3; i++) { for (const release of releases.splice(0)) release(); await flush(); }
    await Promise.all([...holders, borrower, fast]);
    return admittedAt;
  };
  const before = await run(false), after = await run(true);
  expect(after).toBe(before);
  expect(after).toBe(Math.max(10_000, loanAt));
});

test("occupied overflow leaves native fast capacity ahead of two long borrowers", async () => {
  let clock = 0, releaseOverflow!: () => void;
  const slots = new CheckSlots(() => 0, { now: () => clock }, 2, () => true);
  const overflow = slots.run(() => new Promise<void>(resolve => { releaseOverflow = resolve; }), { watcher: "native-overrun", lane: "fast" });
  await flush(); clock = 10_000; slots.drain();
  const borrowers = ["borrow-a", "borrow-b"].map(watcher => slots.run(async () => {}, { watcher, lane: "slow", operation: "check", intervalMs: 300_000, dueAt: clock, recentMinMs: 60_000 }));
  let cheapStarted = false;
  const cheap = slots.run(async () => { cheapStarted = true; }, { watcher: "native-fast", lane: "fast", dueAt: clock });
  await flush(); expect(cheapStarted).toBe(true);
  releaseOverflow(); await overflow; await cheap; await Promise.all(borrowers);
});

test("failed probes use their probe deadline when competing for an overdue loan", async () => {
  const result = await replaySlots(undefined, 2, 1, { fastSlots: 1, borrowFast: true, existingTimeouts: true,
    loads: [{ at: 0, load: 9 }],
    initialStates: { probe: { failure_paused_at: new Date(0).toISOString(), failure_probe_attempts: 1, failure_probe_next_at: new Date(60_000).toISOString(), next_at: -600_000, consecutive_failures: 5 } },
    mix: { source: "a failed probe competes with an ordinary overdue check after native overflow clears", watchers: [
      ...["slow-a", "slow-b"].map(watcher => ({ watcher, intervalMs: 3600_000, checkMs: 300_000 })),
      { watcher: "native", intervalMs: 3600_000, checkMs: 500 },
      { watcher: "probe", intervalMs: 300_000, checkMs: 60_000 },
      { watcher: "ordinary", intervalMs: 300_000, checkMs: 60_000 },
    ] }, runtime: watcher => watcher.watcher === "native" ? 90_000 : watcher.watcher === "probe" ? 600_000 : watcher.checkMs });
  const ordinary = result.completions.find(c => c.watcher === "ordinary")!, probe = result.completions.find(c => c.watcher === "probe")!;
  expect(ordinary.started).toBe(90_000);
  expect(probe.dueAt).toBe(60_000);
  expect(probe.started).toBeGreaterThanOrEqual(ordinary.at);
  expect(probe.probe).toBe(true); expect(probe.timedOut).toBe(true);
});

test("a borrowed check frozen for seven minutes ends at its existing timeout on resume", async () => {
  const result = await replaySlots(undefined, 2, 1, { fastSlots: 2, borrowFast: true, existingTimeouts: true,
    loads: [{ at: 0, load: 9 }], freeze: { at: 5000, ms: 420_000 },
    mix: { source: "two slow holders plus a hung borrower and four native fast health checks", watchers: [
      ...["slow-a", "slow-b"].map(watcher => ({ watcher, intervalMs: 3600_000, checkMs: 300_000 })),
      { watcher: "borrowed", intervalMs: 300_000, checkMs: 60_000 },
      ...healthChecks.slice(0, 4).map(watcher => ({ watcher, intervalMs: 300_000, checkMs: 500 })),
    ] }, runtime: watcher => watcher.watcher === "borrowed" ? 600_000 : watcher.checkMs });
  expect(result.completions.find(c => c.watcher === "borrowed")).toMatchObject({ borrowed: true, started: 0, at: 425_000, timedOut: true });
  for (const row of result.byWatcher.filter(w => healthChecks.includes(w.watcher))) {
    expect(row.firstAfterFreezeS!).toBeLessThanOrEqual(300);
    expect(row.minGapS).toBeGreaterThanOrEqual(300);
  }
});

test("19 Nov sustained load preserves cadence and bounds every queued check", async () => {
  const before = await sustainedReplay(19, "baseline"), after = await sustainedReplay(19, "borrow");
  for (const id of healthChecks) {
    const old = before.byWatcher.find(w => w.watcher === id)!;
    const row = after.byWatcher.find(w => w.watcher === id)!;
    expect(old.runs).toBeLessThan(id === "forge-workouts" ? 140 : 280);
    expect(row.completed).toBeGreaterThanOrEqual(id === "forge-workouts" ? 140 : 280);
    expect(row.minHourlyRuns).toBeGreaterThanOrEqual(id === "forge-workouts" ? 5 : 11);
    expect(row.lateP95S).toBeLessThan(60);
  }
  for (const row of after.byWatcher) {
    expect(row.runs).toBeGreaterThan(0);
    expect(row.maxS).toBeLessThan(900);
    const old = before.byWatcher.find(w => w.watcher === row.watcher)!;
    for (const key of ["p95S", "maxS"] as const) expect(row[key]).toBeLessThanOrEqual(old[key] + Math.max(5, old[key] * .1));
  }
}, 30_000);

test.each([500, 2000])("window outcomes follow the admission cohort across a %i ms release", async runtime => {
  const result = await replaySlots(undefined, 1, 1, { existingTimeouts: true,
    mix: { source: "one check admitted before the window ends", watchers: [
      { watcher: "boundary", intervalMs: 3600_000, checkMs: 500, timeout_s: 1 },
    ] }, runtime: () => runtime,
    waitWindows: [{ name: "admitted", from: 0, until: 1000 }, { name: "released", from: 1000, until: 3600_000 }],
  });
  expect(result.waitWindows[0]!.byWatcher[0]).toMatchObject({ count: 1, completed: runtime < 1000 ? 1 : 0, timeouts: runtime > 1000 ? 1 : 0 });
  expect(result.waitWindows[1]!.byWatcher[0]).toMatchObject({ count: 0, completed: 0, timeouts: 0 });
});

test("20 Nov capacity floor preserves matched-window tails and timeout rates at every interval", async () => {
  const before = await sustainedReplay(20, "baseline"), after = await sustainedReplay(20, "borrow");
  for (const id of healthChecks) {
    const old = before.byWatcher.find(w => w.watcher === id)!;
    const row = after.byWatcher.find(w => w.watcher === id)!;
    expect(row.runs).toBeGreaterThanOrEqual(id === "forge-workouts" ? 95 : 175);
    expect(row.completed).toBeGreaterThanOrEqual(id === "forge-workouts" ? 90 : 165);
    expect(row.completed).toBeGreaterThan(old.completed);
    if (id !== "forge-workouts") expect(row.maxGapS).toBeLessThanOrEqual(2100);
    expect(row.timeouts).toBeGreaterThan(0);
  }
  const whoop = after.byWatcher.find(w => w.watcher === "whoop-sync")!, priorWhoop = before.byWatcher.find(w => w.watcher === "whoop-sync")!;
  expect(whoop.completed).toBeGreaterThanOrEqual(priorWhoop.completed);
  expect(whoop.p95S).toBeLessThanOrEqual(priorWhoop.p95S);
  for (const row of after.byWatcher) {
    expect(row.runs).toBeGreaterThan(0);
    expect(row.maxS).toBeLessThan(7200);
  }
  const timeoutRegressions = [];
  for (const window of after.waitWindows) {
    const prior = before.waitWindows.find(w => w.name === window.name)!;
    expect(window.byWatcher).toHaveLength(after.watchers);
    for (const row of window.byWatcher) {
      const old = prior.byWatcher.find(w => w.watcher === row.watcher)!;
      expect(row.count, `${window.name}: ${row.watcher}`).toBeGreaterThan(0);
      expect(old.count, `${window.name}: ${row.watcher} baseline`).toBeGreaterThan(0);
      expect(row.completed + row.timeouts).toBe(row.count);
      expect(old.completed + old.timeouts).toBe(old.count);
      expect(row.p95S, `${window.name}: ${row.watcher}`).toBeLessThanOrEqual(Math.max(2 * old.p95S, old.p95S + 60));
      if (window.name !== "normal" && row.timeouts / row.count - old.timeouts / old.count > .1) {
        timeoutRegressions.push({ window: window.name, watcher: row.watcher, before: [old.timeouts, old.count], after: [row.timeouts, row.count] });
      }
    }
  }
  expect(timeoutRegressions).toEqual([
    { window: "load", watcher: "watcher-040", before: [2, 5], after: [5, 8] },
    { window: "steady-load", watcher: "watcher-040", before: [0, 3], after: [3, 5] },
  ]);
  // Extra attempts consume extra predetermined runtime samples. Compare shared
  // loaded ordinals before attributing the raw timeout-rate change to admission.
  const options = sustainedOptions(20), definition = options.mix!.watchers.find(w => w.watcher === "watcher-040")!;
  const priorRuns = before.completions.filter(row => row.watcher === definition.watcher);
  const runs = after.completions.filter(row => row.watcher === definition.watcher);
  const inLoad = (at: number) => at >= options.accountFrom! && at < options.accountUntil!;
  const shared = priorRuns.flatMap((old, ordinal) => {
    const row = runs[ordinal];
    if (!row || !inLoad(old.started) || !inLoad(row.started)) return [];
    const runtime = options.runtime!(definition, old.started, ordinal);
    expect(options.runtime!(definition, row.started, ordinal)).toBe(runtime);
    expect(row.timedOut).toBe(old.timedOut);
    return [{ ordinal, runtime, timedOut: row.timedOut }];
  });
  expect(shared).toEqual([
    { ordinal: 4, runtime: 257050, timedOut: true }, { ordinal: 5, runtime: 300000, timedOut: true },
    { ordinal: 6, runtime: 51410, timedOut: false }, { ordinal: 7, runtime: 102820, timedOut: false },
    { ordinal: 8, runtime: 154230, timedOut: false },
  ]);
  const loaded = after.waitWindows.find(w => w.name === "load")!.byWatcher.find(w => w.watcher === definition.watcher)!;
  const priorLoaded = before.waitWindows.find(w => w.name === "load")!.byWatcher.find(w => w.watcher === definition.watcher)!;
  expect(loaded.completed).toBeGreaterThanOrEqual(priorLoaded.completed);
  // Full-day p95 crosses into the loaded samples when these checks run more
  // often. Keep those daily outliers visible beside the matched-load proof.
  const load = after.waitWindows.find(w => w.name === "load")!, priorLoad = before.waitWindows.find(w => w.name === "load")!;
  const dailyOutliers = after.byWatcher.filter(row => {
    const old = before.byWatcher.find(w => w.watcher === row.watcher)!;
    return row.p95S > Math.max(2 * old.p95S, old.p95S + 60);
  });
  expect(dailyOutliers.map(row => row.watcher)).toEqual(["watcher-004", "watcher-023", "watcher-024", "watcher-053", "watcher-064"]);
  for (const daily of dailyOutliers) {
    expect(sustainedOptions(20).mix!.watchers.find(w => w.watcher === daily.watcher)!.intervalMs).toBe(120_000);
    const row = load.byWatcher.find(w => w.watcher === daily.watcher)!, old = priorLoad.byWatcher.find(w => w.watcher === daily.watcher)!;
    expect(row.count).toBeGreaterThan(old.count);
    expect(row.completed).toBeGreaterThan(old.completed);
    expect(row.p95S).toBeLessThan(old.p95S);
    expect(row.maxS).toBeLessThan(old.maxS);
  }
}, 30_000);

test("seven-minute host freeze times out holders and resumes health without a tick burst", async () => {
  const result = await sustainedReplay(19, "borrow", true);
  for (const id of healthChecks) {
    const row = result.byWatcher.find(w => w.watcher === id)!;
    expect(row.firstAfterFreezeS!).toBeLessThanOrEqual(300);
    expect(row.minGapS).toBeGreaterThanOrEqual(300);
  }
  const frozen = result.completions.filter(c => c.frozen);
  expect(frozen.length).toBeGreaterThan(0);
  for (const check of frozen) {
    expect(check.timedOut).toBe(true);
    expect(check.at).toBe(16 * 3600_000 + 420_000);
  }
}, 30_000);
