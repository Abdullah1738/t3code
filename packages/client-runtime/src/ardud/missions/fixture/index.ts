import {
  Approval,
  Ask,
  Call,
  Draft,
  Knock,
  Lane,
  Milestone,
  Mission,
  MissionError,
  type MissionErrorCode,
  type MissionInbox,
  type MissionListItem,
  type MissionListSnapshot,
  type MissionOverview,
  FeedItem,
  MissionActor,
  MissionRecordRef,
  type MissionProvenance,
  Note,
  type OwnerSurface,
  Room,
  SubMission,
  Suggestion,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import type { Listener, MissionRoomEntry, MissionsSource, Unsubscribe } from "../source.ts";
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
  const approvals: Approval[] = [...decodeApprovals([])];
  const notes = decodeNotes(data.notes);
  const calls: Call[] = [...decodeCalls(data.calls)];
  const rooms = decodeRooms(data.rooms);
  const criticalPath = decodeRefs(data.criticalPath);
  const feed = decodeFeed(data.feed);
  const held: HeldItem[] = decodeHeld(data.heldItems).map(({ holder, item }) => ({
    holder: holder.actor,
    holderLabel: holder.label,
    item,
  }));
  const ownerLastLookedAt = new Map<string, string | null>(Object.entries(data.ownerLastLookedAt));
  const roomUnread = new Map<string, number>(Object.entries(data.roomUnread));

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
      .filter((n) => missionId === null || n.missionId === missionId)
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

  function overview(missionId: string): MissionOverview | null {
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
        blockers: groupBlockers([...ownerHeld(missionId), ...(isCrpko ? held : [])]),
        feed: isCrpko ? feed : [],
        lanes: laneCountsOf(lanes.filter((l) => l.missionId === missionId)),
        ownerLastLookedAt: lastLooked,
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

  function missionRooms(missionId: string): ReadonlyArray<MissionRoomEntry> {
    return memo(`rooms:${missionId}`, () =>
      rooms
        .filter((room) => room.missionId === missionId && !room.archived)
        .map((room) => ({ room, unread: roomUnread.get(room.id) ?? 0 })),
    );
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
    subscribeRooms: (missionId, listener) => watch(() => missionRooms(missionId), listener),

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
      commit();
      return Promise.resolve();
    },

    markMissionSeen({ missionId }) {
      if (!findMission(missionId)) return fail("not-found", `Mission ${missionId} not found.`);
      ownerLastLookedAt.set(missionId, nowIso());
      for (const room of rooms) if (room.missionId === missionId) roomUnread.set(room.id, 0);
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
      const at = nowIso();
      replace(asks, {
        ...ask,
        status: "answered",
        answer: {
          optionId: input.optionId,
          text: input.text,
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
      const decided = { ...draft, decidedBy: ownerProvenance(), decidedAt: at };
      switch (input.action) {
        case "approve":
          replace(drafts, {
            ...decided,
            status: "approved",
            approvedText: input.editedText ?? draft.text,
          });
          break;
        case "rewrite":
          replace(drafts, {
            ...decided,
            status: "rewrite-requested",
            rewriteNote: input.rewriteNote ?? null,
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
      const decided = { ...suggestion, decidedBy: ownerProvenance(), decidedAt: at };
      switch (input.action) {
        case "accept":
          replace(suggestions, { ...decided, status: "accepted" });
          break;
        case "accept-edited":
          replace(suggestions, {
            ...decided,
            status: "edited",
            after: input.editedAfter ?? suggestion.after,
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
          forwardedText: input.editedText ?? knock.summary,
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
  };
}

export { FIXTURE_NOW } from "./data.ts";
