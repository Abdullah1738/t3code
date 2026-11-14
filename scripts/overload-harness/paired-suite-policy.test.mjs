import { expect, it } from "vite-plus/test";
import {
  DATA_ROOT,
  placementFailures,
  measuredRunKey,
  measuredProcessKey,
  steadyWindowKey,
} from "./paired-suite-policy.mjs";
const boxes = ["bx_fixture0", "bx_fixture1", "bx_fixture2"];
const example = () => {
  const plan = {
    batch: 3,
    rotation: 0,
    writtenAtMs: 1000,
    releaseEpochMs: 45000,
    hash: "a".repeat(64),
    assignment: { A: boxes[0], B: boxes[1], C: boxes[2] },
  };
  const runs = ["A", "B", "C"].map((arm, i) => {
    const id = {
      nodePid: 100 + i,
      nodeStartEpochMs: 2000 + i,
      linuxStartTicks: String(1000 + i),
      bootId: "fixture-boot",
      offboxBoxId: boxes[i],
      hostname: boxes[i].replace("bx_", "bx-"),
      parentOffboxRunId: `parent-${i}`,
      batch: 3,
      arm,
    };
    return {
      offboxRunId: `parent-${i}`,
      offboxBoxId: boxes[i],
      wallMs: 600000,
      pairedMeasurement: {
        steadyEpochMs: 170000,
        resources: [
          { boundary: "start", data: id },
          { boundary: "end", data: { ...id } },
        ],
      },
      suiteExecution: {
        parentOffboxRunId: `parent-${i}`,
        batch: 3,
        arm,
        nodePid: 100 + i,
        expectedBoxId: boxes[i],
        planHash: plan.hash,
        launchedAtMs: 2000,
        launchIdentity: {
          offboxBoxId: boxes[i],
          hostname: id.hostname,
          parentOffboxRunId: `parent-${i}`,
        },
        processesAtLaunch: [{ pid: 1, comm: "init" }],
        freshDirectory: { path: `${DATA_ROOT}/3-${arm}`, created: true, existedBefore: false },
        previousDirectory: { path: null, gone: true },
      },
    };
  });
  return { plan, runs };
};
it("accepts the prewritten Latin row and produces distinct measured identities", () => {
  const { plan, runs } = example();
  expect(placementFailures(runs, plan, 0, boxes)).toEqual([]);
  expect(new Set(runs.map(measuredRunKey)).size).toBe(3);
  expect(measuredProcessKey(runs[0])).toContain("parent-0");
  expect(JSON.parse(steadyWindowKey(runs[0]))).toEqual(["parent-0", 100, 2000, 170000, 770000]);
});
it.each([
  ["wrong launch box", (r) => (r.suiteExecution.launchIdentity.offboxBoxId = boxes[1])],
  ["wrong end box", (r) => (r.pairedMeasurement.resources[1].data.offboxBoxId = boxes[1])],
  ["reused data folder", (r) => (r.suiteExecution.freshDirectory.existedBefore = true)],
  ["launch parent missing", (r) => delete r.suiteExecution.launchIdentity.parentOffboxRunId],
  [
    "changed Incus identity",
    (r) => (r.pairedMeasurement.resources[1].data.incusContainerId = "another-container"),
  ],
  ["missing wipe", (r) => (r.suiteExecution.previousDirectory.gone = false)],
  ["missing process inventory", (r) => (r.suiteExecution.processesAtLaunch = [])],
  ["pid changed", (r) => (r.pairedMeasurement.resources[1].data.nodePid = 999)],
  ["process start changed", (r) => r.pairedMeasurement.resources[1].data.nodeStartEpochMs++],
  ["missing process start", (r) => delete r.pairedMeasurement.resources[0].data.nodeStartEpochMs],
  ["wrong parent", (r) => (r.pairedMeasurement.resources[1].data.parentOffboxRunId = "invented")],
  ["missing end", (r) => r.pairedMeasurement.resources.pop()],
])("invalidates %s", (_, change) => {
  const { plan, runs } = example();
  change(runs[0]);
  expect(placementFailures(runs, plan, 0, boxes).length).toBeGreaterThan(0);
});
it("rejects the wrong Latin row and identifies a repeated physical process even across windows", () => {
  const { plan, runs } = example();
  expect(placementFailures(runs, plan, 1, boxes).length).toBeGreaterThan(0);
  const second = structuredClone(runs[0]);
  second.suiteExecution.batch = 4;
  second.pairedMeasurement.steadyEpochMs += 900000;
  expect(measuredRunKey(second)).not.toBe(measuredRunKey(runs[0]));
  expect(measuredProcessKey(second)).toBe(measuredProcessKey(runs[0]));
});
