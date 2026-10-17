import {
  Approval,
  Ask,
  Call,
  Draft,
  DraftNote,
  Knock,
  Lane,
  Milestone,
  Mission,
  MissionError,
  type MissionErrorCode,
  MissionFork,
  type MissionInbox,
  type MissionListItem,
  type MissionListSnapshot,
  MissionMessage,
  FeedItem,
  MissionActor,
  MissionRecordRef,
  type MissionProvenance,
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

import type {
  Listener,
  MissionForkEntry,
  MissionInboxHistory,
  MissionOverviewSnapshot,
  MissionPoolUsage,
  MissionRoomEntry,
  MissionsSource,
  Unsubscribe,
} from "../source.ts";
import { groupBlockers, laneCountsOf, type HeldItem } from "../viewModel.ts";
import * as data from "./data.ts";

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
const decodeForks = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ fork: MissionFork, question: Schema.NullOr(Schema.String) })),
);
const decodeFork = Schema.decodeUnknownSync(MissionFork);
const decodeMessages = Schema.decodeUnknownSync(Schema.Array(MissionMessage));
const decodeMessage = Schema.decodeUnknownSync(MissionMessage);
const decodeSubscriptions = Schema.decodeUnknownSync(Schema.Array(Subscription));
const decodeRules = Schema.decodeUnknownSync(Schema.Array(Rule));
const decodeRule = Schema.decodeUnknownSync(Rule);

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

function fail(code: MissionErrorCode, detail: string): Promise<never> {
  return Promise.reject(new MissionError({ code, detail }));
}

/** Snapshot content without its top-level `revision`, for change detection. */
function contentKey(value: unknown): string {
  return JSON.stringify(value, (key, entry: unknown) => (key === "revision" ? undefined : entry));
}

/** Identity of a fork origin: the record it is about, ignoring display labels. */
function originKey(origin: MissionFork["origin"]): string | null {
  if (origin === null) return null;
  return "id" in origin
    ? `${origin.kind}:${origin.id}`
    : `${origin.kind}:${origin.ref ?? origin.url ?? origin.label}`;
}

/** Fits text into a message summary (400 characters, trimmed). */
function clampSummary(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= 400 ? trimmed : `${trimmed.slice(0, 399).trimEnd()}…`;
}

function newestFirst<T extends { readonly createdAt: string }>(items: ReadonlyArray<T>): T[] {
  return [...items].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
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
  const lanes = decodeLanes(data.lanes);
  const asks: Ask[] = [...decodeAsks(data.asks)];
  const drafts: Draft[] = [...decodeDrafts(data.drafts)];
  const knocks: Knock[] = [...decodeKnocks(data.knocks)];
  const suggestions: Suggestion[] = [...decodeSuggestions(data.suggestions)];
  const approvals: Approval[] = [...decodeApprovals(data.approvals)];
  const notes: Note[] = [...decodeNotes(data.notes)];
  const calls: Call[] = [...decodeCalls(data.calls)];
  const draftNotes: DraftNote[] = [...decodeDraftNotes(data.draftNotes)];
  const stats: SuggestionStats[] = [...decodeStats(data.suggestionStats)];
  const forks: MissionForkEntry[] = [...decodeForks(data.forks)];
  const rules: Rule[] = [...decodeRules(data.rules)];
  const poolUsage = new Map<string, ReadonlyArray<MissionPoolUsage>>(
    Object.entries(data.poolUsage),
  );
  const subscriptions = decodeSubscriptions(data.roomSubscriptions);
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
    const last = messagesByRoom.get(def.id)?.at(-1);
    return { ...def, lastSeq: last?.seq ?? 0, lastMessageAt: last?.createdAt ?? null };
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
  // The master's proposed share per sub-mission, restored when the owner hands it back.
  const masterIntended = new Map(subMissions.map((s) => [s.id as string, s.intendedEffort]));

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

  /** Open asks, pending drafts and approvals, and knocks, per contract `needsYou`. */
  function needsYou(missionId: string, subMissionId: string | null): number {
    const inScope = (record: { readonly id: string; readonly subMissionId?: string | null }) =>
      subMissionId === null || (record.subMissionId ?? subMissionOf(record)) === subMissionId;
    return (
      openAsks(missionId).filter(inScope).length +
      pendingDrafts(missionId).filter(inScope).length +
      pendingApprovals(missionId).filter(inScope).length +
      pendingKnocks(missionId).filter(inScope).length
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

  function ownerHeld(missionId: string): HeldItem[] {
    const owner = { holder: { _tag: "owner" } as const, holderLabel: "you" };
    const fromAsks = openAsks(missionId).map((ask) => ({
      ...owner,
      item: { kind: "ask" as const, id: ask.id, label: ask.question },
    }));
    const fromDrafts = pendingDrafts(missionId).map((draft) => ({
      ...owner,
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
      // A call the owner is discussing stays in the check until its fork closes.
      const discussing = new Set(
        forks
          .filter((entry) => entry.fork.status === "open" && entry.fork.kind === "discuss")
          .map((entry) => originKey(entry.fork.origin)),
      );
      const directionCheck = calls
        .filter(
          (c) =>
            c.missionId === missionId &&
            ((c.ownerReaction === null && (lastLooked === null || c.createdAt > lastLooked)) ||
              (c.ownerReaction === "discuss" && discussing.has(`call:${c.id}`))),
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
        blockers: groupBlockers([...ownerHeld(missionId), ...(isCrpko ? held : [])]),
        feed: isCrpko ? feed : [],
        lanes: laneCountsOf(lanes.filter((l) => l.missionId === missionId)),
        ownerLastLookedAt: lastLooked,
        poolUsage: poolUsage.get(missionId) ?? [],
      };
    });
  }

  function inbox(missionId: string | null): MissionInbox {
    return memo(`inbox:${missionId ?? "*"}`, () => {
      const inboxAsks = newestFirst(openAsks(missionId));
      const inboxDrafts = newestFirst(pendingDrafts(missionId));
      const inboxApprovals = newestFirst(pendingApprovals(missionId));
      const inboxKnocks = newestFirst(pendingKnocks(missionId));
      const inboxSuggestions = newestFirst(openSuggestions(missionId));
      const inboxFyi = fyi(missionId);
      return {
        revision,
        counts: {
          decide: inboxAsks.length,
          approve: inboxDrafts.length + inboxApprovals.length,
          knocks: inboxKnocks.length,
          suggestions: inboxSuggestions.length,
          fyi: inboxFyi.length,
        },
        asks: inboxAsks,
        drafts: inboxDrafts,
        approvals: inboxApprovals,
        knocks: inboxKnocks,
        suggestions: inboxSuggestions,
        fyi: inboxFyi,
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
      rooms
        .filter((room) => room.missionId === missionId && !room.archived)
        .map((room) => ({ room, unread: unreadIn(room.id) })),
    );
  }

  /** Messages strictly older than `beforeSeq`, newest `limit` of them. */
  function pageOf(room: Room, beforeSeq: number, limit: number): RoomPage {
    const all = messagesByRoom.get(room.id) ?? [];
    const older = all.filter((m) => m.seq < beforeSeq);
    const take = Math.max(0, Math.min(limit, ROOM_PAGE_MAX));
    const page = older.slice(Math.max(0, older.length - take));
    return {
      room,
      messages: page,
      subscriptions: subscriptions.filter((sub) => sub.roomId === room.id),
      ownerReadSeq: ownerReadSeq.get(room.id) ?? 0,
      hasOlder: page.length < older.length,
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

  function missionForks(missionId: string | null): ReadonlyArray<MissionForkEntry> {
    return memo(`forks:${missionId ?? "*"}`, () =>
      forks
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => missionId === null || entry.fork.missionId === missionId)
        // Later-opened first when two forks share a timestamp.
        .sort(
          (left, right) =>
            right.entry.fork.createdAt.localeCompare(left.entry.fork.createdAt) ||
            right.index - left.index,
        )
        .map(({ entry }) => entry),
    );
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
    if (room) rooms[index] = { ...room, lastSeq: message.seq, lastMessageAt: message.createdAt };
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

  function openForkRecord(input: {
    missionId: string;
    kind: MissionFork["kind"];
    origin: MissionFork["origin"];
    question: string | null;
  }): MissionForkEntry {
    const key = originKey(input.origin);
    const existing = forks.find(
      (entry) =>
        entry.fork.status === "open" &&
        entry.fork.missionId === input.missionId &&
        key !== null &&
        originKey(entry.fork.origin) === key,
    );
    if (existing) return existing;
    const masterRoleId = findMission(input.missionId)?.masterRoleId ?? "master";
    const fork = decodeFork({
      id: localId("fork"),
      missionId: input.missionId,
      kind: input.kind,
      // Placeholder thread ids until the asks track opens real forks.
      masterThreadId: `fixture-thread-${masterRoleId}`,
      forkThreadId: localId("fixture-thread-fork"),
      origin: input.origin,
      status: "open",
      summaryLine: null,
      commitsMission: false,
      createdAt: nowIso(),
      closedAt: null,
    });
    const entry = { fork, question: input.question };
    forks.push(entry);
    return entry;
  }

  function findMission(missionId: string) {
    return missions.find((m) => m.id === missionId);
  }

  function replace<T extends { readonly id: string }>(list: T[], next: T) {
    const index = list.findIndex((entry) => entry.id === next.id);
    if (index >= 0) list[index] = next;
  }

  return {
    subscribeList: (listener) => watch(listSnapshot, listener),
    subscribeOverview: (missionId, listener) => watch(() => overview(missionId), listener),
    subscribeLanes: (missionId, listener) => watch(() => missionLanes(missionId), listener),
    subscribeInbox: (missionId, listener) => watch(() => inbox(missionId), listener),
    subscribeInboxHistory: (missionId, listener) => watch(() => inboxHistory(missionId), listener),
    subscribeDraftNotes: (missionId, listener) =>
      watch(() => missionDraftNotes(missionId), listener),
    subscribeSuggestionStats: (listener) => watch(suggestionStats, listener),
    subscribeForks: (missionId, listener) => watch(() => missionForks(missionId), listener),
    subscribeRules: (missionId, listener) => watch(() => missionRules(missionId), listener),
    subscribeRooms: (missionId, listener) => watch(() => missionRooms(missionId), listener),
    subscribeRoom: (roomId, listener) => watch(() => roomPage(roomId), listener),

    loadRoomPage({ roomId, beforeSeq, limit }) {
      const room = rooms.find((r) => r.id === roomId);
      if (!room) return fail("not-found", `Room ${roomId} not found.`);
      return Promise.resolve(pageOf(room, beforeSeq, limit));
    },

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
      const at = nowIso();
      input.order.forEach((id, order) => {
        const subMission = subMissions.find((s) => s.id === id);
        if (subMission && subMission.order !== order) {
          replace(subMissions, { ...subMission, order, updatedAt: at });
        }
      });
      commit();
      return Promise.resolve();
    },

    setMissionPaused({ missionId, paused }) {
      const mission = findMission(missionId);
      if (!mission) return fail("not-found", `Mission ${missionId} not found.`);
      if (mission.status === "archived")
        return fail("conflict", "Archived missions cannot resume.");
      replace(missions, { ...mission, status: paused ? "paused" : "active", updatedAt: nowIso() });
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
      replace(missions, { ...mission, focusSubMissionId: subMissionId, updatedAt: nowIso() });
      commit();
      return Promise.resolve();
    },

    reactToCall({ missionId, callId, reaction }) {
      const target = calls.find((c) => c.id === callId && c.missionId === missionId);
      if (!target) return fail("not-found", `Call ${callId} not found.`);
      replace(calls, { ...target, ownerReaction: reaction });
      if (reaction === "discuss") {
        openForkRecord({
          missionId,
          kind: "discuss",
          origin: { kind: "call", id: target.id, label: target.title },
          question: null,
        });
      }
      commit();
      return Promise.resolve();
    },

    setIntendedEffort({ subMissionId, share }) {
      const subMission = subMissions.find((s) => s.id === subMissionId);
      if (!subMission) return fail("not-found", `Sub-mission ${subMissionId} not found.`);
      if (share !== null && !(Number.isFinite(share) && share >= 0 && share <= 1)) {
        return fail("invalid", "An effort share is between 0 and 1.");
      }
      const others = subMission.lockedFields.filter((field) => field !== "intendedEffort");
      replace(
        subMissions,
        share === null
          ? {
              ...subMission,
              intendedEffort: masterIntended.get(subMission.id) ?? null,
              lockedFields: others,
              updatedAt: nowIso(),
            }
          : {
              ...subMission,
              intendedEffort: share,
              lockedFields: [...others, "intendedEffort"],
              updatedAt: nowIso(),
            },
      );
      commit();
      return Promise.resolve();
    },

    openFork({ missionId, kind, origin, question }) {
      if (!findMission(missionId)) return fail("not-found", `Mission ${missionId} not found.`);
      const text = question?.trim() ?? "";
      if (kind === "owner-question" && text === "") {
        return fail("invalid", "Write the question you want to ask.");
      }
      const entry = openForkRecord({
        missionId,
        kind,
        origin,
        question: text === "" ? null : text,
      });
      commit();
      return Promise.resolve(entry);
    },

    archiveFork({ forkId }) {
      const index = forks.findIndex((entry) => entry.fork.id === forkId);
      const entry = forks[index];
      if (!entry) return fail("not-found", `Fork ${forkId} not found.`);
      if (entry.fork.status === "archived") return Promise.resolve();
      forks[index] = { ...entry, fork: { ...entry.fork, status: "archived", closedAt: nowIso() } };
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
      const decided = { ...draft, decidedBy: ownerProvenance(), decidedAt: at };
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
      replace(approvals, {
        ...approval,
        status: input.action === "approve" ? "approved" : "rejected",
        decidedBy: ownerProvenance(),
        decidedAt: nowIso(),
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
      const rule = existing
        ? decodeRule({
            ...existing,
            title: input.title,
            quote: input.quote,
            quotedAt: existing.quote === input.quote ? existing.quotedAt : at,
            scope: input.scope ?? existing.scope,
            activation: input.activation ?? existing.activation,
            status: input.status ?? existing.status,
            version: existing.version + 1,
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
            masterReading: "",
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
      commit();
      return Promise.resolve(rule);
    },
  };
}

export { FIXTURE_NOW } from "./data.ts";
