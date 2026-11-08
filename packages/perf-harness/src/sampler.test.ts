// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Tests the lifetime of the native sampler control channel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
test("sampler IPC does not keep a stopped server alive", async () => {
  const child = spawn(
    process.execPath,
    ["--import", fileURLToPath(new URL("./sampler.ts", import.meta.url)), "-e", ""],
    {
      env: { ...process.env, ROBOB_PERF_SAMPLE_FILE: "/tmp/robob-perf-sampler-probe.json" },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Sampler kept process alive")), 3000);
      child.once("exit", (code) => {
        clearTimeout(timer);
        code === 0 ? resolve() : reject(new Error(`exit ${code}`));
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    assert.equal(child.exitCode, 0);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});
