import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import { resourcePercentages } from "./paired-resources.mjs";
import {
  DATA_ROOT,
  LOADED_AT_MS,
  measuredRunKey,
  measuredProcessKey,
  steadyWindowKey,
  placementFailures,
  resourceFairnessFailures,
} from "./paired-suite-policy.mjs";
import * as NodeChildProcess from "node:child_process";
import { baseMean, relativeFailures } from "./relative-report.mjs";

export const ARMS = {
  A: "dbc99fc3a4b817977bc23a57ea7c049da5d45190",
  B: "8fde0ece3a2abea3dfed2866b6648fda68f52934",
  C: "58a926792ae28235d33d14025f417eccbc842549",
};
export const IDLE_RULE_EPOCH_MS = Date.parse("2026-11-14T01:51:13Z");
const finite = (n) => typeof n === "number" && Number.isFinite(n);
const digest = (s) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const p99 = (values) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.99) - 1];

export const storageFailures = (run) => {
  const snapshots = run.pairedMeasurement?.filesystems;
  if (
    !Array.isArray(snapshots) ||
    snapshots.length !== 2 ||
    snapshots[0]?.boundary !== "start" ||
    snapshots[1]?.boundary !== "end"
  )
    return ["database filesystem boundaries missing"];
  const failures = [];
  const origin = run.pairedMeasurement.steadyEpochMs;
  const end = origin + run.wallMs;
  const expected = {
    statev2: `${run.home}/userdata/statev2.sqlite`,
    boards: `${run.home}/userdata/boards.sqlite`,
  };
  if (
    !run.home?.startsWith(
      `${DATA_ROOT}/${run.suiteExecution?.batch}-${run.suiteExecution?.arm}/overload-`,
    )
  )
    failures.push("database home is not explicitly placed in tmpfs");
  for (const [index, snapshot] of snapshots.entries()) {
    const boundary = index === 0 ? origin : end;
    if (
      ![snapshot.beforeEpochMs, snapshot.afterEpochMs, boundary].every(finite) ||
      snapshot.afterEpochMs < snapshot.beforeEpochMs ||
      Math.abs((index === 0 ? snapshot.afterEpochMs : snapshot.beforeEpochMs) - boundary) > 5000 ||
      (index === 0 && snapshot.afterEpochMs > origin + 10) ||
      (index === 1 && snapshot.beforeEpochMs < end - 10)
    )
      failures.push("filesystem evidence is not at the steady boundary");
    if (
      !Array.isArray(snapshot.files) ||
      snapshot.files.length !== 2 ||
      new Set(snapshot.files.map((x) => x?.name)).size !== 2
    ) {
      failures.push("actual database file identities missing");
      continue;
    }
    for (const name of Object.keys(expected)) {
      const file = snapshot.files.find((x) => x?.name === name);
      if (
        !file ||
        file.error ||
        file.path !== expected[name] ||
        file.actualPath !== expected[name] ||
        file.tmpfs !== true ||
        file.statfsType !== "0x1021994" ||
        file.fsType !== "tmpfs" ||
        file.mount?.fsType !== "tmpfs" ||
        ![
          file.deviceId,
          file.inode,
          file.mount?.mountId,
          file.mount?.device,
          file.mount?.mountPoint,
          file.mount?.source,
        ].every((x) => typeof x === "string" && x.length > 0)
      )
        failures.push(`${snapshot.boundary}: ${name} is missing or not proven tmpfs`);
      if (
        file &&
        !(
          file.actualPath === file.mount?.mountPoint ||
          file.actualPath.startsWith(file.mount?.mountPoint + "/")
        )
      )
        failures.push(`${snapshot.boundary}: ${name} mount does not cover actual path`);
      const previous = snapshots[0].files?.find((x) => x?.name === name);
      if (
        index === 1 &&
        previous &&
        ["path", "actualPath", "deviceId", "inode", "statfsType"].some(
          (k) => previous[k] !== file?.[k],
        )
      )
        failures.push(`${name} filesystem identity changed`);
      if (index === 1 && previous && JSON.stringify(previous.mount) !== JSON.stringify(file?.mount))
        failures.push(`${name} mount changed`);
    }
  }
  return failures;
};

export const selectAttempts = (batches) => {
  const invalid = [];
  if (
    !Array.isArray(batches) ||
    batches.length < 1 ||
    batches.length > 6 ||
    batches.some((b, i) => b.batch !== i + 3 || !["PASS", "FAIL", "INVALID"].includes(b.verdict))
  )
    return {
      verdict: "INVALID",
      counted: [],
      invalid: ["attempts must be sequential batches3–8, at most six"],
    };
  const valid = batches.filter((b) => b.verdict !== "INVALID");
  const counted = valid.slice(0, 3);
  if (valid.length > 3 || (counted.length === 3 && batches.at(-1).batch !== counted.at(-1).batch))
    invalid.push("attempts continued after three valid batches");
  if (counted.length < 3)
    invalid.push(
      batches.length === 6
        ? "six attempts exhausted without three valid batches"
        : "three valid matched batches not complete",
    );
  return {
    verdict: invalid.length
      ? "INVALID"
      : counted.some((b) => b.verdict === "FAIL")
        ? "FAIL"
        : "PASS",
    counted: counted.map((b) => b.batch),
    invalid,
  };
};

export const measurementFailures = (run) => {
  const m = run.pairedMeasurement;
  if (!m || m.version !== 3) return ["paired measurement missing"];
  const failures = [...storageFailures(run)];
  const resourceEntries = m.resources;
  if (
    !Array.isArray(resourceEntries) ||
    resourceEntries.length !== 2 ||
    resourceEntries[0]?.boundary !== "start" ||
    resourceEntries[1]?.boundary !== "end" ||
    resourceEntries.some(
      (x, i) =>
        !x?.data ||
        ![x.beforeEpochMs, x.afterEpochMs].every(finite) ||
        x.afterEpochMs < x.beforeEpochMs ||
        Math.abs(
          (i === 0 ? x.afterEpochMs : x.beforeEpochMs) -
            (m.steadyEpochMs + (i === 0 ? 0 : run.wallMs)),
        ) > 5000,
    )
  )
    failures.push("resource boundaries missing or outside steady measurement");
  if (!finite(m.steadyEpochMs)) failures.push("steady epoch missing");
  if (
    !Array.isArray(m.hooks) ||
    m.hooks.length !== 2 ||
    new Set(m.hooks.map((x) => x?.kind)).size !== 2 ||
    ["harness", "sqlite"].some(
      (kind) =>
        !m.hooks.some(
          (x) => x?.kind === kind && digest(x.sourceHash) && digest(x.instrumentedHash),
        ),
    )
  )
    failures.push("instrumented-source proof missing");
  if (
    !Array.isArray(m.intervals) ||
    m.intervals.length < 60 ||
    m.intervals.some(
      (x, i, rows) =>
        !x ||
        ![x.seconds, x.epochMs, x.activeMs, x.idleMs].every(finite) ||
        x.activeMs < 0 ||
        x.idleMs < 0 ||
        (i > 0 &&
          (x.seconds <= rows[i - 1].seconds ||
            x.activeMs < rows[i - 1].activeMs ||
            x.idleMs < rows[i - 1].idleMs)),
    ) ||
    Math.abs(m.intervals[0]?.seconds) > 0.01 ||
    Math.abs((m.intervals.at(-1)?.seconds ?? 0) * 1000 - run.wallMs) > 10
  )
    failures.push("interval ELU missing or inconsistent");
  if (
    Array.isArray(m.intervals) &&
    m.intervals.at(-1) &&
    (!finite(run.activeMs) ||
      !finite(run.idleMs) ||
      Math.abs(m.intervals.at(-1).activeMs - run.activeMs) > 10 ||
      Math.abs(m.intervals.at(-1).idleMs - run.idleMs) > 10 ||
      m.intervals.some((x) => Math.abs(x.activeMs + x.idleMs - x.seconds * 1000) > 10))
  )
    failures.push("interval ELU disagrees with total");
  if (
    !Array.isArray(m.nonExecutionReplies) ||
    m.nonExecutionReplies.some(
      (x) =>
        !x ||
        typeof x.sql !== "string" ||
        typeof x.caller !== "string" ||
        !finite(x.seconds) ||
        !["transaction-cleanup", "requeue-before-start", "cancelled-before-start"].includes(
          x.reason,
        ),
    )
  )
    failures.push("reader execution timing missing or incomplete");
  if (
    !Array.isArray(m.warnings) ||
    m.warnings.some(
      (x) =>
        !x ||
        !["Warn", "Error"].includes(x.level) ||
        typeof x.text !== "string" ||
        typeof x.steady !== "boolean" ||
        !finite(Date.parse(x.wallTime)),
    )
  )
    failures.push("warning messages missing");
  else
    for (const level of ["Warn", "Error"])
      if (
        m.warnings.filter((x) => x.steady && x.level === level).length !==
        (run.errors?.[level] ?? 0)
      )
        failures.push(`warning text/count disagrees: ${level}`);
  if (
    !Array.isArray(m.statements) ||
    !m.statements.length ||
    m.statements.some(
      (x) =>
        !x ||
        !digest(x.id) ||
        typeof x.sql !== "string" ||
        typeof x.caller !== "string" ||
        !["main:run", "main:all", "worker:prepare+execute"].includes(x.method) ||
        !Array.isArray(x.samples) ||
        !x.samples.length ||
        x.samples.some(
          (s) =>
            !s ||
            !finite(s.seconds) ||
            s.seconds < 0 ||
            s.seconds > run.wallMs / 1000 ||
            !finite(s.durationMs) ||
            s.durationMs < 0 ||
            typeof s.success !== "boolean",
        ),
    )
  )
    failures.push("statement execution evidence missing or inconsistent");
  else
    for (const method of ["main:run", "main:all", "worker:prepare+execute"])
      if (!m.statements.some((x) => x.method === method))
        failures.push(`no ${method} measurements`);
  if (
    !Array.isArray(m.marks) ||
    m.marks.length !== 2 ||
    ["profileStart", "profileEnd"].some(
      (name) =>
        m.marks.filter((x) => x?.name === name && finite(x.epochMs) && finite(x.seconds)).length !==
        1,
    ) ||
    !(
      m.marks.find((x) => x?.name === "profileEnd")?.seconds -
        m.marks.find((x) => x?.name === "profileStart")?.seconds >=
      59
    )
  )
    failures.push("profile wall markers missing");
  if (Array.isArray(m.statements)) {
    const commits = m.statements
      .filter(
        (x) =>
          x.method === "main:run" &&
          x.sql?.trim().toUpperCase() === "COMMIT" &&
          /^(orchestrationV2\.EventSink\.|RestartPacingState\.)/.test(x.caller),
      )
      .reduce((n, x) => n + (x.samples?.length ?? 0), 0);
    if (!finite(run.physical?.writerTransactions) || commits !== run.physical.writerTransactions)
      failures.push("native COMMIT timeline disagrees with writer transaction total");
  }
  return failures;
};

export const batchValidity = (runs) => {
  if (runs.length !== 3) return ["exactly three arms required"];
  const failures = [];
  if (
    new Set(runs.map((x) => x.offboxRunId)).size !== 3 ||
    new Set(runs.map((x) => x.offboxBoxId)).size !== 3
  )
    failures.push("arms must use distinct runs and boxes");
  if (runs.some((r) => !r.offboxRunId || !r.offboxBoxId))
    failures.push("run/box identities missing");
  const starts = runs.map((x) => Date.parse(x.startedAt));
  const steady = runs.map((x) => x.pairedMeasurement?.steadyEpochMs);
  if (
    ![...starts, ...steady].every(finite) ||
    Math.max(...starts) - Math.min(...starts) > 60000 ||
    Math.max(...steady) - Math.min(...steady) > 60000
  )
    failures.push("arm starts differ by more than 60s");
  const overlap = Math.min(...runs.map((x, i) => steady[i] + x.wallMs)) - Math.max(...steady);
  if (!finite(overlap) || overlap < Math.max(...runs.map((x) => x.wallMs)) * 0.9)
    failures.push("steady-window overlap below90%");
  return failures;
};

export const hostEvidenceFailures = (host, preflight, runs) => {
  const failures = [];
  const from = Math.min(...runs.map((x) => x.pairedMeasurement?.steadyEpochMs));
  const to = Math.max(...runs.map((x) => x.pairedMeasurement?.steadyEpochMs + x.wallMs));
  if (
    !host ||
    !finite(host.fromEpochMs) ||
    !finite(host.toEpochMs) ||
    host.fromEpochMs > from ||
    host.toEpochMs < to ||
    !Array.isArray(host.recordedRuns) ||
    host.recordedRuns.some(
      (x) =>
        !x ||
        typeof x.runId !== "string" ||
        typeof x.boxId !== "string" ||
        typeof x.size !== "string" ||
        typeof x.kind !== "string",
    ) ||
    !Array.isArray(host.armRunIds) ||
    [...host.armRunIds].sort().join() !==
      runs
        .map((x) => x.offboxRunId)
        .sort()
        .join()
  )
    failures.push("host-wide co-load evidence missing or wrong window");
  if (preflight?.ruleStartedAtMs !== IDLE_RULE_EPOCH_MS)
    failures.push("idle rule clock is not the sanctioned01:51:13Z epoch");
  if (
    Array.isArray(host?.recordedRuns) &&
    host.recordedRuns.some(
      (x) =>
        !finite(x.commandAtMs) ||
        (x.endAtMs !== null && (!finite(x.endAtMs) || x.endAtMs < x.commandAtMs)) ||
        x.commandAtMs > to ||
        (finite(x.endAtMs) && x.endAtMs < from),
    )
  )
    failures.push("host command intervals missing or outside steady window");
  const commonFrom = Math.max(...runs.map((r) => r.pairedMeasurement?.steadyEpochMs));
  const commonTo = Math.min(...runs.map((r) => r.pairedMeasurement?.steadyEpochMs + r.wallMs));
  if (
    Array.isArray(host?.jobSnapshots) &&
    host.jobSnapshots.some(
      (x) =>
        !Array.isArray(x.jobs) ||
        x.jobs.some(
          (j) =>
            !j ||
            typeof j.runId !== "string" ||
            typeof j.boxId !== "string" ||
            typeof j.size !== "string" ||
            typeof j.kind !== "string" ||
            typeof j.apiVerified !== "boolean",
        ) ||
        (x.collectedAtMs >= commonFrom &&
          x.collectedAtMs <= commonTo &&
          (x.jobs.some((j) => j.apiVerified !== true) ||
            runs.some(
              (r) =>
                !x.jobs.some(
                  (j) =>
                    j.runId === r.offboxRunId && j.boxId === r.offboxBoxId && j.running === true,
                ),
            ))),
    )
  )
    failures.push("host job snapshots omit active arms or command identity evidence");
  if (
    Array.isArray(host?.jobSnapshots) &&
    host.jobSnapshots.some(
      (x) =>
        x.coverageVerified !== true ||
        !Array.isArray(x.jobs) ||
        new Set(x.jobs.map((j) => j?.runId)).size !== x.jobs.length ||
        x.jobs.filter((j) => j?.running === true && j?.queued !== true).length !==
          x.host?.running_cmds ||
        x.jobs.filter((j) => j?.queued === true).length !== x.host?.queued_cmds,
    )
  )
    failures.push("host running/queued counters are not reconciled to identified commands");
  if (
    Array.isArray(host?.jobSnapshots) &&
    host.jobSnapshots.some(
      (x) =>
        !finite(x.host?.ts) ||
        x.jobs?.some(
          (j) =>
            j.running === true &&
            (!finite(j.startedAtMs) ||
              j.startedAtMs > x.host.ts * 1000 ||
              (j.endedAtMs !== null && (!finite(j.endedAtMs) || j.endedAtMs <= x.host.ts * 1000))),
        ),
    )
  )
    failures.push("identified command intervals do not cover the host counter sample");
  if (
    preflight?.exclusiveArmBoxes !== true ||
    preflight?.otherJobs?.some((j) => runs.some((r) => r.offboxBoxId === j.boxId))
  )
    failures.push("retained arm boxes are not proven exclusive");
  const before = preflight?.hostSample;
  const arms = runs.map((x) => x.offboxRunId).sort();
  if (
    !preflight ||
    ![preflight.checkedAtMs, preflight.ruleStartedAtMs, preflight.launchAtMs, before?.ts].every(
      finite,
    ) ||
    !Array.isArray(preflight.otherJobs) ||
    !Array.isArray(preflight.armedRunIds) ||
    preflight.armedRunIds.slice().sort().join() !== arms.join() ||
    preflight.checkedAtMs - before.ts * 1000 > 30000 ||
    preflight.checkedAtMs < before.ts * 1000 ||
    preflight.launchAtMs < preflight.checkedAtMs ||
    preflight.launchAtMs - preflight.checkedAtMs > 60000
  )
    failures.push("idle/quiet-enough preflight proof missing or stale");
  else {
    if (preflight.condition === "idle") {
      if (before.running_cmds !== 3 || before.queued_cmds !== 0 || preflight.otherJobs.length !== 0)
        failures.push("host was not idle besides the three armed runners");
    } else if (preflight.condition === "quiet-enough") {
      if (
        preflight.checkedAtMs - preflight.ruleStartedAtMs < 2700000 ||
        before.queued_cmds !== 0 ||
        before.running_cmds !== 3 + preflight.otherJobs.length ||
        preflight.otherJobs.some(
          (x) =>
            !x ||
            typeof x.runId !== "string" ||
            typeof x.boxId !== "string" ||
            !["default", "small", "large"].includes(x.size) ||
            x.size === "xlarge" ||
            x.kind !== "light" ||
            x.verified !== true,
        )
      )
        failures.push("quiet-enough condition failed or used before45minutes");
    } else if (preflight.condition === "loaded") {
      if (
        preflight.checkedAtMs < LOADED_AT_MS ||
        preflight.exclusiveArmBoxes !== true ||
        preflight.otherJobs.some((j) => runs.some((r) => r.offboxBoxId === j.boxId))
      )
        failures.push("loaded launch too early or arm boxes not exclusive");
    } else failures.push("preflight must be idle, quiet-enough or loaded");
  }
  if (
    preflight?.coverageVerified !== true ||
    !Array.isArray(preflight?.otherJobs) ||
    new Set(preflight.otherJobs?.map((x) => x?.runId)).size !== preflight.otherJobs?.length ||
    preflight.otherJobs?.some((x) => arms.includes(x?.runId))
  )
    failures.push("host-load coverage or distinct co-load identities missing");
  if (
    runs.some(
      (r) =>
        !finite(Date.parse(r.startedAt)) ||
        Date.parse(r.startedAt) < preflight?.checkedAtMs - 1000 ||
        Date.parse(r.startedAt) > preflight?.launchAtMs + 60000,
    )
  )
    failures.push("preflight does not precede these actual starts");
  if (
    !Array.isArray(host?.recordedRuns) ||
    arms.some((id) => !host.recordedRuns.some((r) => r.runId === id))
  )
    failures.push("host overlap ledger omits an arm");
  if (Array.isArray(host?.jobSnapshots)) {
    for (const sample of host.jobSnapshots) {
      if (!Array.isArray(sample.observedJobs)) {
        failures.push("host interval observations missing");
        continue;
      }
      for (const job of sample.observedJobs) {
        const offered = job?.startedAtMs ?? job?.queuedOfferedAtMs;
        if (!finite(offered) || (job?.endedAtMs !== null && !finite(job?.endedAtMs))) {
          failures.push("observed job interval missing");
          continue;
        }
        if (
          offered <= to &&
          (job.endedAtMs === null || job.endedAtMs >= from) &&
          (job.apiVerified !== true ||
            !host.recordedRuns?.some(
              (r) =>
                r.runId === job.runId &&
                r.boxId === job.boxId &&
                r.size === job.size &&
                r.kind === job.kind &&
                r.commandAtMs <= offered &&
                (r.endAtMs === null || r.endAtMs >= (job.endedAtMs ?? to)),
            ))
        )
          failures.push("host overlap ledger omits an observed command interval");
      }
    }
  }
  for (const field of ["samples", "jobSnapshots"]) {
    const samples = host?.[field];
    const clockSamples = Array.isArray(samples)
      ? samples.filter((x, i) => i === 0 || x.host?.ts !== samples[i - 1].host?.ts)
      : [];
    if (
      clockSamples.length < 2 ||
      clockSamples.some((x, i) => i > 0 && x.host?.ts <= clockSamples[i - 1].host?.ts)
    )
      failures.push(`host ${field} clock frozen or backwards`);
    if (
      !Array.isArray(samples) ||
      samples.length < 2 ||
      samples[0]?.collectedAtMs > from ||
      samples.at(-1)?.collectedAtMs < to ||
      samples.some(
        (x, i) =>
          !finite(x?.collectedAtMs) ||
          !finite(x.host?.running_cmds) ||
          !finite(x.host?.queued_cmds) ||
          !finite(x.host?.ts) ||
          x.host.ts * 1000 > x.collectedAtMs ||
          x.collectedAtMs - x.host.ts * 1000 > 30000 ||
          (i === 0 && x.host.ts * 1000 > from) ||
          (i === samples.length - 1 && x.host.ts * 1000 < to) ||
          (i > 0 &&
            (x.collectedAtMs <= samples[i - 1].collectedAtMs ||
              x.collectedAtMs - samples[i - 1].collectedAtMs > 90000)),
      )
    )
      failures.push(`host ${field} missing or incomplete across steady window`);
  }
  return failures;
};

export const statementSummary = (run) =>
  (run.pairedMeasurement?.statements ?? []).map((row) => {
    const durations = row.samples.map((x) => x.durationMs);
    return {
      id: row.id,
      sql: row.sql,
      method: row.method,
      caller: row.caller,
      count: durations.length,
      perMinute: (durations.length * 60000) / run.wallMs,
      meanMs: durations.reduce((a, b) => a + b, 0) / durations.length,
      p99Ms: p99(durations),
      totalMsPerMinute: (durations.reduce((a, b) => a + b, 0) * 60000) / run.wallMs,
    };
  });

export const minuteElu = (run) => {
  const rows = run.pairedMeasurement.intervals;
  const result = [];
  let before = rows[0];
  for (let minute = 1; minute <= 10; minute++) {
    const after = rows.find((x) => x.seconds >= minute * 60) ?? rows.at(-1);
    const active = after.activeMs - before.activeMs,
      idle = after.idleMs - before.idleMs;
    result.push({
      minute,
      fromSeconds: before.seconds,
      toSeconds: after.seconds,
      busy: active / (active + idle),
      stalls: run.stalls.filter((x) => x.seconds > before.seconds && x.seconds <= after.seconds)
        .length,
    });
    before = after;
  }
  return result;
};

const main = async () => {
  const [out, manifestFile, latencyFile] = process.argv.slice(2);
  if (!out || !manifestFile || !latencyFile)
    throw new Error("Usage: paired-report.mjs OUTPUT BATCH_MANIFEST LATENCY_VERDICT");
  await NodeFSP.mkdir(out, { recursive: true });
  const manifest = JSON.parse(await NodeFSP.readFile(manifestFile, "utf8"));
  if (
    !Array.isArray(manifest.batches) ||
    manifest.batches.length < 1 ||
    manifest.batches.length > 6
  )
    throw new Error("One to six attempted batch definitions required");
  const batches = [];
  const globalInvalid = [];
  const sourceKeys = ["harnessHash", "workloadHash", "measurementHash"];
  const frozen = "a99eff438d2e57abb41c28b60c71292786740576b5624dc0a91b5decb06c179d";
  if (
    !digest(manifest.configuration?.hostPolicyHash) ||
    sourceKeys.some((k) => !digest(manifest.configuration?.[k])) ||
    manifest.configuration?.workloadHash !== frozen
  )
    globalInvalid.push("required pre-run frozen configuration missing");
  if (manifest.batches.some((b, i) => b.batch !== i + 3))
    globalInvalid.push("attempt numbers must be sequential from3");
  const seen = new Set(),
    seenProcesses = new Set(),
    seenWindows = new Set(),
    seenArtifacts = new Set(),
    seenProfiles = new Set();
  const previousByBox = new Map();
  let reference;
  for (const [index, metadata] of manifest.batches.entries()) {
    const rows = [];
    const invalid = [...globalInvalid];
    for (const arm of Object.keys(ARMS)) {
      const filename = metadata[arm];
      try {
        const run = JSON.parse(await NodeFSP.readFile(filename, "utf8"));
        if (!run || typeof run !== "object" || Array.isArray(run))
          throw Error("result is not an object");
        rows.push({ batch: index + 3, arm, filename, run, invalid: [] });
      } catch (error) {
        invalid.push(`${arm}: unreadable result: ${String(error)}`);
      }
    }
    if (rows.length === 3) {
      const dir = await NodeFSP.mkdtemp(NodePath.join(out, "schema2-evidence-"));
      const checked = NodeChildProcess.spawnSync(
        process.execPath,
        [
          NodeURL.fileURLToPath(new URL("./report.mjs", import.meta.url)),
          dir,
          ...rows.map(
            (row) =>
              `${row.arm === "A" ? "base" : row.arm === "B" ? "R" : "candidate"}=${row.filename}`,
          ),
        ],
        { encoding: "utf8" },
      );
      try {
        if (checked.error || ![0, 1].includes(checked.status))
          throw checked.error ?? Error(checked.stderr);
        const evidence = JSON.parse(
          await NodeFSP.readFile(NodePath.join(dir, "verdict.json"), "utf8"),
        );
        if (evidence.rows?.length !== 3) throw Error("schema2 validator did not return three rows");
        for (const [i, row] of rows.entries()) row.invalid.push(...evidence.rows[i].invalidReasons);
      } catch (error) {
        invalid.push(`schema2 evidence unreadable: ${String(error)}`);
      }
      try {
        invalid.push(...batchValidity(rows.map((x) => x.run)));
      } catch (error) {
        invalid.push(`invalid pairing: ${String(error)}`);
      }
    }
    for (const row of rows) {
      try {
        row.invalid.push(...measurementFailures(row.run));
      } catch (error) {
        row.invalid.push(`malformed measurement: ${String(error)}`);
      }
      const r = row.run;
      if (r.revision !== ARMS[row.arm]) row.invalid.push("wrong arm revision");
      if (r.source?.harnessIndexTree !== "5f055a5cc28ff8ed9f00de1ea515f486786e17f3")
        row.invalid.push("not the frozen schema2 tree");
      if (r.offboxBoxSize !== "xlarge") row.invalid.push("actual box must be xlarge");
      if (r.source?.settings?.storageRoot !== "/dev/shm/robob-overload-1352")
        row.invalid.push("explicit storage setting missing/mixed");
      for (const k of sourceKeys)
        if (!digest(r.source?.[k]) || r.source[k] !== manifest.configuration?.[k])
          row.invalid.push(`missing/mixed ${k}`);
      const key = measuredRunKey(r),
        processKey = measuredProcessKey(r),
        windowKey = steadyWindowKey(r);
      if (
        !key ||
        !processKey ||
        !windowKey ||
        seen.has(key) ||
        seenProcesses.has(processKey) ||
        seenWindows.has(windowKey)
      )
        row.invalid.push("missing/repeated measured run, process or steady window");
      if (key) seen.add(key);
      if (processKey) seenProcesses.add(processKey);
      if (windowKey) seenWindows.add(windowKey);
      try {
        const canonical = await NodeFSP.realpath(row.filename),
          profilePath = NodePath.join(
            NodePath.dirname(NodePath.resolve(row.filename)),
            "middle.cpuprofile",
          ),
          profileHash = NodeCrypto.createHash("sha256")
            .update(await NodeFSP.readFile(profilePath))
            .digest("hex");
        if (seenArtifacts.has(canonical) || seenProfiles.has(profileHash))
          row.invalid.push("repeated result artifact or CPU profile");
        seenArtifacts.add(canonical);
        seenProfiles.add(profileHash);
        row.profileHash = profileHash;
      } catch (error) {
        row.invalid.push(`artifact/profile identity unreadable: ${String(error)}`);
      }
      const previous = previousByBox.get(r.offboxBoxId);
      if (
        r.suiteExecution?.previousDirectory?.path !== (previous ?? null) ||
        r.suiteExecution?.previousDirectory?.gone !== true
      )
        row.invalid.push("previous batch directory cleanup chain missing");

      invalid.push(...row.invalid.map((reason) => `${row.arm}: ${reason}`));
      if (
        Array.isArray(r.pairedMeasurement?.warnings) &&
        r.pairedMeasurement.warnings.some((w) => w?.steady && w.level === "Warn")
      )
        invalid.push(`${row.arm}: Warn-level stall/workload warning`);
    }
    let host, preflight, plan;
    try {
      plan = JSON.parse(await NodeFSP.readFile(metadata.planEvidence, "utf8"));
      host = JSON.parse(await NodeFSP.readFile(metadata.hostEvidence, "utf8"));
      preflight = JSON.parse(await NodeFSP.readFile(metadata.preflightEvidence, "utf8"));
      if (preflight?.classificationPolicyHash !== manifest.configuration?.hostPolicyHash)
        invalid.push("missing/mixed host classification policy");
      if (rows.length === 3)
        invalid.push(
          ...hostEvidenceFailures(
            host,
            preflight,
            rows.map((x) => x.run),
          ),
        );
    } catch (error) {
      invalid.push(`host evidence unreadable: ${String(error)}`);
    }
    if (rows.length === 3) {
      const rotation = batches.filter((b) => b.verdict !== "INVALID").length;
      try {
        invalid.push(
          ...placementFailures(
            rows.map((x) => x.run),
            plan,
            rotation,
            manifest.suiteBoxes,
          ),
          ...resourceFairnessFailures(
            rows.map((x) => x.run),
            preflight?.condition,
          ),
        );
      } catch (error) {
        invalid.push(`malformed suite proof: ${String(error)}`);
      }
    }
    if (plan?.assignment)
      for (const [arm, box] of Object.entries(plan.assignment))
        previousByBox.set(box, `${DATA_ROOT}/${plan.batch}-${arm}`);
    const A = rows.find((x) => x.arm === "A")?.run,
      C = rows.find((x) => x.arm === "C")?.run;
    if (!invalid.length && reference) {
      for (const row of rows)
        for (const k of [
          "node",
          "cpu",
          "cpus",
          "shapeHash",
          "targetsHash",
          "probeHash",
          "warmupSeconds",
          "steadySeconds",
          "boardsCount",
          "runtimeFlags",
        ])
          if (JSON.stringify(row.run[k]) !== JSON.stringify(reference[k]))
            invalid.push(`${row.arm}: changed counted configuration ${k}`);
    }
    if (!invalid.length && !reference) reference = A;
    const failures = invalid.length ? [] : relativeFailures(C, baseMean([A]));
    batches.push({
      batch: index + 3,
      verdict: invalid.length ? "INVALID" : failures.length ? "FAIL" : "PASS",
      invalid,
      failures,
      rows,
      metadata,
      host,
      preflight,
      plan,
    });
  }
  const latency = JSON.parse(await NodeFSP.readFile(latencyFile, "utf8"));
  if (latency.rows?.[0]?.run.revision !== ARMS.A || latency.rows?.[1]?.run.revision !== ARMS.C)
    globalInvalid.push("latency pin mismatch");
  const selection = selectAttempts(batches);
  if (
    !Array.isArray(manifest.leases) ||
    manifest.leases.length !== 3 ||
    new Set(manifest.leases.map((l) => l?.parentOffboxRunId)).size !== 3 ||
    new Set(manifest.leases.map((l) => l?.boxId)).size !== 3 ||
    manifest.leases.some(
      (l) =>
        !l ||
        typeof l.parentOffboxRunId !== "string" ||
        !manifest.suiteBoxes?.includes(l.boxId) ||
        !finite(l.startedAtMs) ||
        !finite(l.endedAtMs) ||
        l.endedAtMs < l.startedAtMs ||
        l.released !== true,
    )
  )
    globalInvalid.push("suite lease release evidence incomplete");
  if (Array.isArray(manifest.leases))
    for (const batch of batches.filter((b) => b.verdict !== "INVALID"))
      for (const row of batch.rows) {
        const lease = manifest.leases.find((l) => l?.parentOffboxRunId === row.run.offboxRunId);
        if (
          !lease ||
          lease.boxId !== row.run.offboxBoxId ||
          lease.startedAtMs > row.run.suiteExecution?.launchedAtMs ||
          lease.endedAtMs < row.run.pairedMeasurement?.steadyEpochMs + row.run.wallMs
        )
          globalInvalid.push("parent lease does not cover its measured process/window");
      }
  const verdict =
    globalInvalid.length ||
    selection.verdict === "INVALID" ||
    !["PASS", "FAIL"].includes(latency.verdict)
      ? "INVALID"
      : selection.verdict === "FAIL" || latency.verdict === "FAIL"
        ? "FAIL"
        : "PASS";
  const lines = [
    "# Matched relative gate (.11) at58a926792a",
    "",
    `Release verdict: **${verdict}**. Latency: **${latency.verdict}**. Every C is compared with its own batch's A; B is diagnostic.`,
    "",
    "The old bases and batches1/2 are information only. Count the first three valid attempts among3–8; retain numerical FAILs. All arms require explicit tmpfs at both steady boundaries. Launch after full idle, or quiet-enough after the evaluator’s45-minute wait. No Warn-level stalls. Original relative thresholds, q1 substitution, required telemetry and no-backlog checks remain unchanged.",
    `Counted batches: ${selection.counted.join(", ") || "none"}. ${selection.invalid.join("; ")}`,
    "Each measured run has a fresh Node process and wiped tmpfs directory. Three real parent offbox jobs retain the boxes; measured identities include parent id, batch/arm, process start and steady window. Only OS state remains warm between batches. Lease start/end/release records are retained in paired-verdict.json. Loaded-tier fairness gates own-cgroup CPU pressure, not unlimited-quota throttling or shared-host steal.",
    "Batches 1 and 2 show a 9–10 pp swing between batches against C−A margins of −0.12 and −1.02 pp, which is why the verdict is paired. The absolute busy level is not proven to be the same as at calibration. Live APFS/fsync fidelity is a separate question; tmpfs understates disk costs.",
    "",
  ];
  const f = (n) => (Number.isFinite(n) ? n.toFixed(3) : "unavailable");
  const spread = batches.map((b) => {
    const values = b.rows.map((x) => x.run.busy * 100).filter(finite);
    return {
      batch: b.batch,
      min: Math.min(...values),
      max: Math.max(...values),
      spread: Math.max(...values) - Math.min(...values),
      margin:
        (b.rows.find((x) => x.arm === "A")?.run.busy -
          b.rows.find((x) => x.arm === "C")?.run.busy) *
        100,
    };
  });
  lines.push(
    "| Batch | Launch | Arm spread pp | C−A margin to busy line pp |",
    "|---|---|---:|---:|",
    ...spread.map(
      (s) =>
        `| ${s.batch} | ${batches.find((b) => b.batch === s.batch).preflight?.condition ?? "unavailable"} | ${f(s.spread)} | ${f(s.margin)} |`,
    ),
    "",
  );
  if (spread.length > 1) {
    const swing =
      Math.max(...spread.map((s) => (s.min + s.max) / 2)) -
      Math.min(...spread.map((s) => (s.min + s.max) / 2));
    lines.push(
      `Between-batch midpoint swing: ${f(swing)}pp. ${swing >= Math.max(...spread.map((s) => Math.abs(s.margin))) ? "The swing is at least as large as the gate margin; the paired comparison carries the verdict." : "The swing is smaller than the largest paired busy margin."}`,
      "",
    );
  }
  for (const batch of batches) {
    if (batch.verdict === "INVALID") {
      lines.push(
        `## Batch${batch.batch}: INVALID`,
        "",
        ...batch.invalid.map((x) => `INVALID: ${x}`),
        "",
        `Unscored. Raw input paths: ${JSON.stringify(batch.metadata)}. Retained parseable run identities: ${batch.rows.map((x) => x.run.offboxRunId ?? "missing").join(", ")}.`,
        "",
      );
      lines.push(
        "| Arm / parent job | Busy % | Pressure % | GC ms/min |",
        "|---|---:|---:|---:|",
        ...["A", "B", "C"].map((arm) => {
          const r = batch.rows.find((x) => x.arm === arm)?.run ?? {};
          return `| ${arm} ${r.offboxRunId ?? "missing"} | ${f(r.busy * 100)} | ${f(resourcePercentages(r).pressurePct)} | ${f((r.gcMs * 60000) / r.wallMs)} |`;
        }),
        "",
      );
      continue;
    }
    lines.push(
      `## Batch${batch.batch}: ${globalInvalid.length ? "INVALID" : batch.verdict}`,
      "",
      ...batch.invalid.map((x) => `INVALID: ${x}`),
      ...batch.failures.map((x) => `FAIL: ${x}`),
      "",
      "| Arm / run | Busy % | p50/p99/max ms | GC ms/min | Pressure % | Writer tx/min | Open rows/s | Discussion misses/s | Stalls |",
      "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    );
    for (const { arm, run: r } of batch.rows)
      lines.push(
        `| ${arm} ${r.offboxRunId} | ${f(r.busy * 100)} | ${f(r.delayMs.p50)} / ${f(r.delayMs.p99)} / ${f(r.delayMs.max)} | ${f((r.gcMs * 60000) / r.wallMs)} | ${f(resourcePercentages(r).pressurePct)} | ${f((r.physical.writerTransactions * 60000) / r.wallMs)} | ${f((r.physical.openCardRows * 1000) / r.wallMs)} | ${f(((r.cacheAfter.discussion.misses - r.cacheBefore.discussion.misses) * 1000) / r.wallMs)} | ${r.stalls.length} |`,
      );
    const byArm = Object.fromEntries(batch.rows.map((x) => [x.arm, x.run]));
    lines.push(
      "",
      `B−A busy: ${f((byArm.B.busy - byArm.A.busy) * 100)}pp; C−B: ${f((byArm.C.busy - byArm.B.busy) * 100)}pp; C−A: ${f((byArm.C.busy - byArm.A.busy) * 100)}pp.`,
      "",
    );
    lines.push(
      `Launch condition: ${batch.preflight.condition}; host-wide overlapping jobs: ${batch.host.recordedRuns.map((x) => `${x.runId}/${x.boxId}/${x.size}/${x.kind}`).join(", ")}.`,
      "",
    );
    const gc = (arm) => (byArm[arm].gcMs * 60000) / byArm[arm].wallMs;
    lines.push(
      `GC ms/min B−A: ${f(gc("B") - gc("A"))}; C−B: ${f(gc("C") - gc("B"))}; C−A: ${f(gc("C") - gc("A"))}.`,
      "",
    );
    const sql = new Map();
    for (const row of batch.rows)
      for (const statement of statementSummary(row.run)) {
        const key = statement.method + "|" + statement.id + "|" + statement.caller;
        if (!sql.has(key)) sql.set(key, { statement, arms: {} });
        sql.get(key).arms[row.arm] = statement;
      }
    lines.push(
      "| Statement / method / caller | A / B / C calls per minute | B−A / C−B execution ms/min | A / B / C mean ms | A / B / C p99 ms |",
      "|---|---:|---:|---:|---:|",
      ...[...sql.values()]
        .sort(
          (x, y) =>
            Math.abs((y.arms.C?.totalMsPerMinute ?? 0) - (y.arms.B?.totalMsPerMinute ?? 0)) -
            Math.abs((x.arms.C?.totalMsPerMinute ?? 0) - (x.arms.B?.totalMsPerMinute ?? 0)),
        )
        .map(
          ({ statement: s, arms: a }) =>
            `| ${s.id.slice(0, 12)} ${s.method} ${s.caller.replaceAll("|", "\\|")} | ${["A", "B", "C"].map((k) => f(a[k]?.perMinute ?? 0)).join(" / ")} | ${f((a.B?.totalMsPerMinute ?? 0) - (a.A?.totalMsPerMinute ?? 0))} / ${f((a.C?.totalMsPerMinute ?? 0) - (a.B?.totalMsPerMinute ?? 0))} | ${["A", "B", "C"].map((k) => f(a[k]?.meanMs)).join(" / ")} | ${["A", "B", "C"].map((k) => f(a[k]?.p99Ms)).join(" / ")} |`,
        ),
      "",
    );
    for (const row of batch.rows) {
      row.statements = statementSummary(row.run);
      row.minutes = measurementFailures(row.run).length ? [] : minuteElu(row.run);
      lines.push(
        `### ${row.arm} ${row.run.offboxRunId}`,
        "",
        `Box:${row.run.offboxBoxId}, size:${row.run.offboxBoxSize}; revision:${row.run.revision}; log:${row.run.offboxLogPath}.`,
        "",
        `Measured run key: ${measuredRunKey(row.run)}; CPU resources: ${JSON.stringify(resourcePercentages(row.run))}.`,
        `Storage: ${JSON.stringify(row.run.pairedMeasurement?.filesystems ?? null)}.`,
        `Q1 launch cards: ${row.run.reviewLaunchSubstitution?.launches?.map((x) => x.cardId).join(", ") || "none"}; thread.created writer transactions: ${row.run.reviewLaunchSubstitution?.attributedThreadCreatedWriterTransactions ?? "missing"}. No physical-counter check is exempted.`,
        "",
        "Warnings:",
        "",
        "```json",
        JSON.stringify(row.run.pairedMeasurement?.warnings ?? null, null, 2),
        "```",
        "",
        "| Minute | Actual seconds | Busy % | Stalls |",
        "|---|---|---:|---:|",
        ...row.minutes.map(
          (m) =>
            `| ${m.minute} | ${f(m.fromSeconds)}–${f(m.toSeconds)} | ${f(m.busy * 100)} | ${m.stalls} |`,
        ),
        "",
        "| Statement / method / caller | Calls/min | Mean / p99 ms | Execution ms/min |",
        "|---|---:|---:|---:|",
        ...row.statements
          .sort((a, b) => b.totalMsPerMinute - a.totalMsPerMinute)
          .map(
            (s) =>
              `| ${s.id.slice(0, 12)} ${s.method} ${s.caller.replaceAll("|", "\\|")} | ${f(s.perMinute)} | ${f(s.meanMs)} / ${f(s.p99Ms)} | ${f(s.totalMsPerMinute)} |`,
          ),
        "",
      );
    }
  }
  lines.push(
    "Full SQL text, per-statement raw durations/callers, logical work, backlog and q1 launch proofs remain in the individual result JSONs and paired-verdict.json. SQL internal trigger work is part of its enclosing main native call; reader timings include prepare and result iteration. Minute boundaries use the first observed ELU sample at/after each target minute and show the actual bounds; delayed probes do not invent intermediate activity.",
    "",
  );
  await NodeFSP.writeFile(NodePath.join(out, "REPORT.md"), lines.join("\n") + "\n");
  await NodeFSP.writeFile(
    NodePath.join(out, "paired-verdict.json"),
    JSON.stringify(
      {
        verdict,
        globalInvalid,
        selection,
        spread,
        batches,
        leases: manifest.leases,
        suiteBoxes: manifest.suiteBoxes,
        latency: { verdict: latency.verdict, path: latencyFile },
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(`${verdict}: ${out}\n`);
  process.exitCode = verdict === "PASS" ? 0 : 1;
};
if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    const out = process.argv[2];
    if (!out) throw error;
    await NodeFSP.mkdir(out, { recursive: true });
    const invalid = [String(error)];
    await NodeFSP.writeFile(
      NodePath.join(out, "paired-verdict.json"),
      JSON.stringify({ verdict: "INVALID", invalid }) + "\n",
    );
    await NodeFSP.writeFile(
      NodePath.join(out, "REPORT.md"),
      `# Matched relative gate (.11)\n\nVerdict: **INVALID**.\n\n${invalid.join("\n")}\n`,
    );
    process.exitCode = 1;
  }
}
