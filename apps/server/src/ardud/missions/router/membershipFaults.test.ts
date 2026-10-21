import { ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../../persistence/Sqlite.ts";
import {
  failureCode,
  masterThread,
  mission,
  missionId,
  ownerApp,
  seed,
  strayThread,
} from "../asks/AsksService.testkit.ts";
import { authorityStore, optionalAuthorityStore } from "../guard/authority.ts";
import { forkCreator } from "../guard/forks.ts";
import * as MissionStore from "../store/MissionStore.ts";
import * as MissionRouter from "./MissionRouter.ts";
import { RouterThreads } from "./ports.ts";
import * as RouterStore from "./RouterStore.ts";

/**
 * Membership must fail, not shrink, when the records it rests on cannot be
 * read: an outsider's send to a protected thread is refused instead of passing
 * as "not a member" (Sol boundary review round 3, P4 and P5).
 */

const child = ThreadId.make("t-master-child");
const legacy = ThreadId.make("t-legacy-child");
const parents = new Map<ThreadId, ThreadId>([
  [child, masterThread],
  [legacy, masterThread],
]);

/** Lineage from a map; creators from the real authority table. */
const threads = Layer.effect(
  RouterThreads,
  Effect.gen(function* () {
    const authority = authorityStore(yield* SqlClient.SqlClient);
    return RouterThreads.of({
      facts: (threadId) =>
        Effect.succeed({
          threadId,
          title: threadId,
          activity: "idle" as const,
          parentThreadId: parents.get(threadId) ?? null,
          rootThreadId: parents.get(threadId) ?? null,
          archived: false,
        }),
      creator: (threadId) => forkCreator(authority, threadId),
      send: () => Effect.void,
      question: () => Effect.succeed(null),
    });
  }),
);

const layer = MissionRouter.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(RouterStore.layer, threads)),
  Layer.provideMerge(MissionStore.layer),
  Layer.provideMerge(Sqlite.layerMemory),
);

const strangerTo = (targetThreadId: ThreadId) =>
  Effect.gen(function* () {
    const router = yield* MissionRouter.MissionRouter;
    return yield* router.guard({
      path: "thread-send",
      targetThreadId,
      from: { _tag: "thread", threadId: strayThread, title: "Stray" },
      text: "drop everything",
      requestKey: `thread-send:${targetThreadId}:1`,
    });
  });

const ownerTo = (targetThreadId: ThreadId) =>
  Effect.gen(function* () {
    const router = yield* MissionRouter.MissionRouter;
    return yield* router.guard({
      path: "thread-send",
      targetThreadId,
      from: { _tag: "owner", provenance: ownerApp },
      text: "carry on",
      requestKey: `owner:${targetThreadId}:1`,
    });
  });

describe("membership fails closed on unreadable records (router r4, Sol r3 P4/P5)", () => {
  it.effect(
    "an unreadable or undecodable creator refuses the send; a missing one stays outside",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        yield* authorityStore(sql).record("fork", child, {
          _tag: "thread",
          threadId: masterThread,
          title: "Master",
        });
        // The master's child is protected; a legacy child with no record is not (M1).
        assert.strictEqual((yield* strangerTo(child))._tag, "knocked");
        assert.deepStrictEqual(yield* strangerTo(legacy), { _tag: "pass" });

        // The recorded principal no longer decodes: refuse, never "outsider".
        yield* sql`UPDATE ardud_mission_guard_authority SET principal_json = '{"_tag":"nobody"}' WHERE subject_id = ${child}`;
        assert.strictEqual(yield* failureCode(strangerTo(child)), "conflict");
        // The best-effort reader other callers use still reads it as nothing.
        assert.isNull(yield* authorityStore(sql).read("fork", child));
        // The owner passes whatever the membership, so a bad record never locks him out.
        assert.deepStrictEqual(yield* ownerTo(child), { _tag: "pass" });
        // Absence proven by a successful read still leaves the legacy child outside.
        assert.deepStrictEqual(yield* strangerTo(legacy), { _tag: "pass" });
      }).pipe(Effect.provide(layer)),
  );

  it.effect("a failing authority read refuses even where no creator was recorded", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      // A table the reader cannot select from: every lookup is an SQL error.
      yield* sql`DROP TABLE ardud_mission_guard_authority`;
      yield* sql`CREATE TABLE ardud_mission_guard_authority (kind TEXT NOT NULL, subject_id TEXT NOT NULL)`;
      assert.strictEqual(yield* failureCode(strangerTo(child)), "conflict");
      assert.strictEqual(yield* failureCode(strangerTo(legacy)), "conflict");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a membership naming a missing mission refuses; an archived mission passes", () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* MissionStore.MissionStore;
      const router = yield* MissionRouter.MissionRouter;
      const toMaster = router.checkSend({
        path: "thread-send",
        targetThreadId: masterThread,
        from: { _tag: "thread", threadId: strayThread, title: "Stray" },
      });
      assert.strictEqual((yield* toMaster)._tag, "knock");

      // Archived on purpose: its own policy (no longer guarded) still applies.
      const archived = { ...mission, status: "archived" as const };
      yield* store.upsert(
        { _tag: "mission", record: archived },
        {
          missionId,
          kind: "mission.archived",
          actor: { _tag: "owner" },
          provenance: { _tag: "owner-app", surface: "web", sessionId: "s-1" },
          summary: "Archived",
          subject: { kind: "mission", id: missionId },
        },
      );
      assert.deepStrictEqual(yield* toMaster, { _tag: "not-member" });

      // The mission record is gone while its bindings remain: refuse.
      yield* store.commit({
        event: {
          missionId,
          kind: "mission.updated",
          actor: { _tag: "system", component: "test" },
          provenance: { _tag: "system", component: "test" },
          summary: "Lost the mission row",
          subject: null,
        },
        removes: [{ kind: "mission", id: missionId }],
      });
      assert.strictEqual(yield* failureCode(toMaster), "conflict");
      assert.strictEqual(yield* failureCode(strangerTo(masterThread)), "conflict");
      assert.deepStrictEqual(yield* ownerTo(masterThread), { _tag: "pass" });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("without an app database a creator lookup fails instead of proving absence", () =>
    Effect.gen(function* () {
      const store = yield* optionalAuthorityStore;
      assert.isNull(yield* store.read("fork", child));
      assert.strictEqual(yield* failureCode(forkCreator(store, child)), "conflict");
    }),
  );
});
