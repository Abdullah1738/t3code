// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalConsole:off -- Worker-local diagnostics must also run inside serialized workers without Effect.
import * as NodeV8 from "node:v8";
import * as NodeWorkerThreads from "node:worker_threads";

// These constrain individual V8 heaps, not the shared cage or external/native memory.
export const workerMemoryLimits = {
  reader: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 8 },
  writer: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 8 },
  checkpoint: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4 },
  exporter: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 8 },
  backup: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 8 },
  spawn: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 },
  guard: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4 },
} as const;

export type WorkerMemoryRole = keyof typeof workerMemoryLimits;

// Keep self-contained: this function is serialized into eval workers and bundles.
function heartbeat(role: string, threadId: number, heap: typeof NodeV8.getHeapStatistics) {
  const sample = () => {
    const stats = heap();
    console.info("worker.heap", {
      pid: process.pid,
      workerId: threadId,
      role,
      heapUsed: stats.used_heap_size,
      heapLimit: stats.heap_size_limit,
    });
  };
  sample();
  setInterval(sample, 60_000).unref();
}

export const workerMemoryHeartbeatSource = (role: WorkerMemoryRole) =>
  `(${heartbeat.toString()})(${JSON.stringify(role)}, require("node:worker_threads").threadId, require("node:v8").getHeapStatistics);\n`;

const active = new Map<number, WorkerMemoryRole>();

/** Counts workers created by this isolate; nested writer workers report separately. */
export function trackWorkerMemory<T extends NodeWorkerThreads.Worker>(
  worker: T,
  role: WorkerMemoryRole,
): T {
  const id = worker.threadId;
  active.set(id, role);
  const report = () =>
    console.info("worker.count", {
      pid: process.pid,
      parentWorkerId: NodeWorkerThreads.threadId,
      count: active.size,
      roles: Object.fromEntries(
        Object.keys(workerMemoryLimits).map((role) => [
          role,
          [...active.values()].filter((value) => value === role).length,
        ]),
      ),
    });
  report();
  worker.once("exit", () => {
    active.delete(id);
    report();
  });
  return worker;
}
