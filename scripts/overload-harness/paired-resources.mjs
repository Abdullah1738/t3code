import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodePerfHooks from "node:perf_hooks";

const decodeMount = (value) =>
  value.replace(/\\([0-7]{3})/g, (_, n) => String.fromCharCode(Number.parseInt(n, 8)));
export const ownCgroup = ({ pid, cgroup, mountinfo, readFile }) => {
  const path = cgroup
    .split("\n")
    .find((x) => x.startsWith("0::"))
    ?.slice(3);
  if (!path || !path.startsWith("/") || path.split("/").includes(".."))
    throw Error("Unified process cgroup unavailable");
  const candidates = [];
  for (const line of mountinfo.split("\n")) {
    const [left, right] = line.split(" - ");
    if (!right?.startsWith("cgroup2 ")) continue;
    const fields = left.split(" "),
      root = decodeMount(fields[3]),
      mount = decodeMount(fields[4]);
    const suffixes = [path.slice(1)];
    if (path === root || path.startsWith(root + "/"))
      suffixes.push(NodePath.posix.relative(root, path));
    for (const suffix of suffixes) {
      const actual = NodePath.posix.resolve(mount, suffix);
      if (actual !== mount && !actual.startsWith(mount + "/")) continue;
      try {
        if (
          readFile(actual + "/cgroup.procs")
            .trim()
            .split(/\s+/)
            .includes(String(pid))
        )
          candidates.push(actual);
      } catch {}
    }
  }
  const unique = [...new Set(candidates)];
  if (unique.length !== 1) throw Error("Cannot prove the cgroup holding the server process");
  return unique[0];
};
export const pressureTotals = (text) => {
  const value = (kind) => {
    const n = new RegExp("^" + kind + " .*\\btotal=(\\d+)(?:\\s|$)", "m").exec(text)?.[1];
    return n === undefined ? null : Number(n);
  };
  const some = value("some"),
    full = value("full");
  if (!Number.isSafeInteger(some) || some < 0)
    throw Error("cpu.pressure some total missing or invalid");
  return {
    someTotalUs: some,
    fullTotalUs: Number.isSafeInteger(full) && full >= 0 ? full : null,
    raw: text,
  };
};
export const captureOwnResources = () => {
  const beforePerformanceMs = NodePerfHooks.performance.now();
  const data = {
    nodePid: process.pid,
    nodeStartEpochMs: NodePerfHooks.performance.timeOrigin,
    hostname: NodeOS.hostname(),
    beforePerformanceMs,
    errors: {},
    sharedHostView: true,
  };
  data.offboxBoxId = /^bx-[a-z0-9]{8}$/.test(data.hostname)
    ? data.hostname.replace("bx-", "bx_")
    : null;
  data.parentOffboxRunId = process.env.OFFBOX_RUN_ID ?? null;
  data.batch = process.env.OVERLOAD_BATCH ? Number(process.env.OVERLOAD_BATCH) : null;
  data.arm = process.env.OVERLOAD_ARM ?? null;
  data.incusContainerId =
    process.env.INCUS_INSTANCE_ID ?? process.env.container_uuid ?? process.env.LXC_NAME ?? null;
  data.incusContainerIdAvailability = "known process environment keys; hostname also observed";
  const read = (path) => NodeFS.readFileSync(path, "utf8");
  try {
    data.bootId = read("/proc/sys/kernel/random/boot_id").trim();
    const stat = read("/proc/self/stat");
    data.linuxStartTicks = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19];
  } catch (error) {
    data.errors.process = String(error);
  }
  try {
    const path = ownCgroup({
      pid: process.pid,
      cgroup: read("/proc/self/cgroup"),
      mountinfo: read("/proc/self/mountinfo"),
      readFile: read,
    });
    data.cgroupPath = path;
    data.membershipPid = process.pid;
    try {
      data.pressure = pressureTotals(read(path + "/cpu.pressure"));
    } catch (error) {
      data.errors.pressure = String(error);
    }
    try {
      data.cpuStat = Object.fromEntries(
        read(path + "/cpu.stat")
          .trim()
          .split("\n")
          .map((x) => {
            const [key, value] = x.split(/\s+/);
            return [key, Number(value)];
          }),
      );
    } catch (error) {
      data.errors.cpuStat = String(error);
    }
    try {
      data.cpuMax = read(path + "/cpu.max").trim();
    } catch (error) {
      data.errors.cpuMax = String(error);
    }
  } catch (error) {
    data.errors.cgroup = String(error);
  }
  try {
    const fields = read("/proc/stat").split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
    data.sharedHostStat = {
      stealTicks: fields[7],
      totalTicks: fields.slice(0, 8).reduce((a, b) => a + b, 0),
      view: "shared host view; diagnostic only",
    };
  } catch (error) {
    data.errors.hostStat = String(error);
  }
  data.afterPerformanceMs = NodePerfHooks.performance.now();
  return data;
};
export const resourcePercentages = (run) => {
  const entries = Array.isArray(run.pairedMeasurement?.resources)
    ? run.pairedMeasurement.resources
    : [];
  const before = entries?.find((x) => x?.boundary === "start")?.data,
    after = entries?.find((x) => x?.boundary === "end")?.data;
  const denominator = run.wallMs * 1000;
  const delta = (a, b) =>
    Number.isSafeInteger(a) && Number.isSafeInteger(b) && b >= a ? b - a : null;
  const some = delta(before?.pressure?.someTotalUs, after?.pressure?.someTotalUs),
    full = delta(before?.pressure?.fullTotalUs, after?.pressure?.fullTotalUs),
    throttled = delta(before?.cpuStat?.throttled_usec, after?.cpuStat?.throttled_usec),
    steal = delta(before?.sharedHostStat?.stealTicks, after?.sharedHostStat?.stealTicks),
    total = delta(before?.sharedHostStat?.totalTicks, after?.sharedHostStat?.totalTicks);
  const percent = (value) =>
    value !== null && Number.isFinite(denominator) && denominator > 0
      ? (value / denominator) * 100
      : null;
  return {
    pressurePct: percent(some),
    fullPressurePct: percent(full),
    throttledPct: percent(throttled),
    sharedHostStealPct: steal !== null && total > 0 ? (steal / total) * 100 : null,
    someTotalDeltaUs: some,
    fullTotalDeltaUs: full,
    throttledDeltaUs: throttled,
    nrThrottledDelta: delta(before?.cpuStat?.nr_throttled, after?.cpuStat?.nr_throttled),
    cpuMaxBefore: before?.cpuMax ?? null,
    cpuMaxAfter: after?.cpuMax ?? null,
    steadyWallUs: denominator,
  };
};
