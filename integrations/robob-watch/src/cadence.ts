import { heldByMaintenance, type Maintenance, type State, type Watcher } from "./lib.ts";

export function syncCadenceSuspension(watcher: Watcher, state: State, at: number, maintenance: Maintenance | undefined, ssdMounted: boolean): boolean {
  const indefinite = !!(watcher.paused || state.failure_paused_at || (!ssdMounted && watcher.depends?.includes("ssd")));
  const until = heldByMaintenance(watcher, maintenance) ? Date.parse(maintenance!.until) : undefined;
  return suspendCadence(state, at, indefinite || until !== undefined, indefinite ? undefined : until);
}

export function suspendCadence(state: State, at: number, suspended: boolean, until?: number): boolean {
  const initialized = !!state.cadence;
  const cadence = state.cadence ??= { since: at };
  let changed = !initialized;
  if (cadence.suspendedAt !== undefined && (!suspended || cadence.suspendedUntil !== until || (cadence.suspendedUntil ?? Infinity) <= at)) {
    cadence.suspendedMs = (cadence.suspendedMs ?? 0) + Math.max(0, Math.min(at, cadence.suspendedUntil ?? at) - cadence.suspendedAt);
    delete cadence.suspendedAt;
    delete cadence.suspendedUntil;
    changed = true;
  }
  if (suspended && cadence.suspendedAt === undefined) {
    cadence.suspendedAt = at;
    if (until !== undefined) cadence.suspendedUntil = until;
    return true;
  }
  return changed;
}

function elapsed(cadence: NonNullable<State["cadence"]>, at: number): number {
  const currentHold = cadence.suspendedAt === undefined ? 0 : Math.max(0, Math.min(at, cadence.suspendedUntil ?? at) - cadence.suspendedAt);
  return Math.max(0, at - (cadence.lastCompleted ?? cadence.since) - (cadence.suspendedMs ?? 0) - currentHold);
}

export function cadenceStale(watcher: Watcher, state: State, at: number) {
  if (!watcher.urgent) return;
  const cadence = state.cadence ??= { since: at };
  if (cadence.suspendedAt !== undefined && (cadence.suspendedUntil ?? Infinity) > at) return;
  const staleMs = elapsed(cadence, at);
  if (staleMs <= Math.max(3 * watcher.interval_s * 1000, 30 * 60_000)) return;
  return { staleMs, lastOutcome: cadence.lastOutcome ?? "queued" };
}

export function completeCadence(state: State, at: number, outcome: "fire" | "no_change", queuedMs: number, starved: boolean) {
  const cadence = state.cadence ??= { since: at };
  const recovered = cadence.staleAt === undefined ? undefined : {
    staleMs: elapsed(cadence, at), lastOutcome: cadence.lastOutcome ?? "queued",
  };
  cadence.lastCompleted = cadence.lastEnd = at;
  cadence.lastOutcome = starved ? "starved" : outcome;
  cadence.lastQueuedMs = queuedMs;
  delete cadence.suspendedMs;
  if (cadence.suspendedAt !== undefined) cadence.suspendedAt = at;
  delete cadence.staleAt;
  delete cadence.alerted;
  delete cadence.alertRetryAt;
  delete cadence.alertText;
  return recovered;
}

export function urgentLoadRetry(watcher: Watcher, state: State, at: number): boolean {
  if (!watcher.urgent || (state.urgent_retry_at !== undefined && at - state.urgent_retry_at < watcher.interval_s * 1000)) return false;
  state.urgent_retry_at = at;
  state.next_at = at;
  return true;
}

export function isStarved(intervalS: number, slotWaitMs: number): boolean {
  return slotWaitMs > Math.max(intervalS * 1000, 300_000);
}

export function starvedText(queuedMs: number, timing: { slotWaitMs: number; slotQueueDepth: number; slotActiveAtEnqueue: number }, cap: number, checkMs: number, timeoutMs?: number): string {
  const seconds = (ms: number) => (ms / 1000).toFixed(1);
  return `starved: queued ${seconds(queuedMs)}s, slot_wait ${seconds(timing.slotWaitMs)}s, depth ${timing.slotQueueDepth}, active ${timing.slotActiveAtEnqueue}/${cap}, then ${timeoutMs === undefined ? `check ${seconds(checkMs)}s` : `load timeout after ${seconds(timeoutMs)}s`}`;
}
