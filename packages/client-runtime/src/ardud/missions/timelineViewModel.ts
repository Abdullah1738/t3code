import type { MissionActor } from "@t3tools/contracts";

import type { MissionTimelineEvent } from "./source.ts";
import { actorKey, actorLabel } from "./viewModel.ts";

// Timeline tab: the mission's event log, newest first, filtered by kind and
// actor, with each event's cause chain and the lane successions pulled out.

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
  | "recovery"
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
  recovery: "Recovery",
  other: "Other",
};

const PREFIX_GROUP: Record<string, TimelineKindGroup> = {
  mission: "mission",
  portfolio: "mission",
  "sub-mission": "sub-mission",
  milestone: "sub-mission",
  lane: "lane",
  role: "role",
  rule: "rule",
  "review-policy": "review",
  criticality: "review",
  review: "review",
  pool: "pool",
  routing: "routing",
  record: "routing",
  ask: "inbox",
  call: "inbox",
  draft: "inbox",
  approval: "inbox",
  suggestion: "inbox",
  knock: "inbox",
  fork: "inbox",
  recovery: "recovery",
};

export function kindGroup(kind: string): TimelineKindGroup {
  return PREFIX_GROUP[kind.split(".")[0] ?? ""] ?? "other";
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
      (filter.groups.length === 0 || filter.groups.includes(kindGroup(event.kind))) &&
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

/** Kind groups present in the log, with counts, in label order. */
export function kindChoices(
  events: ReadonlyArray<MissionTimelineEvent>,
): FilterChoice<TimelineKindGroup>[] {
  const counts = new Map<TimelineKindGroup, number>();
  for (const event of events) {
    const group = kindGroup(event.kind);
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  return [...counts]
    .map(([value, count]) => ({ value, label: TIMELINE_KIND_GROUP_LABEL[value], count }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

/** Actors present in the log, you and the master first, then by how often they appear. */
export function actorChoices(
  events: ReadonlyArray<MissionTimelineEvent>,
  masterRoleId: string | null,
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
    .sort(
      ([, left], [, right]) =>
        rank(left.actor) - rank(right.actor) ||
        right.count - left.count ||
        actorLabel(left.actor, masterRoleId).localeCompare(actorLabel(right.actor, masterRoleId)),
    )
    .map(([value, entry]) => ({
      value,
      label: actorLabel(entry.actor, masterRoleId),
      count: entry.count,
    }));
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

export interface SuccessionEntry {
  readonly event: MissionTimelineEvent;
  /** The lane or role that changed threads. */
  readonly who: string;
}

/** Lane and role handoffs (`role.succession`), newest first. */
export function successions(
  events: ReadonlyArray<MissionTimelineEvent>,
  masterRoleId: string | null,
): SuccessionEntry[] {
  return events
    .filter((event) => event.kind === "role.succession")
    .sort((left, right) => right.seq - left.seq)
    .map((event) => ({
      event,
      who:
        event.subject?.kind === "lane"
          ? event.subject.id.replace(/^lane-/, "")
          : event.subject?.kind === "role" && event.subject.id === masterRoleId
            ? "master"
            : (event.subject?.label ?? event.subject?.id ?? actorLabel(event.actor, masterRoleId)),
    }));
}

export interface TimelineEventRow {
  readonly event: MissionTimelineEvent;
  readonly actor: string;
  readonly group: TimelineKindGroup;
  /** Present when the event has a recorded cause in the log. */
  readonly causeSummary: string | null;
  readonly consequenceCount: number;
}

export function timelineRows(
  events: ReadonlyArray<MissionTimelineEvent>,
  all: ReadonlyArray<MissionTimelineEvent>,
  masterRoleId: string | null,
): TimelineEventRow[] {
  const byId = new Map(all.map((event) => [event.id as string, event]));
  const caused = new Map<string, number>();
  for (const event of all) {
    if (event.causedBy) caused.set(event.causedBy, (caused.get(event.causedBy) ?? 0) + 1);
  }
  return events.map((event) => ({
    event,
    actor: actorLabel(event.actor, masterRoleId),
    group: kindGroup(event.kind),
    causeSummary: event.causedBy ? (byId.get(event.causedBy)?.summary ?? null) : null,
    consequenceCount: caused.get(event.id) ?? 0,
  }));
}
