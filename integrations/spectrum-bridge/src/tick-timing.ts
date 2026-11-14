import { AsyncLocalStorage } from "node:async_hooks";
import { toolLog } from "./toollog.ts";

export type ReadTiming = {
  slowest?: { route: string; started: number; durationMs: number };
  pending: Set<{ route: string; started: number }>;
};
type Tick = ReadTiming & { started: number; completionChecked?: number; sources: Set<ReadTiming> };
const reads = new AsyncLocalStorage<ReadTiming>();
const ticks = new AsyncLocalStorage<Tick>();

export function captureReadTiming<T>(operation: () => Promise<T>): { result: Promise<T>; timing: ReadTiming } {
  const timing: ReadTiming = { pending: new Set() };
  return { result: reads.run(timing, operation), timing };
}

/** A prefetched read belongs to the tick awaiting its result, even if another timer started it. */
export function includeReadTiming(timing: ReadTiming): void {
  ticks.getStore()?.sources.add(timing);
}

export function completionChecked(): void {
  const tick = ticks.getStore();
  if (tick) tick.completionChecked = performance.now();
}

export function tickRead(route: string, started: number): void {
  const tick = reads.getStore();
  const durationMs = performance.now() - started;
  if (tick && (!tick.slowest || durationMs > tick.slowest.durationMs)) tick.slowest = { route, started, durationMs };
}

export function startTickRead(route: string, started: number): () => void {
  const tick = reads.getStore();
  const read = { route, started };
  tick?.pending.add(read);
  return () => {
    tick?.pending.delete(read);
    const durationMs = performance.now() - started;
    if (tick && (!tick.slowest || durationMs > tick.slowest.durationMs)) tick.slowest = { route, started, durationMs };
  };
}

export async function timeTick(ids: Record<string, string>, operation: () => Promise<void>): Promise<void> {
  const tick: Tick = { started: performance.now(), pending: new Set(), sources: new Set() };
  return ticks.run(tick, () => reads.run(tick, async () => {
    try { await operation(); }
    finally {
      const durationMs = performance.now() - tick.started;
      for (const source of [tick, ...tick.sources]) {
        if (source.slowest && (!tick.slowest || source.slowest.durationMs > tick.slowest.durationMs)) tick.slowest = source.slowest;
        for (const read of source.pending) {
          const durationMs = performance.now() - read.started;
          if (!tick.slowest || durationMs > tick.slowest.durationMs) tick.slowest = { ...read, durationMs };
        }
      }
      if (durationMs > 5_000) toolLog.capture(() => toolLog.write({ component: "router", kind: "perf", name: "turn.tick_timing", durationMs, ids,
        props: {
          ...(tick.slowest ? { route: tick.slowest.route, slowestReadMs: tick.slowest.durationMs } : {}),
          completionCheck: tick.completionChecked === undefined ? "unchecked"
            : !tick.slowest || tick.completionChecked <= tick.slowest.started ? "before" : "after",
        } }));
    }
  }));
}
