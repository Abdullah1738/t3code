// Support the repository runner and dependency-free CLI checks.
const NodeTest = process.env.VITEST ? await import("vitest") : await import("node:test");
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeHttp from "node:http";
import * as NodeChildProcess from "node:child_process";
import { ControlClient } from "./client.mjs";
import {
  deepHealth,
  summarizeLag,
  readLagTail,
  healthVerdict,
  TAIL_BYTES,
  ownsListener,
} from "./deep-health.mjs";

const now = Date.parse("2026-11-13T10:10:00Z");
function fixture(severe = [], options = {}) {
  const rows = Array.from({ length: 21 }, (_, i) => ({
    time: new Date(now - (20 - i) * 30_000).toISOString(),
    kind: "sample",
    rssMb: 3600,
    gcTotalMs: 75,
    gcMajorMaxMs: 50,
  }));
  for (const [i, delay] of severe)
    rows[i] = {
      ...rows[i],
      delayMaxMs: delay,
      gcCount: 2,
      gcMaxMs: 50,
      gcMajorCount: 1,
      heapUsedMb: 1500,
      heapUsedMbPrev: 2100,
    };
  return {
    text:
      rows
        .filter((_, i) => !options.skip?.includes(i))
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
    bytesRead: 2000,
  };
}
const ok = { status: "ok", ms: 10, readiness: "healthy" };
for (const [name, severe, verdict, code] of [
  ["healthy", [], "healthy", 0],
  ["degraded", [[18, 5000]], "degraded", 1],
  [
    "stalled",
    [
      [14, 5000],
      [16, 6000],
      [20, 32_700],
    ],
    "stalled",
    2,
  ],
])
  NodeTest.test(`lag summary and verdict: ${name}`, () => {
    const lag = summarizeLag(fixture(severe), now);
    NodeAssert.equal(lag.stalls5s, severe.length);
    NodeAssert.equal(lag.latestRssMb, 3600);
    NodeAssert.equal(lag.secondsSinceLastRow, 0);
    NodeAssert.deepEqual(healthVerdict(lag, ok, ok), { verdict, exitCode: code });
    if (severe.length) NodeAssert.equal(lag.worstMs, Math.max(...severe.map((row) => row[1])));
  });
for (const [name, tail] of [
  ["current gap", fixture([], { skip: [18, 19, 20] })],
  ["internal gap", fixture([], { skip: [8, 9] })],
  [
    "no recent rows",
    {
      text:
        JSON.stringify({
          time: new Date(now - 900_000).toISOString(),
          delayMaxMs: 6000,
          rssMb: 2000,
        }) + "\n",
      bytesRead: 100,
    },
  ],
  ["empty", { text: "", bytesRead: 0 }],
  ["missing", { text: "", bytesRead: 0, error: "ENOENT" }],
  ["malformed", { ...fixture(), text: fixture().text + "bad-json\n" }],
])
  NodeTest.test(`unknown coverage: ${name}`, () => {
    const lag = summarizeLag(tail, now);
    NodeAssert.equal(lag.status, "unknown");
    NodeAssert.deepEqual(healthVerdict(lag, ok, ok), { verdict: "unknown", exitCode: 1 });
  });
NodeTest.test("threshold and exit-code matrix", () => {
  const lag = summarizeLag(
    fixture([
      [1, 999],
      [2, 1000],
      [3, 4999],
    ]),
    now,
  );
  NodeAssert.equal(lag.stalls1s, 2);
  NodeAssert.equal(lag.stalls5s, 0);
  for (const [ms, verdict, exitCode] of [
    [1999, "healthy", 0],
    [2000, "degraded", 1],
    [9999, "degraded", 1],
  ]) {
    NodeAssert.deepEqual(healthVerdict(lag, ok, { status: "ok", ms }), { verdict, exitCode });
  }
  NodeAssert.deepEqual(healthVerdict(lag, ok, { status: "timeout" }), {
    verdict: "stalled",
    exitCode: 2,
  });
  NodeAssert.equal(healthVerdict(lag, { status: "error" }, ok).verdict, "unknown");
  NodeAssert.equal(healthVerdict(lag, { ...ok, readiness: "degraded" }, ok).verdict, "degraded");
  NodeAssert.equal(summarizeLag(fixture([], { skip: [19] }), now).status, "complete");
});
NodeTest.test("50 MB log reads at most 2 MB by seeking, skips partial records", async () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "deep-tail-"));
  try {
    const file = NodePath.join(dir, "lag");
    const fd = NodeFS.openSync(file, "w");
    NodeFS.ftruncateSync(fd, 50 * 1024 * 1024);
    NodeFS.writeSync(
      fd,
      "\n" + fixture().text,
      50 * 1024 * 1024 - Buffer.byteLength("\n" + fixture().text),
    );
    NodeFS.closeSync(fd);
    let bytes = 0;
    let firstPosition;
    const tail = await readLagTail(file, {
      async open(...args) {
        const handle = await NodeFS.promises.open(...args);
        return {
          stat: () => handle.stat(),
          close: () => handle.close(),
          async read(...readArgs) {
            firstPosition ??= readArgs[3];
            const result = await handle.read(...readArgs);
            bytes += result.bytesRead;
            return result;
          },
        };
      },
    });
    NodeAssert.equal(bytes, TAIL_BYTES);
    NodeAssert.equal(tail.bytesRead, bytes);
    NodeAssert.equal(firstPosition, 50 * 1024 * 1024 - TAIL_BYTES);
    NodeAssert.equal(summarizeLag(tail, now).status, "complete");
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});
NodeTest.test("rotation preserves the 10-minute window; partial append ignored", async () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "deep-rotate-"));
  try {
    const file = NodePath.join(dir, "lag");
    const rows = fixture([[2, 6000]]).text.split("\n");
    NodeFS.writeFileSync(file + ".1", rows.slice(0, 10).join("\n") + "\n");
    NodeFS.writeFileSync(file, rows.slice(10).join("\n") + '{"time":');
    const lag = summarizeLag(await readLagTail(file), now);
    NodeAssert.equal(lag.status, "complete");
    NodeAssert.equal(lag.stalls5s, 1);
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});
NodeTest.test("heap diagnostics do not masquerade as sampler heartbeats", () => {
  const lag = summarizeLag(
    {
      text: JSON.stringify({ at: new Date(now).toISOString(), kind: "heap-spaces", rssMb: 3000 }),
      bytesRead: 100,
    },
    now,
  );
  NodeAssert.equal(lag.status, "unknown");
  NodeAssert.equal(lag.latestRssMb, 3000);
});
NodeTest.test(
  "a real authenticated state read and CLI JSON preserve nonhealthy exit codes",
  async () => {
    const requests = [];
    const server = NodeHttp.createServer((req, res) => {
      requests.push(req.url);
      NodeAssert.equal(req.headers.authorization, "Bearer fixture-token");
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          req.url.endsWith("/health") ? { ok: true, status: "healthy" } : { threads: [] },
        ),
      );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${server.address().port}`;
      const report = await deepHealth({
        client: new ControlClient({ url, token: "fixture-token" }),
        readTail: () => fixture(),
      });
      NodeAssert.equal(report.roundTrip.status, "ok");
      NodeAssert.equal(requests[0], "/api/ardud/control/health");
      NodeAssert.match(requests[1], /^\/api\/ardud\/control\/threads\?limit=1&updatedSince=\d+$/);
      const child = NodeChildProcess.spawn(
        process.execPath,
        [new URL("./t3ctl.mjs", import.meta.url).pathname, "health", "--deep", "--json"],
        {
          env: {
            ...process.env,
            T3_CONTROL_URL: url,
            T3_CONTROL_TOKEN: "fixture-token",
            T3CODE_HOME: "/does-not-exist",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let out = "";
      child.stdout.on("data", (data) => (out += data));
      const code = await new Promise((resolve) => child.on("close", resolve));
      NodeAssert.equal(code, 1);
      NodeAssert.equal(JSON.parse(out).verdict, "unknown");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
NodeTest.test("unresolved state read times out even when liveness replies", async () => {
  const controllerSignals = [];
  const report = await deepHealth({
    timeoutMs: 20,
    readTail: () => fixture(),
    client: {
      request(_method, route, _body, options) {
        controllerSignals.push(options.signal);
        return route === "/health" ? Promise.resolve({ ok: true }) : new Promise(() => {});
      },
    },
  });
  NodeAssert.equal(report.verdict, "stalled");
  NodeAssert.equal(report.exitCode, 2);
  NodeAssert.equal(report.roundTrip.status, "timeout");
  NodeAssert.equal(controllerSignals[0].aborted, true);
});

for (const delay of [null, "6000", {}, -1])
  NodeTest.test(`invalid sample delay ${JSON.stringify(delay)} stays unknown`, () => {
    const tail = fixture();
    tail.text +=
      JSON.stringify({ time: new Date(now).toISOString(), kind: "sample", delayMaxMs: delay }) +
      "\n";
    NodeAssert.equal(summarizeLag(tail, now).status, "unknown");
  });

NodeTest.test("remote target never borrows the local server's healthy log", async () => {
  const report = await deepHealth({
    client: {
      url: "https://remote.example",
      request: async (_method, route) => (route === "/health" ? { ok: true } : { threads: [] }),
    },
    readTail() {
      throw new Error("must not read local lag");
    },
  });
  NodeAssert.equal(report.verdict, "unknown");
  NodeAssert.equal(report.lag.bytesRead, 0);
});

NodeTest.test("a long sampler gap straddling the window boundary stays unknown", () => {
  const tail = fixture([], { skip: [0, 1] });
  tail.text +=
    JSON.stringify({ time: new Date(now - 630_000).toISOString(), kind: "sample" }) + "\n";
  // Last pre-window sample at -10m30; first in-window at -9m: 90s gap.
  NodeAssert.equal(summarizeLag(tail, now).status, "unknown");
});

NodeTest.test("rotation never counts the same inode twice", async () => {
  const records = fixture([
    [4, 6000],
    [8, 6000],
  ]).text;
  const buffer = Buffer.from(records);
  let reads = 0;
  const io = {
    open: async () => ({
      close: async () => {},
      stat: async () => ({ dev: 1, ino: 55, size: buffer.length, isFile: () => true }),
      async read(target, offset, length, position) {
        reads++;
        return { bytesRead: buffer.copy(target, offset, position, position + length) };
      },
    }),
  };
  const lag = summarizeLag(await readLagTail("rotating", io), now);
  NodeAssert.equal(reads, 1);
  NodeAssert.equal(lag.stalls5s, 2);
  NodeAssert.equal(lag.status, "unknown");
  NodeAssert.equal(healthVerdict(lag, ok, ok).verdict, "unknown");
});
for (const [name, url, runtime, startedAt, expected] of [
  [
    "matching listener",
    "http://127.0.0.1:3773",
    { origin: "http://127.0.0.1:3773" },
    now,
    "healthy",
  ],
  ["localhost alias", "http://localhost:3773", { origin: "http://127.0.0.1:3773" }, now, "healthy"],
  ["IPv6 alias", "http://[::1]:3773", { origin: "http://127.0.0.1:3773" }, now, "healthy"],
  [
    "other loopback port",
    "http://127.0.0.1:9000",
    { origin: "http://127.0.0.1:3773" },
    now,
    "unknown",
  ],
  [
    "proxy prefix",
    "http://127.0.0.1:3773/proxy",
    { origin: "http://127.0.0.1:3773" },
    now,
    "unknown",
  ],
  ["remote", "https://server.example", { origin: "http://127.0.0.1:3773" }, now, "unknown"],
  [
    "different boot",
    "http://127.0.0.1:3773",
    { origin: "http://127.0.0.1:3773" },
    now - 120_000,
    "unknown",
  ],
  ["missing runtime", "http://127.0.0.1:3773", null, now, "unknown"],
])
  NodeTest.test(`local log identity: ${name}`, async () => {
    const current = Date.now();
    const text = fixture().text;
    const tail = {
      text: text
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const row = JSON.parse(line);
          row.time = new Date(Date.parse(row.time) + current - now).toISOString();
          return JSON.stringify(row);
        })
        .join("\n"),
      bytesRead: 2000,
    };
    const boot = new Date(startedAt).toISOString();
    const report = await deepHealth({
      client: {
        url,
        request: async (_method, route) =>
          route === "/health"
            ? {
                ok: true,
                status: "healthy",
                serverStartedAt: boot,
                bootId:
                  startedAt === now
                    ? "8d0efaf9-5dd4-400f-9db1-8308e5a591b0"
                    : "f2493692-950c-4f64-9025-73e929d67f42",
              }
            : { threads: [] },
      },
      readRuntime: () =>
        runtime && {
          ...runtime,
          startedAt: new Date(now).toISOString(),
          pid: process.pid,
          bootId: "8d0efaf9-5dd4-400f-9db1-8308e5a591b0",
        },
      readTail: () => tail,
    });
    NodeAssert.equal(report.verdict, expected);
  });

for (const [readiness, verdict] of [
  ["healthy", "healthy"],
  ["degraded", "degraded"],
  ["recovered-unverified", "unknown"],
  [undefined, "unknown"],
  ["unexpected", "unknown"],
  [null, "unknown"],
  [false, "unknown"],
])
  NodeTest.test(`readiness state: ${readiness}`, () => {
    const lag = summarizeLag(fixture(), now);
    NodeAssert.equal(healthVerdict(lag, { ...ok, readiness }, ok).verdict, verdict);
  });

for (const [name, output, owned] of [
  ["one owner", "p123\n", true],
  ["multiple sockets, same owner", "p123\np123\n", true],
  ["another owner", "p456\n", false],
  ["two owners on different address families", "p123\np456\n", false],
  ["empty output", "", false],
  ["non-PID output", "lsof: unavailable\n", false],
])
  NodeTest.test(`independent listener ownership: ${name}`, async () => {
    NodeAssert.equal(
      await ownsListener({ pid: 123, port: 3773 }, (command, args, options, callback) => {
        NodeAssert.equal(NodePath.basename(command), "lsof");
        NodeAssert.deepEqual(args, ["-nP", "-iTCP:3773", "-sTCP:LISTEN", "-Fp"]);
        NodeAssert.equal(options.killSignal, "SIGKILL");
        NodeAssert.equal(options.maxBuffer, 64 * 1024);
        callback(null, output);
      }),
      owned,
    );
  });
NodeTest.test("listener command failure never authorizes local evidence", async () => {
  for (const error of ["timeout", "not installed", "permission denied"]) {
    NodeAssert.equal(
      await ownsListener({ pid: 123, port: 3773 }, () => {
        throw new Error(error);
      }),
      false,
    );
  }
});
for (const target of [
  { pid: 0, port: 3773 },
  { pid: -1, port: 3773 },
  { pid: 123, port: 0 },
  { pid: 123, port: 65536 },
])
  NodeTest.test(`invalid listener identity ${JSON.stringify(target)}`, async () => {
    NodeAssert.equal(
      await ownsListener(target, () => {
        throw new Error("must not execute");
      }),
      false,
    );
  });

const localRuntime = {
  origin: "http://127.0.0.1:3773",
  pid: process.pid,
  bootId: "8d0efaf9-5dd4-400f-9db1-8308e5a591b0",
  startedAt: new Date(now).toISOString(),
};
const localClient = {
  url: localRuntime.origin,
  request: async (_method, route) =>
    route === "/health"
      ? {
          ok: true,
          status: "healthy",
          serverStartedAt: localRuntime.startedAt,
          bootId: localRuntime.bootId,
        }
      : { threads: [] },
};
for (const [name, runtimeBoot, responseBoot, readyDelayMs, listener, expected] of [
  ["long boot, same UUID", localRuntime.bootId, localRuntime.bootId, 534_000, false, true],
  [
    "same timestamps, different UUID",
    localRuntime.bootId,
    "f2493692-950c-4f64-9025-73e929d67f42",
    0,
    true,
    false,
  ],
  ["legacy long boot, listener owned", undefined, undefined, 534_000, true, true],
  ["legacy short boot, listener unverified", undefined, undefined, 0, false, false],
  ["new CLI, old runtime file", undefined, localRuntime.bootId, 115_000, true, true],
  ["new runtime file, old response", localRuntime.bootId, undefined, 115_000, true, true],
  ["invalid UUIDs cannot match", "fixture-secret", "fixture-secret", 0, false, false],
]) {
  NodeTest.test(`stable runtime identity: ${name}`, async () => {
    const current = Date.now();
    const rows = Array.from({ length: 21 }, (_, i) =>
      JSON.stringify({
        time: new Date(current - (20 - i) * 30_000 - 15_000).toISOString(),
        kind: "sample",
      }),
    );
    const report = await deepHealth({
      client: {
        ...localClient,
        request: async (_method, route) =>
          route === "/health"
            ? {
                ok: true,
                status: "healthy",
                bootId: responseBoot,
                serverStartedAt: localRuntime.startedAt,
              }
            : { threads: [] },
      },
      readRuntime: () => ({
        ...localRuntime,
        bootId: runtimeBoot,
        startedAt: new Date(now + readyDelayMs).toISOString(),
      }),
      checkListener: () => listener,
      readTail: () => ({ text: rows.join("\n") + "\n", bytesRead: 2000 }),
    });
    NodeAssert.equal(report.lag.status, expected ? "complete" : "unknown");
    NodeAssert.equal(report.lag.sampleCount, expected ? 20 : 0);
    NodeAssert.equal(report.verdict, expected ? "healthy" : "unknown");
    NodeAssert.doesNotMatch(JSON.stringify(report), /fixture-secret/);
    if (runtimeBoot === localRuntime.bootId && responseBoot !== undefined)
      NodeAssert.equal(report.stages.listener.status, "skipped");
  });
}
NodeTest.test("both probes ignore abort: one shared budget still returns a report", async () => {
  const start = performance.now();
  const report = await deepHealth({
    timeoutMs: 25,
    client: { ...localClient, request: () => new Promise(() => {}) },
    readRuntime: () => null,
  });
  NodeAssert.ok(performance.now() - start < 250);
  NodeAssert.equal(report.connection.status, "timeout");
  NodeAssert.equal(report.roundTrip.status, "timeout");
  NodeAssert.equal(report.stages.connection.status, "timeout");
  NodeAssert.equal(report.stages.roundTrip.status, "timeout");
  NodeAssert.ok(["ok", "error", "skipped"].includes(report.stages.runtime.status));
  NodeAssert.match(report.summary, /timeout/);
});
for (const connected of [false, true])
  NodeTest.test(
    `listener ignoring abort stays bounded (HTTP connected: ${connected})`,
    { timeout: 500 },
    async () => {
      const report = await deepHealth({
        timeoutMs: 25,
        client: {
          ...localClient,
          request: (_method, route) =>
            route === "/health"
              ? connected
                ? Promise.resolve({ ok: true, status: "healthy" })
                : Promise.reject(new Error("unavailable"))
              : Promise.resolve({ threads: [] }),
        },
        readRuntime: () => localRuntime,
        checkListener: () => new Promise(() => {}),
        readTail: () => {
          throw new Error("must not read unverified lag");
        },
      });
      NodeAssert.equal(report.stages.listener.status, "timeout");
      NodeAssert.equal(report.lag.bytesRead, 0);
      NodeAssert.match(report.summary, /unverified/);
      NodeAssert.equal(report.status, "timeout");
      NodeAssert.equal(report.stage, "listener");
    },
  );
for (const stage of ["runtime", "lagTail"]) {
  for (const failure of ["throw", "reject", "hang"]) {
    NodeTest.test(
      `${stage} ${failure}: local I/O still returns a safe report`,
      { timeout: 500 },
      async () => {
        const fail = () => {
          const error = new Error("secret server body Bearer fixture-secret");
          if (failure === "throw") throw error;
          return failure === "reject" ? Promise.reject(error) : new Promise(() => {});
        };
        const report = await deepHealth({
          timeoutMs: 25,
          client: localClient,
          readRuntime: stage === "runtime" ? fail : () => localRuntime,
          readTail: stage === "lagTail" ? fail : () => fixture(),
        });
        NodeAssert.equal(report.stages[stage].status, failure === "hang" ? "timeout" : "error");
        NodeAssert.equal(report.lag.status, "unknown");
        NodeAssert.equal(report.lag.bytesRead, 0);
        NodeAssert.doesNotMatch(JSON.stringify(report), /fixture-secret|secret server body/);
      },
    );
  }
}

NodeTest.test("a listener child that never closes is SIGKILLed and detached", async () => {
  const signals = [];
  let detached = false;
  let destroyed = 0;
  await NodeAssert.rejects(
    ownsListener({ pid: 123, port: 3773, timeoutMs: 10 }, () => ({
      kill: (signal) => signals.push(signal),
      unref: () => {
        detached = true;
      },
      stdout: {
        destroy: () => {
          destroyed++;
        },
      },
      stderr: {
        destroy: () => {
          destroyed++;
        },
      },
    })),
    { name: "TimeoutError" },
  );
  NodeAssert.deepEqual(signals, ["SIGKILL"]);
  NodeAssert.equal(detached, true);
  NodeAssert.equal(destroyed, 2);
});

NodeTest.test(
  "invalid readiness metadata never echoes response bodies or credentials",
  async () => {
    const report = await deepHealth({
      client: {
        ...localClient,
        request: async (_method, route) =>
          route === "/health"
            ? { ok: true, status: "Bearer fixture-secret", serverStartedAt: "fixture-secret" }
            : { threads: [] },
      },
      readRuntime: () => localRuntime,
      checkListener: () => false,
    });
    NodeAssert.equal(report.verdict, "unknown");
    NodeAssert.doesNotMatch(JSON.stringify(report), /fixture-secret/);
  },
);
