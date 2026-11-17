import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function logEvent(record) {
  try {
    const directory = path.join(
      process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state"),
      "vp-shim",
    );
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, "events.jsonl");
    const limit = Number(process.env.VP_SHIM_LOG_MAX_BYTES) || 5 * 1024 * 1024;
    if (fs.existsSync(file) && fs.statSync(file).size > limit) fs.renameSync(file, `${file}.1`);
    if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
    fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`, {
      mode: 0o600,
    });
  } catch {
    // Observability must never change command admission or its exit status.
  }
}

export function hasToolchain(directory) {
  try {
    return fs
      .statSync(fs.realpathSync(path.join(directory, "node_modules/vite-plus/bin/vp")))
      .isFile();
  } catch {
    return false;
  }
}

export function danglingNotice(kind, directory) {
  return `vp: skipping ${kind} (${directory}): vite-plus/bin/vp does not resolve; repair that checkout with offbox run -- pnpm install --frozen-lockfile`;
}

export function brokenToolchainPath(directory) {
  let target = path.join(directory, "node_modules/vite-plus/bin/vp");
  // Resolve each existing prefix; realpath itself cannot describe a dangling link.
  for (let depth = 0; depth < 40; depth++) {
    let prefix = target;
    while (prefix !== path.dirname(prefix)) {
      try {
        if (fs.lstatSync(prefix).isSymbolicLink()) {
          target = path.resolve(
            path.dirname(prefix),
            fs.readlinkSync(prefix),
            path.relative(prefix, target),
          );
          break;
        }
      } catch {}
      prefix = path.dirname(prefix);
    }
    if (prefix === path.dirname(prefix)) break;
  }
  return target;
}
