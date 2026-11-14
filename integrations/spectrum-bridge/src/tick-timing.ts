import { AsyncLocalStorage } from "node:async_hooks";
import { toolLog } from "./toollog.ts";

type Tick = {
  started: number;
  completionChecked?: number;
  slowest?: { route: string; started: number; durationMs: number };
  pending: Set<{ route: string; started: number }>;
};
const ticks = new AsyncLocalStorage<Tick>();

export function completionChecked(): void {
  const tick = ticks.getStore();
  if (tick) tick.completionChecked = performance.now();
}

export function tickRead(route: string, started: number): void {
  const tick = ticks.getStore();
  const durationMs = performance.now() - started;
  if (tick && (!tick.slowest || durationMs > tick.slowest.durationMs)) tick.slowest = { route, started, durationMs };
}

export function startTickRead(route: string, started: number): () => void {
  const tick = ticks.getStore();
  const read = { route, started };
  tick?.pending.add(read);
  return () => { tick?.pending.delete(read); tickRead(route, started); };
}

export async function timeTick(ids: Record<string, string>, operation: () => Promise<void>): Promise<void> {
  const tick: Tick = { started: performance.now(), pending: new Set() };
  return ticks.run(tick, async () => {
    try { await operation(); }
    finally {
      const durationMs = performance.now() - tick.started;
      for (const read of tick.pending) {
        const durationMs = performance.now() - read.started;
        if (!tick.slowest || durationMs > tick.slowest.durationMs) tick.slowest = { ...read, durationMs };
      }
      if (durationMs > 5_000) toolLog.capture(() => toolLog.write({ component: "router", kind: "perf", name: "turn.tick_timing", durationMs, ids,
        props: {
          ...(tick.slowest ? { route: tick.slowest.route, slowestReadMs: tick.slowest.durationMs } : {}),
          completionCheck: tick.completionChecked === undefined ? "unchecked"
            : !tick.slowest || tick.completionChecked <= tick.slowest.started ? "before" : "after",
        } }));
    }
  });
}
