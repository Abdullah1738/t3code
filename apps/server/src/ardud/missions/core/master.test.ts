import { assert, it } from "@effect/vitest";
import { RoleId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as AsksService from "../asks/AsksService.ts";
import {
  agent,
  harness,
  laneThread,
  masterThread,
  missionId,
  ownerApp,
  seed,
} from "../asks/AsksService.testkit.ts";
import * as MissionStore from "../store/MissionStore.ts";
import { crowdBindings, crowdMissions } from "./crowd.testkit.ts";
import { castOf, isMasterAnywhere, isMasterOf, missionsMasteredBy } from "./master.ts";

const master = agent(masterThread);

it.effect("N10: a master whose mission is past the first page of missions is still a master", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* crowdMissions;
    const store = yield* MissionStore.MissionStore;

    assert.isTrue(yield* isMasterAnywhere(store, master));
    assert.deepStrictEqual(yield* missionsMasteredBy(store, master), [missionId]);
    // Members, strangers and the owner are not masters anywhere.
    assert.isFalse(yield* isMasterAnywhere(store, agent(laneThread)));
    assert.isFalse(yield* isMasterAnywhere(store, ownerApp));
  }).pipe(Effect.provide(harness().layer)),
);

it.effect("N10: a master bound before a page of other bindings keeps its standing", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* crowdBindings;
    const store = yield* MissionStore.MissionStore;
    const asks = yield* AsksService.AsksService;

    const cast = yield* castOf(store, missionId);
    assert.strictEqual(cast.bindings.length, 1_003);
    assert.isTrue(yield* isMasterOf(store, missionId, master));
    assert.isTrue(yield* isMasterAnywhere(store, master));
    // Asks reads the same whole cast: the master still speaks as its role.
    const standing = yield* asks.standing(missionId, master);
    assert.isTrue(standing.isMaster);
    assert.deepStrictEqual(standing.caller.provenance, {
      _tag: "agent",
      threadId: masterThread,
      roleId: RoleId.make("role-master"),
    });
  }).pipe(Effect.provide(harness().layer)),
);
