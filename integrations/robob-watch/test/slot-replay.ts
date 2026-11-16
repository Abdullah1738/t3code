import { CheckSlots, type SlotEvent } from "../src/host.ts";
import fixture from "./fixtures/slot-replay.json";

export async function replaySlots(Slots = CheckSlots, cap = 6, hours = 6) {
  let clock = 0;
  const limit = hours * 3600_000;
  const samples: { watcher: string; at: number; waitMs: number; lateMs: number; fast: boolean; frequent: boolean }[] = [];
  const events: { at: number; event: SlotEvent }[] = [];
  const timers: { at: number; resolve: () => void }[] = [];
  const running = new Set<string>(), jobs: Promise<void>[] = [];
  const next = new Map(fixture.watchers.map(w => [w.watcher, 0]));
  const heldMs = new Map<string, number>();
  let busyMs = 0;
  const slots = new Slots(() => cap, { now: () => clock, emit: event => {
    if (event.name === "slot.busy") busyMs += event.durationMs;
    if (event.name === "slot.hold") heldMs.set(event.request.watcher, (heldMs.get(event.request.watcher) ?? 0) + event.durationMs);
    if (events.length < 100 && (event.name === "slot.backlog" || event.name === "slot.wait")) events.push({ at: clock, event });
  } });
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  for (clock = 0; clock < limit || running.size; clock += 1000) {
    const finished = timers.filter(timer => timer.at <= clock);
    for (const timer of finished) { timers.splice(timers.indexOf(timer), 1); timer.resolve(); }
    await flush();
    slots.drain();
    if (clock < limit) for (const watcher of fixture.watchers) {
      if (running.has(watcher.watcher) || next.get(watcher.watcher)! > clock) continue;
      running.add(watcher.watcher);
      jobs.push(slots.run(async timing => {
        samples.push({ watcher: watcher.watcher, at: clock, waitMs: timing.slotWaitMs, lateMs: timing.startLateMs, fast: watcher.checkMs < 1000, frequent: watcher.intervalMs <= 60_000 });
        next.set(watcher.watcher, clock + watcher.intervalMs);
        await new Promise<void>(resolve => timers.push({ at: clock + watcher.checkMs, resolve }));
      }, { watcher: watcher.watcher, dueAt: next.get(watcher.watcher), intervalMs: watcher.intervalMs }).finally(() => { running.delete(watcher.watcher); }));
    }
    await flush();
    if (clock > limit + 2 * 3600_000) throw new Error("queue did not drain within two hours");
  }
  await Promise.all(jobs);
  const measured = samples.filter(sample => sample.at >= 600_000 && sample.at < limit);
  const waits = (rows: typeof samples) => {
    const sorted = rows.map(row => row.waitMs).sort((a, b) => a - b);
    return { count: rows.length, p95S: (sorted[Math.ceil(sorted.length * .95) - 1] ?? 0) / 1000, maxS: (sorted.at(-1) ?? 0) / 1000 };
  };
  const byWatcher = fixture.watchers.map(w => {
    const rows = samples.filter(sample => sample.watcher === w.watcher);
    return { watcher: w.watcher, runs: rows.length, ...waits(rows), lateRuns: rows.filter(row => row.lateMs > w.intervalMs).length };
  });
  return { cap, watchers: fixture.watchers.length, hours, assumptions: fixture.source,
    all: waits(measured), fast: waits(measured.filter(row => row.fast)), fastFrequent: waits(measured.filter(row => row.fast && row.frequent)), slow: waits(measured.filter(row => !row.fast)),
    busyMinutes: busyMs / 60_000, topHolders: [...heldMs].sort(([, a], [, b]) => b - a).slice(0, 5).map(([watcher, ms]) => ({ watcher, slotSeconds: ms / 1000 })),
    minRuns: Math.min(...byWatcher.map(row => row.runs)), lateRuns: measured.filter(row => row.lateMs > fixture.watchers.find(w => w.watcher === row.watcher)!.intervalMs).length,
    flighty: byWatcher.find(w => w.watcher === "flighty-bookings"),
    samples: [...events.filter(row => row.event.name === "slot.wait").slice(0, 1), ...events.filter(row => row.event.name === "slot.backlog").slice(0, 2)], byWatcher };
}

if (import.meta.main) {
  const Slots = process.argv[2] ? (await import(process.argv[2])).CheckSlots as typeof CheckSlots : CheckSlots;
  const results = [];
  for (const cap of [6, 2]) results.push(await replaySlots(Slots, cap));
  console.log(JSON.stringify(results, null, 2));
}
