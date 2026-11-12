// @effect-diagnostics nodeBuiltinImport:off - Linux worker host counters.
import { readFileSync } from "node:fs";
export function hostCounters() {
  const cpu = readFileSync("/proc/stat", "utf8")
    .split("\n")[0]!
    .trim()
    .split(/\s+/)
    .slice(1)
    .map(Number);
  const pressure = readFileSync("/proc/pressure/io", "utf8");
  return {
    total: cpu.slice(0, 8).reduce((a, b) => a + b, 0),
    steal: cpu[7]!,
    some: Number(pressure.match(/some .*total=(\d+)/)?.[1]),
    full: Number(pressure.match(/full .*total=(\d+)/)?.[1]),
    at: performance.now(),
  };
}
export function hostDelta(a: ReturnType<typeof hostCounters>, b: ReturnType<typeof hostCounters>) {
  return {
    stealPct: (100 * (b.steal - a.steal)) / (b.total - a.total),
    ioSomePct: (b.some - a.some) / (10 * (b.at - a.at)),
    ioFullPct: (b.full - a.full) / (10 * (b.at - a.at)),
  };
}
