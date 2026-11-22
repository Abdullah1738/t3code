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
  private startedAt = 0;
  private reportedAt = 0;
  constructor(private readonly thresholds = { high: LOAD_HIGH, low: LOAD_LOW, dwellMs: LOAD_DWELL_MS }) {}
  sample(load: number, at: number): boolean {
    const crossing = this.high ? load < this.thresholds.low : load >= this.thresholds.high;
    if (!crossing) this.since = undefined;
    else {
      this.since ??= at;
      if (at - this.since >= this.thresholds.dwellMs) {
        this.high = !this.high;
        this.since = undefined;
        if (this.high) this.startedAt = this.reportedAt = at;
      }
    }
    return this.high;
  }

  report(at: number): number | undefined {
    if (!this.high || at - this.reportedAt < 3600_000) return;
    this.reportedAt = at;
    return Math.max(0, at - this.startedAt);
  }
}

export type CheckLane = "fast" | "slow";
export const checkLane = (lastRunMs: number | undefined): CheckLane =>
  lastRunMs !== undefined && Number.isFinite(lastRunMs) && lastRunMs >= 0 && lastRunMs < FAST_CHECK_MS ? "fast" : "slow";

export function checkClassification(lastRunMs: number | undefined, recent: number[] | undefined) {
  const history = recentCheckRuntimes(recent, undefined);
  const runtimes = history.length ? history : recentCheckRuntimes(undefined, lastRunMs);
  const recentMinMs = runtimes.length ? Math.min(...runtimes) : undefined;
  const lane: CheckLane = recentMinMs !== undefined && recentMinMs < FAST_CHECK_MS ? "fast" : "slow";
  const reason = lane === "fast" ? checkLane(lastRunMs) === "fast" ? "fast" : "fast:sticky"
    : recentMinMs === undefined ? "slow:new" : "slow:recent";
  return { lane, reason, recentMinMs };
}

export function recentCheckRuntimes(recent: number[] | undefined, lastRunMs: number | undefined): number[] {
  return [...(Array.isArray(recent) ? recent : []), ...(lastRunMs === undefined ? [] : [lastRunMs])]
    .filter(ms => Number.isFinite(ms) && ms >= 0).slice(-3);
}

export function isMounted(path: string): boolean {
  try { return statSync(path).dev !== statSync(dirname(path)).dev; } catch { toolError("runner", "watch.mount_stat_failed"); return false; }
}

export type SlotRequest = { watcher: string; run?: string; operation?: "check" | "pending"; dueAt?: number; intervalMs?: number; lane?: CheckLane; recentMinMs?: number };
export type SlotTiming = { slotWaitMs: number; slotQueueDepth: number; slotActiveAtEnqueue: number; startLateMs: number; slotLane?: CheckLane };
type Holder = { watcher: string; elapsedMs: number };
export type SlotEvent =
  | { name: "slot.wait"; request: SlotRequest; waitMs: number; holders: Holder[] }
  | { name: "slot.backlog"; depth: number; oldestWaitMs: number; active: number; cap: number; holders: Holder[] }
  | { name: "slot.hold"; request: SlotRequest; durationMs: number }
  | { name: "slot.overrun"; request: SlotRequest; elapsedMs: number }
  | { name: "slot.busy"; durationMs: number };
type Waiter = { resolve: (timing: SlotTiming) => void; request: SlotRequest; at: number; depth: number; active: number; warned: boolean; overrunLogged: boolean; lane: CheckLane | "overrun"; borrowed: boolean };

/** Recheck the cap on every admission; lowering it never interrupts an admitted check. */
export class CheckSlots {
  private active = 0;
  private fastActive = 0;
  private overrunActive = 0;
  private borrowedFast = false;
  private waiters: Waiter[] = [];
  private holders = new Map<Waiter, { at: number; accountedAt: number }>();
  private backlogAt: number | undefined;
  private busyAt: number | undefined;
  private usageAt: number | undefined;
  constructor(private readonly cap: () => number, private readonly telemetry: { now?: () => number; emit?: (event: SlotEvent) => void } = {}, private readonly fastCap = 0, private readonly borrowFast: () => boolean = () => false) {}

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
        if (!this.overrunActive && (!this.borrowedFast || waiter.borrowed)) {
          waiter.lane = "overrun";
          this.fastActive--;
          if (waiter.borrowed) this.borrowedFast = false;
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
      let index = this.waiters.findIndex(waiter => waiter.lane === "fast" ? this.fastActive < this.fastCap : this.active < cap);
      if (index < 0 && this.borrowFast() && !this.borrowedFast && !this.overrunActive && this.fastActive === 0 && this.fastCap > 0) {
        // Preserve slow FIFO admissions and genuine fast work. Only otherwise
        // idle reserved capacity serves overdue 5–10 minute checks.
        // Require runtimes well beyond the fast threshold, leaving brief overruns
        // to sticky classification. Old state can qualify from last_run_ms.
        // An older fast holder must retain access to overflow at its own deadline.
        let deadline = Infinity;
        for (let i = 0; i < this.waiters.length; i++) {
          const request = this.waiters[i]!.request;
          if (request.recentMinMs === undefined || !Number.isFinite(request.recentMinMs) || request.recentMinMs < FAST_CHECK_MS * 2
            || request.operation !== "check" || request.dueAt === undefined || !Number.isFinite(request.dueAt) || request.dueAt > at
            || request.intervalMs === undefined || !Number.isFinite(request.intervalMs) || request.intervalMs < 300_000 || request.intervalMs > 600_000) continue;
          const candidate = request.dueAt + request.intervalMs;
          if (candidate < deadline) { deadline = candidate; index = i; }
        }
        if (index >= 0) {
          this.waiters[index]!.lane = "fast";
          this.waiters[index]!.request.lane = "fast";
          this.waiters[index]!.borrowed = this.borrowedFast = true;
        }
      }
      if (index < 0) break;
      const waiter = this.waiters.splice(index, 1)[0]!;
      if (waiter.lane === "fast") this.fastActive++;
      else this.active++;
      this.holders.set(waiter, { at, accountedAt: at });
      this.usageAt ??= at;
      waiter.resolve({ slotWaitMs: Math.max(0, at - waiter.at), slotQueueDepth: waiter.depth, slotActiveAtEnqueue: waiter.active,
        slotLane: waiter.lane === "overrun" ? "fast" : waiter.lane,
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
        lane: this.fastCap > 0 && request.lane === "fast" ? "fast" : "slow", borrowed: false };
      this.waiters.push(waiter);
      this.drain();
    });
    try { return await fn(timing); } finally {
      const at = this.now(), holder = this.holders.get(waiter!);
      if (holder && at > holder.accountedAt) this.emit({ name: "slot.hold", request, durationMs: at - holder.accountedAt });
      this.holders.delete(waiter!);
      if (waiter!.lane === "fast") { this.fastActive--; if (waiter!.borrowed) this.borrowedFast = false; }
      else if (waiter!.lane === "overrun") this.overrunActive--;
      else this.active--;
      this.drain();
    }
  }
}
