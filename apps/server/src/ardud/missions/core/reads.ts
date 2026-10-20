import {
  MissionError,
  approverOf,
  type Lane,
  type Milestone,
  type MissionHealth,
  type MissionId,
  type MissionInbox,
  type MissionListSnapshot,
  type MissionOverview,
  type Ask,
  type InboxItemKind,
  type SubMission,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { markIdOf, snoozedNow } from "../asks/inboxMarks.ts";
import type * as MissionStore from "../store/MissionStore.ts";
import { countLanes, judgeHealth } from "./health.ts";
import type { MissionEffort } from "./effort.ts";
import type { MissionEditor, MissionRecoveryReader } from "./ports.ts";
import {
  buildBlockers,
  buildCriticalPath,
  buildDirectionCheck,
  buildFeed,
  buildInbox,
  buildListItem,
  INBOX_LIST_LIMIT,
  rankFyi,
} from "./snapshots.ts";

/**
 * Bounded snapshot reads. Every list query has a limit; health is judged from
 * the loaded records and cached per mission for at most 15 seconds.
 */

export const HEALTH_TTL_MS = 15_000;

const LISTED_MISSIONS = ["active", "paused", "draining"];
const OPEN_SUB_MISSIONS = ["active", "paused"];
const LIVE_LANES = ["working", "stuck", "waiting", "idle", "parked"];
const UNFINISHED_STAGES = ["ticket", "pr", "review", "merge", "deploy", "readback", "exercised"];
const WIDE_LIMIT = 5000;
const OVERVIEW_LIMIT = 200;
const INBOX_LOAD_LIMIT = 500;

interface HealthEntry {
  readonly at: number;
  readonly mission: MissionHealth;
  readonly subMissions: ReadonlyMap<string, MissionHealth>;
}

interface HealthRecords {
  readonly subMissions: ReadonlyArray<SubMission>;
  readonly lanes: ReadonlyArray<Lane>;
  readonly openAsks: ReadonlyArray<Ask>;
  readonly milestones: ReadonlyArray<Milestone>;
}

const groupByMission = <T extends { readonly missionId: string | null }>(
  items: ReadonlyArray<T>,
): ReadonlyMap<string, ReadonlyArray<T>> => {
  const groups = new Map<string, Array<T>>();
  for (const item of items) {
    if (item.missionId === null) continue;
    const group = groups.get(item.missionId);
    if (group === undefined) groups.set(item.missionId, [item]);
    else group.push(item);
  }
  return groups;
};

const byOrder = (left: SubMission, right: SubMission) =>
  left.order - right.order || (left.createdAt < right.createdAt ? -1 : 1);

const byTarget = (left: Milestone, right: Milestone) => {
  if (left.targetAt === right.targetAt) return left.createdAt < right.createdAt ? -1 : 1;
  if (left.targetAt === null) return 1;
  if (right.targetAt === null) return -1;
  return left.targetAt < right.targetAt ? -1 : 1;
};

const TIER_RANK = { P0: 0, P1: 1, P2: 2 } as const;

const notFound = (missionId: string) =>
  new MissionError({ code: "not-found", detail: `Mission ${missionId} does not exist.` });

export const makeReads = (
  store: MissionStore.MissionStore["Service"],
  currentEditor: () => MissionEditor | null,
  effort: MissionEffort | null = null,
  // ardud missions: recovery
  currentRecovery: () => MissionRecoveryReader | null = () => null,
) => {
  const healthCache = new Map<string, HealthEntry>();

  const healthOf = (missionId: string, records: HealthRecords) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const cached = healthCache.get(missionId);
      if (cached !== undefined && nowMs - cached.at < HEALTH_TTL_MS) return cached;
      const now = DateTime.formatIso(yield* DateTime.now);
      const subMissions = new Map<string, MissionHealth>();
      for (const subMission of records.subMissions) {
        subMissions.set(
          subMission.id,
          judgeHealth({
            lanes: records.lanes.filter((lane) => lane.subMissionId === subMission.id),
            asks: records.openAsks.filter((ask) => ask.subMissionId === subMission.id),
            milestones: records.milestones.filter(
              (milestone) => milestone.subMissionId === subMission.id,
            ),
            now,
          }),
        );
      }
      const entry: HealthEntry = {
        at: nowMs,
        mission: judgeHealth({
          lanes: records.lanes,
          asks: records.openAsks,
          milestones: records.milestones,
          now,
        }),
        subMissions,
      };
      healthCache.set(missionId, entry);
      return entry;
    });

  const withHealth = (subMissions: ReadonlyArray<SubMission>, entry: HealthEntry) =>
    subMissions.toSorted(byOrder).map((subMission) => ({
      ...subMission,
      health: entry.subMissions.get(subMission.id) ?? subMission.health,
    }));

  const listSnapshot: Effect.Effect<MissionListSnapshot, MissionError> = Effect.gen(function* () {
    const missions = yield* store.list("mission", {
      status: LISTED_MISSIONS,
      limit: WIDE_LIMIT,
    });
    const wide = { limit: WIDE_LIMIT };
    const subMissions = groupByMission(
      yield* store.list("sub-mission", { ...wide, status: OPEN_SUB_MISSIONS }),
    );
    const lanes = groupByMission(yield* store.list("lane", { ...wide, status: LIVE_LANES }));
    const asks = groupByMission(yield* store.list("ask", { ...wide, status: ["open"] }));
    const approvals = groupByMission(
      yield* store.list("approval", { ...wide, status: ["pending"] }),
    );
    const drafts = groupByMission(yield* store.list("draft", { ...wide, status: ["pending"] }));
    const knocks = groupByMission(yield* store.list("knock", { ...wide, status: ["pending"] }));
    const milestones = groupByMission(yield* store.list("milestone", wide));
    // ardud missions: router (master words the owner has not opened yet, in any status)
    const answered = yield* store.ownerRequestsUnread(null);
    // ardud missions: fix-p3 (a snoozed item stops counting until its snooze ends)
    const snoozed = yield* snoozedNow(store, null, DateTime.formatIso(yield* DateTime.now));
    const awake = (kind: InboxItemKind) => (record: { readonly id: string }) =>
      !snoozed.has(markIdOf({ kind, id: record.id }));

    const items = yield* Effect.forEach(
      missions.toSorted(
        (left, right) =>
          TIER_RANK[left.tier] - TIER_RANK[right.tier] ||
          right.weight - left.weight ||
          (left.createdAt < right.createdAt ? -1 : 1),
      ),
      (mission) =>
        Effect.gen(function* () {
          const records: HealthRecords = {
            subMissions: subMissions.get(mission.id) ?? [],
            lanes: lanes.get(mission.id) ?? [],
            openAsks: asks.get(mission.id) ?? [],
            milestones: milestones.get(mission.id) ?? [],
          };
          const entry = yield* healthOf(mission.id, records);
          const item = buildListItem({
            mission,
            subMissions: records.subMissions,
            lanes: records.lanes,
            openAsks: records.openAsks.filter(awake("ask")),
            pendingApprovals: (approvals.get(mission.id) ?? []).filter(
              (approval) => approverOf(approval) === "owner" && awake("approval")(approval),
            ).length,
            // ardud missions: asks (drafts route like approvals)
            pendingDrafts: (drafts.get(mission.id) ?? []).filter(
              (draft) => approverOf(draft) === "owner" && awake("draft")(draft),
            ).length,
            pendingKnocks: (knocks.get(mission.id) ?? []).filter(awake("knock")).length,
            health: entry.mission,
            subMissionHealth: entry.subMissions,
          });
          // ardud missions: router
          return { ...item, requestsAnswered: answered.get(mission.id) ?? 0 };
        }),
    );
    return { revision: yield* store.revision, missions: items };
  });

  const overview = (missionId: MissionId): Effect.Effect<MissionOverview, MissionError> =>
    Effect.gen(function* () {
      const mission = yield* store.get("mission", missionId);
      if (Option.isNone(mission)) return yield* notFound(missionId);
      const scope = { missionId, limit: OVERVIEW_LIMIT };
      const subMissions = yield* store.list("sub-mission", {
        ...scope,
        status: OPEN_SUB_MISSIONS,
      });
      const lanes = yield* store.list("lane", { ...scope, status: LIVE_LANES });
      const openAsks = yield* store.list("ask", { ...scope, status: ["open"] });
      const pendingApprovals = yield* store.list("approval", { ...scope, status: ["pending"] });
      const pendingDrafts = yield* store.list("draft", { ...scope, status: ["pending"] });
      const milestones = (yield* store.list("milestone", scope)).toSorted(byTarget);
      const workItems = yield* store.list("work-item", {
        missionId,
        status: UNFINISHED_STAGES,
        limit: WIDE_LIMIT,
      });
      const roles = yield* store.list("role", scope);
      const calls = yield* store.list("call", scope);
      const notes = yield* store.list("note", scope);
      const events = yield* store.recentEvents(missionId, OVERVIEW_LIMIT);
      const since = yield* store.ownerLastLookedAt(missionId);
      const entry = yield* healthOf(missionId, { subMissions, lanes, openAsks, milestones });
      const editor = currentEditor();
      const view = editor === null ? null : yield* editor.view(missionId);
      const healthy = withHealth(subMissions, entry);
      // ardud missions: recovery
      const recovery = currentRecovery();
      const recoveryState = recovery === null ? null : yield* recovery.state(missionId);
      // ardud missions: router
      // Any status: a progress note or a settle note is unread news too.
      const answered = yield* store.ownerRequestsUnread(missionId);
      return {
        mission: { ...mission.value, health: entry.mission },
        subMissions:
          effort === null ? healthy : yield* effort.withActualEffort(missionId, healthy, lanes),
        milestones,
        bottomLine: view?.bottomLine ?? "",
        bottomLineAt: view?.bottomLineAt ?? null,
        // Seam: usage per mission (OpenCode session tokens) is not measured yet.
        usageShare: null,
        directionCheck: buildDirectionCheck({ missionId, calls, events, since }),
        criticalPath: buildCriticalPath(milestones, workItems),
        blockers: buildBlockers({
          openAsks,
          pendingApprovals,
          pendingDrafts,
          workItems,
          lanes,
          roles,
        }),
        feed: view?.feed ?? buildFeed({ missionId, events, notes, since }),
        lanes: countLanes(lanes),
        ownerLastLookedAt: since,
        // ardud missions: recovery
        recovery: recoveryState,
        // ardud missions: router
        requestsAnswered: answered.get(missionId) ?? 0,
      };
    });

  /** Owner inbox for one mission, or across missions when `missionId` is null. */
  const inbox = (missionId: MissionId | null): Effect.Effect<MissionInbox, MissionError> =>
    Effect.gen(function* () {
      if (missionId !== null && Option.isNone(yield* store.get("mission", missionId))) {
        return yield* notFound(missionId);
      }
      const scope =
        missionId === null
          ? { limit: INBOX_LOAD_LIMIT }
          : {
              missionId,
              limit: INBOX_LOAD_LIMIT,
            };
      const openAsks = yield* store.list("ask", { ...scope, status: ["open"] });
      const pendingDrafts = yield* store.list("draft", { ...scope, status: ["pending"] });
      const pendingApprovals = yield* store.list("approval", { ...scope, status: ["pending"] });
      const pendingKnocks = yield* store.list("knock", { ...scope, status: ["pending"] });
      const suggestions = (yield* store.list("suggestion", { ...scope, status: ["open"] })).filter(
        (suggestion) => suggestion.acceptor === "owner",
      );
      const editor = currentEditor();
      const fyi =
        editor === null
          ? rankFyi(yield* store.list("note", scope))
          : yield* editor.fyi(missionId, INBOX_LIST_LIMIT);
      return buildInbox({
        revision: yield* store.revision,
        openAsks,
        pendingDrafts,
        pendingApprovals,
        pendingKnocks,
        suggestions,
        fyi,
      });
    });

  return { listSnapshot, overview, inbox };
};

export type MissionReads = ReturnType<typeof makeReads>;
