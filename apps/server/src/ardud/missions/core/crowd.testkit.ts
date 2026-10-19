/**
 * Past the store's 1,000-row `list` page: newer records that push the seeded
 * mission (m-1) and its master binding off the first page, so a reader that
 * trusted that page would miss them.
 */
import { MissionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { binding, mission, missionId, role } from "../asks/AsksService.testkit.ts";
import * as MissionStore from "../store/MissionStore.ts";

const later = "2026-10-18T08:00:00.000Z";
export const CROWD = 1_001;

const crowdEvent = {
  kind: "mission.created",
  actor: { _tag: "system", component: "test" },
  provenance: { _tag: "system", component: "test" },
  summary: "crowd",
  subject: null,
} as const;

/** More missions than one page, all updated after m-1. */
export const crowdMissions = Effect.gen(function* () {
  const store = yield* MissionStore.MissionStore;
  yield* store.commit({
    event: { ...crowdEvent, missionId: MissionId.make("m-crowd-0") },
    upserts: Array.from({ length: CROWD }, (_, index) => ({
      _tag: "mission" as const,
      record: {
        ...mission,
        id: MissionId.make(`m-crowd-${index}`),
        slug: `crowd-${index}`,
        masterRoleId: null,
        createdAt: later,
        updatedAt: later,
      },
    })),
  });
  const page = yield* store.list("mission");
  // The precondition: the page a capped reader sees leaves m-1 out.
  if (page.length !== 1_000 || page.some((entry) => entry.id === missionId)) {
    return yield* Effect.die("crowdMissions did not push m-1 off the first page");
  }
});

/** More bound roles in m-1 than one page, each bound after its master. */
export const crowdBindings = Effect.gen(function* () {
  const store = yield* MissionStore.MissionStore;
  yield* store.commit({
    event: { ...crowdEvent, missionId },
    upserts: Array.from({ length: CROWD }, (_, index) => [
      {
        _tag: "role" as const,
        record: { ...role(`role-crowd-${index}`, "writer"), updatedAt: later },
      },
      {
        _tag: "role-binding" as const,
        record: {
          ...binding(`b-crowd-${index}`, `role-crowd-${index}`, ThreadId.make(`t-crowd-${index}`)),
          boundAt: later,
        },
      },
    ]).flat(),
  });
  const page = yield* store.list("role-binding", { missionId, status: ["bound"] });
  if (page.length !== 1_000 || page.some((entry) => entry.id === "b-master")) {
    return yield* Effect.die("crowdBindings did not push b-master off the first page");
  }
});
