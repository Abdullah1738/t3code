import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

/** Keep the heartbeat alive across preflight, quit, launch and recovery. */
export async function acquireInstallHold({
  home = os.homedir(),
  pid = process.pid,
  env = process.env,
  run = promisify(execFile),
  warn = console.warn,
} = {}) {
  const helper = path.join(home, ".local/bin/robob-install-hold");
  const call = (action, by, owner) =>
    run(helper, [action, "--by", by, "--pid", String(owner)], { timeout: 10_000, env });
  const by = "release-install";
  try {
    if (env.ROBOB_INSTALL_HOLD_BY && env.ROBOB_INSTALL_HOLD_PID) {
      try {
        await call("beat", env.ROBOB_INSTALL_HOLD_BY, env.ROBOB_INSTALL_HOLD_PID);
        return async () => {};
      } catch (error) {
        if (error.code === "ENOENT") throw error;
      }
    }
    await call("start", by, pid);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    warn("WARNING: robob-install-hold missing; Robob guard may reopen mid-install.");
    return async () => {};
  }
  return () => call("stop", by, pid);
}
