import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import { profileMarkdown } from "./profile.mjs";
import { equivalent } from "../../apps/server/src/ardud/perf/overloadMath.ts";

const BASE = "dbc99fc3a4b817977bc23a57ea7c049da5d45190";
const R11 = "58a926792ae28235d33d14025f417eccbc842549";
const average = (values) => values.reduce((a, b) => a + b, 0) / values.length;
const normalise = (run) => {
  const seconds = run.wallMs / 1000;
  return {
    busy: run.busy,
    p99: run.delayMs?.p99,
    gcPerMinute: (run.gcMs * 60) / seconds,
    openRows: run.physical?.openCardRows / seconds,
    discussionMisses:
      (run.cacheAfter?.discussion?.misses - run.cacheBefore?.discussion?.misses) / seconds,
    logical: Object.fromEntries(
      Object.entries(run.logical ?? {}).map(([key, value]) => [key, (value * 600) / seconds]),
    ),
    resultSizes: run.resultSizes ?? {},
    end: run.backlog?.at(-1) ?? {},
    slopes: run.backlogSlopes ?? {},
    stalls: Math.max(run.stalls?.length ?? NaN, run.delayMs?.max >= 1000 ? 1 : 0),
  };
};
export const baseMean = (runs) => {
  const values = runs.map(normalise);
  const mean = Object.fromEntries(
    ["busy", "p99", "gcPerMinute", "openRows", "discussionMisses"].map((key) => [
      key,
      average(values.map((row) => row[key])),
    ]),
  );
  mean.logical = Object.fromEntries(
    [...new Set(values.flatMap((row) => Object.keys(row.logical)))].map((key) => [
      key,
      average(values.map((row) => row.logical[key])),
    ]),
  );
  mean.perRun = Object.fromEntries(
    ["providerLaunches", "providerSends", "persisted:thread.created"].map((key) => [
      key,
      average(runs.map((run) => run.logical?.[key] ?? 0)),
    ]),
  );
  mean.resultSizes = values[0].resultSizes;
  mean.end = Object.fromEntries(
    ["pending", "outbox", "dispatcher"].map((key) => [
      key,
      average(values.map((row) => row.end[key])),
    ]),
  );
  return mean;
};
export const selectReference = (bases, candidates) => {
  const first = bases.find((row) => row.offboxRunId === "run-1114-000117-d5e7");
  const later = bases.filter((row) => row !== first);
  if (!first || later.length !== 2 || candidates.length !== 3)
    throw new Error("d5e7 plus2 bases and3 candidates required");
  const five = [...later, ...candidates];
  const separate = five.every((run, index) =>
    five.slice(index + 1).every((other) => {
      if (run.offboxBoxId !== other.offboxBoxId) return true;
      const left = run.conditions?.interval;
      const right = other.conditions?.interval;
      // A later rerun can reuse a box after a base finishes without sharing its load.
      return (
        left &&
        right &&
        [left.from, left.to, right.from, right.to].every(Number.isFinite) &&
        left.from < left.to &&
        right.from < right.to &&
        (left.to <= right.from || right.to <= left.from)
      );
    }),
  );
  const idle = [first, ...five].every(
    (run) =>
      run.conditions?.verified === true &&
      Array.isArray(run.conditions.coLoads) &&
      run.conditions.coLoads.length === 0 &&
      run.offboxBoxSize === first.offboxBoxSize,
  );
  const selected = separate && idle ? bases : later;
  const firstValue = normalise(first);
  const noise = later.flatMap((run) => {
    const value = normalise(run);
    return [
      ["busy", value.busy, firstValue.busy],
      ["GC ms/min", value.gcPerMinute, firstValue.gcPerMinute],
    ].flatMap(([metric, actual, reference]) =>
      Math.abs(actual - reference) > Math.abs(reference) * 0.1
        ? [
            {
              runId: run.offboxRunId,
              metric,
              actual,
              reference,
              changePercent: (actual / reference - 1) * 100,
            },
          ]
        : [],
    );
  });
  return {
    selected,
    mode: selected.length === 3 ? "3-base mean" : "base2/3 mean (co-load/box condition amendment)",
    noise,
  };
};
export const reviewLaunchSubstitution = (run, mean) => {
  const launches = run.logical?.providerLaunches;
  const sends = run.logical?.providerSends;
  const creations = run.logical?.["persisted:thread.created"] ?? 0;
  const extra = launches - mean.perRun.providerLaunches;
  if (
    !Number.isInteger(extra) ||
    extra < 1 ||
    extra > 4 ||
    creations - mean.perRun["persisted:thread.created"] !== extra ||
    Math.abs(mean.perRun.providerSends - sends - extra) > 1e-9
  )
    return false;
  if (
    !equivalent(
      { dispatchDecisions: mean.logical.dispatchDecisions },
      { dispatchDecisions: normalise(run).logical.dispatchDecisions },
      0.1,
    ) ||
    Math.abs(launches + sends - mean.perRun.providerSends) >
      Math.abs(mean.perRun.providerSends) * 0.1
  )
    return false;
  const proof = run.reviewLaunchSubstitution;
  if (
    !proof ||
    proof.offboxRunId !== run.offboxRunId ||
    proof.home !== run.home ||
    proof.readOnly !== true ||
    proof.sourcePath !== `${run.home}/userdata/boards.sqlite` ||
    proof.attributedThreadCreatedWriterTransactions !== extra ||
    !Array.isArray(proof.launches) ||
    proof.launches.length !== extra ||
    !Array.isArray(proof.allLaunches) ||
    proof.allLaunches.length !== proof.totalLaunchLinks
  )
    return false;
  const end = Date.parse(run.completedAt);
  const start = end - run.wallMs;
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    proof.allLaunches.some(
      (row) => !row || typeof row !== "object" || !Number.isFinite(Date.parse(row.startedAt)),
    ) ||
    proof.launches.some((row) => !row || typeof row !== "object")
  )
    return false;
  if (
    proof.allLaunches.some(
      (row) =>
        Math.min(
          Math.abs(Date.parse(row.startedAt) - start),
          Math.abs(Date.parse(row.startedAt) - end),
        ) <= 60000,
    )
  )
    return false;
  const selected = proof.allLaunches.filter(
    (row) => Date.parse(row.startedAt) >= start && Date.parse(row.startedAt) <= end,
  );
  const keys = ["threadId", "cardId", "role", "startedAt", "reviewStep", "chainLength", "seeded"];
  return (
    selected.length === extra &&
    new Set(selected.map((row) => row.cardId)).size === extra &&
    new Set(selected.map((row) => row.threadId)).size === extra &&
    selected.every(
      (row) =>
        row.seeded === true &&
        /^load-card-\d+-\d+$/.test(row.cardId) &&
        /^load-launched-\d+$/.test(row.threadId) &&
        row.role === "review" &&
        Number.isInteger(row.reviewStep) &&
        Number.isInteger(row.chainLength) &&
        row.chainLength > 0 &&
        row.reviewStep >= row.chainLength &&
        proof.launches.some((entry) => keys.every((key) => entry[key] === row[key])),
    )
  );
};
export const relativeFailures = (run, mean) => {
  const value = normalise(run);
  const failures = [];
  const substituted = reviewLaunchSubstitution(run, mean);
  const exempt = substituted
    ? new Set(["providerLaunches", "providerSends", "persisted:thread.created"])
    : new Set();
  const strict = (logical) =>
    Object.fromEntries(Object.entries(logical).filter(([key]) => !exempt.has(key)));
  if (!equivalent(strict(mean.logical), strict(value.logical), 0.1))
    failures.push(
      "logical work outside ±10% of base mean (review substitution requires per-card evidence)",
    );
  if (!equivalent(mean.resultSizes, value.resultSizes, 0))
    failures.push("poller logical result size changed");
  if (!(value.busy <= mean.busy)) failures.push("main-thread busy above base mean");
  if (!(value.p99 <= 100 && value.p99 <= mean.p99))
    failures.push("event-loop p99 above100ms or base mean");
  if (value.stalls !== 0) failures.push("stall ≥1s");
  if (!(value.gcPerMinute < mean.gcPerMinute)) failures.push("#1343 GC ms/min did not fall");
  if (!(value.openRows < mean.openRows)) failures.push("#1342 open-card rows/s did not fall");
  if (!(value.discussionMisses < mean.discussionMisses))
    failures.push("#1341 discussion decode misses/s did not fall");
  for (const key of ["pending", "outbox", "dispatcher"]) {
    if (!(value.end[key] >= 0 && value.end[key] <= mean.end[key] * 1.1))
      failures.push(`${key} backlog above base mean +10%`);
    if (!(value.slopes[key] <= 0)) failures.push(`${key} backlog has upward slope`);
  }
  return failures;
};

const main = async () => {
  const [destination, ...args] = process.argv.slice(2);
  if (!destination || args.length < 1)
    throw new Error(
      "Usage: relative-report.mjs OUTPUT [--latency=VERDICT_JSON] base=RESULT ... candidate=RESULT ...",
    );
  const informationOnly = args.includes("--information-only");
  const latencyPath = args.find((arg) => arg.startsWith("--latency="))?.slice(10);
  const runArgs = args.filter(
    (arg) => !arg.startsWith("--latency=") && arg !== "--information-only",
  );
  await NodeFSP.mkdir(destination, { recursive: true });
  // Reuse the audited schema2 evidence validator; its old absolute verdict is retained separately.
  const evidenceDir = await NodeFSP.mkdtemp(NodePath.join(destination, "absolute-evidence-"));
  const checked = NodeChildProcess.spawnSync(
    process.execPath,
    [NodeURL.fileURLToPath(new URL("./report.mjs", import.meta.url)), evidenceDir, ...runArgs],
    { encoding: "utf8" },
  );
  if (checked.error || ![0, 1].includes(checked.status))
    throw checked.error ?? new Error(checked.stderr);
  const evidence = JSON.parse(
    await NodeFSP.readFile(NodePath.join(evidenceDir, "verdict.json"), "utf8"),
  );
  const rows = evidence.rows;
  const bases = rows.filter((row) => row.role === "base");
  const candidates = rows.filter((row) => row.role === "candidate");
  const invalid = Array.isArray(evidence.invalid) ? [...evidence.invalid] : [];
  if (bases.length !== 3 || candidates.length !== 3 || rows.length !== 6)
    invalid.push("exactly3 base and3 candidate artifacts required");
  for (const row of rows) {
    invalid.push(
      ...row.invalidReasons.map((reason) => `${row.role} ${row.run.offboxRunId}: ${reason}`),
    );
    if (row.run.revision !== (row.role === "base" ? BASE : R11))
      invalid.push(`${row.role}: wrong release revision`);
    if (row.run.offboxBoxSize !== "xlarge")
      invalid.push(`${row.role}: missing or changed actual box size`);
    if (
      row.run.source?.workloadHash !==
        "a99eff438d2e57abb41c28b60c71292786740576b5624dc0a91b5decb06c179d" ||
      row.run.source?.harnessIndexTree !== "5f055a5cc28ff8ed9f00de1ea515f486786e17f3"
    )
      invalid.push(`${row.role}: not frozen d5e7 harness`);
    if (
      typeof row.run.offboxBoxId !== "string" ||
      row.run.conditions?.verified !== true ||
      row.run.conditions?.boxId !== row.run.offboxBoxId ||
      row.run.conditions?.boxSize !== row.run.offboxBoxSize ||
      !Array.isArray(row.run.conditions?.coLoads) ||
      !row.run.conditions?.metadataPath
    )
      invalid.push(`${row.role}: missing box/co-load metadata`);
  }
  let mean;
  let reference;
  if (!invalid.length) {
    reference = selectReference(
      bases.map((row) => row.run),
      candidates.map((row) => row.run),
    );
    mean = baseMean(reference.selected);
    if (bases.some((row) => !equivalent(row.run.resultSizes, mean.resultSizes, 0)))
      invalid.push("base poller logical sizes differ");
  }
  for (const row of rows)
    row.relativeFailures =
      !invalid.length && row.role === "candidate" ? relativeFailures(row.run, mean) : [];
  const overloadVerdict = invalid.length
    ? "INVALID"
    : candidates.every((row) => row.relativeFailures.length === 0)
      ? "PASS"
      : "FAIL";
  const latency = latencyPath ? JSON.parse(await NodeFSP.readFile(latencyPath, "utf8")) : null;
  if (
    latency &&
    (latency.rows?.[0]?.run?.revision !== BASE || latency.rows?.[1]?.run?.revision !== R11)
  )
    invalid.push("latency evidence is not base/R11");
  const verdict =
    invalid.length || latency?.verdict === "INVALID"
      ? "INVALID"
      : overloadVerdict === "FAIL" || latency?.verdict === "FAIL"
        ? "FAIL"
        : latency?.verdict === "PASS"
          ? "PASS"
          : "NOT_RUN";
  const number = (n, d = 3) => (Number.isFinite(n) ? n.toFixed(d) : "unavailable");
  const lines = [
    "# Relative gate (.11) rerun at 58a926792a",
    "",
    `${informationOnly ? "Information-only score" : "Release verdict"}: **${verdict}**. Overload relative line: **${overloadVerdict}**. Latency: **${latency?.verdict ?? "NOT_RUN"}**.`,
    "",
    ...(informationOnly
      ? [
          "The release verdict requires the post-#1386 rerun on the evaluator's new pin; this rescore does not authorize a release.",
          "",
        ]
      : []),
    `Base: ${BASE}. R11: ${R11}. Frozen v1 workload: a99eff438d2e57abb41c28b60c71292786740576b5624dc0a91b5decb06c179d. Evaluator amendment written13 Nov21:12Z before candidate launch; original absolute thresholds remain on file.`,
    "",
    "| Run | Busy % | Lag p50 / p99 / max ms | GC ms/min | GC wall / busy % | Open rows/s | Discussion misses/s | Tick steps/s | Writer tx/min | Stalls | Relative |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
  ];
  for (const row of rows) {
    const r = row.run,
      v = normalise(r);
    lines.push(
      `| ${row.role} ${r.offboxRunId} | ${number(r.busy * 100)} | ${number(r.delayMs?.p50)} / ${number(r.delayMs?.p99)} / ${number(r.delayMs?.max)} | ${number(v.gcPerMinute)} | ${number(r.gcOfWall * 100)} / ${number(r.gcOfBusy * 100)} | ${number(v.openRows)} | ${number(v.discussionMisses)} | ${number((r.logical?.tickSteps * 1000) / r.wallMs)} | ${number((r.physical?.writerTransactions * 60000) / r.wallMs)} | ${v.stalls} | ${invalid.length || row.invalidReasons.length ? "INVALID" : row.role === "base" ? "reference" : row.relativeFailures.length ? "FAIL" : "PASS"} |`,
    );
  }
  if (mean)
    lines.push(
      `| Reference mean / candidate line | ≤${number(mean.busy * 100)} | p99 ≤${number(Math.min(100, mean.p99))} | <${number(mean.gcPerMinute)} | diagnostic | <${number(mean.openRows)} | <${number(mean.discussionMisses)} | logical ±10% | diagnostic (#1323 absent) |0 | all3 must pass |`,
    );
  lines.push(
    "",
    ...invalid.map((reason) => `- INVALID: ${reason}`),
    "",
    "Logical counts are normalized to the600-second window before comparison. The line requires offered/completed/persisted counters within±10% of the selected base mean, identical poller result sizes, queue endpoints≤the base mean+10%, and no positive queue slope. Physical costs may fall. The three new candidate runs were submitted concurrently against the same three retained base artifacts; offbox queues choose their start times.",
    "",
    "Absolute fidelity remains a documented v1 gap. The evaluator moved disk-latency/live-heap fidelity to a separate card; ≥55% busy and live-rate ±25% do not gate .11.",
    "",
  );
  if (reference) {
    lines.push(
      `Reference: **${reference.mode}**. Runs: ${reference.selected.map((run) => run.offboxRunId).join(", ")}.`,
      "",
      "| Run | Box | Size | Other offbox work during conservative command interval |",
      "|---|---|---|---|",
    );
    for (const row of rows)
      lines.push(
        `| ${row.run.offboxRunId} | ${row.run.offboxBoxId} | ${row.run.offboxBoxSize} | ${row.run.conditions.coLoads.length ? row.run.conditions.coLoads.map((load) => load.runId).join(", ") : "none"} |`,
      );
    lines.push(
      "",
      "Co-load evidence uses each run's command-to-end interval, which contains its full steady window. Sequential reuse of a box by non-overlapping commands is not concurrent co-load; the same three base runs are retained for q2. Details and provenance are retained with each result.",
      "",
    );
    for (const finding of reference.noise)
      lines.push(
        `Harness noise: ${finding.runId} ${finding.metric} differs from d5e7 by ${number(finding.changePercent, 1)}% (${number(finding.actual)} vs ${number(finding.reference)}).`,
      );
    lines.push("");
  }
  for (const row of rows) {
    lines.push(
      `## ${row.role}: ${row.run.offboxRunId}`,
      "",
      `Revision: ${row.run.revision}. Log: ${row.run.offboxLogPath}. Result: ${row.filename}.`,
      "",
      ...row.relativeFailures.map((reason) => `- FAIL: ${reason}`),
      ...(Array.isArray(row.run.reviewLaunchSubstitution?.launches) &&
      row.run.reviewLaunchSubstitution.launches.length &&
      row.run.reviewLaunchSubstitution.launches.every((entry) => entry && typeof entry === "object")
        ? [
            "",
            `Review launch substitution: ${mean && reviewLaunchSubstitution(row.run, mean) ? "verified under q1 clarification" : "not accepted"}; ${row.run.reviewLaunchSubstitution.attributedThreadCreatedWriterTransactions} thread.created writer transactions reported without subtracting them from any other check.`,
            "",
            "| Seeded card | Launched thread | Review step | Chain length |",
            "|---|---|---:|---:|",
            ...row.run.reviewLaunchSubstitution.launches.map(
              (entry) =>
                `| ${entry.cardId} | ${entry.threadId} | ${entry.reviewStep} | ${entry.chainLength} |`,
            ),
          ]
        : []),
      "",
      "```json",
      JSON.stringify(
        {
          logical: row.run.logical,
          resultSizes: row.run.resultSizes,
          backlogEnd: row.run.backlog?.at(-1),
          backlogSlopes: row.run.backlogSlopes,
          source: row.run.source,
          conditions: row.run.conditions,
          reviewLaunchSubstitution: row.run.reviewLaunchSubstitution,
          limitations: row.run.limitations,
        },
        null,
        2,
      ),
      "```",
      "",
    );
    try {
      const profile = JSON.parse(
        await NodeFSP.readFile(
          NodePath.join(NodePath.dirname(row.filename), "middle.cpuprofile"),
          "utf8",
        ),
      );
      lines.push(profileMarkdown(profile), "");
    } catch {
      lines.push("CPU profile unavailable or invalid.", "");
    }
  }
  if (latencyPath)
    lines.push(
      "## #1365 request latency",
      "",
      await NodeFSP.readFile(
        NodePath.join(NodePath.dirname(latencyPath), "LATENCY-REPORT.md"),
        "utf8",
      ),
    );
  await NodeFSP.writeFile(NodePath.join(destination, "REPORT.md"), lines.join("\n") + "\n");
  await NodeFSP.writeFile(
    NodePath.join(destination, "relative-verdict.json"),
    JSON.stringify(
      { verdict, overloadVerdict, informationOnly, invalid, reference, mean, rows, latency },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(`${verdict}: ${NodePath.join(destination, "REPORT.md")}\n`);
  process.exitCode = verdict === "PASS" ? 0 : 1;
};
if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  try {
    await main();
  } catch (error) {
    const destination = process.argv[2];
    if (!destination) throw error;
    await NodeFSP.mkdir(destination, { recursive: true });
    const reason = String(error);
    await NodeFSP.writeFile(
      NodePath.join(destination, "REPORT.md"),
      `# Relative gate (.11)\n\nRelease verdict: **INVALID**.\n\n${reason}\n`,
    );
    await NodeFSP.writeFile(
      NodePath.join(destination, "relative-verdict.json"),
      JSON.stringify({ verdict: "INVALID", invalid: [reason] }, null, 2) + "\n",
    );
    process.exitCode = 1;
  }
}
