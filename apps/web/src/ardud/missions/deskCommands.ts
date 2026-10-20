import type {
  LaneId,
  MissionId,
  MissionMessage,
  MissionMessageKind,
  RoleKind,
  Room,
  SubMissionId,
  Subscription,
} from "@t3tools/contracts";
import {
  moveRoomInput,
  newLaneInput,
  newMissionInput,
  newRoleInput,
  nudgeLaneInput,
  receiptNudgeNote,
  removeRoomInput,
  renameRoomInput,
  restoreRoomInput,
  wakeToggleInput,
  type SetPortfolioOrderInput,
  type WakeColumn,
} from "@t3tools/client-runtime/ardud/missions";

import { missionsSource } from "./missionsStore";
import { runMissionAction, submitMissionInput } from "./missionActions";

// Desk page actions added in finish round B. Input checks live in the
// client-runtime view models; these only send and report failures.

/** Resolves with the new mission's id, or null when nothing was created. */
export async function createMission(
  title: string,
  takenSlugs: ReadonlyArray<string>,
): Promise<MissionId | null> {
  let created: MissionId | null = null;
  await submitMissionInput(
    newMissionInput(title, takenSlugs),
    async (input) => {
      created = await missionsSource.createMission(input);
    },
    "Couldn't create the mission",
  );
  return created;
}

export const createLane = (
  missionId: MissionId,
  name: string,
  subMissionId?: SubMissionId | null,
) =>
  submitMissionInput(
    newLaneInput(missionId, name, subMissionId),
    (input) => missionsSource.createLane(input),
    "Couldn't add the lane",
  );

export const createRole = (missionId: MissionId, kind: RoleKind, name: string) =>
  submitMissionInput(
    newRoleInput(missionId, kind, name),
    (input) => missionsSource.createRole(input),
    "Couldn't add the role",
  );

/** Sends an order the order bar already checked (orderBarDrop). */
export const reorderPortfolio = (input: SetPortfolioOrderInput) =>
  runMissionAction(missionsSource.setPortfolioOrder(input), "Couldn't change the order");

export const renameRoom = (room: Room, title: string) =>
  submitMissionInput(
    renameRoomInput(room, title),
    (input) => missionsSource.updateRoom(input),
    "Couldn't rename the room",
  );

export const moveRoom = (room: Room, subMissionId: SubMissionId | null) =>
  submitMissionInput(
    moveRoomInput(room, subMissionId),
    (input) => missionsSource.updateRoom(input),
    "Couldn't move the room",
  );

export const removeRoom = (room: Room) =>
  submitMissionInput(
    removeRoomInput(room),
    (input) => missionsSource.updateRoom(input),
    "Couldn't remove the room",
  );

export const restoreRoom = (room: Room) =>
  submitMissionInput(
    restoreRoomInput(room),
    (input) => missionsSource.updateRoom(input),
    "Couldn't restore the room",
  );

export const setRoomWake = (
  room: Room,
  subscriptions: ReadonlyArray<Subscription>,
  masterRoleId: string | null,
  column: WakeColumn,
  kind: MissionMessageKind,
  on: boolean,
) =>
  submitMissionInput(
    wakeToggleInput(room.id, subscriptions, masterRoleId, column, kind, on),
    (input) => missionsSource.tuneRoom(input),
    "Couldn't change who the room wakes",
  );

/** Nudges every lane a control post has not reached, pointing at the post. */
export async function nudgePending(message: MissionMessage, laneIds: ReadonlyArray<LaneId>) {
  const note = receiptNudgeNote(message);
  const sent = await Promise.all(
    laneIds.map((laneId) =>
      submitMissionInput(
        nudgeLaneInput(laneId, note),
        (input) => missionsSource.nudgeLane(input),
        "Couldn't nudge the lane",
      ),
    ),
  );
  return sent.every(Boolean);
}
