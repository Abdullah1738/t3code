import type { MissionId, MissionProvenance } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { standingOf, type MissionCast } from "../asks/standing.ts";
import type * as MissionStore from "../store/MissionStore.ts";

/**
 * The calling thread's standing, looked up from its role bindings. Writes
 * that only the owner or a master may make check this themselves, so a
 * transport that forgets to doesn't open them up.
 */
export const castOf = (store: MissionStore.MissionStore["Service"], missionId: MissionId) =>
  Effect.gen(function* () {
    const mission = Option.getOrNull(yield* store.get("mission", missionId));
    const roles = yield* store.list("role", { missionId });
    const bindings = yield* store.list("role-binding", { missionId, status: ["bound"] });
    const lanes = yield* store.list("lane", { missionId });
    const forks = yield* store.list("fork", { missionId, status: ["open"] });
    const cast: MissionCast = { missionId, mission, roles, bindings, lanes, forks };
    return cast;
  });

/** True when the caller's thread holds the mission's master role right now. */
export const isMasterOf = (
  store: MissionStore.MissionStore["Service"],
  missionId: MissionId,
  provenance: MissionProvenance,
) =>
  provenance._tag !== "agent"
    ? Effect.succeed(false)
    : castOf(store, missionId).pipe(
        Effect.map((cast) => cast.mission !== null && standingOf(cast, provenance).isMaster),
      );

/** True when the caller is the master of any mission. */
export const isMasterAnywhere = (
  store: MissionStore.MissionStore["Service"],
  provenance: MissionProvenance,
) =>
  Effect.gen(function* () {
    if (provenance._tag !== "agent") return false;
    const missions = yield* store.list("mission", {});
    for (const mission of missions) {
      if (yield* isMasterOf(store, mission.id, provenance)) return true;
    }
    return false;
  });
