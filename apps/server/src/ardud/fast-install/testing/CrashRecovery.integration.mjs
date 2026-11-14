// Run offbox: node apps/server/src/ardud/fast-install/testing/CrashRecovery.integration.mjs <output-dir>
// The inspector is bound to loopback on a synthetic subprocess only.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeNet from "node:net";
import * as NodeAssert from "node:assert/strict";
import { addRecoveryHistory } from "./RecoveryShape.fixture.mjs";
const root = process.cwd();
const fixtures = NodePath.join(root, "apps/server/src/ardud/fast-install/testing");
const output = NodePath.resolve(process.argv[2] ?? "tmp/l5-crash");
NodeFS.mkdirSync(output, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Synthetic workspaces may live below this checkout. Keep checkpoint discovery
// from treating the enclosing repository as their workspace (150 concurrent
// baselines otherwise scan the whole checkout instead of measuring recovery).
const serverEnv = (home) => ({
  ...process.env,
  GIT_CEILING_DIRECTORIES: NodePath.dirname(home),
});
const sanitizeLog = (text) =>
  text.replace(/Connection string:[\s\S]*?(?=\n\[\d\d:|$)/g, "[synthetic pairing details omitted]");
async function until(f, label, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const r = await f();
    if (r) return r;
    await sleep(25);
  }
  throw Error("Timed out: " + label);
}
async function command(args, log) {
  const fd = NodeFS.openSync(log, "w");
  const child = NodeChildProcess.spawn(process.execPath, args, { cwd: root, stdio: ["ignore", fd, fd] });
  NodeFS.closeSync(fd);
  const [code, signal] = await NodeEvents.once(child, "exit");
  NodeAssert.equal(code, 0, `${args[0]} exited ${code}/${signal}: ${log}`);
}
async function inspector(url) {
  const ws = new WebSocket(url);
  await NodeEvents.once(ws, "open");
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.method) events.push(m);
    if (m.id) {
      pending.get(m.id)?.(m);
      pending.delete(m.id);
    }
  });
  const request = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      const timer = setTimeout(() => {
        pending.delete(n);
        reject(Error("Inspector timeout: " + method));
      }, 10000);
      pending.set(n, (m) => {
        clearTimeout(timer);
        m.error ? reject(Error(JSON.stringify(m.error))) : resolve(m.result);
      });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  return { request, events, close: () => ws.close() };
}
async function port() {
  const server = NodeNet.createServer();
  server.listen(0, "127.0.0.1");
  await NodeEvents.once(server, "listening");
  const value = server.address().port;
  await new Promise((r) => server.close(r));
  return value;
}
async function verifyStubExit(home) {
  const file = NodePath.join(home, "processes.ndjson");
  if (!NodeFS.existsSync(file)) return;
  const owned = NodeFS.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  await until(
    () =>
      owned.every((record) => {
        try {
          const stat = NodeFS.readFileSync(`/proc/${record.pid}/stat`, "utf8");
          const fields = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
          return (
            fields[0] === "Z" ||
            fields[19] !== record.startTime ||
            NodeFS.readlinkSync(`/proc/${record.pid}/exe`) !== record.executable
          );
        } catch {
          return true;
        }
      }),
    "sandbox provider subprocesses exited",
    5000,
  );
}
const rows = [];
for (const [count, active] of [
  [38, 35],
  [150, 150],
]) {
  const home = NodeFS.mkdtempSync(NodePath.join(output, `shape-${count}-`));
  NodeFS.writeFileSync(NodePath.join(home, ".crash-sandbox"), "seed=1\n");
  await command(
    [NodePath.join(fixtures, "CrashSeed.fixture.mjs"), home, String(count), String(active)],
    NodePath.join(home, "seed.log"),
  );
  if (process.env.T3CODE_RECOVERY_SHAPE)
    addRecoveryHistory(home, Number(process.env.T3CODE_RECOVERY_SHAPE));
  const listenPort = await port();
  const start = Date.now();
  let stdout = "",
    stderr = "";
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      "--import",
      NodePath.join(fixtures, "InstallProbe.fixture.mjs"),
      "--inspect=127.0.0.1:0",
      NodePath.join(root, "apps/server/src/bin.ts"),
      "serve",
      "--base-dir",
      home,
      "--host",
      "127.0.0.1",
      "--port",
      String(listenPort),
    ],
    { cwd: root, env: serverEnv(home), stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", (b) => {
    stdout += b;
  });
  child.stderr.on("data", (b) => {
    stderr += b;
  });
  const exit = NodeEvents.once(child, "exit");
  let debug;
  try {
    const url = await until(
      () => stderr.match(/ws:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]+/)?.[0],
      "inspector",
    );
    debug = await inspector(url);
    const report = async () => {
      const r = await debug.request("Runtime.evaluate", {
        expression: "globalThis.__l5InstallReport()",
        awaitPromise: true,
        returnByValue: true,
      });
      if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
      return r.result.value;
    };
    let readReady = null;
    await until(async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${listenPort}/.well-known/t3/environment`, {
          signal: AbortSignal.timeout(200),
        });
        if (
          r.status === 200 &&
          (await r.json()).environmentId ===
            NodeFS.readFileSync(NodePath.join(home, "userdata/environment-id"), "utf8").trim()
        ) {
          readReady = Date.now();
          return true;
        }
      } catch {}
    }, "read-ready");
    const settled = await until(async () => {
      const r = await report();
      return r.completedAt ? r : null;
    }, "reconciliation");
    const requests = () => {
      try {
        return NodeFS
          .readFileSync(NodePath.join(home, "provider-requests.ndjson"), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(JSON.parse);
      } catch {
        return [];
      }
    };
    const turns = await until(
      () => {
        const r = requests().filter((x) => x.method === "turn/start");
        return r.length >= active ? r : null;
      },
      "first provider request for every interrupted run",
      45000,
    );
    const last = await report();
    NodeAssert.equal(last.continued, active, "every preparation cut is continued");
    NodeAssert.equal(turns.length, active, "I7: exactly one request per interrupted preparation");
    const prompts = turns.map((r) => r.params.input.find((i) => i.type === "text")?.text);
    NodeAssert.deepEqual(
      prompts.sort(),
      Array.from({ length: active }, (_, i) => `Synthetic request ${i}`).sort(),
      "I7: exact original inputs each continued once",
    );
    rows.push({
      machine: {
        hostname: NodeOS.hostname(),
        platform: NodeOS.platform(),
        arch: NodeOS.arch(),
        cpus: NodeOS.cpus().length,
        node: process.version,
      },
      seed: 1,
      unrelatedProviderThreads: Number(process.env.T3CODE_RECOVERY_SHAPE ?? 0),
      threads: count,
      active,
      listenMs: Date.parse(last.listeningAt) - start,
      readReadyMs: readReady - start,
      reconciledMs: Date.parse(settled.completedAt) - start,
      firstQueuedMs:
        Math.min(...last.threads.filter((t) => t.queuedAt).map((t) => Date.parse(t.queuedAt))) -
        start,
      lastQueuedMs:
        Math.max(...last.threads.filter((t) => t.queuedAt).map((t) => Date.parse(t.queuedAt))) -
        start,
      firstProviderRequestMs: Math.min(...turns.map((t) => t.at)) - start,
      lastProviderRequestMs: Math.max(...turns.map((t) => t.at)) - start,
    });
  } finally {
    debug?.close();
    child.kill("SIGKILL");
    await Promise.race([
      exit,
      new Promise((_, reject) => {
        const t = setTimeout(() => reject(Error("Subprocess did not exit after SIGKILL")), 10000);
        t.unref();
      }),
    ]);
    await verifyStubExit(home);
    NodeFS.writeFileSync(NodePath.join(home, "server.stdout.log"), sanitizeLog(stdout));
    NodeFS.writeFileSync(NodePath.join(home, "server.stderr.log"), stderr);
    NodeFS.writeFileSync(NodePath.join(output, "timings.json"), JSON.stringify(rows, null, 2));
  }
}
console.log(JSON.stringify(rows, null, 2));
if (process.env.T3CODE_RECOVERY_TIMINGS_ONLY === "1") process.exit(0);

// Each case retains the marked home, provider ledger, reports and exact kill trace.
const cases = [];
async function boot(home, label, pauseAt) {
  const listenPort = await port();
  if (pauseAt) NodeFS.writeFileSync(NodePath.join(home, ".pause-reconcile"), "1");
  let stdout = "",
    stderr = "";
  const began = Date.now();
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      "--import",
      NodePath.join(fixtures, "InstallProbe.fixture.mjs"),
      "--inspect=127.0.0.1:0",
      NodePath.join(root, "apps/server/src/bin.ts"),
      "serve",
      "--base-dir",
      home,
      "--host",
      "127.0.0.1",
      "--port",
      String(listenPort),
    ],
    { cwd: root, env: serverEnv(home), stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", (b) => (stdout += b));
  child.stderr.on("data", (b) => (stderr += b));
  const exit = NodeEvents.once(child, "exit");
  let debug;
  const stop = async (signal = "SIGKILL") => {
    debug?.close();
    child.kill(signal);
    await Promise.race([
      exit,
      new Promise((_, reject) => {
        const t = setTimeout(() => reject(Error("Subprocess did not exit after SIGKILL")), 10000);
        t.unref();
      }),
    ]);
    await verifyStubExit(home);
    NodeFS.writeFileSync(NodePath.join(home, label + ".stdout.log"), sanitizeLog(stdout));
    NodeFS.writeFileSync(NodePath.join(home, label + ".stderr.log"), stderr);
  };
  try {
    debug = await inspector(
      await until(
        () => stderr.match(/ws:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]+/)?.[0],
        label + " inspector",
      ),
    );
    const report = async () => {
      const r = await debug.request("Runtime.evaluate", {
        expression: "globalThis.__l5InstallReport?.()",
        returnByValue: true,
      });
      return r.result.value;
    };
    const setBoundary = async (file, needle) => {
      await debug.request("Debugger.enable");
      const line = NodeFS
        .readFileSync(NodePath.join(root, file), "utf8")
        .split("\n")
        .findIndex((l) => l.includes(needle));
      NodeAssert.ok(line >= 0);
      const { breakpointId } = await debug.request("Debugger.setBreakpointByUrl", {
        urlRegex: file.split("/").at(-1).replaceAll(".", "\\.") + "$",
        lineNumber: line,
      });
      return async () =>
        until(async () => {
          while (debug.events.length) {
            const e = debug.events.shift();
            if (e.method !== "Debugger.paused") continue;
            if (e.params.hitBreakpoints?.includes(breakpointId)) return true;
            await debug.request("Debugger.resume");
          }
        }, label + " breakpoint");
    };
    if (pauseAt)
      await until(
        () => NodeFS.existsSync(NodePath.join(home, ".reconcile-boundary")),
        label + " reconcile commit boundary",
        30000,
      );
    const snapshot = async () => {
      const r = await debug.request("Runtime.evaluate", {
        expression: "globalThis.__l5Snapshot()",
        returnByValue: true,
      });
      return r.result.value;
    };
    return { child, debug, report, snapshot, stop, setBoundary, began };
  } catch (e) {
    await stop();
    throw e;
  }
}
const reconcileBoundary = [
  "apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts",
  "const sharedSessions = yield* projections",
];
const shutdownBoundary = [
  "apps/server/src/ardud/fast-install/shutdown.ts",
  "yield* input.prepare.pipe(",
];
for (const mode of [
  "preparation",
  "running",
  "awaiting",
  "child",
  "shutdown",
  "startup",
  "second-recovery",
]) {
  const home = NodeFS.mkdtempSync(NodePath.join(output, mode + "-"));
  NodeFS.writeFileSync(NodePath.join(home, ".crash-sandbox"), "seed=1\n");
  await command(
    [NodePath.join(fixtures, "CrashSeed.fixture.mjs"), home, "1", "1"],
    NodePath.join(home, "seed.log"),
  );
  const ledger = () => {
    try {
      return NodeFS
        .readFileSync(NodePath.join(home, "provider-requests.ndjson"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse);
    } catch {
      return [];
    }
  };
  const trace = [];
  let current;
  try {
    if (mode !== "startup")
      NodeFS.writeFileSync(
        NodePath.join(home, ".crash-plan"),
        JSON.stringify({
          seed: 1,
          mode: ["shutdown", "second-recovery"].includes(mode) ? "running" : mode,
        }),
      );
    current = await boot(home, "before", mode === "startup" ? reconcileBoundary : undefined);
    if (mode !== "startup")
      await until(
        () => NodeFS.existsSync(NodePath.join(home, ".boundary")),
        mode + " provider boundary",
        30000,
      );
    if (mode !== "startup" && mode !== "preparation")
      await until(
        async () => {
          const snapshot = await current.snapshot();
          return (
            snapshot.provider_turns.filter((t) => t.status === "running").length >=
            (mode === "child" ? 2 : 1)
          );
        },
        mode + " durable running turns",
        30000,
      );
    if (mode === "shutdown") {
      const wait = await current.setBoundary(...shutdownBoundary);
      current.child.kill("SIGTERM");
      await wait();
    }
    const cut =
      mode === "startup"
        ? JSON.parse(NodeFS.readFileSync(NodePath.join(home, ".cut-snapshot"), "utf8"))
        : await current.snapshot();
    NodeFS.writeFileSync(NodePath.join(home, "cut-snapshot.json"), JSON.stringify(cut, null, 2));
    if (["awaiting", "child"].includes(mode)) {
      NodeAssert.ok(
        cut.subagents.some((task) => task.origin === "app_owned" && task.childThreadId),
        "real awaited child relationship",
      );
    }
    trace.push({ phase: mode, signal: "SIGKILL", at: Date.now() });
    await current.stop();
    current = null;
    NodeFS.rmSync(NodePath.join(home, ".crash-plan"), { force: true });
    if (mode === "second-recovery") {
      current = await boot(home, "recovery-cut", reconcileBoundary);
      trace.push({ phase: "reconcile", signal: "SIGKILL", at: Date.now() });
      await current.stop();
      current = null;
    }
    NodeFS.rmSync(NodePath.join(home, ".pause-reconcile"), { force: true });
    const baseline = ledger().filter((r) => r.method === "turn/start").length;
    current = await boot(home, "after");
    const report = await until(async () => {
      const r = await current.report();
      return r?.completedAt ? r : null;
    }, mode + " recovery report");
    const expected = ["awaiting", "child"].includes(mode) ? 2 : 1;
    await until(
      () => ledger().filter((r) => r.method === "turn/start").length - baseline >= expected,
      mode + " resumed provider requests",
      30000,
    );
    const resumed = ledger()
      .filter((r) => r.method === "turn/start")
      .slice(baseline);
    NodeAssert.equal(resumed.length, expected, "I7: one resumed request per interrupted turn");
    NodeAssert.equal(
      report.threads.filter((t) => t.continued || t.reason).length,
      expected,
      "I7: every interrupted thread is accounted for",
    );
    NodeAssert.equal(
      new Set(resumed.map((r) => r.params.threadId)).size,
      expected,
      "I7: no thread resumed twice",
    );
    const recovered = await current.snapshot();
    const sources = cut.runs.filter((r) =>
      ["preparing", "starting", "running", "waiting"].includes(r.status),
    );
    for (const source of sources) {
      const messages = recovered.messages.filter(
        (m) => m.id === `message:restart-continuation:${source.id}`,
      );
      NodeAssert.equal(
        messages.length,
        1,
        "I7: one durable continuation for exact cut run " + source.id,
      );
      const hadNativeTurn = cut.provider_turns.some(
        (t) => t.runAttemptId === source.activeAttemptId,
      );
      if (!hadNativeTurn) {
        const original = cut.messages.find((m) => m.id === source.userMessageId);
        NodeAssert.equal(messages[0].text, original.text, "preparation replays exact input");
        NodeAssert.ok(
          resumed.some((r) => r.params.input.some((i) => i.text === original.text)),
          "provider receives original preparation input",
        );
      } else {
        const native = cut.provider_threads.find((t) => t.id === source.providerThreadId);
        NodeAssert.ok(
          resumed.some((r) => r.params.threadId === native.nativeThreadRef.nativeId),
          "provider resumes the exact native thread for the cut run",
        );
      }
    }
    for (const task of cut.subagents.filter((t) => t.origin === "app_owned" && t.childThreadId)) {
      const retained = recovered.subagents.find((t) => t.id === task.id);
      NodeAssert.equal(
        retained?.childThreadId,
        task.childThreadId,
        "child dependency survives recovery",
      );
      const child = recovered.threads.find((t) => t.id === task.childThreadId);
      NodeAssert.ok(child?.lineage.parentThreadId, "child retains its parent");
    }
    const final = await current.report();
    NodeFS.writeFileSync(NodePath.join(home, "recovery-report.json"), JSON.stringify(final, null, 2));
    trace.push({ phase: "verified", resumed: resumed.length, at: Date.now() });
    cases.push({ mode, seed: 1, passed: true });
  } catch (e) {
    cases.push({ mode, seed: 1, passed: false, error: String(e) });
    throw e;
  } finally {
    if (current) await current.stop();
    NodeFS.writeFileSync(NodePath.join(home, "kill-trace.json"), JSON.stringify(trace, null, 2));
    NodeFS.writeFileSync(NodePath.join(output, "cases.json"), JSON.stringify(cases, null, 2));
  }
}
console.log(JSON.stringify(cases, null, 2));
