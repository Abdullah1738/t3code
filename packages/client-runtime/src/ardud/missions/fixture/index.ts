import {
  Approval,
  approverOf,
  Ask,
  Call,
  Draft,
  DraftNote,
  Knock,
  Lane,
  Milestone,
  Mission,
  type MissionInboxHistory,
  type MissionListItem,
  type MissionListSnapshot,
  MissionMessage,
  FeedItem,
  // --- finish-a ---
  type InboxItemRef,
  type InboxMark,
  // --- end finish-a ---
  MissionActor,
  MissionRecordRef,
  type MissionProvenance,
  // --- fix-p3 ---
  type MissionRoomActivity,
  type MissionRoomActivityInput,
  // --- end fix-p3 ---
  Note,
  type OwnerSurface,
  Room,
  type RoomPage,
  Rule,
  SubMission,
  Subscription,
  Suggestion,
  SuggestionStats,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { latestFieldChanges } from "../changeLog.ts";
import { routeApproval, routeDraft, routeMatchKey } from "../routingViewModel.ts";
import type {
  ApprovalRoutingTable,
  Listener,
  MissionInboxSnapshot,
  MissionOverviewSnapshot,
  MissionPoolUsage,
  MissionRoomEntry,
  MissionsSource,
  Unsubscribe,
} from "../source.ts";
import { actorKey, groupBlockers, laneCountsOf, type HeldItem } from "../viewModel.ts";
import * as data from "./data.ts";
import { createEventLog } from "./eventLog.ts";
import { createOperations } from "./operations.ts";
import * as ops from "./opsData.ts";
import { createRequests } from "./requests.ts";
import { createViews } from "./views.ts";
import { RerouteSeed, RoutingTableSeed } from "./schemas.ts";
import { clampSummary, fail, newestFirst, replace } from "./util.ts";

const HeldItemFixture = Schema.Struct({
  holder: Schema.Struct({ actor: MissionActor, label: Schema.String }),
  item: MissionRecordRef,
});

const decodeMissions = Schema.decodeUnknownSync(Schema.Array(Mission));
const decodeSubMissions = Schema.decodeUnknownSync(Schema.Array(SubMission));
const decodeMilestones = Schema.decodeUnknownSync(Schema.Array(Milestone));
const decodeLanes = Schema.decodeUnknownSync(Schema.Array(Lane));
const decodeAsks = Schema.decodeUnknownSync(Schema.Array(Ask));
const decodeDrafts = Schema.decodeUnknownSync(Schema.Array(Draft));
const decodeKnocks = Schema.decodeUnknownSync(Schema.Array(Knock));
const decodeSuggestions = Schema.decodeUnknownSync(Schema.Array(Suggestion));
const decodeNotes = Schema.decodeUnknownSync(Schema.Array(Note));
const decodeCalls = Schema.decodeUnknownSync(Schema.Array(Call));
const decodeApprovals = Schema.decodeUnknownSync(Schema.Array(Approval));
const decodeRooms = Schema.decodeUnknownSync(Schema.Array(Room));
const decodeRefs = Schema.decodeUnknownSync(Schema.Array(MissionRecordRef));
const decodeFeed = Schema.decodeUnknownSync(Schema.Array(FeedItem));
const decodeHeld = Schema.decodeUnknownSync(Schema.Array(HeldItemFixture));
const decodeDraftNotes = Schema.decodeUnknownSync(Schema.Array(DraftNote));
const decodeDraftNote = Schema.decodeUnknownSync(DraftNote);
const decodeStats = Schema.decodeUnknownSync(Schema.Array(SuggestionStats));
const decodeMessages = Schema.decodeUnknownSync(Schema.Array(MissionMessage));
const decodeMessage = Schema.decodeUnknownSync(MissionMessage);
const decodeSubscriptions = Schema.decodeUnknownSync(Schema.Array(Subscription));
const decodeRules = Schema.decodeUnknownSync(Schema.Array(Rule));
const decodeRule = Schema.decodeUnknownSync(Rule);
const decodeRoutingTables = Schema.decodeUnknownSync(Schema.Array(RoutingTableSeed));
const decodeRoutingTableExit = Schema.decodeUnknownExit(RoutingTableSeed);

const decodeReroutes = Schema.decodeUnknownSync(Schema.Array(RerouteSeed));

type ApprovalRoutingTableRecord = typeof RoutingTableSeed.Type;

/** The table in force when a record was created: the newest one updated at or before it. */
function tableAt(
  tables: ReadonlyArray<ApprovalRoutingTableRecord>,
  missionId: string,
  createdAt: string,
): ApprovalRoutingTableRecord | null {
  return (
    tables
      .filter((table) => table.missionId === missionId && table.updatedAt <= createdAt)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null
  );
}

/** Newest room page size; a page reaches further back to show the first unread. */
const ROOM_PAGE_SIZE = 40;
/** Never hand a screen more than this many messages in one page. */
const ROOM_PAGE_MAX = 200;
/** How long a decided item stays in the inbox history. */
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface FixtureMissionsSourceOptions {
  /** Clock for owner actions. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Which client the owner acts from, recorded on answers and decisions. */
  readonly surface?: OwnerSurface;
}

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 } as const;
const TIER_RANK = { P0: 0, P1: 1, P2: 2 } as const;

/** Snapshot content without its top-level `revision`, for change detection. */
function contentKey(value: unknown): string {
  return JSON.stringify(value, (key, entry: unknown) => (key === "revision" ? undefined : entry));
}

/**
 * In-memory `MissionsSource` seeded with the real Crpko snapshot in `data.ts`.
 * Owner actions update the fixture state and every open subscription sees the
 * change, so screens behave as they will against the server.
 */
export function createFixtureMissionsSource(
  options: FixtureMissionsSourceOptions = {},
): MissionsSource {
  const now = options.now ?? Date.now;
  const surface = options.surface ?? "web";

  // Records are immutable: every change replaces the record, so a snapshot
  // handed to a screen never changes under it.
  const missions: Mission[] = [...decodeMissions(data.missions)];
  const subMissions: SubMission[] = [...decodeSubMissions(data.subMissions)];
  const milestones = decodeMilestones(data.milestones);
  const lanes: Lane[] = [...decodeLanes(ops.lanes)];
  const asks: Ask[] = [...decodeAsks(data.asks)];
  const drafts: Draft[] = [...decodeDrafts(data.drafts)];
  const knocks: Knock[] = [...decodeKnocks(data.knocks)];
  const suggestions: Suggestion[] = [
    ...decodeSuggestions([...data.suggestions, ...ops.ruleSuggestions]),
  ];
  const approvals: Approval[] = [...decodeApprovals(data.approvals)];
  const notes: Note[] = [...decodeNotes(data.notes)];
  const calls: Call[] = [...decodeCalls(data.calls)];
  const draftNotes: DraftNote[] = [...decodeDraftNotes(data.draftNotes)];
  const stats: SuggestionStats[] = [...decodeStats(data.suggestionStats)];
  const rules: Rule[] = [...decodeRules(ops.rules)];
  const poolUsage = new Map<string, ReadonlyArray<MissionPoolUsage>>(
    Object.entries(data.poolUsage),
  );
  const subscriptions: Subscription[] = [...decodeSubscriptions(data.roomSubscriptions)];
  // Messages per room, oldest first. Seqs are monotonic per mission.
  const messagesByRoom = new Map<string, MissionMessage[]>();
  for (const message of decodeMessages(data.messages)) {
    const list = messagesByRoom.get(message.roomId) ?? [];
    list.push(message);
    messagesByRoom.set(message.roomId, list);
  }
  for (const list of messagesByRoom.values()) list.sort((left, right) => left.seq - right.seq);
  let lastSeq = Math.max(0, ...[...messagesByRoom.values()].flat().map((m) => m.seq));
  const ownerReadSeq = new Map<string, number>(Object.entries(data.ownerReadSeq));
  // Room records derive lastSeq/lastMessageAt from their messages.
  const roomRecord = (def: (typeof data.roomDefs)[number]) => {
    const list = messagesByRoom.get(def.id) ?? [];
    const last = list.at(-1);
    return {
      ...def,
      lastSeq: last?.seq ?? 0,
      lastMessageAt: last?.createdAt ?? null,
      messageCount: list.length,
    };
  };
  const rooms: Room[] = [...decodeRooms(data.roomDefs.map(roomRecord))];
  let nextLocalId = 1;
  const localId = (prefix: string) => `${prefix}-local-${nextLocalId++}`;
  const criticalPath = decodeRefs(data.criticalPath);
  const feed = decodeFeed(data.feed);
  const held: HeldItem[] = decodeHeld(data.heldItems).map(({ holder, item }) => ({
    holder: holder.actor,
    holderLabel: holder.label,
    item,
  }));
  const ownerLastLookedAt = new Map<string, string | null>(Object.entries(data.ownerLastLookedAt));
  const routingTables: ApprovalRoutingTableRecord[] = [...decodeRoutingTables([ops.routing])];

  // --- finish-a ---
  // The owner's comments and snoozes, one mark per inbox item. A snooze keeps
  // the item's JSON as its stamp; any change to the item drops it.
  const marks = new Map<string, InboxMark>();
  const inboxRecord = (
    subject: InboxItemRef,
  ): { readonly missionId: string | null } | undefined => {
    const lists = {
      ask: asks,
      draft: drafts,
      approval: approvals,
      knock: knocks,
      suggestion: suggestions,
      note: notes,
    };
    return (
      lists[subject.kind] as ReadonlyArray<{
        readonly id: string;
        readonly missionId: string | null;
      }>
    ).find((record) => record.id === subject.id);
  };
  const liveMarks = (missionId: string | null): ReadonlyArray<InboxMark> =>
    [...marks.values()].flatMap((mark) => {
      if (missionId !== null && mark.missionId !== missionId) return [];
      const record = inboxRecord(mark.subject);
      const holds =
        mark.snooze !== null &&
        JSON.stringify(record) === mark.snooze.stamp &&
        (mark.snooze.until === null || Date.parse(mark.snooze.until) > now());
      const kept = holds ? mark : { ...mark, snooze: null };
      return kept.comments.length > 0 || kept.snooze !== null ? [kept] : [];
    });
  const markFor = (subject: InboxItemRef, at: string): InboxMark => {
    const id = `${subject.kind}:${subject.id}`;
    const record = inboxRecord(subject);
    return (
      marks.get(id) ?? {
        id,
        missionId: (record?.missionId ?? null) as InboxMark["missionId"],
        subject,
        comments: [],
        snooze: null,
        updatedAt: at,
      }
    );
  };
  // --- end finish-a ---

  let revision = 1;
  const listeners = new Set<() => void>();
  const cache = new Map<string, { revision: number; value: unknown; json: string }>();

  /**
   * Recomputes a snapshot once per revision and keeps the previous object when
   * its content did not change, so subscribers only hear about real changes.
   */
  function memo<T>(key: string, compute: () => T): T {
    const hit = cache.get(key);
    if (hit && hit.revision === revision) return hit.value as T;
    const value = compute();
    const json = contentKey(value);
    if (hit && hit.json === json) {
      cache.set(key, { ...hit, revision });
      return hit.value as T;
    }
    cache.set(key, { revision, value, json });
    return value;
  }

  function commit() {
    revision += 1;
    for (const listener of listeners) listener();
  }

  function watch<T>(read: () => T, listener: Listener<T>): Unsubscribe {
    let last: T | undefined;
    const push = () => {
      const next = read();
      if (Object.is(next, last)) return;
      last = next;
      listener(next);
    };
    listeners.add(push);
    push();
    return () => {
      listeners.delete(push);
    };
  }

  const ownerProvenance = (): MissionProvenance => ({
    _tag: "owner-app",
    surface,
    sessionId: null,
  });
  const nowIso = () => DateTime.formatIso(DateTime.makeUnsafe(now()));
  const log = createEventLog({ nowIso, provenance: ownerProvenance });

  // Each draft and approval keeps the approver it was routed to at creation
  // (or by a later move, with the reason in `routeNote`); editing the table
  // never moves it. Seeded records are routed by the table in force then.
  {
    const seeded = decodeRoutingTables([ops.routingV1, ops.routing]);
    drafts.forEach((draft, index) => {
      const { approver } = routeDraft(tableAt(seeded, draft.missionId, draft.createdAt), draft);
      drafts[index] = { ...draft, approver, routeNote: null };
    });
    approvals.forEach((approval, index) => {
      const table = tableAt(seeded, approval.missionId, approval.createdAt);
      const { approver } = routeApproval(table, approval);
      approvals[index] = { ...approval, approver, routeNote: null };
    });
    for (const move of decodeReroutes(ops.reroutes)) {
      const list: Array<Draft | Approval> = move.kind === "draft" ? drafts : approvals;
      const index = list.findIndex((record) => record.id === move.id);
      const record = list[index];
      if (record) list[index] = { ...record, approver: move.approver, routeNote: move.reason };
    }
  }
  const toOwner = (record: Draft | Approval) => approverOf(record) === "owner";

  const subMissionOf = (record: { readonly id: string }) =>
    data.recordSubMission[record.id] ?? null;

  const openAsks = (missionId: string | null) =>
    asks.filter((a) => a.status === "open" && (missionId === null || a.missionId === missionId));
  const pendingDrafts = (missionId: string | null) =>
    drafts.filter(
      (d) => d.status === "pending" && (missionId === null || d.missionId === missionId),
    );
  const pendingApprovals = (missionId: string | null) =>
    approvals.filter(
      (a) => a.status === "pending" && (missionId === null || a.missionId === missionId),
    );
  const pendingKnocks = (missionId: string | null) =>
    knocks.filter(
      (k) => k.status === "pending" && (missionId === null || k.missionId === missionId),
    );
  const openSuggestions = (missionId: string | null) =>
    suggestions.filter(
      (s) =>
        s.status === "open" &&
        (missionId === null || s.missionId === null || s.missionId === missionId),
    );
  const fyi = (missionId: string | null) =>
    notes
      .filter(
        (n) =>
          (missionId === null || n.missionId === missionId) &&
          !n.ackedBy.some((actor) => actor._tag === "owner"),
      )
      .sort(
        (left, right) =>
          Number(right.type === "owner-must-know") - Number(left.type === "owner-must-know") ||
          SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] ||
          right.createdAt.localeCompare(left.createdAt),
      );

  /**
   * Open asks, knocks, and the pending drafts and approvals routed to the
   * owner, per contract `needsYou`. What waits on the master is not counted.
   */
  function needsYou(missionId: string, subMissionId: string | null): number {
    const inScope = (record: {
      readonly id: string;
      readonly subMissionId?: string | null | undefined;
    }) => subMissionId === null || (record.subMissionId ?? subMissionOf(record)) === subMissionId;
    // A snoozed item waits again only once its snooze ends.
    const snoozed = new Set(
      liveMarks(missionId).flatMap((mark) => (mark.snooze === null ? [] : [mark.id])),
    );
    const awake = (kind: InboxItemRef["kind"]) => (record: { readonly id: string }) =>
      !snoozed.has(`${kind}:${record.id}`);
    return (
      openAsks(missionId).filter(inScope).filter(awake("ask")).length +
      pendingDrafts(missionId).filter(toOwner).filter(inScope).filter(awake("draft")).length +
      pendingApprovals(missionId).filter(toOwner).filter(inScope).filter(awake("approval")).length +
      pendingKnocks(missionId).filter(inScope).filter(awake("knock")).length
    );
  }

  const missionSubMissions = (missionId: string) =>
    subMissions
      .filter((s) => s.missionId === missionId)
      .sort((left, right) => left.order - right.order);

  function listSnapshot(): MissionListSnapshot {
    return memo("list", () => {
      const items: MissionListItem[] = [...missions]
        .filter((m) => m.status !== "archived")
        .sort(
          (left, right) =>
            TIER_RANK[left.tier] - TIER_RANK[right.tier] ||
            right.weight - left.weight ||
            left.title.localeCompare(right.title),
        )
        .map((mission) => ({
          id: mission.id,
          title: mission.title,
          status: mission.status,
          tier: mission.tier,
          health: mission.health,
          needsYou: needsYou(mission.id, null),
          lanes: laneCountsOf(lanes.filter((l) => l.missionId === mission.id)),
          subMissions: missionSubMissions(mission.id)
            .filter((s) => s.status !== "closed")
            .map((s) => ({
              id: s.id,
              title: s.title,
              order: s.order,
              status: s.status,
              health: s.health,
              needsYou: needsYou(mission.id, s.id),
              lanes: laneCountsOf(lanes.filter((l) => l.subMissionId === s.id)),
            })),
          updatedAt: mission.updatedAt,
        }));
      return { revision, missions: items };
    });
  }

  /** Asks and pending drafts, each held by whoever has to decide it. */
  function inboxHeld(missionId: string): HeldItem[] {
    const owner = { holder: { _tag: "owner" } as const, holderLabel: "you" };
    const masterRoleId = findMission(missionId)?.masterRoleId ?? null;
    const master = masterRoleId
      ? { holder: { _tag: "role", roleId: masterRoleId } as MissionActor, holderLabel: "master" }
      : owner;
    const fromAsks = openAsks(missionId).map((ask) => ({
      ...owner,
      item: { kind: "ask" as const, id: ask.id, label: ask.question },
    }));
    const fromDrafts = pendingDrafts(missionId).map((draft) => ({
      ...(toOwner(draft) ? owner : master),
      item: {
        kind: "draft" as const,
        id: draft.id,
        label: `Approve the ${draft.audience} draft on ${draft.target.label}`,
      },
    }));
    return [...fromAsks, ...fromDrafts];
  }

  function overview(missionId: string): MissionOverviewSnapshot | null {
    return memo(`overview:${missionId}`, () => {
      const mission = missions.find((m) => m.id === missionId);
      if (!mission) return null;
      const lastLooked = ownerLastLookedAt.get(missionId) ?? null;
      const isCrpko = missionId === data.missions[0]?.id;
      const directionCheck = calls
        .filter(
          (c) =>
            c.missionId === missionId &&
            c.ownerReaction === null &&
            (lastLooked === null || c.createdAt > lastLooked),
        )
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map((c) => ({
          ref: { kind: "call" as const, id: c.id, label: c.title },
          summary: c.decision,
          reason: c.reason,
          at: c.createdAt,
        }));
      const bottomLine = data.bottomLines[missionId];
      return {
        mission,
        subMissions: missionSubMissions(missionId),
        milestones: milestones.filter((m) => m.missionId === missionId),
        bottomLine: bottomLine?.text ?? "",
        bottomLineAt: bottomLine?.at ?? null,
        usageShare: data.usageShares[missionId] ?? null,
        directionCheck,
        criticalPath: isCrpko ? criticalPath : [],
        blockers: groupBlockers([...inboxHeld(missionId), ...(isCrpko ? held : [])]),
        feed: isCrpko ? feed : [],
        lanes: laneCountsOf(lanes.filter((l) => l.missionId === missionId)),
        ownerLastLookedAt: lastLooked,
        poolUsage: poolUsage.get(missionId) ?? [],
        changes: latestFieldChanges(
          log
            .all()
            .filter(
              (event) =>
                event.missionId === missionId &&
                event.kind !== "routing.updated" &&
                (event.subject?.kind === "mission" || event.subject?.kind === "sub-mission"),
            ),
        ),
        recovery: operations.openRecovery(missionId),
      };
    });
  }

  function inbox(missionId: string | null): MissionInboxSnapshot {
    return memo(`inbox:${missionId ?? "*"}`, () => {
      const inboxAsks = newestFirst(openAsks(missionId));
      const inboxDrafts = newestFirst(pendingDrafts(missionId));
      const inboxApprovals = newestFirst(pendingApprovals(missionId));
      const inboxKnocks = newestFirst(pendingKnocks(missionId));
      const inboxSuggestions = newestFirst(openSuggestions(missionId));
      const inboxFyi = fyi(missionId);
      const routedTo = (approver: "owner" | "master") =>
        [...inboxDrafts, ...inboxApprovals].filter((r) => approverOf(r) === approver).length;
      const acceptedBy = (acceptor: "owner" | "master") =>
        inboxSuggestions.filter((s) => s.acceptor === acceptor).length;
      return {
        revision,
        counts: {
          decide: inboxAsks.length,
          approve: routedTo("owner"),
          knocks: inboxKnocks.length,
          suggestions: acceptedBy("owner"),
          fyi: inboxFyi.length,
        },
        masterCounts: { approve: routedTo("master"), suggestions: acceptedBy("master") },
        asks: inboxAsks,
        drafts: inboxDrafts,
        approvals: inboxApprovals,
        knocks: inboxKnocks,
        suggestions: inboxSuggestions,
        fyi: inboxFyi,
        // --- finish-a ---
        marks: liveMarks(missionId),
        // --- end finish-a ---
      };
    });
  }

  function missionLanes(missionId: string): ReadonlyArray<Lane> {
    return memo(`lanes:${missionId}`, () => lanes.filter((l) => l.missionId === missionId));
  }

  const unreadIn = (roomId: string) => {
    const read = ownerReadSeq.get(roomId) ?? 0;
    return (messagesByRoom.get(roomId) ?? []).filter((m) => m.seq > read).length;
  };

  function missionRooms(missionId: string): ReadonlyArray<MissionRoomEntry> {
    return memo(`rooms:${missionId}`, () =>
      // Removed rooms stay in the list, like the server's; pages filter them.
      rooms
        .filter((room) => room.missionId === missionId)
        .map((room) => ({ room, unread: room.archived ? 0 : unreadIn(room.id) })),
    );
  }

  // --- fix-p3 ---
  /** The server's room activity read over the fixture's room messages. */
  function roomActivity(input: MissionRoomActivityInput): MissionRoomActivity {
    return memo(`activity:${JSON.stringify(input)}`, () => {
      const start = Date.parse(input.dayStart);
      const from = Date.parse(input.since ?? input.dayStart);
      const masterRoleId = findMission(input.missionId)?.masterRoleId ?? null;
      const byMaster = (author: MissionActor) =>
        author._tag === "role" && author.roleId === masterRoleId;
      const rows: Array<MissionRoomActivity["rows"][number]> = [];
      let messages = 0;
      let masterDecisions = 0;
      const blockerAuthors = new Set<string>();
      for (const room of rooms) {
        if (room.missionId !== input.missionId || room.kind === "owner-request") continue;
        const bins = new Map<
          number,
          { index: number; blockers: number; master: number; other: number }
        >();
        let total = 0;
        for (const message of messagesByRoom.get(room.id) ?? []) {
          const at = Date.parse(message.createdAt);
          if (at >= from) {
            messages += 1;
            if (message.kind === "decision" && byMaster(message.author)) masterDecisions += 1;
            if (message.kind === "blocker") blockerAuthors.add(JSON.stringify(message.author));
          }
          if (at < start) continue;
          total += 1;
          const index = Math.floor((at - start) / (5 * 60_000));
          const bin = bins.get(index) ?? { index, blockers: 0, master: 0, other: 0 };
          if (message.kind === "blocker") bin.blockers += 1;
          else if (message.kind === "decision" && byMaster(message.author)) bin.master += 1;
          else bin.other += 1;
          bins.set(index, bin);
        }
        if (total > 0) {
          rows.push({
            roomId: room.id,
            total,
            bins: [...bins.values()].toSorted((a, b) => a.index - b.index),
          });
        }
      }
      return {
        rows: rows.toSorted((a, b) => b.total - a.total || a.roomId.localeCompare(b.roomId)),
        since: { messages, masterDecisions, blockerAuthors: blockerAuthors.size },
      };
    });
  }
  // --- end fix-p3 ---

  /** Messages strictly older than `beforeSeq`, newest `limit` of them. */
  function pageOf(room: Room, beforeSeq: number, limit: number): RoomPage {
    const all = messagesByRoom.get(room.id) ?? [];
    const older = all.filter((m) => m.seq < beforeSeq);
    const take = Math.max(0, Math.min(limit, ROOM_PAGE_MAX));
    const page = older.slice(Math.max(0, older.length - take));
    // Like the server: everyone who wrote or was addressed is in the room, with
    // the names the page shows for them.
    const members = new Map<string, MissionActor>();
    for (const message of all) {
      for (const actor of [message.author, ...message.to]) {
        if (actor._tag === "lane" || actor._tag === "role") members.set(actorKey(actor), actor);
      }
    }
    const names: Record<string, string> = {};
    for (const lane of lanes) {
      if (members.has(`lane:${lane.id}`)) names[`lane:${lane.id}`] = lane.name;
    }
    // Per-kind counts over the last 24 hours, as the router sends them.
    const since = now() - 24 * 60 * 60 * 1000;
    const kinds24h: Record<string, number> = {};
    for (const message of all) {
      if (Date.parse(message.createdAt) >= since)
        kinds24h[message.kind] = (kinds24h[message.kind] ?? 0) + 1;
    }
    return {
      room: room.noise ? { ...room, noise: { ...room.noise, kinds24h } } : room,
      messages: page,
      subscriptions: subscriptions.filter((sub) => sub.roomId === room.id),
      ownerReadSeq: ownerReadSeq.get(room.id) ?? 0,
      hasOlder: page.length < older.length,
      names,
      members: [...members.values()],
    };
  }

  function roomPage(roomId: string): RoomPage | null {
    return memo(`room:${roomId}`, () => {
      const room = rooms.find((r) => r.id === roomId);
      if (!room) return null;
      // Reach back to one message before the first unread so the marker shows.
      const all = messagesByRoom.get(roomId) ?? [];
      const read = ownerReadSeq.get(roomId) ?? 0;
      const firstUnread = all.findIndex((m) => m.seq > read);
      const toMarker = firstUnread < 0 ? 0 : all.length - firstUnread + 1;
      return pageOf(room, Number.MAX_SAFE_INTEGER, Math.max(ROOM_PAGE_SIZE, toMarker));
    });
  }

  const recent = (at: string | null) => at !== null && now() - Date.parse(at) <= HISTORY_WINDOW_MS;
  const inMission = (missionId: string | null, record: { readonly missionId: string | null }) =>
    missionId === null || record.missionId === null || record.missionId === missionId;

  function inboxHistory(missionId: string | null): MissionInboxHistory {
    return memo(`history:${missionId ?? "*"}`, () => ({
      since: DateTime.formatIso(DateTime.makeUnsafe(now() - HISTORY_WINDOW_MS)),
      asks: asks.filter(
        (a) =>
          a.status !== "open" &&
          inMission(missionId, a) &&
          recent(a.answer?.answeredAt ?? a.updatedAt),
      ),
      drafts: drafts.filter(
        (d) => d.status !== "pending" && inMission(missionId, d) && recent(d.decidedAt),
      ),
      approvals: approvals.filter(
        (a) => a.status !== "pending" && inMission(missionId, a) && recent(a.decidedAt),
      ),
      knocks: knocks.filter(
        (k) => k.status !== "pending" && inMission(missionId, k) && recent(k.decidedAt),
      ),
      suggestions: suggestions.filter(
        (s) => s.status !== "open" && inMission(missionId, s) && recent(s.decidedAt),
      ),
    }));
  }

  function missionDraftNotes(missionId: string | null): ReadonlyArray<DraftNote> {
    return memo(`draft-notes:${missionId ?? "*"}`, () =>
      draftNotes.filter((note) => inMission(missionId, note)),
    );
  }

  function suggestionStats(): ReadonlyArray<SuggestionStats> {
    return memo("suggestion-stats", () => [...stats]);
  }

  function missionRules(missionId: string): ReadonlyArray<Rule> {
    return memo(`rules:${missionId}`, () =>
      rules.filter((r) => r.missionId === null || r.missionId === missionId),
    );
  }

  /** Bumps `shown`/`accepted`/`dismissed` for the author and kind of a decided suggestion. */
  function countDecision(suggestion: Suggestion, outcome: "accepted" | "dismissed") {
    const index = stats.findIndex(
      (row) => row.author === suggestion.author && row.targetKind === suggestion.targetKind,
    );
    const row = stats[index] ?? {
      author: suggestion.author,
      targetKind: suggestion.targetKind,
      shown: 1,
      accepted: 0,
      dismissed: 0,
      bar: "normal" as const,
    };
    const next = { ...row, [outcome]: row[outcome] + 1 };
    if (index >= 0) stats[index] = next;
    else stats.push(next);
  }

  function appendMessage(message: MissionMessage) {
    const list = messagesByRoom.get(message.roomId) ?? [];
    list.push(message);
    messagesByRoom.set(message.roomId, list);
    const index = rooms.findIndex((r) => r.id === message.roomId);
    const room = rooms[index];
    if (room) {
      rooms[index] = {
        ...room,
        lastSeq: message.seq,
        lastMessageAt: message.createdAt,
        messageCount: list.length,
      };
    }
  }

  /** The room an owner answer lands in: the ask's sub-mission room, else control. */
  function roomForSubMission(missionId: string, subMissionId: string | null) {
    const own = rooms.find(
      (r) =>
        r.missionId === missionId && r.kind === "sub-mission" && r.subMissionId === subMissionId,
    );
    return (
      own ??
      rooms.find((r) => r.missionId === missionId && r.subMissionId === subMissionId) ??
      rooms.find((r) => r.missionId === missionId && r.kind === "control") ??
      null
    );
  }

  /** Posts an owner message (an answer, a correction) and moves the owner's read mark past it. */
  function postOwnerMessage(
    room: Room,
    fields: Pick<MissionMessage, "kind" | "summary" | "to" | "links" | "isCorrection"> & {
      readonly hasBody: boolean;
      readonly key: string | null;
      readonly workItemId: string | null;
    },
  ): MissionMessage {
    lastSeq += 1;
    const message = decodeMessage({
      id: localId("msg"),
      missionId: room.missionId,
      roomId: room.id,
      seq: lastSeq,
      createdAt: nowIso(),
      author: { _tag: "owner" },
      provenance: ownerProvenance(),
      receipt: null,
      ...fields,
    });
    appendMessage(message);
    ownerReadSeq.set(room.id, message.seq);
    return message;
  }

  function routingTable(missionId: string): ApprovalRoutingTable | null {
    return memo(`routing:${missionId}`, () => {
      const table = routingTables.find((t) => t.missionId === missionId);
      if (!table) return null;
      return {
        ...table,
        changes: latestFieldChanges(
          log
            .all()
            .filter((event) => event.kind === "routing.updated" && event.subject?.id === missionId),
        ),
      };
    });
  }

  function postNudge(lane: Lane, note: string) {
    const room = roomForSubMission(lane.missionId, lane.subMissionId);
    if (!room) return;
    postOwnerMessage(room, {
      kind: "request",
      summary: clampSummary(`${lane.name}: ${note}`),
      to: [{ _tag: "lane", laneId: lane.id }],
      links: [],
      isCorrection: false,
      hasBody: false,
      key: null,
      workItemId: lane.currentItemId,
    });
  }

  const operations = createOperations({
    missions,
    subMissions,
    lanes,
    suggestions,
    log,
    memo,
    commit,
    watch,
    nowIso,
    localId,
    missionRules,
    postNudge,
  });

  const { unreadFor, ...requests } = createRequests({ memo, commit, watch, nowIso, localId });
  const views = createViews({
    memo,
    commit,
    watch,
    nowIso,
    localId,
    ownerWaiting: (missionId) => needsYou(missionId, null),
    requestsUnread: unreadFor,
  });

  function findMission(missionId: string) {
    return missions.find((m) => m.id === missionId);
  }

  const source: MissionsSource = {
    // Every feed here is sample data; nothing is marked because nothing is live.
    sampled: new Set(),
    subscribeList: (listener) => watch(listSnapshot, listener),
    subscribeOverview: (missionId, listener) => watch(() => overview(missionId), listener),
    subscribeLanes: (missionId, listener) => watch(() => missionLanes(missionId), listener),
    subscribeInbox: (missionId, listener) => watch(() => inbox(missionId), listener),
    subscribeInboxHistory: (missionId, listener) => watch(() => inboxHistory(missionId), listener),
    subscribeDraftNotes: (missionId, listener) =>
      watch(() => missionDraftNotes(missionId), listener),
    subscribeSuggestionStats: (listener) => watch(suggestionStats, listener),
    subscribeRules: (missionId, listener) => watch(() => missionRules(missionId), listener),
    subscribeRooms: (missionId, listener) => watch(() => missionRooms(missionId), listener),
    // --- fix-p3 ---
    subscribeRoomActivity: (input, listener) => watch(() => roomActivity(input), listener),
    subscribeRoom: (roomId, listener) => watch(() => roomPage(roomId), listener),
    subscribeRouting: (missionId, listener) => watch(() => routingTable(missionId), listener),
    ...operations.source,
    ...requests,
    ...views,

    loadRoomPage({ roomId, beforeSeq, limit }) {
      const room = rooms.find((r) => r.id === roomId);
      if (!room) return fail("not-found", `Room ${roomId} not found.`);
      return Promise.resolve(pageOf(room, beforeSeq, limit));
    },

    // --- finish-b ---
    createMission(input) {
      const title = input.title.trim();
      if (title.length === 0) return fail("invalid", "Name the mission.");
      if (missions.some((m) => m.slug === input.slug)) {
        return fail("conflict", `A mission with slug ${input.slug} exists.`);
      }
      const at = nowIso();
      const mission: Mission = {
        id: (input.missionId ?? localId("mission")) as Mission["id"],
        slug: input.slug,
        title,
        goal: input.goal ?? "",
        status: "active",
        tier: input.tier ?? "P1",
        weight: input.weight ?? 1,
        guaranteedShare: input.guaranteedShare ?? 0,
        borrowCeiling: input.borrowCeiling ?? 1,
        projectId: input.projectId ?? null,
        masterRoleId: null,
        focusSubMissionId: null,
        health: "unknown",
        lockedFields: [],
        createdAt: at,
        updatedAt: at,
      };
      missions.push(mission);
      log.record({
        missionId: mission.id,
        kind: "mission.created",
        subject: { kind: "mission", id: mission.id, label: title },
        summary: `Created ${title}`,
      });
      commit();
      return Promise.resolve(mission.id);
    },
    tuneRoom(input) {
      const room = rooms.find((r) => r.id === input.roomId);
      if (!room) return fail("not-found", `Room ${input.roomId} not found.`);
      const rules = input.rules ?? [];
      if (rules.length === 0) return fail("invalid", "Give at least one rule.");
      if (rules.some((rule) => rule.subscriber._tag === "owner")) {
        return fail("invalid", "The owner is not a room subscriber.");
      }
      const at = nowIso();
      for (const rule of rules) {
        const key = actorKey(rule.subscriber);
        const index = subscriptions.findIndex(
          (sub) => sub.roomId === room.id && actorKey(sub.subscriber) === key,
        );
        const prior = index >= 0 ? subscriptions[index] : undefined;
        const next: Subscription = {
          id: (prior?.id ?? `${room.id}:sub:${key}`) as Subscription["id"],
          roomId: room.id,
          subscriber: rule.subscriber,
          mode: rule.mode,
          wakeOn: [
            ...(rule.wakeOn ?? (rule.mode === "wake" ? ["request", "blocker", "control"] : [])),
          ],
          createdAt: prior?.createdAt ?? at,
        };
        if (index >= 0) subscriptions[index] = next;
        else subscriptions.push(next);
      }
      log.record({
        missionId: room.missionId,
        kind: "room.tuned",
        subject: { kind: "room", id: room.id, label: room.title },
        summary: `${room.title} tuned`,
        payload: { rules },
      });
      commit();
      return Promise.resolve();
    },
    updateRoom(input) {
      const room = rooms.find((r) => r.id === input.roomId);
      if (!room) return fail("not-found", `Room ${input.roomId} not found.`);
      if (input.archived === true && room.kind === "control") {
        return fail("conflict", "The control room can't be removed.");
      }
      if (input.subMissionId) {
        const sub = subMissions.find((s) => s.id === input.subMissionId);
        if (!sub || sub.missionId !== room.missionId) {
          return fail("not-found", `Sub-mission ${input.subMissionId} not found.`);
        }
      }
      const next: Room = {
        ...room,
        title: input.title?.trim() || room.title,
        subMissionId: input.subMissionId === undefined ? room.subMissionId : input.subMissionId,
        archived: input.archived ?? room.archived,
      };
      const fields = (["title", "subMissionId", "archived"] as const).filter(
        (field) => next[field] !== room[field],
      );
      if (fields.length === 0) return fail("invalid", "Nothing to change.");
      replace(rooms, next);
      const kind = fields.includes("archived")
        ? next.archived
          ? "room.archived"
          : "room.restored"
        : "room.updated";
      log.record({
        missionId: room.missionId,
        kind,
        subject: { kind: "room", id: room.id, label: next.title },
        summary:
          kind === "room.archived"
            ? `${room.title} removed`
            : kind === "room.restored"
              ? `${room.title} restored`
              : fields.includes("title")
                ? `${room.title} renamed to ${next.title}`
                : `${room.title} moved`,
        payload: {
          fields,
          before: { title: room.title, subMissionId: room.subMissionId, archived: room.archived },
          after: { title: next.title, subMissionId: next.subMissionId, archived: next.archived },
        },
      });
      commit();
      return Promise.resolve();
    },
    revertChange(action) {
      // Sample data reverts what its own writes can do; the rest is server-only.
      switch (action._tag) {
        case "status":
          if (action.input.status !== "active" && action.input.status !== "paused") break;
          return source.setMissionPaused({
            missionId: action.input.missionId,
            paused: action.input.status === "paused",
          });
        case "focus":
          return source.setMissionFocus(action.input);
        case "order":
          return source.setPortfolioOrder(action.input);
        case "lane": {
          const { missionId, laneId, subMissionId, status } = action.input;
          if (!laneId) break;
          if (subMissionId) return source.moveLane({ missionId, laneId, subMissionId });
          if (status === "parked" || status === "idle") {
            return source.setLaneParked({ missionId, laneId, parked: status === "parked" });
          }
          break;
        }
        case "role-model":
          return source.setRoleModel(action.input);
        case "pool-capacity":
          return source.setPoolCapacity({
            ...action.input,
            reason: action.input.reason ?? "Reverted",
          });
        case "room":
          return source.updateRoom(action.input);
        default:
          break;
      }
      return fail("invalid", "Sample data can't revert this change.");
    },
    // --- end finish-b ---

    reorderSubMissions(input) {
      const mission = findMission(input.missionId);
      if (!mission) return fail("not-found", `Mission ${input.missionId} not found.`);
      const active = missionSubMissions(mission.id).filter((s) => s.status !== "closed");
      const expected = new Set(active.map((s) => s.id));
      if (
        input.order.length !== expected.size ||
        new Set(input.order).size !== expected.size ||
        input.order.some((id) => !expected.has(id))
      ) {
        return fail("invalid", "The new order must list every active sub-mission once.");
      }
      if (input.order.every((id, order) => active.find((s) => s.id === id)?.order === order)) {
        return Promise.resolve();
      }
      const at = nowIso();
      input.order.forEach((id, order) => {
        const subMission = subMissions.find((s) => s.id === id);
        if (subMission && subMission.order !== order) {
          replace(subMissions, { ...subMission, order, updatedAt: at });
        }
      });
      log.record({
        missionId: input.missionId,
        kind: "sub-mission.reordered",
        subject: { kind: "mission", id: input.missionId },
        summary: "Reordered the sub-missions",
        payload: { order: input.order },
      });
      commit();
      return Promise.resolve();
    },

    setMissionPaused({ missionId, paused }) {
      const mission = findMission(missionId);
      if (!mission) return fail("not-found", `Mission ${missionId} not found.`);
      if (mission.status === "archived")
        return fail("conflict", "Archived missions cannot resume.");
      if ((mission.status === "paused") === paused) return Promise.resolve();
      replace(missions, { ...mission, status: paused ? "paused" : "active", updatedAt: nowIso() });
      log.record({
        missionId,
        kind: paused ? "mission.paused" : "mission.resumed",
        subject: { kind: "mission", id: missionId, label: mission.title },
        summary: `${paused ? "Paused" : "Resumed"} ${mission.title}`,
        payload: {
          changed: ["status"],
          status: paused ? "paused" : "active",
          before: { status: mission.status },
        },
      });
      commit();
      return Promise.resolve();
    },

    setMissionFocus({ missionId, subMissionId }) {
      const mission = findMission(missionId);
      if (!mission) return fail("not-found", `Mission ${missionId} not found.`);
      if (
        subMissionId !== null &&
        !subMissions.some((s) => s.id === subMissionId && s.missionId === missionId)
      ) {
        return fail("invalid", `Sub-mission ${subMissionId} is not part of ${missionId}.`);
      }
      if (subMissions.some((s) => s.id === subMissionId && s.status === "closed")) {
        return fail("invalid", "A closed sub-mission can't take the focus.");
      }
      if (mission.focusSubMissionId === subMissionId) return Promise.resolve();
      replace(missions, { ...mission, focusSubMissionId: subMissionId, updatedAt: nowIso() });
      const focus = subMissions.find((s) => s.id === subMissionId);
      log.record({
        missionId,
        kind: "mission.updated",
        subject: { kind: "mission", id: missionId, label: mission.title },
        summary: focus ? `Focus on ${focus.title}` : "Ended focus",
        payload: {
          changed: ["focusSubMissionId"],
          focusSubMissionId: subMissionId,
          before: { focusSubMissionId: mission.focusSubMissionId },
        },
      });
      commit();
      return Promise.resolve();
    },

    reactToCall({ callId, reaction }) {
      const target = calls.find((c) => c.id === callId);
      if (!target) return fail("not-found", `Call ${callId} not found.`);
      replace(calls, { ...target, ownerReaction: reaction });
      commit();
      return Promise.resolve();
    },

    setIntendedEffort({ missionId, subMissionId, share }) {
      const subMission = subMissions.find(
        (s) => s.id === subMissionId && s.missionId === missionId,
      );
      if (!subMission) return fail("not-found", `Sub-mission ${subMissionId} not found.`);
      if (share !== null && !(Number.isFinite(share) && share >= 0 && share <= 1)) {
        return fail("invalid", "An effort share is between 0 and 1.");
      }
      if (subMission.intendedEffort === share) return Promise.resolve();
      // Nothing locks: the owner and the master write the share the same way,
      // and the event log says who changed it last.
      replace(subMissions, { ...subMission, intendedEffort: share, updatedAt: nowIso() });
      log.record({
        missionId: subMission.missionId,
        kind: "sub-mission.updated",
        subject: { kind: "sub-mission", id: subMission.id, label: subMission.title },
        summary:
          share === null
            ? `Cleared the planned share of ${subMission.title}`
            : `${subMission.title} planned at ${Math.round(share * 100)}%`,
        payload: { changed: ["intendedEffort"], intendedEffort: share },
      });
      commit();
      return Promise.resolve();
    },

    markMissionSeen({ missionId }) {
      if (!findMission(missionId)) return fail("not-found", `Mission ${missionId} not found.`);
      ownerLastLookedAt.set(missionId, nowIso());
      for (const room of rooms) {
        if (room.missionId === missionId) ownerReadSeq.set(room.id, room.lastSeq);
      }
      commit();
      return Promise.resolve();
    },

    answerAsk(input) {
      const ask = asks.find((a) => a.id === input.askId);
      if (!ask) return fail("not-found", `Ask ${input.askId} not found.`);
      if (ask.status !== "open") return fail("conflict", "This ask is already closed.");
      if (input.optionId !== null && !ask.options.some((o) => o.id === input.optionId)) {
        return fail("invalid", `Option ${input.optionId} is not on this ask.`);
      }
      const text = input.text.trim();
      if (input.optionId === null && text === "") {
        return fail("invalid", "Pick an option or write an answer.");
      }
      const at = nowIso();
      const room = roomForSubMission(ask.missionId, ask.subMissionId);
      if (room) {
        const option = ask.options.find((o) => o.id === input.optionId);
        postOwnerMessage(room, {
          kind: "decision",
          summary: clampSummary(
            `Answer to "${ask.question}": ${[option?.label, text].filter(Boolean).join(". ")}`,
          ),
          to: [ask.askedBy],
          links: ask.blocks
            .filter((ref) => ref.kind === "work-item")
            .map((ref) => ({ kind: "ticket" as const, label: ref.id, url: null, ref: ref.id })),
          isCorrection: false,
          hasBody: false,
          key: `ask:${ask.id}`,
          workItemId: null,
        });
      }
      replace(asks, {
        ...ask,
        status: "answered",
        answer: {
          optionId: input.optionId,
          text,
          provenance: ownerProvenance(),
          answeredAt: at,
        },
        updatedAt: at,
      });
      commit();
      return Promise.resolve();
    },

    decideDraft(input) {
      const draft = drafts.find((d) => d.id === input.draftId);
      if (!draft) return fail("not-found", `Draft ${input.draftId} not found.`);
      if (draft.status !== "pending") return fail("conflict", "This draft is already decided.");
      const at = nowIso();
      if (
        input.action === "approve" &&
        input.editedText !== undefined &&
        !input.editedText.trim()
      ) {
        return fail("invalid", "An approved draft cannot be empty.");
      }
      if (input.action === "rewrite" && !input.rewriteNote?.trim()) {
        return fail("invalid", "Say what the rewrite should change.");
      }
      // The owner can decide any draft, whoever it is routed to.
      const decided = { ...draft, decidedBy: ownerProvenance(), decidedAt: at };
      log.record({
        missionId: draft.missionId,
        kind: "draft.decided",
        subject: {
          kind: "draft",
          id: draft.id,
          label: `${draft.audience} on ${draft.target.label}`,
        },
        summary: `Draft to ${draft.audience}: ${input.action}`,
        payload: { action: input.action, approver: approverOf(draft) },
      });
      switch (input.action) {
        case "approve":
          replace(drafts, {
            ...decided,
            status: "approved",
            approvedText: input.editedText?.trim() ?? draft.text,
          });
          break;
        case "rewrite":
          replace(drafts, {
            ...decided,
            status: "rewrite-requested",
            rewriteNote: input.rewriteNote?.trim() ?? null,
          });
          break;
        case "drop":
          replace(drafts, { ...decided, status: "dropped" });
          break;
      }
      commit();
      return Promise.resolve();
    },

    decideSuggestion(input) {
      const suggestion = suggestions.find((s) => s.id === input.suggestionId);
      if (!suggestion) return fail("not-found", `Suggestion ${input.suggestionId} not found.`);
      if (suggestion.status !== "open")
        return fail("conflict", "This suggestion is already decided.");
      const at = nowIso();
      if (input.action === "accept-edited" && input.editedAfter === undefined) {
        return fail("invalid", "Accept edited needs the edited change.");
      }
      const decided = { ...suggestion, decidedBy: ownerProvenance(), decidedAt: at };
      countDecision(suggestion, input.action === "dismiss" ? "dismissed" : "accepted");
      switch (input.action) {
        case "accept":
          replace(suggestions, { ...decided, status: "accepted" });
          break;
        case "accept-edited":
          replace(suggestions, {
            ...decided,
            status: "edited",
            after: input.editedAfter,
          });
          break;
        case "dismiss":
          replace(suggestions, {
            ...decided,
            status: "dismissed",
            dismissReason: input.dismissReason ?? null,
          });
          break;
      }
      commit();
      return Promise.resolve();
    },

    decideKnock(input) {
      const knock = knocks.find((k) => k.id === input.knockId);
      if (!knock) return fail("not-found", `Knock ${input.knockId} not found.`);
      if (knock.status !== "pending") return fail("conflict", "This knock is already handled.");
      const at = nowIso();
      if (input.action === "drop") {
        replace(knocks, { ...knock, status: "dropped", decidedAt: at });
      } else {
        const masterRoleId = findMission(knock.missionId)?.masterRoleId ?? null;
        const forwardTo: MissionActor | undefined =
          input.forwardTo ??
          (masterRoleId === null ? undefined : { _tag: "role", roleId: masterRoleId });
        if (!forwardTo) return fail("invalid", "This mission has no master to forward to.");
        replace(knocks, {
          ...knock,
          status: "forwarded",
          forwardedText: input.editedText?.trim() || knock.summary,
          forwardedTo: forwardTo,
          decidedAt: at,
        });
      }
      commit();
      return Promise.resolve();
    },

    decideApproval(input) {
      const approval = approvals.find((a) => a.id === input.approvalId);
      if (!approval) return fail("not-found", `Approval ${input.approvalId} not found.`);
      if (approval.status !== "pending")
        return fail("conflict", "This approval is already decided.");
      // The owner can decide any approval, whoever it is routed to.
      replace(approvals, {
        ...approval,
        status: input.action === "approve" ? "approved" : "rejected",
        decidedBy: ownerProvenance(),
        decidedAt: nowIso(),
      });
      log.record({
        missionId: approval.missionId,
        kind: "approval.decided",
        subject: { kind: "approval", id: approval.id, label: approval.title },
        summary: `${input.action === "approve" ? "Approved" : "Rejected"} ${approval.title}`,
        payload: { action: input.action, approver: approverOf(approval) },
      });
      commit();
      return Promise.resolve();
    },

    addDraftNote({ missionId, scope, text }) {
      if (missionId !== null && !findMission(missionId)) {
        return fail("not-found", `Mission ${missionId} not found.`);
      }
      const trimmed = text.trim();
      if (trimmed === "") return fail("invalid", "A draft note needs some text.");
      if (scope._tag === "person" && scope.name.trim() === "") {
        return fail("invalid", "Name the person this note is for.");
      }
      const at = nowIso();
      const note = decodeDraftNote({
        id: localId("draft-note"),
        missionId,
        scope,
        text: trimmed,
        source: "owner",
        active: true,
        createdAt: at,
        updatedAt: at,
      });
      draftNotes.push(note);
      commit();
      return Promise.resolve(note);
    },

    setDraftNoteActive({ draftNoteId, active }) {
      const note = draftNotes.find((n) => n.id === draftNoteId);
      if (!note) return fail("not-found", `Draft note ${draftNoteId} not found.`);
      if (note.active === active) return Promise.resolve();
      replace(draftNotes, { ...note, active, updatedAt: nowIso() });
      commit();
      return Promise.resolve();
    },

    ackNote({ noteId }) {
      const note = notes.find((n) => n.id === noteId);
      if (!note) return fail("not-found", `Note ${noteId} not found.`);
      if (note.ackedBy.some((actor) => actor._tag === "owner")) return Promise.resolve();
      replace(notes, { ...note, ackedBy: [...note.ackedBy, { _tag: "owner" }] });
      commit();
      return Promise.resolve();
    },

    // --- finish-a ---
    commentInboxItem({ subject, body }) {
      if (!inboxRecord(subject)) return fail("not-found", "That item is gone.");
      const text = body.trim();
      if (text === "") return fail("invalid", "Write a comment first.");
      const at = nowIso();
      const mark = markFor(subject, at);
      const comment = { id: localId("comment"), body: text, at };
      marks.set(mark.id, { ...mark, comments: [...mark.comments, comment], updatedAt: at });
      commit();
      return Promise.resolve();
    },
    snoozeInboxItem({ subject, until }) {
      const record = inboxRecord(subject);
      if (!record) return fail("not-found", "That item is gone.");
      if (until !== null && Date.parse(until) <= now()) {
        return fail("invalid", "Pick a time ahead.");
      }
      const at = nowIso();
      const mark = markFor(subject, at);
      const snooze = { at, until, stamp: JSON.stringify(record) };
      marks.set(mark.id, { ...mark, snooze, updatedAt: at });
      commit();
      return Promise.resolve();
    },
    unsnoozeInboxItem({ subject }) {
      const mark = marks.get(`${subject.kind}:${subject.id}`);
      if (!mark || mark.snooze === null) return fail("conflict", "Not snoozed.");
      marks.set(mark.id, { ...mark, snooze: null, updatedAt: nowIso() });
      commit();
      return Promise.resolve();
    },
    // --- end finish-a ---

    postRoomMessage(input) {
      const room = rooms.find((r) => r.id === input.roomId && r.missionId === input.missionId);
      if (!room) return fail("not-found", `Room ${input.roomId} not found.`);
      if (room.archived) return fail("conflict", "This room is archived.");
      const summary = input.summary.trim();
      if (summary === "") return fail("invalid", "Write a message first.");
      if (summary.length > 400) return fail("invalid", "Keep the message under 400 characters.");
      const masterRoleId = findMission(room.missionId)?.masterRoleId ?? null;
      if (input.isCorrection && masterRoleId === null) {
        return fail("invalid", "This mission has no master to correct.");
      }
      const to: ReadonlyArray<MissionActor> = input.isCorrection
        ? [{ _tag: "role", roleId: masterRoleId! }]
        : (input.to ?? []);
      const message = postOwnerMessage(room, {
        kind: input.kind,
        summary,
        to,
        links: input.links ?? [],
        isCorrection: input.isCorrection ?? false,
        hasBody: (input.body ?? "").trim() !== "",
        key: input.key ?? null,
        workItemId: input.workItemId ?? room.workItemId,
      });
      commit();
      return Promise.resolve(message);
    },

    markRoomRead({ roomId, seq }) {
      const room = rooms.find((r) => r.id === roomId);
      if (!room) return fail("not-found", `Room ${roomId} not found.`);
      const next = Math.min(seq, room.lastSeq);
      if (next <= (ownerReadSeq.get(roomId) ?? 0)) return Promise.resolve();
      ownerReadSeq.set(roomId, next);
      commit();
      return Promise.resolve();
    },

    upsertRule(input) {
      if (input.missionId !== null && !findMission(input.missionId)) {
        return fail("not-found", `Mission ${input.missionId} not found.`);
      }
      const at = nowIso();
      const existing = input.ruleId ? rules.find((r) => r.id === input.ruleId) : undefined;
      if (input.ruleId && !existing) return fail("not-found", `Rule ${input.ruleId} not found.`);
      const scope = input.scope ?? { subMissionIds: [], roleKinds: [], laneIds: [] };
      const edited = existing
        ? (["title", "quote", "scope", "activation", "status", "masterReading"] as const).filter(
            (field) => {
              const next =
                field === "title" || field === "quote"
                  ? input[field]
                  : (input[field] ?? existing[field]);
              return JSON.stringify(existing[field]) !== JSON.stringify(next);
            },
          )
        : [];
      // --- finish-b --- an unchanged reading saved on a reworded rule confirms it.
      const readingGiven = (input.masterReading ?? "").trim() !== "";
      const confirmsReading =
        existing !== undefined &&
        readingGiven &&
        existing.readingVersion !== undefined &&
        existing.readingVersion < existing.version;
      if (existing && edited.length === 0 && !confirmsReading) return Promise.resolve(existing);
      // Acks are per version: only a change to what lanes follow asks them to ack again.
      const reAck = edited.some(
        (field) => field === "quote" || field === "scope" || field === "activation",
      );
      const version = existing ? (reAck ? existing.version + 1 : existing.version) : 1;
      const readingVersion = readingGiven
        ? version
        : existing && reAck
          ? (existing.readingVersion ?? existing.version)
          : existing?.readingVersion;
      const rule = existing
        ? decodeRule({
            ...existing,
            ...(readingVersion === undefined ? {} : { readingVersion }),
            title: input.title,
            quote: input.quote,
            quotedAt: existing.quote === input.quote ? existing.quotedAt : at,
            scope: input.scope ?? existing.scope,
            activation: input.activation ?? existing.activation,
            status: input.status ?? existing.status,
            masterReading: input.masterReading ?? existing.masterReading,
            version,
            updatedAt: at,
          })
        : decodeRule({
            id: localId("rule"),
            missionId: input.missionId,
            number: null,
            title: input.title,
            quote: input.quote,
            quotedAt: at,
            provenance: ownerProvenance(),
            masterReading: input.masterReading ?? "",
            ...(readingVersion === undefined ? {} : { readingVersion }),
            scope,
            activation: input.activation ?? "",
            status: input.status ?? "active",
            version: 1,
            acks: [],
            appliedCount: 0,
            brokenCount: 0,
            lastReliedAt: null,
            lockedFields: [],
            createdAt: at,
            updatedAt: at,
          });
      if (existing) replace(rules, rule);
      else rules.push(rule);
      // A global rule belongs to every mission's rule book, so each timeline logs it.
      const homes = rule.missionId !== null ? [rule.missionId] : missions.map((m) => m.id);
      for (const missionId of homes) {
        log.record({
          missionId,
          kind: existing
            ? rule.status === "retired"
              ? "rule.retired"
              : "rule.updated"
            : "rule.created",
          subject: { kind: "rule", id: rule.id, label: rule.title },
          summary: `${existing ? "Edited" : "Added"} rule: ${rule.title}`,
          payload: existing ? { changed: edited, version: rule.version } : null,
        });
      }
      commit();
      return Promise.resolve(rule);
    },

    setApprovalRouting({ missionId, routes, reason }) {
      if (!findMission(missionId)) return fail("not-found", `Mission ${missionId} not found.`);
      const current = routingTables.find((t) => t.missionId === missionId) ?? null;
      const decoded = decodeRoutingTableExit({ missionId, routes, updatedAt: nowIso() });
      if (decoded._tag === "Failure") {
        return fail("invalid", "Each row needs something to match and an approver.");
      }
      const next = decoded.value;
      const ids = next.routes.map((row) => row.id);
      if (new Set(ids).size !== ids.length) return fail("invalid", "Two rows share an id.");
      const keys = next.routes.map((row) => routeMatchKey(row.match));
      if (new Set(keys).size !== keys.length) {
        return fail("invalid", "Two rows match the same thing.");
      }
      const before = new Map((current?.routes ?? []).map((row) => [row.id, JSON.stringify(row)]));
      const changed = [
        ...next.routes.filter((row) => before.get(row.id) !== JSON.stringify(row)).map((r) => r.id),
        ...[...before.keys()].filter((id) => !next.routes.some((row) => row.id === id)),
      ];
      const reordered =
        current !== null &&
        changed.length === 0 &&
        current.routes.map((row) => row.id).join() !== ids.join();
      if (changed.length === 0 && !reordered) return Promise.resolve(routingTable(missionId)!);
      const index = routingTables.findIndex((t) => t.missionId === missionId);
      if (index >= 0) routingTables[index] = next;
      else routingTables.push(next);
      const toMaster = next.routes.filter((row) => row.approver === "master").length;
      log.record({
        missionId,
        kind: "routing.updated",
        subject: { kind: "mission", id: missionId },
        summary: clampSummary(
          `Approval routing: ${next.routes.length} rows, ${toMaster} to the master${
            reason?.trim() ? `. ${reason.trim()}` : ""
          }`,
        ),
        payload: { changed: ["rules", ...changed] },
      });
      commit();
      return Promise.resolve(routingTable(missionId)!);
    },

    rerouteRecord({ kind, id, approver, reason }) {
      const list: Array<Draft | Approval> = kind === "draft" ? drafts : approvals;
      const index = list.findIndex((record) => record.id === id);
      const record = list[index];
      if (!record)
        return fail("not-found", `${kind === "draft" ? "Draft" : "Approval"} ${id} not found.`);
      if (record.status !== "pending") return fail("conflict", "Only a pending record can move.");
      const why = reason.trim();
      if (why === "") return fail("invalid", "Say why it should move.");
      const from = approverOf(record);
      if (from === approver) return Promise.resolve();
      list[index] = { ...record, approver, routeNote: why };
      log.record({
        missionId: record.missionId,
        kind: "record.rerouted",
        subject: { kind, id },
        summary: clampSummary(`Moved to ${approver === "owner" ? "you" : "master"}: ${why}`),
        payload: { from, to: approver },
      });
      commit();
      return Promise.resolve();
    },

    // ardud missions: r22 fixes
    // The fixture shows no attached threads, so there is nothing to move.
    setThreadAttachment({ missionId, threadId }) {
      return fail("not-found", `Thread ${threadId} is not attached to mission ${missionId}.`);
    },
  };
  return source;
}

export { FIXTURE_NOW } from "./data.ts";
