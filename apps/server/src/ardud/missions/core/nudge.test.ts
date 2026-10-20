import {
  LaneId,
  MissionId,
  RoomId,
  type MissionEvent,
  type MissionMessageId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Sqlite from "../../../persistence/Sqlite.ts";
import {
  agent,
  failureCode,
  lane,
  laneThread,
  masterThread,
  missionId,
  otherLane,
  otherMasterThread,
  ownerApp,
  seed,
  seedOther,
} from "../asks/AsksService.testkit.ts";
import { MissionRouter } from "../router/MissionRouter.ts";
import { fakeRouterThreads, routerOverFakes } from "../router/MissionRouter.testkit.ts";
import * as MissionStore from "../store/MissionStore.ts";
import { nudgeLane } from "./nudge.ts";

const harness = () => {
  const threads = fakeRouterThreads();
  const layer = routerOverFakes(threads).pipe(
    Layer.provideMerge(MissionStore.layer),
    Layer.provideMerge(Sqlite.layerMemory),
  );
  return { ...threads, layer };
};

const control = RoomId.make(`${missionId}:room:control`);

interface NudgePayload {
  readonly messageId: MissionMessageId;
  readonly note: string | null;
  readonly roomId: string;
}
const payloadOf = (event: MissionEvent | undefined) => event?.payload as NudgePayload;

describe("nudgeLane", () => {
  it.effect("posts one control-room request to the lane, wakes its thread, logs who", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      yield* seedOther;
      const store = yield* MissionStore.MissionStore;
      const router = yield* MissionRouter;
      const deps = { store, router };

      const byOwner = yield* nudgeLane(deps, ownerApp, { laneId: lane.id, note: "  Status?  " });
      const [event] = yield* store.recentEvents(missionId, 1);
      assert.strictEqual(event?.seq, byOwner.seq);
      assert.strictEqual(event?.kind, "lane.nudged");
      assert.deepStrictEqual(event?.actor, { _tag: "owner" });
      assert.deepStrictEqual(event?.subject, { kind: "lane", id: lane.id, label: "API" });
      const payload = payloadOf(event);
      assert.strictEqual(payload.note, "Status?");
      assert.strictEqual(payload.roomId, control);

      const page = yield* router.roomPage({ roomId: control }, ownerApp);
      const message = page.messages.find((entry) => entry.id === payload.messageId);
      assert.strictEqual(message?.kind, "request");
      assert.strictEqual(message?.summary, "Status?");
      assert.deepStrictEqual(message?.to, [{ _tag: "lane", laneId: lane.id }]);
      assert.strictEqual(
        h.sent.filter(
          (each) => each.threadId === laneThread && each.key.startsWith("mission-wake:"),
        ).length,
        1,
        "the lane's thread is woken once",
      );

      // The master nudges with no note; the default line asks where it stands.
      yield* nudgeLane(deps, agent(masterThread), { laneId: lane.id });
      const [byMaster] = yield* store.recentEvents(missionId, 1);
      assert.strictEqual(byMaster?.kind, "lane.nudged");
      assert.deepStrictEqual(byMaster?.actor, { _tag: "thread", threadId: masterThread });
      assert.strictEqual(payloadOf(byMaster).note, null);

      // A long note keeps its whole text as the message body.
      const long = "x".repeat(450);
      yield* nudgeLane(deps, ownerApp, { laneId: lane.id, note: long });
      const [longNudge] = yield* store.recentEvents(missionId, 1);
      const body = yield* router.messageBody(
        { messageId: payloadOf(longNudge).messageId },
        ownerApp,
      );
      assert.strictEqual(body.body, long);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("only the owner or that mission's master nudges a live lane", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      yield* seedOther;
      const store = yield* MissionStore.MissionStore;
      const router = yield* MissionRouter;
      const deps = { store, router };
      const code = (effect: ReturnType<typeof nudgeLane>) => failureCode(effect);

      assert.strictEqual(
        yield* code(nudgeLane(deps, agent(laneThread), { laneId: lane.id })),
        "forbidden",
      );
      assert.strictEqual(
        yield* code(nudgeLane(deps, agent(otherMasterThread), { laneId: lane.id })),
        "forbidden",
        "another mission's master",
      );
      assert.strictEqual(
        yield* code(nudgeLane(deps, ownerApp, { laneId: LaneId.make("lane-none") })),
        "not-found",
      );
      assert.strictEqual(
        yield* code(nudgeLane(deps, agent(masterThread), { laneId: otherLane.id }, missionId)),
        "not-found",
        "a master tool pins the lane to its mission",
      );
      const own = yield* nudgeLane(
        deps,
        agent(otherMasterThread),
        { laneId: otherLane.id },
        MissionId.make("m-2"),
      );
      assert.strictEqual(own.ref.id, otherLane.id);

      yield* store.upsert(
        { _tag: "lane", record: { ...lane, status: "retired" } },
        {
          missionId,
          kind: "lane.updated",
          actor: { _tag: "owner" },
          provenance: ownerApp,
          summary: "retired",
          subject: null,
        },
      );
      assert.strictEqual(yield* code(nudgeLane(deps, ownerApp, { laneId: lane.id })), "conflict");
      assert.strictEqual(h.sent.filter((each) => each.threadId === laneThread).length, 0);
    }).pipe(Effect.provide(h.layer));
  });
});
