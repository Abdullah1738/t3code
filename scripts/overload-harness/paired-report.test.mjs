import { describe, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import {
  ARMS,
  IDLE_RULE_EPOCH_MS,
  batchValidity,
  hostEvidenceFailures,
  selectAttempts,
  storageFailures,
  measurementFailures,
  minuteElu,
  statementSummary,
} from "./paired-report.mjs";

const hash = "a".repeat(64);
const fixture = (index = 0) => ({
  startedAt: new Date(1794610000000 + index * 1000).toISOString(),
  offboxRunId: `fixture-${index}`,
  offboxBoxId: `box-${index}`,
  wallMs: 600000,
  home: "/dev/shm/robob-overload-1352/3-A/overload-fixture",
  suiteExecution: { batch: 3, arm: "A" },
  activeMs: 120000,
  idleMs: 480000,
  errors: {},
  physical: { writerTransactions: 0 },
  stalls: [],
  pairedMeasurement: {
    version: 3,
    steadyEpochMs: 1794610120000 + index * 1000,
    resources: ["start", "end"].map((boundary, j) => ({
      boundary,
      beforeEpochMs: 1794610120000 + index * 1000 + j * 600000,
      afterEpochMs: 1794610120000 + index * 1000 + j * 600000,
      data: { nodePid: 100 + index },
    })),
    hooks: ["harness", "sqlite"].map((kind) => ({
      kind,
      sourceHash: hash,
      instrumentedHash: hash,
    })),
    marks: [
      { name: "profileStart", seconds: 270, epochMs: 1794610390000 },
      { name: "profileEnd", seconds: 330, epochMs: 1794610450000 },
    ],
    intervals: Array.from({ length: 601 }, (_, i) => ({
      seconds: i,
      epochMs: 1794610120000 + i * 1000,
      activeMs: i * 200,
      idleMs: i * 800,
    })),
    filesystems: ["start", "end"].map((boundary, i) => ({
      boundary,
      beforeEpochMs: 1794610120000 + index * 1000 + i * 600000,
      afterEpochMs: 1794610120000 + index * 1000 + i * 600000,
      files: ["statev2", "boards"].map((name) => ({
        name,
        path: `/dev/shm/robob-overload-1352/3-A/overload-fixture/userdata/${name}.sqlite`,
        actualPath: `/dev/shm/robob-overload-1352/3-A/overload-fixture/userdata/${name}.sqlite`,
        deviceId: "99",
        inode: name,
        statfsType: "0x1021994",
        fsType: "tmpfs",
        tmpfs: true,
        mount: {
          mountId: "3",
          device: "0:99",
          mountPoint: "/dev/shm",
          source: "tmpfs",
          fsType: "tmpfs",
        },
      })),
    })),
    warnings: [],
    nonExecutionReplies: [],
    statements: ["main:run", "main:all", "worker:prepare+execute"].map((method) => ({
      id: hash,
      sql: "SELECT 1",
      method,
      caller: "fixture",
      samples: [
        { seconds: 1, durationMs: 2, success: true },
        { seconds: 2, durationMs: 4, success: true },
      ],
    })),
  },
});

describe("matched batch report evidence", () => {
  it("accepts complete fixed evidence and reports statement execution math", () => {
    const run = fixture();
    expect(measurementFailures(run)).toEqual([]);
    expect(batchValidity([fixture(0), fixture(1), fixture(2)])).toEqual([]);
    expect(statementSummary(run)[0]).toMatchObject({
      count: 2,
      perMinute: 0.2,
      meanMs: 3,
      p99Ms: 4,
      totalMsPerMinute: 0.6,
    });
    expect(minuteElu(run)).toHaveLength(10);
    expect(minuteElu(run).every((row) => row.busy === 0.2 && row.stalls === 0)).toBe(true);
  });
  it("requires the COMMIT timeline to match independent physical counters", () => {
    const r = fixture();
    r.physical.writerTransactions = 1;
    expect(measurementFailures(r)).toContain(
      "native COMMIT timeline disagrees with writer transaction total",
    );
    r.pairedMeasurement.statements.push({
      id: hash,
      sql: "COMMIT",
      method: "main:run",
      caller: "orchestrationV2.EventSink.write",
      samples: [{ seconds: 1, durationMs: 1, success: true }],
    });
    expect(measurementFailures(r)).toEqual([]);
  });
  it.each([
    [
      "missing total idle",
      (m) => {
        for (const row of m.intervals) row.idleMs = 0;
      },
    ],
    [
      "final idle mismatch",
      (m) => {
        m.intervals.at(-1).idleMs -= 20;
      },
    ],
    [
      "inconsistent elapsed",
      (m) => {
        m.intervals[100].idleMs -= 20;
      },
    ],
    ["missing resource boundaries", (m) => delete m.resources],
    [
      "late resource boundary",
      (m) => {
        m.resources[1].beforeEpochMs += 10000;
      },
    ],
    [
      "reader outcome telemetry",
      (m) => {
        delete m.nonExecutionReplies;
      },
    ],
    [
      "lost worker execution timing",
      (m) => {
        m.nonExecutionReplies.push({
          sql: "SELECT 1",
          caller: "fixture",
          seconds: 1,
          reason: "missing-worker-execution-timing",
        });
      },
    ],
    [
      "retired worker execution",
      (m) => {
        m.nonExecutionReplies.push({
          sql: "SELECT 1",
          caller: "fixture",
          seconds: 1,
          reason: "worker-retired-after-start",
        });
      },
    ],
    [
      "version",
      (m) => {
        delete m.version;
      },
    ],
    [
      "steady epoch",
      (m) => {
        delete m.steadyEpochMs;
      },
    ],
    [
      "hooks",
      (m) => {
        m.hooks = [];
      },
    ],
    [
      "duplicate hooks",
      (m) => {
        m.hooks[1].kind = "harness";
      },
    ],
    [
      "truncated intervals",
      (m) => {
        m.intervals = m.intervals.slice(0, -1);
      },
    ],
    [
      "backward ELU",
      (m) => {
        m.intervals[10].activeMs = 1;
      },
    ],
    [
      "backward timestamp",
      (m) => {
        m.intervals[10].seconds = 1;
      },
    ],
    [
      "invented ELU total",
      (m) => {
        m.intervals.at(-1).activeMs += 30;
      },
    ],
    [
      "warnings",
      (m) => {
        delete m.warnings;
      },
    ],
    [
      "unretained warning count",
      (m) => {
        m.warnings.push({
          level: "Warn",
          text: "fixture",
          steady: true,
          wallTime: "2026-11-14T00:00:00Z",
        });
      },
    ],
    [
      "warning text",
      (m) => {
        m.warnings.push({ level: "Warn", steady: false, wallTime: "2026-11-14T00:00:00Z" });
      },
    ],
    [
      "statements",
      (m) => {
        m.statements = [];
      },
    ],
    [
      "missing duration",
      (m) => {
        delete m.statements[0].samples[0].durationMs;
      },
    ],
    [
      "nonfinite duration",
      (m) => {
        m.statements[0].samples[0].durationMs = NaN;
      },
    ],
    [
      "negative duration",
      (m) => {
        m.statements[0].samples[0].durationMs = -1;
      },
    ],
    [
      "missing caller",
      (m) => {
        delete m.statements[0].caller;
      },
    ],
    [
      "missing SQL",
      (m) => {
        delete m.statements[0].sql;
      },
    ],
    [
      "missing worker",
      (m) => {
        m.statements.pop();
      },
    ],
    [
      "missing profile wall marker",
      (m) => {
        m.marks.pop();
      },
    ],
    [
      "reversed profile marker",
      (m) => {
        m.marks[1].seconds = 260;
      },
    ],
  ])("invalidates missing or inconsistent %s", (_, change) => {
    const run = fixture();
    change(run.pairedMeasurement);
    expect(measurementFailures(run).length).toBeGreaterThan(0);
  });
  it.each([
    [
      "reused box",
      (runs) => {
        runs[1].offboxBoxId = runs[0].offboxBoxId;
      },
    ],
    [
      "reused run",
      (runs) => {
        runs[1].offboxRunId = runs[0].offboxRunId;
      },
    ],
    [
      "late start",
      (runs) => {
        runs[1].startedAt = new Date(Date.parse(runs[0].startedAt) + 61000).toISOString();
      },
    ],
    [
      "short overlap",
      (runs) => {
        runs[1].pairedMeasurement.steadyEpochMs += 61000;
      },
    ],
    [
      "missing arm",
      (runs) => {
        runs.pop();
      },
    ],
  ])("invalidates a batch with %s", (_, change) => {
    const runs = [fixture(0), fixture(1), fixture(2)];
    change(runs);
    expect(batchValidity(runs).length).toBeGreaterThan(0);
  });
  it("retains delayed-probe bounds instead of inventing an interval split", () => {
    const run = fixture();
    run.pairedMeasurement.intervals = run.pairedMeasurement.intervals.filter(
      (row) => row.seconds < 59 || row.seconds > 72,
    );
    run.stalls = [{ seconds: 73, delayMs: 13900 }];
    const minute = minuteElu(run)[0];
    expect(minute).toMatchObject({ fromSeconds: 0, toSeconds: 73, busy: 0.2, stalls: 1 });
  });
});

describe("explicit storage and bounded quiet-host policy", () => {
  it.each([
    ["missing boundaries", (r) => delete r.pairedMeasurement.filesystems],
    ["missing end", (r) => r.pairedMeasurement.filesystems.pop()],
    ["duplicate start", (r) => (r.pairedMeasurement.filesystems[1].boundary = "start")],
    ["unplaced home", (r) => (r.home = "/tmp/overload-fixture")],
    [
      "wrong actual path",
      (r) => (r.pairedMeasurement.filesystems[0].files[0].actualPath = "/tmp/a"),
    ],
    ["ZFS at start", (r) => (r.pairedMeasurement.filesystems[0].files[0].fsType = "zfs")],
    ["ZFS at end", (r) => (r.pairedMeasurement.filesystems[1].files[1].mount.fsType = "zfs")],
    ["wrong magic", (r) => (r.pairedMeasurement.filesystems[1].files[0].statfsType = "0x2fc12fc1")],
    ["lost mount", (r) => delete r.pairedMeasurement.filesystems[0].files[0].mount],
    ["mount changed", (r) => (r.pairedMeasurement.filesystems[1].files[1].mount.mountId = "88")],
    ["device changed", (r) => (r.pairedMeasurement.filesystems[1].files[1].deviceId = "88")],
    ["missing board file", (r) => r.pairedMeasurement.filesystems[1].files.pop()],
    [
      "file read error",
      (r) => (r.pairedMeasurement.filesystems[0].files[0].error = "permission denied"),
    ],
    ["late start check", (r) => (r.pairedMeasurement.filesystems[0].afterEpochMs += 10000)],
    ["early end check", (r) => (r.pairedMeasurement.filesystems[1].beforeEpochMs -= 10000)],
  ])("invalidates %s", (_, change) => {
    const r = fixture();
    change(r);
    expect(storageFailures(r).length).toBeGreaterThan(0);
  });
  const proof = () => {
    const runs = [fixture(0), fixture(1), fixture(2)];
    const checked = IDLE_RULE_EPOCH_MS + 2700000;
    for (const [i, r] of runs.entries()) {
      r.startedAt = new Date(checked + 45000 + i * 1000).toISOString();
      r.pairedMeasurement.steadyEpochMs = checked + 165000 + i * 1000;
    }
    const host = {
      fromEpochMs: checked + 165000,
      toEpochMs: checked + 767000,
      recordedRuns: runs.map((r) => ({
        runId: r.offboxRunId,
        boxId: r.offboxBoxId,
        size: "xlarge",
        kind: "matched-overload",
        commandAtMs: checked - 60000,
        endAtMs: checked + 800000,
        status: "done",
      })),
      samples: Array.from({ length: 23 }, (_, i) => ({
        coverageVerified: true,
        classificationPolicyHash: hash,
        collectedAtMs: checked + 155000 + i * 30000,
        host: { ts: (checked + 155000 + i * 30000) / 1000, running_cmds: 3, queued_cmds: 0 },
        jobs: runs.map((r) => ({
          runId: r.offboxRunId,
          boxId: r.offboxBoxId,
          size: "xlarge",
          kind: "matched-overload",
          startedAtMs: checked - 60000,
          endedAtMs: null,
          running: true,
          queued: false,
          apiVerified: true,
        })),
      })),
      jobSnapshots: Array.from({ length: 23 }, (_, i) => ({
        coverageVerified: true,
        classificationPolicyHash: hash,
        collectedAtMs: checked + 155000 + i * 30000,
        host: { ts: (checked + 155000 + i * 30000) / 1000, running_cmds: 3, queued_cmds: 0 },
        jobs: runs.map((r) => ({
          runId: r.offboxRunId,
          boxId: r.offboxBoxId,
          size: "xlarge",
          kind: "matched-overload",
          startedAtMs: checked - 60000,
          endedAtMs: null,
          running: true,
          queued: false,
          apiVerified: true,
        })),
      })),
      armRunIds: runs.map((r) => r.offboxRunId),
    };
    const pre = {
      classificationPolicyHash: hash,
      coverageVerified: true,
      exclusiveArmBoxes: true,
      condition: "idle",
      checkedAtMs: checked,
      launchAtMs: checked + 45000,
      ruleStartedAtMs: IDLE_RULE_EPOCH_MS,
      armedRunIds: runs.map((r) => r.offboxRunId),
      otherJobs: [],
      hostSample: { ts: checked / 1000, running_cmds: 3, queued_cmds: 0 },
    };
    for (const sample of host.jobSnapshots) sample.observedJobs = sample.jobs;
    return { runs, host, pre };
  };
  it("accepts idle or verified light co-load after45minutes", () => {
    const { runs, host, pre } = proof();
    expect(hostEvidenceFailures(host, pre, runs)).toEqual([]);
    pre.condition = "quiet-enough";
    pre.otherJobs = [
      { runId: "other", boxId: "other-box", size: "large", kind: "light", verified: true },
    ];
    pre.hostSample.running_cmds = 4;
    expect(hostEvidenceFailures(host, pre, runs)).toEqual([]);
  });
  it.each([
    ["old median policy", (p) => (p.condition = "at_or_below_hour_median")],
    [
      "early fallback",
      (p) => {
        p.condition = "quiet-enough";
        p.ruleStartedAtMs += 1;
      },
    ],
    ["unreported co-load", (p) => (p.hostSample.running_cmds = 4)],
    ["queued work", (p) => (p.hostSample.queued_cmds = 1)],
    ["stale sample", (p) => (p.hostSample.ts -= 31)],
    [
      "xlarge job",
      (p) => {
        p.condition = "quiet-enough";
        p.hostSample.running_cmds = 4;
        p.otherJobs = [{ runId: "x", boxId: "x", size: "xlarge", kind: "light", verified: true }];
      },
    ],
    [
      "disk job",
      (p) => {
        p.condition = "quiet-enough";
        p.hostSample.running_cmds = 4;
        p.otherJobs = [
          { runId: "x", boxId: "x", size: "large", kind: "disk-wait", verified: true },
        ];
      },
    ],
    [
      "unverified job",
      (p) => {
        p.condition = "quiet-enough";
        p.hostSample.running_cmds = 4;
        p.otherJobs = [{ runId: "x", boxId: "x", size: "large", kind: "light" }];
      },
    ],
  ])("rejects %s", (_, change) => {
    const { runs, host, pre } = proof();
    change(pre);
    expect(hostEvidenceFailures(host, pre, runs).length).toBeGreaterThan(0);
  });
  it.each([
    ["missing global samples", (h) => delete h.samples],
    ["missing job snapshots", (h) => delete h.jobSnapshots],
    ["truncated samples", (h) => h.samples.splice(-2)],
    ["lost middle samples", (h) => h.samples.splice(5, 5)],
    ["missing arm in ledger", (h) => h.recordedRuns.pop()],
    ["missing command interval", (h) => delete h.recordedRuns[0].commandAtMs],
    ["missing job identities", (h) => (h.jobSnapshots[2].jobs = [])],
    [
      "unidentified running command",
      (h) => {
        for (const x of h.jobSnapshots) x.host.running_cmds = 4;
      },
    ],
    [
      "frozen host clock",
      (h) => {
        for (const x of [...h.samples, ...h.jobSnapshots]) x.host.ts = h.fromEpochMs / 1000 - 10;
      },
    ],
    [
      "stale host clock",
      (h) => {
        for (const x of [...h.samples, ...h.jobSnapshots]) x.host.ts -= 31;
      },
    ],
    ["future host clock", (h) => (h.samples[0].host.ts += 60)],
    ["missing interval ledger", (h) => delete h.jobSnapshots[0].observedJobs],
    ["unproven coverage", (_, p) => delete p.coverageVerified],
    ["invented earlier rule clock", (_, p) => (p.ruleStartedAtMs -= 1000000)],
    [
      "preflight after actual start",
      (_, p) => {
        p.checkedAtMs += 55000;
        p.hostSample.ts = p.checkedAtMs / 1000;
        p.launchAtMs = p.checkedAtMs + 45000;
      },
    ],
  ])("rejects %s co-load evidence", (_, change) => {
    const { runs, host, pre } = proof();
    change(host, pre);
    expect(hostEvidenceFailures(host, pre, runs).length).toBeGreaterThan(0);
  });
  it("coalesces fresh duplicate host clock reads without dropping interval evidence", () => {
    const { runs, host, pre } = proof();
    for (const field of ["samples", "jobSnapshots"]) {
      const duplicate = structuredClone(host[field][4]);
      duplicate.collectedAtMs += 1000;
      host[field].splice(5, 0, duplicate);
    }
    expect(hostEvidenceFailures(host, pre, runs)).toEqual([]);
  });
  it("requires a job entirely between host samples in the overlap ledger", () => {
    const { runs, host, pre } = proof();
    const j = {
      runId: "short-benchmark-fixture",
      boxId: "other-box",
      size: "xlarge",
      kind: "unclassified",
      apiVerified: true,
      startedAtMs: host.fromEpochMs + 3000,
      endedAtMs: host.fromEpochMs + 5000,
    };
    host.jobSnapshots[1].observedJobs = [...host.jobSnapshots[1].observedJobs, j];
    expect(hostEvidenceFailures(host, pre, runs)).toContain(
      "host overlap ledger omits an observed command interval",
    );
    host.recordedRuns.push({ ...j, commandAtMs: j.startedAtMs, endAtMs: j.endedAtMs });
    expect(hostEvidenceFailures(host, pre, runs)).toEqual([]);
  });
  it("retains a valid numerical FAIL and replaces only INVALID attempts", () => {
    const batches = ["INVALID", "PASS", "FAIL", "PASS"].map((verdict, i) => ({
      batch: i + 3,
      verdict,
    }));
    expect(selectAttempts(batches)).toMatchObject({ verdict: "FAIL", counted: [4, 5, 6] });
    expect(selectAttempts(batches.slice(0, 3)).verdict).toBe("INVALID");
    expect(
      selectAttempts(Array.from({ length: 6 }, (_, i) => ({ batch: i + 3, verdict: "INVALID" })))
        .invalid,
    ).toContain("six attempts exhausted without three valid batches");
    expect(selectAttempts([...batches, { batch: 7, verdict: "PASS" }]).verdict).toBe("INVALID");
  });
});

it.each(["missing", "truncated"])("overwrites stale PASS evidence after %s input", async (kind) => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "paired-report-proof-"));
  try {
    await NodeFSP.writeFile(
      NodePath.join(dir, "paired-verdict.json"),
      JSON.stringify({ verdict: "PASS" }),
    );
    await NodeFSP.writeFile(NodePath.join(dir, "REPORT.md"), "PASS");
    const manifest = NodePath.join(dir, "manifest.json");
    if (kind === "truncated") await NodeFSP.writeFile(manifest, "{");
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [
        NodeURL.fileURLToPath(new URL("./paired-report.mjs", import.meta.url)),
        dir,
        manifest,
        NodePath.join(dir, "latency.json"),
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(
      JSON.parse(await NodeFSP.readFile(NodePath.join(dir, "paired-verdict.json"), "utf8")).verdict,
    ).toBe("INVALID");
    expect(await NodeFSP.readFile(NodePath.join(dir, "REPORT.md"), "utf8")).toContain("INVALID");
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});

const schemaTargets = JSON.parse(
  await NodeFSP.readFile(new URL("./targets.json", import.meta.url), "utf8"),
);
const kinds = [
  "providerEvent",
  "rootStart",
  "pacing",
  "otherCommand",
  "providerTurnEnd",
  "status",
  "asks",
  "readOpenCards",
  "kanbanToolsRead",
];
const schemaFixture = (index) => {
  const base = index === 0;
  const busy = base ? 0.6 : 0.2;
  const revision = base ? ARMS.A : ARMS.C;
  return {
    revision,
    startedAt: `2026-11-13T${String(index).padStart(2, "0")}:00:00Z`,
    offboxRunId: `test-fixture-${index}`,
    offboxLogPath: "test-fixture.log",
    node: "v24.22.1",
    cpu: "test-fixture-cpu",
    cpus: 16,
    runtimeFlags: [],
    shapeHash: hash,
    targetsHash: hash,
    probeHash: hash,
    source: {
      productRevision: revision,
      harnessIndexTree: "c".repeat(40),
      harnessHash: hash,
      workloadHash: hash,
    },
    telemetrySchemaVersion: 2,
    gcMs: busy * 0.25 * 600000,
    busy,
    activeMs: busy * 600000,
    idleMs: (1 - busy) * 600000,
    gcOfBusy: 0.25,
    gcOfWall: busy * 0.25,
    wallMs: 600000,
    warmupSeconds: 120,
    steadySeconds: 600,
    boardsCount: 17,
    logical: {
      ...Object.fromEntries(
        kinds.flatMap((kind) => [
          [`offered:${kind}`, 100],
          [`completed:${kind}`, 100],
        ]),
      ),
      ...Object.fromEntries(
        ["status", "asks", "readOpenCards", "kanbanToolsRead"].map((kind) => [
          `served:${kind}`,
          100,
        ]),
      ),
      tickSteps: schemaTargets.workTargets.tickStepsPerSecond * 600,
      dispatchDecisions: 0,
      receipts: 1220,
      "driverEvents:providerEvent": 2840,
      "driverEvents:rootStart": 2000,
      "driverEvents:command": 1220,
      providerLaunches: 0,
      providerSends: 126,
      "offered:boardGet": 0,
      "completed:boardGet": 0,
      "served:boardGet": 0,
      ...Object.fromEntries(
        Object.keys(schemaTargets.eventWriteBatches.all).flatMap((kind) => [
          [`persisted:${kind}`, 100],
          [`offeredEventType:${kind}`, 100],
        ]),
      ),
    },
    physical: {
      writerTransactions: schemaTargets.workTargets.writerTransactionsPerMinute * 10,
      openCardRows: schemaTargets.workTargets.cardRowsPerSecond * 600,
    },
    cacheBefore: { discussion: { misses: 0 } },
    cacheAfter: {
      discussion: { misses: schemaTargets.workTargets.discussionMissesPerSecond * 600 },
    },
    resultSizes: { status: 21875, asks: 44, readOpenCards: 3900, kanbanToolsRead: 3900 },
    delayMs: { p50: 1, p99: 10, max: 20 },
    stalls: [],
    errors: {},
    backlog: Array.from({ length: 61 }, (_, index) => ({
      seconds: index * 10,
      pending: 0,
      outbox: 0,
      dispatcher: 0,
    })),
    backlogSlopes: { pending: 0, outbox: 0, dispatcher: 0 },
  };
};
const cpuFixture = () => ({
  startTime: 0,
  endTime: 60000000,
  nodes: [{ id: 1, callFrame: { functionName: "fixture", url: "fixture.js", lineNumber: 0 } }],
  samples: [1],
  timeDeltas: [60000000],
});

const cliEvidence = async (change = async () => {}) => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "paired-cli-evidence-"));
  try {
    const configuration = {
      hostPolicyHash: hash,
      harnessHash: hash,
      measurementHash: hash,
      workloadHash: "a99eff438d2e57abb41c28b60c71292786740576b5624dc0a91b5decb06c179d",
    };
    const batches = [];
    const suiteBoxes = ["bx_fixture0", "bx_fixture1", "bx_fixture2"];
    for (let batch = 3; batch <= 6; batch++) {
      const metadata = { batch };
      const rotation = Math.max(0, batch - 4);
      const runs = [];
      const checked = IDLE_RULE_EPOCH_MS + 2700000 + (batch - 3) * 900000;
      for (const [i, arm] of ["A", "B", "C"].entries()) {
        const r = schemaFixture(arm === "A" ? 0 : 1);
        const busy = r.busy;
        const steady = checked + 165000 + i * 1000;
        r.revision = ARMS[arm];
        r.source = {
          ...r.source,
          ...configuration,
          productRevision: r.revision,
          harnessIndexTree: "5f055a5cc28ff8ed9f00de1ea515f486786e17f3",
          settings: { storageRoot: "/dev/shm/robob-overload-1352" },
        };
        r.home = `/dev/shm/robob-overload-1352/${batch}-${arm}/overload-fixture`;
        r.startedAt = new Date(checked + 45000 + i * 1000).toISOString();
        r.completedAt = new Date(steady + 600000).toISOString();
        const slot = (i + rotation) % 3;
        r.offboxRunId = `suite-parent-${slot}`;
        r.offboxBoxId = suiteBoxes[slot];
        r.offboxBoxSize = "xlarge";
        const m = fixture(i).pairedMeasurement;
        m.steadyEpochMs = steady;
        m.filesystems.forEach((x, j) => {
          x.beforeEpochMs = steady + j * 600000;
          x.afterEpochMs = x.beforeEpochMs;
        });
        m.intervals = Array.from({ length: 601 }, (_, j) => ({
          seconds: j,
          epochMs: steady + j * 1000,
          activeMs: j * 1000 * busy,
          idleMs: j * 1000 * (1 - busy),
        }));
        m.statements.push({
          id: hash,
          sql: "COMMIT",
          method: "main:run",
          caller: "orchestrationV2.EventSink.write",
          samples: Array.from({ length: r.physical.writerTransactions }, (_, j) => ({
            seconds: (j * 600) / r.physical.writerTransactions,
            durationMs: 1,
            success: true,
          })),
        });
        for (const snapshot of m.filesystems)
          for (const f of snapshot.files) {
            f.path = `${r.home}/userdata/${f.name}.sqlite`;
            f.actualPath = f.path;
          }
        const identity = {
          nodePid: batch * 10 + i,
          nodeStartEpochMs: checked + 1000 + i,
          linuxStartTicks: String(batch * 1000 + i),
          bootId: `boot-${slot}`,
          offboxBoxId: r.offboxBoxId,
          hostname: r.offboxBoxId.replace("bx_", "bx-"),
          parentOffboxRunId: r.offboxRunId,
          batch,
          arm,
          cgroupPath: `/cgroup/${slot}`,
          membershipPid: batch * 10 + i,
          cpuMax: "max 100000",
          cpuStat: { throttled_usec: 0, nr_throttled: 0 },
          pressure: { someTotalUs: 100, fullTotalUs: 0 },
        };
        m.resources = ["start", "end"].map((boundary, j) => ({
          boundary,
          beforeEpochMs: steady + j * 600000,
          afterEpochMs: steady + j * 600000,
          data: { ...identity, pressure: { someTotalUs: 100 + j * 6000000, fullTotalUs: 0 } },
        }));
        r.suiteExecution = {
          parentOffboxRunId: r.offboxRunId,
          batch,
          arm,
          nodePid: identity.nodePid,
          expectedBoxId: r.offboxBoxId,
          planHash: hash,
          launchedAtMs: checked + 1000,
          launchIdentity: {
            offboxBoxId: r.offboxBoxId,
            hostname: r.offboxBoxId.replace("bx_", "bx-"),
            parentOffboxRunId: r.offboxRunId,
          },
          processesAtLaunch: [{ pid: 1, comm: "init" }],
          freshDirectory: {
            path: `/dev/shm/robob-overload-1352/${batch}-${arm}`,
            created: true,
            existedBefore: false,
          },
          previousDirectory: { gone: true, path: null },
        };
        if (batch > 3) {
          const prevRotation = Math.max(0, batch - 5),
            prevArm = ["A", "B", "C"][(slot - prevRotation + 3) % 3];
          r.suiteExecution.previousDirectory.path = `/dev/shm/robob-overload-1352/${batch - 1}-${prevArm}`;
        }
        r.pairedMeasurement = m;
        if (arm === "C") {
          r.physical.openCardRows /= 2;
          r.cacheAfter.discussion.misses /= 2;
          r.delayMs.p99 = 9;
        }
        const file = NodePath.join(dir, `${batch}-${arm}`, "result.json");
        await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
        await NodeFSP.writeFile(file, JSON.stringify(r));
        await NodeFSP.writeFile(
          NodePath.join(NodePath.dirname(file), "middle.cpuprofile"),
          JSON.stringify({
            ...cpuFixture(),
            startTime: batch * 1000000000 + i * 100000000,
            endTime: batch * 1000000000 + i * 100000000 + 60000000,
          }),
        );
        metadata[arm] = file;
        runs.push(r);
      }
      const samples = Array.from({ length: 23 }, (_, i) => ({
        coverageVerified: true,
        classificationPolicyHash: hash,
        collectedAtMs: checked + 155000 + i * 30000,
        host: { ts: (checked + 155000 + i * 30000) / 1000, running_cmds: 3, queued_cmds: 0 },
        jobs: runs.map((r) => ({
          runId: r.offboxRunId,
          boxId: r.offboxBoxId,
          size: "xlarge",
          kind: "matched-overload",
          startedAtMs: checked - 60000,
          endedAtMs: null,
          running: true,
          queued: false,
          apiVerified: true,
        })),
      }));
      for (const sample of samples) sample.observedJobs = sample.jobs;
      const host = {
        fromEpochMs: checked + 165000,
        toEpochMs: checked + 767000,
        recordedRuns: runs.map((r) => ({
          runId: r.offboxRunId,
          boxId: r.offboxBoxId,
          size: "xlarge",
          kind: "matched-overload",
          commandAtMs: checked - 60000,
          endAtMs: checked + 800000,
          status: "done",
        })),
        samples,
        jobSnapshots: samples,
        armRunIds: runs.map((r) => r.offboxRunId),
      };
      const pre = {
        classificationPolicyHash: hash,
        coverageVerified: true,
        exclusiveArmBoxes: true,
        condition: "idle",
        checkedAtMs: checked,
        launchAtMs: checked + 45000,
        ruleStartedAtMs: IDLE_RULE_EPOCH_MS,
        armedRunIds: runs.map((r) => r.offboxRunId),
        otherJobs: [],
        hostSample: { ts: checked / 1000, running_cmds: 3, queued_cmds: 0 },
      };
      metadata.hostEvidence = NodePath.join(dir, `${batch}-host.json`);
      metadata.preflightEvidence = NodePath.join(dir, `${batch}-pre.json`);
      await NodeFSP.writeFile(metadata.hostEvidence, JSON.stringify(host));
      await NodeFSP.writeFile(metadata.preflightEvidence, JSON.stringify(pre));
      const plan = {
        batch,
        rotation,
        writtenAtMs: checked + 10,
        releaseEpochMs: checked + 45000,
        hash,
        assignment: Object.fromEntries(
          ["A", "B", "C"].map((a, i) => [a, suiteBoxes[(i + rotation) % 3]]),
        ),
      };
      metadata.planEvidence = NodePath.join(dir, `${batch}-plan.json`);
      await NodeFSP.writeFile(metadata.planEvidence, JSON.stringify(plan));
      batches.push(metadata);
    }
    const leases = suiteBoxes.map((boxId, i) => ({
      boxId,
      parentOffboxRunId: `suite-parent-${i}`,
      startedAtMs: IDLE_RULE_EPOCH_MS,
      endedAtMs: IDLE_RULE_EPOCH_MS + 10000000,
      released: true,
    }));
    const manifest = { configuration, batches, suiteBoxes, leases };
    await change(manifest);
    const manifestFile = NodePath.join(dir, "manifest.json"),
      latencyFile = NodePath.join(dir, "latency.json"),
      out = NodePath.join(dir, "out");
    await NodeFSP.writeFile(manifestFile, JSON.stringify(manifest));
    await NodeFSP.writeFile(
      latencyFile,
      JSON.stringify({
        verdict: "PASS",
        rows: [{ run: { revision: ARMS.A } }, { run: { revision: ARMS.C } }],
      }),
    );
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [
        NodeURL.fileURLToPath(new URL("./paired-report.mjs", import.meta.url)),
        out,
        manifestFile,
        latencyFile,
      ],
      { encoding: "utf8" },
    );
    return {
      status: result.status,
      verdict: JSON.parse(
        await NodeFSP.readFile(NodePath.join(out, "paired-verdict.json"), "utf8"),
      ),
      report: await NodeFSP.readFile(NodePath.join(out, "REPORT.md"), "utf8"),
    };
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
};
it.each([
  "missing measurement hash",
  "missing file",
  "truncated file",
  "malformed warning",
  "malformed resources",
  "empty object",
])(
  "replaces INVALID attempt with %s and scores later valid batches",
  async (kind) => {
    const result = await cliEvidence(async (manifest) => {
      const file = manifest.batches[0].A;
      if (kind === "empty object") await NodeFSP.writeFile(file, "{}");
      else if (kind === "missing file") await NodeFSP.rm(file);
      else if (kind === "truncated file") await NodeFSP.writeFile(file, "{");
      else if (kind === "malformed resources") {
        const r = JSON.parse(await NodeFSP.readFile(file, "utf8"));
        r.pairedMeasurement.resources = [null];
        await NodeFSP.writeFile(file, JSON.stringify(r));
      } else if (kind === "malformed warning") {
        const r = JSON.parse(await NodeFSP.readFile(file, "utf8"));
        r.pairedMeasurement.warnings = [null];
        await NodeFSP.writeFile(file, JSON.stringify(r));
      } else {
        const r = JSON.parse(await NodeFSP.readFile(file, "utf8"));
        delete r.source.measurementHash;
        await NodeFSP.writeFile(file, JSON.stringify(r));
      }
    });
    expect(
      result.verdict.verdict,
      JSON.stringify(result.verdict.globalInvalid ?? result.verdict.invalid),
    ).toBe("PASS");
    expect(result.verdict.selection.counted).toEqual([4, 5, 6]);
    expect(result.verdict.batches[0].verdict).toBe("INVALID");
    expect(result.report).toContain("9–10 pp swing");
    expect(result.report).toContain("−0.12 and −1.02 pp");
    expect(result.report).toContain("absolute busy level is not proven");
  },
  15000,
);
