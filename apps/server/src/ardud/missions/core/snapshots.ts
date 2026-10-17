import type {
  Approval,
  Ask,
  BlockerGroup,
  Call,
  DirectionCheckItem,
  Draft,
  FeedItem,
  Knock,
  Lane,
  Milestone,
  MissionActor,
  MissionEvent,
  MissionEventKind,
  MissionHealth,
  MissionInbox,
  MissionListItem,
  MissionRecordRef,
  Mission,
  Note,
  Role,
  SubMission,
  Suggestion,
  WorkItem,
} from "@t3tools/contracts";

import { countLanes } from "./health.ts";

/**
 * Pure snapshot assembly. MissionService loads bounded record sets from the
 * store and hands them here; nothing in this file reads storage or the clock.
 */

const SUMMARY_MAX = 400;
export const DIRECTION_CHECK_LIMIT = 20;
export const FEED_LIMIT = 30;
export const CRITICAL_PATH_LIMIT = 30;
export const INBOX_LIST_LIMIT = 50;

export const cutSummary = (text: string): string => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "(no summary)";
  return trimmed.length <= SUMMARY_MAX ? trimmed : `${trimmed.slice(0, SUMMARY_MAX - 1)}…`;
};

const newestFirst = <T>(items: ReadonlyArray<T>, at: (item: T) => string): Array<T> =>
  items.toSorted((left, right) => (at(left) < at(right) ? 1 : at(left) > at(right) ? -1 : 0));

const after = (at: string, since: string | null) => since === null || at > since;

// --- list -------------------------------------------------------------------

export interface ListItemInputs {
  readonly mission: Mission;
  /** Sub-missions shown in the sidebar (not closed). */
  readonly subMissions: ReadonlyArray<SubMission>;
  /** Non-retired lanes of the mission. */
  readonly lanes: ReadonlyArray<Lane>;
  readonly openAsks: ReadonlyArray<Ask>;
  readonly pendingApprovals: number;
  readonly pendingDrafts: number;
  readonly pendingKnocks: number;
  readonly health: MissionHealth;
  readonly subMissionHealth: ReadonlyMap<string, MissionHealth>;
}

export const buildListItem = (inputs: ListItemInputs): MissionListItem => ({
  id: inputs.mission.id,
  title: inputs.mission.title,
  status: inputs.mission.status,
  tier: inputs.mission.tier,
  health: inputs.health,
  needsYou:
    inputs.openAsks.length + inputs.pendingApprovals + inputs.pendingDrafts + inputs.pendingKnocks,
  lanes: countLanes(inputs.lanes),
  subMissions: inputs.subMissions
    .toSorted((left, right) => left.order - right.order)
    .map((subMission) => ({
      id: subMission.id,
      title: subMission.title,
      order: subMission.order,
      status: subMission.status,
      health: inputs.subMissionHealth.get(subMission.id) ?? "unknown",
      needsYou: inputs.openAsks.filter((ask) => ask.subMissionId === subMission.id).length,
      lanes: countLanes(inputs.lanes.filter((lane) => lane.subMissionId === subMission.id)),
    })),
  updatedAt: inputs.mission.updatedAt,
});

// --- direction check ----------------------------------------------------------

/** Structural changes the owner should glance at, besides calls. */
const STRUCTURAL_EVENTS: ReadonlySet<MissionEventKind> = new Set<MissionEventKind>([
  "sub-mission.created",
  "sub-mission.reordered",
  "sub-mission.closed",
  "milestone.created",
  "lane.created",
  "lane.moved",
  "lane.split",
  "lane.merged",
  "lane.retired",
  "role.model-changed",
  "rule.created",
  "rule.updated",
  "rule.retired",
  "review-policy.updated",
]);

export interface DirectionCheckInputs {
  readonly missionId: string;
  /** Calls the owner has not reacted to. */
  readonly calls: ReadonlyArray<Call>;
  /** Recent events, any order. */
  readonly events: ReadonlyArray<MissionEvent>;
  readonly since: string | null;
}

export const buildDirectionCheck = (inputs: DirectionCheckInputs): Array<DirectionCheckItem> => {
  const fromCalls = inputs.calls
    .filter((call) => call.ownerReaction === null && after(call.createdAt, inputs.since))
    .map((call): DirectionCheckItem => ({
      ref: { kind: "call", id: call.id, label: call.title },
      summary: cutSummary(call.title),
      reason: call.decision.length > 0 ? `Call: ${call.decision}` : "Call",
      at: call.createdAt,
    }));
  const fromEvents = inputs.events
    .filter(
      (event) =>
        STRUCTURAL_EVENTS.has(event.kind) &&
        event.actor._tag !== "owner" &&
        after(event.at, inputs.since),
    )
    .map((event): DirectionCheckItem => ({
      ref: event.subject ?? { kind: "mission", id: inputs.missionId },
      summary: event.summary,
      reason: event.kind,
      at: event.at,
    }));
  return newestFirst([...fromCalls, ...fromEvents], (item) => item.at).slice(
    0,
    DIRECTION_CHECK_LIMIT,
  );
};

// --- critical path ------------------------------------------------------------

const workItemRef = (item: WorkItem): MissionRecordRef => ({
  kind: "work-item",
  id: item.id,
  label: item.title,
});

/**
 * The nearest open milestone's unfinished items, dependencies first. A
 * milestone's items are its `itemIds` plus work items pointing at it. Items it
 * depends on outside the milestone are included when unfinished.
 */
export const buildCriticalPath = (
  milestones: ReadonlyArray<Milestone>,
  workItems: ReadonlyArray<WorkItem>,
): Array<MissionRecordRef> => {
  const byId = new Map(workItems.map((item) => [item.id as string, item]));
  const unfinished = (id: string) => {
    const item = byId.get(id);
    return item !== undefined && item.stage !== "done" ? item : null;
  };
  const itemsOf = (milestone: Milestone): ReadonlyArray<string> => [
    ...milestone.itemIds,
    ...workItems
      .filter((item) => item.milestoneId === milestone.id && !milestone.itemIds.includes(item.id))
      .map((item) => item.id),
  ];
  const open = milestones
    .filter((milestone) => milestone.status !== "done" && milestone.status !== "missed")
    .toSorted((left, right) => {
      if (left.targetAt !== right.targetAt) {
        if (left.targetAt === null) return 1;
        if (right.targetAt === null) return -1;
        return left.targetAt < right.targetAt ? -1 : 1;
      }
      return left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0;
    });
  const target = open.find((milestone) => itemsOf(milestone).some((id) => unfinished(id)));
  if (target === undefined) return [];

  const ordered: Array<WorkItem> = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id) || ordered.length >= CRITICAL_PATH_LIMIT) return;
    seen.add(id);
    const item = unfinished(id);
    if (item === null) return;
    for (const dependency of item.dependsOn) visit(dependency);
    if (ordered.length < CRITICAL_PATH_LIMIT) ordered.push(item);
  };
  for (const id of itemsOf(target)) visit(id);
  return ordered.map(workItemRef);
};

// --- blockers -----------------------------------------------------------------

export interface BlockerInputs {
  readonly openAsks: ReadonlyArray<Ask>;
  readonly pendingApprovals: ReadonlyArray<Approval>;
  readonly pendingDrafts: ReadonlyArray<Draft>;
  readonly workItems: ReadonlyArray<WorkItem>;
  readonly lanes: ReadonlyArray<Lane>;
  readonly roles: ReadonlyArray<Role>;
}

const UNASSIGNED: MissionActor = { _tag: "system", component: "unassigned" };

const actorKey = (actor: MissionActor): string => {
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
};

/** Open asks, approvals and drafts wait on the owner; blocked work and stuck lanes on whoever holds them. */
export const buildBlockers = (inputs: BlockerInputs): Array<BlockerGroup> => {
  const roleNames = new Map(inputs.roles.map((role) => [role.id as string, role.name]));
  const laneNames = new Map(inputs.lanes.map((lane) => [lane.id as string, lane.name]));
  const labelOf = (actor: MissionActor): string => {
    switch (actor._tag) {
      case "owner":
        return "You";
      case "role":
        return roleNames.get(actor.roleId) ?? actor.roleId;
      case "lane":
        return laneNames.get(actor.laneId) ?? actor.laneId;
      case "thread":
        return `Thread ${actor.threadId}`;
      case "system":
        return actor.component;
      case "person":
        return actor.name;
    }
  };

  const groups = new Map<string, { holder: MissionActor; items: Array<MissionRecordRef> }>();
  const add = (holder: MissionActor, ref: MissionRecordRef) => {
    const key = actorKey(holder);
    const group = groups.get(key) ?? { holder, items: [] };
    group.items.push(ref);
    groups.set(key, group);
  };

  const owner: MissionActor = { _tag: "owner" };
  for (const ask of newestFirst(inputs.openAsks, (ask) => ask.createdAt)) {
    add(owner, { kind: "ask", id: ask.id, label: ask.question });
  }
  for (const approval of newestFirst(inputs.pendingApprovals, (approval) => approval.createdAt)) {
    add(owner, { kind: "approval", id: approval.id, label: approval.title });
  }
  for (const draft of newestFirst(inputs.pendingDrafts, (draft) => draft.createdAt)) {
    add(owner, { kind: "draft", id: draft.id, label: draft.audience });
  }
  for (const item of inputs.workItems) {
    if (item.stage !== "done" && item.blockedBy.length > 0) {
      add(item.heldBy ?? UNASSIGNED, workItemRef(item));
    }
  }
  for (const lane of inputs.lanes) {
    if (lane.status === "stuck") {
      const holder: MissionActor =
        lane.leadRoleId === null
          ? { _tag: "lane", laneId: lane.id }
          : { _tag: "role", roleId: lane.leadRoleId };
      add(holder, { kind: "lane", id: lane.id, label: lane.name });
    }
  }
  return [...groups.values()].map((group) => ({
    holder: group.holder,
    holderLabel: labelOf(group.holder),
    items: group.items,
  }));
};

// --- feed ---------------------------------------------------------------------

const DECIDED_EVENTS: ReadonlySet<MissionEventKind> = new Set<MissionEventKind>([
  "call.made",
  "ask.answered",
  "approval.decided",
  "draft.decided",
  "suggestion.decided",
  "rule.created",
  "rule.updated",
  "rule.retired",
]);
const SHIPPED_STAGES: ReadonlySet<string> = new Set(["deploy", "readback", "exercised", "done"]);

const payloadField = (payload: unknown, field: string): unknown =>
  typeof payload === "object" && payload !== null && field in payload
    ? (payload as Record<string, unknown>)[field]
    : undefined;

const feedKindOf = (event: MissionEvent): FeedItem["kind"] | null => {
  if (DECIDED_EVENTS.has(event.kind)) return "decided";
  switch (event.kind) {
    case "milestone.created":
    case "milestone.updated":
      return "milestone";
    case "work-item.updated": {
      const stage = payloadField(event.payload, "stage");
      const changed = payloadField(event.payload, "changed");
      return typeof stage === "string" &&
        SHIPPED_STAGES.has(stage) &&
        Array.isArray(changed) &&
        changed.includes("stage")
        ? "shipped"
        : null;
    }
    case "lane.updated":
      return payloadField(event.payload, "status") === "stuck" ? "blocked" : null;
    default:
      return null;
  }
};

export interface FeedInputs {
  readonly events: ReadonlyArray<MissionEvent>;
  readonly notes: ReadonlyArray<Note>;
  readonly since: string | null;
}

export const buildFeed = (inputs: FeedInputs): Array<FeedItem> => {
  const fromEvents = inputs.events.flatMap((event): Array<FeedItem> => {
    if (!after(event.at, inputs.since)) return [];
    const kind = feedKindOf(event);
    return kind === null
      ? []
      : [{ kind, summary: event.summary, ref: event.subject, at: event.at }];
  });
  const fromNotes = inputs.notes
    .filter((note) => note.citation !== "failed" && after(note.createdAt, inputs.since))
    .map((note): FeedItem => ({
      kind: note.type === "blocker" ? "blocked" : "note",
      summary: note.summary,
      ref: { kind: "note", id: note.id },
      at: note.createdAt,
    }));
  return newestFirst([...fromEvents, ...fromNotes], (item) => item.at).slice(0, FEED_LIMIT);
};

// --- inbox --------------------------------------------------------------------

const SEVERITY_RANK: Record<Note["severity"], number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/**
 * Notes the owner should see: owner-must-know or high severity, cited, not yet
 * acknowledged by the owner. Owner-must-know first, then severity, then newest.
 */
export const rankFyi = (notes: ReadonlyArray<Note>): Array<Note> =>
  notes
    .filter(
      (note) =>
        note.citation !== "failed" &&
        !note.ackedBy.some((actor) => actor._tag === "owner") &&
        (note.type === "owner-must-know" || SEVERITY_RANK[note.severity] >= SEVERITY_RANK.high),
    )
    .toSorted((left, right) => {
      const mustKnow =
        Number(right.type === "owner-must-know") - Number(left.type === "owner-must-know");
      if (mustKnow !== 0) return mustKnow;
      const severity = SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity];
      if (severity !== 0) return severity;
      return left.createdAt < right.createdAt ? 1 : left.createdAt > right.createdAt ? -1 : 0;
    });

export interface InboxInputs {
  readonly revision: number;
  readonly openAsks: ReadonlyArray<Ask>;
  readonly pendingDrafts: ReadonlyArray<Draft>;
  readonly pendingApprovals: ReadonlyArray<Approval>;
  readonly pendingKnocks: ReadonlyArray<Knock>;
  /** Open suggestions the owner accepts. */
  readonly suggestions: ReadonlyArray<Suggestion>;
  /** Already ranked. */
  readonly fyi: ReadonlyArray<Note>;
}

export const buildInbox = (inputs: InboxInputs): MissionInbox => {
  const bounded = <T extends { readonly createdAt: string }>(items: ReadonlyArray<T>) =>
    newestFirst(items, (item) => item.createdAt).slice(0, INBOX_LIST_LIMIT);
  return {
    revision: inputs.revision,
    counts: {
      decide: inputs.openAsks.length,
      approve: inputs.pendingApprovals.length + inputs.pendingDrafts.length,
      knocks: inputs.pendingKnocks.length,
      suggestions: inputs.suggestions.length,
      fyi: inputs.fyi.length,
    },
    asks: bounded(inputs.openAsks),
    drafts: bounded(inputs.pendingDrafts),
    approvals: bounded(inputs.pendingApprovals),
    knocks: bounded(inputs.pendingKnocks),
    suggestions: bounded(inputs.suggestions),
    fyi: inputs.fyi.slice(0, INBOX_LIST_LIMIT),
  };
};
