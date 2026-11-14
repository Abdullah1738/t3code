/* oxlint-disable unicorn/require-post-message-target-origin -- Node MessagePort has no browser target origin. */
import * as NodeWorkerThreads from "node:worker_threads";
import { ControlClient } from "./client.mjs";
import { ignoreMacosTypeOfServiceEinval } from "./control-qos.mjs";
import { deepHealth, deepHealthBudget, healthLine, summarizeLag } from "./deep-health.mjs";

// Keep the watchdog outside the probe's event loop, including credential reads.
export function runDeepHealthCli({ url, token, timeoutMs, json }) {
  const budget = deepHealthBudget(timeoutMs);
  const deadline = performance.now() + budget;
  let stage = "config";
  let stageStarted = performance.now();
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
    process.exitCode = report.exitCode ?? 2;
    const text =
      (!json && report.summary ? `${report.summary}\n` : "") +
      `${JSON.stringify(report, null, 2)}\n`;
    // Flush piped output before exiting; stuck filesystem work and keep-alive
    // sockets must not keep this diagnostic alive after it prints its result.
    process.stdout.write(text, () => process.exit(process.exitCode));
  };
  const backstop = setTimeout(() => {
    finish(failure("timeout"));
    process.exit(2);
  }, budget + 2000);
  backstop.unref();
  const worker = new NodeWorkerThreads.Worker(new URL(import.meta.url), {
    workerData: { kind: "deep-health", url, token, deadline },
  });
  let finished = false;
  worker.on("message", (message) => {
    if (message.stage) {
      stage = message.stage;
      stageStarted = performance.now();
    }
    if (message.report && !finished) {
      finished = true;
      finish(message.report);
    }
  });
  const failed = () => {
    if (finished) return;
    finished = true;
    finish(failure("error"));
  };
  worker.on("error", failed);
  worker.on("exit", failed);
}

if (!NodeWorkerThreads.isMainThread && NodeWorkerThreads.workerData?.kind === "deep-health") {
  ignoreMacosTypeOfServiceEinval();
  NodeWorkerThreads.parentPort.postMessage({ stage: "config" });
  const client = new ControlClient({
    url: NodeWorkerThreads.workerData.url,
    token: NodeWorkerThreads.workerData.token,
    component: "t3ctl",
  });
  const report = await deepHealth({
    client,
    timeoutMs: Math.max(1, NodeWorkerThreads.workerData.deadline - performance.now()),
    onStage: (stage) => NodeWorkerThreads.parentPort.postMessage({ stage }),
  });
  NodeWorkerThreads.parentPort.postMessage({ report });
}
