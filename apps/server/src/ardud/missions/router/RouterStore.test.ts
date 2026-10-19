import {
  MissionId,
  MissionMessageId,
  RoomId,
  SubscriptionId,
  ThreadId,
  type MissionMessage,
  type MissionMessageKind,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as RouterStore from "./RouterStore.ts";

const TestLayer = RouterStore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

const missionId = MissionId.make("mission-1");
const roomId = RoomId.make("room-1");
const lane = ThreadId.make("thread-lane");

const message = (
  seq: number,
  kind: MissionMessageKind = "request",
  key: string | null = null,
): MissionMessage => ({
  id: MissionMessageId.make(`message-${seq}`),
  missionId,
  roomId,
  seq,
  kind,
  author: { _tag: "owner" },
  provenance: { _tag: "owner-app", surface: "web", sessionId: "session-1" },
  to: [],
  summary: `message ${seq}`,
  hasBody: false,
  key,
  workItemId: null,
  links: [],
  receipt: null,
  isCorrection: false,
  createdAt: `2026-10-17T10:00:0${seq % 10}.000Z`,
});

it.layer(TestLayer)("RouterStore", (it) => {
  it.effect("pages room messages oldest first and finds them by key", () =>
    Effect.gen(function* () {
      const store = yield* RouterStore.RouterStore;
      for (const seq of [1, 2, 3, 4, 5]) {
        yield* store.insertMessage({
          message: message(seq, "status", seq === 3 ? "k3" : null),
          body: seq === 2 ? "full body" : null,
          contentHash: `hash-${seq}`,
          deliveries: [],
        });
      }
      assert.strictEqual(yield* store.lastMessageSeq(missionId), 5);

      const newest = yield* store.roomMessages(roomId, null, 2);
      assert.deepStrictEqual(
        newest.messages.map((m) => m.seq),
        [4, 5],
      );
      assert.isTrue(newest.hasOlder);
      const older = yield* store.roomMessages(roomId, 4, 10);
      assert.deepStrictEqual(
        older.messages.map((m) => m.seq),
        [1, 2, 3],
      );
      assert.isFalse(older.hasOlder);

      const keyed = yield* store.messageByKey(missionId, "k3");
      assert.strictEqual(keyed?.message.seq, 3);
      assert.strictEqual(keyed?.contentHash, "hash-3");
      assert.strictEqual(yield* store.messageBody(MissionMessageId.make("message-2")), "full body");
      assert.isNull(yield* store.messageBody(MissionMessageId.make("message-1")));
    }),
  );

  it.effect("only moves read positions forward", () =>
    Effect.gen(function* () {
      const store = yield* RouterStore.RouterStore;
      const reader = { _tag: "thread" as const, threadId: lane };
      yield* store.advanceRead(
        { roomId, reader, seq: 5, updatedAt: "2026-10-17T10:00:00.000Z" },
        "thread:lane",
      );
      const kept = yield* store.advanceRead(
        { roomId, reader, seq: 2, updatedAt: "2026-10-17T10:01:00.000Z" },
        "thread:lane",
      );
      assert.strictEqual(kept.seq, 5);
      const positions = yield* store.readPositions(roomId);
      assert.strictEqual(positions.length, 1);
      assert.strictEqual(positions[0]?.seq, 5);
    }),
  );

  it.effect("keeps one subscription per subscriber and room", () =>
    Effect.gen(function* () {
      const store = yield* RouterStore.RouterStore;
      const subscriber = { _tag: "thread" as const, threadId: lane };
      yield* store.upsertSubscription(
        {
          id: SubscriptionId.make("sub-1"),
          roomId,
          subscriber,
          mode: "wake",
          wakeOn: ["request"],
          createdAt: "2026-10-17T10:00:00.000Z",
        },
        "thread:lane",
      );
      yield* store.upsertSubscription(
        {
          id: SubscriptionId.make("sub-2"),
          roomId,
          subscriber,
          mode: "mute",
          wakeOn: [],
          createdAt: "2026-10-17T10:00:00.000Z",
        },
        "thread:lane",
      );
      const subscriptions = yield* store.subscriptions(roomId);
      assert.strictEqual(subscriptions.length, 1);
      assert.strictEqual(subscriptions[0]?.mode, "mute");
    }),
  );

  it.effect("covers deliveries with a ring and counts wasted wakes once settled", () =>
    Effect.gen(function* () {
      const store = yield* RouterStore.RouterStore;
      const otherRoom = RoomId.make("room-wasted");
      yield* store.insertMessage({
        message: { ...message(20), roomId: otherRoom, id: MissionMessageId.make("message-20") },
        body: null,
        contentHash: "h20",
        deliveries: [lane],
      });
      const unread = yield* store.unreadDeliveries(lane);
      assert.deepStrictEqual(
        unread.map((row) => [row.seq, row.wakeId]),
        [[20, null]],
      );

      yield* store.ring({
        threadId: lane,
        missionId,
        wakeId: "wake-1",
        upToSeq: 20,
        at: "2026-10-17T10:00:00.000Z",
      });
      const rung = yield* store.doorbell(lane);
      assert.isTrue(rung?.outstanding);
      assert.strictEqual(rung?.rungSeq, 20);
      assert.strictEqual((yield* store.unreadDeliveries(lane))[0]?.wakeId, "wake-1");

      assert.isTrue(yield* store.settle(lane, "2026-10-17T10:05:00.000Z"));
      assert.isFalse(yield* store.settle(lane, "2026-10-17T10:06:00.000Z"));
      assert.isFalse((yield* store.doorbell(lane))?.outstanding);
      // Settled without the thread posting anything: a wasted wake.
      assert.strictEqual(yield* store.wastedWakesSince(otherRoom, "2026-10-17T00:00:00.000Z"), 1);

      yield* store.readDeliveries(lane, otherRoom, 20);
      assert.strictEqual((yield* store.unreadDeliveries(lane)).length, 0);
    }),
  );

  it.effect("a wake the thread acted on is not wasted", () =>
    Effect.gen(function* () {
      const store = yield* RouterStore.RouterStore;
      const room = RoomId.make("room-acted");
      const thread = ThreadId.make("thread-acted");
      yield* store.insertMessage({
        message: { ...message(30), roomId: room, id: MissionMessageId.make("message-30") },
        body: null,
        contentHash: "h30",
        deliveries: [thread],
      });
      yield* store.ring({
        threadId: thread,
        missionId,
        wakeId: "wake-acted",
        upToSeq: 30,
        at: "2026-10-17T10:00:00.000Z",
      });
      yield* store.markActed(thread);
      yield* store.settle(thread, "2026-10-17T10:05:00.000Z");
      assert.strictEqual(yield* store.wastedWakesSince(room, "2026-10-17T00:00:00.000Z"), 0);
    }),
  );

  it.effect("stores members by principal", () =>
    Effect.gen(function* () {
      const store = yield* RouterStore.RouterStore;
      yield* store.putMember(
        { missionId, principal: "thread:master", kind: "master", label: "Crpko master" },
        "2026-10-17T10:00:00.000Z",
      );
      const rows = yield* store.membersByPrincipal("thread:master");
      assert.deepStrictEqual(
        rows.map((row) => [row.missionId, row.kind]),
        [[missionId, "master"]],
      );
      assert.isTrue(yield* store.removeMember(missionId, "thread:master"));
      assert.strictEqual((yield* store.membersByPrincipal("thread:master")).length, 0);
    }),
  );

  it.effect("makes the guard's authority table at boot, before any read", () =>
    Effect.gen(function* () {
      yield* RouterStore.RouterStore;
      const sql = yield* SqlClient.SqlClient;
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'ardud_mission_guard_authority'
      `;
      assert.deepStrictEqual(
        tables.map((table) => table.name),
        ["ardud_mission_guard_authority"],
      );
    }),
  );
});
