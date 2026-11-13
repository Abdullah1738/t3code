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
  if (profile && (profile.endTime - profile.startTime) / 1e6 < 59)
    failures.push("CPU profile shorter than 59s");
  const seconds = run.wallMs / 1000;
  const cacheDelta = (name, field) =>
    (run.cacheAfter?.[name]?.[field] ?? NaN) - (run.cacheBefore?.[name]?.[field] ?? NaN);
  const rates = {
    tickStepsPerSecond: (run.logical?.tickSteps ?? 0) / seconds,
    writerTransactionsPerMinute: ((run.physical?.writerTransactions ?? 0) * 60) / seconds,
    cardRowsPerSecond: (run.physical?.openCardRows ?? 0) / seconds,
    discussionMissesPerSecond: cacheDelta("discussion", "misses") / seconds,
  };
  const pending = run.backlog?.at(-1);
  if (!pending || run.backlog.length < 60) failures.push("missing steady backlog samples");
  rows.push({ role, filename, run, rates, failures, profile, pending });
}
const bases = rows.filter((x) => x.role === "base");
for (const row of bases) {
  if (!row.run.revision.startsWith("dbc99fc3a4"))
    row.failures.push("calibration revision is not dbc99fc3a4");
  row.failures.push(
    ...calibrationFailures(
      { busy: row.run.busy, gcOfBusy: row.run.gcOfBusy, rates: row.rates },
      targets.workTargets,
    ),
  );
}
const calibrated = bases.length === 3 && bases.every((row) => row.failures.length === 0);
const base = bases[0];
for (const row of rows.filter((row) => row.role !== "base")) {
  if (!base || !calibrated) row.failures.push("three valid calibration passes required");
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
      if (base.run[key] !== row.run[key]) row.failures.push(`comparison changed ${key}`);
    if (row.role === "candidate") {
      const end = row.pending ?? {};
      const baseEnd = base.pending ?? {};
      row.failures.push(
        ...candidateFailures(
          {
            busy: row.run.busy,
            gcOfWall: row.run.gcOfWall,
            p99Ms: row.run.delayMs?.p99,
            stalls: row.run.stalls?.length,
            logical: row.run.logical ?? {},
            resultSizes: row.run.resultSizes ?? {},
            pending: { pending: end.pending, outbox: end.outbox, dispatcher: end.dispatcher },
            slopes: row.run.backlogSlopes ?? {},
          },
          {
            logical: base.run.logical,
            resultSizes: base.run.resultSizes,
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
const percent = (n) => (Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : "missing");
const number = (n) => (Number.isFinite(n) ? n.toFixed(2) : "missing");
const lines = [
  "# Overload harness report",
  "",
  `Release verdict: **${pass ? "PASS" : "FAIL"}**. Calibration: **${calibrated ? "PASS" : "FAIL"}**.`,
  "",
  "Line fixed before any run: PASS-LINE.md at 6cbce53a; evaluator clarification at 358ad2969b.",
  "",
  "| Run | Commit | Busy ≤30% | p99 ≤100ms | Max delay ms | ≥1s stalls | GC wall ≤10% | GC busy | Ticks/s | Tx/min | Open rows/s | Discussion misses/s | Result |",
  "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
  ...rows.map(
    (row) =>
      `| ${row.role} | ${row.run.revision} | ${percent(row.run.busy)} | ${number(row.run.delayMs?.p99)} | ${number(row.run.delayMs?.max)} | ${row.run.stalls?.length ?? "missing"} | ${percent(row.run.gcOfWall)} | ${percent(row.run.gcOfBusy)} | ${number(row.rates.tickStepsPerSecond)} | ${number(row.rates.writerTransactionsPerMinute)} | ${number(row.rates.cardRowsPerSecond)} | ${number(row.rates.discussionMissesPerSecond)} | ${row.failures.length ? "FAIL" : row.role === "candidate" || row.role === "base" ? "PASS" : "measured"} |`,
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
    ...row.failures.map((x) => `- FAIL: ${x}`),
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
  lines.push(`FAIL: expected three full candidate runs; received ${candidates.length}.`);
if (bases.length !== 3)
  lines.push(`FAIL: expected three calibration runs; received ${bases.length}.`);
await NodeFSP.mkdir(destination, { recursive: true });
await NodeFSP.writeFile(NodePath.join(destination, "REPORT.md"), lines.join("\n") + "\n");
await NodeFSP.writeFile(
  NodePath.join(destination, "verdict.json"),
  JSON.stringify(
    {
      verdict: pass ? "PASS" : "FAIL",
      calibrated,
      rows: rows.map(({ profile: _profile, ...row }) => row),
    },
    null,
    2,
  ) + "\n",
);
process.stdout.write(`${pass ? "PASS" : "FAIL"}: ${NodePath.join(destination, "REPORT.md")}\n`);
process.exitCode = pass ? 0 : 1;
