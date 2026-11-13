import { profileMarkdown } from "./profile.mjs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
const { calibrationFailures, candidateFailures } = await import(
  NodeURL.pathToFileURL(NodePath.resolve("apps/server/src/ardud/perf/overloadMath.ts"))
);
const targets = JSON.parse(await NodeFSP.readFile("scripts/overload-harness/targets.json", "utf8"));
const args = process.argv.slice(2);
const destination = args.shift();
if (!destination || args.length === 0)
  throw new Error(
    "Usage: node scripts/overload-harness/report.mjs OUTPUT_DIR role=RESULT_JSON ... (roles: base, R, fix1323, fix1341, fix1342, fix1343, candidate)",
  );
const rows = [];
const seenFiles = new Set();
const seenWindows = new Set();
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sha = (value, length) =>
  typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const invalidate = (row, reason) => {
  row.failures.push(reason);
  row.invalidReasons.push(reason);
};
const requiredCounters = [
  ...[
    "providerEvent",
    "rootStart",
    "pacing",
    "otherCommand",
    "providerTurnEnd",
    "status",
    "asks",
    "readOpenCards",
    "kanbanToolsRead",
  ].flatMap((kind) => [`offered:${kind}`, `completed:${kind}`]),
  ...["status", "asks", "readOpenCards", "kanbanToolsRead"].map((kind) => `served:${kind}`),
  "tickSteps",
  "receipts",
  "driverEvents:providerEvent",
  "driverEvents:rootStart",
  "driverEvents:command",
];
for (const arg of args) {
  const split = arg.indexOf("=");
  const role = arg.slice(0, split);
  const filename = NodePath.resolve(arg.slice(split + 1));
  if (
    split < 0 ||
    !["base", "R", "fix1323", "fix1341", "fix1342", "fix1343", "candidate", "sensitivity"].includes(
      role,
    )
  )
    throw new Error(`Invalid run argument: ${arg}`);
  const run = JSON.parse(await NodeFSP.readFile(filename, "utf8"));
  const failures = [];
  const canonical = await NodeFSP.realpath(filename);
  if (seenFiles.has(canonical)) failures.push("repeated result file");
  seenFiles.add(canonical);
  if (typeof run.startedAt !== "string" || !Number.isFinite(Date.parse(run.startedAt)))
    failures.push("missing run start time");
  const windowKey = `${run.offboxRunId}:${run.startedAt}`;
  if (seenWindows.has(windowKey)) failures.push("repeated run window");
  seenWindows.add(windowKey);
  if (!sha(run.revision, 40)) failures.push("revision must be a full commit SHA");
  for (const key of ["shapeHash", "targetsHash", "probeHash"])
    if (!sha(run[key], 64)) failures.push(`missing ${key}`);
  if (
    !object(run.source) ||
    !sha(run.source.harnessIndexTree, 40) ||
    !sha(run.source.harnessHash, 64) ||
    !sha(run.source.workloadHash, 64) ||
    run.source.productRevision !== run.revision
  )
    failures.push("missing or inconsistent frozen source manifest");
  if (
    typeof run.node !== "string" ||
    typeof run.cpu !== "string" ||
    !Number.isInteger(run.cpus) ||
    run.cpus <= 0
  )
    failures.push("missing runtime/hardware provenance");
  if (
    !Array.isArray(run.runtimeFlags) ||
    !run.runtimeFlags.every((flag) => typeof flag === "string")
  )
    failures.push("missing runtime flags");
  if (
    !finite(run.activeMs) ||
    run.activeMs < 0 ||
    !finite(run.idleMs) ||
    run.idleMs < 0 ||
    Math.abs(run.activeMs + run.idleMs - run.wallMs) > 1 ||
    Math.abs(run.activeMs / run.wallMs - run.busy) > 1e-6
  )
    failures.push("ELU does not follow from raw deltas");
  if (
    !finite(run.gcOfWall) ||
    run.gcOfWall < 0 ||
    run.gcOfWall > 1 ||
    !finite(run.gcOfBusy) ||
    run.gcOfBusy < 0 ||
    Math.abs(run.gcOfBusy * run.busy - run.gcOfWall) > 1e-6
  )
    failures.push("inconsistent GC shares");
  if (
    !object(run.logical) ||
    requiredCounters.some((key) => !finite(run.logical[key]) || run.logical[key] <= 0) ||
    !Object.keys(run.logical ?? {}).some(
      (key) => key.startsWith("persisted:") && run.logical[key] > 0,
    )
  )
    failures.push("missing logical work counters");
  if (
    !object(run.logical) ||
    !finite(run.logical.dispatchDecisions) ||
    run.logical.dispatchDecisions < 0
  )
    failures.push("missing dispatch decision counter");
  if (
    run.telemetrySchemaVersion !== 2 ||
    !finite(run.gcMs) ||
    Math.abs(run.gcMs / run.wallMs - run.gcOfWall) > 1e-6
  )
    failures.push("missing timestamp-clipped GC evidence");
  if (
    !object(run.resultSizes) ||
    ["status", "asks", "readOpenCards", "kanbanToolsRead"].some(
      (key) => !finite(run.resultSizes[key]) || run.resultSizes[key] < 0,
    )
  )
    failures.push("missing poller logical sizes");
  if (
    !object(run.delayMs) ||
    ["p50", "p99", "max"].some((key) => !finite(run.delayMs[key]) || run.delayMs[key] < 0) ||
    run.delayMs.p99 > run.delayMs.max ||
    !Array.isArray(run.stalls)
  )
    failures.push("missing delay/stall measurements");
  if (!object(run.errors)) failures.push("missing workload error counters");
  if (
    !object(run.backlogSlopes) ||
    Object.keys(run.backlogSlopes).sort().join(",") !== "dispatcher,outbox,pending" ||
    ["pending", "outbox", "dispatcher"].some((key) => !finite(run.backlogSlopes[key]))
  )
    failures.push("missing backlog slopes");
  for (const field of ["busy", "gcOfWall", "gcOfBusy", "wallMs", "steadySeconds"])
    if (!Number.isFinite(run[field])) failures.push(`missing ${field}`);
  if (run.warmupSeconds !== 120 || run.steadySeconds !== 600 || run.wallMs < 600000)
    failures.push("incomplete prescribed window");
  if (run.boardsCount !== 17 && role !== "sensitivity") failures.push("not the 17-board gate seed");
  if (!run.revision || run.revision === "UNSPECIFIED") failures.push("missing revision");
  if (!run.offboxRunId || !run.offboxLogPath) failures.push("missing offbox run/log provenance");
  if (Object.values(run.errors ?? {}).some((n) => n !== 0)) failures.push("workload errors");
  let profile;
  try {
    profile = JSON.parse(
      await NodeFSP.readFile(
        NodePath.join(NodePath.dirname(filename), "middle.cpuprofile"),
        "utf8",
      ),
    );
  } catch {
    failures.push("missing middle CPU profile");
  }
  if (profile) {
    const duration = (profile.endTime - profile.startTime) / 1e6;
    const validSamples =
      Array.isArray(profile.samples) &&
      profile.samples.length > 0 &&
      Array.isArray(profile.timeDeltas) &&
      profile.samples.length === profile.timeDeltas.length &&
      profile.timeDeltas.every((delta) => finite(delta) && delta >= 0);
    const sampled = validSamples
      ? profile.timeDeltas.reduce((sum, delta) => sum + delta, 0) / 1e6
      : NaN;
    if (
      !finite(profile.startTime) ||
      !finite(profile.endTime) ||
      duration < 59 ||
      !validSamples ||
      !finite(sampled) ||
      sampled < 59 ||
      sampled > duration + 1
    )
      failures.push("incomplete CPU profile timestamps/samples");
    try {
      profileMarkdown(profile);
    } catch {
      failures.push("invalid CPU profile tree");
      profile = undefined;
    }
  }
  const seconds = run.wallMs / 1000;
  const cacheDelta = (name, field) =>
    (run.cacheAfter?.[name]?.[field] ?? NaN) - (run.cacheBefore?.[name]?.[field] ?? NaN);
  const rates = {
    tickStepsPerSecond: (run.logical?.tickSteps ?? 0) / seconds,
    writerTransactionsPerMinute: ((run.physical?.writerTransactions ?? 0) * 60) / seconds,
    cardRowsPerSecond: (run.physical?.openCardRows ?? 0) / seconds,
    discussionMissesPerSecond: cacheDelta("discussion", "misses") / seconds,
  };
  if (
    !object(run.physical) ||
    ["writerTransactions", "openCardRows"].some(
      (key) => !finite(run.physical[key]) || run.physical[key] < 0,
    ) ||
    !finite(cacheDelta("discussion", "misses")) ||
    cacheDelta("discussion", "misses") < 0
  )
    failures.push("missing physical work telemetry");
  const pending = run.backlog?.at(-1);
  if (
    !pending ||
    run.backlog.length < 60 ||
    run.backlog.some((sample) =>
      ["seconds", "pending", "outbox", "dispatcher"].some(
        (key) => !finite(sample[key]) || sample[key] < 0,
      ),
    )
  )
    failures.push("missing steady backlog samples");
  rows.push({
    role,
    filename,
    run,
    rates,
    failures,
    invalidReasons: [...failures],
    profile,
    pending,
  });
}
const bases = rows.filter((x) => x.role === "base");
for (const row of bases) {
  if (row.run.revision !== "dbc99fc3a4b817977bc23a57ea7c049da5d45190")
    invalidate(row, "calibration revision is not dbc99fc3a4");
  row.failures.push(
    ...calibrationFailures(
      { busy: row.run.busy, gcOfBusy: row.run.gcOfBusy, rates: row.rates },
      targets.workTargets,
    ),
  );
}
const gating = rows.filter((row) => row.role === "base" || row.role === "candidate");
const reference = bases[0];
for (const row of gating) {
  if (!reference) continue;
  for (const key of [
    "node",
    "cpu",
    "cpus",
    "shapeHash",
    "targetsHash",
    "probeHash",
    "warmupSeconds",
    "steadySeconds",
    "boardsCount",
  ])
    if (reference.run[key] !== row.run[key]) invalidate(row, `comparison changed ${key}`);
  if (JSON.stringify(reference.run.runtimeFlags) !== JSON.stringify(row.run.runtimeFlags))
    invalidate(row, "comparison changed runtimeFlags");
  if (reference.run.source?.workloadHash !== row.run.source?.workloadHash)
    invalidate(row, "comparison changed workload hash");
}
const candidateRevisions = new Set(
  rows.filter((row) => row.role === "candidate").map((row) => row.run.revision),
);
if (candidateRevisions.size > 1)
  for (const row of gating.filter((row) => row.role === "candidate"))
    invalidate(row, "candidate revisions differ");
const calibrated = bases.length === 1 && bases.every((row) => row.failures.length === 0);
const base = bases[0];
for (const row of rows.filter((row) => row.role !== "base")) {
  if (!base || !calibrated) row.failures.push("one valid schema2 calibration required");
  if (base) {
    for (const key of [
      "node",
      "cpu",
      "cpus",
      "shapeHash",
      "targetsHash",
      "probeHash",
      "warmupSeconds",
      "steadySeconds",
      "boardsCount",
    ])
      if (base.run[key] !== row.run[key]) invalidate(row, `comparison changed ${key}`);
    if (JSON.stringify(base.run.runtimeFlags) !== JSON.stringify(row.run.runtimeFlags))
      invalidate(row, "comparison changed runtimeFlags");
    for (const key of ["workloadHash"])
      if (base.run.source?.[key] !== row.run.source?.[key])
        invalidate(row, `comparison changed source ${key}`);
    if (row.role === "candidate") {
      const end = row.pending ?? {};
      const baseEnd = base.pending ?? {};
      row.failures.push(
        ...candidateFailures(
          {
            busy: row.run.busy,
            gcOfWall: row.run.gcOfWall,
            p99Ms: row.run.delayMs?.p99,
            stalls: Math.max(row.run.stalls?.length ?? 1, row.run.delayMs?.max >= 1000 ? 1 : 0),
            logical: row.run.logical ?? {},
            resultSizes: row.run.resultSizes ?? {},
            pending: { pending: end.pending, outbox: end.outbox, dispatcher: end.dispatcher },
            slopes: row.run.backlogSlopes ?? {},
          },
          {
            logical: base.run.logical ?? {},
            resultSizes: base.run.resultSizes ?? {},
            pending: {
              pending: baseEnd.pending,
              outbox: baseEnd.outbox,
              dispatcher: baseEnd.dispatcher,
            },
          },
        ),
      );
      if (Object.keys(row.run.backlogSlopes ?? {}).length !== 3)
        row.failures.push("missing backlog slopes");
    }
  }
}
const candidates = rows.filter((row) => row.role === "candidate");
const pass =
  calibrated && candidates.length === 3 && candidates.every((row) => row.failures.length === 0);
const invalid =
  bases.length !== 1 ||
  candidates.length !== 3 ||
  gating.some((row) => row.invalidReasons.length > 0);
const calibrationVerdict =
  bases.length !== 1 || bases.some((row) => row.invalidReasons.length > 0)
    ? "INVALID"
    : calibrated
      ? "PASS"
      : "FAIL";
const verdict =
  candidates.length === 0
    ? calibrationVerdict === "INVALID"
      ? "INVALID"
      : "NOT_RUN"
    : invalid
      ? "INVALID"
      : pass
        ? "PASS"
        : "FAIL";
const percent = (n) => (Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : "missing");
const number = (n) => (Number.isFinite(n) ? n.toFixed(2) : "missing");
const lines = [
  "# Overload harness report",
  "",
  `Release verdict: **${verdict}**. Calibration: **${calibrationVerdict}**.`,
  "",
  ...(rows.some((row) => row.role === "candidate")
    ? []
    : ["Candidate: **NOT RUN**. This report cannot establish a product verdict.", ""]),
  "Line fixed before any run: PASS-LINE.md at 6cbce53a; evaluator clarification at 358ad2969b.",
  "",
  "| Run | Commit | Busy ≤30% | p99 ≤100ms | Max delay ms | ≥1s stalls | GC wall ≤10% | GC busy | Ticks/s | Tx/min | Open rows/s | Discussion misses/s | Result |",
  "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
  ...rows.map(
    (row) =>
      `| ${row.role} | ${row.run.revision} | ${percent(row.run.busy)} | ${number(row.run.delayMs?.p99)} | ${number(row.run.delayMs?.max)} | ${row.run.stalls?.length ?? "missing"} | ${percent(row.run.gcOfWall)} | ${percent(row.run.gcOfBusy)} | ${number(row.rates.tickStepsPerSecond)} | ${number(row.rates.writerTransactionsPerMinute)} | ${number(row.rates.cardRowsPerSecond)} | ${number(row.rates.discussionMissesPerSecond)} | ${row.invalidReasons.length ? "INVALID" : row.failures.length ? "FAIL" : row.role === "candidate" || row.role === "base" ? "PASS" : "measured"} |`,
  ),
  "",
  "Base calibration uses busy≥55%, GC busy≥20%, physical/work rates ±25% of trace targets. Candidate keeps logical work ±10%, identical poller sizes, end backlog≤base+10% and no positive queue slope. Costs may fall.",
  "",
];
for (const row of rows) {
  lines.push(
    `## ${row.role}: ${row.run.revision}`,
    "",
    `Offbox run: ${row.run.offboxRunId ?? "missing"}; log: ${row.run.offboxLogPath ?? "missing"}; result: ${row.filename}`,
    "",
    ...row.failures.map((x) => `- ${row.invalidReasons.length ? "INVALID" : "FAIL"}: ${x}`),
    "",
    "```json",
    JSON.stringify(
      {
        logical: row.run.logical,
        physical: row.run.physical,
        resultSizes: row.run.resultSizes,
        backlogEnd: row.pending,
        backlogSlopes: row.run.backlogSlopes,
        limitations: row.run.limitations,
      },
      null,
      2,
    ),
    "```",
    "",
  );
  if (!row.profile) continue;
  lines.push(profileMarkdown(row.profile), "");
}
if (candidates.length !== 3)
  lines.push(`INVALID: expected three full candidate runs; received ${candidates.length}.`);
if (bases.length !== 1)
  lines.push(
    `INVALID: expected one schema2 calibration run (evaluator addition); received ${bases.length}.`,
  );
await NodeFSP.mkdir(destination, { recursive: true });
await NodeFSP.writeFile(NodePath.join(destination, "REPORT.md"), lines.join("\n") + "\n");
await NodeFSP.writeFile(
  NodePath.join(destination, "verdict.json"),
  JSON.stringify(
    {
      verdict,
      calibrationVerdict,
      calibrated,
      rows: rows.map(({ profile: _profile, ...row }) => row),
    },
    null,
    2,
  ) + "\n",
);
process.stdout.write(`${verdict}: ${NodePath.join(destination, "REPORT.md")}\n`);
process.exitCode = pass ? 0 : 1;
