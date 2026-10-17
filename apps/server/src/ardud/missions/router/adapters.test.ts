import {
  MissionId,
  MissionMessageId,
  RoleId,
  RoomId,
  SubscriptionId,
  type MissionMessage,
  type ReadPosition,
  type Room,
  type Subscription,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Sqlite from "../../../persistence/Sqlite.ts";
import { readPositionId } from "../import/apply.ts";
import { routerImportSink } from "./adapters.ts";
import * as RouterStore from "./RouterStore.ts";

const TestLayer = RouterStore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

const missionId = MissionId.make("crpko");
const roomId = RoomId.make("crpko:room:control");
const lead = { _tag: "role", roleId: RoleId.make("crpko:lane-lead") } as const;
const at = "2026-10-17T10:00:00.000Z";

const room: Room = {
  id: roomId,
  missionId,
  subMissionId: null,
  kind: "control",
  title: "Control",
  workItemId: null,
  archived: false,
  lastSeq: 7,
  lastMessageAt: at,
  noise: null,
  createdAt: at,
};

const message: MissionMessage = {
  id: MissionMessageId.make("crpko:coord:7"),
  missionId,
  roomId,
  seq: 7,
  kind: "control",
  author: { _tag: "system", component: "coord" },
  provenance: { _tag: "import", source: "coord" },
  to: [lead],
  summary: "pause non-urgent lanes",
  hasBody: true,
  key: "ctl-1",
  workItemId: null,
  links: [],
  receipt: null,
  isCorrection: false,
  createdAt: at,
};

const subscription: Subscription = {
  id: SubscriptionId.make("crpko:room:control:sub:lead"),
  roomId,
  subscriber: lead,
  mode: "wake",
  wakeOn: ["request", "blocker", "control"],
  createdAt: at,
};

const position: ReadPosition = { roomId, reader: lead, seq: 7, updatedAt: at };

const batch = {
  rooms: [room],
  messages: [{ message, body: "Pause until the 5h window resets." }],
  subscriptions: [subscription],
  readPositions: [position],
};

it.layer(TestLayer)("routerImportSink", (it) => {
  it.effect("writes coord rooms, messages, subscriptions and reads once, by import ids", () =>
    Effect.gen(function* () {
      const store = yield* RouterStore.RouterStore;
      const sink = yield* routerImportSink;

      assert.strictEqual((yield* sink.existing("room", [roomId])).size, 0);
      yield* sink.write(batch);
      // A re-run writes nothing new and does not fail on what is there.
      yield* sink.write(batch);

      assert.isTrue((yield* sink.existing("room", [roomId])).has(roomId));
      assert.isTrue((yield* sink.existing("message", [message.id])).has(message.id));
      assert.isTrue((yield* sink.existing("subscription", [subscription.id])).has(subscription.id));
      // Read positions are matched by the import's own id format.
      assert.isTrue(
        (yield* sink.existing("read-position", [readPositionId(position)])).has(
          readPositionId(position),
        ),
      );

      const page = yield* store.roomMessages(roomId, null, 10);
      assert.deepStrictEqual(
        page.messages.map((m) => m.id),
        [message.id],
      );
      assert.strictEqual(yield* store.messageBody(message.id), "Pause until the 5h window resets.");
      // Router posts continue after the imported coord seqs.
      assert.strictEqual(yield* store.lastMessageSeq(missionId), 7);
      // The same key is found again, so a coord retry is not posted twice.
      assert.strictEqual((yield* store.messageByKey(missionId, "ctl-1"))?.message.seq, 7);
    }),
  );
});
