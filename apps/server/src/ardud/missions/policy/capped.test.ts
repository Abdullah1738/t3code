/**
 * Past the store's 1,000-row `list` page. Callers, holders and bindings must
 * come from complete reads, so a crowd of newer records never hides an older
 * master or holder.
 */
import { MissionId, PoolId, RoleId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { binding, mission, role } from "../asks/AsksService.testkit.ts";
import * as MissionService from "../MissionService.ts";
import * as MissionStore from "../store/MissionStore.ts";
import { OPUS_XHIGH } from "./models.ts";
import * as PolicyService from "./PolicyService.ts";
import { CRPKO, OWNER, agent, makePorts, testLayer } from "./testing.ts";

const ports = makePorts();
const MASTER = agent("thread-master");
const STRANGER = agent("thread-stranger");
const CROWD = 1_001;
const later = "2026-10-18T08:00:00.000Z";
const crowdEvent = {
  kind: "mission.created",
  actor: { _tag: "system", component: "test" },
  provenance: { _tag: "system", component: "test" },
  summary: "crowd",
  subject: null,
} as const;

const setup = Effect.gen(function* () {
  const missions = yield* MissionService.MissionService;
  const policy = yield* PolicyService.PolicyService;
  const store = yield* MissionStore.MissionStore;
  if ((yield* store.get("mission", CRPKO))._tag === "None") {
    yield* missions.createMission(OWNER, { missionId: CRPKO, slug: "crpko", title: "Crpko" });
    for (const thread of ["thread-master", "thread-stranger", "thread-a", "thread-b"]) {
      ports.threads.set(thread, { exists: true, idle: true, modelSelection: OPUS_XHIGH });
    }
    yield* policy.bindRole(OWNER, {
      roleId: RoleId.make("crpko:master"),
      threadId: ThreadId.make("thread-master"),
    });
  }
  return { policy, store };
});

/** More missions than one page, each with a master bound after Crpko's. */
const crowdMissions = Effect.gen(function* () {
  const store = yield* MissionStore.MissionStore;
  yield* store.commit({
    event: { ...crowdEvent, missionId: MissionId.make("m-crowd-0") },
    upserts: Array.from({ length: CROWD }, (_, index) => {
      const missionId = MissionId.make(`m-crowd-${index}`);
      const roleId = `m-crowd-${index}:master`;
      return [
        {
          _tag: "mission" as const,
          record: {
            ...mission,
            id: missionId,
            slug: `crowd-${index}`,
            masterRoleId: RoleId.make(roleId),
            createdAt: later,
            updatedAt: later,
          },
        },
        { _tag: "role" as const, record: { ...role(roleId, "master"), missionId } },
        {
          _tag: "role-binding" as const,
          record: {
            ...binding(`b-crowd-${index}`, roleId, ThreadId.make(`t-crowd-${index}`)),
            boundAt: later,
          },
        },
      ];
    }).flat(),
  });
  const page = yield* store.list("role-binding", { status: ["bound"] });
  if (page.length !== 1_000 || page.some((entry) => entry.threadId === "thread-master")) {
    return yield* Effect.die("crowdMissions did not push Crpko's master off the first page");
  }
});

/** More bound roles in Crpko than one page, each bound after its master. */
const crowdBindings = Effect.gen(function* () {
  const store = yield* MissionStore.MissionStore;
  yield* store.commit({
    event: { ...crowdEvent, missionId: CRPKO },
    upserts: Array.from({ length: CROWD }, (_, index) => [
      {
        _tag: "role" as const,
        record: { ...role(`crpko:crowd-${index}`, "writer"), missionId: CRPKO, updatedAt: later },
      },
      {
        _tag: "role-binding" as const,
        record: {
          ...binding(`b-crpko-${index}`, `crpko:crowd-${index}`, ThreadId.make(`t-crpko-${index}`)),
          boundAt: later,
        },
      },
    ]).flat(),
  });
  const page = yield* store.list("role-binding", { missionId: CRPKO, status: ["bound"] });
  if (page.length !== 1_000 || page.some((entry) => entry.threadId === "thread-master")) {
    return yield* Effect.die("crowdBindings did not push Crpko's master off the first page");
  }
});

it.layer(testLayer(ports.layer))("policy past one page", (it) => {
  it.effect("lets an old master govern a global pool past 1,000 newer missions", () =>
    Effect.gen(function* () {
      const { policy } = yield* setup;
      yield* crowdMissions;
      const created = yield* policy.createPool(MASTER, {
        poolId: PoolId.make("crowd-slots"),
        name: "Crowd slots",
        unit: "slot",
        capacity: 1,
        scope: { _tag: "global" },
        kind: "lease",
        backend: "native",
      });
      const poolId = PoolId.make(created.ref.id);
      yield* policy.setPoolCapacity(MASTER, { poolId, capacity: 2 });
      const view = (yield* policy.pools({})).pools.find((entry) => entry.pool.id === poolId)!;
      assert.strictEqual(view.pool.capacity, 2);
      // A crowd master governs too; a thread with no master role never does.
      yield* policy.setPoolCapacity(agent("t-crowd-0"), { poolId, capacity: 3 });
      const refused = yield* Effect.flip(policy.setPoolCapacity(STRANGER, { poolId, capacity: 5 }));
      assert.strictEqual(refused.code, "forbidden");
    }),
  );

  it.effect("finds the master and a role's holder past 1,000 newer bindings", () =>
    Effect.gen(function* () {
      const { policy } = yield* setup;
      yield* crowdBindings;
      const editor = RoleId.make("crpko:editor");
      // The master's own binding is older than the whole crowd.
      yield* policy.bindRole(MASTER, { roleId: editor, threadId: ThreadId.make("thread-a") });
      // So is the editor's: succession must still find its holder.
      const handed = yield* policy.succeedRole(MASTER, {
        roleId: editor,
        threadId: ThreadId.make("thread-b"),
        handoffNote: "carry on",
      });
      assert.strictEqual(handed.ended.threadId, "thread-a");
      const snapshot = yield* policy.roles(CRPKO);
      const held = snapshot.bindings.filter((entry) => entry.endedAt === null);
      assert.isTrue(held.some((entry) => entry.threadId === "thread-master"));
      assert.isTrue(held.some((entry) => entry.threadId === "thread-b"));
      assert.isFalse(held.some((entry) => entry.threadId === "thread-a"));
      const refused = yield* Effect.flip(
        policy.bindRole(STRANGER, { roleId: editor, threadId: ThreadId.make("thread-a") }),
      );
      assert.strictEqual(refused.code, "forbidden");
    }),
  );
});
