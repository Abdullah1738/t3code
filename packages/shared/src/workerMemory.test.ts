// @effect-diagnostics nodeBuiltinImport:off -- Verifies the serialized diagnostic in a real worker.
import * as NodeWorkerThreads from "node:worker_threads";
import { expect, it } from "vite-plus/test";
import { workerMemoryHeartbeatSource, workerMemoryLimits } from "./workerMemory.ts";

it.each(Object.entries(workerMemoryLimits))(
  "applies the %s heap limit to a real worker",
  async (role, limits) => {
    const worker = new NodeWorkerThreads.Worker(
      workerMemoryHeartbeatSource(role as keyof typeof workerMemoryLimits) +
        'require("node:worker_threads").parentPort.postMessage(require("node:v8").getHeapStatistics().heap_size_limit)',
      { eval: true, resourceLimits: limits, execArgv: [] },
    );
    try {
      const heapLimit = await new Promise<number>((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
      });
      expect(heapLimit).toBeGreaterThanOrEqual(limits.maxOldGenerationSizeMb * 1024 * 1024);
      expect(heapLimit).toBeLessThanOrEqual(
        (limits.maxOldGenerationSizeMb + 2 * limits.maxYoungGenerationSizeMb) * 1024 * 1024,
      );
    } finally {
      await worker.terminate();
    }
  },
);
