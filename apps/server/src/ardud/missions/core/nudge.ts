import {
  isOwnerProvenance,
  MissionError,
  type MissionId,
  type MissionMutationResult,
  type MissionProvenance,
  type MissionRecordRef,
  type NudgeLaneInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { clipSummary } from "../asks/shared.ts";
import { controlRoomId, type MissionRouter } from "../router/MissionRouter.ts";
import type * as MissionStore from "../store/MissionStore.ts";
import { isMasterOf } from "./master.ts";
import { actorOf } from "./provenance.ts";

const SUMMARY_LIMIT = 400;
const DEFAULT_NUDGE = "Nudge: post where you are and what is next.";

export interface NudgeDeps {
  readonly store: MissionStore.MissionStore["Service"];
  readonly router: MissionRouter["Service"];
}

const fail = (code: MissionError["code"], detail: string) =>
  Effect.fail(new MissionError({ code, detail }));

/**
 * The owner or the lane's master wakes a lane: one control-room message
 * addressed to the lane (the router delivers it to the lane's thread), then a
 * `lane.nudged` entry naming that message. `inMission` pins the lane to the
 * mission a master tool acts for.
 */
export const nudgeLane = (
  { store, router }: NudgeDeps,
  provenance: MissionProvenance,
  input: NudgeLaneInput,
  inMission?: MissionId,
): Effect.Effect<MissionMutationResult, MissionError> =>
  Effect.gen(function* () {
    const lane = Option.getOrNull(yield* store.get("lane", input.laneId));
    if (lane === null || (inMission !== undefined && lane.missionId !== inMission)) {
      return yield* fail(
        "not-found",
        inMission === undefined
          ? `No lane ${input.laneId}.`
          : `No lane ${input.laneId} in mission ${inMission}.`,
      );
    }
    if (!isOwnerProvenance(provenance) && !(yield* isMasterOf(store, lane.missionId, provenance))) {
      return yield* fail(
        "forbidden",
        `Only the owner or mission ${lane.missionId}'s master nudges its lanes.`,
      );
    }
    if (lane.status === "retired") {
      return yield* fail("conflict", `Lane ${lane.name} is retired.`);
    }
    const note = input.note?.trim() ?? "";
    const roomId = controlRoomId(lane.missionId);
    const message = yield* router.post(
      {
        missionId: lane.missionId,
        roomId,
        kind: "request",
        summary: note.length === 0 ? DEFAULT_NUDGE : clipSummary(note),
        ...(note.length > SUMMARY_LIMIT ? { body: note } : {}),
        to: [{ _tag: "lane", laneId: lane.id }],
      },
      provenance,
    );
    const ref: MissionRecordRef = { kind: "lane", id: lane.id, label: lane.name };
    const event = yield* store.appendEvent({
      missionId: lane.missionId,
      kind: "lane.nudged",
      actor: actorOf(provenance),
      provenance,
      summary: `Nudged lane ${lane.name}`,
      subject: ref,
      payload: {
        laneId: lane.id,
        roomId,
        messageId: message.id,
        note: note.length === 0 ? null : note,
      },
    });
    return { seq: event.seq, ref };
  });
