import type {
  FeedItem,
  MilestoneStatus,
  MissionHealth,
  MissionListItem,
  MissionOverview,
  ReorderSubMissionsInput,
  RoomKind,
  SubMissionId,
} from "@t3tools/contracts";

import type { MissionRoomEntry } from "../source.ts";
import {
  badgeCount,
  ballHolderLine,
  criticalPathView,
  effortNote,
  feedCountsLine,
  foldLaneCounts,
  formatCountdown,
  formatDayLabel,
  formatPercent,
  formatRelative,
  healthLabel,
  isDraftFeedItem,
  nextMilestone,
  orderBlockerGroups,
  priorityStack,
  refKey,
  refLabel,
  sinceLastLookedLabel,
  splitFeed,
  usageView,
  type EffortDrift,
} from "../viewModel.ts";

// Mission list, overview and rooms as plain view data for the phone. Wording
// matches the web overview so the owner reads the same thing on every surface.

/** Health as a tone the screens map to colours. Paused work reads as muted. */
export type HealthTone = MissionHealth | "paused";

export function healthTone(health: MissionHealth, paused: boolean): HealthTone {
  return paused ? "paused" : health;
}

export function healthToneLabel(tone: HealthTone): string {
  return tone === "paused" ? "Paused" : healthLabel(tone);
}

// ---------------------------------------------------------------------------
// Mission list

type ListSubMission = MissionListItem["subMissions"][number];

export interface MissionListSubRow {
  readonly id: SubMissionId;
  readonly position: number;
  readonly title: string;
  readonly tone: HealthTone;
  readonly paused: boolean;
  /** Badge text, or `null` when nothing needs the owner. */
  readonly needsYou: string | null;
}

export interface MissionListRow {
  readonly id: MissionListItem["id"];
  readonly title: string;
  readonly tier: MissionListItem["tier"];
  readonly tone: HealthTone;
  readonly toneLabel: string;
  readonly paused: boolean;
  readonly needsYou: string | null;
  readonly needsYouLabel: string | null;
  /** "37 lanes: 21 working, 2 stuck, 14 idle" */
  readonly lanesLine: string;
  readonly subMissions: ReadonlyArray<MissionListSubRow>;
}

function needsYouBadge(count: number): string | null {
  return count > 0 ? badgeCount(count) : null;
}

function needsYouA11y(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? "1 item needs you" : `${count} items need you`;
}

/** Sub-missions in the owner's order, closed ones dropped. */
export function listSubMissionRows(
  subMissions: ReadonlyArray<ListSubMission>,
): MissionListSubRow[] {
  return [...subMissions]
    .filter((sub) => sub.status !== "closed")
    .sort((left, right) => left.order - right.order || left.title.localeCompare(right.title))
    .map((sub, index) => {
      const paused = sub.status === "paused";
      return {
        id: sub.id,
        position: index + 1,
        title: sub.title,
        tone: healthTone(sub.health, paused),
        paused,
        needsYou: needsYouBadge(sub.needsYou),
      };
    });
}

/** Archived missions drop out; the rest keep the server's order. */
export function missionListRows(missions: ReadonlyArray<MissionListItem>): MissionListRow[] {
  return missions
    .filter((mission) => mission.status !== "archived")
    .map((mission) => {
      const paused = mission.status === "paused";
      const tone = healthTone(mission.health, paused);
      return {
        id: mission.id,
        title: mission.title,
        tier: mission.tier,
        tone,
        toneLabel: healthToneLabel(tone),
        paused,
        needsYou: needsYouBadge(mission.needsYou),
        needsYouLabel: needsYouA11y(mission.needsYou),
        // The fold's parts already carry their counts ("21 working"); render the line as is.
        lanesLine: foldLaneCounts(mission.lanes).line,
        subMissions: listSubMissionRows(mission.subMissions),
      };
    });
}

// ---------------------------------------------------------------------------
// Overview header

export interface OverviewHeaderView {
  readonly goal: string;
  readonly tone: HealthTone;
  readonly toneLabel: string;
  readonly paused: boolean;
  /** "Mon 19 Oct · 1d 20h · 3 at risk · 1/4 done", or `null` with no open milestone. */
  readonly milestoneLine: string | null;
  readonly usage: ReturnType<typeof usageView>;
  readonly lanesLine: string;
  readonly focusTitle: string | null;
}

export function overviewHeaderView(overview: MissionOverview, nowMs: number): OverviewHeaderView {
  const { mission } = overview;
  const paused = mission.status === "paused";
  const tone = healthTone(mission.health, paused);
  const next = nextMilestone(overview.milestones);
  const milestoneLine = next
    ? [
        formatDayLabel(next.targetAt),
        formatCountdown(next.targetAt, nowMs),
        ...(next.atRisk > 0 ? [`${next.atRisk} at risk`] : []),
        `${next.done}/${next.total} done`,
      ].join(" · ")
    : null;
  const focus = overview.subMissions.find((sub) => sub.id === mission.focusSubMissionId);
  return {
    goal: mission.goal,
    tone,
    toneLabel: healthToneLabel(tone),
    paused,
    milestoneLine,
    usage: usageView(overview.usageShare),
    lanesLine: foldLaneCounts(overview.lanes).line,
    focusTitle: focus?.title ?? null,
  };
}

/** "Master's bottom line, 2h ago", or `null` when the master has not written one. */
export function bottomLineCaption(overview: MissionOverview, nowMs: number): string | null {
  if (overview.bottomLine.trim() === "") return null;
  return overview.bottomLineAt
    ? `Master's bottom line, ${formatRelative(overview.bottomLineAt, nowMs)}`
    : "Master's bottom line";
}

// ---------------------------------------------------------------------------
// Blockers

export interface BlockerGroupView {
  readonly key: string;
  readonly label: string;
  readonly isOwner: boolean;
  readonly items: ReadonlyArray<{ readonly key: string; readonly label: string }>;
}

export interface BlockersView {
  /** "you 2 · master 4", or `null` when nothing is blocked. */
  readonly caption: string | null;
  readonly groups: ReadonlyArray<BlockerGroupView>;
}

export function blockersView(overview: Pick<MissionOverview, "blockers">): BlockersView {
  const groups = orderBlockerGroups(overview.blockers);
  return {
    caption: groups.length > 0 ? ballHolderLine(groups) : null,
    groups: groups.map((group) => {
      const isOwner = group.holder._tag === "owner";
      return {
        key: `${group.holder._tag}:${group.holderLabel}`,
        label: isOwner ? "You" : group.holderLabel,
        isOwner,
        items: group.items.map((item) => ({ key: refKey(item), label: refLabel(item) })),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Critical path

export const MILESTONE_LABEL: Readonly<Record<MilestoneStatus, string>> = {
  planned: "Planned",
  "on-track": "On track",
  "at-risk": "At risk",
  done: "Done",
  missed: "Missed",
};

export interface CriticalPathScreenView {
  /** "Critical path to Mon 19 Oct" */
  readonly title: string;
  /** "1 of 4 links blocked", "Nothing blocked", or `null` with no path. */
  readonly caption: string | null;
  readonly steps: ReadonlyArray<{
    readonly key: string;
    readonly label: string;
    /** "Blocked, ball with you", or `null` when the link is clear. */
    readonly blockedLine: string | null;
  }>;
  /** "4 milestones · 1d 20h left", or `null` with no milestones. */
  readonly milestonesLine: string | null;
  readonly milestones: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly status: MilestoneStatus;
    readonly statusLabel: string;
    readonly note: string | null;
  }>;
}

export function criticalPathScreenView(
  overview: Pick<MissionOverview, "criticalPath" | "blockers" | "milestones">,
  nowMs: number,
): CriticalPathScreenView {
  const path = criticalPathView(overview.criticalPath, overview.blockers);
  const milestones = [...overview.milestones].sort((left, right) =>
    (left.targetAt ?? "").localeCompare(right.targetAt ?? ""),
  );
  const target = milestones.find((milestone) => milestone.targetAt !== null)?.targetAt ?? null;
  const caption =
    path.steps.length === 0
      ? null
      : path.blockedCount > 0
        ? `${path.blockedCount} of ${path.steps.length} links blocked`
        : "Nothing blocked";
  const count = milestones.length;
  const milestonesLine =
    count === 0
      ? null
      : `${count === 1 ? "1 milestone" : `${count} milestones`}${
          target ? ` · ${formatCountdown(target, nowMs)} left` : ""
        }`;
  return {
    title: target ? `Critical path to ${formatDayLabel(target)}` : "Critical path",
    caption,
    steps: path.steps.map((step) => ({
      key: refKey(step.ref),
      label: refLabel(step.ref),
      blockedLine: step.heldBy ? `Blocked, ball with ${step.heldBy}` : null,
    })),
    milestonesLine,
    milestones: milestones.map((milestone) => ({
      id: milestone.id,
      title: milestone.title,
      status: milestone.status,
      statusLabel: MILESTONE_LABEL[milestone.status],
      note: milestone.statusNote,
    })),
  };
}

// ---------------------------------------------------------------------------
// Direction check

export function directionCheckCaption(
  overview: Pick<MissionOverview, "ownerLastLookedAt">,
  nowMs: number,
): string {
  return `Calls you may want to reverse. ${sinceLastLookedLabel(overview.ownerLastLookedAt, nowMs)}.`;
}

// ---------------------------------------------------------------------------
// Priority stack

export interface PriorityRowView {
  readonly id: SubMissionId;
  readonly position: number;
  readonly title: string;
  readonly tone: HealthTone;
  readonly tags: ReadonlyArray<string>;
  /** "34% / 30%" (actual / intended), "– / 30%" before effort is measured. */
  readonly effortLine: string;
  readonly effortA11y: string;
  readonly drift: EffortDrift;
  /** Bar fill and intended tick, 0..1, for whatever the design draws. */
  readonly actual: number | null;
  readonly intended: number | null;
}

export interface PriorityStackView {
  readonly rows: ReadonlyArray<PriorityRowView>;
  readonly note: string | null;
}

export function priorityStackView(
  overview: Pick<MissionOverview, "subMissions" | "mission">,
): PriorityStackView {
  const rows = priorityStack(overview.subMissions);
  return {
    rows: rows.map((row) => {
      const sub = row.subMission;
      const paused = sub.status === "paused";
      const actual = row.actual === null ? "–" : formatPercent(row.actual);
      const intended = row.intended === null ? "–" : formatPercent(row.intended);
      return {
        id: sub.id,
        position: row.position,
        title: sub.title,
        tone: healthTone(sub.health, paused),
        tags: [
          ...(overview.mission.focusSubMissionId === sub.id ? ["focus"] : []),
          ...(sub.fillIdleCapacity ? ["fills idle"] : []),
          ...(paused ? ["paused"] : []),
        ],
        effortLine: `${actual} / ${intended}`,
        effortA11y: `${actual} of effort, intended ${intended}`,
        drift: row.drift,
        actual: row.actual,
        intended: row.intended,
      };
    }),
    note: effortNote(rows),
  };
}

/**
 * The stack after moving one sub-mission a step up or down, as the input the
 * source expects. `null` when the move would fall off either end.
 */
export function moveSubMissionInput(
  overview: Pick<MissionOverview, "mission" | "subMissions">,
  subMissionId: SubMissionId,
  direction: "up" | "down",
): ReorderSubMissionsInput | null {
  const order = priorityStack(overview.subMissions).map((row) => row.subMission.id);
  const from = order.indexOf(subMissionId);
  if (from < 0) return null;
  const to = direction === "up" ? from - 1 : from + 1;
  if (to < 0 || to >= order.length) return null;
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, subMissionId);
  return { missionId: overview.mission.id, order: next };
}

// ---------------------------------------------------------------------------
// Feed

export const FEED_KIND_LABEL: Readonly<Record<FeedItem["kind"], string>> = {
  shipped: "Shipped",
  decided: "Decided",
  blocked: "Blocked",
  milestone: "Milestone",
  note: "Note",
};

export interface FeedItemView {
  readonly key: string;
  readonly kind: FeedItem["kind"];
  readonly kindLabel: string;
  readonly summary: string;
  readonly at: string;
  /** Draft items open the Approve segment of the inbox. */
  readonly opensDraft: boolean;
}

export interface FeedView {
  /** "Since you last looked, 3h ago" */
  readonly title: string;
  /** "12 shipped · 3 decided", "Nothing new", or `null` when the feed is empty. */
  readonly caption: string | null;
  readonly canMarkSeen: boolean;
  readonly fresh: ReadonlyArray<FeedItemView>;
  readonly earlier: ReadonlyArray<FeedItemView>;
}

function feedItemView(item: FeedItem, nowMs: number): FeedItemView {
  return {
    key: `${item.at}-${item.ref ? refKey(item.ref) : item.summary}`,
    kind: item.kind,
    kindLabel: FEED_KIND_LABEL[item.kind],
    summary: item.summary,
    at: formatRelative(item.at, nowMs),
    opensDraft: isDraftFeedItem(item),
  };
}

export function feedView(
  overview: Pick<MissionOverview, "feed" | "ownerLastLookedAt">,
  nowMs: number,
): FeedView {
  const { fresh, earlier } = splitFeed(overview.feed, overview.ownerLastLookedAt);
  return {
    title: sinceLastLookedLabel(overview.ownerLastLookedAt, nowMs),
    caption:
      fresh.length > 0 ? feedCountsLine(fresh) : overview.feed.length > 0 ? "Nothing new" : null,
    canMarkSeen: fresh.length > 0,
    fresh: fresh.map((item) => feedItemView(item, nowMs)),
    earlier: earlier.map((item) => feedItemView(item, nowMs)),
  };
}

// ---------------------------------------------------------------------------
// Rooms

export const ROOM_KIND_LABEL: Readonly<Record<RoomKind, string>> = {
  "sub-mission": "Sub-mission",
  "work-item": "Work item",
  control: "Control",
  release: "Release",
  arch: "Architecture",
  lane: "Lane",
  custom: "Custom",
};

export interface RoomRowView {
  readonly id: MissionRoomEntry["room"]["id"];
  readonly title: string;
  readonly kindLabel: string;
  readonly unread: number;
  readonly unreadBadge: string | null;
  /** "Sub-mission · 59 msgs/h · 55% actionable · 2m ago" */
  readonly meta: string;
}

function noiseParts(noise: MissionRoomEntry["room"]["noise"]): string[] {
  if (!noise) return [];
  const rate = noise.messagesPerHour;
  const rateText = rate >= 10 ? Math.round(rate).toString() : rate.toFixed(1);
  return [`${rateText} msgs/h`, `${formatPercent(noise.actionableShare)} actionable`];
}

/** Rooms with unread messages first, then most recent; archived rooms drop out. */
export function roomRows(entries: ReadonlyArray<MissionRoomEntry>, nowMs: number): RoomRowView[] {
  return entries
    .filter((entry) => !entry.room.archived)
    .sort((left, right) => {
      const unread = Number(right.unread > 0) - Number(left.unread > 0);
      if (unread !== 0) return unread;
      const leftAt = left.room.lastMessageAt ? Date.parse(left.room.lastMessageAt) : 0;
      const rightAt = right.room.lastMessageAt ? Date.parse(right.room.lastMessageAt) : 0;
      return rightAt - leftAt || left.room.title.localeCompare(right.room.title);
    })
    .map(({ room, unread }) => ({
      id: room.id,
      title: room.title,
      kindLabel: ROOM_KIND_LABEL[room.kind],
      unread,
      unreadBadge: unread > 0 ? badgeCount(unread) : null,
      meta: [
        ROOM_KIND_LABEL[room.kind],
        ...noiseParts(room.noise),
        ...(room.lastMessageAt ? [formatRelative(room.lastMessageAt, nowMs)] : []),
      ].join(" · "),
    }));
}

export function unreadTotal(entries: ReadonlyArray<MissionRoomEntry>): number {
  return entries.reduce((sum, entry) => sum + (entry.room.archived ? 0 : entry.unread), 0);
}
