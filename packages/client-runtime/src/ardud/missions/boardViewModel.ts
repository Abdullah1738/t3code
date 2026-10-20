// @effect-diagnostics globalDate:off - The board counts days and hours on the reader's local calendar.
import type {
  Lane,
  LaneCounts,
  MissionRoomActivity,
  PoolView,
  ReviewRecord,
  RoomActivityRow,
} from "@t3tools/contracts";

import type { InboxEntry } from "./inboxViewModel.ts";
import { isRequestUnread } from "./requestsViewModel.ts";
import type { OwnerRequest } from "./source.ts";
import { ageView, formatDayLabel, formatTimeOfDay, laneTotal } from "./viewModel.ts";

// The board's lead: greeting, facts, figures and the day line. Every time is
// the reading device's own zone; "today" starts at its local midnight. Message
// counts come from the router's room activity read, which covers imported
// rooms too (their messages have no timeline events).

const MINUTE_MS = 60_000;

/** Local midnight of the day `nowMs` falls in, in the device's zone. */
export function startOfLocalDay(nowMs: number): number {
  const day = new Date(nowMs);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

const COUNT_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

function countWords(count: number, one: string, many: string): string {
  return `${COUNT_WORDS[count] ?? String(count)} ${count === 1 ? one : many}`;
}

/**
 * "Morning, Abdullah. Crpko has three holds waiting on you." The owner's first
 * name when the server knows it; just "Morning." otherwise.
 */
export function boardGreeting(
  title: string,
  waiting: number,
  nowMs: number,
  ownerName: string | null = null,
): string {
  const hour = new Date(nowMs).getHours();
  const word = hour < 12 ? "Morning" : hour < 18 ? "Afternoon" : "Evening";
  const firstName = ownerName?.trim().split(/\s+/)[0] ?? "";
  const hello = firstName === "" ? `${word}.` : `${word}, ${firstName}.`;
  if (waiting === 0) return `${hello} Nothing in ${title} waits on you.`;
  return `${hello} ${title} has ${countWords(waiting, "hold", "holds")} waiting on you.`;
}

/** One fact on the greeting line; `strong` is set in ink. */
export interface BoardFact {
  readonly key: string;
  readonly before: string;
  readonly strong: string;
  readonly after: string;
}

/** The room activity read for the board: today from local midnight, tallies since the look. */
export function boardActivityInput(ownerLastLookedAt: string | null, nowMs: number) {
  return {
    dayStart: new Date(startOfLocalDay(nowMs)).toISOString(),
    since: ownerLastLookedAt,
  };
}

export interface BoardFactsInput {
  readonly waiting: ReadonlyArray<InboxEntry>;
  /** Room tallies since the owner last looked; undefined while they load. */
  readonly activity: MissionRoomActivity | undefined;
  readonly ownerLastLookedAt: string | null;
  readonly nowMs: number;
}

/** "Mon 19 Oct", "The oldest has waited 11d", "6 lanes posted blockers since you looked". */
export function boardFacts(input: BoardFactsInput): BoardFact[] {
  const facts: BoardFact[] = [
    {
      key: "day",
      before: "",
      strong: formatDayLabel(new Date(input.nowMs).toISOString()),
      after: "",
    },
  ];
  const oldest = input.waiting[0];
  const age = oldest ? ageView(oldest.record.createdAt, input.nowMs) : null;
  if (age && age.tier !== "minutes") {
    facts.push({ key: "oldest", before: "The oldest has waited ", strong: age.label, after: "" });
  }
  if (input.ownerLastLookedAt !== null && input.activity !== undefined) {
    const authors = input.activity.since.blockerAuthors;
    if (authors > 0) {
      facts.push({
        key: "blockers",
        before: "",
        strong: authors === 1 ? "1 lane" : `${authors} lanes`,
        after: " posted blockers since you looked",
      });
    }
  }
  return facts;
}

export type BoardFigureKey = "requests" | "lanes" | "since" | "reviews";

export interface BoardFigure {
  readonly key: BoardFigureKey;
  readonly label: string;
  readonly value: string;
  readonly unit: string | null;
  /** One line under the value; `alert` sets it red. */
  readonly note: { readonly text: string; readonly alert: boolean } | null;
}

export interface BoardFiguresInput {
  /** Your requests only (no discussions). */
  readonly requests: ReadonlyArray<OwnerRequest>;
  readonly lanes: LaneCounts;
  /** Room tallies since the owner last looked; undefined while they load. */
  readonly activity: MissionRoomActivity | undefined;
  readonly reviews: ReadonlyArray<ReviewRecord>;
  /** The mission's pools; a review budget there gives the day's cap. */
  readonly pools: ReadonlyArray<PoolView> | undefined;
  readonly ownerLastLookedAt: string | null;
  readonly nowMs: number;
}

/** The daily review budget (a budget pool counted in reviews), when the mission has one. */
export function reviewBudget(pools: ReadonlyArray<PoolView> | undefined): PoolView | null {
  return (
    pools?.find(
      (view) =>
        view.pool.kind === "budget" && view.pool.unit === "review" && view.pool.capacity > 0,
    ) ?? null
  );
}

/** "04:20" for a moment today, "Sun 18 Oct" for an earlier day. */
export function clockOrDay(atIso: string, nowMs: number): string {
  return Date.parse(atIso) >= startOfLocalDay(nowMs)
    ? formatTimeOfDay(atIso)
    : formatDayLabel(atIso);
}

function sinceLabel(ownerLastLookedAt: string | null, nowMs: number): string {
  return ownerLastLookedAt === null ? "Today" : `Since ${clockOrDay(ownerLastLookedAt, nowMs)}`;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The four figures under the greeting. */
export function boardFigures(input: BoardFiguresInput): BoardFigure[] {
  const answered = input.requests.filter(isRequestUnread).length;
  const waitingOnMaster = input.requests.filter((request) => request.status === "waiting").length;

  const messages = input.activity?.since.messages ?? 0;
  const masterDecisions = input.activity?.since.masterDecisions ?? 0;

  const dayStart = startOfLocalDay(input.nowMs);
  const reviewsToday = input.reviews.filter((review) => Date.parse(review.createdAt) >= dayStart);
  const blockedReviews = reviewsToday.filter((review) => review.verdict === "blocked").length;
  // The budget counts what the review service sent in its own day; fall back
  // to today's recorded verdicts when the mission has no review budget.
  const budget = reviewBudget(input.pools);
  const reviewsDone = budget === null ? reviewsToday.length : Math.round(budget.inUse);

  return [
    {
      key: "requests",
      label: "Your requests",
      value: String(answered),
      unit: "answered",
      note:
        waitingOnMaster > 0
          ? { text: `${waitingOnMaster} waiting on the master`, alert: false }
          : null,
    },
    {
      key: "lanes",
      label: "Lanes working",
      value: String(input.lanes.working),
      unit: `of ${laneTotal(input.lanes)}`,
      note: input.lanes.stuck > 0 ? { text: `${input.lanes.stuck} stuck`, alert: true } : null,
    },
    {
      key: "since",
      label: sinceLabel(input.ownerLastLookedAt, input.nowMs),
      value: String(messages),
      unit: messages === 1 ? "message" : "messages",
      note:
        masterDecisions > 0
          ? { text: plural(masterDecisions, "master decision", "master decisions"), alert: false }
          : null,
    },
    {
      key: "reviews",
      label: "Reviews today",
      value: String(reviewsDone),
      unit: budget === null ? null : `of ${Math.round(budget.pool.capacity)}`,
      note: blockedReviews > 0 ? { text: `${blockedReviews} blocked`, alert: true } : null,
    },
  ];
}

// --- Day line ---------------------------------------------------------------

export const DAY_BIN_MINUTES = 5;
const BIN_FULL_AT = 11;
const BIN_MIN_HEIGHT = 5;
export const DAY_BIN_MAX_HEIGHT = 24;

/** One 5-minute column: blockers stack at the foot, master decisions above, the rest on top. */
export interface DayBin {
  readonly index: number;
  readonly blockers: number;
  readonly master: number;
  readonly other: number;
}

export interface DayRow {
  readonly roomId: string;
  readonly name: string;
  readonly total: number;
  readonly bins: ReadonlyArray<DayBin>;
}

export interface DayLine {
  /** Minutes from local midnight to now (at least an hour, so the axis has room). */
  readonly minutes: number;
  readonly rows: ReadonlyArray<DayRow>;
  readonly totals: {
    readonly messages: number;
    readonly masterDecisions: number;
    readonly blockers: number;
  };
  /**
   * Whether the day reads as a strip of 5-minute columns. A handful of
   * messages makes a strip of lone ticks, so a quiet day shows only each
   * room's count.
   */
  readonly strip: boolean;
  /** Hour marks for the axis, as minutes from midnight; none crowd the strip's right edge. */
  readonly hours: ReadonlyArray<number>;
}

/** Messages a day needs before its rooms draw as a strip. */
export const DAY_STRIP_FROM = 10;
/** Axis marks stop short of the strip's end, where a centred label would hang off it. */
const AXIS_LAST_SHARE = 0.88;

/** Column height in px: 5 for one message, up to 24 at eleven or more. */
export function dayBinHeight(count: number): number {
  if (count <= 0) return 0;
  const capped = Math.min(count, BIN_FULL_AT);
  return (
    BIN_MIN_HEIGHT + ((capped - 1) / (BIN_FULL_AT - 1)) * (DAY_BIN_MAX_HEIGHT - BIN_MIN_HEIGHT)
  );
}

export interface DayLineInput {
  /** Today's room activity from local midnight, binned by the server. */
  readonly rows: ReadonlyArray<RoomActivityRow>;
  readonly roomTitles: ReadonlyMap<string, string>;
  readonly nowMs: number;
}

/** Today's room messages, one row per room, busiest first. */
export function dayLine(input: DayLineInput): DayLine {
  const minutes = Math.max(60, Math.ceil((input.nowMs - startOfLocalDay(input.nowMs)) / MINUTE_MS));
  const totals = { messages: 0, masterDecisions: 0, blockers: 0 };
  for (const row of input.rows) {
    totals.messages += row.total;
    for (const bin of row.bins) {
      totals.blockers += bin.blockers;
      totals.masterDecisions += bin.master;
    }
  }

  const hours: number[] = [];
  for (let mark = 0; mark <= minutes * AXIS_LAST_SHARE; mark += 6 * 60) hours.push(mark);

  return {
    minutes,
    totals,
    strip: totals.messages >= DAY_STRIP_FROM,
    hours,
    rows: input.rows
      .filter((row) => row.total > 0)
      .map((row) => ({
        roomId: row.roomId,
        name: input.roomTitles.get(row.roomId) ?? "Room",
        total: row.total,
        bins: row.bins,
      }))
      .toSorted((left, right) => right.total - left.total || left.name.localeCompare(right.name)),
  };
}

/** "06:00" for an axis mark. */
export function dayHourLabel(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:00`;
}

// --- Lanes panel --------------------------------------------------------------

export interface LaneBar {
  readonly key: "working" | "waiting" | "idle" | "parked";
  readonly label: string;
  readonly count: number;
  /** Share of live lanes, 0 to 1. */
  readonly share: number;
}

const LANE_BARS = [
  ["working", "Working"],
  ["waiting", "Waiting"],
  ["idle", "Idle"],
  ["parked", "Parked"],
] as const;

/** Stuck lanes, most recently changed first. */
export function stuckLanes<T extends Pick<Lane, "status" | "updatedAt">>(
  lanes: ReadonlyArray<T>,
): T[] {
  return lanes
    .filter((lane) => lane.status === "stuck")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/** Working, waiting, idle and parked as shares of every live lane (stuck ones included). */
export function laneBars(counts: LaneCounts): LaneBar[] {
  const total = laneTotal(counts);
  return LANE_BARS.map(([key, label]) => ({
    key,
    label,
    count: counts[key],
    share: total === 0 ? 0 : counts[key] / total,
  }));
}
