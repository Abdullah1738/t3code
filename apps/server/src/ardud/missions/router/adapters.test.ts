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
import { AskId, LaneId, WorkItemId, type Ask } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Sqlite from "../../../persistence/Sqlite.ts";
import {
  at as seededAt,
  laneThread,
  missionId as seededMission,
  seed,
  writerThread,
} from "../asks/AsksService.testkit.ts";
import { AsksSignals } from "../asks/ports.ts";
import { readPositionId } from "../import/apply.ts";
import * as MissionStore from "../store/MissionStore.ts";
import { asksSignalsLayer, routerImportSink } from "./adapters.ts";
import { controlRoomId } from "./MissionRouter.ts";
import { fakeRouterThreads, routerOverFakes } from "./MissionRouter.testkit.ts";
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

const answered: Ask = {
  id: AskId.make("ask-1"),
  missionId: seededMission,
  subMissionId: null,
  askedBy: { _tag: "role", roleId: RoleId.make("role-writer") },
  question: "Ship the migration tonight?",
  context: "",
  options: [{ id: "yes", label: "Yes", detail: "" }],
  recommendation: null,
  blocks: [{ kind: "work-item", id: "wi-held" }],
  costOfWaiting: "",
  urgency: "normal",
  status: "answered",
  answer: {
    optionId: "yes",
    text: "after the backup",
    provenance: { _tag: "owner-app", surface: "web", sessionId: "s-1" },
    answeredAt: seededAt,
  },
  createdAt: seededAt,
  updatedAt: seededAt,
};

it.effect(
  "a resolved ask rings the asker and the released item's lane through the doorbell",
  () => {
    const threads = fakeRouterThreads();
    const layer = asksSignalsLayer.pipe(
      Layer.provideMerge(routerOverFakes(threads)),
      Layer.provideMerge(MissionStore.layer),
      Layer.provideMerge(Sqlite.layerMemory),
    );
    return Effect.gen(function* () {
      yield* seed;
      const signals = yield* AsksSignals;
      const store = yield* RouterStore.RouterStore;
      const released = [{ kind: "work-item", id: WorkItemId.make("wi-held") }] as const;
      yield* signals.askResolved({ ask: answered, askerThreadId: writerThread, released });
      // A replay of the same resolution is the same message, not a second wake.
      yield* signals.askResolved({ ask: answered, askerThreadId: writerThread, released });

      const page = yield* store.roomMessages(controlRoomId(seededMission), null, 10);
      assert.strictEqual(page.messages.length, 1);
      const message = page.messages[0]!;
      assert.strictEqual(message.kind, "decision");
      assert.include(message.summary, "after the backup");
      assert.deepStrictEqual(message.to, [
        { _tag: "role", roleId: RoleId.make("role-writer") },
        { _tag: "lane", laneId: LaneId.make("lane-api") },
      ]);
      const wakes = threads.sent.filter((sent) => sent.key.startsWith("mission-wake:"));
      assert.deepStrictEqual(wakes.map((sent) => sent.threadId).toSorted(), [
        laneThread,
        writerThread,
      ]);
      // Nothing reached a thread except through the doorbell.
      assert.strictEqual(threads.sent.length, wakes.length);
    }).pipe(Effect.provide(layer));
  },
);
