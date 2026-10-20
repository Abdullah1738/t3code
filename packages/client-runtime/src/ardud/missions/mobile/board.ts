import type {
  FeedItem,
  Lane,
  LaneStatus,
  MissionOverview,
  MissionRecordRef,
} from "@t3tools/contracts";

import { LANE_STATUS_LABEL } from "../lanesViewModel.ts";
import type { OwnerRequest } from "../source.ts";
import { directionCheckRows } from "../timelineViewModel.ts";
import {
  ageView,
  formatCountdown,
  formatDayLabel,
  formatPercent,
  formatTimeOfDay,
  nextMilestone,
  priorityStack,
  refKey,
  splitFeed,
} from "../viewModel.ts";
import { healthTone, type HealthTone } from "./overview.ts";
import { requestFigures } from "./requests.ts";

// The phone board for one mission: figures, Since you last looked, Toward the
// next milestone, and the lanes grouped by state. Times read in the device's
// own zone; `timeZone` exists for tests only.

function calendarDay(atMs: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    ...(timeZone ? { timeZone } : {}),
  }).format(atMs);
}

/** "15:41" for today, "Wed 14 Oct" for anything earlier. */
export function clockLabel(atIso: string, nowMs: number, timeZone?: string): string {
  const atMs = Date.parse(atIso);
  if (!Number.isFinite(atMs)) return "";
  return calendarDay(atMs, timeZone) === calendarDay(nowMs, timeZone)
    ? formatTimeOfDay(atIso, timeZone)
    : formatDayLabel(atIso, timeZone);
}

export interface BoardFigure {
  readonly key: "requests" | "lanes" | "since" | "toward";
  readonly label: string;
  readonly value: string;
  readonly detail: string | null;
}

export function boardFigures(
  overview: Pick<MissionOverview, "lanes" | "feed" | "ownerLastLookedAt" | "milestones">,
  requests: ReadonlyArray<OwnerRequest>,
  nowMs: number,
  timeZone?: string,
): BoardFigure[] {
  const asks = requestFigures(requests);
  const lanes = overview.lanes;
  const total = lanes.working + lanes.stuck + lanes.waiting + lanes.idle + lanes.parked;
  const { fresh } = splitFeed(overview.feed, overview.ownerLastLookedAt);
  const decided = fresh.filter((item) => item.kind === "decided").length;
  const next = nextMilestone(overview.milestones);
  const figures: BoardFigure[] = [
    {
      key: "requests",
      label: "Your requests",
      value: `${asks.answered} answered`,
      detail: asks.waiting > 0 ? `${asks.waiting} waiting` : null,
    },
    {
      key: "lanes",
      label: "Lanes working",
      value: `${lanes.working} of ${total}`,
      detail:
        lanes.stuck > 0
          ? `${lanes.stuck} stuck`
          : lanes.waiting > 0
            ? `${lanes.waiting} waiting`
            : null,
    },
    {
      key: "since",
      label: overview.ownerLastLookedAt
        ? `Since ${clockLabel(overview.ownerLastLookedAt, nowMs, timeZone)}`
        : "So far",
      value: `${fresh.length} new`,
      detail: decided > 0 ? `${decided} decided` : null,
    },
  ];
  if (next) {
    figures.push({
      key: "toward",
      label: `Toward ${formatDayLabel(next.targetAt, timeZone)}`,
      value: formatCountdown(next.targetAt, nowMs),
      detail: next.atRisk > 0 ? `${next.atRisk} at risk` : null,
    });
  }
  return figures;
}

// ---------------------------------------------------------------------------
// Since you last looked

const FEED_LABEL: Readonly<Record<FeedItem["kind"], string>> = {
  shipped: "Shipped",
  decided: "Decided",
  blocked: "Blocked",
  milestone: "Milestone",
  note: "Note",
};

export interface SinceRow {
  readonly key: string;
  readonly time: string;
  readonly summary: string;
  readonly label: string;
  readonly ref: MissionRecordRef | null;
  /** Set on the master's calls: the owner can say Fine or discuss it. */
  readonly callId: string | null;
  /** Repeated structural changes folded into this row. */
  readonly count: number;
}

export interface SinceView {
  /** When the owner last pressed Mark seen, or null before the first time. */
  readonly mark: string | null;
  readonly rows: ReadonlyArray<SinceRow>;
  readonly canMarkSeen: boolean;
}

/**
 * Calls to check first, then what happened, newest first. It only moves when
 * the owner presses Mark seen; opening the board changes nothing.
 */
export function sinceView(
  overview: Pick<MissionOverview, "feed" | "ownerLastLookedAt" | "directionCheck">,
  nowMs: number,
  timeZone?: string,
): SinceView {
  const { fresh } = splitFeed(overview.feed, overview.ownerLastLookedAt);
  const checks = directionCheckRows(overview.directionCheck).map((row): SinceRow => ({
    key: `check:${refKey(row.item.ref)}:${row.item.at}`,
    time: clockLabel(row.item.at, nowMs, timeZone),
    summary: row.item.summary,
    label: row.reason,
    ref: row.item.ref,
    callId: row.item.ref.kind === "call" ? row.item.ref.id : null,
    count: row.count,
  }));
  const feed = fresh.map((item): SinceRow => ({
    key: `feed:${item.at}:${item.ref ? refKey(item.ref) : item.summary}`,
    time: clockLabel(item.at, nowMs, timeZone),
    summary: item.summary,
    label: FEED_LABEL[item.kind],
    ref: item.ref,
    callId: null,
    count: 1,
  }));
  const rows = [...checks, ...feed];
  return {
    mark: overview.ownerLastLookedAt
      ? clockLabel(overview.ownerLastLookedAt, nowMs, timeZone)
      : null,
    rows,
    canMarkSeen: rows.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Toward the next milestone

export interface TowardView {
  /** "Toward Mon 19 Oct" */
  readonly title: string;
  readonly countdown: string;
  readonly milestones: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly status: string;
    readonly atRisk: boolean;
  }>;
  /** Sub-missions in the owner's order with their share of the effort. */
  readonly subMissions: ReadonlyArray<{
    readonly id: string;
    readonly rank: number;
    readonly title: string;
    readonly tone: HealthTone;
    readonly share: string | null;
  }>;
}

const MILESTONE_STATUS: Readonly<Record<string, string>> = {
  planned: "Planned",
  "on-track": "On track",
  "at-risk": "At risk",
  done: "Done",
  missed: "Missed",
};

export function towardView(
  overview: Pick<MissionOverview, "milestones" | "subMissions">,
  nowMs: number,
  timeZone?: string,
): TowardView | null {
  const next = nextMilestone(overview.milestones);
  if (!next) return null;
  return {
    title: `Toward ${formatDayLabel(next.targetAt, timeZone)}`,
    countdown: formatCountdown(next.targetAt, nowMs),
    milestones: next.milestones.map((milestone) => ({
      id: milestone.id,
      title: milestone.title,
      status: MILESTONE_STATUS[milestone.status] ?? milestone.status,
      atRisk: milestone.status === "at-risk" || milestone.status === "missed",
    })),
    subMissions: priorityStack(overview.subMissions).map((row) => ({
      id: row.subMission.id,
      rank: row.position,
      title: row.subMission.title,
      tone: healthTone(row.subMission.health, row.subMission.status === "paused"),
      share: row.actual === null ? null : formatPercent(row.actual),
    })),
  };
}

// ---------------------------------------------------------------------------
// Lanes

export interface LaneRowView {
  readonly id: Lane["id"];
  readonly name: string;
  readonly purpose: string;
  readonly status: LaneStatus;
  /** Why it is stuck or waiting, when the lane says. */
  readonly reason: string | null;
  readonly age: string | null;
  /** The lane's thread; the row opens the normal thread screen. */
  readonly threadId: Lane["threadId"];
}

export interface LaneSection {
  readonly key: string;
  readonly label: string;
  readonly rows: ReadonlyArray<LaneRowView>;
}

const LANE_SECTIONS: ReadonlyArray<{
  readonly key: string;
  readonly label: string;
  readonly statuses: ReadonlyArray<LaneStatus>;
}> = [
  { key: "stuck", label: LANE_STATUS_LABEL.stuck, statuses: ["stuck"] },
  { key: "waiting", label: LANE_STATUS_LABEL.waiting, statuses: ["waiting"] },
  { key: "working", label: LANE_STATUS_LABEL.working, statuses: ["working"] },
  { key: "idle", label: LANE_STATUS_LABEL.idle, statuses: ["idle"] },
  { key: "parked", label: "Parked and retired", statuses: ["parked", "retired"] },
];

/** Lanes by state, problems first, most recently active first inside each. */
export function laneSections(lanes: ReadonlyArray<Lane>, nowMs: number): LaneSection[] {
  const recent = (left: Lane, right: Lane) =>
    (right.lastActiveAt ?? "").localeCompare(left.lastActiveAt ?? "") ||
    left.name.localeCompare(right.name);
  return LANE_SECTIONS.flatMap((section) => {
    const rows = lanes
      .filter((lane) => section.statuses.includes(lane.status))
      .sort(recent)
      .map((lane) => ({
        id: lane.id,
        name: lane.name,
        purpose: lane.purpose,
        status: lane.status,
        reason: lane.status === "stuck" || lane.status === "waiting" ? lane.statusReason : null,
        age: lane.lastActiveAt ? (ageView(lane.lastActiveAt, nowMs)?.label ?? null) : null,
        threadId: lane.threadId,
      }));
    return rows.length > 0 ? [{ key: section.key, label: section.label, rows }] : [];
  });
}
