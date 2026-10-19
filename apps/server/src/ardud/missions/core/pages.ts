import {
  MissionError,
  type MissionEventKind,
  type MissionTimelineGroup,
  type MissionTimelineInput,
  type MissionTimelinePage,
  type MissionWorkItemsInput,
  type MissionWorkItemsPage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as MissionStore from "../store/MissionStore.ts";

/**
 * Paged reads for the app's Work and Timeline tabs. Work items come newest
 * change first, filtered by lane and stage; timeline pages come newest first,
 * each event tagged with the family the Timeline filters by.
 */

const DEFAULT_PAGE = 100;
const MAX_PAGE = 500;

const PREFIX_GROUP: Readonly<Record<string, MissionTimelineGroup>> = {
  mission: "mission",
  portfolio: "mission",
  "sub-mission": "sub-mission",
  milestone: "sub-mission",
  lane: "lane",
  role: "role",
  rule: "rule",
  "review-policy": "review",
  criticality: "review",
  review: "review",
  pool: "pool",
  routing: "routing",
  record: "routing",
  ask: "inbox",
  call: "inbox",
  draft: "inbox",
  approval: "inbox",
  suggestion: "inbox",
  knock: "inbox",
  fork: "inbox",
  "secret-request": "inbox",
  recovery: "recovery",
};

/** The Timeline family of an event kind, by its prefix (`lane.created` is a lane event). */
export const timelineGroupOf = (kind: MissionEventKind | string): MissionTimelineGroup =>
  PREFIX_GROUP[kind.split(".")[0] ?? ""] ?? "other";

const pageSize = (limit: number | undefined) =>
  Math.min(Math.max(limit ?? DEFAULT_PAGE, 1), MAX_PAGE);

const notFound = (missionId: string) =>
  new MissionError({ code: "not-found", detail: `Mission ${missionId} does not exist.` });

export const makePages = (store: MissionStore.MissionStore["Service"]) => {
  const requireMission = (missionId: MissionWorkItemsInput["missionId"]) =>
    Effect.gen(function* () {
      if (Option.isNone(yield* store.get("mission", missionId))) {
        return yield* notFound(missionId);
      }
    });

  const workItems = (
    input: MissionWorkItemsInput,
  ): Effect.Effect<MissionWorkItemsPage, MissionError> =>
    Effect.gen(function* () {
      yield* requireMission(input.missionId);
      const offset = Math.max(input.offset ?? 0, 0);
      const page = yield* store.listPage("work-item", {
        missionId: input.missionId,
        ...(input.stages === undefined ? {} : { status: input.stages }),
        ...(input.laneId === undefined ? {} : { laneId: input.laneId }),
        offset,
        limit: pageSize(input.limit),
      });
      return {
        missionId: input.missionId,
        items: page.records,
        total: page.total,
        hasMore: offset + page.records.length < page.total,
      };
    });

  const timeline = (
    input: MissionTimelineInput,
  ): Effect.Effect<MissionTimelinePage, MissionError> =>
    Effect.gen(function* () {
      yield* requireMission(input.missionId);
      const size = pageSize(input.limit);
      const events = yield* store.recentEvents(input.missionId, size + 1, input.beforeSeq);
      return {
        missionId: input.missionId,
        entries: events
          .slice(0, size)
          .map((event) => ({ event, group: timelineGroupOf(event.kind) })),
        hasOlder: events.length > size,
      };
    });

  return { workItems, timeline };
};

export type MissionPages = ReturnType<typeof makePages>;
