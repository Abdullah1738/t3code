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
  agent,
  failureCode,
  governor,
  harness,
  laneThread,
  masterThread,
  missionId,
  otherMasterThread,
  otherMissionId,
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
    const { layer, threadCreators } = harness();
    threadCreators.set(reviewThread, "crw");
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

      // Every tick resends it, and a renamed PR alone is not news: nothing new is committed.
      const again = yield* missions.attachThread(crw, attach());
      assert.equal(again.seq, first.seq);
      const renamed = yield* missions.attachThread(crw, attach({ title: "Renamed upstream" }));
      assert.equal(renamed.seq, first.seq);

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
    const { layer, threadCreators } = harness();
    threadCreators.set(reviewThread, "crw");
    return Effect.gen(function* () {
      yield* seed;
      yield* seedOther;
      const missions = yield* MissionService.MissionService;

      assert.equal(yield* failureCode(missions.attachThread(ownerApp, attach())), "forbidden");
      // The thread must exist and crw must have created it; saying so is not enough.
      const unknown = ThreadId.make("t-nowhere");
      assert.equal(
        yield* failureCode(missions.attachThread(crw, attach({ threadId: unknown }))),
        "not-found",
      );
      for (const [threadId, creator] of [
        [ThreadId.make("t-bridge"), "spectrum-bridge"],
        [ThreadId.make("t-typed"), null],
      ] as const) {
        threadCreators.set(threadId, creator);
        assert.equal(
          yield* failureCode(missions.attachThread(crw, attach({ threadId }))),
          "forbidden",
        );
      }
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
      assert.equal(
        yield* failureCode(missions.attachThread(governor, attach({ attachedBy: "governor" }))),
        "forbidden",
      );
      const elsewhere = attach({ missionId: otherMissionId });
      assert.equal(yield* failureCode(missions.attachThread(crw, elsewhere)), "conflict");

      // Detached, it may move.
      yield* missions.attachThread(crw, attach({ state: "detached" }));
      yield* missions.attachThread(crw, elsewhere);
      assert.notInclude(yield* listedThreads, reviewThread);

      // A thread that acts for a mission is never hidden as a review.
      for (const acting of [masterThread, laneThread]) {
        assert.equal(
          yield* failureCode(missions.attachThread(crw, attach({ threadId: acting }))),
          "conflict",
        );
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "old settled threads go back to the thread list together with the Reviews group",
    () => {
      const { layer, threadCreators } = harness();
      const threads = Array.from({ length: 22 }, (_, index) => ThreadId.make(`t-pr-${index}`));
      for (const threadId of threads) threadCreators.set(threadId, "crw");
      return Effect.gen(function* () {
        yield* seed;
        const missions = yield* MissionService.MissionService;
        for (const [index, threadId] of threads.entries()) {
          const pullRequest = { repository: "Equicom-Crypto/edge-api", number: index + 1 };
          yield* missions.attachThread(crw, attach({ threadId, pullRequest }));
          if (index > 0) {
            yield* missions.attachThread(crw, attach({ threadId, pullRequest, state: "closed" }));
          }
        }
        const shown = (yield* missions.overview(missionId)).attachedThreads ?? [];
        const listed = yield* listedThreads;
        // The open one plus the latest 20 settled ones; the oldest settled one is back in the list.
        assert.equal(shown.length, 21);
        assert.deepStrictEqual(shown[0]?.threadId, threads[0]);
        assert.notInclude(listed, threads[1]);
        assert.notInclude(
          shown.map((thread) => thread.threadId),
          threads[1],
        );
        for (const thread of shown) assert.include(listed, thread.threadId);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("the owner or the master detaches any attachment; crw can attach it again", () => {
    const { layer, threadCreators } = harness();
    threadCreators.set(reviewThread, "crw");
    return Effect.gen(function* () {
      yield* seed;
      yield* seedOther;
      const missions = yield* MissionService.MissionService;
      const store = yield* MissionStore.MissionStore;
      const detach = { missionId, threadId: reviewThread, state: "detached" } as const;
      const stateOf = Effect.map(
        store.get("thread-attachment", reviewThread),
        (found) => Option.getOrThrow(found).state,
      );
      yield* missions.attachThread(crw, attach());

      // Components, lanes and other missions' masters do not move it.
      for (const by of [
        crw,
        governor,
        agent(laneThread),
        agent(writerThread),
        agent(otherMasterThread),
      ]) {
        assert.equal(yield* failureCode(missions.setThreadAttachment(by, detach)), "forbidden");
      }
      assert.equal(
        yield* failureCode(
          missions.setThreadAttachment(ownerApp, { ...detach, threadId: ThreadId.make("t-other") }),
        ),
        "not-found",
      );
      assert.equal(
        yield* failureCode(
          missions.setThreadAttachment(agent(otherMasterThread), {
            ...detach,
            missionId: otherMissionId,
          }),
        ),
        "not-found",
      );

      const detached = yield* missions.setThreadAttachment(ownerApp, detach);
      const [event] = yield* missions.eventsSince(missionId, detached.seq - 1);
      assert.equal(event?.kind, "thread.detached");
      assert.deepStrictEqual(event?.actor, { _tag: "owner" });
      assert.notInclude(yield* listedThreads, reviewThread);
      assert.deepStrictEqual((yield* missions.overview(missionId)).attachedThreads, []);
      assert.equal((yield* missions.setThreadAttachment(ownerApp, detach)).seq, detached.seq);

      // The PR merging later does not pull it back in; a fresh attach does.
      const merged = yield* missions.attachThread(crw, attach({ state: "closed" }));
      assert.equal(merged.seq, detached.seq);
      assert.equal(yield* stateOf, "detached");
      yield* missions.attachThread(crw, attach());
      assert.equal(yield* stateOf, "open");
      assert.include(yield* listedThreads, reviewThread);

      // The master can do the same, and put it back.
      const master = agent(masterThread);
      yield* missions.setThreadAttachment(master, detach);
      assert.equal(yield* stateOf, "detached");
      yield* missions.setThreadAttachment(master, { ...detach, state: "open" });
      assert.equal(yield* stateOf, "open");
      yield* missions.setThreadAttachment(master, { ...detach, state: "closed" });
      assert.equal(yield* stateOf, "closed");
      const record = Option.getOrThrow(yield* store.get("thread-attachment", reviewThread));
      assert.equal(record.attachedBy, "crw");
      assert.deepStrictEqual(record.pullRequest, attach().pullRequest);

      // Detached by the master, it can move to the mission it belongs to.
      yield* missions.setThreadAttachment(master, detach);
      yield* missions.attachThread(crw, attach({ missionId: otherMissionId }));
      const moved = Option.getOrThrow(yield* store.get("thread-attachment", reviewThread));
      assert.deepStrictEqual([moved.missionId, moved.state], [otherMissionId, "open"]);
    }).pipe(Effect.provide(layer));
  });
});
