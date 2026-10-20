import type { DirectionCheckItem, MissionActor } from "@t3tools/contracts";
import { DateTime } from "effect";

import { type ActorNames, actorName } from "./roomsViewModel.ts";
import type { MissionTimelineEvent, MissionTimelineWindow } from "./source.ts";
import { actorKey, formatDayLabel } from "./viewModel.ts";

// Timeline tab: the mission's event log, newest first, under day heads,
// filtered by kind and actor, with each event's cause chain. Repeated lines
// fold into one. The direction check on the board folds the same way.

/** Kind families for the filter: the part before the dot. */
export type TimelineKindGroup =
  | "mission"
  | "sub-mission"
  | "lane"
  | "role"
  | "rule"
  | "review"
  | "pool"
  | "routing"
  | "inbox"
  | "requests"
  | "rooms"
  | "work"
  | "layout"
  | "recovery"
  | "succession"
  | "other";

export const TIMELINE_KIND_GROUP_LABEL: Record<TimelineKindGroup, string> = {
  mission: "Mission",
  "sub-mission": "Sub-missions",
  lane: "Lanes",
  role: "Roles",
  rule: "Rules",
  review: "Reviews",
  pool: "Pools",
  routing: "Routing",
  inbox: "Asks, drafts and approvals",
  requests: "Your requests",
  rooms: "Rooms",
  work: "Work",
  layout: "Layout",
  recovery: "Recovery",
  succession: "Successions",
  other: "Other",
};

/** Event kind prefix: its filter group and the kicker a row shows instead of the raw kind. */
const PREFIXES: Record<string, { readonly group: TimelineKindGroup; readonly kicker: string }> = {
  mission: { group: "mission", kicker: "Mission" },
  portfolio: { group: "mission", kicker: "Portfolio" },
  editor: { group: "mission", kicker: "Bottom line" },
  field: { group: "mission", kicker: "Field" },
  governor: { group: "mission", kicker: "Governor" },
  import: { group: "mission", kicker: "Import" },
  "sub-mission": { group: "sub-mission", kicker: "Sub-mission" },
  milestone: { group: "sub-mission", kicker: "Milestone" },
  lane: { group: "lane", kicker: "Lane" },
  role: { group: "role", kicker: "Role" },
  rule: { group: "rule", kicker: "Rule" },
  "review-policy": { group: "review", kicker: "Review policy" },
  criticality: { group: "review", kicker: "Criticality" },
  review: { group: "review", kicker: "Review" },
  pool: { group: "pool", kicker: "Pool" },
  routing: { group: "routing", kicker: "Routing" },
  record: { group: "routing", kicker: "Routing" },
  "approval-routing": { group: "routing", kicker: "Routing" },
  ask: { group: "inbox", kicker: "Ask" },
  call: { group: "inbox", kicker: "Call" },
  draft: { group: "inbox", kicker: "Draft" },
  "draft-note": { group: "inbox", kicker: "Draft note" },
  approval: { group: "inbox", kicker: "Approval" },
  suggestion: { group: "inbox", kicker: "Suggestion" },
  knock: { group: "inbox", kicker: "Knock" },
  note: { group: "inbox", kicker: "Note" },
  "secret-request": { group: "inbox", kicker: "Secret request" },
  request: { group: "requests", kicker: "Request" },
  room: { group: "rooms", kicker: "Room" },
  message: { group: "rooms", kicker: "Message" },
  send: { group: "rooms", kicker: "Send" },
  member: { group: "rooms", kicker: "Member" },
  subscription: { group: "rooms", kicker: "Room" },
  "work-item": { group: "work", kicker: "Work" },
  view: { group: "layout", kicker: "Layout" },
  recovery: { group: "recovery", kicker: "Recovery" },
};

/** Whole kinds whose kicker differs from their prefix's. */
const KIND_KICKER: Record<string, string> = {
  "role.succession": "Succession",
  "pool.hold-taken": "Hold",
  "pool.hold-released": "Hold",
  "pool.hold-expired": "Hold",
  "pool.hold-queued": "Hold",
  "pool.hold-reconciled": "Hold",
  "lane.nudged": "Nudge",
};

const prefixOf = (kind: string) => kind.split(".")[0] ?? "";

export function kindGroup(kind: string): TimelineKindGroup {
  // Handoffs get their own filter instead of a section of their own.
  if (kind === "role.succession") return "succession";
  return PREFIXES[prefixOf(kind)]?.group ?? "other";
}

/** An event's group: the client's own for kinds it knows, else the server's. */
export function eventGroup(event: MissionTimelineEvent): TimelineKindGroup {
  const group = kindGroup(event.kind);
  return group === "other" && event.group !== undefined ? event.group : group;
}

/** The kicker a row shows for its kind: "Lane", "Hold", "Succession". */
export function eventKicker(kind: string): string {
  const known = KIND_KICKER[kind] ?? PREFIXES[prefixOf(kind)]?.kicker;
  if (known) return known;
  const prefix = prefixOf(kind).replaceAll("-", " ");
  return prefix.charAt(0).toUpperCase() + prefix.slice(1);
}

export interface TimelineFilter {
  /** Empty = every kind. */
  readonly groups: ReadonlyArray<TimelineKindGroup>;
  /** `actorKey` values; empty = everyone. */
  readonly actors: ReadonlyArray<string>;
}

export const EMPTY_TIMELINE_FILTER: TimelineFilter = { groups: [], actors: [] };

export function filterTimeline(
  events: ReadonlyArray<MissionTimelineEvent>,
  filter: TimelineFilter,
): MissionTimelineEvent[] {
  return events.filter(
    (event) =>
      (filter.groups.length === 0 || filter.groups.includes(eventGroup(event))) &&
      (filter.actors.length === 0 || filter.actors.includes(actorKey(event.actor))),
  );
}

export function toggleFilter<T>(values: ReadonlyArray<T>, value: T): T[] {
  return values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value];
}

export interface FilterChoice<T> {
  readonly value: T;
  readonly label: string;
  readonly count: number;
}

/** Kind groups present in the log, with counts, the busiest first. */
export function kindChoices(
  events: ReadonlyArray<MissionTimelineEvent>,
): FilterChoice<TimelineKindGroup>[] {
  const counts = new Map<TimelineKindGroup, number>();
  for (const event of events) {
    const group = eventGroup(event);
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  return [...counts]
    .map(([value, count]) => ({ value, label: TIMELINE_KIND_GROUP_LABEL[value], count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

/**
 * Actors present in the log, you and the master first, then by how often they
 * appear. Lanes and roles read by name when `names` has them.
 */
export function actorChoices(
  events: ReadonlyArray<MissionTimelineEvent>,
  masterRoleId: string | null,
  names?: ActorNames,
): FilterChoice<string>[] {
  const seen = new Map<string, { actor: MissionActor; count: number }>();
  for (const event of events) {
    const key = actorKey(event.actor);
    const entry = seen.get(key);
    if (entry) entry.count += 1;
    else seen.set(key, { actor: event.actor, count: 1 });
  }
  const rank = (actor: MissionActor) =>
    actor._tag === "owner" ? 0 : actor._tag === "role" && actor.roleId === masterRoleId ? 1 : 2;
  return [...seen]
    .map(([value, entry]) => ({
      value,
      actor: entry.actor,
      label: actorName(entry.actor, masterRoleId, names),
      count: entry.count,
    }))
    .sort(
      (left, right) =>
        rank(left.actor) - rank(right.actor) ||
        right.count - left.count ||
        left.label.localeCompare(right.label),
    )
    .map(({ value, label, count }) => ({ value, label, count }));
}

/**
 * The chain of causes behind an event, oldest first, ending at the event.
 * Stops at a cause that is not in the log or at a loop.
 */
export function lineage(
  event: MissionTimelineEvent,
  events: ReadonlyArray<MissionTimelineEvent>,
): MissionTimelineEvent[] {
  const byId = new Map(events.map((entry) => [entry.id as string, entry]));
  const chain = [event];
  const seen = new Set<string>([event.id]);
  let cause = event.causedBy;
  while (cause && !seen.has(cause)) {
    const parent = byId.get(cause);
    if (!parent) break;
    chain.unshift(parent);
    seen.add(cause);
    cause = parent.causedBy;
  }
  return chain;
}

/** Events this one caused directly, oldest first. */
export function consequences(
  event: MissionTimelineEvent,
  events: ReadonlyArray<MissionTimelineEvent>,
): MissionTimelineEvent[] {
  return events
    .filter((entry) => entry.causedBy === event.id)
    .sort((left, right) => left.seq - right.seq);
}

/** "Role model changed", "Lane created": a raw event kind as words. */
export function eventKindLabel(kind: string): string {
  const action = kind.slice(kind.indexOf(".") + 1).replaceAll("-", " ");
  return kind.includes(".") ? `${eventKicker(kind)} ${action}` : eventKicker(kind);
}

/** One timeline line: an event, or a run of events that say the same thing. */
export interface TimelineLine {
  readonly key: string;
  /** The newest event of the run; its time, kind, subject and cause chain. */
  readonly event: MissionTimelineEvent;
  readonly kicker: string;
  readonly summary: string;
  readonly group: TimelineKindGroup;
  /** You or the master; other actors read from `actor`. */
  readonly by: "owner" | "master" | null;
  readonly actor: string;
  /** Events folded into the line; 1 for a plain event. */
  readonly count: number;
  /** Events before (causes) and after (direct consequences) this one in its chain. */
  readonly lineageSteps: number;
  /** "Because rule 104 added": the direct cause, when it is in the log. */
  readonly because: string | null;
  /** Events this one caused directly. */
  readonly led: number;
}

export interface TimelineDay {
  readonly key: string;
  /** "Today", "Yesterday", "Fri 16 Oct". */
  readonly heading: string;
  /** Events on the day, folded runs counted in full. */
  readonly count: number;
  readonly rows: ReadonlyArray<TimelineLine>;
}

const isImport = (event: MissionTimelineEvent) =>
  event.kind === "import.applied" && event.provenance._tag === "import";

/** Two neighbouring events say the same thing: one import, or the same line repeated. */
function sameLine(left: MissionTimelineEvent, right: MissionTimelineEvent): boolean {
  if (isImport(left) && isImport(right)) return true;
  return (
    left.kind === right.kind &&
    left.summary === right.summary &&
    actorKey(left.actor) === actorKey(right.actor)
  );
}

const plural = (count: number, noun: string) =>
  count === 1
    ? noun
    : /[^aeiou]y$/.test(noun)
      ? `${noun.slice(0, -1)}ies`
      : /(s|x|ch|sh)$/.test(noun)
        ? `${noun}es`
        : `${noun}s`;

/** Record counts an import event carries: core batches, rooms, messages, read marks. */
function importCounts(event: MissionTimelineEvent): Array<[string, number]> {
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null) return [];
  const fields = payload as Record<string, unknown>;
  const counted = (noun: string, value: unknown): Array<[string, number]> =>
    typeof value === "number" && value > 0 ? [[noun, value]] : [];
  if (fields.kind === "room") {
    return [...counted("room", fields.rooms), ...counted("subscription", fields.subscriptions)];
  }
  if (typeof fields.kind !== "string") return [];
  return counted(fields.kind.replaceAll("-", " "), fields.count);
}

/** "Imported 52 roles, 88 lanes and 3 rooms": one line for a whole import. */
export function importSummary(events: ReadonlyArray<MissionTimelineEvent>): string | null {
  const totals = new Map<string, number>();
  // Oldest first, so the parts read in the order the import wrote them.
  for (let index = events.length - 1; index >= 0; index -= 1) {
    for (const [noun, count] of importCounts(events[index]!)) {
      totals.set(noun, (totals.get(noun) ?? 0) + count);
    }
  }
  const parts = [...totals].map(([noun, count]) => `${count} ${plural(count, noun)}`);
  if (parts.length === 0) return null;
  const last = parts.pop();
  return `Imported ${parts.length > 0 ? `${parts.join(", ")} and ${last}` : last}`;
}

/**
 * Timeline lines from events (newest first): neighbouring events that say the
 * same thing fold into one line with a count, so an import or a boot-time
 * alignment reads as one line instead of fifty.
 */
export function timelineRows(
  events: ReadonlyArray<MissionTimelineEvent>,
  all: ReadonlyArray<MissionTimelineEvent>,
  masterRoleId: string | null,
  names?: ActorNames,
): TimelineLine[] {
  const caused = new Map<string, number>();
  const byId = new Map<string, MissionTimelineEvent>();
  for (const event of all) {
    byId.set(event.id, event);
    if (event.causedBy) caused.set(event.causedBy, (caused.get(event.causedBy) ?? 0) + 1);
  }
  const runs: MissionTimelineEvent[][] = [];
  for (const event of events) {
    const run = runs.at(-1);
    const head = run?.[0];
    if (run && head && sameLine(head, event)) run.push(event);
    else runs.push([event]);
  }
  return runs.map((run) => {
    const event = run[0]!;
    const actor = event.actor;
    const by =
      actor._tag === "owner"
        ? "owner"
        : actor._tag === "role" && actor.roleId === masterRoleId
          ? "master"
          : null;
    const summary = (isImport(event) ? importSummary(run) : null) ?? event.summary;
    const cause = event.causedBy ? byId.get(event.causedBy) : undefined;
    return {
      key: run.length === 1 ? event.id : `${event.id}+${run.length}`,
      event,
      kicker: eventKicker(event.kind),
      summary,
      group: eventGroup(event),
      by,
      actor: actorName(actor, masterRoleId, names),
      count: run.length,
      lineageSteps: lineage(event, all).length - 1 + (caused.get(event.id) ?? 0),
      because: cause ? `Because ${sentenceTail(cause.summary)}` : null,
      led: caused.get(event.id) ?? 0,
    } satisfies TimelineLine;
  });
}

/** A summary set mid-sentence: "Rule 104 added" reads "rule 104 added"; "PR #12" stays. */
const sentenceTail = (text: string) =>
  /^[A-Z][a-z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;

const DAY_MS = 24 * 60 * 60 * 1000;

/** "Today", "Yesterday" or "Fri 16 Oct" for an instant, in the reader's time zone. */
export function dayHeading(atIso: string, nowMs: number, timeZone?: string): string {
  const day = formatDayLabel(atIso, timeZone);
  const label = (ms: number) =>
    formatDayLabel(DateTime.formatIso(DateTime.makeUnsafe(ms)), timeZone);
  if (day === label(nowMs)) return "Today";
  if (day === label(nowMs - DAY_MS)) {
    return "Yesterday";
  }
  return day;
}

/** Lines grouped under day heads, newest day first. */
export function timelineDays(
  rows: ReadonlyArray<TimelineLine>,
  nowMs: number,
  timeZone?: string,
): TimelineDay[] {
  const days: Array<{ key: string; heading: string; count: number; rows: TimelineLine[] }> = [];
  for (const row of rows) {
    const key = formatDayLabel(row.event.at, timeZone);
    const day = days.at(-1);
    if (day && day.key === key) {
      day.rows.push(row);
      day.count += row.count;
    } else {
      days.push({
        key,
        heading: dayHeading(row.event.at, nowMs, timeZone),
        count: row.count,
        rows: [row],
      });
    }
  }
  return days;
}

/** How far back the timeline reads: today, the last 7 days, or everything loaded. */
export type TimelineRange = "today" | "week" | "all";

export function inTimelineRange(
  event: Pick<MissionTimelineEvent, "at">,
  range: TimelineRange,
  nowMs: number,
  timeZone?: string,
): boolean {
  if (range === "all") return true;
  if (range === "week") return Date.parse(event.at) >= nowMs - 7 * DAY_MS;
  const today = formatDayLabel(DateTime.formatIso(DateTime.makeUnsafe(nowMs)), timeZone);
  return formatDayLabel(event.at, timeZone) === today;
}

/**
 * Whether the range may reach past the loaded pages: the server has older
 * events and the oldest loaded one still falls inside the range. "All" pages
 * on request instead, so it never loads the whole log by itself.
 */
export function needsOlderTimeline(
  window: MissionTimelineWindow,
  range: TimelineRange,
  nowMs: number,
  timeZone?: string,
): boolean {
  if (!window.hasOlder || range === "all") return false;
  const oldest = window.events.at(-1);
  return oldest === undefined || inTimelineRange(oldest, range, nowMs, timeZone);
}

/** Whether the loaded pages reach back to an instant, or the log has nothing older. */
export function timelineReaches(window: MissionTimelineWindow, atIso: string): boolean {
  if (!window.hasOlder) return true;
  const oldest = window.events.at(-1);
  return oldest !== undefined && Date.parse(oldest.at) <= Date.parse(atIso);
}

/** The restart line to jump to: the oldest recovery event at or after the restart was found. */
export function restartEvent(
  events: ReadonlyArray<MissionTimelineEvent>,
  detectedAt: string,
): MissionTimelineEvent | null {
  const from = Date.parse(detectedAt);
  let found: MissionTimelineEvent | null = null;
  for (const event of events) {
    if (eventGroup(event) === "recovery" && Date.parse(event.at) >= from) found = event;
  }
  return found;
}

// --- Since you last looked: the direction check ---

export interface DirectionCheckRow {
  readonly item: DirectionCheckItem;
  /** Items folded into this row: the same structural change repeated. */
  readonly count: number;
  /** The reason as words; the server sends a raw event kind for structural changes. */
  readonly reason: string;
}

const RAW_KIND = /^[a-z][a-z-]*\.[a-z][a-z-]*$/;

/**
 * Direction-check rows: calls one per row, structural changes that repeat
 * (same reason and summary) folded into one row with a count.
 */
export function directionCheckRows(items: ReadonlyArray<DirectionCheckItem>): DirectionCheckRow[] {
  const rows: Array<{ item: DirectionCheckItem; count: number; reason: string }> = [];
  const folded = new Map<string, { count: number }>();
  for (const item of items) {
    const reason = RAW_KIND.test(item.reason) ? eventKindLabel(item.reason) : item.reason;
    if (item.ref.kind === "call") {
      rows.push({ item, count: 1, reason });
      continue;
    }
    const key = `${item.reason}\n${item.summary}`;
    const existing = folded.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    const row = { item, count: 1, reason };
    folded.set(key, row);
    rows.push(row);
  }
  return rows;
}
