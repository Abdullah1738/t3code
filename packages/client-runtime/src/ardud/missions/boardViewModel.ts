// @effect-diagnostics globalDate:off - The board counts days and hours on the reader's local calendar.
import type {
  Lane,
  LaneCounts,
  MissionMessageKind,
  ReviewRecord,
  RoleId,
} from "@t3tools/contracts";

import type { InboxEntry } from "./inboxViewModel.ts";
import { isRequestUnread } from "./requestsViewModel.ts";
import type { MissionTimelineEvent, OwnerRequest } from "./source.ts";
import { ageView, formatDayLabel, formatTimeOfDay, laneTotal } from "./viewModel.ts";

// The board's lead: greeting, facts, figures and the day line. Every time is
// the reading device's own zone; "today" starts at its local midnight.

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

/** "Morning. Crpko has three holds waiting on you." */
export function boardGreeting(title: string, waiting: number, nowMs: number): string {
  const hour = new Date(nowMs).getHours();
  const word = hour < 12 ? "Morning" : hour < 18 ? "Afternoon" : "Evening";
  if (waiting === 0) return `${word}. Nothing in ${title} waits on you.`;
  return `${word}. ${title} has ${countWords(waiting, "hold", "holds")} waiting on you.`;
}

/** One fact on the greeting line; `strong` is set in ink. */
export interface BoardFact {
  readonly key: string;
  readonly before: string;
  readonly strong: string;
  readonly after: string;
}

/** A room message's kind, read from a `message.posted` event; null for anything else. */
export function messageKindOf(event: MissionTimelineEvent): MissionMessageKind | null {
  if (event.kind !== "message.posted") return null;
  const match = /^(request|decision|status|evidence|blocker|control) in /.exec(event.summary);
  return match ? (match[1] as MissionMessageKind) : null;
}

function roomIdOf(event: MissionTimelineEvent): string | null {
  const payload = event.payload as { readonly roomId?: unknown } | null;
  return typeof payload?.roomId === "string" ? payload.roomId : null;
}

function isMaster(event: MissionTimelineEvent, masterRoleId: RoleId | null): boolean {
  return (
    masterRoleId !== null && event.actor._tag === "role" && event.actor.roleId === masterRoleId
  );
}

/** Who held up work since the owner looked: distinct authors of blocker messages. */
function blockerAuthorsSince(events: ReadonlyArray<MissionTimelineEvent>, sinceMs: number) {
  const authors = new Set<string>();
  for (const event of events) {
    if (Date.parse(event.at) < sinceMs || messageKindOf(event) !== "blocker") continue;
    authors.add(JSON.stringify(event.actor));
  }
  return authors.size;
}

export interface BoardFactsInput {
  readonly waiting: ReadonlyArray<InboxEntry>;
  readonly events: ReadonlyArray<MissionTimelineEvent>;
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
  if (input.ownerLastLookedAt !== null) {
    const authors = blockerAuthorsSince(input.events, Date.parse(input.ownerLastLookedAt));
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
  readonly events: ReadonlyArray<MissionTimelineEvent>;
  readonly reviews: ReadonlyArray<ReviewRecord>;
  readonly masterRoleId: RoleId | null;
  readonly ownerLastLookedAt: string | null;
  readonly nowMs: number;
}

/** When "since you last looked" starts: the look itself, or local midnight before the first look. */
function sinceStart(ownerLastLookedAt: string | null, nowMs: number): number {
  return ownerLastLookedAt === null ? startOfLocalDay(nowMs) : Date.parse(ownerLastLookedAt);
}

function sinceLabel(ownerLastLookedAt: string | null, nowMs: number): string {
  if (ownerLastLookedAt === null) return "Today";
  const lookedMs = Date.parse(ownerLastLookedAt);
  return lookedMs >= startOfLocalDay(nowMs)
    ? `Since ${formatTimeOfDay(ownerLastLookedAt)}`
    : `Since ${formatDayLabel(ownerLastLookedAt)}`;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The four figures under the greeting. */
export function boardFigures(input: BoardFiguresInput): BoardFigure[] {
  const answered = input.requests.filter(isRequestUnread).length;
  const waitingOnMaster = input.requests.filter((request) => request.status === "waiting").length;

  const fromMs = sinceStart(input.ownerLastLookedAt, input.nowMs);
  let messages = 0;
  let masterDecisions = 0;
  for (const event of input.events) {
    const kind = messageKindOf(event);
    if (kind === null || Date.parse(event.at) < fromMs) continue;
    messages += 1;
    if (kind === "decision" && isMaster(event, input.masterRoleId)) masterDecisions += 1;
  }

  const dayStart = startOfLocalDay(input.nowMs);
  const reviewsToday = input.reviews.filter((review) => Date.parse(review.createdAt) >= dayStart);
  const blockedReviews = reviewsToday.filter((review) => review.verdict === "blocked").length;

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
      value: String(reviewsToday.length),
      unit: null,
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
  /** Minute the owner last looked, 0 when that was before today, null before the first look. */
  readonly lookedMinute: number | null;
  readonly rows: ReadonlyArray<DayRow>;
  readonly totals: {
    readonly messages: number;
    readonly masterDecisions: number;
    readonly blockers: number;
  };
  /** Hour marks for the axis, as minutes from midnight. */
  readonly hours: ReadonlyArray<number>;
}

/** Column height in px: 5 for one message, up to 24 at eleven or more. */
export function dayBinHeight(count: number): number {
  if (count <= 0) return 0;
  const capped = Math.min(count, BIN_FULL_AT);
  return (
    BIN_MIN_HEIGHT + ((capped - 1) / (BIN_FULL_AT - 1)) * (DAY_BIN_MAX_HEIGHT - BIN_MIN_HEIGHT)
  );
}

export interface DayLineInput {
  readonly events: ReadonlyArray<MissionTimelineEvent>;
  readonly roomTitles: ReadonlyMap<string, string>;
  readonly masterRoleId: RoleId | null;
  readonly ownerLastLookedAt: string | null;
  readonly nowMs: number;
}

/** Today's room messages, one row per room, busiest first. */
export function dayLine(input: DayLineInput): DayLine {
  const startMs = startOfLocalDay(input.nowMs);
  const minutes = Math.max(60, Math.ceil((input.nowMs - startMs) / MINUTE_MS));
  const rows = new Map<string, { total: number; bins: Map<number, DayBin> }>();
  const totals = { messages: 0, masterDecisions: 0, blockers: 0 };

  for (const event of input.events) {
    const kind = messageKindOf(event);
    const roomId = roomIdOf(event);
    const atMs = Date.parse(event.at);
    if (kind === null || roomId === null || atMs < startMs || atMs > input.nowMs) continue;
    const blocker = kind === "blocker";
    const master = !blocker && kind === "decision" && isMaster(event, input.masterRoleId);
    totals.messages += 1;
    if (blocker) totals.blockers += 1;
    if (master) totals.masterDecisions += 1;

    const row = rows.get(roomId) ?? { total: 0, bins: new Map<number, DayBin>() };
    rows.set(roomId, row);
    row.total += 1;
    const index = Math.floor((atMs - startMs) / (DAY_BIN_MINUTES * MINUTE_MS));
    const bin = row.bins.get(index) ?? { index, blockers: 0, master: 0, other: 0 };
    row.bins.set(index, {
      index,
      blockers: bin.blockers + (blocker ? 1 : 0),
      master: bin.master + (master ? 1 : 0),
      other: bin.other + (blocker || master ? 0 : 1),
    });
  }

  let lookedMinute: number | null = null;
  if (input.ownerLastLookedAt !== null) {
    const lookedMs = Date.parse(input.ownerLastLookedAt);
    lookedMinute = lookedMs < startMs ? 0 : Math.min(minutes, (lookedMs - startMs) / MINUTE_MS);
  }

  const hours: number[] = [];
  for (let mark = 0; mark < minutes; mark += 6 * 60) hours.push(mark);

  return {
    minutes,
    lookedMinute,
    totals,
    hours,
    rows: [...rows]
      .map(([roomId, row]) => ({
        roomId,
        name: input.roomTitles.get(roomId) ?? "Room",
        total: row.total,
        bins: [...row.bins.values()].sort((left, right) => left.index - right.index),
      }))
      .sort((left, right) => right.total - left.total || left.name.localeCompare(right.name)),
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
