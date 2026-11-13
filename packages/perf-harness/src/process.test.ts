// @effect-diagnostics nodeBuiltinImport:off - Tests native subprocess signal lifetime.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { observeExit } from "./process.ts";
test("signal exit can be awaited repeatedly without waiting for a second event", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  const lifetime = observeExit(child);
  child.kill("SIGTERM");
  await lifetime.exit;
  assert.equal(lifetime.exited, true);
  assert.equal(child.exitCode, null);
  await lifetime.exit;
  assert.equal(observeExit(child).exited, true);
});
