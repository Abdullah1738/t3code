import {
  MissionError,
  WORK_ITEM_REVIEW_BUDGET,
  type Lane,
  type MissionProvenance,
  type MissionRecordRef,
  type RecordReviewRoundInput,
  type SetOwnLaneStatusInput,
  type WorkItem,
  type WorkItemReviewRound,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { standingOf, type Standing } from "../asks/standing.ts";
import type { WriteKit } from "./kit.ts";
import { castOf } from "./master.ts";

/**
 * Lane-owned bookkeeping: the review rounds a lane ran on its work items, and
 * parking its own lane when the queue is empty. Both are the lane's own
 * records, so its lead writes them without asking the master; the master can
 * write them too.
 */

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const fail = (code: "invalid" | "forbidden" | "conflict" | "not-found", detail: string) =>
  new MissionError({ code, detail });

/** The caller leads this lane: its thread runs it, or it holds the lane's lead role. */
const leads = (standing: Standing, lane: Lane) =>
  standing.lanes.some((each) => each.id === lane.id) ||
  (lane.leadRoleId !== null && standing.roles.some((role) => role.id === lane.leadRoleId));

const sameRound = (left: WorkItemReviewRound, right: Omit<WorkItemReviewRound, "at">) =>
  left.round === right.round &&
  left.verdict === right.verdict &&
  left.findings === right.findings &&
  left.severe === right.severe &&
  left.headSha === right.headSha &&
  left.reviewer === right.reviewer;

const workItemRef = (item: WorkItem): MissionRecordRef => ({
  kind: "work-item",
  id: item.id,
  label: item.title,
});

const laneRef = (lane: Lane): MissionRecordRef => ({ kind: "lane", id: lane.id, label: lane.name });

export const makeReviewRoundWrites = (kit: WriteKit) => {
  const { store, serial, loadMission, unchanged, commit } = kit;

  const standingIn = (missionId: Lane["missionId"], provenance: MissionProvenance) =>
    Effect.map(castOf(store, missionId), (cast) => standingOf(cast, provenance));

  const recordReviewRound = (provenance: MissionProvenance, input: RecordReviewRoundInput) =>
    serial(
      Effect.gen(function* () {
        const mission = yield* loadMission(input.missionId);
        const item = Option.getOrNull(yield* store.get("work-item", input.workItemId));
        if (item === null || item.missionId !== mission.id) {
          return yield* fail("not-found", `No work item ${input.workItemId} in ${mission.id}.`);
        }
        const standing = yield* standingIn(mission.id, provenance);
        const lane =
          item.laneId === null ? null : Option.getOrNull(yield* store.get("lane", item.laneId));
        if (!standing.isMaster && (lane === null || !leads(standing, lane))) {
          return yield* fail(
            "forbidden",
            `Only the lead of ${item.title}'s lane or mission ${mission.id}'s master records its review rounds.`,
          );
        }
        if (input.verdict === "clear" && input.severe > 0) {
          return yield* fail("invalid", "A clear round has no P0/P1 findings.");
        }
        if (input.severe > input.findings) {
          return yield* fail("invalid", "P0/P1 findings are counted in findings too.");
        }
        const rounds = item.reviewRounds ?? [];
        const entry = {
          round: input.round,
          verdict: input.verdict,
          findings: input.findings,
          severe: input.severe,
          headSha: input.headSha ?? null,
          reviewer: input.reviewer,
        };
        const existing = rounds.find((each) => each.round === input.round);
        if (existing !== undefined) {
          if (sameRound(existing, entry)) return yield* unchanged(mission.id, workItemRef(item));
          return yield* fail(
            "conflict",
            `Round ${input.round} of ${item.title} is already recorded; record round ${rounds.length + 1} next.`,
          );
        }
        if (input.round !== rounds.length + 1) {
          return yield* fail(
            "invalid",
            `${item.title} has ${rounds.length} recorded rounds; the next is round ${rounds.length + 1}.`,
          );
        }
        const now = yield* nowIso;
        const previous = rounds.at(-1) ?? null;
        const record: WorkItem = {
          ...item,
          reviewRounds: [...rounds, { ...entry, at: now }],
          updatedAt: now,
        };
        const over = input.round > WORK_ITEM_REVIEW_BUDGET;
        return yield* commit(provenance, {
          missionId: mission.id,
          kind: "work-item.reviewed",
          summary: `"${item.title}" review round ${input.round}: ${
            input.verdict === "clear"
              ? "clear"
              : `${input.findings} finding${input.findings === 1 ? "" : "s"}${
                  input.severe > 0 ? ` (${input.severe} P0/P1)` : ""
                }`
          }${over ? `, past the ${WORK_ITEM_REVIEW_BUDGET}-round budget` : ""}`,
          ref: workItemRef(record),
          upserts: [{ _tag: "work-item", record }],
          payload: {
            round: input.round,
            verdict: input.verdict,
            findings: input.findings,
            severe: input.severe,
            headSha: entry.headSha,
            reviewer: input.reviewer,
            budget: WORK_ITEM_REVIEW_BUDGET,
            previousSevere: previous?.severe ?? null,
          },
        });
      }),
    );

  /**
   * A lead parks its own lane (queue empty) or puts it back to work. The
   * master keeps `mission_lane` for everything else, and an ask holding the
   * lane is checked by the transport, as for `mission_lane`.
   */
  const setOwnLaneStatus = (provenance: MissionProvenance, input: SetOwnLaneStatusInput) =>
    serial(
      Effect.gen(function* () {
        const mission = yield* loadMission(input.missionId);
        const standing = yield* standingIn(mission.id, provenance);
        // The lanes this thread runs: the transport checks ask holds on the same lane.
        const led = standing.lanes.filter((lane) => lane.status !== "retired");
        const lane =
          input.laneId === undefined
            ? led.length === 1
              ? (led[0] ?? null)
              : null
            : Option.getOrNull(yield* store.get("lane", input.laneId));
        if (lane === null) {
          return yield* fail(
            "invalid",
            led.length === 0
              ? `This thread leads no lane in ${mission.id}.`
              : `This thread leads ${led.length} lanes in ${mission.id}; pass laneId.`,
          );
        }
        if (lane.missionId !== mission.id) {
          return yield* fail("not-found", `No lane ${lane.id} in ${mission.id}.`);
        }
        if (!standing.isMaster && !standing.lanes.some((each) => each.id === lane.id)) {
          return yield* fail(
            "forbidden",
            `Only lane ${lane.name}'s own thread or the master sets its status.`,
          );
        }
        if (lane.status === "retired") {
          return yield* fail("conflict", `Lane ${lane.name} is retired.`);
        }
        const reason = input.reason ?? null;
        if (lane.status === input.status && lane.statusReason === reason) {
          return yield* unchanged(mission.id, laneRef(lane));
        }
        const record: Lane = {
          ...lane,
          status: input.status,
          statusReason: reason,
          updatedAt: yield* nowIso,
        };
        const kind =
          input.status === "parked"
            ? lane.status === "parked"
              ? "lane.updated"
              : "lane.parked"
            : lane.status === "parked"
              ? "lane.resumed"
              : "lane.updated";
        return yield* commit(provenance, {
          missionId: mission.id,
          kind,
          summary:
            kind === "lane.updated"
              ? `Lane "${record.name}": status ${input.status}`
              : `Lane "${record.name}" ${kind.slice("lane.".length)}${reason === null ? "" : `: ${reason}`}`,
          ref: laneRef(record),
          upserts: [{ _tag: "lane", record }],
          payload: {
            changed: ["status", "statusReason"],
            status: record.status,
            subMissionId: record.subMissionId,
            before: { status: lane.status, statusReason: lane.statusReason },
          },
        });
      }),
    );

  return { recordReviewRound, setOwnLaneStatus };
};
