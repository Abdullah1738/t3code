import type { Ask, Lane, LaneCounts, Milestone, MissionHealth } from "@t3tools/contracts";

/**
 * Server-side health. Pure: callers load the records and cache the result
 * (MissionService recomputes a mission at most every 15 seconds).
 *
 * - red: a stuck lane, a P0 question, a missed milestone or an at-risk one
 *   past its target.
 * - amber: a waiting lane, a lane near its context limit, any open question,
 *   an at-risk or overdue milestone.
 * - green: lanes or milestones exist and none of the above.
 * - unknown: nothing to judge yet.
 */

const RANK: Record<MissionHealth, number> = { unknown: 0, green: 1, amber: 2, red: 3 };
const CONTEXT_WARN_RATIO = 0.85;

export const worstHealth = (values: Iterable<MissionHealth>): MissionHealth => {
  let worst: MissionHealth = "unknown";
  for (const value of values) {
    if (RANK[value] > RANK[worst]) worst = value;
  }
  return worst;
};

export interface HealthInputs {
  readonly lanes: ReadonlyArray<Lane>;
  /** Open asks only. */
  readonly asks: ReadonlyArray<Ask>;
  readonly milestones: ReadonlyArray<Milestone>;
  /** ISO time; milestones past `targetAt` count as overdue. */
  readonly now: string;
}

const contextHigh = (lane: Lane) =>
  lane.context !== null &&
  lane.context.promptTokens / lane.context.limitTokens >= CONTEXT_WARN_RATIO;

export const judgeHealth = (inputs: HealthInputs): MissionHealth => {
  const lanes = inputs.lanes.filter(
    (lane) => lane.status !== "retired" && lane.status !== "parked",
  );
  const milestones = inputs.milestones.filter((milestone) => milestone.status !== "done");
  if (lanes.length === 0 && milestones.length === 0 && inputs.asks.length === 0) return "unknown";
  const overdue = (milestone: Milestone) =>
    milestone.targetAt !== null && milestone.targetAt < inputs.now;
  if (
    lanes.some((lane) => lane.status === "stuck") ||
    inputs.asks.some((ask) => ask.urgency === "p0") ||
    milestones.some(
      (milestone) =>
        milestone.status === "missed" || (milestone.status === "at-risk" && overdue(milestone)),
    )
  ) {
    return "red";
  }
  if (
    lanes.some((lane) => lane.status === "waiting" || contextHigh(lane)) ||
    inputs.asks.length > 0 ||
    milestones.some((milestone) => milestone.status === "at-risk" || overdue(milestone))
  ) {
    return "amber";
  }
  return "green";
};

/** Lane counts for list rows and the overview. Retired lanes are not counted. */
export const countLanes = (lanes: ReadonlyArray<Lane>): LaneCounts => {
  const counts = { working: 0, stuck: 0, waiting: 0, idle: 0, parked: 0 };
  for (const lane of lanes) {
    if (lane.status !== "retired") counts[lane.status] += 1;
  }
  return counts;
};
