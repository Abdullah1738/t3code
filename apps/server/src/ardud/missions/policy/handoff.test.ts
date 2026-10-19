import { LaneId, RoleId, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Sqlite from "../../../persistence/Sqlite.ts";
import {
  agent as asksAgent,
  binding,
  failureCode,
  laneThread,
  missionId,
  seed,
  writerThread,
} from "../asks/AsksService.testkit.ts";
import * as MissionService from "../MissionService.ts";
import * as MissionRouter from "../router/MissionRouter.ts";
import { fakeRouterThreads, routerOverFakes } from "../router/MissionRouter.testkit.ts";
import * as MissionStore from "../store/MissionStore.ts";
import { OPUS_XHIGH } from "./models.ts";
import * as PolicyService from "./PolicyService.ts";
import { subscriptionMover } from "./ports.ts";
import { CRPKO, OWNER, agent, makePorts, testLayer } from "./testing.ts";

const ports = makePorts();
const MASTER = agent("thread-master");
const STRANGER = agent("thread-stranger");
const LEAD = ThreadId.make("thread-lead-1");

const setup = Effect.gen(function* () {
  const missions = yield* MissionService.MissionService;
  const policy = yield* PolicyService.PolicyService;
  const store = yield* MissionStore.MissionStore;
  if (Option.isNone(yield* store.get("mission", CRPKO))) {
    yield* missions.createMission(OWNER, { missionId: CRPKO, slug: "crpko", title: "Crpko" });
  }
  for (const id of ["thread-master", "thread-stranger", LEAD, "thread-lead-2"]) {
    ports.threads.set(id, { exists: true, idle: true, modelSelection: OPUS_XHIGH });
  }
  yield* policy.bindRole(OWNER, {
    roleId: RoleId.make(`${CRPKO}:master`),
    threadId: ThreadId.make("thread-master"),
  });
  return { missions, policy, store };
});

/** A fresh lane whose lead role is held by `LEAD`. */
const leadLane = (name: string) =>
  Effect.gen(function* () {
    const { missions, policy, store } = yield* setup;
    const created = yield* missions.upsertLane(OWNER, { missionId: CRPKO, name });
    const laneId = LaneId.make(created.ref.id);
    const roleId = RoleId.make(`${CRPKO}:lane-lead:${laneId}`);
    yield* policy.bindRole(OWNER, { roleId, threadId: LEAD });
    const lane = yield* store.get("lane", laneId);
    assert.strictEqual(Option.getOrThrow(lane).threadId, LEAD);
    return { policy, store, laneId, roleId };
  });

const reset = () => {
  ports.launches.length = 0;
  ports.briefs.length = 0;
  ports.subscriptionMoves.length = 0;
};

it.layer(testLayer(ports.layer))("lane handoff", (it) => {
  it.effect("launches a fresh lead in the old lead's workspace, briefs it and moves the lane", () =>
    Effect.gen(function* () {
      const { policy, store, laneId, roleId } = yield* leadLane("api");
      reset();
      const result = yield* policy.handOffLane(OWNER, {
        laneId,
        handoffNote: "PR 41 is waiting on review; tests for the parser are next",
      });
      assert.strictEqual(ports.launches.length, 1);
      const launched = ports.launches[0]!;
      assert.strictEqual(launched.from, LEAD);
      assert.strictEqual(launched.title, "api lead");
      assert.strictEqual(result.ended.threadId, LEAD);
      assert.strictEqual(result.binding.threadId, launched.threadId);
      assert.strictEqual(result.binding.roleId, roleId);
      assert.strictEqual(result.binding.reason, "succession");
      const lane = Option.getOrThrow(yield* store.get("lane", laneId));
      assert.strictEqual(lane.threadId, launched.threadId);
      assert.strictEqual(lane.leadRoleId, roleId);
      // The new lead gets the note as its brief, once.
      assert.strictEqual(ports.briefs.length, 1);
      assert.strictEqual(ports.briefs[0]!.threadId, launched.threadId);
      assert.include(ports.briefs[0]!.text, "PR 41 is waiting on review");
      assert.include(ports.briefs[0]!.text, `taking over from thread ${LEAD}`);
      // Schedules (port), subscriptions (after commit) and children (reported) all show.
      assert.deepStrictEqual(
        result.moves.map((move) => [move.what, move.supported]),
        [
          ["schedules", true],
          ["children", false],
          ["subscriptions", true],
        ],
      );
      assert.deepStrictEqual(ports.subscriptionMoves, [
        { missionId: CRPKO, from: LEAD, to: launched.threadId },
      ]);
    }),
  );

  it.effect("the master can hand a lane to a thread it already launched; nothing is launched", () =>
    Effect.gen(function* () {
      const { policy, laneId } = yield* leadLane("docs");
      reset();
      const result = yield* policy.handOffLane(MASTER, {
        laneId,
        handoffNote: "docs index done",
        threadId: ThreadId.make("thread-lead-2"),
      });
      assert.strictEqual(result.binding.threadId, "thread-lead-2");
      assert.deepStrictEqual(ports.launches, []);
      assert.deepStrictEqual(ports.briefs, []);
    }),
  );

  it.effect(
    "refuses a stranger, a lane without a lead and a lead that left, before launching",
    () =>
      Effect.gen(function* () {
        const { missions, policy } = yield* setup;
        const { laneId } = yield* leadLane("web");
        reset();
        assert.strictEqual(
          yield* failureCode(policy.handOffLane(STRANGER, { laneId, handoffNote: "x" })),
          "forbidden",
        );
        const bare = yield* missions.upsertLane(OWNER, { missionId: CRPKO, name: "bare" });
        assert.strictEqual(
          yield* failureCode(
            policy.handOffLane(OWNER, { laneId: LaneId.make(bare.ref.id), handoffNote: "x" }),
          ),
          "conflict",
        );
        // The lane still points at a thread whose lead binding has ended.
        yield* policy.unbindRole(OWNER, {
          roleId: RoleId.make(`${CRPKO}:lane-lead:${laneId}`),
          threadId: LEAD,
        });
        assert.strictEqual(
          yield* failureCode(policy.handOffLane(OWNER, { laneId, handoffNote: "x" })),
          "conflict",
        );
        assert.strictEqual(
          yield* failureCode(
            policy.handOffLane(OWNER, { laneId: LaneId.make("lane-missing"), handoffNote: "x" }),
          ),
          "not-found",
        );
        assert.deepStrictEqual(ports.launches, []);
      }),
  );
});

describe("subscription mover", () => {
  const harness = () =>
    routerOverFakes(fakeRouterThreads()).pipe(
      Layer.provideMerge(MissionStore.layer),
      Layer.provideMerge(Sqlite.layerMemory),
    );

  it.effect("gives the successor the old thread's own subscriptions, mode and wake kinds", () =>
    Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const store = yield* MissionStore.MissionStore;
      const control = MissionRouter.controlRoomId(missionId);
      yield* router.subscribe(
        {
          roomId: control,
          subscriber: { _tag: "thread", threadId: writerThread },
          mode: "wake",
          wakeOn: ["blocker"],
        },
        asksAgent(writerThread),
      );
      // The writer role passes to a new thread, as succeedRole commits it.
      const next = ThreadId.make("t-writer-2");
      yield* store.commit({
        event: {
          missionId,
          kind: "role.succession",
          actor: { _tag: "system", component: "test" },
          provenance: { _tag: "system", component: "test" },
          summary: "writer handed over",
          subject: null,
        },
        upserts: [
          {
            _tag: "role-binding",
            record: {
              ...binding("b-writer", "role-writer", writerThread),
              endedAt: "2026-10-17T09:00:00.000Z",
            },
          },
          { _tag: "role-binding", record: binding("b-writer-2", "role-writer", next) },
        ],
      });
      const move = yield* subscriptionMover(router)(missionId, writerThread, next);
      assert.deepStrictEqual(move, { what: "subscriptions", moved: 1, failed: 0, supported: true });
      const tuning = yield* router.roomTuning({ roomId: control }, asksAgent(next));
      const copied = tuning.subscriptions.find(
        (each) => each.subscriber._tag === "thread" && each.subscriber.threadId === next,
      );
      assert.isDefined(copied);
      assert.strictEqual(copied!.mode, "wake");
      assert.deepStrictEqual(copied!.wakeOn, ["blocker"]);
      // A thread with no subscriptions of its own moves nothing.
      const none = yield* subscriptionMover(router)(missionId, ThreadId.make("t-nobody"), next);
      assert.deepStrictEqual(none, { what: "subscriptions", moved: 0, failed: 0, supported: true });
      // An old thread that is still a member (here through its lane) is muted,
      // so it stops waking next to its successor.
      yield* router.subscribe(
        { roomId: control, subscriber: { _tag: "thread", threadId: laneThread }, mode: "wake" },
        asksAgent(laneThread),
      );
      yield* subscriptionMover(router)(missionId, laneThread, next);
      const after = yield* router.roomTuning({ roomId: control }, asksAgent(next));
      const old = after.subscriptions.find(
        (each) => each.subscriber._tag === "thread" && each.subscriber.threadId === laneThread,
      );
      assert.strictEqual(old?.mode, "mute");
    }).pipe(Effect.provide(harness())),
  );
});
