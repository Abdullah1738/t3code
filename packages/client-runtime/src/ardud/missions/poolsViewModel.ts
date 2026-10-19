import type { MissionRecoveryState, Pool, PoolHold, PoolId, PoolView } from "@t3tools/contracts";

import { changeIndex, lastChangedLine } from "./changeLog.ts";
import type {
  MissionPoolsSnapshot,
  RecoveryAction,
  RecoveryIncident,
  RecoveryMember,
  SetPoolCapacityInput,
} from "./source.ts";
import { actorLabel, formatPercent } from "./viewModel.ts";

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

export const RECOVERY_ACTION_LABEL: Record<RecoveryAction, string> = {
  resume: "Resume",
  "notice-only": "Notice only",
  "reconcile-first": "Reconcile first",
  skip: "Skip",
};

const CAUSE_LABEL: Record<RecoveryIncident["cause"], string> = {
  "server-restart": "Server restart",
  "opencode-restart": "OpenCode restart",
  "run-interrupted": "Run interrupted",
  succession: "Succession",
};

export interface RecoveryMemberRow {
  readonly member: RecoveryMember;
  readonly name: string;
  readonly actionLabel: string;
  /** "4 children lost, 4 resumed" style summary. */
  readonly childrenLine: string;
  readonly settled: boolean;
}

export interface RecoveryView {
  readonly incident: RecoveryIncident;
  readonly causeLabel: string;
  /** "9 threads: 4 resumed, 5 decided, 0 waiting". */
  readonly progressLine: string;
  readonly pending: ReadonlyArray<RecoveryMemberRow>;
  readonly settled: ReadonlyArray<RecoveryMemberRow>;
  /** Resume order: the plan, pending members first in their planned order. */
  readonly resumeRate: string;
}

function memberName(member: RecoveryMember): string {
  if (member.laneId) return member.laneId.replace(/^lane-/, "");
  if (member.roleId) return member.roleId;
  return member.threadId;
}

export function recoveryView(incident: RecoveryIncident): RecoveryView {
  const rows = incident.members.map((member): RecoveryMemberRow => {
    const lost = member.lostChildren.length;
    return {
      member,
      name: memberName(member),
      actionLabel: RECOVERY_ACTION_LABEL[member.action],
      childrenLine:
        lost === 0 ? "No children lost" : `${lost} ${lost === 1 ? "child" : "children"} lost`,
      settled: member.state !== "pending",
    };
  });
  const resumed = incident.members.filter((member) => member.state === "resumed").length;
  const decided = incident.members.filter((member) => member.state === "decided").length;
  const waiting = incident.members.length - resumed - decided;
  return {
    incident,
    causeLabel: CAUSE_LABEL[incident.cause],
    progressLine: `${incident.members.length} threads: ${resumed} resumed, ${decided} decided, ${waiting} waiting`,
    pending: rows.filter((row) => !row.settled),
    settled: rows.filter((row) => row.settled),
    resumeRate: `${incident.resumesPerMinute} resumes a minute`,
  };
}

/**
 * The overview line while a restart incident still has threads to resume or
 * decide, from the contract's `MissionOverview.recovery`; null once none wait.
 */
export function recoveryBanner(recovery: MissionRecoveryState | null | undefined) {
  if (!recovery || recovery.pending === 0) return null;
  const threads = recovery.pending === 1 ? "thread" : "threads";
  const reconcile = recovery.reconcile > 0 ? `, ${recovery.reconcile} to reconcile first` : "";
  return `${recovery.label}: ${recovery.pending} of ${recovery.total} ${threads} still to resume or decide${reconcile}`;
}
