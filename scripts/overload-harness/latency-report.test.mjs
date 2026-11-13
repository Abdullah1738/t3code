import { describe, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
const root = NodeURL.fileURLToPath(new URL("../../", import.meta.url));
const base = "dbc99fc3a4b817977bc23a57ea7c049da5d45190";
const make = (index) => ({
  scenario: "request-latency-1365",
  revision: index === 0 ? base : "b".repeat(40),
  offboxRunId: `fixture-${index}`,
  offboxLogPath: "fixture.log",
  startedAt: `2026-11-13T${index}:00:00Z`.replace("T0:", "T00:").replace("T1:", "T01:"),
  completedAt: "2026-11-14T00:00:00Z",
  source: { productRevision: index === 0 ? base : "b".repeat(40), workloadHash: "a".repeat(64) },
  node: "v24.22.1",
  cpu: "fixture",
  samples: 100,
  runtimeFlags: [],
  counts: { threads: 56543, runs: 130622, nodes: 5518254 },
  candidateIndexPresent: index !== 0,
  archiveExit: "Success",
  streams: Object.fromEntries(
    ["threads", "nodePk", "providerCredential", "clientCredential", "wholeMcp"].map((name) => {
      const slow = index === 0 && ["threads", "nodePk"].includes(name);
      return [
        name,
        {
          observations: Array.from({ length: 100 }, () => ({
            ms: slow ? 3000 : 5,
            completed: !slow,
            timedOut: slow,
            error: null,
            longReaderActive: true,
            writerActive: true,
          })),
        },
      ];
    }),
  ),
  telemetry: [
    {
      name: "sql.statement",
      attributes: {
        "db.lock_wait_ms": 0,
        "db.reader.hold_ms": 1,
        ...(index === 0 ? {} : { "db.reader.acquire_wait_ms": 0, "db.statement.execution_ms": 1 }),
      },
    },
  ],
});
const run = async (change, relativeMode = false, reusedInput) => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "latency-report-test-"));
  try {
    const rows = [make(0), make(1)];
    if (relativeMode) {
      rows[1].revision = "aeb6617ef8219665cf7ce2e89f834a8abb801a05";
      rows[1].source.productRevision = rows[1].revision;
    }
    if (change) change(rows);
    const paths = rows.map((_, index) => NodePath.join(dir, `${index}.json`));
    await Promise.all(
      rows.map((row, index) => NodeFSP.writeFile(paths[index], JSON.stringify(row))),
    );
    let result = NodeChildProcess.spawnSync(
      process.execPath,
      [
        "scripts/overload-harness/latency-report.mjs",
        NodePath.join(dir, "report"),
        ...paths,
        ...(relativeMode ? ["--relative-r11"] : []),
      ],
      { cwd: root, encoding: "utf8" },
    );
    if (reusedInput) {
      if (reusedInput === "missing") await NodeFSP.rm(paths[0]);
      else await NodeFSP.writeFile(paths[0], "{");
      result = NodeChildProcess.spawnSync(
        process.execPath,
        ["scripts/overload-harness/latency-report.mjs", NodePath.join(dir, "report"), ...paths],
        { cwd: root, encoding: "utf8" },
      );
    }
    return {
      status: result.status,
      stderr: result.stderr,
      report: await NodeFSP.readFile(NodePath.join(dir, "report/LATENCY-REPORT.md"), "utf8"),
    };
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
};
describe("request-latency evidence", () => {
  it.each(["missing", "malformed"])("invalidates reused output for %s input", async (kind) => {
    const result = await run(undefined, false, kind);
    expect(result.status).toBe(1);
    expect(result.report).toContain("**INVALID**");
  });
  it("records a fast base affected stream as a relative-gate fidelity note", async () => {
    const result = await run((rows) => {
      for (const sample of rows[0].streams.threads.observations) {
        sample.ms = 5;
        sample.completed = true;
        sample.timedOut = false;
      }
    }, true);
    expect(result.status, result.stderr).toBe(0);
    expect(result.report).toContain("Fidelity note:");
  });
  it("pins the relative latency candidate to R11", async () => {
    const result = await run((rows) => {
      rows[1].revision = "b".repeat(40);
      rows[1].source.productRevision = rows[1].revision;
    }, true);
    expect(result.report).toContain("candidate must be exact R11");
    expect(result.report).toContain("INVALID");
  });
  it("keeps the base credential guard under the relative gate", async () => {
    const result = await run((rows) => {
      rows[0].streams.providerCredential.observations[0].ms = 2001;
    }, true);
    expect(result.report).toContain("FAIL");
    expect(result.status).toBe(1);
  });
  it("accepts right-censored base pressure and the explicit older diagnostic exception", async () => {
    const result = await run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.report).toContain("not emitted by this revision");
  });
  it.each([
    [
      "missing hardware provenance",
      (rows) => {
        delete rows[1].cpu;
      },
      "INVALID",
    ],
    [
      "missing measured window",
      (rows) => {
        delete rows[1].startedAt;
      },
      "INVALID",
    ],
    [
      "missing source hash",
      (rows) => {
        delete rows[1].source.workloadHash;
      },
      "INVALID",
    ],
    [
      "missing client timings",
      (rows) => {
        delete rows[1].streams.nodePk;
      },
      "INVALID",
    ],
    [
      "short sample stream",
      (rows) => {
        rows[1].streams.threads.observations.pop();
      },
      "INVALID",
    ],
    [
      "holder released early",
      (rows) => {
        rows[1].streams.threads.observations[0].longReaderActive = false;
      },
      "INVALID",
    ],
    [
      "writer released early",
      (rows) => {
        rows[1].streams.threads.observations[0].writerActive = false;
      },
      "INVALID",
    ],
    [
      "missing new execution field",
      (rows) => {
        delete rows[1].telemetry[0].attributes["db.statement.execution_ms"];
      },
      "INVALID",
    ],
    [
      "missing old hold field",
      (rows) => {
        delete rows[0].telemetry[0].attributes["db.reader.hold_ms"];
      },
      "INVALID",
    ],
    [
      "missing index",
      (rows) => {
        rows[1].candidateIndexPresent = false;
      },
      "INVALID",
    ],
    [
      "changed runtime",
      (rows) => {
        rows[1].runtimeFlags = ["--jitless"];
      },
      "INVALID",
    ],
    [
      "changed seed",
      (rows) => {
        rows[1].counts.nodes = 1;
      },
      "INVALID",
    ],
    [
      "fast base without fidelity",
      (rows) => {
        rows[0].streams.nodePk = structuredClone(rows[1].streams.nodePk);
      },
      "FAIL",
    ],
    [
      "slow credential guard on base",
      (rows) => {
        rows[0].streams.providerCredential.observations[0].ms = 2100;
      },
      "FAIL",
    ],
    [
      "censored per-fix request",
      (rows) => {
        rows[1].streams.nodePk.observations[0] = {
          ...rows[1].streams.nodePk.observations[0],
          completed: false,
          timedOut: true,
          ms: 3000,
        };
      },
      "FAIL",
    ],
  ])("rejects %s", async (_name, change, verdict) => {
    const result = await run(change);
    expect(result.status, result.stderr).toBe(1);
    expect(result.report).toContain(`Scenario verdict: **${verdict}**`);
  });
});
