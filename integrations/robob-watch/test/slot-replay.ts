import { CheckSlots, checkLane, checkClassification, recentCheckRuntimes, LoadMode, checkTimeout, LOAD_GRACE_MS, LOAD_HIGH, type SlotEvent } from "../src/host.ts";
import { TIMEOUT_BACKOFF_CAP_S, normalize, shouldPause, failureProbeDelay, clearFailureState, type State } from "../src/lib.ts";
import fixture from "./fixtures/slot-replay.json";

export type ReplayMix = { source: string; watchers: { watcher: string; intervalMs: number; checkMs: number; timeout_s?: number }[] };
export type ReplayOptions = { mix?: ReplayMix; loads?: { at: number; load: number }[]; hysteresis?: boolean; fastSlots?: number; anchor?: boolean;
  sticky?: boolean; borrowFast?: boolean; runtime?: (watcher: ReplayMix["watchers"][number], at: number, run: number) => number;
  freeze?: { at: number; ms: number }; existingTimeouts?: boolean; accountFrom?: number; accountUntil?: number;
  observedRelease?: (watcher: ReplayMix["watchers"][number], at: number, run: number) => { ms: number; timedOut: boolean };
  releaseDelayMs?: number; failureProbes?: boolean; initialStates?: Record<string, Partial<State>> };
export async function replaySlots(Slots = CheckSlots, cap = 6, hours = 6, options: ReplayOptions = {}) {
  const mix = options.mix ?? fixture;
  let clock = 0;
  const limit = hours * 3600_000;
  const samples: { watcher: string; at: number; waitMs: number; lateMs: number; fast: boolean; fastLane: boolean; frequent: boolean }[] = [];
  const events: { at: number; event: SlotEvent }[] = [];
  const timers: { at: number; resolve: () => void }[] = [];
  const running = new Set<string>(), jobs: Promise<void>[] = [];
  const history = new Map<string, number[]>(), last = new Map(mix.watchers.map(w => [w.watcher, w.checkMs])), runCounts = new Map<string, number>();
  const completions: { watcher: string; started: number; at: number; timedOut: boolean; frozen: boolean; borrowed: boolean; dueAt: number; probe: boolean }[] = [];
  const definitions = new Map(mix.watchers.map(w => [w.watcher, normalize({ id: w.watcher, title: w.watcher, check: "true", mode: "notify", interval_s: w.intervalMs / 1000, ...(w.timeout_s ? { timeout_s: w.timeout_s } : {}) })]));
  const states = new Map<string, State>(mix.watchers.map(w => [w.watcher, { status: "active", fires: 0, consecutive_failures: 0, ...options.initialStates?.[w.watcher] }]));
  const next = new Map(mix.watchers.map(w => [w.watcher, states.get(w.watcher)!.next_at ?? 0]));
  const mode = new LoadMode();
  let load = options.loads?.[0]?.load ?? 0, loadIndex = 0, high = false, switches = 0;
  const heldMs = new Map<string, number>();
  let busyMs = 0;
  const borrowedNow = new Map<string, boolean>(), windowBorrowed = new Map<string, number>();
  const windowHolds = new Map<string, {slow: number; fast: number}>();
  const hourlyHolds = Array.from({ length: hours }, () => new Map<string, {slow: number; fast: number}>());
  const hourlySupplyMs = Array.from({ length: hours }, () => 0);
  const slots = new Slots(() => options.loads ? high ? 2 : cap : cap, { now: () => clock, emit: event => {
    if (event.name === "slot.busy") busyMs += event.durationMs;
    if (event.name === "slot.hold") {
      heldMs.set(event.request.watcher, (heldMs.get(event.request.watcher) ?? 0) + event.durationMs);
      const ms = Math.max(0, Math.min(clock, options.accountUntil ?? limit) - Math.max(clock - event.durationMs, options.accountFrom ?? 0));
      const held = windowHolds.get(event.request.watcher) ?? { slow: 0, fast: 0 };
      held[event.request.lane === "fast" ? "fast" : "slow"] += ms;
      if (borrowedNow.get(event.request.watcher)) windowBorrowed.set(event.request.watcher, (windowBorrowed.get(event.request.watcher) ?? 0) + ms);
      windowHolds.set(event.request.watcher, held);
      const lane = event.request.lane === "fast" ? "fast" : "slow";
      for (let hour = Math.max(0, Math.floor((clock - event.durationMs) / 3600_000)); hour < hours && hour * 3600_000 < clock; hour++) {
        const overlap = Math.max(0, Math.min(clock, (hour + 1) * 3600_000) - Math.max(clock - event.durationMs, hour * 3600_000));
        const row = hourlyHolds[hour]!.get(event.request.watcher) ?? { slow: 0, fast: 0 };
        row[lane] += overlap;
        hourlyHolds[hour]!.set(event.request.watcher, row);
      }
    }
    if (events.length < 100 && (event.name === "slot.backlog" || event.name === "slot.wait")) events.push({ at: clock, event });
  } }, options.fastSlots ?? 0, () => high && !!options.borrowFast);
  const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
  for (clock = 0; clock < limit || running.size; clock += 1000) {
    if (options.freeze && clock >= options.freeze.at && clock < options.freeze.at + options.freeze.ms) continue;
    while (options.loads?.[loadIndex] && options.loads[loadIndex]!.at <= clock) load = options.loads[loadIndex++]!.load;
    const wasHigh = high;
    high = options.hysteresis ? mode.sample(load, clock) : load >= 1.5;
    if (clock < limit) hourlySupplyMs[Math.floor(clock / 3600_000)]! += ((options.loads && high ? 2 : cap) + (options.fastSlots ?? 0) + ((options.fastSlots ?? 0) > 0 ? 1 : 0)) * 1000;
    if (high !== wasHigh && clock < limit) switches++;
    const finished = timers.filter(timer => timer.at <= clock);
    for (const timer of finished) { timers.splice(timers.indexOf(timer), 1); timer.resolve(); }
    await flush();
    slots.drain();
    if (clock < limit) for (const watcher of mix.watchers) {
      const state = states.get(watcher.watcher)!;
      if ((state.failure_paused_at && options.failureProbes === false) || running.has(watcher.watcher) || (state.failure_paused_at ? Date.parse(state.failure_probe_next_at!) > clock : next.get(watcher.watcher)! > clock)) continue;
      const dueAt = state.failure_paused_at ? Date.parse(state.failure_probe_next_at!) : next.get(watcher.watcher)!;
      running.add(watcher.watcher);
      const lane = options.sticky ? checkClassification(last.get(watcher.watcher), history.get(watcher.watcher)).lane
        : checkLane(options.runtime ? last.get(watcher.watcher) : watcher.checkMs);
      jobs.push(slots.run(async timing => {
        borrowedNow.set(watcher.watcher, lane === "slow" && timing.slotLane === "fast");
        samples.push({ watcher: watcher.watcher, at: clock, waitMs: timing.slotWaitMs, lateMs: timing.startLateMs, fast: watcher.checkMs < 1000, fastLane: (timing.slotLane ?? lane) === "fast", frequent: watcher.intervalMs <= 60_000 });
        const due = dueAt;
        next.set(watcher.watcher, options.anchor ? due + (Math.floor(Math.max(0, clock - due) / watcher.intervalMs) + 1) * watcher.intervalMs : clock + watcher.intervalMs);
        const probe = !!state.failure_paused_at;
        if (probe) state.failure_probe_attempts = (state.failure_probe_attempts ?? 0) + 1;
        const started = clock, startLoad = load, run = runCounts.get(watcher.watcher) ?? 0;
        runCounts.set(watcher.watcher, run + 1);
        const observed = options.observedRelease?.(watcher, clock, run);
        const runtime = observed?.ms ?? options.runtime?.(watcher, clock, run) ?? watcher.checkMs;
        let doneAt = clock + runtime;
        if (options.freeze && clock < options.freeze.at && doneAt >= options.freeze.at) doneAt += options.freeze.ms;
        const deadline = clock + (options.existingTimeouts ? checkTimeout(definitions.get(watcher.watcher)!, load) : Infinity);
        const timedOut = observed ? observed.timedOut : deadline < doneAt;
        const releaseAt = observed ? doneAt : timedOut ? deadline + (options.releaseDelayMs ?? 0) : doneAt;
        await new Promise<void>(resolve => timers.push({ at: releaseAt, resolve }));
        const ms = clock - started;
        if (timedOut) {
          if (probe) state.failure_probe_next_at = new Date(clock + failureProbeDelay(state.failure_probe_attempts!)).toISOString();
          else {
            if (Math.max(startLoad, load) >= LOAD_HIGH) state.load_timeout_since ??= new Date(clock).toISOString();
            if (Math.max(startLoad, load) >= LOAD_HIGH && clock - Date.parse(state.load_timeout_since!) < LOAD_GRACE_MS) {
              next.set(watcher.watcher, clock + Math.min(watcher.intervalMs, TIMEOUT_BACKOFF_CAP_S * 1000));
            } else {
              state.consecutive_failures++;
              state.failing_since ??= new Date(started).toISOString();
              next.set(watcher.watcher, clock + Math.min(watcher.intervalMs * 2 ** Math.min(state.consecutive_failures - 1, 8), Math.max(watcher.intervalMs, TIMEOUT_BACKOFF_CAP_S * 1000)));
              if (shouldPause(definitions.get(watcher.watcher)!, state, true, clock)) {
                state.failure_paused_at = new Date(clock).toISOString();
                state.failure_probe_attempts = 0;
                state.failure_probe_next_at = new Date(clock + failureProbeDelay(0)).toISOString();
              }
            }
          }
        } else if (options.existingTimeouts) clearFailureState(state);
        history.set(watcher.watcher, recentCheckRuntimes(history.get(watcher.watcher) ?? [watcher.checkMs], ms));
        last.set(watcher.watcher, ms);
        completions.push({ watcher: watcher.watcher, started, at: clock, timedOut, dueAt, probe, frozen: !!options.freeze && started < options.freeze.at && started + runtime >= options.freeze.at, borrowed: lane === "slow" && timing.slotLane === "fast" });
      }, { watcher: watcher.watcher, dueAt, intervalMs: watcher.intervalMs, lane, recentMinMs: Math.min(...(history.get(watcher.watcher) ?? [watcher.checkMs])), operation: "check" }).finally(() => { running.delete(watcher.watcher); }));
    }
    await flush();
    if (clock > limit + 2 * 3600_000) throw new Error("queue did not drain within two hours");
  }
  await Promise.all(jobs);
  const measured = samples.filter(sample => sample.at >= 600_000 && sample.at < limit);
  const waits = (rows: typeof samples) => {
    const sorted = rows.map(row => row.waitMs).sort((a, b) => a - b);
    const late = rows.map(row => row.lateMs).sort((a, b) => a - b);
    return { count: rows.length, p95S: (sorted[Math.ceil(sorted.length * .95) - 1] ?? 0) / 1000, maxS: (sorted.at(-1) ?? 0) / 1000,
      lateP95S: (late[Math.ceil(late.length * .95) - 1] ?? 0) / 1000 };
  };
  const byWatcher = mix.watchers.map(w => {
    const rows = samples.filter(sample => sample.watcher === w.watcher && sample.at < limit);
    const gaps = rows.slice(1).map((row, i) => row.at - rows[i]!.at);
    return { watcher: w.watcher, minGapS: Math.min(...gaps) / 1000, runs: rows.length, completed: completions.filter(c => c.watcher === w.watcher && c.at < limit && !c.timedOut).length, timeouts: completions.filter(c => c.watcher === w.watcher && c.at < limit && c.timedOut).length, ...waits(rows), maxGapS: Math.max(0, ...gaps) / 1000,
      minHourlyRuns: Math.min(...Array.from({ length: hours }, (_, h) => rows.filter(row => row.at >= h * 3600_000 && row.at < (h + 1) * 3600_000).length)),
      firstAfterFreezeS: options.freeze ? (rows.find(row => row.at >= options.freeze!.at + options.freeze!.ms)?.at ?? Infinity) / 1000 - (options.freeze.at + options.freeze.ms) / 1000 : undefined,
      lateRuns: rows.filter(row => row.lateMs > w.intervalMs).length };
  });
  return { cap, watchers: mix.watchers.length, hours, assumptions: mix.source, switches,
    windowHolds: Object.fromEntries(windowHolds), windowBorrowed: Object.fromEntries(windowBorrowed),
    hourlyHolds: hourlyHolds.map(holds => Object.fromEntries(holds)), hourlySupplyMs,
    all: waits(measured), fast: waits(measured.filter(row => row.fast)), fastFrequent: waits(measured.filter(row => row.fast && row.frequent)), slow: waits(measured.filter(row => !row.fast)),
    fastLane: waits(measured.filter(row => row.fastLane)), slowLane: waits(measured.filter(row => !row.fastLane)),
    busyMinutes: busyMs / 60_000, topHolders: [...heldMs].sort(([, a], [, b]) => b - a).slice(0, 5).map(([watcher, ms]) => ({ watcher, slotSeconds: ms / 1000 })),
    minRuns: Math.min(...byWatcher.map(row => row.runs)), lateRuns: measured.filter(row => row.lateMs > mix.watchers.find(w => w.watcher === row.watcher)!.intervalMs).length,
    flighty: byWatcher.find(w => w.watcher === "flighty-bookings"),
    completions, samples: [...events.filter(row => row.event.name === "slot.wait").slice(0, 1), ...events.filter(row => row.event.name === "slot.backlog").slice(0, 2)], byWatcher };
}

if (import.meta.main) {
  const Slots = process.argv[2] ? (await import(process.argv[2])).CheckSlots as typeof CheckSlots : CheckSlots;
  const results = [];
  for (const cap of [6, 2]) results.push(await replaySlots(Slots, cap));
  console.log(JSON.stringify(results, null, 2));
}
