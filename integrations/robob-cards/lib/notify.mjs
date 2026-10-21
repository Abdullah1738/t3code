import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const BUN = join(homedir(), ".bun/bin/bun");
const TELEGRAM = join(homedir(), ".local/share/telegram-bridge/src/cli.ts");
const T3CTL = join(homedir(), ".local/bin/t3ctl");

// Alerts are best effort: a missing bridge must never stop an enrollment.
function fire(command, args) {
  if (process.env.ROBOB_CARDS_QUIET === "1") return;
  const env = { ...process.env };
  delete env.BUN_INSPECT;
  try {
    const child = spawn(command, args, { stdio: "ignore", env, timeout: 60_000 });
    child.on("error", () => {});
  } catch {}
}

export function notifyOwner({ name, key, severity, text }) {
  fire(BUN, [
    TELEGRAM, "notify", "--source", "Robob Cards", "--severity", severity, "--text", text, "--key", `robob-cards:${name}:${key}`,
  ]);
}

export function wakeThread(thread, text) {
  if (thread) fire(process.execPath, [T3CTL, "send", thread, `[robob-cards] ${text}`, "--mode", "auto"]);
}
