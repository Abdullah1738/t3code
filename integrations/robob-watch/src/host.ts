import { statSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { dirname } from "node:path";
import { CHECK_TIMEOUT_MS, type Watcher } from "./lib.ts";

export const LOAD_HIGH = Number(process.env.ROBOB_WATCH_LOAD_HIGH ?? 1.5);
export const LOAD_GRACE_MS = Number(process.env.ROBOB_WATCH_LOAD_GRACE_MS ?? 60 * 60_000);
export const SSD_PATH = process.env.ROBOB_WATCH_SSD_PATH ?? "/Volumes/ExternalSSD";

export function hostLoad(): number {
  const override = process.env.ROBOB_WATCH_LOAD_OVERRIDE;
  return override !== undefined ? Number(override) : loadavg()[0] / Math.max(cpus().length, 1);
}

export function checkTimeout(watcher: Watcher, load: number): number {
  const base = watcher.timeout_s === undefined ? CHECK_TIMEOUT_MS : watcher.timeout_s * 1_000;
  return load >= LOAD_HIGH ? Math.min(base * 3, 300_000) : base;
}

export function checkSlotCap(load: number): number {
  const normal = Number(process.env.ROBOB_WATCH_MAX_CONCURRENT ?? 6);
  return load >= LOAD_HIGH ? Math.min(normal, Number(process.env.ROBOB_WATCH_MAX_CONCURRENT_UNDER_LOAD ?? 2)) : normal;
}

export function isMounted(path: string): boolean {
  try { return statSync(path).dev !== statSync(dirname(path)).dev; } catch { return false; }
}

/** Recheck the cap on every admission; lowering it never interrupts an admitted check. */
export class CheckSlots {
  private active = 0;
  private waiters: (() => void)[] = [];
  constructor(private readonly cap: () => number) {}

  drain(): void {
    while (this.waiters.length && this.active < this.cap()) {
      this.active += 1;
      this.waiters.shift()!();
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await new Promise<void>(resolve => { this.waiters.push(resolve); this.drain(); });
    try { return await fn(); } finally { this.active -= 1; this.drain(); }
  }
}
