import { assert, describe, it } from "@effect/vitest";
import type { ResourceTelemetryProcess } from "@t3tools/contracts";

import {
  assignRuntimeSlots,
  groupProcesses,
  providerRuntimeChildren,
} from "./ProcessGroupMetrics.ts";

const process = (
  pid: number,
  ppid: number,
  name: string,
  category: ResourceTelemetryProcess["category"] = "server-child",
  command = name,
) =>
  ({
    identity: { pid, startTimeMs: 1 },
    ppid,
    name,
    command,
    category,
    residentBytes: pid * 1_000,
    cpuPercent: pid,
  }) as ResourceTelemetryProcess;

describe("groupProcesses", () => {
  it("sums each direct child of the server with its whole subtree", () => {
    const totals = groupProcesses([
      process(10, 1, "node", "server"),
      process(11, 10, "t3-resource-mon", "resource-monitor"),
      process(20, 10, "claude"),
      process(21, 20, "bash"),
      process(22, 21, "cargo"),
      process(30, 10, "codex"),
      process(40, 10, "zsh"),
      process(50, 10, "chrome-headless"),
      process(60, 10, "git", "server-child", "git checkout claude/fix"),
      process(70, 99, "orphan"),
      // An older Claude package runs as a script under node.
      process(
        80,
        10,
        "node",
        "server-child",
        "node /opt/node_modules/@anthropic-ai/claude-code/cli.js",
      ),
      process(90, 10, "node", "server-child", "node /srv/tools/report.js"),
    ]);

    assert.deepStrictEqual(Object.fromEntries(totals), {
      server: { residentBytes: 10_000, cpuPercent: 10, count: 1 },
      "resource-monitor": { residentBytes: 11_000, cpuPercent: 11, count: 1 },
      // The agent's shell and the build it ran belong to the agent, not the terminal group.
      claude: { residentBytes: 143_000, cpuPercent: 143, count: 4 },
      codex: { residentBytes: 30_000, cpuPercent: 30, count: 1 },
      terminal: { residentBytes: 40_000, cpuPercent: 40, count: 1 },
      browser: { residentBytes: 50_000, cpuPercent: 50, count: 1 },
      // `git` whose arguments mention claude, a parentless process, and a node script.
      other: { residentBytes: 220_000, cpuPercent: 220, count: 3 },
    });
  });
});

describe("providerRuntimeChildren", () => {
  it("counts each runtime's descendants without counting the runtime or sibling processes", () => {
    const processes = [
      process(10, 1, "node", "server"),
      process(20, 10, "codex"),
      process(21, 20, "node", "server-child", "node dia-agent-bridge/src/server.js"),
      process(22, 21, "helper"),
      process(23, 20, "perplexity-mcp"),
      process(24, 20, "cua-driver"),
      process(30, 10, "codex"),
      process(31, 30, "node"),
      process(40, 10, "node", "server-child", "node /opt/claude-code/cli.js"),
      process(41, 40, "node"),
      process(50, 10, "zsh"),
      process(51, 50, "codex"),
      process(60, 99, "node"),
      process(70, 71, "node"),
      process(71, 70, "node"),
    ];
    assert.deepEqual(providerRuntimeChildren(processes), [
      { provider: "codex", pid: 20, startTimeMs: 1, count: 4, residentBytes: 90_000 },
      { provider: "codex", pid: 30, startTimeMs: 1, count: 1, residentBytes: 31_000 },
      { provider: "claude", pid: 40, startTimeMs: 1, count: 1, residentBytes: 41_000 },
    ]);
    assert.deepEqual(
      providerRuntimeChildren(processes.filter((p) => p.ppid !== 20 && p.ppid !== 21))[0],
      {
        provider: "codex",
        pid: 20,
        startTimeMs: 1,
        count: 0,
        residentBytes: 0,
      },
    );
  });

  it("requires the server identity before assigning runtime ownership", () => {
    assert.deepEqual(
      providerRuntimeChildren([process(20, 10, "codex"), process(21, 20, "node")]),
      [],
    );
  });
});

describe("assignRuntimeSlots", () => {
  const runtime = (pid: number, provider = "codex", startTimeMs = 1) => ({
    provider,
    pid,
    startTimeMs,
    count: 3,
    residentBytes: 6000,
  });
  it("keeps surviving slots, reuses exited slots and clears empty series", () => {
    const first = assignRuntimeSlots([runtime(10), runtime(20), runtime(30, "claude")], []);
    assert.deepEqual(
      first.active.map((r) => [r.provider, r.pid, r.slot]),
      [
        ["codex", 10, 0],
        ["codex", 20, 1],
        ["claude", 30, 0],
      ],
    );
    const second = assignRuntimeSlots([runtime(20), runtime(40)], first.active);
    assert.deepEqual(
      second.active.map((r) => [r.pid, r.slot]),
      [
        [20, 1],
        [40, 0],
      ],
    );
    assert.deepEqual(second.samples.at(-1), {
      ...runtime(30, "claude"),
      slot: 0,
      count: 0,
      residentBytes: 0,
    });
    const empty = assignRuntimeSlots([], second.active);
    assert.deepEqual(
      empty.samples.map((r) => [r.slot, r.count, r.residentBytes]),
      [
        [1, 0, 0],
        [0, 0, 0],
      ],
    );
    assert.deepEqual(assignRuntimeSlots([], empty.active), { active: [], samples: [] });
  });
  it("distinguishes a reused PID without increasing series over repeated restarts", () => {
    let previous = assignRuntimeSlots([runtime(10)], []).active;
    for (let start = 2; start < 100; start++) {
      const next = assignRuntimeSlots([runtime(10, "codex", start)], previous);
      assert.deepEqual(next.samples, [{ ...runtime(10, "codex", start), slot: 0 }]);
      previous = next.active;
    }
  });
});
