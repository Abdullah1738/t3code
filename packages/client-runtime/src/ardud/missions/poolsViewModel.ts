import type { MissionRecoveryState, Pool, PoolHold, PoolId, PoolView } from "@t3tools/contracts";

import { changeIndex, lastChangedLine } from "./changeLog.ts";
import type {
  MissionPoolsSnapshot,
  RecoveryCause,
  RecoveryIncident,
  RecoveryThread,
  SetPoolCapacityInput,
} from "./source.ts";
import { actorLabel, formatDayLabel, formatPercent, formatTimeOfDay } from "./viewModel.ts";

// Roles tab, part two: shared pools (unit, capacity, scope, holders, queue,
// advisory or enforced) and restart recovery incidents.

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const err = <T>(error: string): Result<T> => ({ ok: false, error });

export interface PoolHoldRow {
  readonly hold: PoolHold;
  readonly holder: string;
  /** "fence 48, lease to 18:01" style detail; the screen formats the times. */
  readonly fence: number;
  readonly queued: boolean;
  readonly needsReconcile: boolean;
}

export interface PoolRow {
  readonly pool: Pool;
  /** "10 of 30 account in use". */
  readonly usageLine: string;
  readonly scopeLine: string;
  readonly enforcementLabel: string;
  readonly pressure: PoolView["pressure"];
  readonly pressureReason: string;
  readonly holders: ReadonlyArray<PoolHoldRow>;
  readonly queue: ReadonlyArray<PoolHoldRow>;
  readonly capacityChangedBy: string | null;
}

const PRESSURE_RANK: Record<PoolView["pressure"], number> = {
  exhausted: 0,
  tight: 1,
  ok: 2,
};

function formatAmount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

export function poolScopeLine(
  pool: Pick<Pool, "scope">,
  missionTitles: ReadonlyMap<string, string>,
) {
  switch (pool.scope._tag) {
    case "global":
      return "All missions";
    case "mission":
      return `Only ${missionTitles.get(pool.scope.missionId) ?? pool.scope.missionId}`;
    case "shared":
      return `Shared by ${pool.scope.missionIds.map((id) => missionTitles.get(id) ?? id).join(", ")}`;
  }
}

/** Exhausted pools first, then tight, then the rest by name. */
export function poolRows(
  snapshot: MissionPoolsSnapshot,
  masterRoleId: string | null,
  missionTitles: ReadonlyMap<string, string> = new Map(),
): PoolRow[] {
  const lookup = changeIndex(snapshot.changes);
  return [...snapshot.pools]
    .sort(
      (left, right) =>
        PRESSURE_RANK[left.pressure] - PRESSURE_RANK[right.pressure] ||
        left.pool.name.localeCompare(right.pool.name),
    )
    .map((view): PoolRow => {
      const holdRow = (hold: PoolHold): PoolHoldRow => ({
        hold,
        holder: actorLabel(hold.holder, masterRoleId),
        fence: hold.fence,
        queued: hold.status === "queued",
        needsReconcile: hold.status === "reconcile-required",
      });
      const rows = view.holds.map(holdRow);
      return {
        pool: view.pool,
        usageLine: `${formatAmount(view.inUse)} of ${formatAmount(view.pool.capacity)} ${view.pool.unit} in use`,
        scopeLine: poolScopeLine(view.pool, missionTitles),
        enforcementLabel: view.pool.enforcement === "enforced" ? "Enforced" : "Advisory",
        pressure: view.pressure,
        pressureReason: view.pressureReason,
        holders: rows.filter((row) => !row.queued),
        queue: rows.filter((row) => row.queued),
        capacityChangedBy: lastChangedLine(
          lookup({ kind: "pool", id: view.pool.id }, "capacity"),
          masterRoleId,
        ),
      };
    });
}

/** Share of a pool in use, for a gauge. */
export function poolShare(view: Pick<PoolView, "inUse" | "pool">): number {
  return view.pool.capacity <= 0 ? 1 : Math.min(1, view.inUse / view.pool.capacity);
}

export function poolShareLabel(view: Pick<PoolView, "inUse" | "pool">): string {
  return formatPercent(poolShare(view));
}

export function setPoolCapacityInput(
  poolId: PoolId,
  text: string,
  reason: string,
): Result<SetPoolCapacityInput> {
  const capacity = Number(text.trim());
  if (!text.trim() || !Number.isFinite(capacity) || capacity < 0) {
    return err("Capacity is a number, zero or more.");
  }
  if (!reason.trim()) return err("Say why the capacity changes.");
  return ok({ poolId, capacity, reason: reason.trim() });
}

// ---------------------------------------------------------------------------
// Recovery

const CAUSE_LABEL: Record<RecoveryCause, string> = {
  "server-restart": "restart",
  "opencode-restart": "OpenCode restart",
  "run-interrupted": "interrupted runs",
  succession: "role handoff",
};

const OPEN_STATES: ReadonlySet<RecoveryThread["state"]> = new Set(["pending", "held", "failed"]);

/** "Recovered from restart at 15:37", the clock in the reader's own zone. */
export function recoveryLabel(cause: RecoveryCause, atIso: string, timeZone?: string): string {
  return `Recovered from ${CAUSE_LABEL[cause]} at ${formatTimeOfDay(atIso, timeZone)}`;
}

export interface RecoveryGroup {
  readonly label: string;
  /** Lane or thread names in resume order. */
  readonly names: ReadonlyArray<string>;
}

export interface RecoveryView {
  readonly incident: RecoveryIncident;
  /** "Sun 4 Oct". */
  readonly dayLabel: string;
  /** "15:35 to 15:37, found 15:41". */
  readonly downLine: string;
  /** Waiting first, then what happened to each thread; empty groups left out. */
  readonly groups: ReadonlyArray<RecoveryGroup>;
}

function threadName(thread: RecoveryThread): string {
  if (thread.laneName) return thread.laneName;
  if (thread.roleKind === "master") return "master";
  return thread.title;
}

function outcome(thread: RecoveryThread): string {
  if (OPEN_STATES.has(thread.state)) return "Waiting";
  if (thread.state === "skipped" || thread.action === "skip") return "Skipped";
  if (thread.state === "decided") return "Decided";
  if (thread.action === "reconcile-first") return "Reconciled";
  if (thread.action === "notice-only") return "Told only";
  return "Resumed";
}

const OUTCOME_ORDER = ["Waiting", "Resumed", "Reconciled", "Told only", "Skipped", "Decided"];

export function recoveryView(incident: RecoveryIncident, timeZone?: string): RecoveryView {
  const groups = new Map<string, string[]>();
  for (const thread of [...incident.threads].sort((a, b) => a.position - b.position)) {
    const label = outcome(thread);
    groups.set(label, [...(groups.get(label) ?? []), threadName(thread)]);
  }
  const clock = (atIso: string) => formatTimeOfDay(atIso, timeZone);
  return {
    incident,
    dayLabel: formatDayLabel(incident.detectedAt, timeZone),
    downLine: `${clock(incident.windowStart)} to ${clock(incident.windowEnd)}, found ${clock(incident.detectedAt)}`,
    groups: OUTCOME_ORDER.flatMap((label) => {
      const names = groups.get(label);
      return names ? [{ label, names }] : [];
    }),
  };
}

/**
 * The overview line while a restart incident still has threads to resume or
 * decide, from the contract's `MissionOverview.recovery`; null once none wait.
 * The clock is the reader's, not the server's `label`.
 */
export function recoveryBanner(
  recovery: MissionRecoveryState | null | undefined,
  timeZone?: string,
) {
  if (!recovery || recovery.pending === 0) return null;
  const threads = recovery.pending === 1 ? "thread" : "threads";
  const reconcile = recovery.reconcile > 0 ? `, ${recovery.reconcile} to reconcile first` : "";
  return `${recoveryLabel(recovery.cause, recovery.at, timeZone)}: ${recovery.pending} of ${recovery.total} ${threads} still to resume or decide${reconcile}`;
}
