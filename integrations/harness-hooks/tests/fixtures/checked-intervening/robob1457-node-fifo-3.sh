cat >> apps/server/src/ardud/control/t3ctl-live-cli.test.mjs <<'EOF'

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
      const result = await NodeUtil.promisify(NodeChildProcess.execFile)(process.execPath, [
        "--import", `data:text/javascript,${encodeURIComponent(hook)}`, cli, "live", "HEAD",
        "--url", "http://127.0.0.1:1", "--token", "fixture-secret", "--timeout", "0.2",
      ], { env: {...process.env,T3_TEST_NATIVE_FIFO:fifo}, timeout: 4000, killSignal:"SIGKILL" }).catch((error) => error);
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
EOF
python3 -I - <<'PY'
from pathlib import Path
p=Path('apps/server/src/ardud/control/t3ctl.test.ts')
s=p.read_text().replace('const result = await invoke("0.05");','const result = await invoke("0.5");')
p.write_text(s)
PY