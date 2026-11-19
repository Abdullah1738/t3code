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
  readRuntimeState,
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
    await NodeAssert.rejects(
      ownsListener({ pid: 123, port: 3773 }, () => {
        throw new Error(error);
      }),
      { message: error },
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

const socketFailure = () =>
  Object.assign(new Error("fixture-private-token"), {
    code: "EADDRNOTAVAIL",
    syscall: "connect",
    path: "/private/fixture-private-token/socket",
  });
const socketFields = { code: "EADDRNOTAVAIL", syscall: "connect", path: "socket" };
for (const [name, makeError, expected] of [
  ["direct", socketFailure, socketFields],
  [
    "fetch cause",
    () => new TypeError("fixture-private-token", { cause: socketFailure() }),
    socketFields,
  ],
  [
    "nested cause",
    () =>
      new Error("fixture-private-token", {
        cause: new TypeError("fetch failed", { cause: socketFailure() }),
      }),
    socketFields,
  ],
  [
    "outer precedence",
    () =>
      Object.assign(socketFailure(), {
        code: "EIO",
        syscall: "read",
        path: "/private/outer",
        cause: socketFailure(),
      }),
    { code: "EIO", syscall: "read", path: "outer" },
  ],
  [
    "unsafe wrapper fields",
    () =>
      Object.assign(new Error("fixture-private-token", { cause: socketFailure() }), {
        code: "fixture-private-token",
        syscall: "fixture-private-token",
        path: "https://secret.test/?token=fixture-private-token",
      }),
    socketFields,
  ],
  [
    "cyclic cause",
    () => {
      const error = new Error("fixture-private-token");
      error.cause = error;
      return error;
    },
    {},
  ],
  [
    "depth limit",
    () => {
      let error = socketFailure();
      for (let depth = 0; depth < 4; depth++)
        error = new Error("fixture-private-token", { cause: error });
      return error;
    },
    {},
  ],
  [
    "primitive cause",
    () => new Error("fixture-private-token", { cause: "fixture-private-token" }),
    {},
  ],
  ["null cause", () => new Error("fixture-private-token", { cause: null }), {}],
])
  NodeTest.test(`stage error cause corpus: ${name}`, async () => {
    const report = await deepHealth({
      client: {
        ...localClient,
        request: async () => {
          throw makeError();
        },
      },
      readRuntime: async () => {
        throw makeError();
      },
    });
    for (const stage of ["connection", "roundTrip", "runtime"])
      NodeAssert.deepEqual(report.stages[stage], {
        status: "error",
        ms: report.stages[stage].ms,
        ...expected,
      });
    NodeAssert.equal(report.localIdentity.code, expected.code ?? null);
    NodeAssert.doesNotMatch(
      JSON.stringify(report),
      /fixture-private-token|\/private\/|secret\.test/,
    );
  });

for (const exhaustedAt of ["connection", "runtime", "listener"])
  NodeTest.test(`deadline skips local identity work before ${exhaustedAt}`, async () => {
    const descriptor = Object.getOwnPropertyDescriptor(performance, "now");
    let time = 0;
    Object.defineProperty(performance, "now", { configurable: true, value: () => time });
    try {
      const report = await deepHealth({
        timeoutMs: 25,
        client: {
          ...localClient,
          request: async (...args) => {
            if (exhaustedAt === "runtime") time = 25;
            return localClient.request(...args);
          },
        },
        onStage: (stage) => {
          if (stage === exhaustedAt && stage === "connection") time = 25;
        },
        readRuntime: () => {
          NodeAssert.equal(
            exhaustedAt,
            "listener",
            "runtime must stay unread when budget exhausted",
          );
          time = 25;
          return { ...localRuntime, bootId: undefined };
        },
        checkListener: () => NodeAssert.fail("must not check listener after budget exhausted"),
        readTail: () => NodeAssert.fail("must not read lag after budget exhausted"),
      });
      const stage = exhaustedAt === "listener" ? "listener" : "runtime";
      NodeAssert.deepEqual(report.localIdentity, {
        ok: false,
        reason: "deadline-exhausted",
        stage,
        code: null,
      });
      NodeAssert.equal(report.stages[stage].status, "skipped");
      NodeAssert.match(report.summary, /deadline-exhausted/);
      NodeAssert.doesNotMatch(report.summary, /runtime-unreadable|listener-error/);
    } finally {
      if (descriptor) Object.defineProperty(performance, "now", descriptor);
      else delete performance.now;
    }
  });

for (const code of ["EPERM", "EACCES", "ENOENT", "ETIMEDOUT"])
  NodeTest.test(`runtime read failure preserves ${code} without sensitive details`, async () => {
    const token = "fixture-private-token";
    const path = `/private/${token}/server-runtime.json`;
    const report = await deepHealth({
      client: localClient,
      readRuntime: async () => {
        throw Object.assign(new Error(`${code}: ${path}?token=${token}`), {
          code,
          syscall: "open",
          path,
          token,
        });
      },
      readTail: () => NodeAssert.fail("must not read unverified lag"),
    });
    NodeAssert.deepEqual(report.localIdentity, {
      ok: false,
      reason: "runtime-unreadable",
      stage: "runtime",
      code,
    });
    NodeAssert.deepEqual(report.stages.runtime, {
      status: "error",
      ms: report.stages.runtime.ms,
      code,
      syscall: "open",
      path: "server-runtime.json",
    });
    NodeAssert.match(report.summary, new RegExp(`runtime-unreadable ${code}`));
    NodeAssert.match(report.summary, /at runtime/);
    NodeAssert.doesNotMatch(JSON.stringify(report), /fixture-private-token|\/private\//);
    NodeAssert.equal(report.stages.listener.status, "skipped");
    NodeAssert.equal(report.stages.lagTail.status, "skipped");
  });

NodeTest.test("runtime read timeout retains its stage and reason", async () => {
  const report = await deepHealth({
    timeoutMs: 25,
    client: localClient,
    readRuntime: () => new Promise(() => {}),
  });
  NodeAssert.deepEqual(report.localIdentity, {
    ok: false,
    reason: "runtime-timeout",
    stage: "runtime",
    code: "ETIMEDOUT",
  });
  NodeAssert.equal(report.stages.runtime.status, "timeout");
  NodeAssert.equal(report.stage, "runtime");
  NodeAssert.equal(report.exitCode, 2);
  NodeAssert.match(report.summary, /runtime-timeout ETIMEDOUT.*at runtime/);
});

for (const [name, runtime, url, reason, code] of [
  ["missing", null, localClient.url, "runtime-invalid", null],
  ["scalar", "fixture-private-token", localClient.url, "runtime-invalid", null],
  ["invalid origin", { origin: "fixture-private-token" }, localClient.url, "runtime-invalid", null],
  ["invalid pid", { pid: 0 }, localClient.url, "runtime-invalid", null],
  ["dead pid", { pid: 2147483647 }, localClient.url, "pid-mismatch", "ESRCH"],
  [
    "invalid date",
    { startedAt: "fixture-private-token" },
    localClient.url,
    "runtime-invalid",
    null,
  ],
  ["object date", { startedAt: { toString: null } }, localClient.url, "runtime-invalid", null],
  ["invalid boot", { bootId: "fixture-private-token" }, localClient.url, "runtime-invalid", null],
  [
    "different boot",
    { bootId: "f2493692-950c-4f64-9025-73e929d67f42" },
    localClient.url,
    "bootid-mismatch",
    null,
  ],
  ["remote target", {}, "https://remote.example?token=fixture-private-token", "non-loopback", null],
  [
    "remote runtime",
    { origin: "http://remote.example:3773" },
    localClient.url,
    "non-loopback",
    null,
  ],
  ["other port", {}, "http://127.0.0.1:9000", "origin-mismatch", null],
  ["proxy", {}, `${localClient.url}/proxy`, "origin-mismatch", null],
  ["protocol", {}, "https://127.0.0.1:3773", "origin-mismatch", null],
  ["query", {}, `${localClient.url}?token=fixture-private-token`, "origin-mismatch", null],
])
  NodeTest.test(`local identity reason: ${name}`, async () => {
    const report = await deepHealth({
      client: { ...localClient, url },
      readRuntime: () =>
        runtime && typeof runtime === "object" ? { ...localRuntime, ...runtime } : runtime,
      checkListener: () => NodeAssert.fail("identity must reject before checking listener"),
      readTail: () => NodeAssert.fail("must not read unverified lag"),
    });
    NodeAssert.deepEqual(report.localIdentity, { ok: false, reason, stage: "runtime", code });
    NodeAssert.ok(report.summary.includes(reason));
    NodeAssert.match(report.summary, /at runtime/);
    NodeAssert.doesNotMatch(JSON.stringify(report), /fixture-private-token|remote\.example/);
  });

NodeTest.test("malformed runtime JSON is invalid rather than unreadable", async () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "deep-invalid-runtime-"));
  try {
    NodeFS.writeFileSync(
      NodePath.join(dir, "server-runtime.json"),
      '{"token":"fixture-private-token"',
    );
    const report = await deepHealth({
      client: localClient,
      logPath: NodePath.join(dir, "logs", "lag.ndjson"),
    });
    NodeAssert.equal(await readRuntimeState(NodePath.join(dir, "server-runtime.json")), null);
    NodeAssert.equal(report.stages.runtime.status, "ok");
    NodeAssert.equal(report.localIdentity.reason, "runtime-invalid");
    NodeAssert.doesNotMatch(JSON.stringify(report), /fixture-private-token|deep-invalid-runtime-/);
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

for (const [name, checkListener, reason, status, code] of [
  ["another owner", () => false, "listener-not-owner", "ok", null],
  [
    "permission error",
    () =>
      ownsListener({ pid: process.pid, port: 3773 }, (_command, _args, _options, callback) => {
        callback(
          Object.assign(new Error("fixture-private-token /private/fixture/lsof"), {
            code: "EACCES",
            syscall: "spawn /private/fixture/lsof",
            path: "/private/fixture/lsof",
          }),
        );
      }),
    "listener-error",
    "error",
    "EACCES",
  ],
  ["timeout", () => new Promise(() => {}), "listener-timeout", "timeout", "ETIMEDOUT"],
])
  NodeTest.test(`listener failure reason: ${name}`, async () => {
    const report = await deepHealth({
      timeoutMs: 25,
      client: localClient,
      readRuntime: () => ({ ...localRuntime, bootId: undefined }),
      checkListener,
      readTail: () => NodeAssert.fail("must not read unverified lag"),
    });
    NodeAssert.deepEqual(report.localIdentity, { ok: false, reason, stage: "listener", code });
    NodeAssert.equal(report.stages.listener.status, status);
    NodeAssert.ok(report.summary.includes(`${reason}${code ? ` ${code}` : ""}`));
    NodeAssert.match(report.summary, /at listener/);
    NodeAssert.doesNotMatch(JSON.stringify(report), /fixture-private-token|\/private\//);
    if (code === "EACCES") {
      NodeAssert.equal(report.stages.listener.syscall, "spawn");
      NodeAssert.equal(report.stages.listener.path, "lsof");
    }
  });

for (const [name, fields, expected] of [
  ["child exit code", { code: 1 }, { code: 1 }],
  ["URL", { path: "https://example.test/runtime?token=fixture-private-token" }, {}],
  [
    "query on path",
    { path: "/private/runtime.json?token=fixture-private-token" },
    { path: "runtime.json" },
  ],
  [
    "Windows path",
    { path: "C:\\private\\fixture-private-token\\runtime.json" },
    { path: "runtime.json" },
  ],
  [
    "arbitrary error fields",
    {
      code: "fixture-private-token",
      syscall: "fixture-private-token",
      path: "/private/runtime\nfixture-private-token",
    },
    {},
  ],
])
  NodeTest.test(`stage error redaction: ${name}`, async () => {
    const report = await deepHealth({
      client: localClient,
      readRuntime: () => {
        throw Object.assign(new Error("fixture-private-token"), fields);
      },
    });
    NodeAssert.deepEqual(report.stages.runtime, {
      status: "error",
      ms: report.stages.runtime.ms,
      ...expected,
    });
    NodeAssert.doesNotMatch(
      JSON.stringify(report),
      /fixture-private-token|\/private\/|example\.test/,
    );
  });

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
    NodeAssert.equal(report.localIdentity.ok, expected);
    if (expected) {
      NodeAssert.equal(report.localIdentity.reason, null);
      NodeAssert.equal(report.localIdentity.code, null);
    }
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

NodeTest.test("watchdog summary names ongoing and recent blockers with frames", async () => {
  const { summarizeMainThread, healthLine } = await import("./deep-health.mjs");
  const blocked = {
    kind: "blocked",
    pid: 12,
    bootId: localRuntime.bootId,
    reportIntervalMs: 30_000,
    episode: "12:1",
    at: new Date(now - 30_000).toISOString(),
    blockedForMs: 10_000,
    inFlight: [{ tool: "board_activity", boardId: "board-test" }],
    frames: [{ functionName: "testBlockingLoop", url: "watchdog.ts", lineNumber: 42 }],
  };
  const tail = (rows) => ({ text: rows.map((row) => JSON.stringify(row)).join("\n") + "\n" });
  const summarize = (rows, at = now, pid = 12, bootId = localRuntime.bootId) =>
    summarizeMainThread(tail(rows), at, pid, bootId);
  const mainThread = summarize([blocked]);
  NodeAssert.equal(mainThread.ongoing, true);
  NodeAssert.match(
    mainThread.summary,
    /main thread blocked 40s by board_activity\(board-test\).*testBlockingLoop.*watchdog.ts:42/,
  );
  NodeAssert.match(
    healthLine({
      verdict: "stalled",
      lag: summarizeLag(fixture(), now),
      connection: ok,
      roundTrip: ok,
      mainThread,
    }),
    /main thread blocked 40s/,
  );
  const ended = {
    ...blocked,
    kind: "unblocked",
    at: new Date(now - 1000).toISOString(),
    blockedForMs: 39_000,
  };
  // Rotation reader returns newest file first, so chronology must not depend on file order.
  NodeAssert.equal(summarize([ended, blocked]).ongoing, false);
  NodeAssert.equal(summarize([ended], now + 900_001), null);
  NodeAssert.equal(summarize([blocked], now, 13), null);
  NodeAssert.equal(
    summarizeMainThread({ text: '{"secret":"' }, now, 12, localRuntime.bootId),
    null,
  );
});

for (const [name, ageMs, kind, rowBootId, runtimeBootId, interval, expected] of [
  ["fresh blocked", 30_000, "blocked", localRuntime.bootId, localRuntime.bootId, 30_000, true],
  ["freshness boundary", 62_000, "blocked", localRuntime.bootId, localRuntime.bootId, 30_000, true],
  ["missing recovery", 62_001, "blocked", localRuntime.bootId, localRuntime.bootId, 30_000, false],
  [
    "custom repeat interval",
    90_000,
    "blocked",
    localRuntime.bootId,
    localRuntime.bootId,
    60_000,
    true,
  ],
  ["recent recovery", 30_000, "unblocked", localRuntime.bootId, localRuntime.bootId, 30_000, false],
  [
    "expired recovery",
    900_001,
    "unblocked",
    localRuntime.bootId,
    localRuntime.bootId,
    30_000,
    null,
  ],
  [
    "expired unfinished episode",
    900_001,
    "blocked",
    localRuntime.bootId,
    localRuntime.bootId,
    30_000,
    null,
  ],
  [
    "reused PID",
    1000,
    "blocked",
    "f2493692-950c-4f64-9025-73e929d67f42",
    localRuntime.bootId,
    30_000,
    null,
  ],
  ["missing record boot", 1000, "blocked", undefined, localRuntime.bootId, 30_000, null],
  ["missing runtime boot", 1000, "blocked", localRuntime.bootId, undefined, 30_000, null],
])
  NodeTest.test(`watchdog evidence eligibility: ${name}`, async () => {
    const { summarizeMainThread } = await import("./deep-health.mjs");
    const summary = summarizeMainThread(
      {
        text: JSON.stringify({
          kind,
          pid: 12,
          bootId: rowBootId,
          reportIntervalMs: interval,
          episode: "fixture",
          at: new Date(now - ageMs).toISOString(),
          blockedForMs: 10_000,
        }),
      },
      now,
      12,
      runtimeBootId,
    );
    NodeAssert.equal(summary?.ongoing ?? null, expected);
    if (name === "missing recovery") {
      NodeAssert.equal(summary.durationMs, 10_000);
      NodeAssert.match(summary.summary, /recovery unconfirmed/);
    }
  });

NodeTest.test("stale unfinished watchdog evidence cannot override successful probes", async () => {
  const current = Date.now();
  const lagText = fixture()
    .text.split("\n")
    .filter(Boolean)
    .map((line) => {
      const row = JSON.parse(line);
      return JSON.stringify({
        ...row,
        time: new Date(Date.parse(row.time) + current - now).toISOString(),
      });
    })
    .join("\n");
  const report = await deepHealth({
    client: localClient,
    readRuntime: () => localRuntime,
    readTail: (file) => ({
      text: file.endsWith("main-thread-blocked.ndjson")
        ? JSON.stringify({
            kind: "blocked",
            pid: process.pid,
            bootId: localRuntime.bootId,
            reportIntervalMs: 30_000,
            episode: "fixture",
            at: new Date(current - 90_000).toISOString(),
            blockedForMs: 10_000,
            inFlight: [{ tool: "board_activity" }],
          })
        : lagText,
      bytesRead: 2000,
    }),
  });
  NodeAssert.equal(report.mainThread.recoveryUnconfirmed, true);
  NodeAssert.equal(report.verdict, "healthy");
});

NodeTest.test("deep health reads the independent watchdog log while HTTP resets", async () => {
  const report = await deepHealth({
    client: {
      url: localClient.url,
      request: async () => {
        throw Object.assign(new Error("private body"), { code: "ECONNRESET" });
      },
    },
    readRuntime: () => localRuntime,
    checkListener: async () => true,
    readTail: (file) =>
      file.endsWith("main-thread-blocked.ndjson")
        ? {
            text:
              JSON.stringify({
                kind: "blocked",
                pid: process.pid,
                bootId: localRuntime.bootId,
                reportIntervalMs: 30_000,
                episode: "fixture:1",
                at: new Date(Date.now() - 1000).toISOString(),
                blockedForMs: 6000,
                inFlight: [{ tool: "board_activity", boardId: "board-crpko" }],
                frames: [{ functionName: "queued", url: "activity.ts", lineNumber: 19 }],
              }) + "\n",
            bytesRead: 100,
          }
        : fixture(),
  });
  NodeAssert.equal(report.localIdentity.ok, true);
  NodeAssert.equal(report.mainThread.ongoing, true);
  NodeAssert.equal(report.verdict, "stalled");
  NodeAssert.match(
    report.summary,
    /main thread blocked 7s by board_activity\(board-crpko\).*queued/,
  );
  NodeAssert.doesNotMatch(report.summary, /private body/);
});
