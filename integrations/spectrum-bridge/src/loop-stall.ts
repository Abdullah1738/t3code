import { freemem, loadavg } from "node:os";

export const LOOP_OPERATIONS = ["inbound.pending", "inbound.latency", "inbound.parents", "inbound.wakes",
  "inbound.unanswered", "inbound.failed-receipts", "inbound.failed-alerts", "share.records",
  "remote.pending", "remote.queue-depth", "remote.unanswered", "remote.expiry", "remote.reply",
  "log.append", "log.scan", "log.sources", "log.counters"] as const;
type OperationName = typeof LOOP_OPERATIONS[number];
type Operation = { startedAt: number; endedAt: number };
export type RuntimeSample = { loopLagMaxMs: number; loopLagP95Ms: number; cpuUserMs: number; cpuSystemMs: number; rssMb: number; loadAvg1: number };
export type Stall = { stallMs: number; loadAvg1: number; freeMemoryBytes: number; rssBytes: number; operations: string } & StallTiming;
/**
 * Only what the process can measure, rounded to whole milliseconds.
 * - `measuredMaxMs` / `operationMs`: wall-clock spans of traced operations that started and ended
 *   inside the window. An upper bound on blocking: async operations (e.g. `log.scan`) may await
 *   I/O inside their span.
 * - `threadCpuMs`: main-thread CPU over the window.
 * - `offCpuMs`: `windowMs - threadCpuMs`. Includes the normal idle time before the heartbeat was
 *   due, plus scheduling delay or a blocking wait (sync I/O, a lock) the process cannot tell apart.
 */
type StallTiming = { windowMs?: number; measuredMaxMs?: number; operationMs?: string; threadCpuMs?: number; offCpuMs?: number };

export function createLoopOperations(now = () => performance.now()) {
  // Per-name coverage survives bursts of fast operations before the heartbeat can run.
  const completed = new Map<OperationName, Operation>();
  const active = new Map<OperationName, { startedAt: number; count: number }>();
  // Longest duration per name in the current heartbeat window; work begun before the window
  // spans an await, so its duration is not synchronous loop time.
  const measured = new Map<OperationName, number>();
  let windowStart = -Infinity;
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
        const endedAt = now();
        completed.set(name, { startedAt, endedAt });
        if (startedAt >= windowStart) measured.set(name, Math.max(measured.get(name) ?? 0, endedAt - startedAt));
      };
    },
    /** Returns the closing window's longest durations in fixed name order and opens a window at `next`. */
    drain(next: number): Map<OperationName, number> {
      const longest = new Map(LOOP_OPERATIONS.flatMap(name => measured.has(name) ? [[name, measured.get(name)!] as const] : []));
      measured.clear();
      windowStart = next;
      return longest;
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
function defaultThreadCpu(): (() => NodeJS.CpuUsage) | undefined {
  const read = (process as { threadCpuUsage?: () => NodeJS.CpuUsage }).threadCpuUsage;
  return typeof read === "function" ? () => read.call(process) : undefined;
}
export function traceLoopOperation<T>(name: OperationName, work: () => T): T {
  const end = loopOperations.begin(name);
  try { return work(); } finally { end(); }
}

/** A separate heartbeat avoids changing the callback histogram's sampling/reset semantics. */
export function createLoopStallMonitor(emit: (stall: Stall) => void, options: {
  sample?: (sample: RuntimeSample) => void; cpu?: () => NodeJS.CpuUsage; tick?: () => void;
  /** Main-thread CPU; process-wide CPU would count GC and I/O helper threads as loop work. */
  threadCpu?: (() => NodeJS.CpuUsage) | null;
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
  const threadCpu = options.threadCpu === undefined ? defaultThreadCpu() : options.threadCpu ?? undefined;
  let previousThread: NodeJS.CpuUsage | undefined;
  try { previousThread = threadCpu?.(); } catch { /* CPU attribution is optional. */ }
  let latestLag = 0;
  const lags: number[] = [];
  let lastEmission = -Infinity;
  let timer: ReturnType<typeof setInterval> | undefined;
  function check() {
    const at = now();
    const start = previous;
    previous = at;
    const stallMs = at - start - 250;
    const longest = operations.drain(at);
    let thread: NodeJS.CpuUsage | undefined;
    try { thread = threadCpu?.(); } catch { /* CPU attribution is optional. */ }
    const lastThread = previousThread;
    previousThread = thread;
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
    const timing: StallTiming = { windowMs: Math.round(at - start) };
    if (longest.size) {
      timing.measuredMaxMs = Math.round(Math.max(...longest.values()));
      timing.operationMs = [...longest].map(([name, ms]) => `${name}:${Math.round(ms)}`).join(",");
    }
    if (thread && lastThread) {
      const threadCpuMs = Math.max(0, thread.user + thread.system - lastThread.user - lastThread.system) / 1000;
      timing.threadCpuMs = Math.round(threadCpuMs);
      timing.offCpuMs = Math.round(Math.max(0, at - start - threadCpuMs));
    }
    try { emit({ ...host(), stallMs, operations: operations.during(start, at), ...timing }); }
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
      try { previousThread = threadCpu?.(); } catch { previousThread = undefined; }
      operations.drain(previous);
      lags.length = 0;
      timer = setInterval(check, 250);
      timer.unref();
    },
    stop() { clearInterval(timer); timer = undefined; },
  };
}
