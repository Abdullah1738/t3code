import { spawn } from "node:child_process";
import type { Watcher } from "./lib.ts";

export function processGroupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

const psStatuses = new Set(["ps pending", "ps unavailable", "ps timed out after 3s", "ps: no group rows", "ps: no safe group rows"]);

export function sanitizeGroupState(raw: string): string {
  if (psStatuses.has(raw)) return raw;
  const rows: string[] = [];
  for (const line of raw.slice(0, 4_000).split(/\r?\n|\s+\|\s+/).slice(0, 64)) {
    const row = line.trim().match(/^(\d{1,10})\s+([A-Za-z+<>NnsLlEXWPTIUZSRD-]{1,16})\s+([A-Za-z0-9_.?:*-]{1,100})\s+([\d:.-]{1,32})\s+(\S+)/);
    if (!row) continue;
    const [, pid, stat, wchan, elapsed, executable] = row;
    const name = executable!.split("/").at(-1)!;
    // Arguments can contain credentials or message bodies. Retain only a bounded executable basename.
    const safeName = /^[A-Za-z0-9_.-]{1,80}$/.test(name) ? name : "[executable]";
    rows.push(`${pid} ${stat} ${wchan} ${elapsed} ${safeName}`);
  }
  return rows.join(" | ").slice(0, 4_000) || "ps: no safe group rows";
}

export function captureGroupState(pgid: number): Promise<string> {
  return new Promise(resolve => {
    let output = "", done = false;
    // ps must not inherit a cwd on the volume whose opens may be stuck.
    const child = spawn("/bin/ps", ["-o", "pid,stat,wchan,etime,comm", "-g", String(pgid)], {
      cwd: "/", stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" },
    });
    const finish = (fallback: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      resolve(output.trim() ? sanitizeGroupState(output) : fallback);
    };
    child.stdout.on("data", chunk => { output = (output + chunk).slice(0, 4_000); });
    child.stderr.on("data", () => {});
    child.once("error", () => finish("ps unavailable"));
    child.once("close", () => finish("ps: no group rows"));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish("ps timed out after 3s");
    }, 3_000);
  });
}

export type CheckGroup = {
  watcher: Watcher; pgid: number; pid: number; command: string;
  closed: Promise<void>; release: () => void; killedAt?: number;
  stuck: boolean; diagnostic: string; nextLogAt: number; alerted: boolean; alerting: boolean;
};

export class CheckGroups {
  readonly groups = new Map<number, CheckGroup>();
  private lastGlobalAt = -Infinity;

  constructor(
    readonly log: (id: string | null, message: string) => void,
    readonly emit: (name: string, group: CheckGroup, diagnostic: string) => void,
    readonly capture = captureGroupState,
  ) {}

  // One in-memory registry also owns shutdown. Persisting it would add file opens to the FS-stall path;
  // runner restarts use #96's bounded group cleanup rather than trusting reused pgids from disk.
  track(watcher: Watcher, pid: number): CheckGroup {
    let release!: () => void;
    const closed = new Promise<void>(resolve => { release = resolve; });
    const group = { watcher, pgid: pid, pid, command: watcher.check, closed, release,
      stuck: false, diagnostic: "ps pending", nextLogAt: 0, alerted: false, alerting: false };
    this.groups.set(pid, group);
    return group;
  }

  isAlive(pgid: number): boolean { return processGroupAlive(pgid); }

  reap(group: CheckGroup, at = Date.now()): boolean {
    if (this.groups.get(group.pgid) !== group) return true;
    if (this.isAlive(group.pgid)) return false;
    this.groups.delete(group.pgid);
    group.release();
    if (group.stuck) {
      this.log(null, `stuck group ${group.pgid} exited after ${Math.floor((at - group.killedAt!) / 1000)}s watcher=${group.watcher.id}`);
      this.emit("watch.stuck_exited", group, group.diagnostic);
    }
    return true;
  }

  markStuck(group: CheckGroup): void {
    if (this.reap(group)) return;
    group.stuck = true;
    void this.capture(group.pgid).catch(() => "ps unavailable").then(diagnostic => {
      if (this.groups.get(group.pgid) !== group) return;
      group.diagnostic = sanitizeGroupState(diagnostic);
      this.log(null, `check group ${group.pgid} not reaped after SIGKILL watcher=${group.watcher.id}: ${group.diagnostic}`);
      this.emit("watch.stuck_group", group, group.diagnostic);
    });
  }

  previous(id: string, at = Date.now()): CheckGroup | undefined {
    for (const group of this.groups.values()) {
      if (group.watcher.id === id && group.killedAt !== undefined && !this.reap(group, at)) return group;
    }
  }

  stuck(at = Date.now()): CheckGroup[] {
    return [...this.groups.values()].filter(group => group.stuck && !this.reap(group, at));
  }

  globalWarning(at = Date.now()): number | undefined {
    const count = this.stuck(at).length;
    if (count < 5 || at - this.lastGlobalAt < 10 * 60_000) return;
    this.lastGlobalAt = at;
    return count;
  }
}
