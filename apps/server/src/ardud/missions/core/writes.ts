// @effect-diagnostics nodeBuiltinImport:off - record ids use node:crypto, like the session board.
import * as NodeCrypto from "node:crypto";

import {
  LaneId,
  MilestoneId,
  MissionError,
  MissionId,
  SubMissionId,
  WorkItemId,
  type CreateMissionInput,
  type Lane,
  type MarkMissionSeenInput,
  type Milestone,
  type Mission,
  type MissionEventKind,
  type MissionMutationResult,
  type MissionProvenance,
  type MissionRecordRef,
  type ReorderSubMissionsInput,
  type SetMissionFocusInput,
  type SetMissionStatusInput,
  type SetSubMissionStatusInput,
  type SubMission,
  type UpdateMissionInput,
  type UpsertLaneInput,
  type UpsertMilestoneInput,
  type UpsertSubMissionInput,
  type UpsertWorkItemInput,
  type WorkItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import type * as MissionStore from "../store/MissionStore.ts";
import type { MissionStoreRecord } from "../store/recordIndex.ts";
import { makeApprovalWrites } from "./approvals.ts";
import { makeAttachmentWrites } from "./attachments.ts";
import { makeCallWrites } from "./calls.ts";
import { makePortfolioWrites } from "./portfolio.ts";
import { makeReviewRoundWrites } from "./reviewRounds.ts";
import { attachTargets } from "./attachTargets.ts";
import { ownerConditions } from "./conditions.ts";
import type { WriteKit } from "./kit.ts";
import { actorOf } from "./provenance.ts";
import { changedFields, previousValues, requireOwner } from "./rules.ts";
import { makeStructureWrites } from "./structure.ts";

/**
 * Core mutations: missions, sub-missions, milestones, lanes, work items and
 * status changes. Provenance is an argument the transport fills; it never
 * comes from the input. Nothing here is owner only: the owner and the
 * mission's master use the same methods, and the transports decide who may
 * call them (WS: paired owner clients; MCP: the master). Every change is a
 * timeline event carrying actor and provenance, which is how the owner sees
 * what the master changed.
 *
 * Writes run one at a time (read, check, commit) so checks see the state the
 * commit replaces. A write that changes nothing commits nothing and returns
 * the mission's current seq.
 */

const OPEN_SUB_MISSIONS = ["active", "paused"];
const ORDER_SCAN_LIMIT = 5000;

/** Timeline kind for a mission status change. */
const missionStatusEvent = (
  before: Mission["status"],
  after: Mission["status"],
): MissionEventKind => {
  if (after === "paused") return "mission.paused";
  if (after === "archived") return "mission.archived";
  if (before === "archived") return "mission.unarchived";
  if (before === "paused" && after === "active") return "mission.resumed";
  return "mission.updated";
};

const invalid = (detail: string) => new MissionError({ code: "invalid", detail });
const notFound = (kind: string, id: string) =>
  new MissionError({ code: "not-found", detail: `No ${kind} ${id}.` });
const otherMission = (kind: string, id: string, missionId: string) =>
  new MissionError({
    code: "conflict",
    detail: `${kind} ${id} belongs to another mission than ${missionId}.`,
  });

const failIf = (error: MissionError | null) => (error === null ? Effect.void : Effect.fail(error));

const newId = (prefix: string) => `${prefix}-${NodeCrypto.randomUUID()}`;

/** Drops keys whose value is `undefined` so a patch never clears a field by omission. */
const definedOnly = <T extends object>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export const makeWrites = (store: MissionStore.MissionStore["Service"]) =>
  Effect.gen(function* () {
    const writeLock = yield* Semaphore.make(1);
    const conditions = yield* ownerConditions;
    const targets = yield* attachTargets;
    const serial = <A>(effect: Effect.Effect<A, MissionError>) => writeLock.withPermit(effect);

    const need = <A>(
      found: Effect.Effect<Option.Option<A>, MissionError>,
      kind: string,
      id: string,
    ) =>
      Effect.flatMap(found, (option) =>
        Effect.fromOption(option).pipe(Effect.mapError(() => notFound(kind, id))),
      );

    const loadMission = (missionId: MissionId) =>
      need(store.get("mission", missionId), "mission", missionId);

    /** The referenced record must exist and belong to the mission. */
    const requireIn = (
      kind: "sub-mission" | "lane" | "milestone" | "work-item",
      id: string | null | undefined,
      missionId: MissionId,
    ) =>
      id === null || id === undefined
        ? Effect.void
        : Effect.flatMap(store.get(kind, id), (found) =>
            Option.isNone(found)
              ? Effect.fail(notFound(kind, id))
              : found.value.missionId === missionId
                ? Effect.void
                : Effect.fail(otherMission(kind, id, missionId)),
          );

    const unchanged = (missionId: MissionId, ref: MissionRecordRef) =>
      Effect.map(store.latestSeq(missionId), (seq): MissionMutationResult => ({ seq, ref }));

    const commit = (
      provenance: MissionProvenance,
      write: {
        readonly missionId: MissionId;
        readonly kind: MissionEventKind;
        readonly summary: string;
        readonly ref: MissionRecordRef;
        readonly upserts: ReadonlyArray<MissionStoreRecord>;
        readonly payload?: unknown;
      },
    ) =>
      Effect.map(
        store.commit({
          event: {
            missionId: write.missionId,
            kind: write.kind,
            actor: actorOf(provenance),
            provenance,
            summary: write.summary,
            subject: write.ref,
            payload: write.payload ?? null,
          },
          upserts: write.upserts,
        }),
        (result): MissionMutationResult => ({ seq: result.seq, ref: write.ref }),
      );

    const missionRef = (mission: Mission): MissionRecordRef => ({
      kind: "mission",
      id: mission.id,
      label: mission.title,
    });

    // --- missions ---------------------------------------------------------------

    const createMission = (provenance: MissionProvenance, input: CreateMissionInput) =>
      serial(
        Effect.gen(function* () {
          const id = input.missionId ?? MissionId.make(newId("mission"));
          if (Option.isSome(yield* store.get("mission", id))) {
            return yield* new MissionError({ code: "conflict", detail: `Mission ${id} exists.` });
          }
          const missions = yield* store.list("mission", { limit: ORDER_SCAN_LIMIT });
          if (missions.some((mission) => mission.slug === input.slug)) {
            return yield* new MissionError({
              code: "conflict",
              detail: `A mission with slug ${input.slug} exists.`,
            });
          }
          const now = yield* nowIso;
          const mission: Mission = {
            id,
            slug: input.slug,
            title: input.title,
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
            createdAt: now,
            updatedAt: now,
          };
          return yield* commit(provenance, {
            missionId: id,
            kind: "mission.created",
            summary: `Mission "${mission.title}" created`,
            ref: missionRef(mission),
            upserts: [{ _tag: "mission", record: mission }],
          });
        }),
      );

    /** Applies a mission change; a write that changes nothing commits nothing. */
    const writeMission = (
      provenance: MissionProvenance,
      before: Mission,
      next: Mission,
      kindFor: (changed: ReadonlyArray<string>) => MissionEventKind,
    ) =>
      Effect.gen(function* () {
        const changed = changedFields(before, next);
        if (changed.length === 0) return yield* unchanged(before.id, missionRef(before));
        const record: Mission = { ...next, updatedAt: yield* nowIso };
        const kind = kindFor(changed);
        return yield* commit(provenance, {
          missionId: before.id,
          kind,
          summary: `Mission "${record.title}": ${kind === "mission.updated" ? `${changed.join(", ")} changed` : kind.slice("mission.".length)}`,
          ref: missionRef(record),
          upserts: [{ _tag: "mission", record }],
          payload: {
            changed,
            status: record.status,
            focusSubMissionId: record.focusSubMissionId,
            // finish-b: the previous values, so a client can revert the change.
            before: previousValues(before, changed),
          },
        });
      });

    const updateMission = (provenance: MissionProvenance, input: UpdateMissionInput) =>
      serial(
        Effect.gen(function* () {
          const before = yield* loadMission(input.missionId);
          const { missionId: _missionId, ...fields } = input;
          return yield* writeMission(
            provenance,
            before,
            { ...before, ...definedOnly(fields) },
            () => "mission.updated",
          );
        }),
      );

    const setMissionStatus = (provenance: MissionProvenance, input: SetMissionStatusInput) =>
      serial(
        Effect.gen(function* () {
          const before = yield* loadMission(input.missionId);
          return yield* writeMission(provenance, before, { ...before, status: input.status }, () =>
            missionStatusEvent(before.status, input.status),
          );
        }),
      );

    /** Focus mode: only the focused sub-mission admits new work. `null` ends it. */
    const setMissionFocus = (provenance: MissionProvenance, input: SetMissionFocusInput) =>
      serial(
        Effect.gen(function* () {
          const before = yield* loadMission(input.missionId);
          if (input.subMissionId !== null) {
            const subMission = yield* need(
              store.get("sub-mission", input.subMissionId),
              "sub-mission",
              input.subMissionId,
            );
            if (subMission.missionId !== before.id) {
              return yield* otherMission("sub-mission", subMission.id, before.id);
            }
            if (subMission.status === "closed") {
              return yield* invalid(`Sub-mission ${subMission.title} is closed.`);
            }
          }
          return yield* writeMission(
            provenance,
            before,
            { ...before, focusSubMissionId: input.subMissionId },
            () => "mission.updated",
          );
        }),
      );

    // --- sub-missions -------------------------------------------------------------

    const subMissionRef = (subMission: SubMission): MissionRecordRef => ({
      kind: "sub-mission",
      id: subMission.id,
      label: subMission.title,
    });

    const openSubMissions = (missionId: MissionId) =>
      store.list("sub-mission", { missionId, status: OPEN_SUB_MISSIONS, limit: ORDER_SCAN_LIMIT });

    const upsertSubMissionNow = (provenance: MissionProvenance, input: UpsertSubMissionInput) =>
      Effect.gen(function* () {
        const mission = yield* loadMission(input.missionId);
        const { missionId: _missionId, subMissionId, ...fields } = input;
        const patch = definedOnly(fields);
        const existing =
          subMissionId === undefined
            ? Option.none()
            : yield* store.get("sub-mission", subMissionId);
        const now = yield* nowIso;

        if (Option.isSome(existing)) {
          const before = existing.value;
          if (before.missionId !== mission.id) {
            return yield* otherMission("sub-mission", before.id, mission.id);
          }
          const next: SubMission = { ...before, ...patch };
          const changed = changedFields(before, next);
          if (changed.length === 0) return yield* unchanged(mission.id, subMissionRef(before));
          const record: SubMission = { ...next, updatedAt: now };
          const closing = changed.includes("status") && record.status === "closed";
          return yield* commit(provenance, {
            missionId: mission.id,
            kind: closing ? "sub-mission.closed" : "sub-mission.updated",
            summary: closing
              ? `Sub-mission "${record.title}" closed`
              : `Sub-mission "${record.title}": ${changed.join(", ")} changed`,
            ref: subMissionRef(record),
            upserts: [{ _tag: "sub-mission", record }],
            payload: { changed, status: record.status },
          });
        }

        if (patch.title === undefined) return yield* invalid("A new sub-mission needs a title.");
        const open = yield* openSubMissions(mission.id);
        const record: SubMission = {
          id: subMissionId ?? SubMissionId.make(newId("sub")),
          missionId: mission.id,
          title: patch.title,
          intent: patch.intent ?? "",
          order: open.reduce((max, subMission) => Math.max(max, subMission.order + 1), 0),
          fillIdleCapacity: patch.fillIdleCapacity ?? false,
          status: patch.status ?? "active",
          coordinatorRoleId: patch.coordinatorRoleId ?? null,
          intendedEffort: patch.intendedEffort ?? null,
          actualEffort: null,
          health: "unknown",
          lockedFields: [],
          createdAt: now,
          updatedAt: now,
        };
        return yield* commit(provenance, {
          missionId: mission.id,
          kind: "sub-mission.created",
          summary: `Sub-mission "${record.title}" created`,
          ref: subMissionRef(record),
          upserts: [{ _tag: "sub-mission", record }],
        });
      });

    const upsertSubMission = (provenance: MissionProvenance, input: UpsertSubMissionInput) =>
      serial(upsertSubMissionNow(provenance, input));

    /** Pause, resume, close or reopen one sub-mission. */
    const setSubMissionStatus = (provenance: MissionProvenance, input: SetSubMissionStatusInput) =>
      serial(
        Effect.gen(function* () {
          const subMission = yield* need(
            store.get("sub-mission", input.subMissionId),
            "sub-mission",
            input.subMissionId,
          );
          return yield* upsertSubMissionNow(provenance, {
            missionId: subMission.missionId,
            subMissionId: subMission.id,
            status: input.status,
          });
        }),
      );

    /** Sets the order of every open sub-mission in one event. */
    const reorderSubMissions = (provenance: MissionProvenance, input: ReorderSubMissionsInput) =>
      serial(
        Effect.gen(function* () {
          const mission = yield* loadMission(input.missionId);
          const open = yield* openSubMissions(mission.id);
          const byId = new Map(open.map((subMission) => [subMission.id as string, subMission]));
          const listed = new Set<string>(input.order);
          if (
            listed.size !== input.order.length ||
            listed.size !== byId.size ||
            input.order.some((id) => !byId.has(id))
          ) {
            return yield* invalid("The order must list every open sub-mission exactly once.");
          }
          const now = yield* nowIso;
          const moved = input.order.flatMap((id, order): Array<MissionStoreRecord> => {
            const subMission = byId.get(id);
            return subMission === undefined || subMission.order === order
              ? []
              : [{ _tag: "sub-mission", record: { ...subMission, order, updatedAt: now } }];
          });
          if (moved.length === 0) return yield* unchanged(mission.id, missionRef(mission));
          return yield* commit(provenance, {
            missionId: mission.id,
            kind: "sub-mission.reordered",
            summary: `Sub-missions of "${mission.title}" reordered`,
            ref: missionRef(mission),
            upserts: moved,
            payload: { order: input.order },
          });
        }),
      );

    // --- milestones, lanes, work items -----------------------------------------------

    const milestoneRef = (milestone: Milestone): MissionRecordRef => ({
      kind: "milestone",
      id: milestone.id,
      label: milestone.title,
    });

    const upsertMilestone = (provenance: MissionProvenance, input: UpsertMilestoneInput) =>
      serial(
        Effect.gen(function* () {
          const mission = yield* loadMission(input.missionId);
          const { missionId: _missionId, milestoneId, ...fields } = input;
          const patch = definedOnly(fields);
          yield* requireIn("sub-mission", patch.subMissionId, mission.id);
          const existing =
            milestoneId === undefined ? Option.none() : yield* store.get("milestone", milestoneId);
          const now = yield* nowIso;

          if (Option.isSome(existing)) {
            const before = existing.value;
            if (before.missionId !== mission.id) {
              return yield* otherMission("milestone", before.id, mission.id);
            }
            const next: Milestone = { ...before, ...patch };
            const changed = changedFields(before, next);
            if (changed.length === 0) return yield* unchanged(mission.id, milestoneRef(before));
            const record: Milestone = { ...next, updatedAt: now };
            return yield* commit(provenance, {
              missionId: mission.id,
              kind: "milestone.updated",
              summary: `Milestone "${record.title}": ${changed.join(", ")} changed`,
              ref: milestoneRef(record),
              upserts: [{ _tag: "milestone", record }],
              payload: { changed, status: record.status },
            });
          }

          if (patch.title === undefined || patch.subMissionId === undefined) {
            return yield* invalid("A new milestone needs a title and a sub-mission.");
          }
          const record: Milestone = {
            id: milestoneId ?? MilestoneId.make(newId("milestone")),
            missionId: mission.id,
            subMissionId: patch.subMissionId,
            title: patch.title,
            targetAt: patch.targetAt ?? null,
            status: patch.status ?? "planned",
            statusNote: patch.statusNote ?? null,
            itemIds: patch.itemIds ?? [],
            createdAt: now,
            updatedAt: now,
          };
          return yield* commit(provenance, {
            missionId: mission.id,
            kind: "milestone.created",
            summary: `Milestone "${record.title}" created`,
            ref: milestoneRef(record),
            upserts: [{ _tag: "milestone", record }],
          });
        }),
      );

    const laneRef = (lane: Lane): MissionRecordRef => ({
      kind: "lane",
      id: lane.id,
      label: lane.name,
    });

    const laneEventKind = (before: Lane, after: Lane, changed: ReadonlyArray<string>) => {
      if (changed.includes("status") && after.status === "retired") return "lane.retired";
      if (changed.includes("status") && after.status === "parked") return "lane.parked";
      if (changed.includes("subMissionId")) return "lane.moved";
      if (changed.includes("status") && before.status === "parked") return "lane.resumed";
      return "lane.updated";
    };

    const upsertLane = (provenance: MissionProvenance, input: UpsertLaneInput) =>
      serial(
        Effect.gen(function* () {
          const mission = yield* loadMission(input.missionId);
          const { missionId: _missionId, laneId, ...fields } = input;
          const patch = definedOnly(fields);
          yield* requireIn("sub-mission", patch.subMissionId, mission.id);
          yield* requireIn("work-item", patch.currentItemId, mission.id);
          const existing = laneId === undefined ? Option.none() : yield* store.get("lane", laneId);
          const now = yield* nowIso;

          if (Option.isSome(existing)) {
            const before = existing.value;
            if (before.missionId !== mission.id) {
              return yield* otherMission("lane", before.id, mission.id);
            }
            const next: Lane = { ...before, ...patch };
            const changed = changedFields(before, next);
            if (changed.length === 0) return yield* unchanged(mission.id, laneRef(before));
            const record: Lane = { ...next, updatedAt: now };
            const kind = laneEventKind(before, record, changed);
            return yield* commit(provenance, {
              missionId: mission.id,
              kind,
              summary:
                kind === "lane.updated"
                  ? `Lane "${record.name}": ${changed.join(", ")} changed`
                  : `Lane "${record.name}" ${kind.slice("lane.".length)}`,
              ref: laneRef(record),
              upserts: [{ _tag: "lane", record }],
              payload: {
                changed,
                status: record.status,
                subMissionId: record.subMissionId,
                before: previousValues(before, changed),
              },
            });
          }

          if (patch.name === undefined) return yield* invalid("A new lane needs a name.");
          const record: Lane = {
            id: laneId ?? LaneId.make(newId("lane")),
            missionId: mission.id,
            subMissionId: patch.subMissionId ?? null,
            name: patch.name,
            purpose: patch.purpose ?? "",
            status: patch.status ?? "idle",
            statusReason: patch.statusReason ?? null,
            leadRoleId: patch.leadRoleId ?? null,
            threadId: patch.threadId ?? null,
            currentItemId: patch.currentItemId ?? null,
            lastEvidence: null,
            context: null,
            lastActiveAt: null,
            createdAt: now,
            updatedAt: now,
          };
          return yield* commit(provenance, {
            missionId: mission.id,
            kind: "lane.created",
            summary: `Lane "${record.name}" created`,
            ref: laneRef(record),
            upserts: [{ _tag: "lane", record }],
          });
        }),
      );

    const workItemRef = (item: WorkItem): MissionRecordRef => ({
      kind: "work-item",
      id: item.id,
      label: item.title,
    });

    const upsertWorkItem = (provenance: MissionProvenance, input: UpsertWorkItemInput) =>
      serial(
        Effect.gen(function* () {
          const mission = yield* loadMission(input.missionId);
          const { missionId: _missionId, workItemId, ...fields } = input;
          const patch = definedOnly(fields);
          yield* requireIn("sub-mission", patch.subMissionId, mission.id);
          yield* requireIn("lane", patch.laneId, mission.id);
          yield* requireIn("milestone", patch.milestoneId, mission.id);
          const existing =
            workItemId === undefined ? Option.none() : yield* store.get("work-item", workItemId);
          const now = yield* nowIso;

          if (Option.isSome(existing)) {
            const before = existing.value;
            if (before.missionId !== mission.id) {
              return yield* otherMission("work-item", before.id, mission.id);
            }
            const next: WorkItem = { ...before, ...patch };
            const changed = changedFields(before, next);
            if (changed.length === 0) return yield* unchanged(mission.id, workItemRef(before));
            const record: WorkItem = { ...next, updatedAt: now };
            return yield* commit(provenance, {
              missionId: mission.id,
              kind: "work-item.updated",
              summary: changed.includes("stage")
                ? `"${record.title}" moved to ${record.stage}`
                : `"${record.title}": ${changed.join(", ")} changed`,
              ref: workItemRef(record),
              upserts: [{ _tag: "work-item", record }],
              payload: { changed, stage: record.stage },
            });
          }

          if (patch.title === undefined) return yield* invalid("A new work item needs a title.");
          const record: WorkItem = {
            id: workItemId ?? WorkItemId.make(newId("item")),
            missionId: mission.id,
            subMissionId: patch.subMissionId ?? null,
            laneId: patch.laneId ?? null,
            milestoneId: patch.milestoneId ?? null,
            title: patch.title,
            kind: patch.kind ?? "other",
            stage: patch.stage ?? "ticket",
            heldBy: patch.heldBy ?? null,
            blockedBy: patch.blockedBy ?? [],
            dependsOn: patch.dependsOn ?? [],
            pullRequest: patch.pullRequest ?? null,
            links: patch.links ?? [],
            facts: patch.facts ?? { mergedAtHead: null, deployedReadback: null, exercised: null },
            ...(patch.view === undefined ? {} : { view: patch.view }),
            createdAt: now,
            updatedAt: now,
          };
          return yield* commit(provenance, {
            missionId: mission.id,
            kind: "work-item.created",
            summary: `Work item "${record.title}" created`,
            ref: workItemRef(record),
            upserts: [{ _tag: "work-item", record }],
          });
        }),
      );

    // --- owner looks ---------------------------------------------------------------

    /** Records when the owner last opened the mission; feed and direction check start there. */
    const markSeen = (provenance: MissionProvenance, input: MarkMissionSeenInput) =>
      Effect.gen(function* () {
        yield* failIf(requireOwner(provenance, "mark a mission seen"));
        const mission = yield* loadMission(input.missionId);
        yield* store.markOwnerLooked(mission.id, yield* nowIso);
        return yield* unchanged(mission.id, missionRef(mission));
      });

    const kit: WriteKit = { store, conditions, serial, loadMission, unchanged, commit };

    return {
      createMission,
      updateMission,
      setMissionStatus,
      setMissionFocus,
      upsertSubMission,
      setSubMissionStatus,
      reorderSubMissions,
      upsertMilestone,
      upsertLane,
      upsertWorkItem,
      markSeen,
      ...makeStructureWrites(kit),
      ...makeApprovalWrites(kit),
      ...makeCallWrites(kit),
      ...makePortfolioWrites(kit),
      ...makeReviewRoundWrites(kit),
      // ardud missions: crw-threads
      ...makeAttachmentWrites(kit, targets),
    };
  });

export type MissionWrites = Effect.Success<ReturnType<typeof makeWrites>>;
