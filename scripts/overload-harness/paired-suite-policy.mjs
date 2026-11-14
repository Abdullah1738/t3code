import { resourcePercentages } from "./paired-resources.mjs";
export const DATA_ROOT = "/dev/shm/robob-overload-1352";
export const LOADED_AT_MS = Date.parse("2026-11-14T03:45:00Z");
const finite = (n) => typeof n === "number" && Number.isFinite(n);
const startData = (run) =>
  Array.isArray(run.pairedMeasurement?.resources)
    ? run.pairedMeasurement.resources.find((x) => x?.boundary === "start")?.data
    : undefined;
export const measuredRunKey = (run) => {
  const x = run.suiteExecution,
    d = startData(run);
  if (
    !x ||
    !Number.isInteger(x.batch) ||
    x.batch < 3 ||
    x.batch > 8 ||
    !["A", "B", "C"].includes(x.arm) ||
    !d ||
    !Number.isInteger(d.nodePid) ||
    d.nodePid <= 0 ||
    !finite(d.nodeStartEpochMs) ||
    d.nodeStartEpochMs <= 0 ||
    !finite(run.pairedMeasurement?.steadyEpochMs) ||
    !finite(run.wallMs)
  )
    return null;
  return JSON.stringify([
    run.offboxRunId,
    x.batch,
    x.arm,
    d.nodePid,
    d.nodeStartEpochMs,
    run.pairedMeasurement.steadyEpochMs,
    run.pairedMeasurement.steadyEpochMs + run.wallMs,
  ]);
};
export const measuredProcessKey = (run) => {
  const d = startData(run);
  return d
    ? JSON.stringify([run.offboxRunId, d.nodePid, d.nodeStartEpochMs, d.linuxStartTicks, d.bootId])
    : null;
};
export const steadyWindowKey = (run) => {
  const d = startData(run);
  return d
    ? JSON.stringify([
        run.offboxRunId,
        d.nodePid,
        d.nodeStartEpochMs,
        run.pairedMeasurement.steadyEpochMs,
        run.pairedMeasurement.steadyEpochMs + run.wallMs,
      ])
    : null;
};
export const placementFailures = (runs, plan, rotation, boxes) => {
  const failures = [];
  if (
    !plan ||
    !Number.isInteger(plan.batch) ||
    plan.batch < 3 ||
    plan.batch > 8 ||
    plan.rotation !== rotation ||
    !finite(plan.writtenAtMs) ||
    !finite(plan.releaseEpochMs) ||
    plan.writtenAtMs > plan.releaseEpochMs ||
    !Array.isArray(boxes) ||
    boxes.length !== 3 ||
    new Set(boxes).size !== 3
  )
    return ["prewritten Latin-square plan missing or wrong row"];
  for (const [i, arm] of ["A", "B", "C"].entries()) {
    const r = runs.find((x) => x.suiteExecution?.arm === arm),
      expected = boxes[(i + rotation) % 3];
    if (!r) {
      failures.push(`missing ${arm} suite run`);
      continue;
    }
    const x = r.suiteExecution,
      entries = r.pairedMeasurement?.resources;
    if (
      x.batch !== plan.batch ||
      x.parentOffboxRunId !== r.offboxRunId ||
      x.expectedBoxId !== expected ||
      plan.assignment?.[arm] !== expected ||
      r.offboxBoxId !== expected ||
      x.planHash !== plan.hash ||
      x.launchIdentity?.offboxBoxId !== expected ||
      x.launchIdentity?.hostname !== expected.replace("bx_", "bx-") ||
      !finite(x.launchedAtMs) ||
      x.launchedAtMs < plan.writtenAtMs ||
      Math.abs(x.launchedAtMs - plan.releaseEpochMs) > 60000
    )
      failures.push(`${arm}: launch/Latin-square identity disagrees`);
    if (
      !Array.isArray(x.processesAtLaunch) ||
      !x.processesAtLaunch.length ||
      x.processesAtLaunch.some((p) => !Number.isInteger(p.pid) || typeof p.comm !== "string")
    )
      failures.push(`${arm}: launch process inventory missing`);
    if (
      x.freshDirectory?.path !== `${DATA_ROOT}/${plan.batch}-${arm}` ||
      x.freshDirectory?.existedBefore !== false ||
      x.freshDirectory?.created !== true ||
      x.previousDirectory?.gone !== true
    )
      failures.push(`${arm}: fresh/wiped directory proof missing`);
    if (
      !Array.isArray(entries) ||
      entries.length !== 2 ||
      entries[0]?.boundary !== "start" ||
      entries[1]?.boundary !== "end"
    ) {
      failures.push(`${arm}: resource/placement boundaries missing`);
      continue;
    }
    const first = entries[0].data;
    if (x.launchIdentity?.parentOffboxRunId !== r.offboxRunId)
      failures.push(`${arm}: launch parent identity missing`);
    for (const entry of entries)
      if ((entry?.data?.incusContainerId ?? null) !== (x.launchIdentity?.incusContainerId ?? null))
        failures.push(`${arm}: Incus container identity changed`);
    for (const entry of entries) {
      const d = entry?.data;
      if (
        !d ||
        d.offboxBoxId !== expected ||
        d.hostname !== expected.replace("bx_", "bx-") ||
        d.parentOffboxRunId !== r.offboxRunId ||
        d.batch !== plan.batch ||
        d.arm !== arm ||
        !Number.isInteger(d.nodePid) ||
        d.nodePid <= 0 ||
        d.nodePid !== x.nodePid ||
        !finite(d.nodeStartEpochMs) ||
        d.nodeStartEpochMs <= 0 ||
        d.nodeStartEpochMs !== first?.nodeStartEpochMs ||
        typeof d.linuxStartTicks !== "string" ||
        !/^\d+$/.test(d.linuxStartTicks) ||
        d.linuxStartTicks !== first?.linuxStartTicks ||
        typeof d.bootId !== "string" ||
        d.bootId !== first?.bootId
      )
        failures.push(`${arm}: actual process/box changed or is missing at ${entry?.boundary}`);
    }
  }
  return failures;
};
export const resourceFairnessFailures = (runs, tier) => {
  if (tier !== "loaded") return [];
  const failures = [];
  const byArm = Object.fromEntries(runs.map((r) => [r.suiteExecution?.arm, r]));
  for (const arm of ["A", "C"]) {
    const r = byArm[arm],
      entries = r?.pairedMeasurement?.resources;
    if (!r || !Array.isArray(entries) || entries.length !== 2) {
      failures.push(`${arm}: CPU pressure boundaries missing`);
      continue;
    }
    const first = entries[0].data,
      last = entries[1].data;
    if (
      !first?.cgroupPath ||
      first.cgroupPath !== last?.cgroupPath ||
      first.membershipPid !== first.nodePid ||
      last?.membershipPid !== last?.nodePid ||
      !finite(resourcePercentages(r).pressurePct)
    )
      failures.push(`${arm}: own-cgroup CPU pressure missing, unreadable or backwards`);
  }
  const A = byArm.A ? resourcePercentages(byArm.A) : {},
    C = byArm.C ? resourcePercentages(byArm.C) : {};
  if (finite(A.pressurePct) && finite(C.pressurePct) && Math.abs(A.pressurePct - C.pressurePct) > 2)
    failures.push("A/C CPU pressure differs by more than2.0pp");
  let limited = false;
  for (const r of runs) {
    const m = resourcePercentages(r);
    if (
      typeof m.cpuMaxBefore !== "string" ||
      typeof m.cpuMaxAfter !== "string" ||
      m.cpuMaxBefore !== m.cpuMaxAfter
    )
      failures.push("cpu.max applicability missing or changed");
    else if (!m.cpuMaxBefore.startsWith("max ")) limited = true;
  }
  if (limited) {
    if (!finite(A.throttledPct) || !finite(C.throttledPct))
      failures.push("limited CPU: throttling evidence missing/backwards");
    else if (Math.abs(A.throttledPct - C.throttledPct) > 2)
      failures.push("limited CPU: A/C throttling differs by more than2.0pp");
  }
  return failures;
};
