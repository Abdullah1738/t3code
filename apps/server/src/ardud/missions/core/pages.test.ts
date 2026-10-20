import { LaneId, MissionId, WorkItemId, type MissionEventKind } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { harness, item, lane, missionId, seed } from "../asks/AsksService.testkit.ts";
import { MissionService } from "../MissionService.ts";
import * as MissionStore from "../store/MissionStore.ts";
import { timelineGroupOf } from "./pages.ts";

const system = { _tag: "system", component: "test" } as const;

const putItem = (id: string, updatedAt: string, patch: Partial<ReturnType<typeof item>> = {}) =>
  Effect.gen(function* () {
    const store = yield* MissionStore.MissionStore;
    yield* store.upsert(
      { _tag: "work-item", record: { ...item(id), updatedAt, ...patch } },
      {
        missionId,
        kind: "work-item.updated",
        actor: system,
        provenance: system,
        summary: `put ${id}`,
        subject: null,
      },
    );
  });

const log = (kind: MissionEventKind, summary: string) =>
  Effect.gen(function* () {
    const store = yield* MissionStore.MissionStore;
    return yield* store.appendEvent({
      missionId,
      kind,
      actor: system,
      provenance: system,
      summary,
      subject: null,
    });
  });

describe("mission pages", () => {
  const { layer } = harness();

  it.effect("work items page newest change first, filtered by lane and stage", () =>
    Effect.gen(function* () {
      yield* seed;
      const otherLane = LaneId.make("lane-web");
      yield* putItem("wi-a", "2026-10-18T09:00:00.000Z");
      yield* putItem("wi-b", "2026-10-18T10:00:00.000Z", { laneId: otherLane });
      yield* putItem("wi-c", "2026-10-18T11:00:00.000Z", { stage: "done" });
      const missions = yield* MissionService;

      const first = yield* missions.workItems({ missionId, limit: 2 });
      assert.deepStrictEqual(
        first.items.map((entry) => entry.id),
        [WorkItemId.make("wi-c"), WorkItemId.make("wi-b")],
      );
      assert.strictEqual(first.total, 5);
      assert.isTrue(first.hasMore);

      const rest = yield* missions.workItems({ missionId, limit: 2, offset: 4 });
      assert.strictEqual(rest.items.length, 1);
      assert.isFalse(rest.hasMore);

      const byLane = yield* missions.workItems({ missionId, laneId: otherLane });
      assert.deepStrictEqual(
        byLane.items.map((entry) => entry.id),
        [WorkItemId.make("wi-b")],
      );

      const open = yield* missions.workItems({ missionId, laneId: lane.id, stages: ["pr"] });
      assert.deepStrictEqual(
        open.items.map((entry) => entry.id).toSorted(),
        ["wi-a", "wi-free", "wi-held"].map((id) => WorkItemId.make(id)),
      );

      const missing = yield* Effect.flip(
        missions.workItems({ missionId: MissionId.make("m-none") }),
      );
      assert.strictEqual(missing.code, "not-found");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a work-item page reads only its own rows from SQL", () =>
    Effect.gen(function* () {
      yield* seed;
      for (let index = 0; index < 30; index += 1) {
        const minute = String(index).padStart(2, "0");
        yield* putItem(`wi-bulk-${minute}`, `2026-10-18T12:${minute}:00.000Z`);
      }
      // An old row the first page never reaches: decoding it would fail.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        UPDATE ardud_mission_records
        SET record_json = ${JSON.stringify({ _tag: "work-item", record: { laneId: lane.id } })}
        WHERE kind = 'work-item' AND id = 'wi-bulk-00'
      `;
      const missions = yield* MissionService;

      const page = yield* missions.workItems({ missionId, laneId: lane.id, limit: 3 });
      assert.deepStrictEqual(
        page.items.map((entry) => entry.id),
        ["wi-bulk-29", "wi-bulk-28", "wi-bulk-27"].map((id) => WorkItemId.make(id)),
      );
      assert.strictEqual(page.total, 32);
      assert.isTrue(page.hasMore);

      const tail = yield* Effect.flip(missions.workItems({ missionId, offset: 29, limit: 3 }));
      assert.strictEqual(tail.code, "invalid");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("timeline pages newest first with each event's group", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* log("lane.created", "lane");
      yield* log("approval.decided", "approval");
      yield* log("secret-request.closed", "secret");
      yield* log("import.applied", "import");
      const missions = yield* MissionService;

      const page = yield* missions.timeline({ missionId, limit: 3 });
      assert.deepStrictEqual(
        page.entries.map((entry) => [entry.event.kind, entry.group]),
        [
          ["import.applied", "other"],
          ["secret-request.closed", "inbox"],
          ["approval.decided", "inbox"],
        ],
      );
      assert.isTrue(page.hasOlder);

      const older = yield* missions.timeline({
        missionId,
        beforeSeq: page.entries.at(-1)!.event.seq,
      });
      assert.deepStrictEqual(
        older.entries.map((entry) => [entry.event.kind, entry.group]),
        [
          ["lane.created", "lane"],
          ["mission.created", "mission"],
        ],
      );
      assert.isFalse(older.hasOlder);
    }).pipe(Effect.provide(layer)),
  );

  it("groups event kinds by their prefix", () => {
    assert.strictEqual(timelineGroupOf("milestone.created"), "sub-mission");
    assert.strictEqual(timelineGroupOf("review-policy.updated"), "review");
    assert.strictEqual(timelineGroupOf("call.made"), "inbox");
    assert.strictEqual(timelineGroupOf("recovery.resumed"), "recovery");
    assert.strictEqual(timelineGroupOf("governor.action"), "other");
  });
});
