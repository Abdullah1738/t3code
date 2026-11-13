import { describe, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";

const root = NodeURL.fileURLToPath(new URL("../../", import.meta.url));
const targets = JSON.parse(
  await NodeFSP.readFile(new URL("./targets.json", import.meta.url), "utf8"),
);
const workTargets = targets.workTargets;
const digest = "a".repeat(64);
const baseSha = "dbc99fc3a4b817977bc23a57ea7c049da5d45190";
const candidateSha = "b".repeat(40);
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
const fixture = (index) => {
  const base = index === 0;
  const busy = base ? 0.6 : 0.2;
  const revision = base ? baseSha : candidateSha;
  return {
    revision,
    startedAt: `2026-11-13T${String(index).padStart(2, "0")}:00:00Z`,
    offboxRunId: `test-fixture-${index}`,
    offboxLogPath: "test-fixture.log",
    node: "v24.22.1",
    cpu: "test-fixture-cpu",
    cpus: 16,
    runtimeFlags: [],
    shapeHash: digest,
    targetsHash: digest,
    probeHash: digest,
    source: {
      productRevision: revision,
      harnessIndexTree: "c".repeat(40),
      harnessHash: digest,
      workloadHash: digest,
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
      tickSteps: workTargets.tickStepsPerSecond * 600,
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
        Object.keys(targets.eventWriteBatches.all).flatMap((kind) => [
          [`persisted:${kind}`, 100],
          [`offeredEventType:${kind}`, 100],
        ]),
      ),
    },
    physical: {
      writerTransactions: workTargets.writerTransactionsPerMinute * 10,
      openCardRows: workTargets.cardRowsPerSecond * 600,
    },
    cacheBefore: { discussion: { misses: 0 } },
    cacheAfter: { discussion: { misses: workTargets.discussionMissesPerSecond * 600 } },
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
const profile = () => ({
  startTime: 0,
  endTime: 60000000,
  nodes: [{ id: 1, callFrame: { functionName: "fixture", url: "fixture.js", lineNumber: 0 } }],
  samples: [1],
  timeDeltas: [60000000],
});
const run = async (change = () => {}, relative = false, reusedInput) => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "overload-report-test-"));
  try {
    const rows = Array.from({ length: 4 }, (_, index) => ({
      role: index === 0 ? "base" : "candidate",
      run: fixture(index),
      profile: profile(),
      filename: NodePath.join(dir, String(index), "result.json"),
    }));
    if (relative) {
      rows.splice(
        1,
        0,
        ...[4, 5].map((index) => ({
          role: "base",
          run: fixture(0),
          profile: profile(),
          filename: NodePath.join(dir, String(index), "result.json"),
        })),
      );
      for (const [index, row] of rows.entries()) {
        row.run.startedAt = `2026-11-13T${String(index).padStart(2, "0")}:00:00Z`;
        row.run.offboxRunId = index === 0 ? "run-1114-000117-d5e7" : `relative-fixture-${index}`;
        row.run.offboxBoxId = `box-${index}`;
        row.run.offboxBoxSize = "xlarge";
        row.run.conditions = {
          verified: true,
          boxId: row.run.offboxBoxId,
          boxSize: "xlarge",
          coLoads: [],
          metadataPath: "fixture.json",
        };
        row.run.revision =
          row.role === "base" ? baseSha : "aeb6617ef8219665cf7ce2e89f834a8abb801a05";
        row.run.source.productRevision = row.run.revision;
        row.run.source.harnessIndexTree = "5f055a5cc28ff8ed9f00de1ea515f486786e17f3";
        row.run.source.workloadHash =
          "a99eff438d2e57abb41c28b60c71292786740576b5624dc0a91b5decb06c179d";
      }
    }
    change(rows);
    for (const row of rows) {
      await NodeFSP.mkdir(NodePath.dirname(row.filename), { recursive: true });
      await NodeFSP.writeFile(row.filename, JSON.stringify(row.run));
      await NodeFSP.writeFile(
        NodePath.join(NodePath.dirname(row.filename), "middle.cpuprofile"),
        JSON.stringify(row.profile),
      );
    }
    let output = NodeChildProcess.spawnSync(
      process.execPath,
      [
        relative
          ? "scripts/overload-harness/relative-report.mjs"
          : "scripts/overload-harness/report.mjs",
        NodePath.join(dir, "report"),
        ...rows.map((row) => `${row.role}=${row.filename}`),
      ],
      { cwd: root, encoding: "utf8" },
    );
    if (reusedInput) {
      if (reusedInput === "missing") await NodeFSP.rm(rows[0].filename);
      else await NodeFSP.writeFile(rows[0].filename, "{");
      output = NodeChildProcess.spawnSync(
        process.execPath,
        [
          relative
            ? "scripts/overload-harness/relative-report.mjs"
            : "scripts/overload-harness/report.mjs",
          NodePath.join(dir, "report"),
          ...rows.map((row) => `${row.role}=${row.filename}`),
        ],
        { cwd: root, encoding: "utf8" },
      );
    }
    const report = await NodeFSP.readFile(NodePath.join(dir, "report/REPORT.md"), "utf8");
    return { status: output.status, report, stderr: output.stderr };
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
};

describe("overload report evidence", () => {
  it("accepts four independent, complete fixed fixtures", async () => {
    expect((await run()).status).toBe(0);
  });
  it.each([
    [
      "frozen source",
      (row) => {
        row.run.source.harnessIndexTree = "e".repeat(40);
      },
    ],
    [
      "box size",
      (row) => {
        row.run.offboxBoxSize = "large";
      },
    ],
    [
      "co-load provenance",
      (row) => {
        delete row.run.conditions;
      },
    ],
  ])("never labels candidates PASS after global invalid %s", async (_, change) => {
    const result = await run((rows) => change(rows[0]), true);
    expect(result.report).toContain("INVALID");
    expect(result.report).not.toMatch(/\| PASS \|/);
  });
  it.each([
    [true, "missing"],
    [true, "malformed"],
    [false, "missing"],
    [false, "malformed"],
  ])("invalidates reused output (relative=%s, input=%s)", async (relative, kind) => {
    const result = await run(() => {}, relative, kind);
    expect(result.report).toContain("**INVALID**");
    expect(result.report).not.toMatch(/\| PASS \|/);
  });
  it.each([["not-an-array"], [[null]]])(
    "fails work instead of crashing on malformed substitution evidence %j",
    async (launches) => {
      const result = await run((rows) => {
        rows[3].run.logical.providerLaunches = 4;
        rows[3].run.logical.providerSends = 122;
        rows[3].run.logical["persisted:thread.created"] = 4;
        rows[3].run.reviewLaunchSubstitution = { launches };
      }, true);
      expect(result.report).toContain("Release verdict: **FAIL**");
      expect(result.report).toContain("logical work outside ±10%");
    },
  );
  const cases = [
    ...[
      "providerLaunches",
      "providerSends",
      "offered:boardGet",
      "completed:boardGet",
      "served:boardGet",
      ...Object.keys(targets.eventWriteBatches.all).flatMap((kind) => [
        `persisted:${kind}`,
        `offeredEventType:${kind}`,
      ]),
    ].map((key) => [
      `missing frozen counter ${key}`,
      (rows) => {
        for (const row of rows) delete row.run.logical[key];
      },
      "missing logical work",
    ]),
    ...["pending", "outbox", "dispatcher"].map((key) => [
      `forged ${key} slope`,
      (rows) => {
        rows[3].run.backlog = rows[3].run.backlog.map((sample, index) => ({
          ...sample,
          [key]: index,
        }));
      },
      `inconsistent ${key} backlog slope`,
    ]),
    ...[null, {}, "x".repeat(61)].map((value, index) => [
      `invalid backlog container ${index}`,
      (rows) => {
        rows[3].run.backlog = value;
      },
      "missing steady backlog samples",
    ]),
    ...[-1, 0.5, "0"].map((value, index) => [
      `invalid logical count ${index}`,
      (rows) => {
        rows[3].run.logical.providerLaunches = value;
      },
      "missing logical work",
    ]),
    [
      "invalid backlog row",
      (rows) => {
        rows[3].run.backlog[10] = null;
      },
      "missing steady backlog samples",
    ],
    [
      "repeated backlog time",
      (rows) => {
        rows[3].run.backlog[1].seconds = 0;
      },
      "backlog timestamps not strictly increasing",
    ],
    [
      "missing physical counters",
      (rows) => {
        delete rows[3].run.physical;
      },
      "missing physical work telemetry",
    ],
    [
      "missing cache counters",
      (rows) => {
        delete rows[3].run.cacheAfter;
      },
      "missing physical work telemetry",
    ],

    [
      "missing work",
      (rows) => {
        rows[3].run.logical = { tickSteps: workTargets.tickStepsPerSecond * 600 };
      },
      "missing logical work",
    ],
    [
      "missing poller sizes",
      (rows) => {
        rows[3].run.resultSizes = {};
      },
      "missing poller logical sizes",
    ],
    [
      "missing errors",
      (rows) => {
        delete rows[3].run.errors;
      },
      "missing workload error",
    ],
    [
      "wrong slope keys",
      (rows) => {
        rows[3].run.backlogSlopes = { a: 0, b: 0, c: 0 };
      },
      "missing backlog slopes",
    ],
    [
      "different base seed",
      (rows) => {
        rows.push({
          ...structuredClone(rows[0]),
          filename: rows[1].filename + ".extra",
          run: {
            ...structuredClone(rows[0].run),
            startedAt: "2026-11-14T00:00:00Z",
            shapeHash: "d".repeat(64),
          },
        });
      },
      "comparison changed shapeHash",
    ],
    [
      "different runtime flags",
      (rows) => {
        rows[3].run.runtimeFlags = ["--jitless"];
      },
      "comparison changed runtimeFlags",
    ],
    [
      "different harness",
      (rows) => {
        rows[1].run.source.workloadHash = "d".repeat(64);
      },
      "comparison changed workload hash",
    ],
    [
      "missing hash",
      (rows) => {
        delete rows[3].run.probeHash;
      },
      "missing probeHash",
    ],
    [
      "repeated file",
      (rows) => {
        rows[1].filename = rows[0].filename;
      },
      "repeated result file",
    ],
    [
      "repeated window",
      (rows) => {
        rows[1].run.startedAt = rows[0].run.startedAt;
        rows[1].run.offboxRunId = rows[0].run.offboxRunId;
      },
      "repeated run window",
    ],
    [
      "different candidate revisions",
      (rows) => {
        rows[2].run.revision = "d".repeat(40);
        rows[2].run.source.productRevision = rows[2].run.revision;
      },
      "candidate revisions differ",
    ],
    [
      "unrecorded stall",
      (rows) => {
        rows[3].run.delayMs.max = 1050;
      },
      "stall ≥1 second",
    ],
    [
      "missing profile times",
      (rows) => {
        delete rows[3].profile.startTime;
        delete rows[3].profile.endTime;
      },
      "incomplete CPU profile",
    ],
    [
      "short profile samples",
      (rows) => {
        rows[3].profile.timeDeltas = [1000];
      },
      "incomplete CPU profile",
    ],
    [
      "invalid profile deltas",
      (rows) => {
        rows[3].profile.timeDeltas = [-1];
      },
      "incomplete CPU profile",
    ],
    [
      "wrong ELU",
      (rows) => {
        rows[3].run.busy = 0.1;
      },
      "ELU does not follow",
    ],
    [
      "wrong GC",
      (rows) => {
        rows[3].run.gcOfWall = 0.01;
      },
      "inconsistent GC",
    ],
  ];
  it.each(cases)("rejects %s", async (name, change, reason) => {
    const result = await run(change);
    expect(result.status, result.stderr).toBe(1);
    expect(result.report).toContain(reason);
    if (name !== "unrecorded stall") expect(result.report).toContain("INVALID");
  });
});
