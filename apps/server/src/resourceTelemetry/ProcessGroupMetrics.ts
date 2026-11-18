import * as ProviderRuntimeInventory from "../ardud/providers/ProviderRuntimeInventory.ts";
import type { ResourceTelemetryProcess } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";

import * as ServerConfig from "../config.ts";
import { metricAttributes } from "../observability/Metrics.ts";
import * as ResourceTelemetry from "./ResourceTelemetry.ts";

const SAMPLE_INTERVAL = "1 minute";

const residentBytes = Metric.gauge("t3_process_group_resident_bytes", {
  description: "Resident memory of the server's processes, summed by group.",
  attributes: { unit: "By" },
});
const cpuPercent = Metric.gauge("t3_process_group_cpu_percent", {
  description: "CPU use of the server's processes, summed by group; 100 is one full core.",
  attributes: { unit: "%" },
});
const processCount = Metric.gauge("t3_process_group_count", {
  description: "Processes in each group.",
  attributes: { unit: "{process}" },
});

const runtimeChildCount = Metric.gauge("t3_provider_runtime_child_process_count", {
  description: "Descendant processes of one provider runtime, excluding the runtime itself.",
  attributes: { unit: "{process}" },
});
const runtimeChildResidentBytes = Metric.gauge("t3_provider_runtime_child_resident_bytes", {
  description: "Resident memory of one provider runtime's descendant processes.",
  attributes: { unit: "By" },
});

// Each direct child of the server names the group of its whole subtree. A fixed set keeps one
// series per group per server, however many agents and processes come and go.
const PROVIDER_GROUPS: ReadonlyArray<readonly [RegExp, string]> = [
  [/codex/, "codex"],
  [/claude/, "claude"],
  [/cursor/, "cursor"],
  [/opencode/, "opencode"],
  [/grok/, "grok"],
  [/antigravity|gemini/, "antigravity"],
];
const OTHER_GROUPS: ReadonlyArray<readonly [RegExp, string]> = [
  [/chrom/, "browser"],
  [/^(?:ba|z|fi|da|c)?sh(?:\.exe)?$|^pwsh|^powershell|^cmd\.exe$/, "terminal"],
];
// A CLI shipped as a script runs under a JavaScript runtime, so its process name is the
// runtime's (older Claude packages run `node .../@anthropic-ai/claude-code/cli.js`). Only those
// are matched by command line; any other name is matched by name alone, so a shell or `git`
// whose arguments mention a provider stays in its own group.
const SCRIPT_RUNTIME = /^(?:node|bun|deno)(?:\.exe)?$/;

const match = (groups: ReadonlyArray<readonly [RegExp, string]>, text: string) =>
  groups.find(([pattern]) => pattern.test(text))?.[1];

const childGroup = (name: string, command: string) => {
  const lowerName = name.toLowerCase();
  if (SCRIPT_RUNTIME.test(lowerName))
    return match(PROVIDER_GROUPS, command.toLowerCase()) ?? "other";
  return match(PROVIDER_GROUPS, lowerName) ?? match(OTHER_GROUPS, lowerName) ?? "other";
};

export interface ProcessGroupTotals {
  readonly residentBytes: number;
  readonly cpuPercent: number;
  readonly count: number;
}

export function groupProcesses(
  processes: ReadonlyArray<ResourceTelemetryProcess>,
): ReadonlyMap<string, ProcessGroupTotals> {
  const byPid = new Map(processes.map((process) => [process.identity.pid, process]));
  const serverPid = processes.find((process) => process.category === "server")?.identity.pid;
  const groupOf = (process: ResourceTelemetryProcess): string => {
    if (process.category === "server") return "server";
    if (process.category === "resource-monitor") return "resource-monitor";
    if (process.category.startsWith("electron-")) return "electron";
    let current = process;
    // Bounded by the table size, in case a reused PID makes the parent chain loop.
    for (let step = 0; step < processes.length; step++) {
      if (current.ppid === serverPid) return childGroup(current.name, current.command);
      const parent = byPid.get(current.ppid);
      if (parent === undefined) break;
      current = parent;
    }
    return "other";
  };
  const totals = new Map<string, ProcessGroupTotals>();
  for (const process of processes) {
    const group = groupOf(process);
    const total = totals.get(group) ?? { residentBytes: 0, cpuPercent: 0, count: 0 };
    totals.set(group, {
      residentBytes: total.residentBytes + process.residentBytes,
      cpuPercent: total.cpuPercent + process.cpuPercent,
      count: total.count + 1,
    });
  }
  return totals;
}

export function providerRuntimeChildren(processes: ReadonlyArray<ResourceTelemetryProcess>) {
  const serverPid = processes.find((process) => process.category === "server")?.identity.pid;
  const byPid = new Map(processes.map((process) => [process.identity.pid, process]));
  const runtimes = new Map(
    processes.flatMap((process) => {
      if (serverPid === undefined || process.ppid !== serverPid) return [];
      const provider = childGroup(process.name, process.command);
      if (!PROVIDER_GROUPS.some(([, name]) => name === provider)) return [];
      const total = { process, provider, count: 0, residentBytes: 0 };
      return [[process.identity.pid, total] as const];
    }),
  );
  for (const process of processes) {
    let parentPid = process.ppid;
    for (let step = 0; step < processes.length; step++) {
      const runtime = runtimes.get(parentPid);
      if (runtime !== undefined) {
        runtime.count++;
        runtime.residentBytes += process.residentBytes;
        break;
      }
      const parent = byPid.get(parentPid);
      if (parent === undefined || parent === process) break;
      parentPid = parent.ppid;
    }
  }
  return [...runtimes.values()].map(({ process, ...total }) => ({
    ...total,
    pid: process.identity.pid,
    startTimeMs: process.identity.startTimeMs,
  }));
}

type RuntimeChildren = ReturnType<typeof providerRuntimeChildren>[number];
type RuntimeSample = RuntimeChildren & { readonly slot: number };

// Reuse labels after a runtime exits: PID labels would retain a metric series for every turn.
export function assignRuntimeSlots(
  runtimes: ReadonlyArray<RuntimeChildren>,
  previous: ReadonlyArray<RuntimeSample>,
) {
  const sameRuntime = (a: RuntimeChildren, b: RuntimeChildren) =>
    a.provider === b.provider && a.pid === b.pid && a.startTimeMs === b.startTimeMs;
  const active = runtimes.flatMap((runtime) => {
    const prior = previous.find((candidate) => sameRuntime(runtime, candidate));
    return prior === undefined ? [] : [{ ...runtime, slot: prior.slot }];
  });
  for (const runtime of runtimes) {
    if (active.some((candidate) => sameRuntime(runtime, candidate))) continue;
    let slot = 0;
    while (
      active.some((candidate) => candidate.provider === runtime.provider && candidate.slot === slot)
    )
      slot++;
    active.push({ ...runtime, slot });
  }
  const exited = previous
    .filter(
      (prior) =>
        !active.some(
          (runtime) => runtime.provider === prior.provider && runtime.slot === prior.slot,
        ),
    )
    .map((runtime) => ({ ...runtime, count: 0, residentBytes: 0 }));
  return { active, samples: [...active, ...exited] };
}

// Inventory and exported gauges consume the same process capture, once a minute.
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const telemetry = yield* ResourceTelemetry.ResourceTelemetry;
    const inventory = yield* ProviderRuntimeInventory.ProviderRuntimeInventory;
    // A group that empties reads zero rather than holding its last value.
    const seen = new Set<string>();
    let previousRuntimes: ReadonlyArray<RuntimeSample> = [];
    const sample = Effect.fn("ProcessGroupMetrics.sample")(function* () {
      const snapshot = yield* telemetry.refresh;
      const processes = snapshot.processes;
      const runtimes = assignRuntimeSlots(providerRuntimeChildren(processes), previousRuntimes);
      previousRuntimes = runtimes.active;
      yield* inventory.refresh(snapshot, runtimes.active).pipe(
        Effect.timeout("45 seconds"),
        Effect.catchCause(() => Effect.logWarning("provider runtime inventory sample unavailable")),
      );
      if (config.otlpMetricsUrl === undefined) return;
      const totals = groupProcesses(processes);
      for (const group of totals.keys()) seen.add(group);
      for (const group of seen) {
        const total = totals.get(group) ?? { residentBytes: 0, cpuPercent: 0, count: 0 };
        const attributes = metricAttributes({ group });
        yield* Metric.update(Metric.withAttributes(residentBytes, attributes), total.residentBytes);
        yield* Metric.update(Metric.withAttributes(cpuPercent, attributes), total.cpuPercent);
        yield* Metric.update(Metric.withAttributes(processCount, attributes), total.count);
      }
      for (const runtime of runtimes.samples) {
        const attributes = metricAttributes({
          provider: runtime.provider,
          runtimeSlot: String(runtime.slot),
        });
        yield* Metric.update(Metric.withAttributes(runtimeChildCount, attributes), runtime.count);
        yield* Metric.update(
          Metric.withAttributes(runtimeChildResidentBytes, attributes),
          runtime.residentBytes,
        );
      }
      for (const runtime of runtimes.active) {
        yield* Effect.logInfo("orchestration-v2.driver-session.child-processes", {
          provider: runtime.provider,
          runtimePid: runtime.pid,
          runtimeStartTimeMs: runtime.startTimeMs,
          runtimeSlot: runtime.slot,
          childProcessCount: runtime.count,
          childResidentBytes: runtime.residentBytes,
        });
      }
    });
    yield* sample().pipe(
      Effect.catch((error) =>
        Effect.logDebug("process group metrics sample failed", { error: error.message }),
      ),
      Effect.andThen(Effect.sleep(SAMPLE_INTERVAL)),
      Effect.forever,
      Effect.forkScoped,
    );
  }),
);
