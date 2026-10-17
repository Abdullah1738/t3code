// @effect-diagnostics nodeBuiltinImport:off - record ids use node:crypto, like the session board.
import * as NodeCrypto from "node:crypto";

import {
  LaneId,
  MissionError,
  type Lane,
  type MergeLanesInput,
  type MergeSubMissionsInput,
  type Milestone,
  type Mission,
  type MissionProvenance,
  type MissionRecordRef,
  type SplitLaneInput,
  type SubMission,
  type WorkItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { MissionStoreRecord } from "../store/recordIndex.ts";
import type { WriteKit } from "./kit.ts";

/**
 * Reshaping a mission: split a lane, fold a lane into another, fold a
 * sub-mission into another. The owner and the master use the same methods;
 * each is one timeline event whose payload says what moved.
 */

const WIDE = 5000;

const fail = (code: MissionError["code"], detail: string) =>
  Effect.fail(new MissionError({ code, detail }));

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const laneRef = (lane: Lane): MissionRecordRef => ({ kind: "lane", id: lane.id, label: lane.name });
const subMissionRef = (subMission: SubMission): MissionRecordRef => ({
  kind: "sub-mission",
  id: subMission.id,
  label: subMission.title,
});

export const makeStructureWrites = (kit: WriteKit) => {
  const { store, serial, loadMission, commit } = kit;

  const laneIn = (laneId: LaneId, missionId: Mission["id"]) =>
    Effect.flatMap(store.get("lane", laneId), (found) =>
      Option.isNone(found)
        ? fail("not-found", `No lane ${laneId}.`)
        : found.value.missionId !== missionId
          ? fail("conflict", `Lane ${laneId} belongs to another mission than ${missionId}.`)
          : Effect.succeed(found.value),
    );

  const subMissionIn = (subMissionId: SubMission["id"], missionId: Mission["id"]) =>
    Effect.flatMap(store.get("sub-mission", subMissionId), (found) =>
      Option.isNone(found)
        ? fail("not-found", `No sub-mission ${subMissionId}.`)
        : found.value.missionId !== missionId
          ? fail(
              "conflict",
              `Sub-mission ${subMissionId} belongs to another mission than ${missionId}.`,
            )
          : Effect.succeed(found.value),
    );

  const workItemsOf = (missionId: Mission["id"]) =>
    store.list("work-item", { missionId, limit: WIDE });

  const splitLane = (provenance: MissionProvenance, input: SplitLaneInput) =>
    serial(
      Effect.gen(function* () {
        const mission = yield* loadMission(input.missionId);
        const source = yield* laneIn(input.laneId, mission.id);
        if (source.status === "retired")
          return yield* fail("conflict", `Lane ${source.name} is retired.`);
        const newLaneId = input.newLaneId ?? LaneId.make(`lane-${NodeCrypto.randomUUID()}`);
        if (Option.isSome(yield* store.get("lane", newLaneId))) {
          return yield* fail("conflict", `Lane ${newLaneId} exists.`);
        }
        const subMissionId =
          input.subMissionId === undefined ? source.subMissionId : input.subMissionId;
        if (subMissionId !== null) yield* subMissionIn(subMissionId, mission.id);
        const wanted = new Set<string>(input.workItemIds ?? []);
        const items = (yield* workItemsOf(mission.id)).filter((item) => wanted.has(item.id));
        const strays = [...wanted].filter(
          (id) => !items.some((item) => item.id === id && item.laneId === source.id),
        );
        if (strays.length > 0) {
          return yield* fail("invalid", `Not on lane ${source.name}: ${strays.join(", ")}.`);
        }
        const now = yield* nowIso;
        const lane: Lane = {
          id: newLaneId,
          missionId: mission.id,
          subMissionId,
          name: input.name,
          purpose: input.purpose ?? "",
          status: "idle",
          statusReason: `split from ${source.name}`,
          leadRoleId: null,
          threadId: null,
          currentItemId: null,
          lastEvidence: null,
          context: null,
          lastActiveAt: null,
          createdAt: now,
          updatedAt: now,
        };
        const moved: ReadonlyArray<WorkItem> = items.map((item) => ({
          ...item,
          laneId: lane.id,
          subMissionId: subMissionId ?? item.subMissionId,
          updatedAt: now,
        }));
        const keptCurrent = moved.some((item) => item.id === source.currentItemId);
        const sourceAfter: Lane = keptCurrent
          ? { ...source, currentItemId: null, updatedAt: now }
          : source;
        const upserts: ReadonlyArray<MissionStoreRecord> = [
          { _tag: "lane", record: lane },
          ...(keptCurrent ? [{ _tag: "lane" as const, record: sourceAfter }] : []),
          ...moved.map((record) => ({ _tag: "work-item" as const, record })),
        ];
        return yield* commit(provenance, {
          missionId: mission.id,
          kind: "lane.split",
          summary: `Lane "${lane.name}" split from "${source.name}" with ${moved.length} work items`,
          ref: laneRef(lane),
          upserts,
          payload: { from: source.id, into: lane.id, workItemIds: moved.map((item) => item.id) },
        });
      }),
    );

  const mergeLanes = (provenance: MissionProvenance, input: MergeLanesInput) =>
    serial(
      Effect.gen(function* () {
        if (input.laneId === input.intoLaneId)
          return yield* fail("invalid", "A lane can't merge into itself.");
        const mission = yield* loadMission(input.missionId);
        const source = yield* laneIn(input.laneId, mission.id);
        const target = yield* laneIn(input.intoLaneId, mission.id);
        if (source.status === "retired" || target.status === "retired") {
          return yield* fail("conflict", "Retired lanes don't merge.");
        }
        const now = yield* nowIso;
        const moved = (yield* workItemsOf(mission.id))
          .filter((item) => item.laneId === source.id)
          .map((item): WorkItem => ({ ...item, laneId: target.id, updatedAt: now }));
        const retired: Lane = {
          ...source,
          status: "retired",
          statusReason: `merged into ${target.name}`,
          currentItemId: null,
          updatedAt: now,
        };
        return yield* commit(provenance, {
          missionId: mission.id,
          kind: "lane.merged",
          summary: `Lane "${source.name}" merged into "${target.name}" (${moved.length} work items)`,
          ref: laneRef(target),
          upserts: [
            { _tag: "lane", record: retired },
            ...moved.map((record) => ({ _tag: "work-item" as const, record })),
          ],
          payload: { from: source.id, into: target.id, workItemIds: moved.map((item) => item.id) },
        });
      }),
    );

  const mergeSubMissions = (provenance: MissionProvenance, input: MergeSubMissionsInput) =>
    serial(
      Effect.gen(function* () {
        if (input.subMissionId === input.intoSubMissionId) {
          return yield* fail("invalid", "A sub-mission can't merge into itself.");
        }
        const mission = yield* loadMission(input.missionId);
        const source = yield* subMissionIn(input.subMissionId, mission.id);
        const target = yield* subMissionIn(input.intoSubMissionId, mission.id);
        if (source.status === "closed" || target.status === "closed") {
          return yield* fail("conflict", "Closed sub-missions don't merge.");
        }
        const now = yield* nowIso;
        const scope = { missionId: mission.id, subMissionId: source.id, limit: WIDE };
        const lanes = (yield* store.list("lane", scope)).map((lane): Lane => ({
          ...lane,
          subMissionId: target.id,
          updatedAt: now,
        }));
        const milestones = (yield* store.list("milestone", scope)).map((milestone): Milestone => ({
          ...milestone,
          subMissionId: target.id,
          updatedAt: now,
        }));
        const items = (yield* store.list("work-item", scope)).map((item): WorkItem => ({
          ...item,
          subMissionId: target.id,
          updatedAt: now,
        }));
        const closed: SubMission = { ...source, status: "closed", updatedAt: now };
        const focusMoves = mission.focusSubMissionId === source.id;
        const upserts: ReadonlyArray<MissionStoreRecord> = [
          { _tag: "sub-mission", record: closed },
          ...lanes.map((record) => ({ _tag: "lane" as const, record })),
          ...milestones.map((record) => ({ _tag: "milestone" as const, record })),
          ...items.map((record) => ({ _tag: "work-item" as const, record })),
          ...(focusMoves
            ? [
                {
                  _tag: "mission" as const,
                  record: { ...mission, focusSubMissionId: target.id, updatedAt: now },
                },
              ]
            : []),
        ];
        return yield* commit(provenance, {
          missionId: mission.id,
          kind: "sub-mission.merged",
          summary: `"${source.title}" merged into "${target.title}"`,
          ref: subMissionRef(target),
          upserts,
          payload: {
            from: source.id,
            into: target.id,
            laneIds: lanes.map((lane) => lane.id),
            milestoneIds: milestones.map((milestone) => milestone.id),
            workItemIds: items.map((item) => item.id),
            focusMoved: focusMoves,
          },
        });
      }),
    );

  return { splitLane, mergeLanes, mergeSubMissions };
};
