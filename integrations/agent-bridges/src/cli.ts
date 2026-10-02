import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SupervisorState } from "./supervisor.ts";

class CliError extends Error {}

const STALE_MS = 120_000;

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function readState(path: string): Promise<SupervisorState> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new CliError("Supervisor state is unavailable; is the agent-bridges service running?");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new CliError("Supervisor state is unreadable"); }
  const state = parsed as SupervisorState;
  if (!state || typeof state !== "object" || typeof state.supervisorPid !== "number"
    || typeof state.updatedAt !== "number" || !state.children || typeof state.children !== "object") {
    throw new CliError("Supervisor state is unreadable");
  }
  return state;
}

if (import.meta.main) {
  try {
    const command = process.argv[2] ?? "status";
    if (command !== "status") throw new CliError("Expected status");
    const path = process.env.AGENT_BRIDGES_STATE ?? join(homedir(), ".config/agent-bridges/state.json");
    const state = await readState(path);
    const live = pidAlive(state.supervisorPid);
    const fresh = Date.now() - state.updatedAt < STALE_MS;
    // Project only supervisor scalars and per-child state; logs never pass through here.
    const children = Object.fromEntries(Object.entries(state.children).map(([name, child]) =>
      [name, { state: child.state, pid: child.pid, restarts: child.restarts, lastExitCode: child.lastExitCode }]));
    console.log(JSON.stringify({ running: live && fresh, supervisorPid: state.supervisorPid,
      startedAt: state.startedAt, updatedAt: state.updatedAt, children }));
    process.exitCode = live && fresh ? 0 : 1;
  } catch (error) {
    console.error(JSON.stringify({ error: error instanceof CliError ? error.message : "Supervisor status failed" }));
    process.exitCode = 1;
  }
}
