import { MissionId, SubMissionId, type Mission, type SubMission } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as MissionStore from "./MissionStore.ts";

const TestLayer = MissionStore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

const at = "2026-10-17T08:00:00.000Z";

const mission = (id: string, overrides: Partial<Mission> = {}): Mission => ({
  id: MissionId.make(id),
  slug: id,
  title: `Mission ${id}`,
  goal: "Ship it",
  status: "active",
  tier: "P1",
  weight: 1,
  guaranteedShare: 0.2,
  borrowCeiling: 0.5,
  projectId: null,
  masterRoleId: null,
  focusSubMissionId: null,
  health: "unknown",
  lockedFields: [],
  createdAt: at,
  updatedAt: at,
  ...overrides,
});

const subMission = (missionId: string, id: string, order: number): SubMission => ({
  id: SubMissionId.make(id),
  missionId: MissionId.make(missionId),
  title: `Sub ${id}`,
  intent: "",
  order,
  fillIdleCapacity: false,
  status: "active",
  coordinatorRoleId: null,
  intendedEffort: null,
  actualEffort: null,
  health: "unknown",
  lockedFields: [],
  createdAt: at,
  updatedAt: at,
});

const event = (missionId: string, summary = "changed") =>
  ({
    missionId: MissionId.make(missionId),
    kind: "mission.updated",
    actor: { _tag: "owner" },
    provenance: { _tag: "owner-app", surface: "web", sessionId: "session-1" },
    summary,
    subject: { kind: "mission", id: missionId },
  }) as const;

it.layer(TestLayer)("MissionStore", (it) => {
  it.effect("creates its tables idempotently", () =>
    Effect.gen(function* () {
      // The layer already ran the DDL once; building it again must not fail.
      yield* Layer.build(MissionStore.layer).pipe(Effect.scoped);
      const sql = yield* SqlClient.SqlClient;
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ardud_mission_%' ORDER BY name
      `;
      assert.deepStrictEqual(
        tables.map((row) => row.name),
        [
          "ardud_mission_counters",
          "ardud_mission_events",
          "ardud_mission_owner_looks",
          "ardud_mission_records",
        ],
      );
    }),
  );

  it.effect("writes the record and its event in one transaction", () =>
    Effect.gen(function* () {
      const store = yield* MissionStore.MissionStore;
      const result = yield* store.upsert(
        { _tag: "mission", record: mission("m-tx") },
        { ...event("m-tx"), kind: "mission.created" },
      );
      assert.equal(result.seq, 1);
      assert.equal(result.event.seq, 1);
      const stored = yield* store.get("mission", "m-tx");
      assert.isTrue(Option.isSome(stored));
      const events = yield* store.eventsSince(MissionId.make("m-tx"), 0);
      assert.deepStrictEqual(
        events.map((entry) => [entry.seq, entry.kind]),
        [[1, "mission.created"]],
      );

      // A failure inside the commit rolls back both the record and the event.
      const failed = yield* store
        .commit({
          event: event("m-tx", "should roll back"),
          upserts: [{ _tag: "mission", record: mission("m-tx", { title: "Rolled back" }) }],
          alongside: Effect.die("boom"),
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(failed));
      const after = yield* store.get("mission", "m-tx");
      assert.equal(Option.getOrThrow(after).title, "Mission m-tx");
      assert.equal((yield* store.eventsSince(MissionId.make("m-tx"), 0)).length, 1);
      assert.equal(yield* store.latestSeq(MissionId.make("m-tx")), 1);
    }),
  );

  it.effect("assigns strictly increasing seq per mission", () =>
    Effect.gen(function* () {
      const store = yield* MissionStore.MissionStore;
      yield* store.upsert({ _tag: "mission", record: mission("m-a") }, event("m-a"));
      yield* store.upsert({ _tag: "mission", record: mission("m-b") }, event("m-b"));
      yield* store.upsert(
        { _tag: "sub-mission", record: subMission("m-a", "s-1", 0) },
        event("m-a"),
      );
      yield* store.appendEvent(event("m-a", "note only"));
      const a = yield* store.eventsSince(MissionId.make("m-a"), 0);
      const b = yield* store.eventsSince(MissionId.make("m-b"), 0);
      assert.deepStrictEqual(
        a.map((entry) => entry.seq),
        [1, 2, 3],
      );
      assert.deepStrictEqual(
        b.map((entry) => entry.seq),
        [1],
      );
      const page = yield* store.eventsSince(MissionId.make("m-a"), 1, 1);
      assert.deepStrictEqual(
        page.map((entry) => entry.seq),
        [2],
      );
      const subs = yield* store.list("sub-mission", { missionId: MissionId.make("m-a") });
      assert.deepStrictEqual(
        subs.map((entry) => entry.id),
        ["s-1"],
      );
    }),
  );

  it.effect("publishes committed changes in seq order", () =>
    Effect.gen(function* () {
      const store = yield* MissionStore.MissionStore;
      const subscription = yield* store.subscribe;
      yield* store.upsert({ _tag: "mission", record: mission("m-pub") }, event("m-pub"));
      yield* store.commit({
        event: event("m-pub"),
        removes: [{ kind: "mission", id: "m-pub" }],
      });
      const items = yield* PubSub.takeAll(subscription);
      assert.deepStrictEqual(
        items.map((item) => [item._tag, item._tag === "list" ? null : item.seq]),
        [
          ["upsert", 1],
          ["upsert", 1],
          ["remove", 2],
          ["upsert", 2],
        ],
      );
      assert.isTrue(Option.isNone(yield* store.get("mission", "m-pub")));
    }).pipe(Effect.scoped),
  );

  it.effect("surfaces a stored record that fails to decode as MissionError", () =>
    Effect.gen(function* () {
      const store = yield* MissionStore.MissionStore;
      yield* store.upsert({ _tag: "mission", record: mission("m-bad") }, event("m-bad"));
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        UPDATE ardud_mission_records SET record_json = ${'{"_tag":"mission","record":{"id":"m-bad"}}'}
        WHERE kind = 'mission' AND id = 'm-bad'
      `;
      const error = yield* store.get("mission", "m-bad").pipe(Effect.flip);
      assert.equal(error._tag, "MissionError");
      assert.equal(error.code, "invalid");
      const listed = yield* store.list("mission", { ids: ["m-bad"] }).pipe(Effect.flip);
      assert.equal(listed.code, "invalid");
    }),
  );

  it.effect("rejects a record that does not match the contract before writing", () =>
    Effect.gen(function* () {
      const store = yield* MissionStore.MissionStore;
      const error = yield* store
        .upsert(
          { _tag: "mission", record: mission("m-invalid", { weight: 0 }) },
          event("m-invalid"),
        )
        .pipe(Effect.flip);
      assert.equal(error.code, "invalid");
      assert.equal(yield* store.latestSeq(MissionId.make("m-invalid")), 0);
    }),
  );
});
