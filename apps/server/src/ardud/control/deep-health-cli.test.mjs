const { test } = process.env.VITEST ? await import("vitest") : await import("node:test");
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeURL from "node:url";

const cli = NodeURL.fileURLToPath(new URL("./t3ctl.mjs", import.meta.url));
for (const stage of ["config", "connection", "roundTrip", "runtime", "listener", "lagTail"]) {
  test(`CLI watchdog survives a blocked ${stage} event loop`, { concurrency: true }, async () => {
    // Synchronous loader hooks are inherited by workers. Block the actual CLI
    // worker, so the test also proves the deadline lives on another event loop.
    const hook = `
      import { registerHooks } from 'node:module';
      registerHooks({ load(url, context, next) {
        const result = next(url, context);
        if (!url.endsWith('/deep-health.mjs') && !url.endsWith('/client.mjs')) return result;
        let source = Buffer.from(result.source).toString();
        if (${JSON.stringify(stage)} === 'config' && url.endsWith('/client.mjs')) {
          source = source.replace('constructor(options = {}) {',
            'constructor(options = {}) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);');
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
            'onStage(name); if (name === ${JSON.stringify(stage)}) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);');
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
      { timeout: 5000, killSignal: "SIGKILL" },
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
  });
}

test("deep health keeps the macOS QoS workaround in the probe worker", async () => {
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
