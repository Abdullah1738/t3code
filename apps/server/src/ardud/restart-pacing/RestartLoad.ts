// @effect-diagnostics nodeBuiltinImport:off -- Interval host CPU and event-loop counters drive restart pacing.
import * as NodeOS from "node:os";
import * as NodePerfHooks from "node:perf_hooks";

const sampleHost = () => {
  const cpus = NodeOS.cpus();
  const loop = NodePerfHooks.performance.eventLoopUtilization();
  return {
    at: NodePerfHooks.performance.now(),
    idle: cpus.reduce((sum, cpu) => sum + cpu.times.idle, 0),
    total: cpus.reduce(
      (sum, cpu) => sum + Object.values(cpu.times).reduce((total, time) => total + time, 0),
      0,
    ),
    loopIdle: loop.idle,
    loopActive: loop.active,
  };
};

export const makeRestartLoad = (sample = sampleHost) => {
  let previous = sample();
  let load = 0;
  return () => {
    const current = sample();
    if (current.at - previous.at < 10_000) return load;
    const total = current.total - previous.total;
    const idle = current.idle - previous.idle;
    const active = current.loopActive - previous.loopActive;
    const loopTotal = active + current.loopIdle - previous.loopIdle;
    const busy = total > 0 && idle >= 0 ? Math.max(0, 1 - idle / total) : 0;
    const utilization = loopTotal > 0 && active >= 0 ? active / loopTotal : 0;
    previous = current;
    // A score above one means either the host is >85% busy or the server's
    // event loop is >90% busy. macOS loadavg also counts blocked I/O threads.
    load = Math.max(busy / 0.85, utilization / 0.9);
    return load;
  };
};
