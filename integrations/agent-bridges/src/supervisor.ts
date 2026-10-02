import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { acquireLock } from "./lock.ts";

export type ChildSpec = { name: string; start: string };
export type ChildState = {
  pid: number | null;
  state: "starting" | "running" | "backoff" | "stopped";
  restarts: number;
  lastExitCode: number | null;
  lastExitAt: number | null;
  nextStartAt: number | null;
};
export type SupervisorState = {
  supervisorPid: number;
  startedAt: number;
  updatedAt: number;
  children: Record<string, ChildState>;
};

const MIN_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
const UPTIME_RESET_MS = 5 * 60_000;
const STOP_GRACE_MS = 10_000;

/** Default layout: both bridge runtimes live under ~/.local/share with start.zsh entrypoints. */
export function defaultChildren(home: string): ChildSpec[] {
  return [
    { name: "spectrum", start: join(home, ".local/share/spectrum-bridge/start.zsh") },
    { name: "telegram", start: join(home, ".local/share/telegram-bridge/start.zsh") },
  ];
}

export type SupervisorOptions = {
  children: ChildSpec[];
  statePath: string;
  /** Test seam: cap interruptible waits (backoff, stop grace) at this many ms. */
  waitCapMs?: number;
  onLog?: (line: string) => void;
};

function logLine(line: string): void {
  console.log(line);
}

class Child {
  state: ChildState = { pid: null, state: "starting", restarts: 0, lastExitCode: null, lastExitAt: null, nextStartAt: null };
  private process?: Bun.Subprocess<"ignore", "pipe", "pipe">;
  private startedAt = 0;
  private backoffMs = MIN_BACKOFF_MS;

  constructor(
    private readonly spec: ChildSpec,
    private readonly sink: (line: string) => void,
    private readonly notify: () => void,
  ) {}

  get name(): string { return this.spec.name; }

  async start(): Promise<void> {
    this.state = { ...this.state, state: "starting", pid: null, nextStartAt: null };
    const child = Bun.spawn(["/bin/zsh", "-f", this.spec.start], {
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    this.process = child;
    this.startedAt = Date.now();
    this.state = { ...this.state, pid: child.pid, state: "running" };
    this.notify();
    this.pump(child.stdout as ReadableStream<Uint8Array>, "stdout");
    this.pump(child.stderr as ReadableStream<Uint8Array>, "stderr");
    this.state = { ...this.state, pid: null, lastExitCode: await child.exited, lastExitAt: Date.now() };
    this.notify();
  }

  get uptime(): number {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }

  isRunning(): boolean {
    return this.state.state === "running" && this.state.pid !== null;
  }

  nextBackoff(): number {
    // A long clean run resets the ladder; short crashes climb it.
    if (this.uptime >= UPTIME_RESET_MS) this.backoffMs = MIN_BACKOFF_MS;
    const wait = this.backoffMs;
    this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs * 2);
    this.state = { ...this.state, restarts: this.state.restarts + 1 };
    return wait;
  }

  scheduleBackoff(wait: number): void {
    this.state = { ...this.state, state: "backoff", nextStartAt: Date.now() + wait };
  }

  markStopped(): void {
    this.state = { ...this.state, state: "stopped", pid: null, nextStartAt: null };
  }

  terminate(): void {
    this.process?.kill("SIGTERM");
  }

  kill(): void {
    this.process?.kill("SIGKILL");
  }

  private async pump(stream: ReadableStream<Uint8Array>, channel: string): Promise<void> {
    try {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (line.trim()) this.sink(JSON.stringify({ at: new Date().toISOString(), child: this.name, channel, line: line.slice(0, 2_000) }));
        }
      }
    } catch { /* A closed pipe must never take the supervisor down. */ }
  }
}

export class Supervisor {
  private readonly children: Child[];
  private readonly state: SupervisorState;
  /** Interruptible wait so shutdown never sits out a long backoff. */
  private readonly sleepers = new Set<() => void>();
  private persistChain: Promise<void> = Promise.resolve();
  private stopping = false;
  private stopped = false;

  constructor(private readonly options: SupervisorOptions) {
    const emit = (line: string) => options.onLog ? options.onLog(line) : logLine(line);
    this.children = options.children.map(spec => new Child(spec, emit, () => { void this.persist(); }));
    this.state = { supervisorPid: process.pid, startedAt: Date.now(), updatedAt: Date.now(),
      children: Object.fromEntries(this.children.map(child => [child.name, child.state])) };
  }

  private log(event: string, extra?: Record<string, string | number>): void {
    const line = JSON.stringify({ at: new Date().toISOString(), event, ...extra });
    this.options.onLog ? this.options.onLog(line) : logLine(line);
  }

  /** Interruptible sleep: requestStop wakes every waiter immediately. */
  private wait(ms: number): Promise<void> {
    return new Promise<void>(resolve => {
      const wake = () => {
        clearTimeout(timer);
        this.sleepers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, Math.min(ms, this.options.waitCapMs ?? ms));
      this.sleepers.add(wake);
    });
  }

  /** Signal-safe shutdown: children get SIGTERM, then SIGKILL after the grace period. */
  requestStop(): void {
    if (this.stopping) return;
    this.stopping = true;
    for (const wake of this.sleepers) wake();
    for (const child of this.children) child.terminate();
  }

  /** Serialized writes: the temp file is only ever owned by one persist at a time. */
  private persist(): Promise<void> {
    this.persistChain = this.persistChain.then(async () => {
      this.state.updatedAt = Date.now();
      this.state.children = Object.fromEntries(this.children.map(child => [child.name, child.state]));
      const temp = `${this.options.statePath}.tmp`;
      await writeFile(temp, JSON.stringify(this.state), { mode: 0o600 });
      await rename(temp, this.options.statePath);
    });
    return this.persistChain;
  }

  private async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.log("supervisor-stopping");
    for (const child of this.children) child.terminate();
    const deadline = Date.now() + STOP_GRACE_MS;
    while (Date.now() < deadline && this.children.some(child => child.isRunning())) await this.wait(20);
    for (const child of this.children) if (child.isRunning()) {
      this.log("child-force-killed", { child: child.name });
      child.kill();
    }
    for (const child of this.children) child.markStopped();
    await this.persist();
  }

  async run(): Promise<void> {
    const stateDirectory = dirname(this.options.statePath);
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await chmod(stateDirectory, 0o700).catch(() => {});
    const releaseLock = acquireLock(join(stateDirectory, "supervisor.lock"));
    try {
      await this.persist();
      const loops = this.children.map(async child => {
        while (!this.stopping) {
          await child.start().catch(() => {
            child.state = { ...child.state, lastExitCode: null, lastExitAt: Date.now() };
          });
          if (this.stopping) break;
          const wait = child.nextBackoff();
          this.log("child-exited", { child: child.name, code: child.state.lastExitCode ?? "none" });
          if (this.stopping) break;
          child.scheduleBackoff(wait);
          await this.persist();
          this.log("child-restart-scheduled", { child: child.name, waitMs: wait });
          await this.wait(wait);
        }
      });
      this.log("supervisor-started", { children: this.children.map(child => child.name).join(",") });
      await Promise.all(loops);
      await this.stop();
    } finally {
      releaseLock();
      await rm(join(stateDirectory, "supervisor.lock"), { force: true }).catch(() => {});
    }
  }
}

if (import.meta.main) {
  const home = process.env.HOME ?? "";
  const children = process.env.AGENT_BRIDGES_CHILDREN
    ? JSON.parse(process.env.AGENT_BRIDGES_CHILDREN) as ChildSpec[]
    : defaultChildren(home);
  for (const spec of children) {
    if (!spec.name || !/^[a-z][a-z0-9-]{0,30}$/.test(spec.name) || !spec.start?.startsWith("/")) {
      throw new Error("Invalid child specification");
    }
  }
  const supervisor = new Supervisor({
    children,
    statePath: process.env.AGENT_BRIDGES_STATE ?? join(home, ".config/agent-bridges/state.json"),
  });
  process.once("SIGTERM", () => supervisor.requestStop());
  process.once("SIGINT", () => supervisor.requestStop());
  await supervisor.run().catch(error => {
    logLine(JSON.stringify({ at: new Date().toISOString(), event: "supervisor-start-failed",
      message: (error as Error).message.slice(0, 128) }));
    process.exit(1);
  });
}
