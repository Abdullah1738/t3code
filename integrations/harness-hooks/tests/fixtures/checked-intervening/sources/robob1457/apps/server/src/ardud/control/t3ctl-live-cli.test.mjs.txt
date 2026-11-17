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
  ["FIFO open without a writer", 50, false],
  ["FIFO read without data", 200, true],
  ["FIFO open at the default bound", 20_000, false],
]) {
  test(
    `live exits after native credential ${name}`,
    { skip: fifoUnsupported, timeout: 26_000 },
    async () => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "live-config-fifo-"));
      const fifo = NodePath.join(dir, "credentials");
      let writer;
      try {
        NodeChildProcess.execFileSync("mkfifo", ["-m", "600", fifo]);
        if (holdWriter)
          writer = NodeFS.openSync(fifo, NodeFS.constants.O_RDWR | NodeFS.constants.O_NONBLOCK);
        const env = { ...process.env, T3_CONTROL_TOKEN_FILE: fifo };
        delete env.T3_CONTROL_URL;
        delete env.T3_CONTROL_TOKEN;
        const args = [cli, "live", "HEAD"];
        if (timeoutMs !== 20_000) args.push("--timeout", String(timeoutMs / 1000));
        const start = performance.now();
        const result = await NodeUtil.promisify(NodeChildProcess.execFile)(process.execPath, args, {
          env,
          timeout: timeoutMs + 3000,
          killSignal: "SIGKILL",
        }).catch((error) => error);
        NodeAssert.equal(result.code, 2, "live required an external kill");
        NodeAssert.ok(performance.now() - start < timeoutMs + 2500);
        const report = JSON.parse(result.stdout);
        NodeAssert.equal(report.commit, "HEAD");
        NodeAssert.equal(report.buildCommit, null);
        NodeAssert.equal(report.live, null);
        NodeAssert.match(report.reason, /config.*timed out|timeout at config/);
        NodeAssert.equal(report.stages.config.status, "timeout");
        NodeAssert.ok(report.elapsedMs <= timeoutMs + 2000);
        NodeAssert.equal(result.stderr, "");
      } finally {
        if (writer !== undefined) NodeFS.closeSync(writer);
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
}

for (const stage of ["config", "health", "target", "build", "ancestry", "shallow"]) {
  test(`live watchdog survives native I/O at ${stage}`, { skip: fifoUnsupported }, async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "live-stage-fifo-"));
    const fifo = NodePath.join(dir, "blocked");
    try {
      NodeChildProcess.execFileSync("mkfifo", ["-m", "600", fifo]);
      const hook = `
        import { registerHooks } from 'node:module';
        registerHooks({ load(url, context, next) {
          const result = next(url, context);
          if (!url.endsWith('/live-check.mjs') && !url.endsWith('/client.mjs')) return result;
          let source = Buffer.from(result.source).toString();
          if (url.endsWith('/client.mjs')) {
            if (${JSON.stringify(stage)} === 'config') {
              source = source.replace('constructor(options = {}) {',
                'constructor(options = {}) { process.getBuiltinModule("node:fs").readFileSync(process.env.T3_TEST_NATIVE_FIFO);');
            }
            source = source.replace('async request(method, path, body, options = {}) {',
              'async request(method, path, body, options = {}) { return {ok:true,status:"healthy",buildCommit:"abcdef012345"};');
          } else {
            source = source.replace('git = liveGit,', 'git = async (args) => ({status:args[0] === "merge-base" ? 1 : 0,stdout:args[0] === "cat-file" ? "commit" : args.includes("--is-shallow-repository") ? "false" : "abcdef012345"}),');
            source = source.replace('onStage(name);',
              'onStage(name); if (name === ${JSON.stringify(stage)}) process.getBuiltinModule("node:fs").readFileSync(process.env.T3_TEST_NATIVE_FIFO);');
          }
          return {...result,source};
        }});
      `;
      const start = performance.now();
      const result = await NodeUtil.promisify(NodeChildProcess.execFile)(
        process.execPath,
        [
          "--import",
          `data:text/javascript,${encodeURIComponent(hook)}`,
          cli,
          "live",
          "HEAD",
          "--url",
          "http://127.0.0.1:1",
          "--token",
          "fixture-secret",
          "--timeout",
          "0.2",
        ],
        {
          env: { ...process.env, T3_TEST_NATIVE_FIFO: fifo },
          timeout: 4000,
          killSignal: "SIGKILL",
        },
      ).catch((error) => error);
      NodeAssert.equal(result.code, 2, result.stderr);
      NodeAssert.ok(performance.now() - start < 3000);
      const report = JSON.parse(result.stdout);
      NodeAssert.equal(report.live, null);
      NodeAssert.match(report.reason, new RegExp(`${stage}.*timed out|timeout at ${stage}`));
      NodeAssert.equal(report.stages[stage].status, "timeout");
      NodeAssert.doesNotMatch(result.stdout + result.stderr, /fixture-secret/);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("live keeps the macOS QoS workaround in the probe subprocess", async () => {
  const hook = `
    import { registerHooks } from 'node:module';
    import * as Net from 'node:net';
    Object.defineProperty(process, 'platform', {value:'darwin'});
    Net.Socket.prototype.setTypeOfService = function () {
      throw Object.assign(new Error('fixture QoS'), {code:'EINVAL'});
    };
    registerHooks({ load(url, context, next) {
      const result = next(url, context);
      let source = Buffer.from(result.source ?? '').toString();
      if (url.endsWith('/client.mjs')) {
        source = "import * as QosNet from 'node:net';" + source.replace(
          'async request(method, path, body, options = {}) {',
          'async request(method, path, body, options = {}) { new QosNet.Socket().setTypeOfService(0); return {ok:true,status:"healthy",buildCommit:"abcdef012345"};');
      } else if (url.endsWith('/live-check.mjs')) {
        source = source.replace('git = liveGit,', 'git = async (args) => ({status:0,stdout:args[0] === "cat-file" ? "commit" : "abcdef012345"}),');
      } else return result;
      return {...result,source};
    }});
  `;
  const result = await NodeUtil.promisify(NodeChildProcess.execFile)(
    process.execPath,
    [
      "--import",
      `data:text/javascript,${encodeURIComponent(hook)}`,
      cli,
      "live",
      "HEAD",
      "--url",
      "http://127.0.0.1:1",
      "--token",
      "fixture-secret",
    ],
    { timeout: 5000, killSignal: "SIGKILL" },
  ).catch((error) => error);
  NodeAssert.equal(result.code ?? 0, 0, result.stderr);
  NodeAssert.equal(JSON.parse(result.stdout).live, true);
  NodeAssert.doesNotMatch(result.stdout + result.stderr, /fixture-secret/);
});
