import type { Mission, MissionActor, MissionId, MissionTier } from "@t3tools/contracts";

import { changeIndex, lastChangedLine } from "./changeLog.ts";
import type {
  FieldChange,
  PortfolioMission,
  PortfolioPoolDraw,
  PortfolioSnapshot,
  SetPortfolioOrderInput,
} from "./source.ts";
import { actorLabel, formatPercent, moveInOrder } from "./viewModel.ts";

// Portfolio: every mission in cross-mission priority order with its tier,
// guaranteed share, how much it borrowed, and when it runs each pool out.

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const err = <T>(error: string): Result<T> => ({ ok: false, error });

export interface PortfolioPoolRow {
  readonly draw: PortfolioPoolDraw;
  /** "92% of Offbox". */
  readonly line: string;
  /** Pool run-out time when the mission draws on it; the screen formats it. */
  readonly runOutAt: string | null;
}

export interface PortfolioRow {
  readonly mission: PortfolioMission;
  readonly position: number;
  readonly tierLabel: string;
  /** "Guaranteed 70%, can borrow up to 90%". */
  readonly shareLine: string;
  /** "Using 66%: borrowing 0%" / "Not measured yet". */
  readonly usedLine: string;
  /** Share used beyond the guaranteed share; 0 when within it, null unmeasured. */
  readonly borrowed: number | null;
  readonly pools: ReadonlyArray<PortfolioPoolRow>;
  /** Earliest run-out across the pools it draws on. */
  readonly firstRunOutAt: string | null;
  /** Per-field "last changed by" lines for tier and shares. */
  readonly changedBy: { readonly tier: string | null; readonly shares: string | null };
}

export interface PortfolioView {
  readonly rows: ReadonlyArray<PortfolioRow>;
  /** "Order last changed by you", or null when the log has no reorder. */
  readonly orderLine: string | null;
  /** Sum of guaranteed shares of live missions; above 1 the guarantees overlap. */
  readonly guaranteedTotal: number;
  readonly overcommitted: boolean;
}

const TIER_LABEL: Record<MissionTier, string> = {
  P0: "P0, top priority",
  P1: "P1",
  P2: "P2, background",
};

const LIVE = (mission: PortfolioMission) =>
  mission.status === "active" || mission.status === "draining";

/** Each row names its own mission's master; the order line knows every mission's master. */
export function portfolioView(snapshot: PortfolioSnapshot): PortfolioView {
  const byId = new Map(snapshot.missions.map((mission) => [mission.missionId as string, mission]));
  const ordered = [
    ...snapshot.order.flatMap((id) => {
      const mission = byId.get(id);
      return mission ? [mission] : [];
    }),
    ...snapshot.missions.filter((mission) => !snapshot.order.includes(mission.missionId)),
  ];
  const lookup = changeIndex(snapshot.changes);
  const rows = ordered.map((mission, index): PortfolioRow => {
    const ref = { kind: "mission" as const, id: mission.missionId };
    const { masterRoleId } = mission;
    const borrowed =
      mission.usedShare === null ? null : Math.max(0, mission.usedShare - mission.guaranteedShare);
    const pools = mission.pools.map((draw) => ({
      draw,
      line: `${formatPercent(draw.share)} of ${draw.label}`,
      runOutAt: draw.runOutAt,
    }));
    const runOuts = pools.flatMap((pool) => (pool.runOutAt ? [pool.runOutAt] : [])).sort();
    const shareChange = [lookup(ref, "guaranteedShare"), lookup(ref, "borrowCeiling")]
      .filter((change) => change !== null)
      .sort((left, right) => right.at.localeCompare(left.at))[0];
    return {
      mission,
      position: index + 1,
      tierLabel: TIER_LABEL[mission.tier],
      shareLine: `Guaranteed ${formatPercent(mission.guaranteedShare)}, can borrow up to ${formatPercent(mission.borrowCeiling)}`,
      usedLine:
        mission.usedShare === null
          ? "Not measured yet"
          : `Using ${formatPercent(mission.usedShare)}: borrowing ${formatPercent(borrowed ?? 0)}`,
      borrowed,
      pools,
      firstRunOutAt: runOuts[0] ?? null,
      changedBy: {
        tier: lastChangedLine(lookup(ref, "tier"), masterRoleId),
        shares: lastChangedLine(shareChange ?? null, masterRoleId),
      },
    };
  });
  const guaranteedTotal = snapshot.missions
    .filter(LIVE)
    .reduce((total, mission) => total + mission.guaranteedShare, 0);
  return {
    rows,
    orderLine: snapshot.orderChange
      ? `Order last changed by ${orderActorLabel(snapshot.orderChange.actor, snapshot.missions)}`
      : null,
    guaranteedTotal,
    overcommitted: guaranteedTotal > 1 + 1e-9,
  };
}

function orderActorLabel(actor: MissionActor, missions: ReadonlyArray<PortfolioMission>): string {
  const master =
    actor._tag === "role" ? missions.find((m) => m.masterRoleId === actor.roleId) : undefined;
  return actorLabel(actor, master?.masterRoleId ?? null);
}

const TIER_RANK: Record<MissionTier, number> = { P0: 0, P1: 1, P2: 2 };

/**
 * A portfolio built from the missions themselves, for servers without the
 * portfolio read (core r6): tier then weight order, usage from each overview,
 * no pool draws and no recorded reorder.
 */
export function portfolioFromMissions(
  missions: ReadonlyArray<{ readonly mission: Mission; readonly usageShare: number | null }>,
  changes: ReadonlyArray<FieldChange> = [],
): PortfolioSnapshot {
  const ordered = [...missions].sort(
    (left, right) =>
      TIER_RANK[left.mission.tier] - TIER_RANK[right.mission.tier] ||
      right.mission.weight - left.mission.weight ||
      left.mission.title.localeCompare(right.mission.title),
  );
  return {
    order: ordered.map(({ mission }) => mission.id),
    missions: ordered.map(({ mission, usageShare }): PortfolioMission => ({
      missionId: mission.id,
      title: mission.title,
      status: mission.status,
      tier: mission.tier,
      masterRoleId: mission.masterRoleId,
      guaranteedShare: mission.guaranteedShare,
      borrowCeiling: mission.borrowCeiling,
      // The overview measures use against the guaranteed share.
      usedShare: usageShare === null ? null : usageShare * mission.guaranteedShare,
      pools: [],
    })),
    changes,
    orderChange: null,
  };
}

/** Move `missionId` to sit where `overId` is; refuses anything that isn't a full reorder. */
export function reorderPortfolioInput(
  order: ReadonlyArray<MissionId>,
  missionId: MissionId,
  overId: MissionId,
): Result<SetPortfolioOrderInput> {
  if (missionId === overId) return err("Pick another position.");
  if (!order.includes(missionId) || !order.includes(overId)) {
    return err("Both missions must be in the order.");
  }
  return ok({ order: moveInOrder(order, missionId, overId) });
}
