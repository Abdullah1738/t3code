/**
 * Governor: reads pools and lane state, and decides which lane parks, which
 * parked lane comes back and which mission admits work next.
 *
 * Rules (design section 11):
 * - Missions have a tier (P0 > P1 > P2), a weight, a guaranteed share of the
 *   watched pools and a borrow ceiling.
 * - A pool is tight when its projection runs out before the window resets or
 *   when it is inside the reserve kept for P0, masters and scribes.
 * - Under pressure, lanes park at a safe point: P2 borrowers first, then P1
 *   lanes above their guarantee (highest weighted share first, then the lowest
 *   sub-mission, then the least sunk work). A mission is never pushed below
 *   its guarantee, P0 is never parked, and master and scribe lanes never park.
 * - One lane per tick, so the next tick sees fresh usage before parking more.
 * - It never switches models or variants. Slowing down is the only lever.
 *
 * What it may not do itself becomes a `Suggestion` for the master or owner.
 *
 * Pure functions only. `PolicyService` applies the result.
 */
import {
  type Lane,
  type LaneId,
  type Mission,
  type MissionId,
  type MissionTier,
  type Pool,
  type PoolHold,
  type Role,
  type SubMission,
  type Suggestion,
  SuggestionId,
} from "@t3tools/contracts";

/** Share of a watched pool kept free for P0 work, masters and scribes. */
export const GOVERNOR_RESERVE = 0.15;

/** Prefix on `Lane.statusReason` for lanes the governor parked, so it only resumes its own. */
export const GOVERNOR_PARK_PREFIX = "governor:";

/** How long a queue waits on a full enforced pool before the governor suggests more capacity. */
export const QUEUE_WAIT_SUGGEST_MS = 30 * 60_000;

export interface MissionUse {
  readonly missionId: MissionId;
  readonly poolId: Pool["id"];
  /** In the pool's unit. */
  readonly used: number;
}

export interface GovernorInput {
  readonly missions: ReadonlyArray<Mission>;
  readonly subMissions: ReadonlyArray<SubMission>;
  readonly lanes: ReadonlyArray<Lane>;
  readonly roles: ReadonlyArray<Role>;
  /** Pools the governor watches; budget and observed pools carry a usage sample. */
  readonly pools: ReadonlyArray<Pool>;
  readonly usage: ReadonlyArray<MissionUse>;
  /** Queued holds on enforced pools. */
  readonly queued?: ReadonlyArray<PoolHold>;
  readonly now: string;
  readonly reserve?: number;
}

export type PressureLevel = "ok" | "tight" | "exhausted";

export interface PoolPressure {
  readonly poolId: Pool["id"];
  readonly level: PressureLevel;
  readonly reason: string;
}

const percent = (value: number) => `${Math.round(value * 100)}%`;

export function poolPressure(pool: Pool, now: string, reserve = GOVERNOR_RESERVE): PoolPressure {
  const ok = (reason: string): PoolPressure => ({ poolId: pool.id, level: "ok", reason });
  if (pool.kind === "lease" || pool.capacity <= 0) return ok("not watched");
  const share = pool.usage.used / pool.capacity;
  const { runOutAt, resetsAt } = pool.usage;
  const nowMs = Date.parse(now);
  if (share >= 1) {
    return {
      poolId: pool.id,
      level: "exhausted",
      reason: `${pool.name} is at ${percent(share)} of ${pool.capacity} ${pool.unit}`,
    };
  }
  if (
    runOutAt !== null &&
    resetsAt !== null &&
    Date.parse(runOutAt) < Date.parse(resetsAt) &&
    Date.parse(resetsAt) > nowMs
  ) {
    return {
      poolId: pool.id,
      level: "tight",
      reason: `${pool.name} runs out at ${runOutAt}, before it resets at ${resetsAt}`,
    };
  }
  if (share >= 1 - reserve) {
    return {
      poolId: pool.id,
      level: "tight",
      reason: `${pool.name} is at ${percent(share)}, inside the ${percent(reserve)} reserve`,
    };
  }
  return ok(`${pool.name} is at ${percent(share)}`);
}

export interface MissionShare {
  readonly missionId: MissionId;
  /** Largest share of any watched pool this mission uses, 0..1+. */
  readonly dominant: number;
  /** `dominant / weight`; lower admits first and parks last. */
  readonly weighted: number;
  readonly aboveGuarantee: boolean;
}

export function missionShares(input: GovernorInput): ReadonlyArray<MissionShare> {
  const watched = input.pools.filter((pool) => pool.kind !== "lease" && pool.capacity > 0);
  return input.missions.map((mission) => {
    const dominant = watched.reduce((max, pool) => {
      const used = input.usage
        .filter((use) => use.missionId === mission.id && use.poolId === pool.id)
        .reduce((sum, use) => sum + use.used, 0);
      return Math.max(max, used / pool.capacity);
    }, 0);
    return {
      missionId: mission.id,
      dominant,
      weighted: dominant / mission.weight,
      aboveGuarantee: dominant > mission.guaranteedShare,
    };
  });
}

const TIER_RANK: Record<MissionTier, number> = { P0: 0, P1: 1, P2: 2 };

const LIVE_LANE = (lane: Lane) => lane.status !== "parked" && lane.status !== "retired";
const AT_SAFE_POINT = (lane: Lane) =>
  lane.status === "idle" || lane.status === "waiting" || lane.status === "stuck";

const neverParks = (lane: Lane, roles: ReadonlyArray<Role>): boolean => {
  const lead = roles.find((role) => role.id === lane.leadRoleId);
  return lead?.kind === "master" || lead?.kind === "scribe";
};

const subMissionOrder = (lane: Lane, subMissions: ReadonlyArray<SubMission>): number =>
  subMissions.find((sub) => sub.id === lane.subMissionId)?.order ?? Number.MAX_SAFE_INTEGER;

const sunkWork = (lane: Lane) => lane.context?.promptTokens ?? 0;

export interface ParkCandidate {
  readonly lane: Lane;
  readonly mission: Mission;
  readonly share: MissionShare;
}

/** Lanes the governor may park, in the order it parks them. */
export function parkOrder(input: GovernorInput): ReadonlyArray<ParkCandidate> {
  const shares = missionShares(input);
  const candidates: Array<ParkCandidate> = [];
  for (const mission of input.missions) {
    if (mission.status === "archived" || mission.tier === "P0") continue;
    const share = shares.find((entry) => entry.missionId === mission.id)!;
    if (!share.aboveGuarantee) continue;
    for (const lane of input.lanes) {
      if (lane.missionId !== mission.id || !LIVE_LANE(lane) || neverParks(lane, input.roles)) {
        continue;
      }
      candidates.push({ lane, mission, share });
    }
  }
  return candidates.toSorted(
    (left, right) =>
      TIER_RANK[right.mission.tier] - TIER_RANK[left.mission.tier] ||
      right.share.weighted - left.share.weighted ||
      subMissionOrder(right.lane, input.subMissions) -
        subMissionOrder(left.lane, input.subMissions) ||
      sunkWork(left.lane) - sunkWork(right.lane) ||
      left.lane.id.localeCompare(right.lane.id),
  );
}

export type GovernorAction =
  | {
      readonly _tag: "park";
      readonly laneId: LaneId;
      readonly missionId: MissionId;
      readonly reason: string;
    }
  | {
      /** The next lane to park is mid-step; it parks at its next safe point. */
      readonly _tag: "park-at-safe-point";
      readonly laneId: LaneId;
      readonly missionId: MissionId;
      readonly reason: string;
    }
  | {
      readonly _tag: "resume";
      readonly laneId: LaneId;
      readonly missionId: MissionId;
      readonly reason: string;
    };

export interface GovernorDecision {
  readonly pressure: ReadonlyArray<PoolPressure>;
  readonly shares: ReadonlyArray<MissionShare>;
  readonly actions: ReadonlyArray<GovernorAction>;
  readonly suggestions: ReadonlyArray<Suggestion>;
}

const isGovernorParked = (lane: Lane) =>
  lane.status === "parked" && (lane.statusReason ?? "").startsWith(GOVERNOR_PARK_PREFIX);

/** Parked lanes the governor brings back first: higher tier, then the higher sub-mission. */
function resumeOrder(input: GovernorInput): ReadonlyArray<Lane> {
  const tierOf = (lane: Lane) =>
    TIER_RANK[input.missions.find((mission) => mission.id === lane.missionId)?.tier ?? "P2"];
  return input.lanes
    .filter(isGovernorParked)
    .toSorted(
      (left, right) =>
        tierOf(left) - tierOf(right) ||
        subMissionOrder(left, input.subMissions) - subMissionOrder(right, input.subMissions) ||
        left.updatedAt.localeCompare(right.updatedAt),
    );
}

const suggestion = (
  fields: Pick<
    Suggestion,
    "id" | "missionId" | "targetKind" | "target" | "title" | "before" | "after" | "diffText" | "why"
  > & { readonly acceptor: Suggestion["acceptor"] },
  now: string,
): Suggestion => ({
  ...fields,
  evidence: fields.target === null ? [] : [fields.target],
  author: "governor",
  status: "open",
  dismissReason: null,
  outcome: null,
  decidedBy: null,
  decidedAt: null,
  createdAt: now,
});

function queueSuggestions(input: GovernorInput): ReadonlyArray<Suggestion> {
  const out: Array<Suggestion> = [];
  const nowMs = Date.parse(input.now);
  for (const pool of input.pools) {
    if (pool.enforcement !== "enforced") continue;
    const waiting = (input.queued ?? []).filter(
      (hold) => hold.poolId === pool.id && hold.status === "queued",
    );
    const stale = waiting.filter(
      (hold) => nowMs - Date.parse(hold.createdAt) >= QUEUE_WAIT_SUGGEST_MS,
    );
    if (stale.length === 0) continue;
    const extra = stale.reduce((sum, hold) => sum + hold.amount, 0);
    const capacity = pool.capacity + extra;
    out.push(
      suggestion(
        {
          id: SuggestionId.make(`governor:pool:${pool.id}:capacity:${capacity}`),
          missionId: pool.scope._tag === "mission" ? pool.scope.missionId : null,
          targetKind: "pool",
          target: { kind: "pool", id: pool.id, label: pool.name },
          title: `Raise ${pool.name} to ${capacity} ${pool.unit}`,
          before: { capacity: pool.capacity },
          after: { capacity },
          diffText: `capacity ${pool.capacity} -> ${capacity}`,
          why: `${stale.length} request(s) have waited over ${QUEUE_WAIT_SUGGEST_MS / 60_000} minutes for ${pool.name}.`,
          acceptor: pool.scope._tag === "mission" ? "master" : "owner",
        },
        input.now,
      ),
    );
  }
  return out;
}

/**
 * Lanes left when nothing is parkable: every mission is at or below its
 * guarantee. Parking below a guarantee is the owner's call, so the governor
 * proposes the lowest-priority lane instead of parking it.
 */
function belowGuaranteeSuggestion(input: GovernorInput, pressure: PoolPressure): Suggestion | null {
  const shares = missionShares(input);
  const lane = input.lanes
    .filter((candidate) => LIVE_LANE(candidate) && !neverParks(candidate, input.roles))
    .map((candidate) => ({
      lane: candidate,
      mission: input.missions.find((mission) => mission.id === candidate.missionId),
    }))
    .filter(
      (entry): entry is { lane: Lane; mission: Mission } =>
        entry.mission !== undefined &&
        entry.mission.status !== "archived" &&
        entry.mission.tier !== "P0",
    )
    .toSorted(
      (left, right) =>
        TIER_RANK[right.mission.tier] - TIER_RANK[left.mission.tier] ||
        (shares.find((share) => share.missionId === right.mission.id)?.weighted ?? 0) -
          (shares.find((share) => share.missionId === left.mission.id)?.weighted ?? 0) ||
        subMissionOrder(right.lane, input.subMissions) -
          subMissionOrder(left.lane, input.subMissions) ||
        sunkWork(left.lane) - sunkWork(right.lane),
    )[0]?.lane;
  if (!lane) return null;
  return suggestion(
    {
      id: SuggestionId.make(`governor:lane:${lane.id}:park:${pressure.poolId}`),
      missionId: lane.missionId,
      targetKind: "lane",
      target: { kind: "lane", id: lane.id, label: lane.name },
      title: `Park ${lane.name} below its mission's guarantee`,
      before: { status: lane.status },
      after: { status: "parked" },
      diffText: `status ${lane.status} -> parked`,
      why: `${pressure.reason}. Every mission is at or below its guarantee, so only the owner can park more.`,
      acceptor: "owner",
    },
    input.now,
  );
}

export function decide(input: GovernorInput): GovernorDecision {
  const reserve = input.reserve ?? GOVERNOR_RESERVE;
  const pressure = input.pools.map((pool) => poolPressure(pool, input.now, reserve));
  const shares = missionShares(input);
  const worst =
    pressure.find((entry) => entry.level === "exhausted") ??
    pressure.find((entry) => entry.level === "tight");
  const actions: Array<GovernorAction> = [];
  const suggestions: Array<Suggestion> = [...queueSuggestions(input)];

  if (worst) {
    const next = parkOrder(input)[0];
    if (next) {
      const reason = `${GOVERNOR_PARK_PREFIX} ${worst.reason}`;
      actions.push({
        _tag: AT_SAFE_POINT(next.lane) ? "park" : "park-at-safe-point",
        laneId: next.lane.id,
        missionId: next.mission.id,
        reason,
      });
    } else {
      const proposal = belowGuaranteeSuggestion(input, worst);
      if (proposal) suggestions.push(proposal);
    }
  } else {
    const lane = resumeOrder(input)[0];
    if (lane) {
      actions.push({
        _tag: "resume",
        laneId: lane.id,
        missionId: lane.missionId,
        reason: "governor: every watched pool is back under its reserve",
      });
    }
  }
  return { pressure, shares, actions, suggestions };
}

export interface Admission {
  readonly missionId: MissionId;
  readonly canAdmit: boolean;
  readonly reason: string;
}

/**
 * Which mission admits new work next: highest tier with ready work, then the
 * lowest weighted dominant share. A mission at its borrow ceiling waits, and
 * under pressure only missions within their guarantee admit (P0 always may).
 */
export function admissionOrder(input: GovernorInput): ReadonlyArray<Admission> {
  const reserve = input.reserve ?? GOVERNOR_RESERVE;
  const tight = input.pools.some((pool) => poolPressure(pool, input.now, reserve).level !== "ok");
  const shares = missionShares(input);
  return input.missions
    .filter((mission) => mission.status === "active")
    .map((mission) => {
      const share = shares.find((entry) => entry.missionId === mission.id)!;
      const ready = input.lanes.some(
        (lane) =>
          lane.missionId === mission.id &&
          lane.status === "idle" &&
          (mission.focusSubMissionId === null || lane.subMissionId === mission.focusSubMissionId),
      );
      const admission = (canAdmit: boolean, reason: string) => ({
        mission,
        share,
        admission: { missionId: mission.id, canAdmit, reason },
      });
      if (!ready) return admission(false, "no idle lane with ready work");
      if (mission.tier === "P0") return admission(true, "P0");
      if (share.dominant >= mission.borrowCeiling) {
        return admission(false, `at its borrow ceiling (${percent(mission.borrowCeiling)})`);
      }
      if (tight && share.aboveGuarantee) {
        return admission(false, "pools are tight and it is above its guarantee");
      }
      return admission(true, `weighted share ${share.weighted.toFixed(3)}`);
    })
    .toSorted(
      (left, right) =>
        Number(right.admission.canAdmit) - Number(left.admission.canAdmit) ||
        TIER_RANK[left.mission.tier] - TIER_RANK[right.mission.tier] ||
        left.share.weighted - right.share.weighted,
    )
    .map((entry) => entry.admission);
}
