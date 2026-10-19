import type { MissionId, MissionProvenance } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { standingOf, type MissionCast } from "../asks/standing.ts";
import type * as MissionStore from "../store/MissionStore.ts";

const newestFirst = <A>(oldestFirst: ReadonlyArray<A>) => oldestFirst.toReversed();

/**
 * The calling thread's standing, looked up from its role bindings. Writes
 * that only the owner or a master may make check this themselves, so a
 * transport that forgets to doesn't open them up. Reads the whole cast:
 * `list` stops at its limit, and authority must never hang on what a page
 * happened to include.
 */
export const castOf = (store: MissionStore.MissionStore["Service"], missionId: MissionId) =>
  Effect.gen(function* () {
    const mission = Option.getOrNull(yield* store.get("mission", missionId));
    // Newest first, as `list` returned them: `roles[0]` and `lanes[0]` keep meaning
    // the caller's most recent role and lane.
    const roles = newestFirst(yield* store.listAllInMission("role", missionId));
    const bindings = newestFirst(
      yield* store.listAllInMission("role-binding", missionId, ["bound"]),
    );
    const lanes = newestFirst(yield* store.listAllInMission("lane", missionId));
    const forks = newestFirst(yield* store.listAllInMission("fork", missionId, ["open"]));
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

/**
 * Every mission whose master role the caller's thread holds right now. Starts
 * from the store's complete thread index, so a master is found however many
 * missions exist.
 */
export const missionsMasteredBy = (
  store: MissionStore.MissionStore["Service"],
  provenance: MissionProvenance,
) =>
  Effect.gen(function* () {
    if (provenance._tag !== "agent") return [];
    const mastered: Array<MissionId> = [];
    for (const missionId of yield* store.missionsOfThread(provenance.threadId)) {
      if (yield* isMasterOf(store, missionId, provenance)) mastered.push(missionId);
    }
    return mastered;
  });

/** True when the caller is the master of any mission. */
export const isMasterAnywhere = (
  store: MissionStore.MissionStore["Service"],
  provenance: MissionProvenance,
) =>
  Effect.gen(function* () {
    if (provenance._tag !== "agent") return false;
    for (const missionId of yield* store.missionsOfThread(provenance.threadId)) {
      if (yield* isMasterOf(store, missionId, provenance)) return true;
    }
    return false;
  });
