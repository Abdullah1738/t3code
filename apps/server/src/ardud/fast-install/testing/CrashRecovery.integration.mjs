// Run offbox: node apps/server/src/ardud/fast-install/testing/CrashRecovery.integration.mjs <output-dir>
// The inspector is bound to loopback on a synthetic subprocess only.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import assert from "node:assert/strict";
const root = process.cwd();
const fixtures = path.join(root, "apps/server/src/ardud/fast-install/testing");
const output = path.resolve(process.argv[2] ?? "tmp/l5-crash");
fs.mkdirSync(output, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  const fd = fs.openSync(log, "w");
  const child = spawn(process.execPath, args, { cwd: root, stdio: ["ignore", fd, fd] });
  fs.closeSync(fd);
  const [code, signal] = await once(child, "exit");
  assert.equal(code, 0, `${args[0]} exited ${code}/${signal}: ${log}`);
}
async function inspector(url) {
  const ws = new WebSocket(url);
  await once(ws, "open");
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
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const value = server.address().port;
  await new Promise((r) => server.close(r));
  return value;
}
async function verifyStubExit(home) {
  const file = path.join(home, "processes.ndjson");
  if (!fs.existsSync(file)) return;
  const owned = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  await until(
    () =>
      owned.every((record) => {
        try {
          const stat = fs.readFileSync(`/proc/${record.pid}/stat`, "utf8");
          const fields = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
          return (
            fields[0] === "Z" ||
            fields[19] !== record.startTime ||
            fs.readlinkSync(`/proc/${record.pid}/exe`) !== record.executable
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
  const home = fs.mkdtempSync(path.join(output, `shape-${count}-`));
  fs.writeFileSync(path.join(home, ".crash-sandbox"), "seed=1\n");
  await command(
    [path.join(fixtures, "CrashSeed.fixture.mjs"), home, String(count), String(active)],
    path.join(home, "seed.log"),
  );
  const listenPort = await port();
  const start = Date.now();
  let stdout = "",
    stderr = "";
  const child = spawn(
    process.execPath,
    [
      "--import",
      path.join(fixtures, "InstallProbe.fixture.mjs"),
      "--inspect=127.0.0.1:0",
      path.join(root, "apps/server/src/bin.ts"),
      "serve",
      "--base-dir",
      home,
      "--host",
      "127.0.0.1",
      "--port",
      String(listenPort),
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", (b) => {
    stdout += b;
  });
  child.stderr.on("data", (b) => {
    stderr += b;
  });
  const exit = once(child, "exit");
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
            fs.readFileSync(path.join(home, "userdata/environment-id"), "utf8").trim()
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
        return fs
          .readFileSync(path.join(home, "provider-requests.ndjson"), "utf8")
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
    assert.equal(last.continued, active, "every preparation cut is continued");
    assert.equal(turns.length, active, "I7: exactly one request per interrupted preparation");
    const prompts = turns.map((r) => r.params.input.find((i) => i.type === "text")?.text);
    assert.deepEqual(
      prompts.sort(),
      Array.from({ length: active }, (_, i) => `Synthetic request ${i}`).sort(),
      "I7: exact original inputs each continued once",
    );
    rows.push({
      machine: {
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        cpus: os.cpus().length,
        node: process.version,
      },
      seed: 1,
      threads: count,
      active,
      listenMs: Date.parse(last.listeningAt) - start,
      readReadyMs: readReady - start,
      reconciledMs: Date.parse(settled.completedAt) - start,
      firstQueuedMs:
        Math.min(...last.threads.filter((t) => t.queuedAt).map((t) => Date.parse(t.queuedAt))) -
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
    fs.writeFileSync(path.join(home, "server.stdout.log"), sanitizeLog(stdout));
    fs.writeFileSync(path.join(home, "server.stderr.log"), stderr);
    fs.writeFileSync(path.join(output, "timings.json"), JSON.stringify(rows, null, 2));
  }
}
console.log(JSON.stringify(rows, null, 2));

// Each case retains the marked home, provider ledger, reports and exact kill trace.
const cases = [];
async function boot(home, label, pauseAt) {
  const listenPort = await port();
  if (pauseAt) fs.writeFileSync(path.join(home, ".pause-reconcile"), "1");
  let stdout = "",
    stderr = "";
  const began = Date.now();
  const child = spawn(
    process.execPath,
    [
      "--import",
      path.join(fixtures, "InstallProbe.fixture.mjs"),
      "--inspect=127.0.0.1:0",
      path.join(root, "apps/server/src/bin.ts"),
      "serve",
      "--base-dir",
      home,
      "--host",
      "127.0.0.1",
      "--port",
      String(listenPort),
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", (b) => (stdout += b));
  child.stderr.on("data", (b) => (stderr += b));
  const exit = once(child, "exit");
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
    fs.writeFileSync(path.join(home, label + ".stdout.log"), sanitizeLog(stdout));
    fs.writeFileSync(path.join(home, label + ".stderr.log"), stderr);
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
      const line = fs
        .readFileSync(path.join(root, file), "utf8")
        .split("\n")
        .findIndex((l) => l.includes(needle));
      assert.ok(line >= 0);
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
        () => fs.existsSync(path.join(home, ".reconcile-boundary")),
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
  const home = fs.mkdtempSync(path.join(output, mode + "-"));
  fs.writeFileSync(path.join(home, ".crash-sandbox"), "seed=1\n");
  await command(
    [path.join(fixtures, "CrashSeed.fixture.mjs"), home, "1", "1"],
    path.join(home, "seed.log"),
  );
  const ledger = () => {
    try {
      return fs
        .readFileSync(path.join(home, "provider-requests.ndjson"), "utf8")
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
      fs.writeFileSync(
        path.join(home, ".crash-plan"),
        JSON.stringify({
          seed: 1,
          mode: ["shutdown", "second-recovery"].includes(mode) ? "running" : mode,
        }),
      );
    current = await boot(home, "before", mode === "startup" ? reconcileBoundary : undefined);
    if (mode !== "startup")
      await until(
        () => fs.existsSync(path.join(home, ".boundary")),
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
        ? JSON.parse(fs.readFileSync(path.join(home, ".cut-snapshot"), "utf8"))
        : await current.snapshot();
    fs.writeFileSync(path.join(home, "cut-snapshot.json"), JSON.stringify(cut, null, 2));
    if (["awaiting", "child"].includes(mode)) {
      assert.ok(
        cut.subagents.some((task) => task.origin === "app_owned" && task.childThreadId),
        "real awaited child relationship",
      );
    }
    trace.push({ phase: mode, signal: "SIGKILL", at: Date.now() });
    await current.stop();
    current = null;
    fs.rmSync(path.join(home, ".crash-plan"), { force: true });
    if (mode === "second-recovery") {
      current = await boot(home, "recovery-cut", reconcileBoundary);
      trace.push({ phase: "reconcile", signal: "SIGKILL", at: Date.now() });
      await current.stop();
      current = null;
    }
    fs.rmSync(path.join(home, ".pause-reconcile"), { force: true });
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
    assert.equal(resumed.length, expected, "I7: one resumed request per interrupted turn");
    assert.equal(
      report.threads.filter((t) => t.continued || t.reason).length,
      expected,
      "I7: every interrupted thread is accounted for",
    );
    assert.equal(
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
      assert.equal(
        messages.length,
        1,
        "I7: one durable continuation for exact cut run " + source.id,
      );
      const hadNativeTurn = cut.provider_turns.some(
        (t) => t.runAttemptId === source.activeAttemptId,
      );
      if (!hadNativeTurn) {
        const original = cut.messages.find((m) => m.id === source.userMessageId);
        assert.equal(messages[0].text, original.text, "preparation replays exact input");
        assert.ok(
          resumed.some((r) => r.params.input.some((i) => i.text === original.text)),
          "provider receives original preparation input",
        );
      } else {
        const native = cut.provider_threads.find((t) => t.id === source.providerThreadId);
        assert.ok(
          resumed.some((r) => r.params.threadId === native.nativeThreadRef.nativeId),
          "provider resumes the exact native thread for the cut run",
        );
      }
    }
    for (const task of cut.subagents.filter((t) => t.origin === "app_owned" && t.childThreadId)) {
      const retained = recovered.subagents.find((t) => t.id === task.id);
      assert.equal(
        retained?.childThreadId,
        task.childThreadId,
        "child dependency survives recovery",
      );
      const child = recovered.threads.find((t) => t.id === task.childThreadId);
      assert.ok(child?.lineage.parentThreadId, "child retains its parent");
    }
    const final = await current.report();
    fs.writeFileSync(path.join(home, "recovery-report.json"), JSON.stringify(final, null, 2));
    trace.push({ phase: "verified", resumed: resumed.length, at: Date.now() });
    cases.push({ mode, seed: 1, passed: true });
  } catch (e) {
    cases.push({ mode, seed: 1, passed: false, error: String(e) });
    throw e;
  } finally {
    if (current) await current.stop();
    fs.writeFileSync(path.join(home, "kill-trace.json"), JSON.stringify(trace, null, 2));
    fs.writeFileSync(path.join(output, "cases.json"), JSON.stringify(cases, null, 2));
  }
}
console.log(JSON.stringify(cases, null, 2));
