/**
 * How policy reads the store: by-id reads come back complete in a few pages,
 * the boot sweep reads roles in batches rather than one at a time, and the
 * governor and per-PR review reads never go through a capped page.
 */
import { MissionId, RoleId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Sqlite from "../../../persistence/Sqlite.ts";
import { mission, role } from "../asks/AsksService.testkit.ts";
import * as MissionService from "../MissionService.ts";
import * as MissionStore from "../store/MissionStore.ts";
import type { MissionListFilter } from "../store/MissionStore.ts";
import { recordsByIds } from "./context.ts";
import { OPUS_XHIGH } from "./models.ts";
import * as PolicyService from "./PolicyService.ts";
import * as PolicyStore from "./PolicyStore.ts";
import { CRPKO, OWNER, agent, makePorts } from "./testing.ts";

const ports = makePorts();
const reads = {
  roleGets: 0,
  lists: [] as Array<{ readonly kind: string; readonly filter: MissionListFilter | undefined }>,
};
const resetReads = () => {
  reads.roleGets = 0;
  reads.lists.length = 0;
};

/** The real store, counting single-record role reads and every `list` page. */
const countingStore = Layer.effect(
  MissionStore.MissionStore,
  Effect.gen(function* () {
    const store = yield* MissionStore.MissionStore;
    return MissionStore.MissionStore.of({
      ...store,
      get: (kind, id) => {
        if (kind === "role") reads.roleGets += 1;
        return store.get(kind, id);
      },
      list: (kind, filter) => {
        reads.lists.push({ kind, filter });
        return store.list(kind, filter);
      },
    });
  }),
).pipe(Layer.provide(MissionStore.layer));

const layer = PolicyService.makeLayer().pipe(
  Layer.provideMerge(PolicyStore.layer),
  Layer.provideMerge(MissionService.layer),
  Layer.provideMerge(ports.layer),
  Layer.provideMerge(countingStore),
  Layer.provideMerge(Sqlite.layerMemory),
);

const event = {
  kind: "mission.created",
  actor: { _tag: "system", component: "test" },
  provenance: { _tag: "system", component: "test" },
  summary: "seed",
  subject: null,
} as const;

it.layer(layer)("policy store reads", (it) => {
  it.effect("reads 1,001 records by id completely, a page per 400 ids", () =>
    Effect.gen(function* () {
      const store = yield* MissionStore.MissionStore;
      const missionId = MissionId.make("m-ids");
      const ids = Array.from({ length: 1_001 }, (_, index) => `m-ids:writer-${index}`);
      yield* store.commit({
        event: { ...event, missionId },
        upserts: [
          { _tag: "mission", record: { ...mission, id: missionId, slug: missionId } },
          ...ids.map((id) => ({
            _tag: "role" as const,
            record: { ...role(id, "writer"), missionId },
          })),
        ],
      });
      resetReads();
      const found = yield* recordsByIds(store, "role", [...ids, ids[0]!]);
      assert.strictEqual(new Set(found.map((record) => record.id)).size, 1_001);
      assert.deepStrictEqual(
        reads.lists.map(({ filter }) => [filter?.ids?.length, filter?.limit]),
        [
          [400, 400],
          [400, 400],
          [201, 201],
        ],
      );
    }),
  );

  it.effect("sweeps bound roles without one read per role", () =>
    Effect.gen(function* () {
      const missions = yield* MissionService.MissionService;
      const policy = yield* PolicyService.PolicyService;
      yield* missions.createMission(OWNER, { missionId: CRPKO, slug: "crpko", title: "Crpko" });
      for (const kind of ["master", "editor", "scribe"]) {
        const threadId = ThreadId.make(`thread-${kind}`);
        ports.threads.set(threadId, { exists: true, idle: true, modelSelection: OPUS_XHIGH });
        yield* policy.bindRole(OWNER, { roleId: RoleId.make(`${CRPKO}:${kind}`), threadId });
      }
      resetReads();
      yield* policy.sweep;
      assert.strictEqual(reads.roleGets, 0);
    }),
  );

  it.effect(
    "reads the governor's missions, sub-missions, lanes and a PR's review history uncapped",
    () =>
      Effect.gen(function* () {
        const policy = yield* PolicyService.PolicyService;
        const pullRequest = { repository: "crpko/trading-core", number: 7 };
        resetReads();
        yield* policy.governor;
        yield* policy.recordCriticality(agent("thread-master"), {
          missionId: CRPKO,
          pullRequest,
          critical: false,
          reason: "docs only",
        });
        yield* policy.reviewPlan({ missionId: CRPKO, pullRequest, headSha: "h1" });
        assert.deepStrictEqual(
          reads.lists.filter(({ kind }) => ["mission", "sub-mission", "lane"].includes(kind)),
          [],
        );
        const byId = reads.lists.filter(({ filter }) => filter?.ids !== undefined);
        assert.isTrue(byId.length > 0);
        for (const { filter } of byId) {
          assert.strictEqual(filter?.limit, filter?.ids?.length);
        }
      }),
  );
});
