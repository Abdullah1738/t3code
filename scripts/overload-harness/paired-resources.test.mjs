import { expect, it } from "vite-plus/test";
import { ownCgroup, pressureTotals, resourcePercentages } from "./paired-resources.mjs";
import { resourceFairnessFailures } from "./paired-suite-policy.mjs";
it("proves the server process membership instead of assuming the cgroup root", () => {
  const files = { "/sys/fs/cgroup/boatd/42/cgroup.procs": "123\n" };
  expect(
    ownCgroup({
      pid: 123,
      cgroup: "0::/boatd/42\n",
      mountinfo: "1 0 0:9 / /sys/fs/cgroup rw - cgroup2 cgroup rw",
      readFile: (p) => {
        if (!(p in files)) throw Error("missing");
        return files[p];
      },
    }),
  ).toBe("/sys/fs/cgroup/boatd/42");
  expect(() =>
    ownCgroup({
      pid: 456,
      cgroup: "0::/boatd/42\n",
      mountinfo: "1 0 0:9 / /sys/fs/cgroup rw - cgroup2 cgroup rw",
      readFile: (p) => files[p] ?? "",
    }),
  ).toThrow();
});
it.each([
  "some avg10=0 total=0\nfull avg10=0 total=20",
  "some avg10=0 avg60=0 avg300=0 total=12345\nfull avg10=0 total=3",
])("reads raw pressure counters %s", (text) =>
  expect(pressureTotals(text).someTotalUs).toBeGreaterThanOrEqual(0),
);
it.each([
  "",
  "full avg10=0 total=1",
  "some avg10=0 total=-1",
  "some total=99999999999999999999999",
])("rejects missing or invalid pressure %s", (text) =>
  expect(() => pressureTotals(text)).toThrow(),
);
const run = (arm, delta = 6000000) => ({
  wallMs: 600000,
  suiteExecution: { arm },
  pairedMeasurement: {
    resources: [
      {
        boundary: "start",
        data: {
          nodePid: 10,
          membershipPid: 10,
          cgroupPath: "/cgroup/own",
          pressure: { someTotalUs: 100, fullTotalUs: 50 },
          cpuStat: { throttled_usec: 0, nr_throttled: 0 },
          cpuMax: "max 100000",
          sharedHostStat: { stealTicks: 0, totalTicks: 100 },
        },
      },
      {
        boundary: "end",
        data: {
          nodePid: 10,
          membershipPid: 10,
          cgroupPath: "/cgroup/own",
          pressure: { someTotalUs: 100 + delta, fullTotalUs: 50 },
          cpuStat: { throttled_usec: 0, nr_throttled: 0 },
          cpuMax: "max 100000",
          sharedHostStat: { stealTicks: 0, totalTicks: 1000 },
        },
      },
    ],
  },
});
it("uses the exact steady wall denominator and gates pressure at2pp", () => {
  const A = run("A"),
    B = run("B"),
    C = run("C", 18000000);
  expect(resourcePercentages(A).pressurePct).toBe(1);
  expect(resourceFairnessFailures([A, B, C], "loaded")).toEqual([]);
  C.pairedMeasurement.resources[1].data.pressure.someTotalUs++;
  expect(resourceFairnessFailures([A, B, C], "loaded")).toContain(
    "A/C CPU pressure differs by more than2.0pp",
  );
  expect(resourceFairnessFailures([A, B, C], "quiet-enough")).toEqual([]);
});
it.each(["missing", "backwards", "wrong cgroup", "wrong membership"])(
  "invalidates %s own pressure evidence",
  (kind) => {
    const rows = [run("A"), run("B"), run("C")],
      d = rows[0].pairedMeasurement.resources[1].data;
    if (kind === "missing") delete d.pressure;
    else if (kind === "backwards") d.pressure.someTotalUs = 0;
    else if (kind === "wrong cgroup") d.cgroupPath = "/wrong";
    else d.membershipPid = 99;
    expect(resourceFairnessFailures(rows, "loaded").length).toBeGreaterThan(0);
  },
);
it("records B pressure without gating it and applies limited-quota throttling separately", () => {
  const rows = [run("A"), run("B"), run("C")];
  delete rows[1].pairedMeasurement.resources[1].data.pressure;
  expect(resourceFairnessFailures(rows, "loaded")).toEqual([]);
  for (const e of rows[0].pairedMeasurement.resources) e.data.cpuMax = "100000 100000";
  rows[0].pairedMeasurement.resources[1].data.cpuStat.throttled_usec = 12000001;
  expect(resourceFairnessFailures(rows, "loaded")).toContain(
    "limited CPU: A/C throttling differs by more than2.0pp",
  );
});
