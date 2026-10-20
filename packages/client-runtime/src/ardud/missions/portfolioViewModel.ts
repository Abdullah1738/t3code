import type { MissionActor, MissionHealth, MissionId, MissionTier } from "@t3tools/contracts";

import { changeIndex, lastChangedLine } from "./changeLog.ts";
import type {
  PortfolioMission,
  PortfolioPoolDraw,
  PortfolioSnapshot,
  SetPortfolioOrderInput,
} from "./source.ts";
import { actorLabel, formatPercent, healthLabel, moveInOrder } from "./viewModel.ts";

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

// --- Desk page ---

export interface PortfolioShare {
  readonly missionId: MissionId;
  readonly title: string;
  readonly share: number;
  readonly paused: boolean;
}

/** The order bar: each mission's guaranteed share in priority order, then what is free. */
export interface PortfolioBar {
  readonly shares: ReadonlyArray<PortfolioShare>;
  readonly free: number;
}

export function portfolioBar(view: PortfolioView): PortfolioBar {
  const shares = view.rows
    .filter((row) => row.mission.status !== "archived")
    .map((row) => ({
      missionId: row.mission.missionId,
      title: row.mission.title,
      share: row.mission.guaranteedShare,
      paused: row.mission.status === "paused",
    }));
  const taken = shares.reduce((total, share) => total + share.share, 0);
  return { shares, free: Math.max(0, 1 - taken) };
}

/** Page-line text with its figures marked, so the screen can set them in ink. */
export type SummaryPart = string | { readonly key: string; readonly figure: string };

/** "Crpko takes 70% of the shared pools. Juno is paused. 25% is free." */
export function portfolioSummary(bar: PortfolioBar): ReadonlyArray<SummaryPart> {
  const parts: SummaryPart[] = [];
  const live = bar.shares.filter((share) => !share.paused);
  live.forEach((share, index) => {
    parts.push(`${index === 0 ? "" : " "}${share.title} takes `, {
      key: share.missionId,
      figure: formatPercent(share.share),
    });
    parts.push(index === 0 ? " of the shared pools." : ".");
  });
  for (const share of bar.shares.filter((s) => s.paused)) {
    parts.push(`${parts.length ? " " : ""}${share.title} is paused.`);
  }
  const taken = bar.shares.reduce((total, share) => total + share.share, 0);
  if (taken > 1 + 1e-9) {
    parts.push(`${parts.length ? " " : ""}Guarantees add up to `, {
      key: "taken",
      figure: formatPercent(taken),
    });
    parts.push(".");
  } else if (bar.free > 1e-9) {
    parts.push(
      parts.length ? " " : "",
      { key: "free", figure: formatPercent(bar.free) },
      " is free.",
    );
  }
  return parts;
}

export interface PortfolioFact {
  readonly label: string;
  readonly value: string;
}

/** The figures on a mission card: guaranteed, using, borrowed and ceiling. */
export function portfolioFacts(row: PortfolioRow): ReadonlyArray<PortfolioFact> {
  const { mission } = row;
  return [
    { label: "Guaranteed", value: formatPercent(mission.guaranteedShare) },
    {
      label: "Using",
      value: mission.usedShare === null ? "Not measured" : formatPercent(mission.usedShare),
    },
    ...(row.borrowed === null ? [] : [{ label: "Borrowed", value: formatPercent(row.borrowed) }]),
    { label: "Ceiling", value: formatPercent(mission.borrowCeiling) },
  ];
}

export interface PortfolioPoolSplit {
  readonly poolId: string;
  readonly label: string;
  readonly runOutAt: string | null;
  /** "Crpko 92%, Juno 8%": each mission's draw, largest first. */
  readonly line: string;
}

/** Shared pools across the missions with each mission's draw on them. */
export function portfolioPools(view: PortfolioView): ReadonlyArray<PortfolioPoolSplit> {
  const pools = new Map<
    string,
    { label: string; runOutAt: string | null; draws: { title: string; share: number }[] }
  >();
  for (const row of view.rows) {
    for (const { draw } of row.pools) {
      const pool = pools.get(draw.poolId) ?? {
        label: draw.label,
        runOutAt: draw.runOutAt,
        draws: [],
      };
      pool.draws.push({ title: row.mission.title, share: draw.share });
      pools.set(draw.poolId, pool);
    }
  }
  return [...pools].map(([poolId, pool]) => ({
    poolId,
    label: pool.label,
    runOutAt: pool.runOutAt,
    line: [...pool.draws]
      .sort((left, right) => right.share - left.share)
      .map((draw) => `${draw.title} ${formatPercent(draw.share)}`)
      .join(", "),
  }));
}

export interface PortfolioChangeRow {
  readonly key: string;
  readonly at: string;
  /** "Order: Crpko, then Juno" / "Crpko engineering guaranteed share". */
  readonly text: string;
  /** "you", "master", ... */
  readonly by: string;
}

const PORTFOLIO_FIELD_LABEL: Record<string, string> = {
  tier: "tier",
  guaranteedShare: "guaranteed share",
  borrowCeiling: "borrow ceiling",
};

/** The order change and the newest tier and share changes, newest first. */
export function portfolioChanges(
  snapshot: PortfolioSnapshot,
  limit = 8,
): ReadonlyArray<PortfolioChangeRow> {
  const byId = new Map(snapshot.missions.map((mission) => [mission.missionId as string, mission]));
  const titles = snapshot.order.map((id) => byId.get(id)?.title ?? id);
  const order: PortfolioChangeRow[] = snapshot.orderChange
    ? [
        {
          key: "order",
          at: snapshot.orderChange.at,
          text: `Order: ${titles.length > 1 ? `${titles.slice(0, -1).join(", ")}, then ${titles[titles.length - 1]}` : (titles[0] ?? "")}`,
          by: orderActorLabel(snapshot.orderChange.actor, snapshot.missions),
        },
      ]
    : [];
  const fields = snapshot.changes.flatMap((change): PortfolioChangeRow[] => {
    const mission = byId.get(change.ref.id);
    const field = PORTFOLIO_FIELD_LABEL[change.field];
    if (!mission || !field) return [];
    return [
      {
        key: `${change.ref.id}:${change.field}`,
        at: change.at,
        text: `${mission.title} ${field}`,
        by: actorLabel(change.actor, mission.masterRoleId),
      },
    ];
  });
  return [...order, ...fields]
    .sort((left, right) => right.at.localeCompare(left.at))
    .slice(0, limit);
}

export interface HealthCount {
  readonly health: MissionHealth;
  readonly count: number;
  /** "3 at risk". */
  readonly label: string;
}

const HEALTH_ORDER: ReadonlyArray<MissionHealth> = ["red", "amber", "green", "unknown"];

/** Sub-missions folded by health, problems first: "1 off track, 3 at risk, 3 on track". */
export function healthCounts(
  subMissions: ReadonlyArray<{ readonly health: MissionHealth }>,
): ReadonlyArray<HealthCount> {
  return HEALTH_ORDER.flatMap((health) => {
    const count = subMissions.filter((sub) => sub.health === health).length;
    return count ? [{ health, count, label: `${count} ${healthLabel(health).toLowerCase()}` }] : [];
  });
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
