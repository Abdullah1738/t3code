import { toolError } from "./toollog.ts";
import { statSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { dirname } from "node:path";
import { CHECK_TIMEOUT_MS, type Watcher } from "./lib.ts";

export const LOAD_HIGH = Number(process.env.ROBOB_WATCH_LOAD_HIGH ?? 1.5);
export const LOAD_GRACE_MS = Number(process.env.ROBOB_WATCH_LOAD_GRACE_MS ?? 60 * 60_000);
export const LOAD_LOW = Number(process.env.ROBOB_WATCH_LOAD_LOW ?? 1.2);
export const LOAD_DWELL_MS = Number(process.env.ROBOB_WATCH_LOAD_DWELL_MS ?? 60_000);
export const FAST_CHECK_MS = 10_000;
export const SSD_PATH = process.env.ROBOB_WATCH_SSD_PATH ?? "/Volumes/ExternalSSD";

export function hostLoad(): number {
  const override = process.env.ROBOB_WATCH_LOAD_OVERRIDE;
  return override !== undefined ? Number(override) : loadavg()[0] / Math.max(cpus().length, 1);
}

export function checkTimeout(watcher: Watcher, load: number): number {
  const base = watcher.timeout_s === undefined ? CHECK_TIMEOUT_MS : watcher.timeout_s * 1_000;
  return load >= LOAD_HIGH ? Math.min(base * 3, 300_000) : base;
}

export function checkSlotCap(load: number | boolean): number {
  const normal = Number(process.env.ROBOB_WATCH_MAX_CONCURRENT ?? 6);
  return (typeof load === "boolean" ? load : load >= LOAD_HIGH) ? Math.min(normal, Number(process.env.ROBOB_WATCH_MAX_CONCURRENT_UNDER_LOAD ?? 2)) : normal;
}

export class LoadMode {
  high = false;
  private since: number | undefined;
  constructor(private readonly thresholds = { high: LOAD_HIGH, low: LOAD_LOW, dwellMs: LOAD_DWELL_MS }) {}
  sample(load: number, at: number): boolean {
    const crossing = this.high ? load < this.thresholds.low : load >= this.thresholds.high;
    if (!crossing) this.since = undefined;
    else {
      this.since ??= at;
      if (at - this.since >= this.thresholds.dwellMs) {
        this.high = !this.high;
        this.since = undefined;
      }
    }
    return this.high;
  }
}

export type CheckLane = "fast" | "slow";
export const checkLane = (lastRunMs: number | undefined): CheckLane =>
  lastRunMs !== undefined && Number.isFinite(lastRunMs) && lastRunMs >= 0 && lastRunMs < FAST_CHECK_MS ? "fast" : "slow";

export function isMounted(path: string): boolean {
  try { return statSync(path).dev !== statSync(dirname(path)).dev; } catch { toolError("runner", "watch.mount_stat_failed"); return false; }
}

export type SlotRequest = { watcher: string; run?: string; operation?: "check" | "pending"; dueAt?: number; intervalMs?: number; lane?: CheckLane };
export type SlotTiming = { slotWaitMs: number; slotQueueDepth: number; slotActiveAtEnqueue: number; startLateMs: number };
type Holder = { watcher: string; elapsedMs: number };
export type SlotEvent =
  | { name: "slot.wait"; request: SlotRequest; waitMs: number; holders: Holder[] }
  | { name: "slot.backlog"; depth: number; oldestWaitMs: number; active: number; cap: number; holders: Holder[] }
  | { name: "slot.hold"; request: SlotRequest; durationMs: number }
  | { name: "slot.overrun"; request: SlotRequest; elapsedMs: number }
  | { name: "slot.busy"; durationMs: number };
type Waiter = { resolve: (timing: SlotTiming) => void; request: SlotRequest; at: number; depth: number; active: number; warned: boolean; overrunLogged: boolean; lane: CheckLane | "overrun" };

/** Recheck the cap on every admission; lowering it never interrupts an admitted check. */
export class CheckSlots {
  private active = 0;
  private fastActive = 0;
  private overrunActive = 0;
  private waiters: Waiter[] = [];
  private holders = new Map<Waiter, { at: number; accountedAt: number }>();
  private backlogAt: number | undefined;
  private busyAt: number | undefined;
  private usageAt: number | undefined;
  constructor(private readonly cap: () => number, private readonly telemetry: { now?: () => number; emit?: (event: SlotEvent) => void } = {}, private readonly fastCap = 0) {}

  private now(): number { return (this.telemetry.now ?? Date.now)(); }
  private emit(event: SlotEvent): void {
    try { this.telemetry.emit?.(event); } catch { toolError("runner", "slot.telemetry_failed"); }
  }
  private snapshot(at: number): Holder[] {
    return [...this.holders].map(([waiter, holder]) => ({ watcher: waiter.request.watcher, elapsedMs: Math.max(0, at - holder.at) }));
  }
  private busy(at: number, cap: number): void {
    if (this.active >= cap && this.fastActive >= this.fastCap) this.busyAt ??= at;
    else if (this.busyAt !== undefined) {
      if (at > this.busyAt) this.emit({ name: "slot.busy", durationMs: at - this.busyAt });
      this.busyAt = undefined;
    }
  }
  private usage(at: number): void {
    for (const [waiter, holder] of this.holders) {
      if (at > holder.accountedAt) this.emit({ name: "slot.hold", request: waiter.request, durationMs: at - holder.accountedAt });
      holder.accountedAt = at;
    }
    if (this.busyAt !== undefined) {
      if (at > this.busyAt) this.emit({ name: "slot.busy", durationMs: at - this.busyAt });
      this.busyAt = at;
    }
    this.usageAt = at;
  }

  drain(): void {
    const at = this.now(), cap = this.cap();
    for (const [waiter, holder] of this.holders) {
      if (waiter.lane === "fast" && at - holder.at >= FAST_CHECK_MS) {
        if (!waiter.overrunLogged) {
          waiter.overrunLogged = true;
          this.emit({ name: "slot.overrun", request: waiter.request, elapsedMs: at - holder.at });
        }
        // One overflow holder frees fast capacity without taking a FIFO slow
        // slot. Further overruns retain their fast slot until overflow clears.
        if (!this.overrunActive) {
          waiter.lane = "overrun";
          this.fastActive--;
          this.overrunActive++;
        }
      }
    }
    this.busy(at, cap);
    for (const waiter of this.waiters) {
      if (!waiter.warned && at - waiter.at >= 30_000) {
        waiter.warned = true;
        this.emit({ name: "slot.wait", request: waiter.request, waitMs: at - waiter.at, holders: this.snapshot(at) });
      }
    }
    for (;;) {
      const index = this.waiters.findIndex(waiter => waiter.lane === "fast" ? this.fastActive < this.fastCap : this.active < cap);
      if (index < 0) break;
      const waiter = this.waiters.splice(index, 1)[0]!;
      if (waiter.lane === "fast") this.fastActive++;
      else this.active++;
      this.holders.set(waiter, { at, accountedAt: at });
      this.usageAt ??= at;
      waiter.resolve({ slotWaitMs: Math.max(0, at - waiter.at), slotQueueDepth: waiter.depth, slotActiveAtEnqueue: waiter.active,
        startLateMs: waiter.request.dueAt === undefined ? 0 : Math.max(0, at - waiter.request.dueAt) });
    }
    this.busy(at, cap);
    if (!this.waiters.length) this.backlogAt = undefined;
    else {
      this.backlogAt ??= at;
      if (at - this.backlogAt >= 60_000) {
        this.emit({ name: "slot.backlog", depth: this.waiters.length, oldestWaitMs: Math.max(...this.waiters.map(waiter => at - waiter.at)), active: this.active + this.fastActive + this.overrunActive, cap: cap + this.fastCap, holders: this.snapshot(at) });
        this.backlogAt = at;
      }
    }
    // Flush partial holdings across UTC boundaries and while a check is still running.
    if (this.usageAt !== undefined && at - this.usageAt >= 60_000) this.usage(at);
  }

  async run<T>(fn: (timing: SlotTiming) => Promise<T>, request: SlotRequest = { watcher: "unknown" }): Promise<T> {
    let waiter: Waiter;
    const timing = await new Promise<SlotTiming>(resolve => {
      waiter = { resolve, request, at: this.now(), depth: this.waiters.length, active: this.active + this.fastActive + this.overrunActive, warned: false, overrunLogged: false,
        lane: this.fastCap > 0 && request.lane === "fast" ? "fast" : "slow" };
      this.waiters.push(waiter);
      this.drain();
    });
    try { return await fn(timing); } finally {
      const at = this.now(), holder = this.holders.get(waiter!);
      if (holder && at > holder.accountedAt) this.emit({ name: "slot.hold", request, durationMs: at - holder.accountedAt });
      this.holders.delete(waiter!);
      if (waiter!.lane === "fast") this.fastActive--;
      else if (waiter!.lane === "overrun") this.overrunActive--;
      else this.active--;
      this.drain();
    }
  }
}
