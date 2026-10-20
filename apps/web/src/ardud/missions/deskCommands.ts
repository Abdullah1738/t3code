import type { MissionId, RoleKind, SubMissionId } from "@t3tools/contracts";
import {
  newLaneInput,
  newMissionInput,
  newRoleInput,
} from "@t3tools/client-runtime/ardud/missions";

import { missionsSource } from "./missionsStore";
import { submitMissionInput } from "./missionActions";

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
