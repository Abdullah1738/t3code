import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultChildren, Supervisor, type SupervisorState } from "../src/supervisor.ts";

let directory: string;
const directories: string[] = [];
const logs: string[] = [];

async function script(name: string, body: string): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, `#!/bin/zsh -f\n${body}\n`, { mode: 0o700 });
  return path;
}

function readState(): SupervisorState {
  return JSON.parse(readFileSync(join(directory, "state/agent/state.json"), "utf8")) as SupervisorState;
}

/** Run a supervisor under test; always stops it, even when expectations fail. */
async function supervised(
  children: Array<{ name: string; start: string }>,
  body: (supervisor: Supervisor) => Promise<void>,
): Promise<string[]> {
  const collected: string[] = [];
  const supervisor = new Supervisor({
    children, statePath: join(directory, "state/agent/state.json"),
    waitCapMs: 15, onLog: line => { collected.push(line); logs.push(line); },
  });
  const running = supervisor.run();
  try {
    await body(supervisor);
  } finally {
    supervisor.requestStop();
    await running;
  }
  return collected;
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "agent-bridges-"));
  directories.push(directory);
  logs.length = 0;
  await mkdir(join(directory, "state/agent"), { recursive: true });
});

afterAll(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("Supervisor", () => {
  test("starts both children, forwards tagged logs, and writes live state", async () => {
    const stable = await script("stable.zsh", 'echo "hello from stdout"\nexec /bin/sleep 60');
    const quiet = await script("quiet.zsh", "exec /bin/sleep 60");
    await supervised([{ name: "spectrum", start: stable }, { name: "telegram", start: quiet }], async () => {
      await new Promise(resolve => setTimeout(resolve, 150));
      const state = readState();
      expect(state.children.spectrum).toMatchObject({ state: "running", restarts: 0 });
      expect(state.children.telegram).toMatchObject({ state: "running", restarts: 0 });
      expect(typeof state.children.spectrum.pid).toBe("number");
      expect(state.children.telegram.pid).not.toBe(state.children.spectrum.pid);
      const tagged = logs.map(line => JSON.parse(line) as { child: string; channel: string; line: string });
      expect(tagged).toContainEqual(expect.objectContaining({ child: "spectrum", channel: "stdout", line: "hello from stdout" }));
    });
    const stopped = readState();
    expect(stopped.children.spectrum).toMatchObject({ state: "stopped" });
    expect(stopped.children.telegram).toMatchObject({ state: "stopped" });
    expect(existsSync(join(directory, "state/agent/supervisor.lock"))).toBe(false);
  });

  test("a crashing child backs off, restarts, and climbs the backoff ladder", async () => {
    const crash = await script("crash.zsh", 'echo "going down" >&2\nexit 3');
    const collected = await supervised([{ name: "telegram", start: crash }], async () => {
      await new Promise(resolve => setTimeout(resolve, 600));
    });
    const state = readState();
    expect(state.children.telegram.restarts).toBeGreaterThanOrEqual(2);
    // Every crash is logged with its own code. The final state may instead hold
    // the SIGTERM of a restart the stop interrupted, so it is not asserted here.
    const exits = collected.filter(line => line.includes("child-exited"))
      .map(line => (JSON.parse(line) as { code: number | string }).code);
    expect(exits.length).toBeGreaterThanOrEqual(2);
    expect(new Set(exits)).toEqual(new Set([3]));
    expect([3, 143]).toContain(state.children.telegram.lastExitCode!);
    // Restart waits double from the 2s floor; a crashed child never gets an instant retry.
    const waits = collected.filter(line => line.includes("child-restart-scheduled"))
      .map(line => (JSON.parse(line) as { waitMs: number }).waitMs);
    expect(waits[0]).toBe(2_000);
    expect(waits[1]).toBe(4_000);
    const stderr = collected.map(line => JSON.parse(line) as { channel: string; line: string });
    expect(stderr).toContainEqual(expect.objectContaining({ channel: "stderr", line: "going down" }));
  });

  test("a missing child script is a backoff event, not a supervisor crash", async () => {
    await supervised([{ name: "spectrum", start: join(directory, "missing.zsh") }], async () => {
      await new Promise(resolve => setTimeout(resolve, 150));
      const state = readState();
      expect(["backoff", "running"]).toContain(state.children.spectrum.state);
      expect(state.children.spectrum.restarts).toBeGreaterThanOrEqual(1);
    });
  });

  test("only one supervisor may hold the lock", async () => {
    const stable = await script("stable.zsh", "exec /bin/sleep 60");
    const statePath = join(directory, "state/agent/state.json");
    const first = new Supervisor({ children: [{ name: "spectrum", start: stable }], statePath, waitCapMs: 15 });
    const running = first.run();
    await new Promise(resolve => setTimeout(resolve, 150));
    const second = new Supervisor({ children: [{ name: "spectrum", start: stable }], statePath, waitCapMs: 15 });
    await expect(second.run()).rejects.toThrow("already running");
    first.requestStop();
    await running;
  });

  test("default children point at the installed bridge runtimes", () => {
    const children = defaultChildren("/Users/tester");
    expect(children).toEqual([
      { name: "spectrum", start: "/Users/tester/.local/share/spectrum-bridge/start.zsh" },
      { name: "telegram", start: "/Users/tester/.local/share/telegram-bridge/start.zsh" },
    ]);
  });
});

describe("CLI status", () => {
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

  test("projects running state for a live supervisor and exits 0", async () => {
    const statePath = join(directory, "state/agent/state.json");
    await writeFile(statePath, JSON.stringify({
      supervisorPid: process.pid, startedAt: Date.now(), updatedAt: Date.now(),
      children: { spectrum: { pid: 111, state: "running", restarts: 0, lastExitCode: null, lastExitAt: null, nextStartAt: null } },
    }));
    const child = Bun.spawn([process.execPath, "run", cli, "status"], { env: { AGENT_BRIDGES_STATE: statePath }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const status = JSON.parse(stdout);
    expect(status.running).toBe(true);
    expect(status.children.spectrum).toEqual({ pid: 111, state: "running", restarts: 0, lastExitCode: null });
  });

  test.each([
    { name: "dead supervisor pid", stale: false },
    { name: "stale state file", stale: true },
  ])("flags %s and exits 1", async ({ stale }) => {
    const statePath = join(directory, "state/agent/state.json");
    await writeFile(statePath, JSON.stringify({
      supervisorPid: 999_999, startedAt: 1,
      updatedAt: stale ? 1 : Date.now(),
      children: {},
    }));
    const child = Bun.spawn([process.execPath, "run", cli, "status"], { env: { AGENT_BRIDGES_STATE: statePath }, stdout: "pipe", stderr: "pipe" });
    const [stdout, , exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout).running).toBe(false);
  });

  test("reports missing state and unknown commands as sanitized errors", async () => {
    for (const [args, env, error] of [
      [["status"], { AGENT_BRIDGES_STATE: join(directory, "missing.json") }, "Supervisor state is unavailable; is the agent-bridges service running?"],
      [["explode"], undefined, "Expected status"],
    ] as Array<[string[], Record<string, string> | undefined, string]>) {
      const child = Bun.spawn([process.execPath, "run", cli, ...args], {
        env: { ...(env ?? { AGENT_BRIDGES_STATE: join(directory, "state.json") }) }, stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(JSON.parse(stderr)).toEqual({ error });
    }
  });
});
