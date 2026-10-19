import type {
  BlockerGroup,
  FeedItem,
  Lane,
  LaneCounts,
  LaneStatus,
  Milestone,
  MissionActor,
  MissionHealth,
  MissionInbox,
  MissionRecordRef,
  SubMission,
} from "@t3tools/contracts";

import type { FieldChange, MissionPoolUsage } from "./source.ts";

// Pure view helpers shared by the web and mobile mission screens. Everything
// here takes contract snapshots and returns display-ready values, so both
// clients word things the same way.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// ---------------------------------------------------------------------------
// Lanes

export const EMPTY_LANE_COUNTS: LaneCounts = {
  working: 0,
  stuck: 0,
  waiting: 0,
  idle: 0,
  parked: 0,
};

const LANE_COUNT_KEYS = ["working", "stuck", "waiting", "idle", "parked"] as const;

export function sumLaneCounts(counts: ReadonlyArray<LaneCounts>): LaneCounts {
  const total = { ...EMPTY_LANE_COUNTS };
  for (const entry of counts) {
    for (const key of LANE_COUNT_KEYS) total[key] += entry[key];
  }
  return total;
}

/** Counts lanes by status. Retired lanes are history, not capacity, so they are left out. */
export function laneCountsOf(lanes: ReadonlyArray<Pick<Lane, "status">>): LaneCounts {
  const counts = { ...EMPTY_LANE_COUNTS };
  for (const lane of lanes) {
    if (lane.status === "retired") continue;
    counts[lane.status] += 1;
  }
  return counts;
}

export function laneTotal(counts: LaneCounts): number {
  return LANE_COUNT_KEYS.reduce((sum, key) => sum + counts[key], 0);
}

export type LaneFoldTone = "working" | "stuck" | "waiting" | "idle" | "parked";

export interface LaneFoldPart {
  readonly tone: LaneFoldTone;
  readonly count: number;
  readonly label: string;
}

export interface LaneFold {
  readonly total: number;
  readonly parts: ReadonlyArray<LaneFoldPart>;
  /** "14 lanes: 9 working, 2 stuck, 3 idle" */
  readonly line: string;
}

/**
 * Folds lane counts into one line. `compact` (the sidebar) keeps the three
 * states the owner scans for: waiting lanes count as working (they are busy on
 * someone else's move) and parked lanes count as idle. `full` keeps all five.
 */
export function foldLaneCounts(counts: LaneCounts, mode: "compact" | "full" = "compact"): LaneFold {
  const total = laneTotal(counts);
  const raw: ReadonlyArray<readonly [LaneFoldTone, number]> =
    mode === "compact"
      ? [
          ["working", counts.working + counts.waiting],
          ["stuck", counts.stuck],
          ["idle", counts.idle + counts.parked],
        ]
      : LANE_COUNT_KEYS.map((key) => [key, counts[key]] as const);
  const parts = raw
    .filter(([, count]) => count > 0)
    .map(([tone, count]) => ({ tone, count, label: `${count} ${tone}` }));
  const head = `${total} ${total === 1 ? "lane" : "lanes"}`;
  const line = parts.length === 0 ? head : `${head}: ${parts.map((part) => part.label).join(", ")}`;
  return { total, parts, line };
}

const LANE_STATUS_RANK: Record<LaneStatus, number> = {
  stuck: 0,
  waiting: 1,
  working: 2,
  idle: 3,
  parked: 4,
  retired: 5,
};

/** Problems first: stuck, waiting, working, idle, parked; most recently active first within a status. */
export function sortLanesProblemsFirst<T extends Pick<Lane, "status" | "name" | "lastActiveAt">>(
  lanes: ReadonlyArray<T>,
): T[] {
  return [...lanes].sort((left, right) => {
    const rank = LANE_STATUS_RANK[left.status] - LANE_STATUS_RANK[right.status];
    if (rank !== 0) return rank;
    const activity = (right.lastActiveAt ?? "").localeCompare(left.lastActiveAt ?? "");
    if (activity !== 0) return activity;
    return left.name.localeCompare(right.name);
  });
}

/** Splits lanes into the ones the owner should see and the quiet ones folded behind a count. */
export function splitQuietLanes<T extends Pick<Lane, "status">>(
  lanes: ReadonlyArray<T>,
): { readonly active: T[]; readonly quiet: T[] } {
  const active: T[] = [];
  const quiet: T[] = [];
  for (const lane of lanes) {
    if (lane.status === "retired") continue;
    (lane.status === "idle" || lane.status === "parked" ? quiet : active).push(lane);
  }
  return { active, quiet };
}

// ---------------------------------------------------------------------------
// Health

const HEALTH_RANK: Record<MissionHealth, number> = { red: 3, amber: 2, green: 1, unknown: 0 };

/** Worst known health wins. `unknown` only when nothing reported a signal. */
export function rollUpHealth(healths: ReadonlyArray<MissionHealth>): MissionHealth {
  let worst: MissionHealth = "unknown";
  for (const health of healths) {
    if (HEALTH_RANK[health] > HEALTH_RANK[worst]) worst = health;
  }
  return worst;
}

export function healthLabel(health: MissionHealth): string {
  switch (health) {
    case "green":
      return "On track";
    case "amber":
      return "At risk";
    case "red":
      return "Off track";
    case "unknown":
      return "No signal";
  }
}

// ---------------------------------------------------------------------------
// Needs you

export interface NeedsYouCounts {
  readonly decide: number;
  readonly approve: number;
  readonly knocks: number;
  readonly suggestions: number;
  readonly fyi: number;
  /** What the sidebar badge shows: things that wait on the owner (not suggestions or FYI). */
  readonly total: number;
}

export function needsYouCounts(inbox: Pick<MissionInbox, "counts">): NeedsYouCounts {
  const { decide, approve, knocks, suggestions, fyi } = inbox.counts;
  return { decide, approve, knocks, suggestions, fyi, total: decide + approve + knocks };
}

/** "2 decisions, 1 draft to approve" style summary; `null` when nothing waits. */
export function needsYouLine(
  counts: Pick<NeedsYouCounts, "decide" | "approve" | "knocks">,
): string | null {
  const parts: string[] = [];
  if (counts.decide > 0) parts.push(plural(counts.decide, "decision", "decisions"));
  if (counts.approve > 0) parts.push(`${counts.approve} to approve`);
  if (counts.knocks > 0) parts.push(plural(counts.knocks, "knock", "knocks"));
  return parts.length === 0 ? null : parts.join(", ");
}

/** Everything waiting on the owner across missions: the sidebar Inbox row count. */
export function totalNeedsYou(missions: ReadonlyArray<{ readonly needsYou: number }>): number {
  return missions.reduce((total, mission) => total + mission.needsYou, 0);
}

export function badgeCount(count: number, cap = 99): string {
  return count > cap ? `${cap}+` : String(count);
}

// ---------------------------------------------------------------------------
// Blockers and ball holders

/** Stable identity for an actor, used to group and compare holders. */
export function actorKey(actor: MissionActor): string {
  switch (actor._tag) {
    case "owner":
      return "owner";
    case "role":
      return `role:${actor.roleId}`;
    case "lane":
      return `lane:${actor.laneId}`;
    case "thread":
      return `thread:${actor.threadId}`;
    case "system":
      return `system:${actor.component}`;
    case "person":
      return `person:${actor.name}`;
  }
}

export function refKey(ref: Pick<MissionRecordRef, "kind" | "id">): string {
  return `${ref.kind}:${ref.id}`;
}

/**
 * Short display name for an actor. The mission's master role reads as
 * "master" and lanes drop their `lane-` prefix, matching how the coordinator
 * names them in rooms.
 */
export function actorLabel(actor: MissionActor, masterRoleId: string | null = null): string {
  switch (actor._tag) {
    case "owner":
      return "you";
    case "role":
      return actor.roleId === masterRoleId ? "master" : actor.roleId;
    case "lane":
      return actor.laneId.replace(/^lane-/, "");
    case "thread":
      return "a thread";
    case "system":
      return actor.component;
    case "person":
      return actor.name;
  }
}

export interface HeldItem {
  readonly holder: MissionActor;
  readonly holderLabel: string;
  readonly item: MissionRecordRef;
}

/**
 * Groups blocked items by who holds the ball. The owner's group comes first,
 * then the biggest piles, so the line reads "you 2 · master 4 · arch 3".
 * The same item is listed once per holder.
 */
export function groupBlockers(items: ReadonlyArray<HeldItem>): BlockerGroup[] {
  const groups = new Map<
    string,
    { holder: MissionActor; holderLabel: string; items: MissionRecordRef[]; seen: Set<string> }
  >();
  for (const { holder, holderLabel, item } of items) {
    const key = actorKey(holder);
    let group = groups.get(key);
    if (!group) {
      group = { holder, holderLabel, items: [], seen: new Set() };
      groups.set(key, group);
    }
    const itemKey = refKey(item);
    if (group.seen.has(itemKey)) continue;
    group.seen.add(itemKey);
    group.items.push(item);
  }
  return orderBlockerGroups(
    [...groups.values()].map(({ holder, holderLabel, items: groupItems }) => ({
      holder,
      holderLabel,
      items: groupItems,
    })),
  );
}

export function orderBlockerGroups(groups: ReadonlyArray<BlockerGroup>): BlockerGroup[] {
  return [...groups]
    .filter((group) => group.items.length > 0)
    .sort((left, right) => {
      const owner = Number(right.holder._tag === "owner") - Number(left.holder._tag === "owner");
      if (owner !== 0) return owner;
      const size = right.items.length - left.items.length;
      if (size !== 0) return size;
      return left.holderLabel.localeCompare(right.holderLabel);
    });
}

/** "you 2 · master 4 · arch 3" */
export function ballHolderLine(groups: ReadonlyArray<BlockerGroup>): string {
  return orderBlockerGroups(groups)
    .map(
      (group) =>
        `${group.holder._tag === "owner" ? "you" : group.holderLabel} ${group.items.length}`,
    )
    .join(" · ");
}

export interface CriticalPathStep {
  readonly ref: MissionRecordRef;
  /** Who holds the ball on this step, when it is blocked. */
  readonly heldBy: string | null;
}

export interface CriticalPathView {
  readonly steps: ReadonlyArray<CriticalPathStep>;
  readonly blockedCount: number;
}

/** Marks critical-path steps that appear in a blocker group. */
export function criticalPathView(
  path: ReadonlyArray<MissionRecordRef>,
  blockers: ReadonlyArray<BlockerGroup>,
): CriticalPathView {
  const heldBy = new Map<string, string>();
  for (const group of orderBlockerGroups(blockers)) {
    const label = group.holder._tag === "owner" ? "you" : group.holderLabel;
    for (const item of group.items) {
      const key = refKey(item);
      if (!heldBy.has(key)) heldBy.set(key, label);
    }
  }
  const steps = path.map((ref) => ({ ref, heldBy: heldBy.get(refKey(ref)) ?? null }));
  return { steps, blockedCount: steps.filter((step) => step.heldBy !== null).length };
}

export function refLabel(ref: Pick<MissionRecordRef, "id" | "label">): string {
  return ref.label?.trim() || ref.id;
}

// ---------------------------------------------------------------------------
// Sub-mission priority stack

export type EffortDrift = "over" | "under" | "even" | "unknown";

/** Event-log field name for a sub-mission's intended share. */
export const INTENDED_EFFORT_FIELD = "intendedEffort";

export interface PriorityStackRow {
  readonly subMission: SubMission;
  /** 1-based position in the mission's order. */
  readonly position: number;
  readonly intended: number | null;
  /**
   * Who last changed the intended share (owner or master, same method, no
   * lock). `null` when no logged change touched it, e.g. an imported value.
   */
  readonly intendedChange: FieldChange | null;
  readonly actual: number | null;
  readonly drift: EffortDrift;
}

/** "last changed by master", "no share set", or "not changed since import". */
export function intendedShareLine(
  row: Pick<PriorityStackRow, "intended" | "intendedChange">,
  masterRoleId: string | null,
): string {
  if (row.intendedChange) {
    return `last changed by ${actorLabel(row.intendedChange.actor, masterRoleId)}`;
  }
  return row.intended === null ? "no share set" : "not changed since import";
}

/**
 * Reads a typed share: "40", "40%", "0.4" all mean 40%. Empty clears the
 * share. Returns an error for anything else.
 */
export function parseShareInput(
  text: string,
):
  | { readonly ok: true; readonly share: number | null }
  | { readonly ok: false; readonly error: string } {
  const trimmed = text.trim().replace(/%$/, "").trim();
  if (trimmed === "") return { ok: true, share: null };
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return { ok: false, error: "Enter a percentage, like 40." };
  const value = Number(trimmed);
  // "0.4" reads as a fraction; "1" and up read as percent.
  const share = value < 1 && trimmed.includes(".") ? value : value / 100;
  if (share > 1) return { ok: false, error: "A share can't be over 100%." };
  return { ok: true, share: Math.round(share * 1000) / 1000 };
}

/** Sum of intended shares across open sub-missions, and how far it is from 100%. */
export function intendedTotal(rows: ReadonlyArray<Pick<PriorityStackRow, "intended">>): {
  readonly total: number;
  readonly label: string;
  readonly balanced: boolean;
} {
  const total = Math.round(rows.reduce((sum, row) => sum + (row.intended ?? 0), 0) * 1000) / 1000;
  const rounded = Math.round(total * 100);
  return { total, label: `${rounded}% planned`, balanced: Math.abs(rounded - 100) <= 1 };
}

/** Effort is "off" when it misses the owner's share by more than this (absolute share). */
export const EFFORT_DRIFT_THRESHOLD = 0.08;

export function effortDrift(intended: number | null, actual: number | null): EffortDrift {
  if (intended === null || actual === null) return "unknown";
  const delta = actual - intended;
  if (delta > EFFORT_DRIFT_THRESHOLD) return "over";
  if (delta < -EFFORT_DRIFT_THRESHOLD) return "under";
  return "even";
}

/**
 * Open sub-missions in the mission's order (closed ones drop out of the
 * stack). `changes` is the overview's field-change list.
 */
export function priorityStack(
  subMissions: ReadonlyArray<SubMission>,
  changes: ReadonlyArray<FieldChange> = [],
): PriorityStackRow[] {
  const intendedChanges = new Map(
    changes
      .filter((c) => c.ref.kind === "sub-mission" && c.field === INTENDED_EFFORT_FIELD)
      .map((c) => [c.ref.id, c]),
  );
  return [...subMissions]
    .filter((subMission) => subMission.status !== "closed")
    .sort((left, right) => left.order - right.order || left.title.localeCompare(right.title))
    .map((subMission, index) => ({
      subMission,
      position: index + 1,
      intended: subMission.intendedEffort,
      intendedChange: intendedChanges.get(subMission.id) ?? null,
      actual: subMission.actualEffort,
      drift: effortDrift(subMission.intendedEffort, subMission.actualEffort),
    }));
}

/**
 * One sentence about the biggest gap between where effort went and the
 * intended share, or `null` when effort roughly follows the order.
 */
export function effortNote(
  rows: ReadonlyArray<PriorityStackRow>,
  masterRoleId: string | null = null,
): string | null {
  let worst: PriorityStackRow | null = null;
  let worstGap = 0;
  for (const row of rows) {
    if (row.drift !== "over" && row.drift !== "under") continue;
    const gap = Math.abs((row.actual ?? 0) - (row.intended ?? 0));
    if (gap > worstGap) {
      worst = row;
      worstGap = gap;
    }
  }
  if (!worst) return null;
  const actual = formatPercent(worst.actual ?? 0);
  const intended = formatPercent(worst.intended ?? 0);
  const name = worst.subMission.title;
  const target = worst.intendedChange
    ? `${actorLabel(worst.intendedChange.actor, masterRoleId)} set ${intended}`
    : `the plan is ${intended}`;
  return worst.drift === "over"
    ? `${name} (${ordinal(worst.position)}) took ${actual} of the effort; ${target}.`
    : `${name} (${ordinal(worst.position)}) got ${actual} of the effort; ${target}.`;
}

/**
 * Moves `activeId` to where `overId` sits and returns the new id order.
 * Returns the input order unchanged when either id is missing.
 */
export function moveInOrder<T>(order: ReadonlyArray<T>, activeId: T, overId: T): T[] {
  const from = order.indexOf(activeId);
  const to = order.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return [...order];
  const next = [...order];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved as T);
  return next;
}

// ---------------------------------------------------------------------------
// Milestones

export interface MilestoneSummary {
  /** The milestones that share the nearest open target time. */
  readonly milestones: ReadonlyArray<Milestone>;
  readonly targetAt: string;
  readonly atRisk: number;
  readonly done: number;
  readonly total: number;
}

const OPEN_MILESTONE: ReadonlySet<Milestone["status"]> = new Set([
  "planned",
  "on-track",
  "at-risk",
]);

/**
 * The next milestone date with work still open, and every milestone due then.
 * A mission's milestone is usually a bundle ("everything for Monday"), so the
 * header reads "Mon 19 Oct · 1d 20h · 3 at risk".
 */
export function nextMilestone(milestones: ReadonlyArray<Milestone>): MilestoneSummary | null {
  let targetAt: string | null = null;
  for (const milestone of milestones) {
    if (milestone.targetAt === null || !OPEN_MILESTONE.has(milestone.status)) continue;
    if (targetAt === null || Date.parse(milestone.targetAt) < Date.parse(targetAt)) {
      targetAt = milestone.targetAt;
    }
  }
  if (targetAt === null) return null;
  const target = Date.parse(targetAt);
  const due = milestones.filter(
    (milestone) => milestone.targetAt !== null && Date.parse(milestone.targetAt) === target,
  );
  return {
    milestones: due,
    targetAt,
    atRisk: due.filter(
      (milestone) => milestone.status === "at-risk" || milestone.status === "missed",
    ).length,
    done: due.filter((milestone) => milestone.status === "done").length,
    total: due.length,
  };
}

// ---------------------------------------------------------------------------
// Feed and "since you last looked"

export interface FeedSections {
  readonly fresh: ReadonlyArray<FeedItem>;
  readonly earlier: ReadonlyArray<FeedItem>;
}

/** Newest first, split at the owner's last look. Everything is fresh when the owner never looked. */
export function splitFeed(
  feed: ReadonlyArray<FeedItem>,
  ownerLastLookedAt: string | null,
): FeedSections {
  const sorted = [...feed].sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
  if (ownerLastLookedAt === null) return { fresh: sorted, earlier: [] };
  const mark = Date.parse(ownerLastLookedAt);
  return {
    fresh: sorted.filter((item) => Date.parse(item.at) > mark),
    earlier: sorted.filter((item) => Date.parse(item.at) <= mark),
  };
}

const FEED_KIND_ORDER: ReadonlyArray<FeedItem["kind"]> = [
  "shipped",
  "decided",
  "blocked",
  "milestone",
  "note",
];

/** "12 shipped · 3 decided · 2 blocked" */
export function feedCountsLine(feed: ReadonlyArray<FeedItem>): string {
  const counts = new Map<FeedItem["kind"], number>();
  for (const item of feed) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  return FEED_KIND_ORDER.flatMap((kind) => {
    const count = counts.get(kind) ?? 0;
    if (count === 0) return [];
    if (kind === "note") return [plural(count, "note", "notes")];
    if (kind === "milestone") return [plural(count, "milestone", "milestones")];
    return [`${count} ${kind}`];
  }).join(" · ");
}

/** A feed item that points at a draft waits for the owner's approval in the inbox. */
export function isDraftFeedItem(item: FeedItem): boolean {
  return item.ref?.kind === "draft";
}

/** "3h ago", "just now", "4d ago", or a date for anything older than a week. */
export function formatRelative(atIso: string, nowMs: number, timeZone?: string): string {
  const diff = nowMs - Date.parse(atIso);
  if (!Number.isFinite(diff)) return "";
  if (diff < MINUTE_MS) return "just now";
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)}m ago`;
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)}h ago`;
  if (diff < 7 * DAY_MS) return `${Math.floor(diff / DAY_MS)}d ago`;
  return formatDayLabel(atIso, timeZone);
}

/** How long something has waited: under an hour, under a day, or longer. */
export type AgeTier = "minutes" | "hours" | "days";

export interface AgeView {
  /** "now", "52m", "5h", "1d 14h". */
  readonly label: string;
  readonly tier: AgeTier;
}

/** The card age element: a short span since `atIso`, and how loud to show it. */
export function ageView(atIso: string, nowMs: number): AgeView | null {
  const diff = nowMs - Date.parse(atIso);
  if (!Number.isFinite(diff)) return null;
  if (diff < MINUTE_MS) return { label: "now", tier: "minutes" };
  if (diff < HOUR_MS) return { label: `${Math.floor(diff / MINUTE_MS)}m`, tier: "minutes" };
  if (diff < DAY_MS) return { label: `${Math.floor(diff / HOUR_MS)}h`, tier: "hours" };
  const days = Math.floor(diff / DAY_MS);
  const hours = Math.floor((diff % DAY_MS) / HOUR_MS);
  return { label: hours > 0 ? `${days}d ${hours}h` : `${days}d`, tier: "days" };
}

/** "Since you last looked (4h ago)" heading text. */
export function sinceLastLookedLabel(ownerLastLookedAt: string | null, nowMs: number): string {
  if (ownerLastLookedAt === null) return "Everything so far";
  return `Since you last looked, ${formatRelative(ownerLastLookedAt, nowMs)}`;
}

/** "1d 20h", "5h 12m", "42m"; "due now" inside a minute; "overdue 3h" after. */
export function formatCountdown(targetIso: string, nowMs: number): string {
  const diff = Date.parse(targetIso) - nowMs;
  if (!Number.isFinite(diff)) return "";
  const span = Math.abs(diff);
  if (span < MINUTE_MS) return "due now";
  const days = Math.floor(span / DAY_MS);
  const hours = Math.floor((span % DAY_MS) / HOUR_MS);
  const minutes = Math.floor((span % HOUR_MS) / MINUTE_MS);
  const text =
    days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  return diff > 0 ? text : `overdue ${text}`;
}

const dayLabelFormatters = new Map<string, Intl.DateTimeFormat>();

/** "Mon 19 Oct" in the reader's time zone (or `timeZone` when given). */
export function formatDayLabel(atIso: string, timeZone?: string): string {
  const key = timeZone ?? "";
  let formatter = dayLabelFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      ...(timeZone ? { timeZone } : {}),
    });
    dayLabelFormatters.set(key, formatter);
  }
  const atMs = Date.parse(atIso);
  if (!Number.isFinite(atMs)) return "";
  return formatter.format(atMs).replace(",", "");
}

const timeOfDayFormatters = new Map<string, Intl.DateTimeFormat>();

/** "15:41" in the reader's time zone (or `timeZone` when given). */
export function formatTimeOfDay(atIso: string, timeZone?: string): string {
  const key = timeZone ?? "";
  let formatter = timeOfDayFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      ...(timeZone ? { timeZone } : {}),
    });
    timeOfDayFormatters.set(key, formatter);
  }
  const atMs = Date.parse(atIso);
  if (!Number.isFinite(atMs)) return "";
  return formatter.format(atMs);
}

// ---------------------------------------------------------------------------
// Usage

export interface UsageView {
  readonly label: string;
  readonly tone: "normal" | "borrowing" | "unknown";
}

/** `usageShare` is usage against the mission's guaranteed share: 1 means exactly its share. */
export function usageView(usageShare: number | null): UsageView {
  if (usageShare === null || !Number.isFinite(usageShare)) {
    return { label: "Usage not measured yet", tone: "unknown" };
  }
  if (usageShare > 1) {
    return { label: `Borrowing: ${formatMultiplier(usageShare)} its share`, tone: "borrowing" };
  }
  return { label: `${formatPercent(usageShare)} of its share`, tone: "normal" };
}

export type PoolTone = "ok" | "tight" | "out" | "held";

export interface PoolUsageView {
  readonly id: string;
  readonly label: string;
  /** "20/30", "$62 of $500", "free" or "held by cell-devops". */
  readonly value: string;
  readonly tone: PoolTone;
  /** Longer form for a tooltip or screen reader. */
  readonly detail: string;
}

/** Accounts at or below this usable share read as tight. */
export const POOL_TIGHT_SHARE = 0.34;

/** Currency codes read as a prefix ("$62", "EUR 40"); any other unit is counted ("0 of 8 reviews"). */
function formatBudget(spent: number, cap: number, unit: string): string {
  if (unit === "USD") return `$${Math.round(spent)} of $${Math.round(cap)}`;
  if (/^[A-Z]{3}$/.test(unit)) return `${unit} ${Math.round(spent)} of ${unit} ${Math.round(cap)}`;
  const counted = Math.round(cap);
  const noun = counted === 1 || unit.endsWith("s") ? unit : `${unit}s`;
  return `${Math.round(spent)} of ${counted} ${noun}`;
}

/** One compact entry per pool the mission draws on, for the header usage line. */
export function poolUsageView(
  pool: MissionPoolUsage,
  nowMs: number,
  masterRoleId: string | null = null,
): PoolUsageView {
  const sampled = formatRelative(pool.sampledAt, nowMs);
  switch (pool._tag) {
    case "accounts": {
      const share = pool.total === 0 ? 0 : pool.usable / pool.total;
      const tone: PoolTone = pool.usable === 0 ? "out" : share <= POOL_TIGHT_SHARE ? "tight" : "ok";
      return {
        id: pool.id,
        label: pool.label,
        value: `${pool.usable}/${pool.total}`,
        tone,
        detail: `${pool.label}: ${pool.usable} of ${pool.total} usable (read ${sampled})`,
      };
    }
    case "budget": {
      const share = pool.cap === 0 ? 1 : pool.spent / pool.cap;
      const tone: PoolTone = share >= 1 ? "out" : share >= 1 - POOL_TIGHT_SHARE ? "tight" : "ok";
      const value = formatBudget(pool.spent, pool.cap, pool.currency);
      return {
        id: pool.id,
        label: pool.label,
        value,
        tone,
        detail: `${pool.label}: ${value} used (read ${sampled})`,
      };
    }
    case "lock": {
      const holder =
        pool.holder === null
          ? null
          : pool.holder === masterRoleId
            ? "master"
            : pool.holder.replace(/^lane-/, "");
      const since = pool.since === null ? "" : ` since ${formatRelative(pool.since, nowMs)}`;
      return {
        id: pool.id,
        label: pool.label,
        value: holder === null ? "free" : `held by ${holder}`,
        tone: holder === null ? "ok" : "held",
        detail:
          holder === null
            ? `${pool.label}: free${since === "" ? "" : `, released${since.replace(" since", "")}`}`
            : `${pool.label}: held by ${holder}${since}`,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Formatting

export function formatPercent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function formatMultiplier(value: number): string {
  return `${(Math.round(value * 10) / 10).toFixed(1)}×`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function ordinal(position: number): string {
  const mod100 = position % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${position}th`;
  switch (position % 10) {
    case 1:
      return `${position}st`;
    case 2:
      return `${position}nd`;
    case 3:
      return `${position}rd`;
    default:
      return `${position}th`;
  }
}
