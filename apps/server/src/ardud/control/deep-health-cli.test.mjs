const { test } = process.env.VITEST ? await import("vitest") : await import("node:test");
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeURL from "node:url";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const cli = NodeURL.fileURLToPath(new URL("./t3ctl.mjs", import.meta.url));
// oxlint-disable-next-line t3code/no-global-process-runtime -- POSIX FIFO fixtures in standalone Node CLI tests.
const fifoUnsupported = process.platform === "win32";
for (const [name, timeoutMs, holdWriter] of [
  ["FIFO open without a writer", 200, false],
  ["FIFO read without data", 200, true],
  ["FIFO open at the default bound", 10_000, false],
]) {
  test(
    `CLI exits after native credential ${name}`,
    { skip: fifoUnsupported, timeout: 17_000 },
    async () => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "deep-config-fifo-"));
      const fifo = NodePath.join(dir, "credentials");
      let writer;
      try {
        NodeChildProcess.execFileSync("mkfifo", ["-m", "600", fifo]);
        // A writer that sends no bytes makes readFileSync block after open succeeds.
        if (holdWriter)
          writer = NodeFS.openSync(fifo, NodeFS.constants.O_RDWR | NodeFS.constants.O_NONBLOCK);
        const env = { ...process.env, T3_CONTROL_TOKEN_FILE: fifo };
        delete env.T3_CONTROL_URL;
        delete env.T3_CONTROL_TOKEN;
        const args = [cli, "health", "--deep", "--json"];
        if (timeoutMs !== 10_000) args.push("--request-timeout", String(timeoutMs / 1000));
        const start = performance.now();
        const result = await NodeUtil.promisify(NodeChildProcess.execFile)(process.execPath, args, {
          env,
          timeout: timeoutMs + 4000,
          killSignal: "SIGKILL",
        }).catch((error) => error);
        NodeAssert.equal(result.code, 2, "CLI needed an external kill after printing its timeout");
        NodeAssert.ok(performance.now() - start < timeoutMs + 3000);
        const report = JSON.parse(result.stdout);
        NodeAssert.equal(report.status, "timeout");
        NodeAssert.equal(report.stage, "config");
        NodeAssert.ok(report.summary && report.lag && report.connection && report.roundTrip);
        NodeAssert.equal(result.stderr, "");
      } finally {
        if (writer !== undefined) NodeFS.closeSync(writer);
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
}

for (const stage of ["config", "connection", "roundTrip", "runtime", "listener", "lagTail"]) {
  test(`CLI watchdog survives native I/O at ${stage}`, { skip: fifoUnsupported }, async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "deep-stage-fifo-"));
    const fifo = NodePath.join(dir, "blocked");
    try {
      NodeChildProcess.execFileSync("mkfifo", ["-m", "600", fifo]);
      // Loader hooks are inherited by the subprocess. A native FIFO open must
      // not prevent the supervisor from exiting, at any stage of the probe.
      const hook = `
      import { registerHooks } from 'node:module';
      registerHooks({ load(url, context, next) {
        const result = next(url, context);
        if (!url.endsWith('/deep-health.mjs') && !url.endsWith('/client.mjs')) return result;
        let source = Buffer.from(result.source).toString();
        if (${JSON.stringify(stage)} === 'config' && url.endsWith('/client.mjs')) {
          source = source.replace('constructor(options = {}) {',
            'constructor(options = {}) { process.getBuiltinModule("node:fs").readFileSync(process.env.T3_TEST_NATIVE_FIFO);');
        } else if (url.endsWith('/client.mjs')) {
          source = source.replace('async request(method, path, body, options = {}) {',
            'async request(method, path, body, options = {}) { ' +
            'if (path === "/health") { ' +
            (${JSON.stringify(stage)} === 'listener'
              ? 'throw new Error("fixture transport failure");'
              : 'return {ok:true,status:"healthy",serverStartedAt:"2026-11-14T00:00:00Z"};') +
            '} return {threads:[]};');
        } else if (url.endsWith('/deep-health.mjs')) {
          source = source.replace('readRuntime = readRuntimeState,',
            'readRuntime = async () => ({origin:"http://127.0.0.1:1",pid:process.pid,startedAt:"2026-11-14T00:00:00Z"}),');
          source = source.replace('onStage(name);',
            'onStage(name); if (name === ${JSON.stringify(stage)}) process.getBuiltinModule("node:fs").readFileSync(process.env.T3_TEST_NATIVE_FIFO);');
        }
        return { ...result, source };
      }});
    `;
      const start = performance.now();
      const result = await NodeUtil.promisify(NodeChildProcess.execFile)(
        process.execPath,
        [
          "--import",
          `data:text/javascript,${encodeURIComponent(hook)}`,
          cli,
          "health",
          "--deep",
          "--json",
          "--url",
          "http://127.0.0.1:1",
          "--token",
          "fixture-secret",
          "--request-timeout",
          "0.2",
        ],
        {
          env: { ...process.env, T3_TEST_NATIVE_FIFO: fifo },
          timeout: 5000,
          killSignal: "SIGKILL",
        },
      ).catch((error) => error);
      NodeAssert.ok(performance.now() - start < 3500);
      NodeAssert.equal(result.code, 2, result.stderr);
      const report = JSON.parse(result.stdout);
      NodeAssert.equal(report.status, "timeout");
      NodeAssert.equal(report.stage, stage);
      NodeAssert.equal(report.stages[stage].status, "timeout");
      NodeAssert.equal(report.lag.status, "unknown");
      NodeAssert.ok(report.connection && report.roundTrip && report.summary);
      NodeAssert.doesNotMatch(result.stdout + result.stderr, /fixture-secret/);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("deep health keeps the macOS QoS workaround in the probe subprocess", async () => {
  const hook = `
    import { registerHooks } from 'node:module';
    import * as Net from 'node:net';
    Object.defineProperty(process, 'platform', {value:'darwin'});
    Net.Socket.prototype.setTypeOfService = function () {
      throw Object.assign(new Error('fixture QoS'), {code:'EINVAL'});
    };
    registerHooks({ load(url, context, next) {
      const result = next(url, context);
      if (!url.endsWith('/client.mjs')) return result;
      const source = "import * as QosNet from 'node:net';" + Buffer.from(result.source).toString().replace(
        'async request(method, path, body, options = {}) {',
        'async request(method, path, body, options = {}) { ' +
        'new QosNet.Socket().setTypeOfService(0); ' +
        'return path === "/health" ? {ok:true,status:"healthy"} : {threads:[]};');
      return {...result,source};
    }});
  `;
  const result = await NodeUtil.promisify(NodeChildProcess.execFile)(
    process.execPath,
    [
      "--import",
      `data:text/javascript,${encodeURIComponent(hook)}`,
      cli,
      "health",
      "--deep",
      "--json",
      "--url",
      "http://127.0.0.1:1",
      "--token",
      "fixture-secret",
    ],
    { timeout: 5000, killSignal: "SIGKILL" },
  ).catch((error) => error);
  NodeAssert.equal(result.code, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  NodeAssert.equal(report.connection.status, "ok");
  NodeAssert.equal(report.roundTrip.status, "ok");
  NodeAssert.doesNotMatch(result.stdout + result.stderr, /fixture-secret/);
});
