import {
  MissionId,
  PoolHoldId,
  PoolId,
  type Pool,
  type PoolHold,
  type PoolView,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import {
  agent,
  at,
  failureCode,
  harness,
  laneThread,
  masterThread,
  missionId,
  otherMissionId,
  ownerApp,
  seed,
  seedOther,
} from "../asks/AsksService.testkit.ts";
import * as MissionService from "../MissionService.ts";
import * as MissionStore from "../store/MissionStore.ts";
import { PORTFOLIO_TIMELINE } from "./portfolio.ts";

const thirdId = MissionId.make("m-3");
const master = agent(masterThread);

const seedThird = Effect.gen(function* () {
  const missions = yield* MissionService.MissionService;
  yield* missions.createMission(ownerApp, {
    missionId: thirdId,
    slug: "m-3",
    title: "Mission three",
    tier: "P0",
  });
});

const pool = (id: string, capacity: number): Pool => ({
  id: PoolId.make(id),
  name: `Pool ${id}`,
  unit: "slot",
  capacity,
  scope: { _tag: "global" },
  kind: "lease",
  backend: "native",
  enforcement: "enforced",
  usage: {
    used: 0,
    window: null,
    resetsAt: null,
    runOutAt: "2026-10-17T12:00:00.000Z",
    sampledAt: at,
  },
  priority: [],
  lockedFields: [],
  createdAt: at,
  updatedAt: at,
});

const hold = (
  id: string,
  poolId: string,
  holder: MissionId,
  amount: number,
  status: PoolHold["status"],
): PoolHold => ({
  id: PoolHoldId.make(id),
  poolId: PoolId.make(poolId),
  missionId: holder,
  holder: { _tag: "system", component: "test" },
  amount,
  purpose: "",
  fence: 1,
  status,
  leaseExpiresAt: null,
  takenAt: at,
  releasedAt: null,
  releaseNote: null,
  createdAt: at,
});

const view = (of: Pool, holds: ReadonlyArray<PoolHold>): PoolView => ({
  pool: of,
  holds,
  inUse: 0,
  pressure: "ok",
  pressureReason: "",
  sourceConfigured: true,
});

describe("portfolio", () => {
  it.effect("reads every live mission in order, with who changed what and pool use", () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      yield* seedOther;
      yield* seedThird;
      const missions = yield* MissionService.MissionService;

      // Default order: tier first (m-3 is P0), then weight, then title.
      const fresh = yield* missions.portfolio(null);
      assert.deepStrictEqual(fresh.order, [thirdId, missionId, otherMissionId]);
      assert.isNull(fresh.orderChange);
      assert.isTrue(fresh.missions.every((entry) => entry.usedShare === null));
      assert.isTrue(fresh.missions.every((entry) => entry.pools.length === 0));

      // The master changes m-1's tier; the owner changes its guaranteed share after.
      yield* missions.updateMission(master, { missionId, tier: "P2" });
      yield* missions.updateMission(ownerApp, { missionId, guaranteedShare: 0.3 });
      yield* missions.updateMission(ownerApp, { missionId, tier: "P0" });
      yield* missions.setMissionStatus(ownerApp, { missionId: otherMissionId, status: "archived" });

      const usage = {
        pools: [
          view(pool("slots", 4), [
            hold("h-1", "slots", missionId, 1, "active"),
            hold("h-2", "slots", missionId, 1, "queued"),
            hold("h-3", "slots", thirdId, 2, "reconcile-required"),
          ]),
          view(pool("empty", 0), [hold("h-4", "empty", missionId, 1, "active")]),
        ],
        shares: [{ missionId, dominant: 0.25 }],
      };
      const measured = yield* missions.portfolio(usage);
      assert.deepStrictEqual(
        measured.missions.map((entry) => entry.missionId),
        [missionId, thirdId],
        "archived missions leave the portfolio",
      );
      const one = measured.missions.find((entry) => entry.missionId === missionId);
      const three = measured.missions.find((entry) => entry.missionId === thirdId);
      assert.strictEqual(one?.usedShare, 0.25);
      assert.strictEqual(three?.usedShare, 0, "no measured share is no use");
      assert.deepStrictEqual(one?.pools, [
        {
          poolId: PoolId.make("slots"),
          label: "Pool slots",
          unit: "slot",
          share: 0.25,
          runOutAt: "2026-10-17T12:00:00.000Z",
        },
      ]);
      assert.strictEqual(three?.pools[0]?.share, 0.5);

      // The newest change per field: the owner's tier change, not the master's.
      const changesOf = (field: string) =>
        measured.changes.filter((change) => change.ref.id === missionId && change.field === field);
      assert.strictEqual(changesOf("tier").length, 1);
      assert.deepStrictEqual(changesOf("tier")[0]?.actor, { _tag: "owner" });
      assert.deepStrictEqual(changesOf("guaranteedShare")[0]?.actor, { _tag: "owner" });
      assert.strictEqual(changesOf("borrowCeiling").length, 0);
      assert.isFalse(measured.changes.some((change) => change.ref.id === otherMissionId));
    }).pipe(Effect.provide(layer));
  });

  it.effect("the owner and any master set one order; one event says who", () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      yield* seedOther;
      yield* seedThird;
      const missions = yield* MissionService.MissionService;
      const store = yield* MissionStore.MissionStore;

      const byOwner = yield* missions.setPortfolioOrder(ownerApp, {
        order: [otherMissionId, missionId],
      });
      const afterOwner = yield* missions.portfolio(null);
      assert.deepStrictEqual(
        afterOwner.order,
        [otherMissionId, missionId, thirdId],
        "unordered missions follow in default order",
      );
      assert.deepStrictEqual(afterOwner.orderChange?.actor, { _tag: "owner" });

      // A master of any mission may reorder too.
      const byMaster = yield* missions.setPortfolioOrder(master, {
        order: [thirdId, missionId, otherMissionId],
      });
      assert.isTrue(byMaster.seq > byOwner.seq);
      const [event] = yield* store.recentEvents(PORTFOLIO_TIMELINE, 1);
      assert.strictEqual(event?.kind, "portfolio.reordered");
      assert.deepStrictEqual(event?.actor, { _tag: "thread", threadId: masterThread });
      assert.deepStrictEqual(event?.payload, {
        order: [thirdId, missionId, otherMissionId],
        previousOrder: [otherMissionId, missionId],
      });
      assert.deepStrictEqual((yield* missions.portfolio(null)).order, [
        thirdId,
        missionId,
        otherMissionId,
      ]);

      // Same order again writes nothing.
      const again = yield* missions.setPortfolioOrder(master, {
        order: [thirdId, missionId, otherMissionId],
      });
      assert.strictEqual(again.seq, byMaster.seq);
      assert.strictEqual((yield* store.recentEvents(PORTFOLIO_TIMELINE, 10)).length, 2);

      assert.strictEqual(
        yield* failureCode(missions.setPortfolioOrder(agent(laneThread), { order: [missionId] })),
        "forbidden",
      );
      assert.strictEqual(
        yield* failureCode(missions.setPortfolioOrder(ownerApp, { order: [missionId, missionId] })),
        "invalid",
      );
      assert.strictEqual(
        yield* failureCode(
          missions.setPortfolioOrder(ownerApp, { order: [MissionId.make("m-none")] }),
        ),
        "not-found",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("a reorder reaches every list subscriber, so other devices refetch", () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      yield* seedOther;
      const missions = yield* MissionService.MissionService;
      const pull = yield* Stream.toPull(missions.subscribeList);
      const [first] = yield* pull;
      assert.strictEqual(first._tag, "list");

      yield* missions.setPortfolioOrder(ownerApp, { order: [otherMissionId, missionId] });
      const next = yield* pull.pipe(Effect.timeoutOption("2 seconds"));
      assert.isTrue(Option.isSome(next), "the reorder sent no list update");
    }).pipe(Effect.scoped, Effect.provide(layer));
  });
});
