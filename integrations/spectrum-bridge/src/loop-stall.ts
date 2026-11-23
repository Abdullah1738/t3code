import { freemem, loadavg } from "node:os";

export const LOOP_OPERATIONS = ["inbound.pending", "inbound.latency", "inbound.parents", "inbound.wakes",
  "inbound.unanswered", "inbound.failed-receipts", "inbound.failed-alerts", "share.records",
  "remote.pending", "remote.queue-depth", "remote.unanswered", "remote.expiry", "remote.reply",
  "log.append", "log.scan", "log.sources", "log.counters"] as const;
type OperationName = typeof LOOP_OPERATIONS[number];
type Operation = { startedAt: number; endedAt: number };
export type RuntimeSample = { loopLagMaxMs: number; loopLagP95Ms: number; cpuUserMs: number; cpuSystemMs: number; rssMb: number; loadAvg1: number };
export type Stall = { stallMs: number; loadAvg1: number; freeMemoryBytes: number; rssBytes: number; operations: string };

export function createLoopOperations(now = () => performance.now()) {
  // Per-name coverage survives bursts of fast operations before the heartbeat can run.
  const completed = new Map<OperationName, Operation>();
  const active = new Map<OperationName, { startedAt: number; count: number }>();
  return {
    begin(name: OperationName): () => void {
      const startedAt = now();
      const running = active.get(name);
      if (running) running.count++;
      else active.set(name, { startedAt, count: 1 });
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        const running = active.get(name)!;
        if (--running.count === 0) active.delete(name);
        completed.set(name, { startedAt, endedAt: now() });
      };
    },
    during(start: number, end: number): string {
      return LOOP_OPERATIONS.filter(name => {
        const done = completed.get(name);
        const running = active.get(name);
        return done && done.startedAt <= end && done.endedAt > start || running && running.startedAt <= end;
      }).join(",");
    },
  };
}
export const loopOperations = createLoopOperations();
export function traceLoopOperation<T>(name: OperationName, work: () => T): T {
  const end = loopOperations.begin(name);
  try { return work(); } finally { end(); }
}

/** A separate heartbeat avoids changing the callback histogram's sampling/reset semantics. */
export function createLoopStallMonitor(emit: (stall: Stall) => void, options: {
  sample?: (sample: RuntimeSample) => void; cpu?: () => NodeJS.CpuUsage; tick?: () => void;
  now?: () => number; operations?: ReturnType<typeof createLoopOperations>;
  host?: () => Omit<Stall, "stallMs" | "operations">;
} = {}) {
  const now = options.now ?? (() => performance.now());
  const operations = options.operations ?? loopOperations;
  const host = options.host ?? (() => ({ loadAvg1: loadavg()[0]!, freeMemoryBytes: freemem(), rssBytes: process.memoryUsage.rss() }));
  let previous = now();
  let minuteStart = previous;
  const cpu = options.cpu ?? (() => process.cpuUsage());
  let previousCpu = cpu();
  let latestLag = 0;
  const lags: number[] = [];
  let lastEmission = -Infinity;
  let timer: ReturnType<typeof setInterval> | undefined;
  function check() {
    const at = now();
    const start = previous;
    previous = at;
    const stallMs = at - start - 250;
    latestLag = Math.max(0, stallMs);
    lags.push(latestLag);
    if (at - minuteStart >= 60_000) {
      const usage = cpu();
      const sorted = lags.sort((a, b) => a - b);
      try {
        const metadata = host();
        options.sample?.({ loopLagMaxMs: sorted.at(-1) ?? 0, loopLagP95Ms: sorted[Math.ceil(sorted.length * .95) - 1] ?? 0,
          cpuUserMs: Math.max(0, usage.user - previousCpu.user) / 1000,
          cpuSystemMs: Math.max(0, usage.system - previousCpu.system) / 1000,
          rssMb: metadata.rssBytes / 1024 / 1024, loadAvg1: metadata.loadAvg1 });
        options.tick?.();
      } catch { /* Sampling is best effort, including during shutdown. */ }
      previousCpu = usage;
      minuteStart = at;
      lags.length = 0;
    }
    if (stallMs <= 1_000 || at - lastEmission < 10_000) return;
    lastEmission = at;
    try { emit({ ...host(), stallMs, operations: operations.during(start, at) }); }
    catch { /* Diagnostics cannot interrupt bridge work or create an error loop. */ }
  }
  return {
    check,
    loopLag: () => latestLag,
    start() {
      if (timer) return;
      previous = now();
      minuteStart = previous;
      previousCpu = cpu();
      lags.length = 0;
      timer = setInterval(check, 250);
      timer.unref();
    },
    stop() { clearInterval(timer); timer = undefined; },
  };
}
