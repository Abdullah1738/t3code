import * as NodeChildProcess from "node:child_process";
import { ControlClient } from "./client.mjs";
import { ignoreMacosTypeOfServiceEinval } from "./control-qos.mjs";
import { deepHealth, deepHealthBudget, healthLine, summarizeLag } from "./deep-health.mjs";

// Native-blocked worker threads can delay process.exit; keep probes in another process.
export function runDeepHealthCli({ url, token, timeoutMs, json }) {
  const budget = deepHealthBudget(timeoutMs);
  const deadline = Date.now() + budget;
  let stage = "config";
  let stageStarted = performance.now();
  let probe;
  let finished = false;
  const stop = () => {
    if (!probe) return;
    if (probe.exitCode === null && probe.signalCode === null) {
      try {
        // The detached process group belongs to this spawn, including any lsof child.
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
  const failure = (status) => {
    const report = {
      status,
      stage,
      at: new Date().toISOString(),
      verdict: "unknown",
      exitCode: 2,
      connection: { status: "unknown", ms: 0 },
      roundTrip: { status: "unknown", ms: 0 },
      lag: summarizeLag({ text: "", bytesRead: 0, error: `${stage} ${status}` }),
      stages: { [stage]: { status, ms: Math.round(performance.now() - stageStarted) } },
    };
    return { ...report, summary: `${healthLine(report)}; ${stage} ${status}` };
  };
  const finish = (report) => {
    if (finished) return;
    finished = true;
    stop();
    process.exitCode = report.exitCode ?? 2;
    const text =
      (!json && report.summary ? `${report.summary}\n` : "") +
      `${JSON.stringify(report, null, 2)}\n`;
    process.stdout.write(text, () => process.exit(process.exitCode));
  };
  const backstop = setTimeout(() => {
    finish(failure("timeout"));
    process.exit(2);
  }, budget + 2000);
  backstop.unref();
  probe = NodeChildProcess.fork(new URL(import.meta.url), [], {
    detached: true,
    windowsHide: true,
    // Only structured IPC reaches the parent; raw errors may contain credentials.
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  probe.on("message", (message) => {
    if (message.stage) {
      stage = message.stage;
      stageStarted = performance.now();
    }
    if (message.report) finish(message.report);
    else if (message.failed) finish(failure("error"));
  });
  const failed = () => finish(failure("error"));
  probe.on("error", failed);
  probe.on("exit", failed);
  // Credentials stay off the child command line, and startup consumes the shared budget.
  probe.send({ url, token, deadline });
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
    process.send({ stage: "config" });
    try {
      const client = new ControlClient({
        url: options.url,
        token: options.token,
        component: "t3ctl",
      });
      const report = await deepHealth({
        client,
        timeoutMs: Math.max(1, options.deadline - Date.now()),
        onStage: (stage) => process.send({ stage }),
      });
      process.send({ report });
    } catch {
      process.send({ failed: true });
    }
  });
}
