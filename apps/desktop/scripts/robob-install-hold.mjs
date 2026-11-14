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
        return { release: async () => {}, by: env.ROBOB_INSTALL_HOLD_BY, pid: Number(env.ROBOB_INSTALL_HOLD_PID) };
      } catch (error) {
        if (error.code === "ENOENT") throw error;
      }
    }
    await call("start", by, pid);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    warn("WARNING: robob-install-hold missing; Robob guard may reopen mid-install.");
    return { release: async () => {}, by: null, pid: null };
  }
  return { release: () => call("stop", by, pid), by, pid };
}

/** An install timeout ends the attempt, not its recovery window. */
export async function finishInstallHold({
  release,
  quitStarted,
  healthy,
  onWaiting = async () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (quitStarted) {
    let announced = false;
    for (;;) {
      try {
        if (await healthy()) break;
      } catch {
        // A refused connection or stalled read is still an unfinished recovery.
      }
      if (!announced) {
        announced = true;
        try {
          await onWaiting();
        } catch {
          // Reporting an outage cannot release the hold for that outage.
        }
      }
      await sleep(5000);
    }
  }
  await release();
}
