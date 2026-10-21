import {
  MissionId,
  ThreadId,
  type AttachThreadInput,
  type MissionProvenance,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  failureCode,
  harness,
  laneThread,
  masterThread,
  missionId,
  ownerApp,
  seed,
  seedOther,
  writerThread,
} from "../asks/AsksService.testkit.ts";
import * as MissionService from "../MissionService.ts";
import * as MissionStore from "../store/MissionStore.ts";

const crw: MissionProvenance = { _tag: "system", component: "crw" };
const reviewThread = ThreadId.make("t-review-361");

const attach = (extra: Partial<AttachThreadInput> = {}): AttachThreadInput => ({
  missionId,
  threadId: reviewThread,
  attachedBy: "crw",
  title: "CRPKO backoffice-core#361 | Awaiting Decision",
  pullRequest: { repository: "Equicom-Crypto/backoffice-core", number: 361 },
  ...extra,
});

const listedThreads = Effect.gen(function* () {
  const missions = yield* MissionService.MissionService;
  const list = yield* missions.listSnapshot;
  return list.missions.find((mission) => mission.id === missionId)?.threadIds ?? [];
});

describe("thread attachments", () => {
  it.effect("an attached thread belongs to the mission until it is detached", () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const missions = yield* MissionService.MissionService;
      const store = yield* MissionStore.MissionStore;

      const first = yield* missions.attachThread(crw, attach());
      assert.deepStrictEqual(
        [...(yield* listedThreads)].toSorted(),
        [laneThread, masterThread, reviewThread, writerThread].toSorted(),
      );
      const overview = yield* missions.overview(missionId);
      assert.deepStrictEqual(
        overview.attachedThreads?.map((thread) => [thread.threadId, thread.state]),
        [[reviewThread, "open"]],
      );

      // Every tick resends it: nothing new is committed.
      const again = yield* missions.attachThread(crw, attach());
      assert.equal(again.seq, first.seq);

      // The PR merged: the thread stays in the mission, out of the ordinary list.
      yield* missions.attachThread(
        crw,
        attach({ state: "closed", title: "CRPKO backoffice-core#361 | Merged" }),
      );
      assert.include(yield* listedThreads, reviewThread);
      const closed = Option.getOrThrow(yield* store.get("thread-attachment", reviewThread));
      assert.equal(closed.state, "closed");
      assert.deepStrictEqual(closed.pullRequest, attach().pullRequest);

      yield* missions.attachThread(crw, attach({ state: "detached" }));
      assert.notInclude(yield* listedThreads, reviewThread);
      assert.deepStrictEqual((yield* missions.overview(missionId)).attachedThreads, []);

      // Attachments never make a thread act for the mission.
      assert.deepStrictEqual(yield* store.missionsOfThread(reviewThread), []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("only the component that runs a thread attaches it, in one mission at a time", () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      yield* seedOther;
      const missions = yield* MissionService.MissionService;

      assert.equal(yield* failureCode(missions.attachThread(ownerApp, attach())), "forbidden");
      assert.equal(
        yield* failureCode(missions.attachThread(crw, attach({ attachedBy: "governor" }))),
        "forbidden",
      );
      assert.equal(
        yield* failureCode(
          missions.attachThread(crw, attach({ missionId: MissionId.make("m-9") })),
        ),
        "not-found",
      );

      yield* missions.attachThread(crw, attach());
      const governor: MissionProvenance = { _tag: "system", component: "governor" };
      assert.equal(
        yield* failureCode(missions.attachThread(governor, attach({ attachedBy: "governor" }))),
        "forbidden",
      );
      const elsewhere = attach({ missionId: MissionId.make("m-2") });
      assert.equal(yield* failureCode(missions.attachThread(crw, elsewhere)), "conflict");

      // Detached, it may move.
      yield* missions.attachThread(crw, attach({ state: "detached" }));
      yield* missions.attachThread(crw, elsewhere);
      assert.notInclude(yield* listedThreads, reviewThread);
    }).pipe(Effect.provide(layer));
  });
});
