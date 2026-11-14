import * as NodeChildProcess from "node:child_process";
import { ControlClient } from "./client.mjs";
import { ignoreMacosTypeOfServiceEinval } from "./control-qos.mjs";
import { checkLive } from "./live-check.mjs";

// Credential reads and native git I/O must not share the watchdog's event loop.
export function runLiveCli({ commit, repo, url, token, timeoutMs }) {
  const started = performance.now();
  const deadline = Date.now() + timeoutMs;
  let stage = "config";
  let stageStarted = started;
  const stages = {};
  let probe;
  let finished = false;
  const stop = () => {
    if (!probe) return;
    if (probe.exitCode === null && probe.signalCode === null) {
      try {
        // The detached group belongs to this spawn, including any git child.
        // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone Node CLI owns this subprocess.
        if (process.platform !== "win32") process.kill(-probe.pid, "SIGKILL");
        else probe.kill("SIGKILL");
      } catch {
        probe.kill("SIGKILL");
      }
    }
    if (probe.connected) probe.disconnect();
    probe.unref();
  };
  const failure = (status) => ({
    commit,
    buildCommit: null,
    live: null,
    reason: status === "timeout" ? `${stage} timed out` : `${stage} unavailable`,
    stages: { ...stages, [stage]: { status, ms: Math.round(performance.now() - stageStarted) } },
  });
  const finish = (report) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    stop();
    const code = report.live === true ? 0 : report.live === false ? 3 : 2;
    const result = { ...report, elapsedMs: Math.round(performance.now() - started) };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`, () => process.exit(code));
  };
  const timer = setTimeout(() => finish(failure("timeout")), timeoutMs);
  const backstop = setTimeout(() => {
    finish(failure("timeout"));
    process.exit(2);
  }, timeoutMs + 2000);
  backstop.unref();
  try {
    probe = NodeChildProcess.fork(new URL(import.meta.url), [], {
      detached: true,
      windowsHide: true,
      // Raw subprocess output can contain credentials; accept structured IPC only.
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    probe.on("message", (message) => {
      if (message.stage && message.stage !== stage) {
        stages[stage] = { status: "ok", ms: Math.round(performance.now() - stageStarted) };
        stage = message.stage;
        stageStarted = performance.now();
      }
      if (message.report) finish(message.report);
      else if (message.failed) finish(failure("error"));
    });
    const failed = () => finish(failure("error"));
    probe.on("error", failed);
    probe.on("exit", failed);
    // Startup and credential discovery consume the same budget. Secrets stay off argv.
    probe.send({ commit, repo, url, token, deadline }, (error) => {
      if (error) failed();
    });
  } catch {
    finish(failure("error"));
  }
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    process.once(signal, () => {
      stop();
      process.exit(code);
    });
  }
}

if (import.meta.main && process.send) {
  process.on("disconnect", () => process.exit(0));
  process.once("message", async (options) => {
    ignoreMacosTypeOfServiceEinval();
    const started = performance.now();
    process.send({ stage: "config" });
    try {
      const client = new ControlClient({
        url: options.url,
        token: options.token,
        component: "t3ctl",
      });
      const config = { status: "ok", ms: Math.round(performance.now() - started) };
      const report = await checkLive(options.commit, {
        repo: options.repo,
        timeoutMs: Math.max(1, options.deadline - Date.now()),
        health: (requestOptions) => client.health(requestOptions),
        onStage: (stage) => process.send({ stage }),
      });
      process.send({ report: { ...report, stages: { config, ...report.stages } } });
    } catch {
      process.send({ failed: true });
    }
  });
}
